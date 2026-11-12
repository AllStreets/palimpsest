/**
 * Bidding and the award (Task 12, spec 7.2, rulings 4, 6 and 28).
 *
 * A job opens for bids for `bidWindowSec`. Each eligible agent takes a
 * `plan` lease (its own small queued pool, ruling 28), reads the job with
 * its persona and up to `memory.examples` of its firm's merged job
 * summaries, and answers with a plan, a price in credits and a confidence.
 * The answer is untrusted model output: a plan that is not text, or a price
 * or confidence that is not a finite number, makes the agent sit out; the
 * price is clamped to [1, value] and the confidence to [0.05, 0.99]. The
 * city discounts the confidence by the firm's overclaim and awards the
 * highest expected value above zero, ties to the lower price, then the
 * higher calibrated pass probability.
 *
 * Money: a bid costs the firm what its plan calls cost, written once as a
 * `credits` row of kind `bid` with the firm's id, through budget `charge()`
 * (the Anthropic API backend writes those rows itself, `chargesItself`).
 * `bid.placed` carries `charged: { kind: 'bid', credits, by }` so the
 * treasury (Task 17) never debits the bid a second time.
 *
 * Storage: each bid, and each agent that sat out, is a row in `bids` keyed
 * to the job and to the round (the window's `bidsCloseAt`), so a job that
 * reopens starts its next round clean.
 *
 * Examples come from the ledger: a job is the firm's when its latest
 * `job.awarded` chose that firm, it is merged when `job.changed` moves it to
 * `merged` (`{ id, to, job: { title } }`), and its summary is the `summary`
 * of the job's last `run.ended` (`{ run: { jobId }, summary }`).
 */
import { randomUUID } from 'node:crypto';

import { calibrated as calibrate, expectedValue } from '../../shared/market-rules.js';
import type { Agent, Bid, FloorSize, Job, Repo, Tier } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { query, record } from '../ledger.js';
import { getSettings } from '../settings.js';
import { chargesItself } from './anthropic-api.js';
import { acquire, charge, creditsFor, PLAN_ESTIMATE, unattended } from './budget.js';
import { agent as agentById, firm, listAgents } from './firms.js';
import { job as storedJob, transition } from './jobs.js';
import { EXCHANGE, siteOf, startTrip, whereIs } from './trips.js';
import type { Usage } from './provider.js';
import { providerFor } from './providers.js';
import { reputation } from './reputation.js';

export const MIN_PRICE = 1;
export const MIN_CONFIDENCE = 0.05;
export const MAX_CONFIDENCE = 0.99;
/** The most examples any agent is shown (Beagle's genome bound). */
export const MAX_EXAMPLES = 8;
/** The longest plan text kept on a bid. */
export const PLAN_MAX = 4000;
/** The longest example summary passed to a plan call. */
const EXAMPLE_MAX = 600;
/** Most plan calls a vote workflow may make for one bid. */
const MAX_VOTES = 7;
/** What an agent whose plan call was queued past the close is told. */
export const NO_SLOT = 'no slot before the window closed';
/** How long a job that drew no bid at all (nobody eligible, or everyone sat out) waits before it opens for bids again. */
export const BID_COOL_OFF_MS = 10 * 60_000;

const TIER_SIZE: Record<Tier, FloorSize> = { low: 'small', normal: 'medium', high: 'large' };

export interface SatOut {
  jobId: string;
  agentId: string;
  firmId: string;
  reason: string;
  /** How the job's bid list shows it: `sat out: <reason>`. */
  note: string;
  at: string;
}

type Row = { round: string; bid: Bid } | { round: string; satOut: SatOut };

// ---------------------------------------------------------------- storage

function rows(jobId: string, round: string | null): Row[] {
  if (round === null) return [];
  const all = openDb().prepare('SELECT json FROM bids WHERE job_id = ?').all(jobId) as Array<{ json: string }>;
  return all.map((r) => JSON.parse(r.json) as Row).filter((r) => r.round === round);
}

