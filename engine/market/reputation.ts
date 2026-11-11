/**
 * A firm's reputation, read from the ledger alone (spec 7.2, ruling 5): pass
 * rate by job size, calibration as a Brier score of stated confidence
 * against outcomes, durability as merges not later reverted, and the
 * overclaim the award discounts confidence by.
 *
 * What it reads, so later tasks record to match:
 * - `job.awarded` `{ jobId, chosen: Bid | null, ... }`: the bid now holding the job.
 * - a pass: `merge.detected` `{ jobId, size? }`, or `run.ended` with outcome `merged`.
 * - a fail: `inspection.done` `{ inspection: { jobId, passed: false } }`,
 *   `floor.scarred` `{ jobId, size? }`, or `run.ended` with outcome `failed` or `closed`.
 * - `merge.reverted` `{ jobId }`: a merge that did not last.
 * A job's award resolves once, on the first outcome after it; a later award
 * of the same job (a retry) resolves again for whichever firm then holds it.
 * Size comes from the outcome's `size` (or its `floor.size`), else from the
 * awarded job's tier (low small, normal medium, high large), else medium.
 */
import { eraForScore, ERA_ORDER, overclaimOf, reputationScore } from '../../shared/market-rules.js';
import type { Agent, Bid, Era, FloorSize, Reputation, ReputationPoint, Tier } from '../../shared/types.js';
import { query, type LedgerEntry, type LedgerKind } from '../ledger.js';
import { listAgents } from './firms.js';

/** The kinds reputation reads; it asks the ledger's kind index for these alone. */
export const REPUTATION_KINDS: readonly LedgerKind[] = ['job.awarded', 'merge.detected', 'floor.scarred', 'inspection.done', 'run.ended', 'merge.reverted'];

/** The part of the ledger reputation reads, oldest first. */
export function reputationLog(): LedgerEntry[] {
  return query({ kind: REPUTATION_KINDS });
}

export interface Resolved {
  jobId: string;
  firmId: string;
  confidence: number;
  passed: boolean;
  size: FloorSize;
  reverted: boolean;
  /** When the outcome landed, and when the merge was reverted (null while it stands), as ledger times and ids. */
  at: string;
  seq: number;
  revertedAt: string | null;
  revertedSeq: number | null;
}

const TIER_SIZE: Record<Tier, FloorSize> = { low: 'small', normal: 'medium', high: 'large' };

type Data = Record<string, unknown>;

function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

function sizeOf(x: unknown): FloorSize | null {
  return x === 'small' || x === 'medium' || x === 'large' ? x : null;
}

/** The job an outcome entry is about, and whether it passed; null for anything that is not an outcome. */
function outcome(e: LedgerEntry): { jobId: string; passed: boolean; size: FloorSize | null } | null {
  const d = (e.data ?? {}) as Data;
  const floorSize = sizeOf(d.size) ?? sizeOf((d.floor as Data | undefined)?.size);
  switch (e.kind) {
    case 'merge.detected': {
      const jobId = str(d.jobId);
      return jobId ? { jobId, passed: true, size: floorSize } : null;
    }
    case 'floor.scarred': {
      const earned = (d.floor as Data | undefined)?.earned as Data | undefined;
      const jobId = str(d.jobId) ?? str(earned?.jobId);
      return jobId ? { jobId, passed: false, size: floorSize } : null;
    }
    case 'inspection.done': {
      const i = (d.inspection ?? d) as Data;
      const jobId = str(i.jobId);
      // An inconclusive inspection (no reviewer could read the change) is no outcome for the firm.
      return jobId && i.passed === false && !i.inconclusive ? { jobId, passed: false, size: floorSize } : null;
    }
    case 'run.ended': {
      const r = (d.run ?? d) as Data;
      const jobId = str(r.jobId);
      if (!jobId) return null;
      // A PR merged with changes (not the city's head, or into another branch) is no outcome for the firm.
      if (r.mergedWithChanges) return null;
      if (r.outcome === 'merged') return { jobId, passed: true, size: floorSize };
      if (r.outcome === 'failed' || r.outcome === 'closed') return { jobId, passed: false, size: floorSize };
      return null;
    }
    default:
      return null;
  }
}

