/**
 * Shipping (Task 16): the only code that writes to his GitHub repos.
 *
 * Every shipment leaves from the engine's own clone at `<runRoot>/ship`
 * (ruling 20), which the inspection made: a fresh clone of the mirror into
 * which the run branch was fetched as data and checked against the sha the
 * engine committed (`run.headSha`). The engine pushes exactly that sha by
 * name. No code of the repo runs in the inspected clone during shipping:
 * its tree was written by head code (the install, the checks), so only git
 * reads it, with hooks, fsmonitor and the global attributes file off, after
 * the layout and `.git/config` hash checks.
 *
 * PR mode (the default): push `<headSha>:refs/heads/palimpsest/<jobId>`,
 * open the PR, lay a waiting floor, and wait. The PR poll lights the floor
 * when he merges it, and removes it with no scar when he closes it.
 *
 * Push mode (only when the repo asks for it, the inspection is pushable and
 * the repo has both a test and a build command, ruling 23): the branch is
 * pushed as in PR mode, then a fresh ship clone of the synced mirror merges
 * `headSha` into the default branch with `--no-ff`, the merge sha is
 * recorded, the install, the test and the build run again there under the
 * tool profile (egress open to the registries for the install only), HEAD
 * must still be the recorded merge, and that sha is pushed by name as a
 * fast-forward. A rejection fetches and tries once more, then reopens the
 * job with no scar. A merge that conflicts or a recheck that fails falls
 * back to a PR. Nothing is ever force-pushed; the only branches ever
 * deleted are the city's own `palimpsest/<jobId>`.
 *
 * The revert watch halts a repo whose city merge was reverted (self-halt).
 */
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { CheckName, CheckResult, Floor, FloorSize, Inspection, Job, Repo, Run } from '../../shared/types.js';
import { emit } from '../events.js';
import { getRunner } from '../exec.js';
import { createPR, openPRsFrom, prState, prTitle, recentCommits, type PRState } from '../github.js';
import { runCheck } from '../guild/checks.js';
import { canOpenPR, canPush, inspectionSummary, wipeScratch } from '../guild/inspect.js';
import { home, isRealDataHome, paths } from '../home.js';
import { record } from '../ledger.js';
import { mirrorDir, syncMirror } from '../mirror.js';
import { earnedFloors, getRepo, layEarnedFloor, listRepos, removeEarnedFloor, updateEarnedFloor } from '../repos.js';
import { bidById } from './bids.js';
import type { Egress } from './egress.js';
import { agent as storedAgent, agentTowerId } from './firms.js';
import { installDeps as defaultInstallDeps, type InstallDeps, type RunContext } from './install.js';
import { job as storedJob, publicSummary, transition } from './jobs.js';
import type { RunLogLine } from './provider.js';
import { reapRun } from './reaper.js';
import { eraFor } from './reputation.js';
import { finishWaitingRun, haltRepo, listRuns, liveRunIds, run as storedRun, updateRun } from './runs.js';
import { SYSTEM_PATH } from './sandbox.js';
import { createShipDir, engineGit, ENGINE_GIT_FLAGS } from './worktree.js';

/** How often one waiting PR is asked about. */
export const PR_POLL_MS = 5 * 60_000;
/** How often one repo with lit floors is read for reverts. */
export const REVERT_WATCH_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Pushes to the default branch in push mode: the first, and one retry after a fetch. */
export const PUSH_TRIES = 2;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const AUTHOR = ['-c', 'user.name=Palimpsest', '-c', 'user.email=palimpsest@local', '-c', 'commit.gpgSign=false'];
/** Every engine git call here reads attributes from nowhere but the tree itself (never a global file). */
const SAFE = ['-c', 'core.attributesFile=/dev/null'];
/** Flags no push of the city may ever carry. */
const FORCE_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--tags', '--prune', '--follow-tags', '-d', '--delete']);

/** What the runner gives the shipping stage: the run's log and its egress proxy. */
export interface ShipContext {
  log?: (line: RunLogLine) => void;
  /** Opened to the registries for the push-mode install, then closed again. */
  egress?: Pick<Egress, 'setStage'> | null;
  /** The push-mode install (default installDeps). */
  installDeps?: InstallDeps;
  /** Kills whatever of the run is left before its scratch dirs are wiped (default reapRun). */
  reap?: (runRoot: string) => Promise<unknown>;
}

const iso = (ms: number = Date.now()) => new Date(ms).toISOString();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function runRootOf(r: Run): string {
  return join(paths().runs, r.id);
}

function fileLog(runRoot: string): (line: RunLogLine) => void {
  return (line) => {
    try {
      mkdirSync(runRoot, { recursive: true });
      appendFileSync(join(runRoot, 'log.jsonl'), `${JSON.stringify(line)}\n`);
    } catch {
      // the log never stops shipping
    }
  };
}