function saveRow(id: string, jobId: string, row: Row): void {
  openDb().prepare('INSERT OR REPLACE INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(id, jobId, JSON.stringify(row));
}

/** The bids and sit-outs of the job's current round, in the order they came in. */
export function bidList(jobId: string): { bids: Bid[]; satOut: SatOut[] } {
  const j = storedJob(jobId);
  const rs = rows(jobId, j?.bidsCloseAt ?? null);
  const bids = rs.flatMap((r) => ('bid' in r ? [r.bid] : [])).sort((a, b) => a.at.localeCompare(b.at));
  const satOut = rs.flatMap((r) => ('satOut' in r ? [r.satOut] : [])).sort((a, b) => a.at.localeCompare(b.at));
  return { bids, satOut };
}

/** A bid by id, from any round. */
export function bidById(id: string): Bid | null {
  const row = openDb().prepare('SELECT json FROM bids WHERE id = ?').get(id) as { json: string } | undefined;
  if (!row) return null;
  const r = JSON.parse(row.json) as Row;
  return 'bid' in r ? r.bid : null;
}

// ---------------------------------------------------------------- the window

/** When the job's last round drew no bid at all, the time it may open for bids again; else null. */
export function coolingOffUntil(jobId: string): number | null {
  const row = openDb()
    .prepare("SELECT json FROM ledger WHERE kind = 'job.awarded' AND job_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId) as { json: string } | undefined;
  if (!row) return null;
  const until = (JSON.parse(row.json) as { coolOffUntil?: unknown }).coolOffUntil;
  return typeof until === 'string' && Number.isFinite(Date.parse(until)) ? Date.parse(until) : null;
}

/**
 * Opens the job for bids until `now + bidWindowSec`. A job whose last round
 * drew no bid at all stays open, unchanged, until its cool-off passes, so an
 * empty board does not churn every tick; callers read the returned status.
 */
export function openBidding(j: Job, now: number = Date.now()): Job {
  const until = coolingOffUntil(j.id);
  if (until !== null && now < until) return storedJob(j.id) ?? j;
  const closeAt = new Date(now + getSettings().bidWindowSec * 1000).toISOString();
  return transition(j, 'bidding', { bidsCloseAt: closeAt, awardedBid: null });
}

/** Agents that may bid: working, in an active firm the job has not excluded, bidding on its tier. */
export function eligibleAgents(j: Job): Agent[] {
  const excluded = new Set(j.excludedFirms ?? []);
  return listAgents().filter(
    (a) => !a.retired && !excluded.has(a.firmId) && a.bidsOn.includes(j.tier) && firm(a.firmId)?.status === 'active',
  );
}

// ---------------------------------------------------------------- examples

/** Up to `n` of the firm's merged jobs, newest first, as `<title>: <summary>`. */
export function firmExamples(firmId: string, n: number): string[] {
  const want = Math.max(0, Math.min(MAX_EXAMPLES, Math.floor(Number.isFinite(n) ? n : 0)));
  if (want === 0) return [];
  const holder = new Map<string, string>();
  const summary = new Map<string, string>();
  const out: string[] = [];
  for (const e of query({ kind: ['job.awarded', 'run.ended', 'job.changed'] })) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.kind === 'job.awarded') {
      const chosen = d.chosen as { firmId?: unknown } | null | undefined;
      if (typeof d.jobId === 'string' && chosen && typeof chosen.firmId === 'string') holder.set(d.jobId, chosen.firmId);
    } else if (e.kind === 'run.ended') {
      const run = (d.run ?? {}) as { jobId?: unknown };
      if (typeof run.jobId === 'string' && typeof d.summary === 'string') summary.set(run.jobId, d.summary);
    } else if (e.kind === 'job.changed' && d.to === 'merged' && typeof d.id === 'string') {
      if (holder.get(d.id) !== firmId) continue;
      const title = typeof (d.job as { title?: unknown } | undefined)?.title === 'string' ? (d.job as { title: string }).title : d.id;
      const s = summary.get(d.id);
      out.push((s ? `${title}: ${s}` : title).slice(0, EXAMPLE_MAX));
    }
  }
  return out.reverse().slice(0, want);
}

