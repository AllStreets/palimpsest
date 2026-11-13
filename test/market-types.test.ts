import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';

import * as home from '../engine/home.js';
import { poolOfModel, repoMarketDefaults } from '../shared/market-rules.js';
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

const MARKET_TABLES = ['jobs', 'firms', 'agents', 'bids', 'runs', 'inspections', 'baselines', 'earned_floors', 'trips', 'slots', 'credits', 'audits', 'milestones'];

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

test('slots refuse two owners on one plot and the unique index is idempotent', async () => {
  const { openDb: open, migrate } = await import('../engine/db.js');
  const db = open();
  migrate(db);
  db.prepare("INSERT INTO slots (kind, owner, slot) VALUES ('repo', 'a/b', 4)").run();
  assert.throws(() => db.prepare("INSERT INTO slots (kind, owner, slot) VALUES ('firm', 'kiln', 4)").run(), /UNIQUE/);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'slots_slot'").all();
  assert.equal(idx.length, 1);
});

test('the db has audits and milestones tables and jobs.key', async () => {
  // A Phase 2 database: a jobs table without the key column, with a job already in it.
  const raw = new DatabaseSync(home.paths().db);
  raw.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL)');
  raw.prepare('INSERT INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)').run('job-1', 'acme/widgets', 'open', '{"id":"job-1"}');
  raw.close();

  const { migrate, openDb } = await import('../engine/db.js');
  const db = openDb();
  migrate(db);
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols('audits'), ['id', 'repo', 'status', 'started_at', 'json']);
  assert.deepEqual(cols('milestones'), ['id', 'kind', 'tower_id', 'at', 'until', 'json']);
  assert.ok(cols('jobs').includes('key'), 'the migration added jobs.key');
  assert.equal((db.prepare('SELECT key FROM jobs WHERE id = ?').get('job-1') as { key: string | null }).key, null, 'an older job has no key');
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const i of ['audits_repo', 'milestones_tower', 'jobs_key']) assert.ok(indexes.includes(i), i);
  db.prepare('INSERT INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)').run('audit-1', 'acme/widgets', 'done', '2026-11-11T08:00:00.000Z', '{}');
  db.prepare('INSERT INTO milestones (id, kind, tower_id, at, until, json) VALUES (?, ?, ?, ?, ?, ?)').run('skyline:1', 'skyline', 'acme/widgets#founding', '2026-11-11T08:00:00.000Z', null, '{}');
  db.prepare('UPDATE jobs SET key = ? WHERE id = ?').run('acme/widgets#abcdef012345', 'job-1');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE key = ?').get('acme/widgets#abcdef012345') as { n: number }).n, 1);
});

/** Pin (ruling 26): a graduate's mlx model already counts in the local pool, so it shares the local slot and never the Claude window. */
test("poolOfModel('mlx:grad-x') is local", () => {
  assert.equal(poolOfModel('mlx:grad-x'), 'local');
  assert.equal(poolOfModel('mlx:grad-qwen25-coder-7b-1'), 'local');
});

/** Pin: the school's tables join a Phase 3 database without touching what it holds, however often it migrates. */
test('a Phase 3 database with data migrates twice and keeps every row', async () => {
  const raw = new DatabaseSync(home.paths().db);
  raw.exec(`
    CREATE TABLE repos (full_name TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, job_id TEXT, run_id TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, key TEXT);
    CREATE TABLE slots (kind TEXT NOT NULL, owner TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (kind, owner));
    CREATE TABLE credits (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, firm_id TEXT, run_id TEXT, kind TEXT NOT NULL, amount REAL NOT NULL, usd REAL, json TEXT NOT NULL);
    CREATE TABLE audits (id TEXT PRIMARY KEY, repo TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE milestones (id TEXT PRIMARY KEY, kind TEXT NOT NULL, tower_id TEXT NOT NULL, at TEXT NOT NULL, until TEXT, json TEXT NOT NULL);
  `);
  const repo = { fullName: 'acme/widgets', connected: true, slot: 0, analyzedAt: '2026-11-01T00:00:00.000Z', ...repoMarketDefaults(), joinedAt: '2026-11-01T00:00:00.000Z' };
  raw.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  raw.prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)').run('2026-11-11T08:00:00.000Z', 'brief.opened', '{"day":"2026-11-11","items":[]}');
  raw.prepare('INSERT INTO settings (key, json) VALUES (?, ?)').run('dayCapPct', '35');
  raw.prepare('INSERT INTO jobs (id, repo, status, json, key) VALUES (?, ?, ?, ?, ?)').run('job-1', 'acme/widgets', 'open', '{"id":"job-1","source":"issue"}', null);
  raw.prepare("INSERT INTO slots (kind, owner, slot) VALUES ('repo', 'acme/widgets', 0)").run();
  raw.prepare('INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)').run('2026-11-11T09:00:00.000Z', null, 'audit-1', 'audit', 4, null, '{"model":"claude:sonnet"}');
  raw.prepare('INSERT INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)').run('audit-1', 'acme/widgets', 'done', '2026-11-11T08:30:00.000Z', '{"id":"audit-1"}');
  raw.prepare('INSERT INTO milestones (id, kind, tower_id, at, until, json) VALUES (?, ?, ?, ?, ?, ?)').run('skyline:1', 'skyline', 'acme/widgets#founding', '2026-11-11T08:00:00.000Z', null, '{"id":"skyline:1"}');
  const snapshot = (db: DatabaseSync) =>
    Object.fromEntries(['repos', 'ledger', 'settings', 'jobs', 'slots', 'credits', 'audits', 'milestones'].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  const before = snapshot(raw);
  raw.close();

  const { migrate, openDb } = await import('../engine/db.js');
  const db = openDb();
  migrate(db);
  migrate(db);
  assert.deepEqual(snapshot(db), before);
  const names = tables(home.paths().db);
  for (const t of ['nets', 'predictions', 'decisions', 'grants', 'arenas', 'arena_tasks', 'voyages', 'trains', 'graduates', 'verified']) {
    assert.ok(names.includes(t), t);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, `${t} starts empty`);
  }
});
