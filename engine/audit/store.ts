/**
 * The audits table (Phase 3 Task 4): one row per README audit, whole as
 * JSON, with its repo, status and start for the lookups the runner, the
 * triggers and the pages make. The runner is the only writer.
 */
import type { Audit, AuditStatus } from '../../shared/types.js';
import { openDb } from '../db.js';

/** Statuses of an audit that holds a run root right now. */
export const LIVE_AUDIT: readonly AuditStatus[] = ['preparing', 'installing', 'reading'];
/** Statuses of an audit that is not over: waiting in the queue or live. */
export const OPEN_AUDIT: readonly AuditStatus[] = ['waiting', ...LIVE_AUDIT];

export function saveAudit(a: Audit): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)')
    .run(a.id, a.repo, a.status, a.startedAt, JSON.stringify(a));
}

export function audit(id: string): Audit | null {
  const row = openDb().prepare('SELECT json FROM audits WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Audit) : null;
}

/** Audits newest first, optionally for one repo or in some statuses. */
export function listAudits(f: { repo?: string; status?: AuditStatus[] } = {}): Audit[] {
  const rows = openDb().prepare('SELECT json FROM audits').all() as Array<{ json: string }>;
  return rows
    .map((r) => JSON.parse(r.json) as Audit)
    .filter((a) => (f.repo === undefined || a.repo === f.repo) && (f.status === undefined || f.status.includes(a.status)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

/** The newest audit of a repo in any status, or null when it was never audited (ruling 6's "never"). */
export function latestAudit(repo: string): Audit | null {
  return listAudits({ repo })[0] ?? null;
}

/** Ids of the audits stored in a live status. */
export function liveAuditIds(): string[] {
  return listAudits({ status: [...LIVE_AUDIT] }).map((a) => a.id);
}
