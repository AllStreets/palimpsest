/**
 * The nets at work and the master's prospective guesses (Phase 4 Task 14,
 * ruling 15): the prediction half of his decisions. Task 15 adds the
 * decision half.
 *
 * - `predict(net, raw)` runs a net on one raw row, or answers null: when
 *   the school is off (read on every call), when the net has no current
 *   version, when that version is not trusted, or when anything inside the
 *   net throws or gives a value that is not a number. A net never breaks
 *   what asks it.
 * - `masterInputs(job, run)` is what the master reads about a piece of work
 *   before he decides: the appraiser's and the router's estimates for the
 *   run's bid and agent, durability's for its diff, triage's for the brief
 *   line the work would be, taste's for a judged design, the kind of work and
 *   the repo's approval share. A net with nothing to say is null (masked); a
 *   net that fails throws, naming it.
 * - `registerPrediction(job, run, now)` writes the master's guess down when a
 *   decision becomes pending (a job posted `proposed`, a PR opened), once
 *   per key: `master.predicted { key, kind, repo, jobId, p, version,
 *   reason, inputs, at }` and the same Prediction (without the inputs) in
 *   the `predictions` table, whose id is the ledger id. `p` is null, with
 *   the reason, when the school is off, the master is missing, unreadable,
 *   untrusted or older than `AGREE.staleDays`, or an input fails. The inputs
 *   are written down whenever the school is on, so Task 15 can copy them
 *   onto `decision.resolved` and the master learns from what it would have
 *   seen.
 *
 * - `appraiseBid(job, bid)` is the appraiser's estimate the award weighs
 *   (Decision 14).
 *
 * On load this installs `registerPrediction` and `appraiseBid` as the
 * market's hooks (hooks.ts: jobs.ts, ship.ts and bids.ts cannot import this
 * module without a cycle), and `predict` with `masterInputs` as
 * distillation's teacher (datasets.ts), so triage and taste learn from the
 * real master. tick.ts imports this module, so the engine always has them.
 */
import { localDay } from '../../shared/day.js';
import { encode, type RawRow } from '../../shared/net-features.js';
import { forward } from '../../shared/nets.js';
import { AGREE, itemKey, WORK_KINDS, workKind } from '../../shared/school-rules.js';
import type { Bid, Inspection, Job, JobSchool, NetName, Prediction, Run } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { record } from '../ledger.js';
import { agent, listAgents } from '../market/firms.js';
import { reputation } from '../market/reputation.js';
import { listRuns } from '../market/runs.js';
import { getRepo } from '../repos.js';
import { getSettings } from '../settings.js';
import { bidRaw, durabilityRaw, latestInspection, repoAcceptShare, repoApprovalShare, runDiff, setDistilPredict, tasteRaw } from './datasets.js';
import { setAppraiserHook, setPendingHook } from './hooks.js';
import { loadCurrent } from './nets.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The five nets the master reads, in the order its features name them. */
export const MASTER_INPUTS = ['appraiser', 'router', 'durability', 'triage', 'taste'] as const;
export type MasterInputName = (typeof MASTER_INPUTS)[number];

