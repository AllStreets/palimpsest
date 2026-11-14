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
import { nextSlot } from '../repos.js';
import { voyageQueued } from '../../shared/school-rules.js';
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
  /** What is under way on the campus, for its life (Task 37): the live voyage, and a nets or LoRA train running now (Task 28). */
  live: { voyage: boolean; nets: boolean; lora: boolean };
  /**
   * The voyage sailing or paused now, from the engine's voyages table (voyages.ts `voyages()`, Task 22), else
   * null: the city lights the library's reading room by it on load, before any event arrives.
   */
  voyage: VoyageView | null;
  /** The live voyage's arena's repo, when its entry names one (`repo`, or `arena.repo`); the city says "a voyage on <repo>". */
  voyageRepo: string | null;
}

/** The newest ledger entry of one of `kinds` that `where` (an extra SQL condition on `json`) admits: one indexed read from the newest end, never a scan of the whole ledger into memory. */
function newest(kinds: readonly string[], where: string, args: Array<string | null>): { id: number; kind: string; data: Record<string, unknown> } | null {
  const row = openDb()
    .prepare(`SELECT id, kind, json FROM ledger WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND ${where} ORDER BY id DESC LIMIT 1`)
    .get(...kinds, ...args) as { id: number; kind: string; json: string } | undefined;
  if (!row) return null;
  try {
    return { id: Number(row.id), kind: row.kind, data: JSON.parse(row.json) as Record<string, unknown> };
  } catch {
    return null;
  }
}

const VOYAGE_KINDS = ['voyage.started', 'voyage.generation', 'voyage.ended', 'voyage.commissioned'] as const;
const TRAIN_KINDS = ['train.started', 'train.paused', 'train.ended'] as const;

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
 * voyage the engine paused only through its train is paused on load. Both
 * entries are read newest first, one row each (Task 28: the scan is bounded).
 */
export function liveVoyage(): { voyage: VoyageView; repo: string | null } | null {
  const unfinished = voyages()
    .filter((v) => v.status === 'sailing' || (v.status === 'paused' && !voyageQueued(v)))
    .sort((a, b) => Number(b.status === 'sailing') - Number(a.status === 'sailing') || b.startedAt.localeCompare(a.startedAt));
  const v = unfinished[0];
  if (!v) return null;
  const entry = newest(VOYAGE_KINDS, "json_extract(json, '$.voyageId') = ?", [v.id]);
  const d = (entry?.data ?? {}) as { repo?: unknown; arena?: { repo?: unknown } };
  const repo = typeof v.repo === 'string' && v.repo ? v.repo : typeof d.repo === 'string' ? d.repo : typeof d.arena?.repo === 'string' ? d.arena.repo : null;
  const train = newest(TRAIN_KINDS, "json_extract(json, '$.train.kind') = 'voyage' AND (json_extract(json, '$.voyageId') IS NULL OR json_extract(json, '$.voyageId') = ?)", [v.id]);
  if (train && (!entry || train.id > entry.id) && train.kind !== 'train.ended') {
    return { voyage: { ...v, status: train.kind === 'train.paused' ? 'paused' : 'sailing' }, repo };
  }
  return { voyage: v, repo };
}

/** The kinds of train under way now, from the trains table (trainer.ts and voyages.ts write a train's row as it starts and ends). */
function trainsRunning(): Set<string> {
  const rows = openDb().prepare("SELECT DISTINCT kind FROM trains WHERE status = 'running'").all() as Array<{ kind: string }>;
  return new Set(rows.map((r) => r.kind));
}

export function campusView(): CampusView {
  const slot = campusSlot();
  const live = liveVoyage();
  const running = trainsRunning();
  return {
    origin: slot === null ? null : districtOrigin(slot),
    slot,
    live: { voyage: live !== null, nets: running.has('nets'), lora: running.has('lora') },
    voyage: live?.voyage ?? null,
    voyageRepo: live?.repo ?? null,
  };
}
