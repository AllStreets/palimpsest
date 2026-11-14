/**
 * The voyages table read alone (Task 22's `voyages()` and `voyage()`), with
 * nothing but the database imported, so the campus (campus.ts, which
 * trips.ts and the market import) can read the live voyage without pulling
 * voyages.ts's Beagle, trainer and tick into the market's import graph.
 * voyages.ts re-exports both; they are the one reading of the table.
 */
import type { VoyageView } from '../../shared/types.js';
import { openDb } from '../db.js';

/** Every voyage, oldest first. */
export function voyages(): VoyageView[] {
  const rows = openDb().prepare('SELECT json FROM voyages').all() as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as VoyageView).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

export function voyage(id: string): VoyageView | null {
  const row = openDb().prepare('SELECT json FROM voyages WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as VoyageView) : null;
}
