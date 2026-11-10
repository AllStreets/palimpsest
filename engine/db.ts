import { DatabaseSync } from 'node:sqlite';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Repo } from '../shared/types.js';
import { paths } from './home.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    full_name TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS towers (
    repo TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
`;

/** The market's tables (Phase 2). Each row keeps its full record in `json`; the other columns are what queries filter on. */
const MARKET_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    status TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_repo ON jobs (repo);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
  CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agents_firm ON agents (firm_id);
  CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bids_job ON bids (job_id);
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    stage TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_job ON runs (job_id);
  CREATE INDEX IF NOT EXISTS runs_repo ON runs (repo);
  CREATE TABLE IF NOT EXISTS inspections (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS inspections_run ON inspections (run_id);
  CREATE TABLE IF NOT EXISTS baselines (
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (repo, sha)
  );
  CREATE TABLE IF NOT EXISTS earned_floors (
    id TEXT PRIMARY KEY,
    tower_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS earned_floors_tower ON earned_floors (tower_id, seq);
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slots (
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    slot INTEGER NOT NULL,
    PRIMARY KEY (kind, owner)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS slots_slot ON slots (slot);
  CREATE TABLE IF NOT EXISTS credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    firm_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    usd REAL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS credits_firm ON credits (firm_id);
  CREATE INDEX IF NOT EXISTS credits_run ON credits (run_id);
`;

/**
 * Brings a database up to the current schema. Idempotent: every table and
 * index is created only when missing, and a repo row is rewritten only when
 * it lacks a market field. A repo connected before Phase 2 gets the market
 * defaults (market off) and `joinedAt = analyzedAt`, so its datum stays where
 * its founding floors already end (ruling 17).
 */
export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.exec(MARKET_SCHEMA);

  const rows = db.prepare('SELECT full_name, json FROM repos').all() as Array<{ full_name: string; json: string }>;
  const update = db.prepare('UPDATE repos SET json = ? WHERE full_name = ?');
  const defaults = repoMarketDefaults();
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const repo = JSON.parse(row.json) as Partial<Repo> & Record<string, unknown>;
      const missing = (Object.keys(defaults) as Array<keyof typeof defaults>).filter((k) => !(k in repo));
      if (missing.length === 0) continue;
      const filled: Record<string, unknown> = { ...repo };
      for (const k of missing) filled[k] = k === 'joinedAt' ? (repo.analyzedAt ?? null) : defaults[k];
      update.run(JSON.stringify(filled), row.full_name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Cached per resolved db file path, so a changed PALIMPSEST_HOME (as every
// test gives itself a fresh temp dir) opens a fresh connection instead of
// reusing one pointed at a previous test's database.
const connections = new Map<string, DatabaseSync>();

export function openDb(): DatabaseSync {
  const dbPath = paths().db;
  let db = connections.get(dbPath);
  if (!db) {
    db = new DatabaseSync(dbPath);
    migrate(db);
    connections.set(dbPath, db);
  }
  return db;
}
