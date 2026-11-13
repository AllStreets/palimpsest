/**
 * Where the market asks the school (Phase 4 Task 14), without importing it.
 * jobs.ts, ship.ts and bids.ts sit under nearly every module, and the
 * school's imports reach back into the market: importing decisions.ts from
 * them is an import cycle whose top-level code runs half-initialised. So
 * decisions.ts installs these when it loads (tick.ts imports it, and
 * main.ts and server.ts import tick.ts), as settings.ts does for the off
 * switch. Nothing installed means no prediction and no appraisal: Phase 2's
 * market exactly.
 *
 * Both calls are guarded here: a hook that throws is logged or ignored and
 * never breaks a proposal, a PR or an award.
 */
import type { Bid, Inspection, Job, Run } from '../../shared/types.js';

/** Writes the master's guess down on a decision that just became pending. */
export type PendingHook = (job: Job, run: Run | null, now: number, inspection: Inspection | null) => void;
/** The appraiser's P(pass) for a bid, or null when it has nothing to say. */
export type AppraiserHook = (job: Job, bid: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>) => number | null;

let pending: PendingHook | null = null;
let appraiser: AppraiserHook | null = null;

/** Installs what a pending decision runs (decisions.ts does, once), or `null` for nothing. */
export function setPendingHook(fn: PendingHook | null): void {
  pending = fn;
}

/** Installs the appraiser the award asks (decisions.ts does, once), or `null` for none. */
export function setAppraiserHook(fn: AppraiserHook | null): void {
  appraiser = fn;
}

/** A decision became pending (a job posted `proposed`, a PR opened): the master's guess is written down, and nothing it throws escapes. */
export function notePending(job: Job, run: Run | null, now: number = Date.now(), inspection: Inspection | null = null): void {
  if (!pending) return;
  try {
    pending(job, run, now, inspection);
  } catch (err) {
    console.error(`palimpsest: the master's guess on ${job.id} could not be written down: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The appraiser's estimate for a bid, or null: none installed, nothing to say, or a failure. Never throws. */
export function appraise(job: Job, bid: Parameters<AppraiserHook>[1]): number | null {
  if (!appraiser) return null;
  try {
    const p = appraiser(job, bid);
    return typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
  } catch {
    return null;
  }
}
