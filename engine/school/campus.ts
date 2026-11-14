/**
 * The university's plot (Phase 4 ruling 27, Decision 16). The campus takes
 * the next free plot of the district spiral the first time the Phase 4
 * engine starts, through the same numbering repos and firms share, so
 * nothing already standing moves and no later district lands on it. The
 * campus is that one 240 m block; the city draws it from this origin.
 */
import { districtOrigin } from '../../shared/district-layout.js';
import type { VoyageView } from '../../shared/types.js';
import { openDb } from '../db.js';
import { query } from '../ledger.js';
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
  /** What is under way on the campus, for its life (Task 37): `voyage` from the ledger here; nets and LoRA false until Task 28 reads the trains. */
  live: { voyage: boolean; nets: boolean; lora: boolean };
  /**
   * The voyage sailing or paused now, as the ledger's newest `voyage.*` entry carries it (`data.voyage`, a
   * VoyageView), else null: the city lights the library's reading room by it on load, before any event arrives.
   * Task 22's `voyages()` is the better source once it lands; the shape is the same.
   */
  voyage: VoyageView | null;
  /** The live voyage's arena's repo, when its entry names one (`repo`, or `arena.repo`); the city says "a voyage on <repo>". */
  voyageRepo: string | null;
}

/**
 * The newest voyage the ledger knows, when it is still live (sailing or
 * paused for the night), and its repo if its entry says. A voyage races as
 * a train of kind `voyage` (one a night): a `train.paused` newer than the
 * voyage's own entry reads as paused, a `train.started` newer as sailing,
 * so a voyage paused only through its train is paused on load.
 */
export function liveVoyage(): { voyage: VoyageView; repo: string | null } | null {
  const last = query({ kind: ['voyage.started', 'voyage.generation', 'voyage.ended'], last: true })[0];
  const d = (last?.data ?? {}) as { voyage?: VoyageView; repo?: unknown; arena?: { repo?: unknown } };
  const v = d.voyage;
  if (!v || typeof v !== 'object' || !v.id) return null;
  if (v.status !== 'sailing' && v.status !== 'paused') return null;
  const repo = typeof d.repo === 'string' ? d.repo : typeof d.arena?.repo === 'string' ? d.arena.repo : null;
  const train = query({ kind: ['train.started', 'train.paused', 'train.ended'], last: true })[0];
  const t = (train?.data as { train?: { kind?: string } } | undefined)?.train;
  if (train && last && train.id > last.id && t?.kind === 'voyage' && train.kind !== 'train.ended') {
    return { voyage: { ...v, status: train.kind === 'train.paused' ? 'paused' : 'sailing' }, repo };
  }
  return { voyage: v, repo };
}

export function campusView(): CampusView {
  const slot = campusSlot();
  const live = liveVoyage();
  return { origin: slot === null ? null : districtOrigin(slot), slot, live: { voyage: live !== null, nets: false, lora: false }, voyage: live?.voyage ?? null, voyageRepo: live?.repo ?? null };
}
