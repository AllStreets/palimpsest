import { DatabaseSync } from 'node:sqlite';
import { HARNESS_KEY, repoMarketDefaults } from '../shared/market-rules.js';
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
    json TEXT NOT NULL,
    job_id TEXT,
    run_id TEXT
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
    json TEXT NOT NULL,
    key TEXT
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
    json TEXT NOT NULL,
    agent_id TEXT
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

/** Phase 3: the README audits and the city's milestones. */
const PHASE3_SCHEMA = `
  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audits_repo ON audits (repo, started_at);
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    tower_id TEXT NOT NULL,
    at TEXT NOT NULL,
    until TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS milestones_tower ON milestones (tower_id);
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
  migrateLedgerIndex(db);
  db.exec(MARKET_SCHEMA);
  migrateTripsAgent(db);
  migrateJobKey(db);
  db.exec(PHASE3_SCHEMA);

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

/**
 * The SQL twin of ledger.ts `refsOf()`: the job and run an entry is about,
 * read from where each kind keeps them.
 */
const JOB_REF = `COALESCE(
  json_extract(json, '$.jobId'), json_extract(json, '$.job.id'), json_extract(json, '$.bid.jobId'),
  json_extract(json, '$.run.jobId'), json_extract(json, '$.inspection.jobId'),
  CASE WHEN kind = 'job.changed' THEN json_extract(json, '$.id') END)`;
const RUN_REF = `COALESCE(json_extract(json, '$.runId'), json_extract(json, '$.run.id'), json_extract(json, '$.inspection.runId'))`;

/**
 * The ledger's index (Task 18): each entry carries the job and run it is
 * about in its own columns, indexed with its kind and time, so a lookup by
 * kind, job or run (the treasury's cursor, its notes, the award a payment
 * reads, the daily report) never scans the whole ledger. A ledger written
 * before the columns existed gets them and is filled in once, from the json.
 */
function migrateLedgerIndex(db: DatabaseSync): void {
  const cols = new Set((db.prepare('PRAGMA table_info(ledger)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('job_id') || !cols.has('run_id')) {
    db.exec('BEGIN');
    try {
      if (!cols.has('job_id')) db.exec('ALTER TABLE ledger ADD COLUMN job_id TEXT');
      if (!cols.has('run_id')) db.exec('ALTER TABLE ledger ADD COLUMN run_id TEXT');
      db.exec(`UPDATE ledger SET job_id = ${JOB_REF}, run_id = ${RUN_REF}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS ledger_kind ON ledger (kind, id);
    CREATE INDEX IF NOT EXISTS ledger_job ON ledger (job_id, id);
    CREATE INDEX IF NOT EXISTS ledger_run ON ledger (run_id, id);
    CREATE INDEX IF NOT EXISTS ledger_at ON ledger (at);
    -- A firm's books (Task 38): its credits.moved entries, read per firm.
    CREATE INDEX IF NOT EXISTS ledger_moved_firm ON ledger (json_extract(json, '$.firmId'), id) WHERE kind = 'credits.moved';
  `);
}

/**
 * Trips written before the agent column existed (Task 33) get it from their
 * json, so a person's trips are read by index. The index is made here, not in
 * MARKET_SCHEMA, so an older trips table gains its column before the index
 * that reads it.
 */
function migrateTripsAgent(db: DatabaseSync): void {
  const cols = new Set((db.prepare('PRAGMA table_info(trips)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('agent_id')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE trips ADD COLUMN agent_id TEXT');
      db.exec("UPDATE trips SET agent_id = json_extract(json, '$.agentId')");
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS trips_agent ON trips (agent_id)');
}

/**
 * A proposal's key on its job row (Phase 3 Task 1): a jobs table written
 * before the column existed gets it, empty, and the index on it.
 */
/**
 * Adds `jobs.key` to an older table and backfills it for every harness job
 * posted before keys existed, in the column and in the json, built exactly
 * as HARNESS_KEY builds it. Without the backfill a harness he dismissed, or
 * one that merged, would be proposed again by the first analysis after the
 * upgrade (Phase 3 Task 5's key rule reads the key column).
 */
function migrateJobKey(db: DatabaseSync): void {
  const cols = new Set((db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('key')) db.exec('ALTER TABLE jobs ADD COLUMN key TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS jobs_key ON jobs (key)');
  const keyless = db
    .prepare("SELECT id, repo, json FROM jobs WHERE key IS NULL AND json_extract(json, '$.source') = 'harness'")
    .all() as Array<{ id: string; repo: string; json: string }>;
  if (!keyless.length) return;
  const update = db.prepare('UPDATE jobs SET key = ?, json = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of keyless) {
      const key = HARNESS_KEY(row.repo);
      update.run(key, JSON.stringify({ ...(JSON.parse(row.json) as Record<string, unknown>), key }), row.id);
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