/** A net that threw or gave something that is not a number: the master abstains, naming it. */
export class NetFailed extends Error {
  constructor(
    readonly net: NetName,
    detail: string,
  ) {
    super(`the ${net} net failed: ${detail}`);
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The net on `raw`, ignoring the switch: null with no trusted current version; throws `NetFailed` when it fails. */
function run(net: NetName, raw: RawRow): { p: number; version: number } | null {
  let cur;
  try {
    cur = loadCurrent(net).current;
  } catch (err) {
    throw new NetFailed(net, errText(err));
  }
  if (!cur || !cur.version.trusted) return null;
  let p: number;
  try {
    p = forward(cur.weights, encode(net, raw));
  } catch (err) {
    throw new NetFailed(net, errText(err));
  }
  if (!Number.isFinite(p)) throw new NetFailed(net, 'it gave a value that is not a number');
  return { p, version: cur.version.version };
}

/**
 * The net's answer on one raw row and the version that gave it, or null:
 * the school off (read now), no current version, an untrusted one, or a
 * failure inside the net. Never throws.
 */
export function predict(net: NetName, raw: RawRow): { p: number; version: number } | null {
  try {
    if (!getSettings().school.enabled) return null;
    return run(net, raw);
  } catch {
    return null;
  }
}

/** A bid by id from any round, read here so the school does not import the market's bidding. */
function bidOf(id: string): Bid | null {
  const row = openDb().prepare('SELECT json FROM bids WHERE id = ?').get(id) as { json: string } | undefined;
  if (!row) return null;
  const r = JSON.parse(row.json) as { bid?: Bid };
  return r.bid ?? null;
}

/** The firm's standing now, as the appraiser's rows read it at an award. */
export function standingOf(firmId: string): { passRate: number | null; brier: number | null } {
  const rep = reputation(firmId);
  return { passRate: rep.passRateAll, brier: rep.brier };
}

/**
 * The triage row for the brief line the work would be: a proposal, or a PR
 * waiting on him, at `now` and first in its section.
 */
function triageRaw(job: Job, r: Run | null, now: number): RawRow {
  const at = Date.parse(r ? r.startedAt : job.postedAt);
  const d = new Date(now);
  return {
    kind: r ? 'pr' : 'proposal',
    tier: job.tier,
    hours_since_at: Number.isFinite(at) ? (now - at) / 3_600_000 : null,
    weekday: WEEKDAYS[d.getDay()],
    first_open_hour: d.getHours() + d.getMinutes() / 60,
    position: 0,
    repo_accept_share: repoAcceptShare(job.repo, localDay(now)),
  };
}

/**
 * What the master reads about a piece of work before he decides (ruling 8):
 * the five nets' outputs (null where a net has nothing to say or is not
 * trusted), the kind of work and the repo's approval share. With no run it
 * is the proposal itself. Throws `NetFailed` when a net fails.
 */
export function masterInputs(job: Job, r: Run | null, now: number = Date.now(), inspection?: Inspection | null): RawRow {
  const insp = r ? (inspection ?? latestInspection(r.id)) : null;
  const ask = (net: NetName, raw: RawRow | null): number | null => (raw ? (run(net, raw)?.p ?? null) : null);
  let appraiser: number | null = null;
  let router: number | null = null;
  let durability: number | null = null;
  if (r) {
    const a = agent(r.agentId);
    const repo = getRepo(job.repo);
    const rep = standingOf(r.firmId);
    const bid = bidOf(r.bidId);
    appraiser = ask('appraiser-pass', bid ? bidRaw(job, bid, a, repo, rep, r.model) : null);
    router = ask('router', bidRaw(job, null, a, repo, rep, r.model));
    durability = ask('durability', durabilityRaw(r, job, insp, runDiff(r.id)));
  }
  const triage = ask('triage', triageRaw(job, r, now));
  const taste = ask('taste', insp ? tasteRaw(insp) : null);
  return {
    appraiser,
    router,
    durability,
    triage,
    taste,
    kind: workKind(job, r ? (insp ?? {}) : null),
    repo_approval_share: repoApprovalShare(job.repo, now),
  };
}

/** The prediction already registered for `key`, or null. */
function registered(key: string): Prediction | null {
  const row = openDb().prepare('SELECT id, json FROM predictions WHERE key = ?').get(key) as { id: number | bigint; json: string } | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.json) as Prediction), id: Number(row.id) };
}

/** Why the master cannot answer now, or null when it can; with the master when there is one. */
function masterState(now: number): { reason: string | null; master: ReturnType<typeof loadCurrent>['current'] } {
  const { current: m, reason: refused } = loadCurrent('master');
  if (!m) return { reason: refused ? `the master cannot be used: ${refused}` : 'there is no master yet', master: null };
  const n = m.version.version;
  if (!m.version.trusted) return { reason: `the master v${n} does not beat its baseline`, master: m };
  const age = now - Date.parse(m.version.at);
  if (!Number.isFinite(age)) return { reason: `the master v${n} has no training date`, master: m };
  if (age > AGREE.staleDays * DAY_MS) return { reason: `the master v${n} is ${Math.floor(age / DAY_MS)} days old`, master: m };
  return { reason: null, master: m };
}

/**
 * Writes down the master's guess on a decision that just became pending
 * (ruling 15), once per key: a proposal (`run` null) or a PR (its run, and
 * the inspection when the caller has it). Returns the prediction, the
 * existing one when the key already has one. Never throws for a net: any
 * failure is an abstention with its reason.
 */
