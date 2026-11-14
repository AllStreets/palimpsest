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
import { voyages } from './voyage-table.js';

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
   * The voyage sailing or paused now, from the engine's voyages table (voyages.ts `voyages()`, Task 22), else
   * null: the city lights the library's reading room by it on load, before any event arrives.
   */
  voyage: VoyageView | null;
  /** The live voyage's arena's repo, when its entry names one (`repo`, or `arena.repo`); the city says "a voyage on <repo>". */
  voyageRepo: string | null;
}

/**
 * The live voyage (a thin shim over voyages.ts `voyages()`, Task 22, read
 * through voyage-table.ts so the market imports no Beagle): the
 * one sailing, else the one paused for the night that has sailed (a
 * commissioned voyage still queued, generation 0 with no scores, is not on
 * the campus yet), the newest first; and its repo (`voyage.repo`, else its
 * newest entry's `repo` or `arena.repo`). A voyage races as a train of kind
 * `voyage`: the newest `train.*` of that kind for this voyage (by its
 * `voyageId`, or carrying none, as an engine stop's `train.paused` does)
 * newer than the voyage's own newest entry reads paused or sailing, so a
 * voyage the engine paused only through its train is paused on load.
 */
export function liveVoyage(): { voyage: VoyageView; repo: string | null } | null {
  const unfinished = voyages()
    .filter((v) => v.status === 'sailing' || (v.status === 'paused' && (v.generation > 0 || v.scores.length > 0)))
    .sort((a, b) => Number(b.status === 'sailing') - Number(a.status === 'sailing') || b.startedAt.localeCompare(a.startedAt));
  const v = unfinished[0];
  if (!v) return null;
  const entry = query({ kind: ['voyage.started', 'voyage.generation', 'voyage.ended', 'voyage.commissioned'] })
    .reverse()
    .find((e) => (e.data as { voyageId?: unknown }).voyageId === v.id);
  const d = (entry?.data ?? {}) as { repo?: unknown; arena?: { repo?: unknown } };
  const repo = typeof v.repo === 'string' && v.repo ? v.repo : typeof d.repo === 'string' ? d.repo : typeof d.arena?.repo === 'string' ? d.arena.repo : null;
  const train = query({ kind: ['train.started', 'train.paused', 'train.ended'] })
    .reverse()
    .find((e) => {
      const t = e.data as { train?: { kind?: string }; voyageId?: unknown };
      return t.train?.kind === 'voyage' && (t.voyageId === undefined || t.voyageId === v.id);
    });
  if (train && (!entry || train.id > entry.id) && train.kind !== 'train.ended') {
    return { voyage: { ...v, status: train.kind === 'train.paused' ? 'paused' : 'sailing' }, repo };
  }
  return { voyage: v, repo };
}

export function campusView(): CampusView {
  const slot = campusSlot();
  const live = liveVoyage();
  return { origin: slot === null ? null : districtOrigin(slot), slot, live: { voyage: live !== null, nets: false, lora: false }, voyage: live?.voyage ?? null, voyageRepo: live?.repo ?? null };
}
