/**
 * The nets at work and the master's prospective guesses (Phase 4 Task 14,
 * ruling 15) and his decisions against them (Task 15, rulings 14 and 16).
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
 * - `resolve(job, by, at)` records one of his decisions (`decision.resolved`
 *   and the `decisions` table), with the guess's inputs copied on for the
 *   master's rows; never the city's own acts (`autonomy.acted` by jobId),
 *   whose undoing by him is an `undo` that suspends the pair (autonomy.ts,
 *   through hooks.ts).
 *   `installDecisions()` hears them on the bus (main.ts installs it).
 * - `agreement(kind, repo?)` and `agreements()`: the window autonomy reads.
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
import type { Agreement, Bid, Decision, Inspection, Job, JobSchool, NetName, Prediction, Run, WorkKind } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit, subscribe } from '../events.js';
import { record } from '../ledger.js';
import { agent, listAgents } from '../market/firms.js';
import { reputation } from '../market/reputation.js';
import { job as storedJob, listJobs } from '../market/jobs.js';
import { listRuns, run as storedRun } from '../market/runs.js';
import { PR_CLOSED_REASON } from '../market/ship.js';
import { getRepo } from '../repos.js';
import { getSettings } from '../settings.js';
import { bidRaw, durabilityRaw, latestInspection, repoAcceptShare, repoApprovalShare, runDiff, setDistilPredict, tasteRaw } from './datasets.js';
import { noteRevert, setAppraiserHook, setPendingHook, suspendPair } from './hooks.js';
import { loadCurrent, skewedKinds } from './nets.js';
import { ci } from './stats.js';

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
export function registered(key: string): Prediction | null {
  const row = openDb().prepare('SELECT id, json FROM predictions WHERE key = ?').get(key) as { id: number | bigint; json: string } | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.json) as Prediction), id: Number(row.id) };
}

/** Why the master cannot answer now, or null when it can; with the master when there is one. mayAct reads it too. */
export function masterState(now: number): { reason: string | null; master: ReturnType<typeof loadCurrent>['current'] } {
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
  // Once he has decided, no guess on the key can be prospective: nothing is written, and the answer is an abstention with id 0.
  if (decided(key)) return { id: 0, key, kind, repo: job.repo, jobId: job.id, p: null, version: null, reason: 'he has already decided', at: new Date(now).toISOString() };

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

/** Whether `key` has a `decision.resolved` row: once he has decided, no guess on it is prospective. */
function decided(key: string): boolean {
  const row = openDb().prepare("SELECT 1 AS hit FROM ledger WHERE kind = 'decision.resolved' AND json_extract(json, '$.key') = ? LIMIT 1").get(key);
  return row !== undefined;
}

/**
 * At engine start: a decision that became pending while no engine was
 * running, or whose guess failed to be written, gets its guess now, as long
 * as it is still undecided: every job still `proposed`, and every city PR
 * still open and waiting on him (its run `waiting` with a PR and no
 * outcome, its job `waiting`). A key that already has a guess, or that he
 * has decided, is left alone, so every guess stays prospective. Returns
 * the guesses written; one that fails is logged and the rest go on.
 */
export function catchUpPredictions(now: number = Date.now()): Prediction[] {
  const out: Prediction[] = [];
  const tryOne = (job: Job, r: Run | null): void => {
    try {
      const insp = r ? latestInspection(r.id) : null;
      const key = itemKey(workKind(job, r ? (insp ?? {}) : null), job.id);
      if (registered(key) || decided(key)) return;
      out.push(registerPrediction(job, r, now, insp));
    } catch (err) {
      console.error(`palimpsest: the master's guess on ${job.id} could not be caught up: ${errText(err)}`);
    }
  };
  try {
    const jobs = new Map(listJobs().map((j) => [j.id, j]));
    for (const j of jobs.values()) if (j.status === 'proposed') tryOne(j, null);
    for (const r of listRuns()) {
      const j = jobs.get(r.jobId);
      if (!j || j.status !== 'waiting' || r.stage !== 'waiting' || r.prNumber === null || r.outcome !== null || r.endedAt) continue;
      tryOne(j, r);
    }
  } catch (err) {
    console.error(`palimpsest: the master's missed guesses could not be read: ${errText(err)}`);
  }
  return out;
}

// ---------------------------------------------------------------- his decisions (ruling 14)

/** What suspends a pair the city acted for and he undid: autonomy.ts's `suspend`, through hooks.ts unless a test injects its own. */
export type Suspend = (kind: WorkKind, repo: string, reason: string, now: number) => void;
/** Why a pair is suspended when he undoes what it did. */
export const UNDO_REASON = 'he undid it';

const hookSuspend: Suspend = (kind, repo, reason, now) => suspendPair(kind, repo, reason, now);

/**
 * What the city did on its own to a job (Task 17's `autonomy.acted` rows,
 * matched by `jobId`, never by key): whether it acted at all, and the pair
 * of the latest act whose kind it can read. Empty until Task 17 lands.
 */
function actedOn(jobId: string): { acted: boolean; last: { kind: WorkKind; repo: string | null } | null } {
  const rows = openDb()
    .prepare("SELECT json FROM ledger WHERE kind = 'autonomy.acted' AND json_extract(json, '$.jobId') = ? ORDER BY id")
    .all(jobId) as Array<{ json: string }>;
  let last: { kind: WorkKind; repo: string | null } | null = null;
  for (const row of rows) {
    let d: Record<string, unknown> = {};
    try {
      d = (JSON.parse(row.json) as Record<string, unknown>) ?? {};
    } catch {
      continue;
    }
    const grant = d.grant && typeof d.grant === 'object' ? (d.grant as Record<string, unknown>) : {};
    const kind = d.kind ?? grant.kind;
    const repo = d.repo ?? grant.repo;
    if (typeof kind === 'string' && (WORK_KINDS as readonly string[]).includes(kind)) last = { kind: kind as WorkKind, repo: typeof repo === 'string' ? repo : null };
  }
  return { acted: rows.length > 0, last };
}

/** Every resolution of `key`, oldest first. */
function resolutions(key: string): Decision[] {
  return (openDb().prepare('SELECT json FROM decisions WHERE key = ? ORDER BY rowid').all(key) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Decision);
}

/** The latest resolution of each key of this job's PR (a `merge:*` key), the newest last. */
function latestMergeOf(jobId: string): Decision | null {
  const rows = (openDb().prepare("SELECT json FROM decisions WHERE kind LIKE 'merge:%' ORDER BY rowid").all() as Array<{ json: string }>)
    .map((r) => JSON.parse(r.json) as Decision)
    .filter((d) => d.jobId === jobId);
  return rows.at(-1) ?? null;
}

/** The run that carried this job's PR: the job's own run when it has one, else its newest run with a PR. */
function prRun(job: Job): Run | null {
  const own = job.runId ? storedRun(job.runId) : null;
  if (own && own.prNumber !== null) return own;
  return (
    listRuns({ jobId: job.id })
      .filter((r) => r.prNumber !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1) ?? null
  );
}

/** The kind of decision `by` puts on this job: the proposal itself, or its PR (by the run's inspection). */
function kindFor(job: Job, by: Decision['by'], r: Run | null): WorkKind {
  if (by === 'accept' || by === 'dismiss') return workKind(job, null);
  const pr = r ?? prRun(job);
  if (!pr) return workKind(job, by === 'undo' ? null : {});
  return workKind(job, latestInspection(pr.id) ?? {});
}

/** The prediction with this id (its `master.predicted` ledger id), or null. */
function predictionById(id: number): Prediction | null {
  const row = openDb().prepare('SELECT id, json FROM predictions WHERE id = ?').get(id) as { id: number | bigint; json: string } | undefined;
  return row ? { ...(JSON.parse(row.json) as Prediction), id: Number(row.id) } : null;
}

/** The inputs the master read for a prediction, from its `master.predicted` row. */
function inputsOf(predictionId: number): Record<string, unknown> | null {
  const row = openDb().prepare("SELECT json FROM ledger WHERE id = ? AND kind = 'master.predicted'").get(predictionId) as { json: string } | undefined;
  if (!row) return null;
  const d = JSON.parse(row.json) as { inputs?: unknown };
  return d.inputs && typeof d.inputs === 'object' ? (d.inputs as Record<string, unknown>) : null;
}

/**
 * Records one of his decisions on `job` at `at` (ruling 14), against the
 * master's guess on its key if that guess was written strictly before
 * (ruling 15): `agreed` is whether the guess (approve at 0.5 or more) matches
 * him, false for an abstention, null with no earlier guess (in no window).
 *
 * The city's own acts are never his: on a job with an `autonomy.acted` row
 * (by `jobId`) an accept or a merge records nothing, and his dismissal,
 * withdrawal or close is an `undo` under the kind of the act he undid,
 * approved false and agreed false, which suspends that act's pair. His
 * revert supersedes his earlier approve of the job's PR as a decline (on a
 * job the city merged itself it enters the window as agreed false; its
 * revocation is Task 17's). A key he has already decided is not decided
 * again, but for that revert. Returns the decision, or null when nothing is
 * recorded.
 */
export function resolve(job: Job, by: Decision['by'], at: number = Date.now(), o: { run?: Run | null; suspend?: Suspend } = {}): Decision | null {
  const city = actedOn(job.id);
  let kind: WorkKind;
  let forced = false;
  let pair: { kind: WorkKind; repo: string } | null = null;
  let superseded: Decision | null = null;
  if (city.acted) {
    if (by === 'accept' || by === 'merge') return null;
    if (by !== 'revert') by = 'undo';
    kind = city.last?.kind ?? kindFor(job, by, o.run ?? null);
    forced = true;
    if (by === 'undo') pair = { kind, repo: city.last?.repo ?? job.repo };
  } else if (by === 'undo') {
    return null;
  } else if (by === 'revert') {
    const prior = latestMergeOf(job.id);
    if (!prior || !prior.approved) return null;
    kind = prior.kind;
    superseded = prior;
  } else {
    kind = kindFor(job, by, o.run ?? null);
  }

  const key = itemKey(kind, job.id);
  const history = resolutions(key);
  // Decided once; a revert only turns an approve (or, on a job the city merged, nothing yet) into a decline.
  const latest = history.at(-1);
  if (by === 'revert' ? latest !== undefined && !latest.approved : latest !== undefined) return null;

  const approved = by === 'accept' || by === 'merge';
  // A revert is judged against the guess the approve it supersedes was judged against (null if it had none), never a later one.
  const pred = superseded ? (superseded.predictionId !== null ? predictionById(superseded.predictionId) : null) : registered(key);
  const before = pred !== null && Date.parse(pred.at) < at;
  const agreed = forced ? false : before ? pred.p !== null && pred.p >= 0.5 === approved : null;
  const predictionId = before ? pred.id : null;
  const decision: Decision = { key, kind, repo: job.repo, jobId: job.id, approved, by, predictionId, agreed, at: new Date(at).toISOString() };
  const inputs = predictionId !== null ? inputsOf(predictionId) : null;
  record('decision.resolved', { ...decision, ...(inputs ? { inputs } : {}) });
  openDb().prepare('INSERT INTO decisions (key, at, kind, repo, json) VALUES (?, ?, ?, ?, ?)').run(key, decision.at, kind, job.repo, JSON.stringify(decision));
  emit('decision.resolved', { decision });
  if (pair) {
    try {
      (o.suspend ?? hookSuspend)(pair.kind, pair.repo, UNDO_REASON, at);
    } catch (err) {
      console.error(`palimpsest: the ${pair.kind} pair on ${pair.repo} could not be suspended: ${errText(err)}`);
    }
  }
  return decision;
}

/** One event on the bus, as his decision or nothing. */
function hear(type: string, data: unknown, at: number, suspend: Suspend): void {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (type === 'job.changed') {
    const j = d.job as Job | undefined;
    const from = d.from;
    if (!j || typeof j.id !== 'string' || from === j.status) return;
    if (from === 'proposed' && j.status === 'open') resolve(j, 'accept', at, { suspend });
    else if (j.status === 'withdrawn' && j.withdrawnBy === 'him') resolve(j, from === 'proposed' ? 'dismiss' : 'undo', at, { suspend });
    else if (j.status === 'merged' && from === 'waiting') {
      // PR mode only: a push-mode merge comes from `shipping` and is not his decision.
      const r = prRun(j);
      if (r) resolve(j, 'merge', at, { run: r, suspend });
    }
    return;
  }
  if (type === 'run.ended') {
    const r = typeof d.runId === 'string' ? storedRun(d.runId) : null;
    if (!r || r.outcome !== 'closed' || r.prNumber === null) return;
    const j = storedJob(r.jobId);
    if (!j) return;
    // Merged with changes still approves; closed by him declines; any other close (its issue closed) is no decision.
    if (r.mergedWithChanges) resolve(j, 'merge', at, { run: r, suspend });
    else if (r.endedReason === PR_CLOSED_REASON) resolve(j, 'close', at, { run: r, suspend });
    return;
  }
  if (type === 'merge.reverted') {
    // Ruling 19: the pair that acted on the job is revoked first, before the window and before the repo halts.
    noteRevert(d);
    const j = typeof d.jobId === 'string' ? storedJob(d.jobId) : null;
    if (j) resolve(j, 'revert', at, { suspend });
  }
}

/**
 * Hears his decisions on the bus (ruling 14): `job.changed` (an accept, a
 * dismissal, a withdrawal, a PR-mode merge), `run.ended` (a PR merged with
 * changes, or closed by him) and `merge.reverted` (which first revokes the
 * pair that acted on the job, through hooks.ts). `suspend` is autonomy.ts's
 * through hooks.ts unless given. main.ts installs it; returns the unsubscribe.
 */
export function installDecisions(o: { now?: () => number; suspend?: Suspend } = {}): () => void {
  const now = o.now ?? (() => Date.now());
  const suspend = o.suspend ?? hookSuspend;
  return subscribe((e) => {
    if (e.type !== 'job.changed' && e.type !== 'run.ended' && e.type !== 'merge.reverted') return;
    try {
      hear(e.type, e.data, now(), suspend);
    } catch (err) {
      console.error(`palimpsest: his decision on ${e.type} could not be recorded: ${errText(err)}`);
    }
  });
}

// ---------------------------------------------------------------- the agreement (ruling 16)

/** The latest resolution of each key of `kind` with a non-null `agreed`, in the order they were last resolved. */
function windowOf(kind: WorkKind): Decision[] {
  const latest = new Map<string, Decision>();
  for (const r of openDb().prepare('SELECT key, json FROM decisions WHERE kind = ? ORDER BY rowid').all(kind) as Array<{ key: string; json: string }>) {
    latest.delete(r.key);
    latest.set(r.key, JSON.parse(r.json) as Decision);
  }
  return [...latest.values()].filter((d) => d.agreed !== null);
}

/**
 * The master's agreement with him on `kind` (ruling 16): over the last 50
 * non-null `agreed` rows of the kind, pooled across repos, the rate with its
 * interval; eligible with 50 rows at 0.95 or better. With a repo, its own
 * test: at least 10 of its rows of the kind and none of its last 10 against.
 * `skewed` is the current master's mark for the kind (ruling 11).
 */
export function agreement(kind: WorkKind, repo?: string | null): Agreement {
  const all = windowOf(kind);
  const last = all.slice(-AGREE.window);
  const agreed = last.filter((d) => d.agreed === true).length;
  const rate = last.length ? ci(last.map((d) => (d.agreed ? 1 : 0))) : null;
  const eligible = last.length >= AGREE.window && rate !== null && rate.value >= AGREE.rate;
  let repoOk: boolean | null = null;
  if (repo) {
    const mine = all.filter((d) => d.repo === repo);
    repoOk = mine.length >= AGREE.repoMin && mine.slice(-AGREE.repoLast).every((d) => d.agreed === true);
  }
  let skewed = false;
  try {
    skewed = skewedKinds().includes(kind);
  } catch {
    skewed = false;
  }
  return { kind, repo: repo ?? null, rows: last.length, agreed, rate, eligible, repoOk, skewed };
}

/** The agreement on each of the six kinds, pooled across repos. */
export function agreements(): Agreement[] {
  return WORK_KINDS.map((k) => agreement(k));
}

// The market asks through hooks.ts (a pending decision, a bid to appraise) ...
setPendingHook((job, r, now, inspection) => {
  registerPrediction(job, r, now, inspection);
});
setAppraiserHook(appraiseBid);
// ... and distillation asks the real master, on what it would read before his decision.
setDistilPredict(predict, (job, r, _kind, now, inspection) => masterInputs(job, r, now, inspection));