/** Every resolved award in the ledger, oldest first. */
export function resolvedBids(log: LedgerEntry[] = reputationLog()): Resolved[] {
  const holding = new Map<string, { bid: Bid; tier: Tier | null }>();
  const resolved: Resolved[] = [];
  const merges = new Map<string, Resolved>();
  for (const e of log) {
    const d = (e.data ?? {}) as Data;
    if (e.kind === 'job.awarded') {
      const jobId = str(d.jobId);
      const bid = d.chosen as Bid | null | undefined;
      const tier = ((d.job as Data | undefined)?.tier ?? d.tier ?? null) as Tier | null;
      if (jobId && bid && typeof bid.firmId === 'string') holding.set(jobId, { bid, tier });
      continue;
    }
    if (e.kind === 'merge.reverted') {
      const merged = merges.get(str(d.jobId) ?? '');
      if (merged && !merged.reverted) {
        merged.reverted = true;
        merged.revertedAt = e.at;
        merged.revertedSeq = e.id;
      }
      continue;
    }
    const o = outcome(e);
    if (!o) continue;
    const held = holding.get(o.jobId);
    if (!held) continue;
    holding.delete(o.jobId);
    const r: Resolved = {
      jobId: o.jobId,
      firmId: held.bid.firmId,
      confidence: held.bid.confidence,
      passed: o.passed,
      size: o.size ?? (held.tier ? TIER_SIZE[held.tier] : 'medium'),
      reverted: false,
      at: e.at,
      seq: e.id,
      revertedAt: null,
      revertedSeq: null,
    };
    resolved.push(r);
    if (r.passed) merges.set(r.jobId, r);
  }
  return resolved;
}

function tidy(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function rate(xs: Resolved[]): number | null {
  return xs.length === 0 ? null : tidy(xs.filter((r) => r.passed).length / xs.length);
}

/** The highest capability among a firm's agents (working ones first; any agent if none is working). */
function firmCapability(firmId: string): Era {
  const agents = listAgents(firmId);
  const pool = agents.some((a) => !a.retired) ? agents.filter((a) => !a.retired) : agents;
  let best = 0;
  for (const a of pool) best = Math.max(best, ERA_ORDER.indexOf(a.capability));
  return pool.length === 0 ? 'stone' : ERA_ORDER[best];
}

/** `firmId`'s reputation from the ledger. A firm with no resolved bids has null rates and the new-firm overclaim. */
export function reputation(firmId: string, log: LedgerEntry[] = reputationLog()): Reputation {
  const mine = resolvedBids(log).filter((r) => r.firmId === firmId);
  const merges = mine.filter((r) => r.passed);
  const brier = mine.length === 0 ? null : tidy(mine.reduce((s, r) => s + (r.confidence - (r.passed ? 1 : 0)) ** 2, 0) / mine.length);
  const durability = merges.length === 0 ? null : tidy(merges.filter((r) => !r.reverted).length / merges.length);
  const passRateAll = rate(mine);
  const score = reputationScore({ passRateAll, brier, durability });
  return {
    firmId,
    passRate: {
      small: rate(mine.filter((r) => r.size === 'small')),
      medium: rate(mine.filter((r) => r.size === 'medium')),
      large: rate(mine.filter((r) => r.size === 'large')),
    },
    passRateAll,
    brier,
    durability,
    overclaim: overclaimOf(mine.map((r) => ({ confidence: r.confidence, passed: r.passed }))),
    score,
    samples: mine.length,
    era: eraForScore(score, firmCapability(firmId)),
  };
}

/** The era an agent builds in now: its firm's score, capped by what its model can reach. */
export function eraFor(a: Agent, log: LedgerEntry[] = reputationLog()): Era {
  return eraForScore(reputation(a.firmId, log).score, a.capability);
}

/** The most points of a firm's reputation line its page is sent (the newest). */
export const LINE_POINTS = 300;

/**
 * `firmId`'s reputation as it stood after each of its resolved bids and
 * each revert of one of its merges, in ledger order: the page's line. The
 * last point is the reputation now. Kept to the newest `limit` points, in
 * one pass with running sums. Empty for a firm with no resolved bids.
 */
export function reputationLine(firmId: string, log: LedgerEntry[] = reputationLog(), limit = LINE_POINTS): ReputationPoint[] {
  const mine = resolvedBids(log).filter((r) => r.firmId === firmId);
  const moments: Array<{ seq: number; at: string; event: ReputationPoint['event']; r: Resolved }> = [
    ...mine.map((r) => ({ seq: r.seq, at: r.at, event: r.passed ? ('pass' as const) : ('fail' as const), r })),
    ...mine.flatMap((r) => (r.revertedSeq !== null ? [{ seq: r.revertedSeq, at: r.revertedAt ?? r.at, event: 'revert' as const, r }] : [])),
  ].sort((a, b) => a.seq - b.seq);
  let n = 0;
  let passed = 0;
  let brierSum = 0;
  let merges = 0;
  let reverted = 0;
  const out: ReputationPoint[] = [];
  for (const m of moments) {
    if (m.event === 'revert') reverted++;
    else {
      n++;
      brierSum += (m.r.confidence - (m.r.passed ? 1 : 0)) ** 2;
      if (m.r.passed) {
        passed++;
        merges++;
      }
    }
    const brier = tidy(brierSum / n);
    const durability = merges === 0 ? null : tidy((merges - reverted) / merges);
    const passRate = tidy(passed / n);
    out.push({ at: m.at, event: m.event, score: reputationScore({ passRateAll: passRate, brier, durability }), passRate, calibration: tidy(1 - brier), durability, samples: n });
  }
  return out.slice(-limit);
}
