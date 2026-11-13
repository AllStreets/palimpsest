/**
 * Earned autonomy, pair by pair (Phase 4 Task 16, rulings 17 to 19): the
 * asks, his grants, declines and revocations, the school's suspensions, and
 * `mayAct`, the one gate between the city and acting on his repos without
 * him. Every doubt refuses, and every refusal is a sentence he reads.
 *
 * A pair is one kind of work (`WorkKind`) on one repo. Its state is the
 * `Grant` row in the `grants` table, and every move writes a ledger entry
 * that carries the row whole (`grant`), so replay rebuilds the table:
 *
 * - `autonomy.asked { kind, repo, grant, at }`: the tick's ask (ruling 17).
 * - `autonomy.granted { kind, repo, fromSettings, grant, at }`: his grant,
 *   from the open ask, or from Settings for a pair he revoked or the school
 *   suspended. Nothing else grants.
 * - `autonomy.declined { kind, repo, grant, at }`: his decline; quiet 30 days.
 * - `autonomy.revoked { kind, repo, by, jobId, grant, at }`: by him, or by a
 *   revert of a merge the city made (ruling 19); quiet 30 days.
 * - `autonomy.suspended { kind, repo, reason, grant, at }`: the school's
 *   own stop (he undid an act, the window fell, the repo test failed, the
 *   repo allows only squash merges); asked again when eligible, no silence.
 * - `autonomy.acted` (`act()` writes these through `noteActed` and
 *   `noteActResult`, Task 17): before an act, `{ kind, repo, jobId, key,
 *   grant, at }` with the grant's `acted` count moved; after it, `{ kind,
 *   repo, jobId, key, result: { ok, reason }, at }` with no grant. `kind`
 *   and `repo` sit at the top of both, which is where decisions.ts reads
 *   them (by `jobId`), so the city's accept or merge is never heard as his.
 *
 * `act(now)` (ruling 18; `now` a clock read afresh per act) is the tick's: for every granted pair, every
 * proposal or waiting PR of that kind on that repo the city has not acted
 * on and he has not decided, `mayAct` immediately before, the row before,
 * `acceptProposed()` or `mergePR()` (with the head `mayAct` checked), the
 * result after. The switch and the stop file are read again between acts.
 * A key he has decided is refused, whatever the store says the job is.
 *
 * `AllStreets/beagle` is never asked about, never granted and never acted
 * on while Palimpsest imports Beagle (ruling 1), whatever the tables say.
 *
 * decisions.ts suspends a pair he undid and revokes one on a revert through
 * hooks.ts; this module installs both as it loads (tick.ts imports it, so
 * the engine always has them).
 */
import { existsSync } from 'node:fs';

import { AGREE, itemKey, WORK_KINDS, workKind } from '../../shared/school-rules.js';
import type { Grant, Job, Repo, Run, WorkKind } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { MergeMethodError, mergePR, prState } from '../github.js';
import { paths } from '../home.js';
import { query, record } from '../ledger.js';
import { acceptProposed, job as storedJob, listJobs } from '../market/jobs.js';
import { listRuns, run as storedRun, STOP_REASON } from '../market/runs.js';
import { watchRevertsFor } from '../market/ship.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import { latestInspection } from './datasets.js';
import { actTookEffect, agreement, decided, masterState, registered } from './decisions.js';
import { setActingHook, setRevertHook, setSuspendHook } from './hooks.js';
import { versions } from './nets.js';

/** The repo the engine imports as a library: never asked about, granted or acted on (ruling 1). */
export const BEAGLE_REPO = 'AllStreets/beagle';
/** Whether `name` is Beagle by any spelling: GitHub names ignore case, so the pin must too. */
export const isBeagle = (name: string): boolean => name.trim().toLowerCase() === BEAGLE_REPO.toLowerCase();

const DAY_MS = 24 * 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sentence = (s: string) => (!s || /[.!?)]$/.test(s) ? s : `${s}.`);
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'unknown');
const num = (p: number) => String(Number(p.toFixed(3)));

function checkKind(kind: string): asserts kind is WorkKind {
  if (!(WORK_KINDS as readonly string[]).includes(kind)) throw new Error(`${kind} is not a kind of work autonomy covers.`);
}

