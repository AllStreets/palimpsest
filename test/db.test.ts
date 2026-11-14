import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';

import { home, paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { isLedgerKind } from '../shared/ledger-kinds.js';

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
  // Phase 3: the audit and today's cap.
  assert.equal(settings.auditOnConnect, true);
  assert.equal(settings.auditModel, 'auto');
  assert.equal(settings.auditMaxCredits, 40);
  assert.equal(settings.todayCapPct, null);
});

test('the ledger takes the audit, brief and milestone kinds', () => {
  const kinds = ['audit.started', 'audit.stage', 'audit.ended', 'brief.opened', 'brief.action', 'milestone.reached'] as const;
  for (const k of kinds) assert.ok(isLedgerKind(k), k);
  const id = record('audit.started', { audit: { id: 'audit-1' } });
  assert.equal(entries(id - 1)[0]?.kind, 'audit.started');
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

test('migrate adds agent_id and its index to an older trips table, twice', async () => {
  const { migrate } = await import('../engine/db.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE trips (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  db.prepare('INSERT INTO trips (id, json) VALUES (?, ?)').run('t1', JSON.stringify({ agentId: 'a1' }));
  migrate(db);
  migrate(db);
  const cols = (db.prepare('PRAGMA table_info(trips)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('agent_id'));
  const idx = (db.prepare('PRAGMA index_list(trips)').all() as Array<{ name: string }>).map((i) => i.name);
  assert.ok(idx.includes('trips_agent'));
  assert.equal((db.prepare('SELECT agent_id FROM trips WHERE id = ?').get('t1') as { agent_id: string }).agent_id, 'a1');
  db.close();
});

test('allowLowPower defaults to false', () => {
  const s = getSettings().school;
  // Fail closed until he answers Decision 3: nothing trains in Low Power on AC.
  assert.equal(s.allowLowPower, false);
  assert.deepEqual(s, {
    enabled: false,
    window: { from: '01:00', to: '06:00' },
    idleMinutes: 15,
    allowLowPower: false,
    trainNowUntil: null,
    claudeCreditsPerDay: 30,
    designer: 'claude:sonnet',
    understudy: false,
    commitsAsWork: true,
    baseModel: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
    baseModelReady: false,
  });
  // A partial stored value keeps every other default, the window's halves included.
  patchSettings({ school: { enabled: true, window: { from: '02:00' } } as never });
  const merged = getSettings().school;
  assert.equal(merged.enabled, true);
  assert.equal(merged.allowLowPower, false);
  assert.deepEqual(merged.window, { from: '02:00', to: '06:00' });
});

test('the db has the ten school tables', () => {
  const db = new DatabaseSync(paths().db);
  try {
    // openDb() migrates; a raw connection then reads what it made.
    getSettings();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; pk: number }>).map((c) => [c.name, c.pk]);
    assert.deepEqual(cols('nets'), [['net', 1], ['version', 2], ['at', 0], ['current', 0], ['json', 0]]);
    assert.deepEqual(cols('predictions'), [['id', 1], ['key', 0], ['kind', 0], ['repo', 0], ['at', 0], ['json', 0]]);
    assert.deepEqual(cols('decisions'), [['key', 0], ['at', 0], ['kind', 0], ['repo', 0], ['json', 0]]);
    assert.deepEqual(cols('grants'), [['kind', 1], ['repo', 2], ['state', 0], ['at', 0], ['json', 0]]);
    assert.deepEqual(cols('arenas'), [['id', 1], ['repo', 0], ['json', 0]]);
    assert.deepEqual(cols('arena_tasks'), [['id', 1], ['arena', 0], ['split', 0], ['ref', 0], ['json', 0]]);
    assert.deepEqual(cols('voyages'), [['id', 1], ['json', 0]]);
    assert.deepEqual(cols('trains'), [['id', 1], ['kind', 0], ['status', 0], ['json', 0]]);
    assert.deepEqual(cols('graduates'), [['id', 1], ['json', 0]]);
    assert.deepEqual(cols('verified'), [['repo', 1], ['sha', 2], ['json', 0]]);
    const indexes = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>);
    assert.ok(indexes.some((i) => i.name === 'decisions_kind' && /\(kind, at\)/.test(i.sql)), 'decisions are indexed by kind and time');
    // A prediction is registered once per key.
    db.prepare('INSERT INTO predictions (key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?)').run('merge:low:job-1', 'merge:low', 'acme/widgets', '2026-11-12T01:00:00.000Z', '{}');
    assert.throws(() => db.prepare('INSERT INTO predictions (key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?)').run('merge:low:job-1', 'merge:low', 'acme/widgets', '2026-11-12T02:00:00.000Z', '{}'), /UNIQUE/);
  } finally {
    db.close();
  }
});

test('the ledger takes every school kind', () => {
  const kinds = [
    'school.enabled', 'arena.built', 'arena.refused', 'voyage.started', 'voyage.commissioned', 'voyage.generation', 'voyage.ended',
    'train.started', 'train.paused', 'train.ended', 'net.trained', 'net.promoted', 'master.predicted', 'decision.resolved',
    'autonomy.asked', 'autonomy.granted', 'autonomy.declined', 'autonomy.suspended', 'autonomy.revoked', 'autonomy.acted',
    'graduate.made', 'merge.followup',
  ] as const;
  for (const k of kinds) assert.ok(isLedgerKind(k), k);
  const id = record('school.enabled', { enabled: false, at: '2026-11-12T00:00:00.000Z' });
  assert.equal(entries(id - 1)[0]?.kind, 'school.enabled');
});
