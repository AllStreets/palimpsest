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
 * Task 23 adds the school's roster: firms.ts reads the school-bred
 * specialists and graduates, and asks which of them a firm may hire first,
 * and the treasury's daily tick asks for a commission, through what
 * roster.ts installs (`installRoster`; main.ts calls it). Nothing installed
 * means Phase 2's roster, hiring and daily tick exactly.
 *
 * Every call is guarded here: a hook that throws is logged or ignored and
 * never breaks a proposal, a PR, an award, a decision, a revert, a hire or
 * the daily tick.
 */
import type { Agent, Bid, Inspection, Job, Run, WorkKind } from '../../shared/types.js';
import type { RosterSeed } from '../market/firms.js';

/** Writes the master's guess down on a decision that just became pending. */
export type PendingHook = (job: Job, run: Run | null, now: number, inspection: Inspection | null) => void;
/** The appraiser's P(pass) for a bid, or null when it has nothing to say. */
export type AppraiserHook = (job: Job, bid: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>) => number | null;

/** Suspends a (kind, repo) pair the city acted for and he undid (autonomy.ts's `suspend`). */
export type SuspendHook = (kind: WorkKind, repo: string, reason: string, now: number) => void;
/** A `merge.reverted` as it is emitted: revokes the pair that acted on its job (autonomy.ts's `revokeOnRevert`). */
export type RevertHook = (data: Record<string, unknown>) => void;

/** Whether the city is acting on this job right now (autonomy.ts's in-flight set): a before-row with no result row yet is the city's act, not his. */
export type ActingHook = (jobId: string) => boolean;

let pending: PendingHook | null = null;
let actingNow: ActingHook | null = null;
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

/** Installs what says whether the city is acting on a job now (autonomy.ts does, once), or `null` for never. */
export function setActingHook(fn: ActingHook | null): void {
  actingNow = fn;
}

/** Whether the city is acting on `jobId` at this moment; false with nothing installed or on a throw. */
export function acting(jobId: string): boolean {
  if (!actingNow) return false;
  try {
    return actingNow(jobId);
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------- the school's roster (Task 23)

export interface RosterHook {
  /** Every school-bred specialist and graduate, hired or not. */
  seeds(): RosterSeed[];
  /** The school's seeds `firmId` may hire now, best first: empty where the router is not trusted. */
  candidates(firmId: string, now: number): RosterSeed[];
  /** The daily tick's commission rule: at most one firm commissions a voyage. */
  commissionDue(now: number): void;
  /** A firm hired `a`: a graduate's first trip leaves the campus for its quarter (ruling 28), its events carried by `announce`. */
  hired?(a: Agent, now: number, opts: { announce?: (type: string, data: object) => void }): void;
}

let roster: RosterHook | null = null;

/** Installs the school's roster (roster.ts's `installRoster`), or `null` for Phase 2's. */
export function setRosterHook(fn: RosterHook | null): void {
  roster = fn;
}

/** The school's seeds, or none: nothing installed or a failure. Never throws. */
export function schoolSeeds(): RosterSeed[] {
  if (!roster) return [];
  try {
    return roster.seeds();
  } catch (err) {
    console.error(`palimpsest: the school's roster could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The school's seeds a firm may hire first, or none: nothing installed, the router not trusted, or a failure. Never throws. */
export function schoolCandidates(firmId: string, now: number): RosterSeed[] {
  if (!roster) return [];
  try {
    return roster.candidates(firmId, now);
  } catch (err) {
    console.error(`palimpsest: the school's roster could not be offered to ${firmId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Tells the school a firm hired `a` (the treasury, after its hire); nothing it throws escapes. */
export function schoolHired(a: Agent, now: number, announce?: (type: string, data: object) => void): void {
  if (!roster?.hired) return;
  try {
    roster.hired(a, now, announce ? { announce } : {});
  } catch (err) {
    console.error(`palimpsest: the school could not see ${a.id} off to its quarter: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The daily tick's commission, if one is due; nothing it throws escapes. */
export function commissionDue(now: number): void {
  if (!roster) return;
  try {
    roster.commissionDue(now);
  } catch (err) {
    console.error(`palimpsest: the daily commission failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