export function registerPrediction(job: Job, r: Run | null, now: number = Date.now(), inspection?: Inspection | null): Prediction {
  const insp = r ? (inspection ?? latestInspection(r.id)) : null;
  const kind = workKind(job, r ? (insp ?? {}) : null);
  const key = itemKey(kind, job.id);
  const had = registered(key);
  if (had) return had;

  let p: number | null = null;
  let version: number | null = null;
  let reason: string | null = null;
  let inputs: Partial<Record<MasterInputName, number | null>> = {};
  if (!getSettings().school.enabled) {
    reason = 'the school is off';
  } else {
    let raw: RawRow | null = null;
    let failed: string | null = null;
    try {
      raw = masterInputs(job, r, now, insp);
      for (const k of MASTER_INPUTS) inputs[k] = typeof raw[k] === 'number' ? (raw[k] as number) : null;
    } catch (err) {
      failed = `an input failed: ${errText(err)}`;
      inputs = {};
    }
    const state = masterState(now);
    reason = state.reason ?? failed;
    if (!reason && raw && state.master) {
      try {
        const out = forward(state.master.weights, encode('master', raw));
        if (!Number.isFinite(out)) throw new Error('it gave a value that is not a number');
        p = Math.min(1, Math.max(0, out));
        version = state.master.version.version;
      } catch (err) {
        reason = `the master net failed: ${errText(err)}`;
      }
    }
  }

  const at = new Date(now).toISOString();
  const data = { key, kind, repo: job.repo, jobId: job.id, p, version, reason, at };
  const id = record('master.predicted', { ...data, inputs });
  const prediction: Prediction = { id, ...data };
  openDb().prepare('INSERT OR IGNORE INTO predictions (id, key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?, ?)').run(id, key, kind, job.repo, at, JSON.stringify(prediction));
  emit('master.predicted', { prediction });
  return prediction;
}

/**
 * The appraiser's P(pass) for a bid at the award (Decision 14), or null:
 * the school off, no trusted appraiser, or a failure inside it. The row is
 * the one its training rows are built from, with the agent's model and the
 * firm's standing now.
 */
export function appraiseBid(job: Job, bid: Pick<Bid, 'firmId' | 'agentId' | 'plan' | 'price' | 'confidence'>): number | null {
  try {
    if (!getSettings().school.enabled) return null;
    const a = agent(bid.agentId);
    const got = predict('appraiser-pass', bidRaw(job, bid, a, getRepo(job.repo), standingOf(bid.firmId), a?.model ?? ''));
    return got ? Math.min(1, Math.max(0, got.p)) : null;
  } catch {
    return null;
  }
}

/**
 * What the trusted nets say about one job, for its page (`JobDetail.school`):
 * the appraiser on the awarded bid, the router on each working agent that
 * bids on its tier (highest first), durability on its latest inspected run,
 * and the master's latest guess on it. Each is empty when the school is off
 * or the net is not trusted; the guess is shown whatever it was. Never
 * throws.
 */
export function jobSchool(job: Job): JobSchool {
  const out: JobSchool = { appraisal: null, router: [], durability: null, master: null };
  try {
    const keys = WORK_KINDS.map((k) => itemKey(k, job.id));
    const row = openDb()
      .prepare(`SELECT id, json FROM predictions WHERE key IN (${keys.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`)
      .get(...keys) as { id: number | bigint; json: string } | undefined;
    if (row) out.master = { ...(JSON.parse(row.json) as Prediction), id: Number(row.id) };
    if (!getSettings().school.enabled) return out;
    const bid = job.awardedBid ? bidOf(job.awardedBid) : null;
    if (bid) out.appraisal = appraiseBid(job, bid);
    const repo = getRepo(job.repo);
    for (const a of listAgents()) {
      if (a.retired || !a.bidsOn.includes(job.tier)) continue;
      const got = predict('router', bidRaw(job, null, a, repo, standingOf(a.firmId), a.model));
      if (got) out.router.push({ agentId: a.id, p: got.p });
    }
    out.router.sort((x, y) => y.p - x.p || x.agentId.localeCompare(y.agentId));
    const r = listRuns({ jobId: job.id })
      .filter((x) => latestInspection(x.id) !== null)
      .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
      .at(-1);
    if (r) out.durability = predict('durability', durabilityRaw(r, job, latestInspection(r.id), runDiff(r.id)))?.p ?? null;
  } catch (err) {
    console.error(`palimpsest: the nets could not read ${job.id}: ${errText(err)}`);
  }
  return out;
}

// The market asks through hooks.ts (a pending decision, a bid to appraise) ...
setPendingHook((job, r, now, inspection) => {
  registerPrediction(job, r, now, inspection);
});
setAppraiserHook(appraiseBid);
// ... and distillation asks the real master, on what it would read before his decision.
setDistilPredict(predict, (job, r, _kind, now, inspection) => masterInputs(job, r, now, inspection));
