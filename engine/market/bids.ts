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

import { BID_COOL_OFF, calibrated as calibrate, coolOffMs, expectedValue, roundOpen } from '../../shared/market-rules.js';
import type { Agent, Bid, FloorSize, Job, Repo, Tier } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { query, record } from '../ledger.js';
import { appraise } from '../school/hooks.js';
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
/** The first wait of a job whose round awarded nothing; each round in a row with no award doubles it, up to a day (coolOffMs). */
export const BID_COOL_OFF_MS = BID_COOL_OFF.firstMs;

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

/**
 * Where a job stands in its cooling off: how many rounds in a row awarded
 * nothing, and until when it waits before the next (null when it need not
 * wait). An award, his edit of the job (a `job.changed` that keeps its
 * status: scope, acceptance or tier) or his retry (failed back to open)
 * ends the run of empty rounds, and with it any wait.
 */
export function coolOff(jobId: string): { rounds: number; until: number | null } {
  const rows = openDb()
    .prepare(
      `SELECT kind, json_extract(json, '$.chosen.id') AS chosen, json_extract(json, '$.coolOffUntil') AS until,
              json_extract(json, '$.from') AS f, json_extract(json, '$.to') AS t
       FROM ledger WHERE job_id = ? AND kind IN ('job.awarded', 'job.changed') ORDER BY id DESC`,
    )
    .iterate(jobId) as Iterable<{ kind: string; chosen: string | null; until: string | null; f: string | null; t: string | null }>;
  let rounds = 0;
  let until: number | null = null;
  for (const r of rows) {
    if (r.kind === 'job.changed') {
      if (r.f === r.t || (r.f === 'failed' && r.t === 'open')) break;
      continue;
    }
    if (r.chosen !== null) break;
    if (rounds === 0 && typeof r.until === 'string' && Number.isFinite(Date.parse(r.until))) until = Date.parse(r.until);
    rounds++;
  }
  return { rounds, until };
}

/** When the job may open for bids again after rounds that awarded nothing; else null. */
export function coolingOffUntil(jobId: string): number | null {
  return coolOff(jobId).until;
}

