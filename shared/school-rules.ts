/**
 * The school's fixed rules (Phase 4): the kinds of his work autonomy may be
 * granted for, the numbers the plan's rulings pin, and the training window.
 * Pure: no engine import, so the app and the engine read the same values.
 */
import type { Job, Tier, VoyageView, WorkKind } from './types.js';

/** The six kinds of work, in the order the screens list them (Decision 11). */
export const WORK_KINDS: readonly WorkKind[] = ['propose:harness', 'propose:readme-gap', 'merge:low', 'merge:normal', 'merge:high', 'merge:ui'];

/**
 * The kind of decision a job puts to him (ruling 14). With no inspection it
 * is the proposal itself: `propose:harness` for a harness job,
 * `propose:readme-gap` for an audit's proposal. With an inspection it is the
 * PR: `merge:ui` when the inspection checked the design, else the tier's
 * merge. An issue or manual job is never proposed, so it is always a merge.
 */
export function workKind(job: Pick<Job, 'source'> & { tier: Tier }, inspection: { design?: unknown } | null): WorkKind {
  if (inspection === null) {
    if (job.source === 'harness') return 'propose:harness';
    if (job.source === 'proposal') return 'propose:readme-gap';
  }
  if (inspection?.design) return 'merge:ui';
  return `merge:${job.tier}`;
}

/** The key one decision and its prediction share: `<kind>:<jobId>`. */
export function itemKey(kind: WorkKind, jobId: string): string {
  return `${kind}:${jobId}`;
}

/**
 * The agreement window (Decision 12, rulings 16 to 18): the last `window` of
 * his decisions of a kind at `rate` or better; a repo needs `repoMin` of its
 * own and none of its last `repoLast` against; an act needs `actP` from a
 * master no older than `staleDays`; a decline or revocation is quiet for
 * `quietDays`.
 */
export const AGREE = { window: 50, rate: 0.95, repoMin: 10, repoLast: 10, actP: 0.9, quietDays: 30, staleDays: 8 } as const;
/** A net reports nothing until it has this many training and held-out rows (ruling 11). */
export const NET_MIN = { train: 30, heldOut: 10 } as const;
/** The newest share of rows held out (ruling 11). */
export const HELD_OUT = 0.2;
/** Soft labels from the master, at this weight, while a net has fewer than `under` rows of its own (ruling 13). */
export const DISTIL = { weight: 0.3, under: 100 } as const;
/** The training gate (ruling 6): re-read every `pollMs`, `minFreeGB` free, "Train now" for `trainNowHours`, SIGKILL `killGraceMs` after SIGTERM. */
export const GATE = { pollMs: 30_000, minFreeGB: 20, trainNowHours: 3, killGraceMs: 10_000 } as const;
/** LoRA training (ruling 24) and its dataset (ruling 23); `gb` is the base model's size, for its local credits. */
export const LORA = { min: 100, iters: 600, saveEvery: 50, layers: 16, batch: 2, lr: 1e-5, maxSeq: 4096, maxFileBytes: 24_000, gb: 4.3 } as const;
/** Arenas (rulings 20 and 21). */
export const ARENA = { mutants: 120, keepPlanted: 60, keepPast: 40, maxTurns: 24 } as const;
/** Voyages (ruling 22). */
export const VOYAGE = { population: 8, generations: 4, concurrency: 1 } as const;

/**
 * A commissioned voyage not yet sailed (Task 23): stored at commissioning as
 * `paused` at generation 0 with no scores. It is queued, not paused, in every
 * view, and never the campus's live voyage.
 */
export function voyageQueued(v: Pick<VoyageView, 'status' | 'generation' | 'scores'>): boolean {
  return v.status === 'paused' && v.generation === 0 && (v.scores?.length ?? 0) === 0;
}
/** Sealed races an arena's sealed split allows before it is spent (ruling 25). */
export const SEALED_USES = 10;
/** A firm's commission of a voyage (ruling 22, Decision 15). */
export const COMMISSION = { fee: 120, minBalance: 400, firstRefusalDays: 7 } as const;
/** Days after a city merge a fix by him counts as a follow-up (ruling 9). */
export const FOLLOWUP_DAYS = 14;
/** Days a change must survive to count as verified or durable (rulings 8 and 23). */
export const SURVIVE_DAYS = 30;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Whether the local time at `now` is inside `window`, start included and end
 * excluded. A window whose end is before its start crosses midnight (22:00
 * to 04:00). A window it cannot read, or one that starts where it ends, is
 * never open: the gate fails closed.
 */
export function inWindow(window: { from: string; to: string }, now: number): boolean {
  const from = minutes(window.from);
  const to = minutes(window.to);
  if (from === null || to === null || from === to) return false;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}