async function gitOk(dir: string, args: string[]): Promise<string> {
  const r = await engineGit(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------- the ship clone (ruling 20)

/**
 * The clone a run ships from. The run dir, while it still exists, must
 * still hold the run branch at the engine's commit. With the inspection's
 * clone in place (and `fresh` not asked), its fetched head must be
 * `run.headSha`; otherwise, or with `fresh`, a new clone of the mirror is
 * made and checked the same way (createShipDir). Throws on any mismatch.
 */
export async function shipClone(r: Run, o: { fresh?: boolean; repo?: Repo } = {}): Promise<string> {
  const head = r.headSha;
  if (!head || !SHA.test(head)) throw new Error('The run has no engine commit to ship.');
  const runRoot = runRootOf(r);
  const dir = r.dir ?? join(runRoot, 'repo');
  const ship = join(runRoot, 'ship');
  if (existsSync(dir)) {
    const tip = await engineGit(dir, ['rev-parse', '--verify', `refs/heads/${r.branch}^{commit}`]);
    if (tip.code !== 0 || tip.stdout.trim() !== head) {
      throw new Error(`The run branch moved after the engine's commit ${head.slice(0, 7)}: nothing ships.`);
    }
  }
  if (!o.fresh && existsSync(ship)) {
    const fetched = await gitOk(ship, ['rev-parse', '--verify', 'refs/palimpsest/head^{commit}']);
    if (fetched !== head) throw new Error(`The ship clone holds ${fetched.slice(0, 7)}, not the engine's commit ${head.slice(0, 7)}.`);
    return ship;
  }
  if (!existsSync(dir)) throw new Error('The run dir is gone, so no ship clone can be made.');
  const repo = o.repo ?? getRepo(r.repo);
  if (!repo) throw new Error(`${r.repo} is not connected.`);
  return createShipDir(repo, r.id, dir, r.branch, head);
}

/** Every commit of the run carries its job's trailer, so no city commit can become a founding floor (ruling 17). */
async function checkTrailers(ship: string, base: string, head: string, jobId: string): Promise<void> {
  const out = await gitOk(ship, ['log', '--format=%H%x1f%B%x1e', `${base}..${head}`, '--']);
  const trailer = new RegExp(`^Palimpsest-Job: ${jobId.replace(/[.]/g, '\\.')}$`, 'm');
  const commits = out.split('\x1e').map((c) => c.trim()).filter(Boolean);
  if (!commits.length) throw new Error('The run has no commit between its base and its head.');
  for (const c of commits) {
    const [sha, body = ''] = c.split('\x1f');
    if (!trailer.test(body)) throw new Error(`Commit ${sha.slice(0, 7)} has no Palimpsest-Job trailer for ${jobId}: nothing ships.`);
  }
}

/** Changed lines between two commits, for the floor's size. */
async function changedLines(ship: string, base: string, head: string): Promise<number> {
  const out = await gitOk(ship, [...SAFE, 'diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--']);
  let lines = 0;
  for (const row of out.split('\n')) {
    const [a, d] = row.split('\t');
    if (a && a !== '-') lines += Number(a) || 0;
    if (d && d !== '-') lines += Number(d) || 0;
  }
  return lines;
}

// ---------------------------------------------------------------- pushes

/**
 * Where the city pushes: the mirror's origin. On the real data home it must
 * be exactly the repo's GitHub URL; anywhere else (tests, the sample) it
 * must be a local path, so nothing but a temp stand-in is ever written.
 */
export async function pushTarget(repo: Repo): Promise<string> {
  // Read with the push's own clean environment: no GIT_DIR, config parameters or global config of the engine's can redirect it.
  const r = await getRunner()('git', [`--git-dir=${mirrorDir(repo.fullName)}`, 'config', '--local', '--get', 'remote.origin.url'], { timeoutMs: 30_000, env: pushEnv() });
  const url = r.stdout.trim();
  if (r.code !== 0 || !url) throw new Error(`The mirror of ${repo.fullName} has no origin to push to.`);
  if (isRealDataHome(home())) {
    const full = repo.fullName.toLowerCase();
    if (url.toLowerCase() !== `https://github.com/${full}.git`) throw new Error(`Refused: the mirror's origin ${url} is not ${repo.fullName} on GitHub.`);
    return url;
  }
  if (!url.startsWith('/') || url.includes('\n')) throw new Error(`Refused: away from the real data home the city pushes only to a local stand-in, not ${url}.`);
  return url;
}

/** A local stand-in remote (tests, the sample), never GitHub. */
function isLocal(url: string): boolean {
  return url.startsWith('/') && !url.includes('\n');
}

/**
 * The config of every city push: hooks, fsmonitor and the global attributes
 * file off, no submodule pushes, and only gh answering for credentials (the
 * helper list is emptied first). The file protocol only for a local stand-in.
 */
export function pushFlags(url: string): string[] {
  return [
    ...ENGINE_GIT_FLAGS,
    ...SAFE,
    ...(isLocal(url) ? ['-c', 'protocol.file.allow=always'] : []),
    '-c',
    'push.recurseSubmodules=no',
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
  ];
}

/**
 * The whole environment of a city push, built from nothing (no GIT_* of the
 * engine's, no SSH command, no config parameters): no global or system git
 * config, no prompt. HOME is his, so gh finds its own login.
 */
function pushEnv(): Record<string, string> {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = '';
  }
  return {
    PATH: SYSTEM_PATH.join(':'),
    HOME: homedir(),
    LANG: 'en_US.UTF-8',
    ...(user ? { USER: user, LOGNAME: user } : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
  };
}

type PushResult = { ok: true } | { ok: false; rejected: boolean; detail: string };

/**
 * Pushes refspecs from the ship clone by sha, through the runner with an
 * environment built from nothing and pushFlags (gh as the only credential
 * helper), and an explicit git dir. Refuses, before
 * git runs, any force flag, any `+` refspec, and any destination other than
 * those `allowed` names. A deletion is allowed only for the city's own
 * `refs/heads/palimpsest/` branches.
 */
async function push(ship: string, runRoot: string, url: string, refspecs: string[], allowed: string[], o: { del?: boolean } = {}): Promise<PushResult> {
  // The layout and the recorded config hash are checked before git reads the clone at all.
  await gitOk(ship, ['rev-parse', '--git-dir']);
  for (const spec of refspecs) {
    if (spec.startsWith('+') || spec.startsWith('-')) throw new Error(`Refused push refspec ${spec}`);
    const [src, dst] = spec.split(':');
    if (dst === undefined || !allowed.includes(dst)) throw new Error(`Refused push to ${dst ?? spec}`);
    if (o.del ? src !== '' || !/^refs\/heads\/palimpsest\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dst) : !SHA.test(src)) throw new Error(`Refused push refspec ${spec}`);
  }
  const argv = [
    ...pushFlags(url),
    `--git-dir=${join(realpathSync.native(ship), '.git')}`,
    'push',
    '--no-verify',
    '--porcelain',
    url,
    ...refspecs,
  ];
  for (const a of argv) if (FORCE_FLAGS.has(a)) throw new Error(`Refused push flag ${a}`);
  const r = await getRunner()('git', argv, { cwd: runRoot, timeoutMs: PUSH_TIMEOUT_MS, env: pushEnv() });
  if (r.code === 0) return { ok: true };
  const text = `${r.stdout}\n${r.stderr}`;
  const rejected = /\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/.test(text);
  return { ok: false, rejected, detail: text.trim().split('\n').slice(-4).join(' ').slice(0, 500) };
}

/** Deletes the city's own branch on the remote, best effort. */
async function deleteCityBranch(ship: string, runRoot: string, url: string, branch: string, log: (t: string) => void): Promise<void> {
  const ref = `refs/heads/${branch}`;
  try {
    const r = await push(ship, runRoot, url, [`:${ref}`], [ref], { del: true });
    log(r.ok ? `deleted the city's branch ${branch}` : `could not delete ${branch}: ${r.detail}`);
  } catch (err) {
    log(`could not delete ${branch}: ${errText(err)}`);
  }
}

/**
 * Pushes `headSha` to the city's branch. A leftover branch of an earlier
 * attempt (the push is rejected) is deleted and pushed again only when no
 * open PR comes from it.
 */
async function pushBranch(ship: string, r: Run, repo: Repo, url: string, branch: string, log: (t: string) => void, stop: () => void): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const runRoot = runRootOf(r);
  let res = await push(ship, runRoot, url, [`${r.headSha}:${ref}`], [ref]);
  if (!res.ok && res.rejected) {
    const open = await openPRsFrom(repo.fullName, branch);
    if (open.length) throw new Error(`${branch} already has an open PR (#${open[0]}): nothing ships.`);
    log(`${branch} was left by an earlier attempt with no open PR: it is replaced`);
    stop();
    await deleteCityBranch(ship, runRoot, url, branch, log);
    stop();
    res = await push(ship, runRoot, url, [`${r.headSha}:${ref}`], [ref]);
  }
  if (!res.ok) throw new Error(`The push of ${branch} failed: ${res.detail}`);
}

