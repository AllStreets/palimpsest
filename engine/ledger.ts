import { isLedgerKind, type LedgerKind } from '../shared/ledger-kinds.js';
import { openDb } from './db.js';

export type { LedgerKind } from '../shared/ledger-kinds.js';

export interface LedgerEntry {
  id: number;
  at: string;
  kind: string;
  data: unknown;
}

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

/**
 * The job and run an entry is about, from where each kind keeps them (the
 * columns the ledger is indexed on; db.ts holds the same rule in SQL for
 * entries written before the index existed).
 */
export function refsOf(kind: string, data: object): { jobId: string | null; runId: string | null } {
  const d = data as Record<string, unknown>;
  const inner = (k: string) => (d[k] && typeof d[k] === 'object' ? (d[k] as Record<string, unknown>) : {});
  const jobId = str(d.jobId) ?? str(inner('job').id) ?? str(inner('bid').jobId) ?? str(inner('run').jobId) ?? str(inner('inspection').jobId) ?? (kind === 'job.changed' ? str(d.id) : null);
  const runId = str(d.runId) ?? str(inner('run').id) ?? str(inner('inspection').runId);
  return { jobId, runId };
}

/**
 * Appends an entry to the ledger and returns its id. No update or delete is
 * exposed: the ledger is append-only. Throws `unknown ledger kind <kind>`
 * for a kind outside LEDGER_KINDS, before anything is written.
 */
export function record(kind: LedgerKind, data: object): number {
  if (!isLedgerKind(kind)) throw new Error(`unknown ledger kind ${kind}`);
  const db = openDb();
  const at = new Date().toISOString();
  const json = JSON.stringify(data);
  const { jobId, runId } = refsOf(kind, data);
  const result = db.prepare('INSERT INTO ledger (at, kind, json, job_id, run_id) VALUES (?, ?, ?, ?, ?)').run(at, kind, json, jobId, runId);
  return Number(result.lastInsertRowid);
}

type Row = { id: number | bigint; at: string; kind: string; json: string };
const toEntry = (row: Row): LedgerEntry => ({ id: Number(row.id), at: row.at, kind: row.kind, data: JSON.parse(row.json) });

/** Entries in ascending id order. With `since`, only entries whose id is greater than it. */
export function entries(since?: number): LedgerEntry[] {
  return query(since === undefined ? {} : { since });
}

export interface LedgerQuery {
  /** One kind or several. */
  kind?: LedgerKind | readonly LedgerKind[];
  jobId?: string;
  runId?: string;
  /** Only entries whose id is greater than this. */
  since?: number;
  /** Only entries at or after this ISO time. */
  from?: string;
  /** Only entries before this ISO time. */
  to?: string;
  /** Only the newest matching entry. */
  last?: boolean;
}

/**
 * Entries matching every given filter, oldest first, answered from the
 * ledger's indexes (kind, job, run, time) rather than a scan of all of it.
 */
export function query(q: LedgerQuery): LedgerEntry[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (q.kind !== undefined) {
    const kinds: string[] = typeof q.kind === 'string' ? [q.kind] : [...q.kind];
    if (kinds.length === 0) return [];
    where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    args.push(...kinds);
  }
  if (q.jobId !== undefined) {
    where.push('job_id = ?');
    args.push(q.jobId);
  }
  if (q.runId !== undefined) {
    where.push('run_id = ?');
    args.push(q.runId);
  }
  if (q.since !== undefined) {
    where.push('id > ?');
    args.push(q.since);
  }
  if (q.from !== undefined) {
    where.push('at >= ?');
    args.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('at < ?');
    args.push(q.to);
  }
  const sql = `SELECT id, at, kind, json FROM ledger${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${q.last ? 'DESC LIMIT 1' : 'ASC'}`;
  return (openDb().prepare(sql).all(...args) as Row[]).map(toEntry);
}
