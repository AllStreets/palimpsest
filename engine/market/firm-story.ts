/**
 * A firm's story as its page tells it (Task 38), read from the ledger alone:
 * its books as a running balance, every round it bid in (won, or lost with
 * the expected value that lost it), and its deals: the specialists it hired,
 * the dark towers it bought and the towers sold out of its quarter.
 * Read-only: nothing here writes.
 */
import { HIRE_FEE, START_BALANCE } from '../../shared/market-rules.js';
import type { Bid, BookRow, FirmDeal, FirmRound, Tier } from '../../shared/types.js';
import { query } from '../ledger.js';
import { job } from './jobs.js';
import { listRuns } from './runs.js';

const MICRO = 1_000_000;
const toMicro = (credits: number): number => Math.round(credits * MICRO);
const fromMicro = (micro: number): number => micro / MICRO;

type Data = Record<string, unknown>;

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * The firm's books: every `credits.moved` entry for it, oldest first, each
 * with the balance it left. The balance starts where `firm.seeded` set it
 * and is summed in micro-credits, as the treasury sums it, so the last row's
 * balance is the treasury's.
 */
export function firmBooks(firmId: string): BookRow[] {
  const seeded = query({ kind: 'firm.seeded' }).find((e) => ((e.data as Data).firm as Data | undefined)?.id === firmId);
  let micro = toMicro(num(((seeded?.data as Data | undefined)?.firm as Data | undefined)?.balance) ?? START_BALANCE);
  const out: BookRow[] = [];
  // A run's cost names its run, not its job: the page says which job the work was for.
  const titles = new Map<string, string | null>();
  const jobOfRun = new Map(listRuns().filter((r) => r.firmId === firmId).map((r) => [r.id, r.jobId] as const));
  for (const e of query({ kind: 'credits.moved' })) {
    const d = e.data as Data;
    if (d.firmId !== firmId) continue;
    const delta = num(d.delta);
    if (delta === null) continue;
    micro += toMicro(delta);
    const jobId = str(d.jobId) ?? jobOfRun.get(str(d.runId) ?? '') ?? null;
    if (jobId && !titles.has(jobId)) titles.set(jobId, job(jobId)?.title ?? null);
    out.push({ at: str(d.at) ?? e.at, kind: str(d.kind) ?? 'other', delta, balance: fromMicro(micro), runId: str(d.runId), jobId, agentId: str(d.agentId), title: jobId ? (titles.get(jobId) ?? null) : null });
  }
  return out;
}

/** The highest expected value first, then the earlier bid. */
const better = (a: Bid, b: Bid): number => b.ev - a.ev || a.at.localeCompare(b.at);

/**
 * Every round the firm bid in, oldest first: its best bid of the round, the
 * bid that won it (null when no bid was worth taking) and, for a round it
 * won, what became of the work.
 */
export function firmRounds(firmId: string): FirmRound[] {
  const outcomes = new Map(listRuns().filter((r) => r.firmId === firmId).map((r) => [r.bidId, r.outcome ?? (r.stage === 'done' ? null : 'live')] as const));
  const out: FirmRound[] = [];
  for (const e of query({ kind: 'job.awarded' })) {
    const d = e.data as Data;
    const considered = Array.isArray(d.considered) ? (d.considered as Bid[]) : [];
    const mine = considered.filter((b) => b && b.firmId === firmId).sort(better);
    if (!mine.length) continue;
    const chosen = (d.chosen as Bid | null | undefined) ?? null;
    const won = chosen?.firmId === firmId;
    const bid = won ? chosen! : mine[0];
    const jobId = str(d.jobId) ?? bid.jobId;
    const j = job(jobId);
    out.push({
      jobId,
      title: j?.title ?? jobId,
      repo: j?.repo ?? '',
      tier: (j?.tier ?? str(d.tier) ?? 'normal') as Tier,
      value: j?.value ?? 0,
      at: str(d.at) ?? e.at,
      won,
      bid,
      winner: chosen,
      outcome: won ? (outcomes.get(chosen!.id) ?? null) : null,
    });
  }
  return out;
}

/** The firm's hires, purchases and sales, oldest first. */
export function firmDeals(firmId: string): FirmDeal[] {
  const out: FirmDeal[] = [];
  for (const e of query({ kind: ['agent.hired', 'tower.sold'] })) {
    const d = e.data as Data;
    if (e.kind === 'agent.hired') {
      const a = d.agent as Data | undefined;
      if (a?.firmId === firmId && typeof a.id === 'string') out.push({ kind: 'hired', at: e.at, agentId: a.id, other: null, price: HIRE_FEE });
      continue;
    }
    const agentId = str(d.agentId);
    const price = num(d.price) ?? 0;
    if (!agentId) continue;
    if (d.to === firmId) out.push({ kind: 'bought', at: e.at, agentId, other: str(d.from), price });
    else if (d.from === firmId) out.push({ kind: 'sold', at: e.at, agentId, other: str(d.to), price });
  }
  return out;
}