// ---------------------------------------------------------------- floors

function sizeFor(lines: number): FloorSize {
  if (lines < 50) return 'small';
  if (lines < 400) return 'medium';
  return 'large';
}

/** The repo's district tower id (the earned floors stand on its founding tower). */
export function repoTowerId(fullName: string): string {
  return `${fullName}#founding`;
}

export function repoFloorId(fullName: string, jobId: string): string {
  return `${fullName}#job-${jobId}`;
}

export function agentFloorId(agentId: string, jobId: string): string {
  return `agent:${agentId}#job-${jobId}`;
}

function floorOf(r: Run, job: Job, o: { id: string; kind: Floor['kind']; refs: string[]; url: string | null; lines: number; state: 'waiting' | 'lit' | 'scar'; title?: string; at?: string }): Floor {
  const a = storedAgent(r.agentId);
  let era: Floor['era'] = 'stone';
  try {
    if (a) era = eraFor(a);
  } catch {
    // an unreadable ledger leaves the floor at stone
  }
  return {
    id: o.id,
    repo: r.repo,
    kind: o.kind,
    refs: o.refs,
    title: o.title ?? job.title,
    at: o.at ?? iso(),
    era,
    size: sizeFor(o.lines),
    lines: o.lines,
    claude: r.model.startsWith('claude'),
    founding: false,
    url: o.url,
    earned: { jobId: job.id, runId: r.id, agentId: r.agentId, firmId: r.firmId, state: o.state, reverted: false },
  };
}

