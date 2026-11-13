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
 * - `autonomy.acted` (Task 17 writes these through `noteActed` and
 *   `noteActResult`): before an act, `{ kind, repo, jobId, key, grant, at }`
 *   with the grant's `acted` count moved; after it, `{ kind, repo, jobId,
 *   key, result: { ok, reason }, at }` with no grant. `kind` and `repo` sit
 *   at the top of both, which is where decisions.ts reads them (by `jobId`).
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
import { prState } from '../github.js';
import { paths } from '../home.js';
import { query, record } from '../ledger.js';
import { job as storedJob } from '../market/jobs.js';
import { listRuns, run as storedRun, STOP_REASON } from '../market/runs.js';
import { watchRevertsFor } from '../market/ship.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import { latestInspection } from './datasets.js';
import { agreement, masterState, registered } from './decisions.js';
import { setRevertHook, setSuspendHook } from './hooks.js';
import { versions } from './nets.js';

/** The repo the engine imports as a library: never asked about, granted or acted on (ruling 1). */
export const BEAGLE_REPO = 'AllStreets/beagle';

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
  if (name === BEAGLE_REPO) return `${BEAGLE_REPO} is never acted on while Palimpsest imports it.`;
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
  if (repo === BEAGLE_REPO) throw new Error(`${BEAGLE_REPO} is never granted while Palimpsest imports it.`);
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
  const had = grantOf(kind, repo);
  if (!had || had.state !== 'granted') throw new Error(`There is no grant for ${kind} on ${repo} to act under.`);
  return write('autonomy.acted', { ...had, acted: had.acted + 1 }, { jobId, key: itemKey(kind, jobId) }, iso(now));
}

/** After an act: what came of it. Carries no grant, so it moves no pair. */
export function noteActResult(kind: WorkKind, repo: string, jobId: string, result: { ok: boolean; reason: string | null }, now: number = Date.now()): void {
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
 * before the repo halts. A revert of a job the city did not act on revokes
 * nothing.
 */
export function revokeOnRevert(data: Record<string, unknown>): void {
  const jobId = typeof data.jobId === 'string' ? data.jobId : null;
  if (!jobId) return;
  const pair = actedPair(jobId);
  if (!pair) return;
  const had = grantOf(pair.kind, pair.repo);
  if (!had || (had.state !== 'granted' && had.state !== 'suspended')) return;
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
 * no older than `AGREE.staleDays`; and for a merge the inspection passed
 * and pushable, the PR open at the inspected head, and a forced revert
 * read of the repo (a failed read refuses; a revert found revokes first).
 * Anything thrown answers `could not check: ...`. Never throws.
 */
export async function mayAct(kind: WorkKind, repo: string, jobId: string, now: number = Date.now()): Promise<MayAct> {
  try {
    return await check(kind, repo, jobId, now);
  } catch (err) {
    return no(`could not check: ${errText(err)}`);
  }
}

async function check(kind: WorkKind, repo: string, jobId: string, now: number): Promise<MayAct> {
  checkKind(kind);
  if (!getSettings().school.enabled) return no('The school is off.');
  if (repo === BEAGLE_REPO) return no(`${BEAGLE_REPO} is never acted on while Palimpsest imports it.`);

  const g = grantOf(kind, repo);
  if (!g) return no(`There is no grant for ${kind} on ${repo}.`);
  if (g.state === 'asked') return no(`You have not granted ${kind} on ${repo} yet.`);
  if (g.state === 'declined') return no(`You declined ${kind} on ${repo}.`);
  if (g.state === 'revoked') return no(`The grant for ${kind} on ${repo} was revoked ${g.by === 'revert' ? 'after a revert' : 'by you'}.`);
  if (g.state === 'suspended') return no(`The grant for ${kind} on ${repo} is suspended: ${sentence(g.reason ?? 'no reason was written down')}`);
  if (g.state !== 'granted') return no(`The grant for ${kind} on ${repo} is in a state this engine does not know: ${String(g.state)}.`);

  if (existsSync(paths().stop)) return no(STOP_REASON);
  const repoRow = getRepo(repo);
  const refused = repoRefusal(repoRow, repo);
  if (refused || !repoRow) return no(refused ?? `${repo} is not connected.`);

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

  const a = agreement(kind, repo);
  if (a.skewed) return no(`The master is skewed on ${kind}.`);
  if (!a.eligible) {
    const reason = `The master agreed with you on ${a.agreed} of the last ${a.rows} ${kind} decisions; autonomy needs ${AGREE.window} at ${Math.round(AGREE.rate * 100)}%.`;
    suspend(kind, repo, reason, now);
    return no(reason);
  }
  if (!a.repoOk) {
    const reason = `${repo} no longer passes its own test on ${kind}: the master must have agreed with you on its last ${AGREE.repoLast} decisions there, with at least ${AGREE.repoMin} on record.`;
    suspend(kind, repo, reason, now);
    return no(reason);
  }

  const master = masterState(now);
  if (master.reason !== null || !master.master) return no(sentence(capital(master.reason ?? 'there is no master yet')));

  const key = itemKey(kind, jobId);
  const pred = registered(key);
  if (!pred) return no(`The master made no guess on ${key}.`);
  if (pred.p === null) return no(`The master abstained on ${key}: ${sentence(pred.reason ?? 'no reason was written down')}`);
  if (pred.p < AGREE.actP) return no(`The master's guess on ${key} is ${num(pred.p)}, under ${AGREE.actP}.`);
  if (pred.version !== master.master.version.version) {
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
    // The fresh revert read, always forced past the throttle: a throttled read would answer ok with nothing read.
    const read = await watchRevertsFor(repoRow, now, { force: true });
    if (!read.ok) return no(`The revert read of ${repo} failed: ${sentence(read.reason ?? 'no reason was given')}`);
    if (read.reverted.length) {
      // The handler revoked the acting pair on the bus already; if not (nothing installed), this pair is revoked here first.
      const still = grantOf(kind, repo);
      if (still && still.state !== 'revoked') revoke(kind, repo, 'revert', null, now);
      return no(`A city merge on ${repo} was reverted: ${read.reverted.join('; ')}.`);
    }
  }
  return { ok: true, reason: null };
}

// decisions.ts suspends and revokes through hooks.ts; installed as this module loads
setSuspendHook((kind, repo, reason, now) => {
  suspend(kind, repo, reason, now);
});
setRevertHook(revokeOnRevert);