/** "10 minutes", "1 hour 20 minutes", "24 hours": a cooling off, in words. */
function waitWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} ${h === 1 ? 'hour' : 'hours'}${r ? ` ${r} ${r === 1 ? 'minute' : 'minutes'}` : ''}`;
}

/**
 * Opens the job for bids until `now + bidWindowSec`. A job whose last round
 * awarded nothing stays open, unchanged, until its cool-off passes (longer
 * for each such round in a row), so a job no firm will take does not churn
 * every tick; callers read the returned status.
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
  // Nor is an answer that lands after the round closed, though no tick has awarded the job yet:
  // the round is open only before its close (roundOpen), here as in the sample.
  if (!roundOpen(still, clock())) return sitOut(cur, round, a, 'the plan answered after bidding closed', clock());

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
    // the appraiser's estimate once it is trusted and the school is on (Decision 14); else the firm's pass rate at this size, as in Phase 2
    ...estimateOf(cur, { firmId: a.firmId, agentId: a.id, plan, price, confidence }, rep.passRate[TIER_SIZE[cur.tier]] ?? null),
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

/**
 * The appraiser's P(pass) for a bid (Decision 14), or null: the school off,
 * no current trusted `appraiser-pass`, or anything in it failing (asked
 * through school/hooks.ts, which decisions.ts fills). Read fresh on every
 * call; it never throws.
 */
export function appraisal(j: Job, b: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>): number | null {
  const p = appraise(j, b);
  return p === null ? null : tidy(p);
}

/** A new bid's estimate and whose it is: the appraiser's when it answers, else the firm's pass rate (`firmRate`). */
function estimateOf(j: Job, b: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>, firmRate: number | null): Pick<Bid, 'appraisal' | 'appraisalSource'> {
  const a = appraisal(j, b);
  return a === null ? { appraisal: firmRate, appraisalSource: 'firm' } : { appraisal: a, appraisalSource: 'appraiser' };
}

/** Highest EV first; ties to the lower price, then the higher calibrated, then the earlier bid: Phase 2's order. */
export function better(a: Bid, b: Bid): number {
  return b.ev - a.ev || a.price - b.price || b.calibrated - a.calibrated || a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

/** A bid as the award weighs it with the appraiser: the mean of its calibrated pass probability and the appraisal, and that mean's EV. */
interface Weighed {
  bid: Bid;
  p: number;
  ev: number;
}

/** Highest weighed EV first; ties as `better`, on the weighed probability. */
function betterWeighed(a: Weighed, b: Weighed): number {
  return b.ev - a.ev || a.bid.price - b.bid.price || b.p - a.p || a.bid.at.localeCompare(b.bid.at) || a.bid.id.localeCompare(b.bid.id);
}

/**
 * Each bid weighed with the appraiser (Decision 14), or null when the award
 * is Phase 2's: the school off, the appraiser not trusted, or any bid it
 * could not appraise (one failure and no bid is weighed, so no firm gains
 * from another's missing estimate).
 */
function weighed(j: Job, bids: readonly Bid[]): Weighed[] | null {
  if (bids.length === 0) return null;
  const out: Weighed[] = [];
  for (const b of bids) {
    const a = appraisal(j, b);
    if (a === null) return null;
    const p = tidy((b.calibrated + a) / 2);
    out.push({ bid: { ...b, appraisal: a, appraisalSource: 'appraiser' }, p, ev: expectedValue(p, j.value, b.price) });
  }
  return out;
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

  const phase2 = [...bids].sort(better);
  const plain = phase2.find((b) => b.ev > 0) ?? null;
  // Decision 14: with a trusted appraiser and the school on, each bid's pass probability is the mean of its calibrated confidence and the appraisal.
  const school = weighed(cur, bids);
  const schoolRanked = school ? [...school].sort(betterWeighed) : null;
  const ranked = schoolRanked ? schoolRanked.map((w) => w.bid) : phase2;
  const chosen = schoolRanked ? (schoolRanked.find((w) => w.ev > 0)?.bid ?? null) : plain;
  const moved = school !== null && (chosen?.id ?? null) !== (plain?.id ?? null);
  // Rounds in a row with no award, this one included, and the wait they earn (economy change A).
  const emptyRounds = chosen ? 0 : coolOff(cur.id).rounds + 1;
  const wait = chosen ? 0 : coolOffMs(emptyRounds);
  const parts: string[] = [];
  if (chosen) {
    const w = schoolRanked?.find((x) => x.bid.id === chosen.id);
    parts.push(
      w
        ? `Chose ${describe(chosen)}: the highest expected value of ${cur.value} credits with the appraiser's estimate of ${chosen.appraisal} weighed in (pass ${w.p}, EV ${w.ev}).`
        : `Chose ${describe(chosen)}: the highest expected value of ${cur.value} credits.`,
    );
    const others = ranked.filter((b) => b !== chosen);
    if (others.length) parts.push(`Also considered: ${others.map(describe).join('; ')}.`);
  } else {
    const again = `the job goes back on the board and opens again after ${waitWords(wait)}${emptyRounds > 1 ? ` (${emptyRounds} rounds in a row with no award)` : ''}.`;
    parts.push(bids.length ? `No bid had a positive expected value, so ${again}` : `No bids came in, so ${again}`);
    if (bids.length) parts.push(`Considered: ${ranked.map(describe).join('; ')}.`);
  }
  if (satOut.length) parts.push(`Sat out: ${satOut.map((s) => `${nameOf(s.agentId)} (${s.reason})`).join('; ')}.`);
  if (moved) parts.push(`The appraiser moved the award: without it, ${plain ? describe(plain) : 'no bid'} would have been chosen.`);
  const why = parts.join(' ');

  const data = {
    jobId: cur.id,
    tier: cur.tier,
    considered: ranked,
    satOut: satOut.map((s) => ({ agentId: s.agentId, reason: s.reason })),
    chosen,
    why,
    at: new Date(now).toISOString(),
    // No award (nobody eligible, everyone sat out, or no bid worth its price): wait before the next
    // round, since the same firms would bid the same again and each Claude bid spends his plan.
    // The wait doubles with each round in a row that awarded nothing, up to a day.
    coolOffUntil: chosen ? null : new Date(now + wait).toISOString(),
    noAwardRounds: emptyRounds,
    // Decision 14: the appraisals the award weighed, and whether they changed the choice (its later rows are then partly its own).
    ...(school ? { appraisals: Object.fromEntries(school.map((w) => [w.bid.id, w.bid.appraisal])) } : {}),
    ...(moved ? { appraiserMoved: true } : {}),
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