function repoSummary(fullName: string): string {
  const row = openDb().prepare('SELECT json FROM repos WHERE full_name = ?').get(fullName) as { json: string } | undefined;
  if (!row) return fullName;
  const r = JSON.parse(row.json) as Repo;
  return `${r.fullName}${r.language ? ` (${r.language})` : ''}${r.description ? `: ${r.description}` : ''}`;
}

// ---------------------------------------------------------------- answers

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const tidy = (x: number) => Math.round(x * 1e9) / 1e9;

/**
 * A plan answer checked field by field, or null when it cannot be used. The
 * plan text stays untrusted model output: Task 13 must pass it into the work
 * prompt as quoted data, never as instructions to the engine.
 */
function checked(a: unknown): { plan: string; price: number; confidence: number } | null {
  if (!a || typeof a !== 'object') return null;
  const { plan, price, confidence } = a as Record<string, unknown>;
  if (typeof plan !== 'string' || !finite(price) || !finite(confidence)) return null;
  const text = plan.trim().slice(0, PLAN_MAX);
  if (!text) return null;
  return { plan: text, price, confidence };
}

/** Usage with every field a finite, non-negative number. */
function cleanUsage(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (x: unknown) => (finite(x) && x > 0 ? x : 0);
  return { weightedTokens: n(o.weightedTokens), seconds: n(o.seconds), usd: n(o.usd), credits: n(o.credits) };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    weightedTokens: a.weightedTokens + b.weightedTokens,
    seconds: a.seconds + b.seconds,
    usd: a.usd + b.usd,
    credits: a.credits + b.credits,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function votes(a: Agent): number {
  if (a.workflow.shape !== 'vote') return 1;
  const n = a.workflow.n;
  return finite(n) ? clamp(Math.floor(n), 1, MAX_VOTES) : 3;
}

function refusalText(r: { reason: string; detail: string }): string {
  if (r.reason === 'busy') return NO_SLOT;
  return `${r.reason}: ${r.detail}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- bidding

function sitOut(j: Job, round: string, a: Agent, reason: string, at: number): null {
  const s: SatOut = { jobId: j.id, agentId: a.id, firmId: a.firmId, reason, note: `sat out: ${reason}`, at: new Date(at).toISOString() };
  saveRow(`sat-${randomUUID().replace(/-/g, '').slice(0, 12)}`, j.id, { round, satOut: s });
  emit('bid.satOut', { satOut: s });
  return null;
}

/**
 * One agent's bid on a job in bidding, or null when it sat out (the reason
 * is kept on the job's bid list) or may not bid at all. Waits for a plan
 * slot until the window closes; a hard stop aborts the call through the
 * lease's signal. Plan calls that finished are charged to the firm even
 * when the agent then sits out.
 */
export async function collectBid(j: Job, a: Agent, now: number = Date.now()): Promise<Bid | null> {
  const cur = storedJob(j.id);
  if (!cur || cur.status !== 'bidding' || !cur.bidsCloseAt) return null;
  if (!eligibleAgents(cur).some((e) => e.id === a.id)) return null;
  const round = cur.bidsCloseAt;
  if (rows(cur.id, round).some((r) => ('bid' in r ? r.bid.agentId : r.satOut.agentId) === a.id)) return null;
  const key = `${cur.id} ${round} ${a.id}`;
  if (inflight.has(key)) return null;
  inflight.add(key);
  try {
    return await bidOnce(cur, round, a, now);
  } catch (err) {
    // One agent's failure (a charge that threw, a store error) never rejects the round for the others.
    console.error(`palimpsest: bid by ${a.id} on ${cur.id} failed: ${errText(err)}`);
    try {
      return sitOut(cur, round, a, `the bid failed: ${errText(err)}`, now);
    } catch {
      return null;
    }
  } finally {
    inflight.delete(key);
  }
}

/** Agents with a plan call under way, per job and round, so one agent never bids twice in a round. */
const inflight = new Set<string>();

async function bidOnce(cur: Job, round: string, a: Agent, now: number): Promise<Bid | null> {
  const real0 = Date.now();
  const clock = () => now + (Date.now() - real0);

  const n = votes(a);
  const got = await acquire(a.model, 'plan', PLAN_ESTIMATE * n, { now, waitUntil: Date.parse(round) });
  if (!got.ok) return sitOut(cur, round, a, refusalText(got.reason), clock());
  const { lease } = got;

  let spent: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };
  /** Plan calls started: every one is charged, so the budget guard never undercounts. */
  let calls = 0;
  /** Credits owed: max(reported, PLAN_ESTIMATE) per call that answered, PLAN_ESTIMATE per call that threw or was aborted. */
  let owed = 0;
  let cost = 0;
  let failure: string | null = null;
  let chargeFailure: string | null = null;
  const answers: Array<{ plan: string; price: number; confidence: number }> = [];
  let provider;
  try {
    provider = providerFor(a.model);
    const input = {
      job: cur,
      agent: a,
      persona: a.persona,
      repoSummary: repoSummary(cur.repo),
      examples: firmExamples(a.firmId, a.memory?.examples ?? 0),
    };
    for (let k = 0; k < n; k++) {
      if (lease.signal.aborted) break;
      calls++;
      let out: unknown;
      try {
        out = await provider.plan(input, lease.signal);
      } catch (err) {
        owed += PLAN_ESTIMATE;
        throw err;
      }
      const u = cleanUsage((out as { usage?: unknown } | null)?.usage);
      spent = addUsage(spent, u);
      owed += Math.max(creditsFor(a.model, u), PLAN_ESTIMATE);
      const ok = checked(out);
      if (ok) answers.push(ok);
    }
  } catch (err) {
    failure = `the plan call failed: ${errText(err)}`;
  } finally {
    // Charge every call started, under the lease so its reservation is replaced by the spend, then free the slot.
    try {
      if (calls > 0) {
        const selfCharged = provider?.kind === 'anthropic' && chargesItself;
        cost = selfCharged
          ? tidy(spent.credits)
          : charge({ runId: null, firmId: a.firmId, model: a.model, kind: 'bid', usage: spent, unattended: unattended(clock()), at: clock(), lease, minCredits: owed });
      }
    } catch (err) {
      chargeFailure = errText(err);
      console.error(`palimpsest: charging the bid by ${a.id} on ${cur.id} failed: ${chargeFailure}`);
    } finally {
      lease.release();
    }
  }

  if (lease.signal.aborted) {
    const why = lease.signal.reason instanceof Error ? lease.signal.reason.message : 'the call was stopped';
    return sitOut(cur, round, a, `stopped mid-plan (${why})`, clock());
  }
  if (failure) return sitOut(cur, round, a, failure, clock());
  if (chargeFailure) return sitOut(cur, round, a, `the bid could not be charged: ${chargeFailure}`, clock());
  if (answers.length === 0) return sitOut(cur, round, a, 'the plan answer was not usable', clock());

  // The job may have been awarded, withdrawn or reopened while the call ran; a late bid is not entered.
  const still = storedJob(cur.id);
  if (!still || still.status !== 'bidding' || still.bidsCloseAt !== round) return null;

  const price = tidy(clamp(median(answers.map((x) => x.price)), MIN_PRICE, Math.max(MIN_PRICE, cur.value)));
  const confidence = tidy(clamp(median(answers.map((x) => x.confidence)), MIN_CONFIDENCE, MAX_CONFIDENCE));
  // The plan of the answer whose price sits nearest the median.
  const plan = [...answers].sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price))[0].plan;
  const rep = reputation(a.firmId);
  const cal = calibrate(confidence, rep.overclaim);
  const bid: Bid = {
    id: `bid-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    jobId: cur.id,
    firmId: a.firmId,
    agentId: a.id,
    plan,
    price,
    confidence,
    calibrated: cal,
    appraisal: rep.passRate[TIER_SIZE[cur.tier]] ?? null,
    ev: expectedValue(cal, cur.value, price),
    cost,
    at: new Date(clock()).toISOString(),
  };
  saveRow(bid.id, cur.id, { round, bid });
  record('bid.placed', { bid, calls, charged: { kind: 'bid', credits: cost, by: provider?.kind === 'anthropic' && chargesItself ? 'provider' : 'budget' } });
  emit('bid.placed', { bid });
  // The bidder goes to the exchange.
  startTrip(a, 'bid', cur.id, whereIs(a), EXCHANGE, clock());
  return bid;
}

