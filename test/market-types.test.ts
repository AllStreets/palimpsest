import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';

import * as home from '../engine/home.js';
import type { Repo } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

const MARKET_TABLES = ['jobs', 'firms', 'agents', 'bids', 'runs', 'inspections', 'baselines', 'earned_floors', 'trips', 'slots', 'credits'];

function tables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    db.close();
  }
}

test('migrate creates the market tables and is idempotent', async () => {
  const { migrate, openDb } = await import('../engine/db.js');
  const db = openDb();
  migrate(db);
  migrate(db);
  const names = tables(home.paths().db);
  for (const t of [...MARKET_TABLES, 'repos', 'towers', 'ledger', 'settings']) assert.ok(names.includes(t), t);
  // the credits table's columns
  const cols = (db.prepare('PRAGMA table_info(credits)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, ['id', 'at', 'firm_id', 'run_id', 'kind', 'amount', 'usd', 'json']);
});

test('migrate sets joinedAt from analyzedAt', async () => {
  // a Phase 1 database: a connected, analysed repo and one never analysed, written before the migration existed
  const dbPath = home.paths().db;
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE repos (full_name TEXT PRIMARY KEY, json TEXT NOT NULL)');
  const analysed = { fullName: 'acme/widgets', connected: true, analyzedAt: '2026-11-01T10:00:00.000Z' };
  const fresh = { fullName: 'acme/fresh', connected: true, analyzedAt: null };
  const joined = { fullName: 'acme/joined', connected: true, analyzedAt: '2026-11-05T00:00:00.000Z', joinedAt: '2026-11-02T00:00:00.000Z' };
  const put = raw.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)');
  for (const r of [analysed, fresh, joined]) put.run(r.fullName, JSON.stringify(r));
  raw.close();

  const { openDb } = await import('../engine/db.js');
  const db = openDb();
  const read = (name: string) =>
    JSON.parse((db.prepare('SELECT json FROM repos WHERE full_name = ?').get(name) as { json: string }).json) as Repo;
  assert.equal(read('acme/widgets').joinedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(read('acme/fresh').joinedAt ?? null, null);
  assert.equal(read('acme/joined').joinedAt, '2026-11-02T00:00:00.000Z', 'an existing joinedAt is kept');
});

test('paths creates runs and reports', () => {
  const p = home.paths();
  assert.equal(p.runs, join(tempDir, 'runs'));
  assert.equal(p.reports, join(tempDir, 'reports'));
  assert.ok(existsSync(p.runs));
  assert.ok(existsSync(p.reports));
});

test('isRealDataHome is exported from engine/home', () => {
  assert.equal(typeof (home as Record<string, unknown>).isRealDataHome, 'function');
  const { isRealDataHome } = home as unknown as { isRealDataHome: (d: string, r?: string) => boolean };
  assert.equal(isRealDataHome(tempDir, tempDir), true);
  assert.equal(isRealDataHome(join(tempDir, 'x'), tempDir), false);
});
