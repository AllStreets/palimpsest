/**
 * The university's plot (Phase 4 ruling 27, Decision 16). The campus takes
 * the next free plot of the district spiral the first time the Phase 4
 * engine starts, through the same numbering repos and firms share, so
 * nothing already standing moves and no later district lands on it. The
 * campus is that one 240 m block; the city draws it from this origin.
 */
import { districtOrigin } from '../../shared/district-layout.js';
import { openDb } from '../db.js';
import { nextSlot } from '../repos.js';

/** The campus's owner in the slots table. */
export const CAMPUS_OWNER = 'university';

/** The campus's slot: taken once, the same slot on every later call. Only engine start calls it. */
export function ensureCampus(): number {
  return nextSlot('campus', CAMPUS_OWNER);
}

/** The campus's slot once the engine has taken it, else null. A read: it never takes a plot. */
export function campusSlot(): number | null {
  const row = openDb().prepare('SELECT slot FROM slots WHERE kind = ? AND owner = ?').get('campus', CAMPUS_OWNER) as { slot: number } | undefined;
  return row ? Number(row.slot) : null;
}

/** Where the campus stands (its slot's district origin), or null before the engine has taken the plot. */
export function campusOrigin(): { x: number; z: number } | null {
  const slot = campusSlot();
  return slot === null ? null : districtOrigin(slot);
}

/** What `GET /api/school/campus` answers; `origin` and `slot` are null before the plot is taken. */
export interface CampusView {
  origin: { x: number; z: number } | null;
  slot: number | null;
  /** What is under way on the campus, for its life (Task 37); all false until the voyages, nets and LoRA land. */
  live: { voyage: boolean; nets: boolean; lora: boolean };
}

export function campusView(): CampusView {
  const slot = campusSlot();
  return { origin: slot === null ? null : districtOrigin(slot), slot, live: { voyage: false, nets: false, lora: false } };
}