/** Lays a floor once: a floor of that id already laid is updated in place. */
function lay(towerId: string, floor: Floor): Floor {
  const had = earnedFloors(towerId).some((f) => f.id === floor.id);
  const laid = had ? (updateEarnedFloor(floor.id, floor) as Floor) : layEarnedFloor(towerId, floor);
  record('floor.laid', { jobId: floor.earned?.jobId, runId: floor.earned?.runId, towerId, floor: laid, size: laid.size });
  emit('floor.laid', { towerId, floor: laid });
  return laid;
}

/** The job's floor on the repo tower and on the agent's own tower. */
function layJobFloors(r: Run, job: Job, o: Omit<Parameters<typeof floorOf>[2], 'id'>): Floor {
  const floor = lay(repoTowerId(r.repo), floorOf(r, job, { ...o, id: repoFloorId(r.repo, job.id) }));
  lay(agentTowerId(r.agentId), floorOf(r, job, { ...o, id: agentFloorId(r.agentId, job.id) }));
  if (o.state === 'lit') {
    for (const [towerId, id] of [[repoTowerId(r.repo), floor.id], [agentTowerId(r.agentId), agentFloorId(r.agentId, job.id)]]) {
      record('floor.lit', { jobId: job.id, runId: r.id, towerId, floorId: id });
      emit('floor.lit', { towerId, floorId: id });
    }
  }
  return floor;
}

/** Lights the job's waiting floors (a merged PR). */
function lightFloors(r: Run, jobId: string, at: string): void {
  for (const [towerId, id] of [[repoTowerId(r.repo), repoFloorId(r.repo, jobId)], [agentTowerId(r.agentId), agentFloorId(r.agentId, jobId)]]) {
    const f = earnedFloors(towerId).find((x) => x.id === id);
    if (!f?.earned) continue;
    const lit = updateEarnedFloor(id, { at, earned: { ...f.earned, state: 'lit' } });
    record('floor.lit', { jobId, runId: r.id, towerId, floorId: id, floor: lit });
    emit('floor.lit', { towerId, floorId: id, floor: lit });
  }
}

/** Removes the job's waiting floors (a PR closed without a merge): no scar. */
function removeFloors(r: Run, jobId: string): void {
  for (const [towerId, id] of [[repoTowerId(r.repo), repoFloorId(r.repo, jobId)], [agentTowerId(r.agentId), agentFloorId(r.agentId, jobId)]]) {
    if (!earnedFloors(towerId).some((x) => x.id === id)) continue;
    removeEarnedFloor(id);
    record('floor.removed', { jobId, runId: r.id, towerId, floorId: id });
    emit('floor.removed', { towerId, floorId: id });
  }
}

/**
 * A failed inspection's scar (ruling 7): on the repo's tower only, never on
 * the agent's. Its id names the run, so a job that fails twice leaves two
 * scars and a later merge of it still lays its own floor.
 */
export function layScar(r: Run, job: Job, lines = 0): Floor {
  const towerId = repoTowerId(r.repo);
  const floor = floorOf(r, job, {
    id: `${r.repo}#scar-${r.id}`,
    kind: 'commits',
    refs: [r.headSha ? r.headSha.slice(0, 7) : r.id],
    url: null,
    lines,
    state: 'scar',
    title: `Failed inspection: ${job.title}`,
  });
  const laid = earnedFloors(towerId).some((f) => f.id === floor.id) ? (updateEarnedFloor(floor.id, floor) as Floor) : layEarnedFloor(towerId, floor);
  record('floor.scarred', { jobId: job.id, runId: r.id, towerId, floor: laid, size: laid.size });
  emit('floor.scarred', { towerId, floor: laid });
  return laid;
}

// ---------------------------------------------------------------- the PR body

function cell(s: string): string {
  return publicSummary(s).replace(/\|/g, '\\|').slice(0, 160);
}

