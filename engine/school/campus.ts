/**
 * The university's plot (Phase 4 ruling 27, Decision 16). The campus takes
 * the next free plot of the district spiral the first time the Phase 4
 * engine starts, through the same numbering repos and firms share, so
 * nothing already standing moves and no later district lands on it. The
 * campus is that one 240 m block; the city draws it from this origin.
 */
import { districtOrigin } from '../../shared/district-layout.js';
import { nextSlot } from '../repos.js';

/** The campus's owner in the slots table. */
export const CAMPUS_OWNER = 'university';

/** The campus's slot: taken once, the same slot on every later call. */
export function ensureCampus(): number {
  return nextSlot('campus', CAMPUS_OWNER);
}

/** Where the campus stands: its slot's district origin. */
export function campusOrigin(): { x: number; z: number } {
  return districtOrigin(ensureCampus());
}

/** What `GET /api/school/campus` answers. */
export interface CampusView {
  origin: { x: number; z: number };
  slot: number;
  /** What is under way on the campus, for its life (Task 37); all false until the voyages, nets and LoRA land. */
  live: { voyage: boolean; nets: boolean; lora: boolean };
}

export function campusView(): CampusView {
  const slot = ensureCampus();
  return { origin: districtOrigin(slot), slot, live: { voyage: false, nets: false, lora: false } };
}
