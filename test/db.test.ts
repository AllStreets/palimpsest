import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';

import { home, paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { getSettings, patchSettings } from '../engine/settings.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.PALIMPSEST_HOME;
  } else {
    process.env.PALIMPSEST_HOME = previousHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test('home() honours PALIMPSEST_HOME', () => {
  assert.equal(home(), tempDir);

  const p = paths();
  assert.ok(p.mirrors.startsWith(tempDir));
  assert.ok(p.usage.startsWith(tempDir));
  assert.ok(p.logs.startsWith(tempDir));
  assert.ok(existsSync(p.mirrors));
  assert.ok(existsSync(p.usage));
  assert.ok(existsSync(p.logs));
});

test('ledger records are append-only and ordered', () => {
  const id1 = record('repo.connected', { n: 1 });
  const id2 = record('repo.analyzed', { n: 2 });
  const id3 = record('repo.patched', { n: 3 });

  assert.deepEqual([id1, id2, id3], [1, 2, 3]);

  const all = entries();
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3]);

  const since = entries(2);
  assert.equal(since.length, 1);
  assert.equal(since[0].id, 3);
});

test('settings defaults', () => {
  const settings = getSettings();
  assert.equal(settings.quality, 'high');
  assert.equal(settings.dayCapPct, 50);
  assert.equal(settings.nightCapPct, 20);
  assert.equal(settings.hookInstalled, false);
  assert.equal(settings.previousStatusLine, null);
  assert.equal(settings.claudeConcurrency, 2);
  assert.equal(settings.localConcurrency, 1);
  assert.equal(settings.bidWindowSec, 120);
  assert.equal(settings.hardStopPct, 90);
  assert.equal(settings.resumeStaleUntil, null);
  assert.equal(settings.keepAwake, false);
  assert.equal(settings.ollamaHost, '127.0.0.1:11434');
  assert.deepEqual(settings.anthropicApi, { enabled: false, dailyUsd: 5 });
});

test('patchSettings persists across reopen', () => {
  patchSettings({ quality: 'medium', dayCapPct: 75 });

  // Open an independent connection to the same file to prove the write
  // landed on disk, not just in the cached connection held by openDb().
  const direct = new DatabaseSync(paths().db);
  const row = direct.prepare('SELECT json FROM settings WHERE key = ?').get('quality') as { json: string };
  assert.equal(JSON.parse(row.json), 'medium');
  direct.close();

  const reread = getSettings();
  assert.equal(reread.quality, 'medium');
  assert.equal(reread.dayCapPct, 75);
  assert.equal(reread.nightCapPct, 20);
});