/** The PR body: the job, the bid's plan (quoted as data), the inspection table and where the ledger is. */
export function prBody(r: Run, job: Job, inspection: Inspection, note: string | null = null): string {
  const plan = bidById(r.bidId)?.plan ?? '';
  const planLines = plan
    .split('\n')
    .map((l) => publicSummary(l))
    .filter(Boolean)
    .slice(0, 40)
    .map((l) => `> ${l}`);
  const rows = inspection.checks.map((c: CheckResult) => `| ${c.name} | ${c.status} | ${cell(c.detail)} |`);
  return [
    `Palimpsest job ${job.id}${job.issue ? `\n\nCloses #${job.issue}` : ''}`,
    note ? `Note: ${publicSummary(note)}` : null,
    '## Plan',
    planLines.length ? `The winning bid's plan, quoted as written:\n\n${planLines.join('\n')}` : 'No plan was recorded with the bid.',
    '## Inspection',
    `${publicSummary(inspectionSummary(inspection))}`,
    ['| Check | State | Detail |', '| :- | :- | :- |', ...rows].join('\n'),
    '## Ledger',
    `Run ${r.id} for job ${job.id} is recorded in the Palimpsest ledger on the machine that ran it (run page /api/runs/${r.id}, job page /api/jobs/${job.id}).`,
    '[palimpsest]',
  ]
    .filter((x): x is string => x !== null)
    .join('\n\n');
}

// ---------------------------------------------------------------- shipping

class Fallback {
  constructor(readonly why: string) {}
}

/**
 * Ships a run whose inspection passed. Returns the run as it stands after:
 * stage `waiting` with its PR, or ended (`merged` by a push, or `crashed`
 * after two rejected pushes, its job back on the board with no scar).
 * Throws, writing nothing more, when a gate does not hold.
 */
