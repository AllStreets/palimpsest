import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { entries, query, record } from '../engine/ledger.js';
import { LEDGER_KINDS, type LedgerKind } from '../shared/ledger-kinds.js';

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

const PHASE_1: LedgerKind[] = [
  'repo.analyzed',
  'repo.connected',
  'repo.disconnected',
  'repo.error',
  'repo.patched',
  'usage.hook.installed',
  'engine.stopped',
  'engine.resumed',
];

test('record refuses a kind outside LEDGER_KINDS', () => {
  assert.throws(() => record('job.exploded' as LedgerKind, {}), /unknown ledger kind job\.exploded/);
  assert.throws(() => record('' as LedgerKind, {}), /unknown ledger kind/);
  assert.equal(entries().length, 0, 'nothing is written for a refused kind');
});

test('record accepts every Phase 1 kind', () => {
  for (const kind of PHASE_1) record(kind, { kind });
  assert.deepEqual(
    entries().map((e) => e.kind),
    PHASE_1,
  );
});

test('LEDGER_KINDS holds the market kinds and no duplicates', () => {
  for (const kind of ['firm.seeded', 'job.awarded', 'run.ended', 'credits.moved', 'api.key.removed']) {
    assert.ok((LEDGER_KINDS as readonly string[]).includes(kind), kind);
  }
  assert.equal(new Set(LEDGER_KINDS).size, LEDGER_KINDS.length);
});

test('the ledger is indexed by kind, job and run', () => {
  record('job.posted', { job: { id: 'job-1', title: 'one' } });
  record('job.changed', { id: 'job-1', from: 'open', to: 'bidding', job: { id: 'job-1' } });
  record('bid.placed', { bid: { id: 'bid-1', jobId: 'job-1' } });
  record('run.started', { runId: 'run-1', jobId: 'job-1', run: { id: 'run-1', jobId: 'job-1' } });
  record('run.note', { runId: 'run-1', jobId: 'job-1', note: 'one' });
  record('run.note', { runId: 'run-2', jobId: 'job-2', note: 'two' });
  record('inspection.done', { inspection: { id: 'i-1', runId: 'run-1', jobId: 'job-1' } });
  record('credits.moved', { runId: 'run-2', jobId: null, rowIds: [3] });

  assert.deepEqual(query({ jobId: 'job-1' }).map((e) => e.kind), ['job.posted', 'job.changed', 'bid.placed', 'run.started', 'run.note', 'inspection.done']);
  assert.deepEqual(query({ runId: 'run-2' }).map((e) => e.kind), ['run.note', 'credits.moved']);
  assert.deepEqual(query({ kind: 'run.note', jobId: 'job-2' }).map((e) => (e.data as { note: string }).note), ['two']);
  assert.deepEqual(query({ kind: ['run.note', 'credits.moved'] }).length, 3);
  assert.equal(query({ kind: 'run.note', last: true }).length, 1);
  assert.equal((query({ kind: 'run.note', last: true })[0].data as { note: string }).note, 'two');

  // SQLite answers from the indexes, not a scan of every entry.
  const plan = (sql: string, ...args: string[]) => (openDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(' ');
  assert.match(plan('SELECT id FROM ledger WHERE job_id = ? ORDER BY id', 'job-1'), /ledger_job/);
  assert.match(plan('SELECT id FROM ledger WHERE run_id = ? ORDER BY id', 'run-1'), /ledger_run/);
  assert.match(plan('SELECT id FROM ledger WHERE kind = ? ORDER BY id', 'run.note'), /ledger_kind/);
});

test('a ledger written before the index gets its job and run columns filled in', () => {
  const db = new DatabaseSync(paths().db);
  db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL)');
  const put = db.prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)');
  put.run('2026-11-01T00:00:00.000Z', 'job.changed', JSON.stringify({ id: 'job-7', from: 'open', to: 'bidding', job: { id: 'job-7' } }));
  put.run('2026-11-01T00:00:01.000Z', 'run.ended', JSON.stringify({ runId: 'run-7', jobId: 'job-7', run: { id: 'run-7', jobId: 'job-7' } }));
  put.run('2026-11-01T00:00:02.000Z', 'inspection.done', JSON.stringify({ inspection: { id: 'i', runId: 'run-8', jobId: 'job-8' } }));
  put.run('2026-11-01T00:00:03.000Z', 'repo.connected', JSON.stringify({ repo: 'acme/widgets' }));
  db.close();

  assert.deepEqual(query({ jobId: 'job-7' }).map((e) => e.kind), ['job.changed', 'run.ended']);
  assert.deepEqual(query({ runId: 'run-8' }).map((e) => e.kind), ['inspection.done']);
  assert.equal(entries().length, 4, 'nothing was lost');
  const cols = (openDb().prepare('PRAGMA table_info(ledger)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('job_id') && cols.includes('run_id'));
});

test("a firm's books are read through the per-firm index on credits.moved", async () => {
  const { BOOKS_SQL, OLDER_SQL } = await import('../engine/market/firm-story.js');
  record('credits.moved', { kind: 'run', firmId: 'kiln', delta: -2, rowIds: [1] });
  const plan = (sql: string, ...args: Array<string | number>) => (openDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(' ');
  assert.match(plan(BOOKS_SQL, 'kiln', 10), /ledger_moved_firm/, 'the newest movements of one firm');
  assert.match(plan(OLDER_SQL, 'kiln', 5), /ledger_moved_firm/, 'and the sum of those older than the page');
});