/** Every eligible agent's bid on the job, collected side by side. */
export async function collectBids(j: Job, now: number = Date.now()): Promise<Bid[]> {
  const out = await Promise.all(eligibleAgents(j).map((a) => collectBid(j, a, now)));
  return out.filter((b): b is Bid => b !== null);
}

// ---------------------------------------------------------------- the award

/** Highest EV first; ties to the lower price, then the higher calibrated, then the earlier bid. */
function better(a: Bid, b: Bid): number {
  return b.ev - a.ev || a.price - b.price || b.calibrated - a.calibrated || a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

function nameOf(agentId: string): string {
  return listAgents().find((x) => x.id === agentId)?.name ?? agentId;
}

function describe(b: Bid): string {
  return `${nameOf(b.agentId)} (${b.firmId}) at ${b.price} credits, confidence ${b.confidence}, calibrated ${b.calibrated}, EV ${b.ev}`;
}

/**
 * Awards the job once its window has closed or every eligible agent has bid
 * or sat out; before that it returns null and changes nothing. The highest
 * EV above zero wins and the job moves to `awarded`; with none above zero it
 * goes back to `open` (it reopens next tick) and null is returned. Either
 * way `job.awarded` records every bid considered, every agent that sat out,
 * the choice and why.
 */
export function award(j: Job, now: number = Date.now()): Bid | null {
  const cur = storedJob(j.id);
  if (!cur || cur.status !== 'bidding' || !cur.bidsCloseAt) return null;
  const { bids, satOut } = bidList(cur.id);
  const answered = new Set([...bids.map((b) => b.agentId), ...satOut.map((s) => s.agentId)]);
  const everyone = eligibleAgents(cur).every((a) => answered.has(a.id));
  if (now < Date.parse(cur.bidsCloseAt) && !everyone) return null;

  const ranked = [...bids].sort(better);
  const chosen = ranked.find((b) => b.ev > 0) ?? null;
  const parts: string[] = [];
  if (chosen) {
    parts.push(`Chose ${describe(chosen)}: the highest expected value of ${cur.value} credits.`);
    const others = ranked.filter((b) => b !== chosen);
    if (others.length) parts.push(`Also considered: ${others.map(describe).join('; ')}.`);
  } else {
    parts.push(bids.length ? `No bid had a positive expected value, so the job goes back on the board.` : `No bids came in, so the job goes back on the board and opens again after ${BID_COOL_OFF_MS / 60_000} minutes.`);
    if (bids.length) parts.push(`Considered: ${ranked.map(describe).join('; ')}.`);
  }
  if (satOut.length) parts.push(`Sat out: ${satOut.map((s) => `${nameOf(s.agentId)} (${s.reason})`).join('; ')}.`);
  const why = parts.join(' ');

  const data = {
    jobId: cur.id,
    tier: cur.tier,
    considered: ranked,
    satOut: satOut.map((s) => ({ agentId: s.agentId, reason: s.reason })),
    chosen,
    why,
    at: new Date(now).toISOString(),
    // Nobody eligible, or everyone sat out: wait before the next round.
    coolOffUntil: bids.length === 0 ? new Date(now + BID_COOL_OFF_MS).toISOString() : null,
  };
  if (chosen) transition(cur, 'awarded', { awardedBid: chosen.id });
  else transition(cur, 'open', { bidsCloseAt: null, awardedBid: null });
  record('job.awarded', data);
  emit('job.awarded', data);
  // The winner goes on to the job's district, from the exchange or wherever it stands.
  const winner = chosen ? agentById(chosen.agentId) : null;
  if (winner) startTrip(winner, 'job', cur.id, whereIs(winner), siteOf(cur.repo), now);
  return chosen;
}
