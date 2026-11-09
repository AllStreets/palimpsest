import { openDb } from './db.js';

export interface LedgerEntry {
  id: number;
  at: string;
  kind: string;
  data: unknown;
}

/** Appends an entry to the ledger and returns its id. No update or delete is exposed: the ledger is append-only. */
export function record(kind: string, data: object): number {
  const db = openDb();
  const at = new Date().toISOString();
  const json = JSON.stringify(data);
  const result = db.prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)').run(at, kind, json);
  return Number(result.lastInsertRowid);
}

/** Entries in ascending id order. With `since`, only entries whose id is greater than it. */
export function entries(since?: number): LedgerEntry[] {
  const db = openDb();
  const rows =
    since === undefined
      ? (db.prepare('SELECT id, at, kind, json FROM ledger ORDER BY id ASC').all() as Array<{
          id: number | bigint;
          at: string;
          kind: string;
          json: string;
        }>)
      : (db.prepare('SELECT id, at, kind, json FROM ledger WHERE id > ? ORDER BY id ASC').all(since) as Array<{
          id: number | bigint;
          at: string;
          kind: string;
          json: string;
        }>);

  return rows.map((row) => ({
    id: Number(row.id),
    at: row.at,
    kind: row.kind,
    data: JSON.parse(row.json),
  }));
}