/** What each kind lets the city do, for the brief and Settings. */
export function kindWords(kind: WorkKind): { verb: string; noun: string } {
  switch (kind) {
    case 'propose:harness':
      return { verb: 'accept its own harness proposals', noun: 'harness proposal' };
    case 'propose:readme-gap':
      return { verb: 'accept its own README proposals', noun: 'README proposal' };
    case 'merge:ui':
      return { verb: 'merge its UI PRs', noun: 'UI PR' };
    default:
      return { verb: `merge its ${kind.slice('merge:'.length)}-tier PRs`, noun: `${kind.slice('merge:'.length)}-tier PR` };
  }
}

// ---------------------------------------------------------------- the store

/** The pair's row, or null; throws when the row cannot be read (mayAct turns that into a refusal). */
export function grantOf(kind: WorkKind, repo: string): Grant | null {
  const row = openDb().prepare('SELECT json FROM grants WHERE kind = ? AND repo = ?').get(kind, repo) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Grant) : null;
}

/** Every pair on record, in the kinds' order and then by repo. */
export function grants(): Grant[] {
  const rows = (openDb().prepare('SELECT json FROM grants').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Grant);
  const order = new Map(WORK_KINDS.map((k, i) => [k, i]));
  return rows.sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || a.repo.localeCompare(b.repo));
}

type Move = 'autonomy.asked' | 'autonomy.granted' | 'autonomy.declined' | 'autonomy.revoked' | 'autonomy.suspended' | 'autonomy.acted';

/** Writes the pair's new row to the table and the ledger (the row whole, as replay rebuilds it) and tells the bus. */
function write(move: Move, g: Grant, extra: Record<string, unknown> = {}, at: string = g.at): Grant {
  openDb()
    .prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, repo) DO UPDATE SET state = excluded.state, at = excluded.at, json = excluded.json')
    .run(g.kind, g.repo, g.state, g.at, JSON.stringify(g));
  record(move, { kind: g.kind, repo: g.repo, ...extra, grant: g, at });
  emit(move, { kind: g.kind, repo: g.repo, ...extra, grant: g });
  return g;
}

// ---------------------------------------------------------------- the repo's part

/** Why `repo` cannot be acted on or asked about now, as a sentence, or null when it can. */
function repoRefusal(repo: Repo | null, name: string): string | null {
  if (isBeagle(name)) return `${BEAGLE_REPO} is never acted on while Palimpsest imports it.`;
  if (!repo || !repo.connected) return `${name} is not connected.`;
  if (!repo.market) return `The market on ${name} is off.`;
  if (repo.halted) return `${name} is halted: ${sentence(repo.halted.reason)}`;
  if (!repo.checks?.test) return `${name} has no test command.`;
  if (!repo.checks?.build) return `${name} has no build command.`;
  return null;
}

// ---------------------------------------------------------------- asks (ruling 17)

/**
 * The tick's asks: once per (kind, repo) when the school is on, the master
 * current and trusted, the kind eligible and not skewed, the repo passing
 * its own test, connected, market on, not halted, with a test and a build
 * command, not Beagle, and the pair has no open ask, no grant, and no
 * decline or revocation younger than `AGREE.quietDays`. A suspended pair is
 * asked again as soon as it is eligible. Returns the pairs asked now.
 */
