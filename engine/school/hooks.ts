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
 * Task 16 adds the other direction inside the school: decisions.ts suspends
 * a pair and revokes one on a revert through autonomy.ts, which imports
 * decisions.ts, so autonomy.ts installs those two here as it loads.
 *
 * Every call is guarded here: a hook that throws is logged or ignored and
 * never breaks a proposal, a PR, an award, a decision or a revert.
 */
import type { Bid, Inspection, Job, Run, WorkKind } from '../../shared/types.js';

/** Writes the master's guess down on a decision that just became pending. */
export type PendingHook = (job: Job, run: Run | null, now: number, inspection: Inspection | null) => void;
/** The appraiser's P(pass) for a bid, or null when it has nothing to say. */
export type AppraiserHook = (job: Job, bid: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>) => number | null;

/** Suspends a (kind, repo) pair the city acted for and he undid (autonomy.ts's `suspend`). */
export type SuspendHook = (kind: WorkKind, repo: string, reason: string, now: number) => void;
/** A `merge.reverted` as it is emitted: revokes the pair that acted on its job (autonomy.ts's `revokeOnRevert`). */
export type RevertHook = (data: Record<string, unknown>) => void;

let pending: PendingHook | null = null;
let appraiser: AppraiserHook | null = null;
let suspending: SuspendHook | null = null;
let reverted: RevertHook | null = null;

/** Installs what a pending decision runs (decisions.ts does, once), or `null` for nothing. */
export function setPendingHook(fn: PendingHook | null): void {
  pending = fn;
}

/** Installs the appraiser the award asks (decisions.ts does, once), or `null` for none. */
export function setAppraiserHook(fn: AppraiserHook | null): void {
  appraiser = fn;
}

/** Installs what suspends a pair (autonomy.ts does, once; decisions.ts cannot import it without a cycle), or `null` for nothing. */
export function setSuspendHook(fn: SuspendHook | null): void {
  suspending = fn;
}

/** Installs what a revert runs before anything else (autonomy.ts does, once), or `null` for nothing. */
export function setRevertHook(fn: RevertHook | null): void {
  reverted = fn;
}

/** He undid what the city did under a grant: the pair is suspended, and nothing it throws escapes. */
export function suspendPair(kind: WorkKind, repo: string, reason: string, now: number): void {
  if (!suspending) return;
  try {
    suspending(kind, repo, reason, now);
  } catch (err) {
    console.error(`palimpsest: the ${kind} pair on ${repo} could not be suspended: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A city merge was reverted: the pair that acted on its job is revoked first (ruling 19), and nothing it throws escapes. */
export function noteRevert(data: Record<string, unknown>): void {
  if (!reverted) return;
  try {
    reverted(data);
  } catch (err) {
    console.error(`palimpsest: the revert of ${String(data.jobId ?? 'a city merge')} could not revoke its grant: ${err instanceof Error ? err.message : String(err)}`);
  }
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