export async function ship(r: Run, job: Job, repoIn: Repo, inspection: Inspection, signal: AbortSignal, ctx: ShipContext = {}): Promise<Run> {
  const runRoot = runRootOf(r);
  const runLog = ctx.log ?? fileLog(runRoot);
  const log = (text: string) => runLog({ at: iso(), kind: 'engine', text: `[shipping] ${text}` });
  const stop = () => {
    if (signal.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Shipping was stopped.'));
    if (existsSync(paths().stop)) throw new Error('The stop file is set: nothing ships.');
  };

  // The gates, before anything is written.
  stop();
  if (inspection.runId !== r.id || inspection.jobId !== job.id) throw new Error('The inspection is not of this run.');
  if (!inspection.passed || inspection.inconclusive || !canOpenPR(inspection.checks)) throw new Error('Nothing ships without a passed inspection.');
  if (!JOB_ID.test(job.id)) throw new Error(`Bad job id ${job.id}`);
  const branch = `palimpsest/${job.id}`;
  if (r.branch !== branch) throw new Error(`The run's branch ${r.branch} is not ${branch}.`);
  const repo = getRepo(repoIn.fullName) ?? repoIn;
  if (repo.halted) throw new Error(`The market on ${repo.fullName} is halted: nothing ships.`);
  const base = r.baseSha;
  const head = r.headSha;
  if (!base || !head || !SHA.test(base) || !SHA.test(head)) throw new Error('The run has no engine commit to ship.');

  const shipDir = await shipClone(r, { repo });
  await checkTrailers(shipDir, base, head, job.id);
  const lines = await changedLines(shipDir, base, head);
  const url = await pushTarget(repo);

  // 1. The city's branch, at exactly the inspected sha.
  stop();
  await pushBranch(shipDir, r, repo, url, branch, log, stop);
  log(`pushed ${head.slice(0, 7)} to ${branch}`);

  // 2. Push mode, only past every gate (ruling 23: no push mode while a test or build command is missing).
  const checks = repo.checks;
  const pushGate = repo.pushMode && inspection.pushable && canPush(inspection.checks) && !!checks?.test && !!checks?.build;
  let note: string | null = null;
  if (repo.pushMode && !pushGate) {
    note = !checks?.test || !checks?.build ? 'push mode waits for a test and a build command; this change goes up as a PR' : 'the inspection was not clean enough to push; this change goes up as a PR';
    log(note);
  }
  if (pushGate) {
    const out = await pushMode(r, job, repo, url, lines, runLog, log, stop, signal, ctx);
    if (!(out instanceof Fallback)) return out;
    note = out.why;
    log(`${out.why}; this change goes up as a PR`);
  }

  // 3. PR mode.
  stop();
  let pr: { number: number; url: string };
  try {
    pr = await createPR(repo.fullName, { head: branch, base: repo.defaultBranch, title: job.title, body: prBody(r, job, inspection, note) });
  } catch (err) {
    await deleteCityBranch(shipDir, runRoot, url, branch, log);
    throw err;
  }
  const at = iso();
  record('pr.opened', { runId: r.id, jobId: job.id, repo: repo.fullName, number: pr.number, url: pr.url, branch, headSha: head, at });
  const floor = layJobFloors(r, job, { kind: 'pr', refs: [`#${pr.number}`], url: pr.url, lines, state: 'waiting', at });
  transition(storedJob(job.id) ?? job, 'waiting', { floorId: floor.id });
  log(`opened ${pr.url}`);
  return { ...r, prNumber: pr.number, prUrl: pr.url, stage: 'waiting' };
}

type Merged = Run;

async function pushMode(
  r: Run,
  job: Job,
  repo: Repo,
  url: string,
  lines: number,
  runLog: (line: RunLogLine) => void,
  log: (t: string) => void,
  stop: () => void,
  signal: AbortSignal,
  ctx: ShipContext,
): Promise<Merged | Fallback> {
  const runRoot = runRootOf(r);
  const head = r.headSha as string;
  const def = repo.defaultBranch;
  const target = `refs/heads/${def}`;
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
    stop();
    // The newest default branch, then a fresh clone of it: the inspected clone's tree was written by head code.
    await syncMirror(repo.fullName);
    const ship = await shipClone(r, { fresh: true, repo });
    const fmt = await engineGit(ship, ['check-ref-format', target]);
    if (fmt.code !== 0 || def.startsWith('-')) throw new Error(`Bad default branch ${def}`);
    const tip = await gitOk(ship, ['rev-parse', '--verify', `refs/remotes/origin/${def}^{commit}`]);
    await gitOk(ship, [...SAFE, 'checkout', '--quiet', '--detach', tip]);
    const msg = `Merge ${`palimpsest/${job.id}`}: ${job.title.replace(/\s+/g, ' ').trim().slice(0, 200)}\n\nPalimpsest-Job: ${job.id}\n`;
    const merge = await engineGit(ship, [...SAFE, ...AUTHOR, 'merge', '--quiet', '--no-ff', '--no-verify', '--no-edit', '-m', msg, head]);
    if (merge.code !== 0) {
      await engineGit(ship, ['merge', '--abort']);
      return new Fallback(`the change does not merge cleanly into ${def}`);
    }
    const mergeSha = await gitOk(ship, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const parents = (await gitOk(ship, ['rev-list', '--parents', '-n', '1', mergeSha])).split(' ');
    if (parents.length !== 3 || parents[1] !== tip || parents[2] !== head) throw new Error('The merge commit is not the default branch plus the inspected change.');
    record('run.note', { runId: r.id, jobId: job.id, repo: repo.fullName, note: `merge ${mergeSha} recorded for push mode`, mergeSha, at: iso() });
    log(`merged ${head.slice(0, 7)} into ${def} at ${mergeSha.slice(0, 7)}; rechecking`);

    // The recheck: install (registries only), then the test and the build (nothing reachable), under the tool profile.
    await (ctx.reap ?? reapRun)(runRoot);
    stop();
    wipeScratch(runRoot);
    const rctx: RunContext = { runId: r.id, runRoot, dir: ship, log: runLog, signal, side: 'head', ...(ctx.egress ? { egress: ctx.egress } : {}) };
    const install = await (ctx.installDeps ?? defaultInstallDeps)(rctx, repo);
    ctx.egress?.setStage('checks', []);
    record('check.done', { runId: r.id, jobId: job.id, check: install, recheck: true });
    stop();
    if (install.status === 'fail') return new Fallback(`the install failed after the merge with ${def}`);
    for (const name of ['test', 'build'] as const) {
      const c = await recheck(rctx, name, repo.checks?.[name] as string);
      record('check.done', { runId: r.id, jobId: job.id, check: c, recheck: true });
      stop();
      if (c.status !== 'pass') return new Fallback(`the ${name} failed after the merge with ${def}`);
    }

    // HEAD must still be the merge the engine made (a check must not have moved it).
    const now = await engineGit(ship, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (now.code !== 0 || now.stdout.trim() !== mergeSha) {
      await deleteCityBranch(ship, runRoot, url, `palimpsest/${job.id}`, log);
      throw new Error(`HEAD in the ship clone moved from the recorded merge ${mergeSha.slice(0, 7)} during the recheck: nothing is pushed.`);
    }

    stop();
    const res = await push(ship, runRoot, url, [`${mergeSha}:${target}`], [target]);
    if (res.ok) {
      const at = iso();
      record('pushed', { runId: r.id, jobId: job.id, repo: repo.fullName, branch: def, mergeSha, headSha: head, at });
      const floor = layJobFloors(r, job, { kind: 'commits', refs: [mergeSha.slice(0, 7)], url: `https://github.com/${repo.fullName}/commit/${mergeSha}`, lines, state: 'lit', at });
      transition(storedJob(job.id) ?? job, 'merged', { floorId: floor.id }, { summary: r.summary ?? undefined });
      log(`pushed ${mergeSha.slice(0, 7)} to ${def}`);
      // The default branch holds the change now: the city's branch has done its work.
      await deleteCityBranch(ship, runRoot, url, `palimpsest/${job.id}`, log);
      return { ...r, mergeSha, stage: 'done', outcome: 'merged', endedReason: null };
    }
    if (!res.rejected) throw new Error(`The push to ${def} failed: ${res.detail}`);
    log(`the push to ${def} was rejected (try ${attempt} of ${PUSH_TRIES}): ${res.detail}`);
  }

  // Rejected twice: the job goes back on the board, no scar, no attempt spent, the city's branch removed.
  const reason = `The push to ${def} was rejected twice; the job is back on the board.`;
  const ship = join(runRoot, 'ship');
  if (existsSync(ship)) await deleteCityBranch(ship, runRoot, url, `palimpsest/${job.id}`, log);
  transition(storedJob(job.id) ?? job, 'open', { runId: null, awardedBid: null, bidsCloseAt: null });
  return { ...r, stage: 'done', outcome: 'crashed', endedReason: reason };
}

/** A push-mode recheck, its log kept apart from the inspection's own log of that check. */
async function recheck(ctx: RunContext, name: Extract<CheckName, 'test' | 'build'>, command: string): Promise<CheckResult> {
  const dir = join(ctx.runRoot, 'inspection');
  const kept = join(dir, `${name}.log`);
  const aside = join(dir, `${name}.inspection.log`);
  const had = existsSync(kept);
  if (had) renameSync(kept, aside);
  try {
    const c = await runCheck(ctx, name, command);
    const out = join(dir, `recheck-${name}.log`);
    if (existsSync(kept)) {
      rmSync(out, { force: true });
      renameSync(kept, out);
    }
    return { ...c, logPath: c.logPath ? out : null };
  } finally {
    if (had) renameSync(aside, kept);
  }
}

// ---------------------------------------------------------------- the PR poll

const lastPoll = new Map<string, number>();
const lastWatch = new Map<string, number>();

/** Forgets the poll and watch pacing (tests). */
export function resetShipping(): void {
  lastPoll.clear();
  lastWatch.clear();
}

/** Moves a job left waiting (or halted while waiting, ruling 30) to `to`. */
function settleWaitingJob(jobId: string, to: 'merged' | 'closed', patch: Partial<Job>, note: { prUrl?: string; summary?: string }): void {
  let j = storedJob(jobId);
  if (!j) return;
  if (j.status === 'halted' && j.haltedFrom === 'waiting') j = transition(j, 'waiting');
  if (j.status === 'waiting') transition(j, to, patch, note);
}

/**
 * The commit that brought the run's change into the default branch, when gh
 * names none: the newest commit whose parents include the head the city
 * pushed (a merge), the head itself (a fast-forward), or one carrying the
 * job's trailer (a squash or a rebase keeps the commit messages).
 */
async function findMergeSha(r: Run, repo: Repo, o: { sync?: boolean } = {}): Promise<string | null> {
  const head = r.headSha;
  if (!head) return null;
  const trailer = new RegExp(`^Palimpsest-Job: ${r.jobId.replace(/[.]/g, '\\.')}$`, 'm');
  const commits = await recentCommits(repo.fullName, repo.defaultBranch, '', { sync: o.sync, limit: 2000 });
  const hit = commits.find((c) => c.sha === head || c.parents.includes(head) || trailer.test(c.body));
  return hit?.sha ?? null;
}

async function merged(r: Run, s: PRState): Promise<void> {
  const repo = getRepo(r.repo);
  const def = repo?.defaultBranch ?? 'main';
  // What merged must be what the city pushed, into the default branch; otherwise it is not the city's work to pay for.
  if (s.headRefOid !== r.headSha || s.baseRefName !== def) {
    const changes = { headRefOid: s.headRefOid, baseRefName: s.baseRefName, mergeSha: s.mergeCommit };
    const why = s.headRefOid !== r.headSha
      ? `merged with changes: the PR head was ${s.headRefOid?.slice(0, 7) ?? 'unknown'}, not the inspected ${r.headSha?.slice(0, 7)}`
      : `merged with changes: merged into ${s.baseRefName ?? 'an unknown branch'}, not ${def}`;
    removeFloors(r, r.jobId);
    finishWaitingRun(r.id, 'closed', `The PR was ${why}.`, { mergedWithChanges: changes });
    record('run.note', { runId: r.id, jobId: r.jobId, repo: r.repo, note: why, pr: r.prNumber, prUrl: r.prUrl, ...changes, at: iso() });
    settleWaitingJob(r.jobId, 'closed', { floorId: null }, {});
    return;
  }
  let mergeSha = s.mergeCommit;
  if (!mergeSha && repo) {
    try {
      mergeSha = await findMergeSha(r, repo);
    } catch (err) {
      console.warn(`palimpsest: could not find the merge of ${r.repo}#${r.prNumber}: ${errText(err)}`);
    }
  }
  const at = s.mergedAt ?? iso();
  const floor = earnedFloors(repoTowerId(r.repo)).find((f) => f.id === repoFloorId(r.repo, r.jobId));
  record('merge.detected', { jobId: r.jobId, runId: r.id, repo: r.repo, pr: r.prNumber, prUrl: r.prUrl, mergeSha, mergedAt: at, size: floor?.size ?? null, at: iso() });
  lightFloors(r, r.jobId, at);
  finishWaitingRun(r.id, 'merged', null, { mergeSha });
  settleWaitingJob(r.jobId, 'merged', {}, { prUrl: r.prUrl ?? undefined, summary: r.summary ?? undefined });
}

function closed(r: Run): void {
  removeFloors(r, r.jobId);
  finishWaitingRun(r.id, 'closed', 'The PR was closed without a merge.');
  settleWaitingJob(r.jobId, 'closed', { floorId: null }, {});
}

/**
 * Asks GitHub about every run waiting on its PR, each at most every five
 * minutes: a merge records `merge.detected`, lights the floors and resolves
 * the job (paid through `job.changed` to `merged`); a close removes the
 * waiting floors and closes the job, with no scar and no payment. A job
 * whose issue closed meanwhile is settled here too.
 */
export async function pollPRs(now: number = Date.now()): Promise<void> {
  const live = new Set(liveRunIds());
  for (const r of listRuns()) {
    if (r.stage !== 'waiting' || r.outcome !== null || !r.prNumber || live.has(r.id)) continue;
    if (now - (lastPoll.get(r.id) ?? -Infinity) < PR_POLL_MS) continue;
    lastPoll.set(r.id, now);
    try {
      const s = await prState(r.repo, r.prNumber);
      if (s.state === 'MERGED') await merged(r, s);
      else if (s.state === 'CLOSED') closed(r);
    } catch (err) {
      console.warn(`palimpsest: could not read ${r.repo}#${r.prNumber}: ${errText(err)}`);
    }
  }
}

// ---------------------------------------------------------------- the revert watch

/** The subjects a revert of a floor's PR or merge can carry, against the exact title the city sent. */
function revertSubject(subject: string, title: string, pr: number | null): boolean {
  const t = prTitle(title);
  const plain = `Revert "${t}"`;
  return subject === plain || subject.startsWith(`${plain} (#`) || (pr !== null && (subject === `Revert "${t} (#${pr})"` || subject.startsWith(`Revert "${t} (#${pr})" (#`)));
}

/**
 * Reads, every thirty minutes per repo with lit floors, the default branch
 * after each city merge (by ancestry, `<mergeSha>..<branch>`, never by
 * date) for a revert of it: a commit whose body says `This reverts commit
 * <mergeSha>`, or whose subject is `Revert "<title>"` or GitHub's squash
 * form `Revert "<title> (#n)"`, against the exact title sent to GitHub. A
 * merge gh named no commit for is found in the history first. A hit marks
 * the floor (and the agent's) reverted, records `merge.reverted` and halts
 * the repo until he clears it.
 */
export async function watchReverts(now: number = Date.now()): Promise<void> {
  for (const repo of listRepos()) {
    const lit = earnedFloors(repoTowerId(repo.fullName)).filter((f) => f.earned?.state === 'lit' && !f.earned.reverted);
    if (!lit.length) continue;
    if (now - (lastWatch.get(repo.fullName) ?? -Infinity) < REVERT_WATCH_MS) continue;
    lastWatch.set(repo.fullName, now);
    try {
      await syncMirror(repo.fullName);
    } catch (err) {
      console.warn(`palimpsest: could not read ${repo.fullName} for reverts: ${errText(err)}`);
      continue;
    }
    const hits: string[] = [];
    for (const f of lit) {
      const e = f.earned!;
      const r = storedRun(e.runId);
      if (!r) continue;
      let mergeSha = r.mergeSha && SHA.test(r.mergeSha) ? r.mergeSha : null;
      try {
        if (!mergeSha) {
          mergeSha = await findMergeSha(r, repo, { sync: false });
          if (mergeSha) updateRun(r.id, { mergeSha });
        }
        if (!mergeSha) continue;
        const after = await recentCommits(repo.fullName, repo.defaultBranch, mergeSha, { sync: false });
        const byBody = new RegExp(`This reverts commit ${mergeSha}\\b`);
        const hit = after.find((c) => byBody.test(c.body) || revertSubject(c.subject, f.title, r.prNumber));
        if (!hit) continue;
        for (const [towerId, id] of [[repoTowerId(repo.fullName), f.id], [agentTowerId(e.agentId), agentFloorId(e.agentId, e.jobId)]]) {
          const cur = earnedFloors(towerId).find((x) => x.id === id);
          if (cur?.earned) updateEarnedFloor(id, { earned: { ...cur.earned, reverted: true } });
        }
        const data = { jobId: e.jobId, runId: e.runId, repo: repo.fullName, floorId: f.id, mergeSha, revertSha: hit.sha, at: iso(now) };
        record('merge.reverted', data);
        emit('merge.reverted', data);
        hits.push(f.title);
      } catch (err) {
        console.warn(`palimpsest: could not read ${repo.fullName} after ${mergeSha?.slice(0, 7) ?? 'its merge'}: ${errText(err)}`);
      }
    }
    if (hits.length) haltRepo(repo.fullName, `A city merge was reverted: ${hits.join('; ').slice(0, 300)}`, iso(now));
  }
}