export function askDue(now: number = Date.now()): Grant[] {
  const out: Grant[] = [];
  if (!getSettings().school.enabled) return out;
  if (masterState(now).reason !== null) return out;
  const repos = listRepos().filter((r) => repoRefusal(r, r.fullName) === null);
  if (!repos.length) return out;
  for (const kind of WORK_KINDS) {
    const pooled = agreement(kind);
    if (!pooled.eligible || pooled.skewed) continue;
    for (const repo of repos) {
      const had = grantOf(kind, repo.fullName);
      if (had && (had.state === 'asked' || had.state === 'granted')) continue;
      if (had?.quietUntil && Date.parse(had.quietUntil) > now) continue;
      const a = agreement(kind, repo.fullName);
      if (!a.eligible || !a.repoOk || a.skewed) continue;
      out.push(write('autonomy.asked', { kind, repo: repo.fullName, state: 'asked', at: iso(now), by: 'school', rate: a.rate, reason: null, acted: had?.acted ?? 0, quietUntil: null }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- his moves

/**
 * His grant: from the open ask, or with `fromSettings` for a pair he
 * revoked or the school suspended (never one never asked, never a decline
 * still quiet, never Beagle). Throws, with the reason, when it cannot.
 */
export function grant(kind: WorkKind, repo: string, now: number = Date.now(), o: { fromSettings?: boolean } = {}): Grant {
  checkKind(kind);
  if (isBeagle(repo)) throw new Error(`${BEAGLE_REPO} is never granted while Palimpsest imports it.`);
  const had = grantOf(kind, repo);
  if (!had) throw new Error(o.fromSettings ? `${kind} on ${repo} has never been asked.` : `${kind} on ${repo} was not asked.`);
  if (had.state === 'granted') throw new Error(`${kind} on ${repo} is already granted.`);
  if (had.state !== 'asked') {
    if (!o.fromSettings) throw new Error(`${kind} on ${repo} is not asked: it is ${had.state}. Grant it again from Settings.`);
    if (had.state === 'declined') throw new Error(`${kind} on ${repo} was declined; it is asked again after ${AGREE.quietDays} days.`);
  }
  return write('autonomy.granted', { ...had, state: 'granted', at: iso(now), by: 'him', reason: null, quietUntil: null }, { fromSettings: o.fromSettings === true });
}

/** His decline of the open ask: quiet for `AGREE.quietDays`. */
export function decline(kind: WorkKind, repo: string, now: number = Date.now()): Grant {
  checkKind(kind);
  const had = grantOf(kind, repo);
  if (!had || had.state !== 'asked') throw new Error(`${kind} on ${repo} was not asked${had ? `: it is ${had.state}` : ''}.`);
  return write('autonomy.declined', { ...had, state: 'declined', at: iso(now), by: 'him', reason: null, quietUntil: iso(now + AGREE.quietDays * DAY_MS) });
}

/**
 * A revocation, by him or by a revert of a merge the city made (`jobId` is
 * the job reverted): quiet for `AGREE.quietDays`. A pair already revoked
 * stays as it is.
 */
export function revoke(kind: WorkKind, repo: string, by: 'him' | 'revert', jobId?: string | null, now: number = Date.now()): Grant {
  checkKind(kind);
  const had = grantOf(kind, repo);
  if (!had) throw new Error(`There is no grant for ${kind} on ${repo} to revoke.`);
  if (had.state === 'revoked') return had;
  return write('autonomy.revoked', { ...had, state: 'revoked', at: iso(now), by, reason: null, quietUntil: iso(now + AGREE.quietDays * DAY_MS) }, { by, jobId: jobId ?? null });
}

/** The school's own stop of a granted pair, with the reason he reads; a pair not granted is left alone (null). */
export function suspend(kind: WorkKind, repo: string, reason: string, now: number = Date.now()): Grant | null {
  checkKind(kind);
  const had = grantOf(kind, repo);
  if (!had || had.state !== 'granted') return null;
  return write('autonomy.suspended', { ...had, state: 'suspended', at: iso(now), by: 'school', reason, quietUntil: null }, { reason });
}

// ---------------------------------------------------------------- the city's acts (Task 17 writes through these)

/** Before an act under a grant: the `autonomy.acted` row, with the grant's count moved. Throws when the pair is not granted. */
export function noteActed(kind: WorkKind, repo: string, jobId: string, now: number = Date.now()): Grant {
  checkKind(kind);
  if (isBeagle(repo)) throw new Error(`${BEAGLE_REPO} is never acted on while Palimpsest imports it.`);
  const had = grantOf(kind, repo);
  if (!had || had.state !== 'granted') throw new Error(`There is no grant for ${kind} on ${repo} to act under.`);
  return write('autonomy.acted', { ...had, acted: had.acted + 1 }, { jobId, key: itemKey(kind, jobId) }, iso(now));
}

/** After an act: what came of it. Carries no grant, so it moves no pair. */
export function noteActResult(kind: WorkKind, repo: string, jobId: string, result: { ok: boolean; reason: string | null }, now: number = Date.now()): void {
  checkKind(kind);
  const data = { kind, repo, jobId, key: itemKey(kind, jobId), result, at: iso(now) };
  record('autonomy.acted', data);
  emit('autonomy.acted', data);
}

/** The pair of the latest `autonomy.acted` row on `jobId` whose kind can be read, or null. */
function actedPair(jobId: string): { kind: WorkKind; repo: string } | null {
  let last: { kind: WorkKind; repo: string } | null = null;
  for (const e of query({ kind: 'autonomy.acted', jobId })) {
    const d = e.data as { kind?: unknown; repo?: unknown; grant?: { kind?: unknown; repo?: unknown } | null };
    const kind = d.kind ?? d.grant?.kind;
    const repo = d.repo ?? d.grant?.repo;
    if (typeof kind === 'string' && (WORK_KINDS as readonly string[]).includes(kind) && typeof repo === 'string') last = { kind: kind as WorkKind, repo };
  }
  return last;
}

/**
 * Ruling 19: a `merge.reverted` whose job has an `autonomy.acted` row
 * revokes that pair, `by 'revert'` with the job, before the window and
 * before the repo halts: a granted or suspended pair, and an open ask on
 * it (closed, with the same 30 days of quiet). A revert of a job the city
 * did not act on revokes nothing.
 */
export function revokeOnRevert(data: Record<string, unknown>): void {
  const jobId = typeof data.jobId === 'string' ? data.jobId : null;
  if (!jobId) return;
  const pair = actedPair(jobId);
  if (!pair) return;
  const had = grantOf(pair.kind, pair.repo);
  if (!had || (had.state !== 'granted' && had.state !== 'suspended' && had.state !== 'asked')) return;
  const at = typeof data.at === 'string' ? Date.parse(data.at) : NaN;
  revoke(pair.kind, pair.repo, 'revert', jobId, Number.isFinite(at) ? at : Date.now());
}

// ---------------------------------------------------------------- mayAct (ruling 18)

export interface MayAct {
  ok: boolean;
  /** Why not, as a sentence he reads; null when it may. */
  reason: string | null;
}

const no = (reason: string): MayAct => ({ ok: false, reason });

/** The run that carries this job's PR: the job's own run when it has one, else its newest run with a PR. */
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

/**
 * Whether the city may act on `jobId` under the `kind` grant on `repo`, now
 * and read fresh (Decision 13): the school on; not Beagle; an active grant;
 * no stop file; the repo connected, market on, not halted, with test and
 * build; the job the kind says (a proposal waiting, or a PR waiting on him
 * of that kind); the master not skewed on the kind, the window still
 * eligible and the repo still passing its test (else the pair is suspended
 * with the reason, to be asked afresh); the master current and trusted; a
 * guess on the key at `AGREE.actP` or more from the current master or one
 * no older than `AGREE.staleDays`; for a merge the inspection passed and
 * pushable and the PR open at the inspected head; then, for every kind, a
 * forced revert read of the repo (a failed read refuses; a revert found
 * revokes first). After each await the checks that need no network run
 * again, so nothing he did meanwhile is missed. Anything thrown answers
 * `could not check: ...`. Never throws.
 */
export async function mayAct(kind: WorkKind, repo: string, jobId: string, now: number = Date.now()): Promise<MayAct> {
  try {
    return await check(kind, repo, jobId, now);
  } catch (err) {
    return no(`could not check: ${errText(err)}`);
  }
}

/**
 * The checks that read nothing over the network: the switch, the grant, the
 * stop file, the repo row, the master and his agreement (the window, the
 * repo test, the skew mark). They run first and again after every await, since the world moves while gh and git answer (he may flip
 * the switch, write the stop file or revoke the pair meanwhile).
 */
function standing(kind: WorkKind, repo: string, now: number): { refused: string | null; repoRow: Repo | null; master: ReturnType<typeof masterState>['master'] } {
  const none = { repoRow: null, master: null };
  if (!getSettings().school.enabled) return { ...none, refused: 'The school is off.' };
  if (isBeagle(repo)) return { ...none, refused: `${BEAGLE_REPO} is never acted on while Palimpsest imports it.` };

  const g = grantOf(kind, repo);
  if (!g) return { ...none, refused: `There is no grant for ${kind} on ${repo}.` };
  if (g.state === 'asked') return { ...none, refused: `You have not granted ${kind} on ${repo} yet.` };
  if (g.state === 'declined') return { ...none, refused: `You declined ${kind} on ${repo}.` };
  if (g.state === 'revoked') return { ...none, refused: `The grant for ${kind} on ${repo} was revoked ${g.by === 'revert' ? 'after a revert' : 'by you'}.` };
  if (g.state === 'suspended') return { ...none, refused: `The grant for ${kind} on ${repo} is suspended: ${sentence(g.reason ?? 'no reason was written down')}` };
  if (g.state !== 'granted') return { ...none, refused: `The grant for ${kind} on ${repo} is in a state this engine does not know: ${String(g.state)}.` };

  if (existsSync(paths().stop)) return { ...none, refused: STOP_REASON };
  const repoRow = getRepo(repo);
  const refused = repoRefusal(repoRow, repo);
  if (refused || !repoRow) return { ...none, refused: refused ?? `${repo} is not connected.` };

  const master = masterState(now);
  if (master.reason !== null || !master.master) return { ...none, refused: sentence(capital(master.reason ?? 'there is no master yet')) };

  // His agreement, read now: a decision of his that lands while gh or git answers counts.
  const a = agreement(kind, repo);
  if (a.skewed) return { ...none, refused: `The master is skewed on ${kind}.` };
  if (!a.eligible) {
    const refusedFor = `The master agreed with you on ${a.agreed} of the last ${a.rows} ${kind} decisions; autonomy needs ${AGREE.window} at ${Math.round(AGREE.rate * 100)}%.`;
    suspend(kind, repo, refusedFor, now);
    return { ...none, refused: refusedFor };
  }
  if (!a.repoOk) {
    const refusedFor = `${repo} no longer passes its own test on ${kind}: the master must have agreed with you on its last ${AGREE.repoLast} decisions there, with at least ${AGREE.repoMin} on record.`;
    suspend(kind, repo, refusedFor, now);
    return { ...none, refused: refusedFor };
  }
  return { refused: null, repoRow, master: master.master };
}

async function check(kind: WorkKind, repo: string, jobId: string, now: number): Promise<MayAct> {
  checkKind(kind);
  const first = standing(kind, repo, now);
  if (first.refused || !first.repoRow || !first.master) return no(first.refused ?? `There is no grant for ${kind} on ${repo}.`);
  const repoRow = first.repoRow;

  // The job the kind names, before any net is asked about it.
  const job = storedJob(jobId);
  let run: Run | null = null;
  let inspection: ReturnType<typeof latestInspection> = null;
  if (kind.startsWith('propose:')) {
    if (!job || job.status !== 'proposed') return no(`${jobId} is not a proposal waiting on you.`);
    if (job.repo !== repo) return no(`${jobId} is on ${job.repo}, not ${repo}.`);
    const k = workKind(job, null);
    if (k !== kind) return no(`${jobId} is ${k} work, not ${kind}.`);
  } else {
    run = job ? prRun(job) : null;
    if (!job || job.status !== 'waiting' || !run || run.stage !== 'waiting' || run.outcome !== null || run.prNumber === null) return no(`${jobId} has no PR waiting on you.`);
    if (job.repo !== repo || run.repo !== repo) return no(`${jobId} is on ${job.repo}, not ${repo}.`);
    inspection = latestInspection(run.id);
    const k = workKind(job, inspection ?? {});
    if (k !== kind) return no(`${jobId} is ${k} work, not ${kind}.`);
  }

  const key = itemKey(kind, jobId);
  // A key he has decided is his: the city never acts on it, whatever the store says the job is.
  if (decided(key)) return no(`You have already decided ${key}.`);
  const pred = registered(key);
  if (!pred) return no(`The master made no guess on ${key}.`);
  if (pred.p === null) return no(`The master abstained on ${key}: ${sentence(pred.reason ?? 'no reason was written down')}`);
  if (pred.p < AGREE.actP) return no(`The master's guess on ${key} is ${num(pred.p)}, under ${AGREE.actP}.`);
  if (pred.version !== first.master.version.version) {
    const v = pred.version === null ? undefined : versions('master').find((x) => x.version === pred.version);
    if (!v) return no(`The master's guess on ${key} came from v${pred.version ?? '?'}, which is no longer on record.`);
    const age = now - Date.parse(v.at);
    if (!Number.isFinite(age) || age > AGREE.staleDays * DAY_MS) {
      return no(`The master's guess on ${key} came from v${pred.version}, which is ${Number.isFinite(age) ? Math.floor(age / DAY_MS) : 'an unknown number of'} days old and no longer current.`);
    }
  }

  if (run) {
    if (!inspection) return no(`No inspection of ${run.id} is on record.`);
    if (!inspection.passed) return no(`The inspection of ${run.id} did not pass.`);
    if (!inspection.pushable) return no(`The inspection of ${run.id} is not pushable.`);
    const pr = await prState(repo, run.prNumber as number);
    if (pr.state !== 'OPEN') return no(`PR #${run.prNumber} on ${repo} is ${pr.state.toLowerCase()}.`);
    if (!run.headSha || pr.headRefOid !== run.headSha) return no(`The head of PR #${run.prNumber} on ${repo} moved: it is ${short(pr.headRefOid)}, not the inspected ${short(run.headSha)}.`);
    const again = standing(kind, repo, now);
    if (again.refused) return no(again.refused);
  }

  // The fresh revert read before any autonomous action on the repo, a proposal's accept included; always forced
  // past the throttle, since a throttled read would answer ok with nothing read.
  const read = await watchRevertsFor(repoRow, now, { force: true });
  if (!read.ok) return no(`The revert read of ${repo} failed: ${sentence(read.reason ?? 'no reason was given')}`);
  if (read.reverted.length) {
    // The handler revoked the acting pair on the bus already; if not (nothing installed), this pair is revoked here first.
    const still = grantOf(kind, repo);
    if (still && still.state !== 'revoked') revoke(kind, repo, 'revert', null, now);
    return no(`A city merge on ${repo} was reverted: ${read.reverted.join('; ')}.`);
  }
  // The world moved while git answered: everything read without the network is read once more.
  const last = standing(kind, repo, now);
  if (last.refused) return no(last.refused);
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------- the acts (ruling 18)

/** Something the city may act on under a pair: a proposal waiting, or a PR waiting with the run that carries it. */
interface Candidate {
  job: Job;
  run: Run | null;
}

/** Whether any `autonomy.acted` row names `jobId`: a job is acted on once, whatever came of it. */
function actedBefore(jobId: string): boolean {
  return query({ kind: 'autonomy.acted', jobId }).length > 0;
}

/** What `kind` on `repo` could act on now, the oldest first; a job the city already acted on, or a key he has decided, is never a candidate. */
function candidates(kind: WorkKind, repo: string): Candidate[] {
  const out: Candidate[] = [];
  if (kind.startsWith('propose:')) {
    for (const job of listJobs({ status: 'proposed' })) {
      if (job.repo !== repo || workKind(job, null) !== kind || actedBefore(job.id) || decided(itemKey(kind, job.id))) continue;
      out.push({ job, run: null });
    }
    return out.sort((a, b) => a.job.postedAt.localeCompare(b.job.postedAt));
  }
  const seen = new Set<string>();
  for (const run of listRuns().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (run.repo !== repo || run.stage !== 'waiting' || run.outcome !== null || run.prNumber === null || !run.headSha || seen.has(run.jobId)) continue;
    const job = storedJob(run.jobId);
    if (!job || job.status !== 'waiting' || job.repo !== repo) continue;
    if (prRun(job)?.id !== run.id) continue;
    if (workKind(job, latestInspection(run.id) ?? {}) !== kind || actedBefore(job.id) || decided(itemKey(kind, job.id))) continue;
    seen.add(job.id);
    out.push({ job, run });
  }
  return out;
}

/** The switch and the stop file, read between acts in one tick: either stops the tick's acts where they are. */
function stopped(): boolean {
  return !getSettings().school.enabled || existsSync(paths().stop);
}

/**
 * One act, after `mayAct` said yes a moment ago: `autonomy.acted` first (so
 * decisions.ts never hears the act as his), then `acceptProposed()` or
 * `mergePR()` with the head `mayAct` checked, then the result row. A merge
 * refused because the repo allows only squash or rebase merges suspends the
 * pair with that reason. Returns whether the act went through.
 */
/** The jobs an act is in flight on: between the row before and the row after, decisions.ts hears the act as the city's through `acting` (hooks.ts). */
const inFlight = new Set<string>();

async function actOn(kind: WorkKind, repo: string, c: Candidate, now: number): Promise<boolean> {
  const jobId = c.job.id;
  // read once more, with no wait since mayAct: the head the merge must match
  const run = c.run ? storedRun(c.run.id) : null;
  if (kind.startsWith('merge:') && (!run || run.prNumber === null || !run.headSha || run.stage !== 'waiting' || run.outcome !== null)) return false;
  inFlight.add(jobId);
  try {
    try {
      noteActed(kind, repo, jobId, now);
    } catch (err) {
      console.error(`palimpsest: the city could not record its act on ${jobId}, so it did not act: ${errText(err)}`);
      return false;
    }
    let result: { ok: boolean; reason: string | null };
    try {
      if (run) await mergePR(repo, run.prNumber as number, run.headSha as string);
      else acceptProposed(jobId);
      result = { ok: true, reason: null };
    } catch (err) {
      result = { ok: false, reason: errText(err) };
      if (err instanceof MergeMethodError) suspend(kind, repo, err.message, now);
    }
    try {
      noteActResult(kind, repo, jobId, result, now);
    } catch (err) {
      console.error(`palimpsest: the result of the city's act on ${jobId} could not be recorded: ${errText(err)}`);
    }
    return result.ok;
  } finally {
    inFlight.delete(jobId);
  }
}

/**
 * At engine start: every before-row with no result row of its pair (the
 * engine stopped between `noteActed` and the result) gets its result now,
 * from what the store shows (`actTookEffect`), so the brief never says the
 * result is not on record forever and decisions.ts counts only acts that
 * happened. Returns how many were closed.
 */
export function closeOrphanedActs(now: number = Date.now()): number {
  const open = new Map<string, { kind: WorkKind; repo: string; jobId: string }>();
  for (const e of query({ kind: 'autonomy.acted' })) {
    const d = e.data as { kind?: unknown; repo?: unknown; jobId?: unknown; result?: unknown; grant?: { kind?: unknown; repo?: unknown } | null };
    const kind = d.kind ?? d.grant?.kind;
    const repo = d.repo ?? d.grant?.repo;
    if (typeof kind !== 'string' || !(WORK_KINDS as readonly string[]).includes(kind) || typeof repo !== 'string' || typeof d.jobId !== 'string') continue;
    const key = itemKey(kind as WorkKind, d.jobId);
    if (d.result && typeof d.result === 'object') open.delete(key);
    else open.set(key, { kind: kind as WorkKind, repo, jobId: d.jobId });
  }
  for (const o of open.values()) {
    const ok = actTookEffect(o.kind, o.jobId);
    const what = o.kind.startsWith('propose:') ? 'accept' : 'merge';
    const reason = ok ? `the ${what} went through, but the engine stopped before it could write that down` : `the engine stopped before the ${what} was made or confirmed`;
    noteActResult(o.kind, o.repo, o.jobId, { ok, reason }, now);
  }
  return open.size;
}

let acting = false;

/**
 * The tick's acts (ruling 18; Decision 13): for every granted pair, in the
 * kinds' order, every proposal or waiting PR of that kind on that repo that
 * the city has not acted on before. `mayAct` is asked immediately before
 * each act and nothing else's answer counts; the switch and the stop file
 * are read again between acts, and either ends the tick's acts at once. A
 * refusal is no act and leaves no row (a suspension or revocation inside
 * `mayAct` writes its own). Returns how many acts went through. Nothing with
 * the school off, and nothing while another call is still acting.
 */
export async function act(now: number | (() => number) = Date.now): Promise<number> {
  if (acting) return 0;
  acting = true;
  try {
    return await actAll(typeof now === 'function' ? now : () => now);
  } finally {
    acting = false;
  }
}

/** `clock` is read afresh for each act, so a merge that waited on gh is checked and recorded at its own time, not the tick's. */
async function actAll(clock: () => number): Promise<number> {
  let n = 0;
  if (stopped()) return n;
  for (const g of grants()) {
    if (g.state !== 'granted' || isBeagle(g.repo)) continue;
    for (const c of candidates(g.kind, g.repo)) {
      if (stopped()) return n;
      const now = clock();
      const may = await mayAct(g.kind, g.repo, c.job.id, now);
      if (!may.ok) {
        if (may.reason?.startsWith('could not check')) console.warn(`palimpsest: the city did not act on ${c.job.id}: ${may.reason}`);
        continue;
      }
      if (await actOn(g.kind, g.repo, c, clock())) n++;
    }
  }
  return n;
}

// decisions.ts suspends and revokes through hooks.ts; installed as this module loads
setSuspendHook((kind, repo, reason, now) => {
  suspend(kind, repo, reason, now);
});
setRevertHook(revokeOnRevert);
setActingHook((jobId) => inFlight.has(jobId));
