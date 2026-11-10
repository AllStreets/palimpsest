/**
 * The runner and the scheduler (Task 13): what ties the market together.
 *
 * The scheduler ticks every 15 s. Every tick first checks the stop file
 * (the Settings switch writes the same file) and does nothing else while it
 * is set, so clearing it resumes the market on the next tick with no
 * restart. Otherwise one tick polls issues on every repo whose market is on
 * and that is not halted (each at most every five minutes), opens bidding on
 * open jobs, collects bids in the background, awards what is due, and
 * starts runs for awarded jobs while a work lease is granted and the repo
 * has no live run (ruling 7). Before any run starts, the sandbox membership
 * helper must build (the reaper's strict rule), else the market starts no
 * agent runs at all (fail closed).
 *
 * A run: `preparing` (run dir, egress proxy, the broker for Claude),
 * `installing` (egress stage `install`), `working` (egress stage `working`;
 * the agent's workflow shape decides the calls), commitAll and diffOf (each
 * after runQuiet), `inspecting` (egress stage `checks`), then `shipping`
 * or failed. The job moves to `running` only when `working` begins, so a
 * crash before that moves it `awarded > failed`.
 *
 * Kill paths: the stop file at every stage boundary and in a 2 s watcher
 * while a run is live; the watcher also reads the treasury, so a usage
 * reading that crosses the hard stop with nothing in flight is still
 * caught; the treasury's hard stop aborts every Claude lease; kill() and a
 * halt abort the run's lease. The lease's signal is the run's signal: it
 * ends the provider call, every broker command and every check. A killed
 * run leaves no scar and returns its job to `open` without spending an
 * attempt (ruling 16). The proxy and the broker close, the run root is
 * reaped and the lease released on every end.
 *
 * Model output (the bid's plan, the agent's own diff in a self-check) goes
 * back into prompts only as quoted data (quote.ts).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_ATTEMPTS } from '../../shared/market-rules.js';
import type {
  Agent,
  Bid,
  FloorSize,
  Inspection,
  Job,
  JobStatus,
  Repo,
  Run,
  RunOutcome,
  RunProgress,
  RunStage,
  SiteStage,
  SiteState,
  Tier,
} from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { getSpawner, type Spawned } from '../exec.js';
import { home, isRealDataHome, paths } from '../home.js';
import { record } from '../ledger.js';
import { getRepo, listRepos, updateRepoMarket } from '../repos.js';
import { getSettings } from '../settings.js';
import { chargesItself } from './anthropic-api.js';
import { award, bidById, collectBids, firmExamples, openBidding } from './bids.js';
import { forgetRun, startBroker, type Broker, type ToolStage } from './broker.js';
import {
  abortAllLeases,
  abortLease,
  acquire,
  charge,
  creditsFor,
  liveLeaseCount,
  onHardStop,
  registerKeepAwake,
  treasury,
  unattended,
  type Lease,
} from './budget.js';
import { hostsFor, startEgress, type Egress } from './egress.js';
import { agent as storedAgent } from './firms.js';
import { inspect as guildInspect, inspectionSummary, type InspectContext } from '../guild/inspect.js';
import { installDeps as defaultInstallDeps, type InstallDeps, type RunContext } from './install.js';
import { attachRun, setInconclusive, job as storedJob, listJobs, pollJobs as defaultPollJobs, transition, type PollDeps } from './jobs.js';
import type { Provider, RunLogLine, Usage, WorkInput } from './provider.js';
import { providerFor } from './providers.js';
import { quoteAsData } from './quote.js';
import { reapRun, runQuiet } from './reaper.js';
import { sandboxOff } from './sandbox.js';
import { sandboxCheckBin } from './sandbox-check.js';
import { commitAll, diffOf, removeRunDir, createRunDir } from './worktree.js';

// ---------------------------------------------------------------- constants

const MIN_MS = 60_000;
/** How often the scheduler ticks. */
export const TICK_MS = 15_000;
/** How often the watcher checks the stop file and the treasury while a run is live. */
export const WATCH_MS = 2_000;
/** How often each repo's issues are polled. */
export const POLL_MS = 5 * MIN_MS;
/** run.log events per second per run; the rest go to log.jsonl only. */
export const LOG_PER_SECOND = 10;
/** Wall time of a run's work, by backend. */
export const MAX_MINUTES = { local: 25, claude: 40, api: 40 } as const;
/** A run may spend this many times its bid price. */
export const CREDIT_CAP_FACTOR = 1.5;
/** Turns the self-check pass may take at most. */
export const SELF_CHECK_TURNS = 10;
/** The longest diff quoted into a self-check prompt. */
const SELF_CHECK_DIFF_MAX = 20_000;

/** Minutes a run may live beyond its work cap (install, commit, inspection, shipping) before the watcher ends it. */
export const RUN_EXTRA_MINUTES = 90;

export const STOP_REASON = 'The stop file is set.';
/** Inconclusive inspections a job may have in a row before it leaves the board (controller ruling, Task 15). */
export const MAX_INCONCLUSIVE = 2;
export const NEEDS_REVIEWER = 'needs a reviewer: too large or no reviewer available';
export const SHUTDOWN_REASON = 'The engine is shutting down.';
export const INTERRUPTED_RUN = 'The engine stopped during the run.';
export const HELPER_MISSING =
  'The sandbox membership helper could not be built (is /usr/bin/cc installed?), so the market starts no agent runs.';

/** Run stages in which a run is live (ruling 7: one per repo). */
const LIVE_STAGES: RunStage[] = ['preparing', 'installing', 'working', 'inspecting', 'shipping'];
/** Job statuses that belong to a live run. */
const LIVE_JOB: JobStatus[] = ['awarded', 'running', 'inspecting', 'shipping'];
/** Job statuses a halt stops. */
const HALTABLE: JobStatus[] = ['open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting'];

const TIER_SIZE: Record<Tier, FloorSize> = { low: 'small', normal: 'medium', high: 'large' };
const SITE_OF: Record<RunStage, SiteStage> = {
  preparing: 'crane',
  installing: 'crane',
  working: 'framing',
  inspecting: 'inspecting',
  shipping: 'curing',
  waiting: 'waiting',
  done: 'teardown',
};

// ---------------------------------------------------------------- dependencies

/** A run's change: the patch, its files, its changed lines, its hash and where the patch is kept. */
export interface RunDiff {
  patch: string;
  files: string[];
  lines: number;
  sha256: string;
  patchPath: string;
}

/**
 * Task 15: the inspection, under the run's work lease (its signal aborts
 * every check). `ctx` carries the run's log and its egress proxy (a
 * reinstall opens it to the registries, then closes it again).
 */
export type InspectFn = (run: Run, job: Job, repo: Repo, diff: RunDiff, lease: Lease, ctx?: InspectContext) => Promise<Inspection>;
/** Task 16: shipping. Returns the run as it stands after (stage `waiting`, or ended with an outcome). */
export type ShipFn = (run: Run, job: Job, repo: Repo, inspection: Inspection, signal: AbortSignal) => Promise<Run>;

export interface SchedulerDeps {
  now?: () => number;
  installDeps: InstallDeps;
  inspect: InspectFn;
  ship: ShipFn;
  pollJobs?: (repo: Repo, deps: PollDeps) => Promise<Job[]>;
  /** Task 14: the baseline at the run's base commit, computed when missing; it stops when the run's signal aborts. */
  baseline?: (repo: Repo, sha: string, opts: { signal: AbortSignal; log: (line: RunLogLine) => void }) => Promise<unknown>;
  /** Task 16: the open PRs and the revert watch, called every tick (they keep their own pace). */
  pollPRs?: (now: number) => Promise<void>;
  watchReverts?: (now: number) => Promise<void>;
  /** Tasks 17 and 18: the daily tick, called once a local day has ended, with that day (YYYY-MM-DD). */
  daily?: (day: string) => Promise<void>;
  /** Kills the run's strays and confirms none is left (default runQuiet). */
  quiet?: (runRoot: string) => Promise<void>;
  /** Kills whatever of the run is left at its end (default reapRun). */
  reap?: (runRoot: string) => Promise<number[]>;
  /** Why no agent run may start, or null (default: the sandbox membership helper must build). */
  preflight?: () => Promise<string | null>;
  /** The watcher's interval; 0 starts none (tests call watch()). Default WATCH_MS. */
  watchMs?: number;
  /** A run's whole wall time; past it the watcher ends the run `capped`. Default its work cap plus RUN_EXTRA_MINUTES. */
  runWallMs?: number;
}

export interface Scheduler {
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  /** Stops ticking, kills every live run and waits until each has closed, been reaped and released. */
  stop(): Promise<void>;
  /** Resolves once no tick, bid collection or run is in flight. */
  idle(): Promise<void>;
  /** One pass of the watcher: the stop file, the treasury and keep-awake. */
  watch(): void;
}

type Optional = 'baseline' | 'pollPRs' | 'watchReverts' | 'daily' | 'runWallMs';
type Config = Required<Omit<SchedulerDeps, Optional>> & Pick<SchedulerDeps, Optional>;

const notWired = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not wired into the scheduler yet`);
};

let preflightOk: Promise<string | null> | null = null;

/** The sandbox membership helper must build, and the sandbox may be off only away from the real home. */
async function defaultPreflight(): Promise<string | null> {
  if (sandboxOff()) return isRealDataHome(home()) ? 'The sandbox cannot be off on the real data home.' : null;
  if (!preflightOk) {
    preflightOk = sandboxCheckBin().then(
      (bin) => (bin ? null : HELPER_MISSING),
      () => HELPER_MISSING,
    );
  }
  const r = await preflightOk;
  if (r) preflightOk = null; // try again next time: the tools may have been installed since
  return r;
}

function defaults(): Config {
  return {
    now: () => Date.now(),
    installDeps: defaultInstallDeps,
    // Called through a wrapper: inspect.ts imports this module too (haltRepo), so the binding is read at call time.
    inspect: (...a) => guildInspect(...a),
    ship: notWired('Shipping'),
    pollJobs: defaultPollJobs,
    quiet: runQuiet,
    reap: reapRun,
    preflight: defaultPreflight,
    watchMs: WATCH_MS,
  };
}

let config: Config = defaults();

// ---------------------------------------------------------------- storage

function saveRun(r: Run): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)')
    .run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
}

export function run(id: string): Run | null {
  const row = openDb().prepare('SELECT json FROM runs WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Run) : null;
}

/** Runs in the order they started, optionally for one job or repo. */
export function listRuns(f: { jobId?: string; repo?: string } = {}): Run[] {
  const rows = openDb().prepare('SELECT json FROM runs').all() as Array<{ json: string }>;
  return rows
    .map((r) => JSON.parse(r.json) as Run)
    .filter((r) => (f.jobId === undefined || r.jobId === f.jobId) && (f.repo === undefined || r.repo === f.repo))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- live runs

class Killed extends Error {}

interface LiveRun {
  run: Run;
  job: Job;
  bid: Bid;
  agent: Agent;
  repo: Repo;
  lease: Lease;
  runRoot: string;
  egress: Egress | null;
  broker: Broker | null;
  toolStage: ToolStage;
  killReason: string | null;
  logWindow: { start: number; count: number };
  site: SiteState;
  summary: string | null;
  /** Wall-clock ms past which the watcher ends the run. */
  deadlineAt: number;
  deadlineHit: boolean;
}

/** An error in the city's own work (git, disk, the reaper), never blamed on the agent. */
class CityError extends Error {}

const live = new Map<string, LiveRun>();
const pending = new Set<Promise<unknown>>();
/** Repos a startRun call has claimed but not yet made live, so two calls never start two runs on one repo. */
const reserved = new Set<string>();

function repoBusy(fullName: string): boolean {
  return reserved.has(fullName) || [...live.values()].some((x) => x.run.repo === fullName);
}

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}

/** Ids of the runs live now. */
export function liveRunIds(): string[] {
  return [...live.keys()];
}

function iso(ms: number = config.now()): string {
  return new Date(ms).toISOString();
}

/** What a signal's reason says, in words for the run log and the job board. */
function reasonOf(st: LiveRun): string {
  if (st.killReason) return st.killReason;
  const r = st.lease.signal.reason;
  const msg = r instanceof Error ? r.message : String(r ?? '');
  if (msg === 'budget: hard') return 'The hard stop: a usage window reached the hard stop, so Claude work stopped.';
  if (msg === 'budget: stopped') return STOP_REASON;
  return msg || 'The run was stopped.';
}

/**
 * Aborts a live run: its provider call, its broker commands and its checks
 * end, and it ends `killed` (no scar, no attempt spent). False when the run
 * is not live.
 */
export function kill(runId: string, reason: string): boolean {
  const st = live.get(runId);
  if (!st) return false;
  if (!st.killReason && !st.lease.signal.aborted) st.killReason = reason;
  abortLease(st.lease, new Error(reason));
  return true;
}

/** Kills the live run of a job (pollJobs calls it when the issue closes). */
export async function killJob(jobId: string, reason = 'The issue was closed.'): Promise<void> {
  for (const st of live.values()) if (st.run.jobId === jobId) kill(st.run.id, reason);
}

function engineLog(st: LiveRun, text: string): void {
  logTo(st)({ at: new Date().toISOString(), kind: 'engine', text });
}

/** Every line goes to `<runRoot>/log.jsonl`; at most LOG_PER_SECOND a second also go out as `run.log`. */
function logTo(st: LiveRun): (line: RunLogLine) => void {
  return (line) => {
    try {
      appendFileSync(join(st.runRoot, 'log.jsonl'), JSON.stringify(line) + '\n');
    } catch {
      // A log write must never stop the run.
    }
    const t = Date.now();
    if (t - st.logWindow.start >= 1000) st.logWindow = { start: t, count: 0 };
    if (st.logWindow.count < LOG_PER_SECOND) {
      st.logWindow.count++;
      emit('run.log', { runId: st.run.id, line });
    }
  };
}

// ---------------------------------------------------------------- sites

function progressOf(st: LiveRun): number {
  switch (st.run.stage) {
    case 'preparing':
      return 0.05;
    case 'installing':
      return 0.1;
    case 'working': {
      const turns = st.run.progress.turns;
      const max = Math.max(1, st.agent.maxTurns);
      return Math.round((0.15 + 0.55 * Math.min(1, turns / max)) * 100) / 100;
    }
    case 'inspecting':
      return 0.8;
    case 'shipping':
      return 0.95;
    default:
      return 1;
  }
}

function updateSite(st: LiveRun, stage: SiteStage = SITE_OF[st.run.stage]): void {
  const progress = progressOf(st);
  if (st.site.stage === stage && st.site.progress === progress) return;
  st.site = { ...st.site, stage, progress, since: st.site.stage === stage ? st.site.since : iso() };
  emit('site.changed', { site: st.site });
}

/** The job sites of the city: every live run, and every run waiting on its PR. */
export function sites(): SiteState[] {
  const out = [...live.values()].map((st) => st.site);
  const rows = openDb().prepare("SELECT json FROM runs WHERE stage = 'waiting'").all() as Array<{ json: string }>;
  for (const row of rows) {
    const r = JSON.parse(row.json) as Run;
    if (r.outcome !== null || live.has(r.id)) continue;
    const j = storedJob(r.jobId);
    out.push({
      repo: r.repo,
      runId: r.id,
      jobId: r.jobId,
      agentId: r.agentId,
      firmId: r.firmId,
      stage: 'waiting',
      progress: 1,
      size: TIER_SIZE[j?.tier ?? 'normal'],
      since: r.endedAt ?? r.startedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------- keep-awake (ruling 27)

let caffeinate: Spawned | null = null;

export function keepAwakeState(): { on: boolean; held: boolean } {
  return { on: getSettings().keepAwake, held: caffeinate !== null };
}

/** Holds one `caffeinate -i -w <pid>` while keep-awake is on and any run or lease is live; lets it go otherwise. */
export function updateKeepAwake(): void {
  const want = getSettings().keepAwake && (live.size > 0 || liveLeaseCount() > 0);
  if (want && !caffeinate) {
    try {
      const child = getSpawner()('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { clearEnv: true, env: { PATH: '/usr/bin:/bin' } });
      caffeinate = child;
      void child.done.then(() => {
        if (caffeinate === child) caffeinate = null;
      });
    } catch (err) {
      console.warn(`palimpsest: keep-awake could not start caffeinate: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!want && caffeinate) {
    const child = caffeinate;
    caffeinate = null;
    child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------- the watcher

let watcher: NodeJS.Timeout | null = null;

/** One watcher pass: the stop file kills every live run; the treasury read catches a hard stop with nothing in flight. */
export function watchOnce(): void {
  if (existsSync(paths().stop)) for (const id of [...live.keys()]) kill(id, STOP_REASON);
  const t = Date.now();
  for (const st of [...live.values()]) {
    // A run already being stopped (the stop file, him, a halt) ends as that, never as a deadline.
    if (st.deadlineHit || st.lease.signal.aborted || t < st.deadlineAt) continue;
    st.deadlineHit = true;
    kill(st.run.id, `The run passed its wall deadline of ${Math.round(wallMsOf(st.agent) / MIN_MS)} minutes.`);
  }
  try {
    treasury(config.now());
  } catch (err) {
    console.warn(`palimpsest: the watcher could not read the treasury: ${err instanceof Error ? err.message : String(err)}`);
  }
  updateKeepAwake();
}

function syncWatcher(): void {
  const want = live.size > 0 && config.watchMs > 0;
  if (want && !watcher) {
    watcher = setInterval(watchOnce, config.watchMs);
    watcher.unref?.();
  } else if (!want && watcher) {
    clearInterval(watcher);
    watcher = null;
  }
}

// ---------------------------------------------------------------- jobs

/** Moves the run's job as its end says, when the job still belongs to this run. */
function settleJob(st: LiveRun | { run: Run }, how: 'reopen' | 'fail', exclude: boolean, summary?: string): void {
  const r = st.run;
  const cur = storedJob(r.jobId);
  if (!cur || cur.runId !== r.id || !LIVE_JOB.includes(cur.status)) return;
  const reopen = { runId: null, awardedBid: null, bidsCloseAt: null };
  try {
    if (how === 'reopen') {
      transition(cur, 'open', reopen);
      return;
    }
    const excludedFirms = exclude && !cur.excludedFirms.includes(r.firmId) ? [...cur.excludedFirms, r.firmId] : cur.excludedFirms;
    const failed = transition(cur, 'failed', { excludedFirms }, summary ? { summary } : {});
    if (failed.attempts < MAX_ATTEMPTS) {
      const open = transition(failed, 'open', reopen);
      // The repo was halted while this run finished (its own third failed inspection): the job waits halted too.
      if (getRepo(r.repo)?.halted) transition(open, 'halted');
    }
  } catch (err) {
    console.error(`palimpsest: run ${r.id} could not settle job ${r.jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- one run

function setStage(st: LiveRun, stage: RunStage): void {
  st.run = { ...st.run, stage };
  saveRun(st.run);
  record('run.stage', { runId: st.run.id, jobId: st.run.jobId, stage, at: iso() });
  emit('run.stage', { runId: st.run.id, stage });
  updateSite(st);
}

/** A stage boundary: the stop file and the signal are checked before the stage begins. */
function boundary(st: LiveRun, stage: RunStage): void {
  checkpoint(st);
  setStage(st, stage);
}

function checkpoint(st: LiveRun): void {
  if (existsSync(paths().stop)) kill(st.run.id, STOP_REASON);
  if (st.lease.signal.aborted) throw new Killed(reasonOf(st));
}

function end(st: LiveRun, outcome: RunOutcome, reason: string | null, o: { job: 'reopen' | 'fail' | 'none'; exclude?: boolean; scar?: boolean; summary?: string }): Run {
  st.run = { ...st.run, outcome, endedReason: reason, endedAt: iso(), stage: 'done', scar: !!o.scar, summary: st.summary };
  saveRun(st.run);
  record('run.ended', { runId: st.run.id, jobId: st.run.jobId, outcome, reason, summary: st.summary, run: st.run });
  emit('run.ended', { runId: st.run.id, outcome, reason });
  updateSite(st, o.scar ? 'scar' : outcome === 'merged' ? 'curing' : 'teardown');
  if (o.job !== 'none') settleJob(st, o.job, !!o.exclude, o.summary);
  engineLog(st, `run ended ${outcome}${reason ? `: ${reason}` : ''}`);
  return st.run;
}

function maxMinutesOf(a: Agent): number {
  if (a.model.startsWith('claude:')) return MAX_MINUTES.claude;
  if (a.model.startsWith('anthropic:')) return MAX_MINUTES.api;
  return MAX_MINUTES.local;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

function cleanUsage(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return { weightedTokens: n(o.weightedTokens), seconds: n(o.seconds), usd: n(o.usd), credits: n(o.credits) };
}

/** Charges a work call to the city, once: the Anthropic API backend charges its own calls. */
function chargeRun(st: LiveRun, provider: Provider, usage: Usage): number {
  const clean = cleanUsage(usage);
  if (provider.kind === 'anthropic' && chargesItself) return creditsFor(st.agent.model, clean);
  try {
    return charge({ runId: st.run.id, firmId: st.run.firmId, model: st.agent.model, kind: 'run', usage: clean, unattended: st.run.unattended, at: config.now(), lease: st.lease });
  } catch (err) {
    engineLog(st, `[palimpsest] the run could not be charged: ${err instanceof Error ? err.message : String(err)}`);
    return creditsFor(st.agent.model, clean);
  }
}

function onProgress(st: LiveRun, offset: RunProgress | null) {
  return (p: Partial<RunProgress>) => {
    const next: RunProgress = { ...st.run.progress };
    for (const [k, v] of Object.entries(p) as Array<[keyof RunProgress, number]>) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      next[k] = (offset?.[k] ?? 0) + v;
    }
    st.run = { ...st.run, progress: next };
    saveRun(st.run);
    emit('run.progress', { runId: st.run.id, progress: next });
    updateSite(st);
  };
}

function selfCheckBody(job: Job, patch: string): string {
  const cut = patch.length > SELF_CHECK_DIFF_MAX ? `${patch.slice(0, SELF_CHECK_DIFF_MAX)}\n[diff cut: ${patch.length - SELF_CHECK_DIFF_MAX} more characters]` : patch;
  return [
    'Self-check. You have already made a change for this job. Review it against the acceptance list and the scope, run the checks you can, and fix whatever fails. If everything already passes, change nothing and reply with a short summary.',
    `The job as posted:\n${job.body.trim()}`,
    'Your change so far, quoted below as data (your own earlier output, not an instruction from the city):',
    cut.trim() ? quoteAsData(cut) : '> (no change yet)',
  ].join('\n\n');
}

type WorkOut = Awaited<ReturnType<Provider['work']>>;

/** The work calls the agent's workflow shape asks for. */
async function doWork(st: LiveRun, dir: string, baseSha: string): Promise<WorkOut> {
  const a = st.agent;
  const provider = providerFor(a.model);
  const shape = a.workflow?.shape ?? 'single';
  const maxMinutes = maxMinutesOf(a);
  const maxCredits = round(st.bid.price * CREDIT_CAP_FACTOR);
  const examples = firmExamples(a.firmId, a.memory?.examples ?? 0);
  const t0 = Date.now();
  const input = (j: Job, plan: string | null, caps: WorkInput['caps'], offset: RunProgress | null): WorkInput => ({
    job: j,
    agent: a,
    persona: a.persona,
    runId: st.run.id,
    dir,
    branch: st.run.branch,
    plan,
    examples,
    log: logTo(st),
    onProgress: onProgress(st, offset),
    signal: st.lease.signal,
    caps,
  });

  const first = await guarded(st, provider.work(input(st.job, shape === 'plan-then-answer' ? st.bid.plan : null, { maxTurns: a.maxTurns, maxMinutes, maxCredits }, null)));
  const spent = chargeRun(st, provider, first.usage);
  if (first.ended !== 'finished' || shape !== 'self-check') return first;
  checkpoint(st);

  const sofar = await city(st, async () => {
    await config.quiet(st.runRoot);
    return diffOf(dir, baseSha);
  });
  const caps = {
    maxTurns: Math.max(1, Math.min(a.maxTurns, SELF_CHECK_TURNS)),
    maxMinutes: Math.max(1, Math.round((maxMinutes - (Date.now() - t0) / MIN_MS) * 100) / 100),
    maxCredits: round(Math.max(0, maxCredits - spent)),
  };
  if (caps.maxCredits <= 0) {
    engineLog(st, '[palimpsest] no credits left under the cap for the self-check; the first pass stands');
    return first;
  }
  engineLog(st, '[palimpsest] self-check: a second pass reviews the change against the acceptance list');
  const second = await guarded(st, provider.work(input({ ...st.job, body: selfCheckBody(st.job, sofar.patch) }, null, caps, { ...st.run.progress })));
  chargeRun(st, provider, second.usage);
  if (second.ended === 'finished') return { ...second, summary: second.summary || first.summary };
  if (second.ended === 'capped') {
    engineLog(st, `[palimpsest] the self-check reached its cap (${second.reason ?? 'cap'}); the first pass stands`);
    return first;
  }
  return second;
}

/**
 * Awaits `p` unless the run's signal fires first: a stage that ignores the
 * signal (a hung check, a stuck git) cannot hold the run past a kill.
 */
function guarded<T>(st: LiveRun, p: Promise<T>): Promise<T> {
  const s = st.lease.signal;
  if (s.aborted) {
    p.catch(() => {});
    return Promise.reject(new Killed(reasonOf(st)));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(new Killed(reasonOf(st)));
    };
    s.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        s.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        s.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** The city's own step: a failure in it is never the agent's. */
async function city<T>(st: LiveRun, p: () => Promise<T>): Promise<T> {
  try {
    return await guarded(st, p());
  } catch (err) {
    if (err instanceof Killed) throw err;
    throw new CityError(err instanceof Error ? err.message : String(err));
  }
}

function wallMsOf(a: Agent): number {
  return config.runWallMs ?? (maxMinutesOf(a) + RUN_EXTRA_MINUTES) * MIN_MS;
}

/** The whole life of one run, from preparing to its end or to waiting on its PR. */
async function lifecycle(st: LiveRun): Promise<Run> {
  const log = logTo(st);
  let phase: 'before' | 'work' | 'after' = 'before';
  const ecosystems = st.repo.checks?.ecosystems ?? [];
  try {
    boundary(st, 'preparing');
    const { dir, baseSha } = await guarded(st, createRunDir(st.repo, st.run.id, st.run.branch));
    st.run = { ...st.run, dir, baseSha };
    saveRun(st.run);
    st.egress = await guarded(st, startEgress(st.run.id, log));
    if (st.agent.model.startsWith('claude:')) {
      st.broker = await guarded(st, startBroker(st.run.id, { runRoot: st.runRoot, dir, log, signal: st.lease.signal, stage: () => st.toolStage }));
    }
    if (config.baseline) await guarded(st, config.baseline(st.repo, baseSha, { signal: st.lease.signal, log }));

    boundary(st, 'installing');
    st.toolStage = 'install';
    st.egress.setStage('install', hostsFor('install', ecosystems, null));
    const ctx: RunContext = { runId: st.run.id, runRoot: st.runRoot, dir, log, signal: st.lease.signal, egress: st.egress };
    const install = await guarded(st, config.installDeps(ctx, st.repo));
    record('check.done', { runId: st.run.id, jobId: st.run.jobId, check: install });
    checkpoint(st);
    // An install failure is the repo's or the city's, never the firm's: crashed, an attempt spent, no reputation hit.
    if (install.status === 'fail') return end(st, 'crashed', `The install failed: ${install.detail}`, { job: 'fail' });

    phase = 'work';
    checkpoint(st);
    st.job = transition(storedJob(st.job.id) ?? st.job, 'running', { runId: st.run.id });
    setStage(st, 'working');
    st.toolStage = 'working';
    st.egress.setStage('working', hostsFor('working', ecosystems, st.agent.model));
    const out = await doWork(st, dir, baseSha);
    // From here on the agent has stopped: git, disk and reaper failures are the city's.
    phase = 'after';
    st.summary = typeof out.summary === 'string' ? out.summary.slice(0, 4000) : null;
    if (out.ended === 'aborted' && st.lease.signal.aborted) throw new Killed(reasonOf(st));
    checkpoint(st);
    if (out.ended === 'capped') return end(st, 'capped', out.reason ?? 'The run reached a cap.', { job: 'fail', exclude: true });
    if (out.ended === 'crashed' || out.ended === 'aborted') {
      const reason = out.reason ?? (out.ended === 'aborted' ? 'The provider stopped on its own.' : 'The provider crashed.');
      if (out.spendsAttempt === false) return end(st, 'crashed', reason, { job: 'reopen' });
      return end(st, 'crashed', reason, { job: 'fail', exclude: true });
    }

    // A stray the reaper cannot clear is counted as the city's failure: runQuiet does not say whether the survivor was the agent's.
    await city(st, () => config.quiet(st.runRoot));
    const head = await city(st, () => commitAll(dir, st.job.title, st.job.id));
    if (!head) return end(st, 'failed', 'The run finished without changing anything.', { job: 'fail', exclude: true });
    st.run = { ...st.run, headSha: head };
    saveRun(st.run);
    await city(st, () => config.quiet(st.runRoot));
    const d = await city(st, () => diffOf(dir, baseSha));
    const patchPath = join(st.runRoot, 'diff.patch');
    writeFileSync(patchPath, d.patch);
    const diff: RunDiff = { ...d, patchPath };
    record('run.diff', { runId: st.run.id, jobId: st.run.jobId, headSha: head, files: d.files, lines: d.lines, sha256: d.sha256, patchPath });

    checkpoint(st);
    st.job = transition(storedJob(st.job.id) ?? st.job, 'inspecting');
    setStage(st, 'inspecting');
    st.toolStage = 'checks';
    st.egress.setStage('checks', hostsFor('checks', ecosystems, null));
    const inspection = await guarded(st, config.inspect(st.run, st.job, st.repo, diff, st.lease, { log, egress: st.egress }));
    // No reviewer could read the change: not the agent's failure. No scar, no attempt, the firm not excluded.
    // The third time in a row the job leaves the board, halted with a note for his daily brief.
    if (!inspection.passed && inspection.inconclusive && !st.lease.signal.aborted) {
      st.run = { ...st.run, inspectionId: inspection.id };
      saveRun(st.run);
      const reason = `The inspection could not reach a verdict: ${inspection.inconclusive}`;
      const count = (storedJob(st.job.id)?.inconclusive ?? 0) + 1;
      setInconclusive(st.job.id, count);
      if (count <= MAX_INCONCLUSIVE) return end(st, 'crashed', reason, { job: 'reopen' });
      const ended = end(st, 'crashed', reason, { job: 'none' });
      try {
        const cur = storedJob(st.job.id);
        if (cur && cur.runId === st.run.id && LIVE_JOB.includes(cur.status)) {
          transition(cur, 'halted', { runId: null, awardedBid: null, bidsCloseAt: null, haltNote: NEEDS_REVIEWER });
          record('run.note', { runId: st.run.id, jobId: st.job.id, repo: st.run.repo, note: NEEDS_REVIEWER, inconclusive: count, at: iso() });
        }
      } catch (err) {
        engineLog(st, `[palimpsest] the job could not be halted: ${errText(err)}`);
      }
      return ended;
    }
    // A failed inspection that halts the repo does not kill this run: it still ends failed, with its scar.
    if (!inspection.passed && !st.lease.signal.aborted) {
      st.run = { ...st.run, inspectionId: inspection.id };
      saveRun(st.run);
      return end(st, 'failed', 'The change failed inspection.', { job: 'fail', exclude: true, scar: true, summary: inspectionSummary(inspection) });
    }
    checkpoint(st);
    st.run = { ...st.run, inspectionId: inspection.id };
    saveRun(st.run);

    st.job = transition(storedJob(st.job.id) ?? st.job, 'shipping');
    setStage(st, 'shipping');
    const shipped = await guarded(st, config.ship(st.run, st.job, st.repo, inspection, st.lease.signal));
    st.run = { ...st.run, ...shipped, id: st.run.id, jobId: st.run.jobId, summary: st.summary };
    if (st.run.outcome) return end(st, st.run.outcome, st.run.endedReason, { job: 'none' });
    setStage(st, st.run.stage === 'done' ? 'done' : 'waiting');
    return st.run;
  } catch (err) {
    // Past its wall deadline the run is capped: an attempt spent, the firm excluded only if it was still working.
    if (st.deadlineHit) return end(st, 'capped', reasonOf(st), { job: 'fail', exclude: phase === 'work' });
    if (st.lease.signal.aborted || err instanceof Killed) return end(st, 'killed', reasonOf(st), { job: 'reopen' });
    const msg = err instanceof Error ? err.message : String(err);
    // A crash while the agent worked is the agent's; one before or after it, or in the city's own step, is the city's.
    return end(st, 'crashed', msg, { job: 'fail', exclude: phase === 'work' && !(err instanceof CityError) });
  } finally {
    for (const close of [() => st.broker?.close(), () => st.egress?.close()]) {
      try {
        await close();
      } catch {
        // Closing is best effort; the registry entry goes with the run.
      }
    }
    try {
      if (existsSync(st.runRoot)) await config.reap(st.runRoot);
    } catch (err) {
      console.warn(`palimpsest: reaping run ${st.run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    forgetRun(st.run.id);
    removeRunDir(st.run.id);
    // The slot and the lease go only once the proxy, the broker and the run's processes are gone.
    live.delete(st.run.id);
    st.lease.release();
    syncWatcher();
    updateKeepAwake();
  }
}

/**
 * Starts the run for an awarded bid under `lease` (a `work` lease for the
 * agent's model; one is acquired when none is given) and resolves with the
 * run when it ends or waits on its PR. Throws, holding nothing, when the
 * preflight refuses, the job is no longer awarded to this bid, or its repo
 * already has a live run.
 */
export async function startRun(bid: Bid, opts: { lease?: Lease } = {}): Promise<Run> {
  let lease = opts.lease;
  const refuse = (why: string): never => {
    lease?.release();
    throw new Error(why);
  };
  const check = () => {
    const j = storedJob(bid.jobId);
    const a = storedAgent(bid.agentId);
    const repo = j ? getRepo(j.repo) : null;
    if (!j || j.status !== 'awarded' || j.awardedBid !== bid.id) return refuse(`job ${bid.jobId} is not awarded to bid ${bid.id}`);
    if (!a || a.retired) return refuse(`agent ${bid.agentId} cannot work`);
    if (!repo) return refuse(`repo ${j.repo} is not connected`);
    return { j, a, repo };
  };
  const first = check();
  // The repo is claimed before the first await, so a second call for it is refused at once.
  if (repoBusy(first.repo.fullName)) refuse(`${first.repo.fullName} already has a live run`);
  reserved.add(first.repo.fullName);
  try {
    const problem = await config.preflight();
    if (problem) refuse(problem);
    if (!lease) {
      const got = await acquire(first.a.model, 'work', bid.price, { now: config.now() });
      if (!got.ok) refuse(`no work lease: ${got.reason.detail}`);
      else lease = got.lease;
    }
    // The job may have moved while we waited.
    const { j, a, repo } = check();
    const st = begin(bid, j, a, repo, lease as Lease);
    return lifecycle(st);
  } catch (err) {
    lease?.release();
    throw err;
  } finally {
    reserved.delete(first.repo.fullName);
  }
}

/** Makes the run live: its record, its job's run id, its site and its deadline. */
function begin(bid: Bid, j: Job, a: Agent, repo: Repo, lease: Lease): LiveRun {
  const now = config.now();
  const id = `run-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const runRoot = join(paths().runs, id);
  mkdirSync(runRoot, { recursive: true });
  const r: Run = {
    id,
    jobId: j.id,
    bidId: bid.id,
    agentId: a.id,
    firmId: a.firmId,
    repo: repo.fullName,
    model: a.model,
    branch: `palimpsest/${j.id}`,
    dir: null,
    baseSha: null,
    headSha: null,
    stage: 'preparing',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: iso(now),
    endedAt: null,
    prNumber: null,
    prUrl: null,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    // Unattended runs are charged to the night cap (ruling 11).
    unattended: unattended(now),
    summary: null,
  };
  const st: LiveRun = {
    run: r,
    job: attachRun(j.id, id) ?? j,
    bid,
    agent: a,
    repo,
    lease,
    runRoot,
    egress: null,
    broker: null,
    toolStage: 'working',
    killReason: null,
    logWindow: { start: 0, count: 0 },
    site: { repo: repo.fullName, runId: id, jobId: j.id, agentId: a.id, firmId: a.firmId, stage: 'crane', progress: 0, size: TIER_SIZE[j.tier], since: iso(now) },
    summary: null,
    deadlineAt: Date.now() + wallMsOf(a),
    deadlineHit: false,
  };
  live.set(id, st);
  saveRun(r);
  record('run.started', { runId: id, jobId: j.id, run: r });
  emit('run.started', { run: r });
  syncWatcher();
  updateKeepAwake();
  return st;
}

/**
 * Ends a run that is waiting on its PR (Task 16's PR poll: `merged` or
 * `closed`), recording `run.ended` with the summary at the top level as
 * every other end does. The job is Task 16's to move. Null when the run is
 * not waiting.
 */
export function finishWaitingRun(runId: string, outcome: Exclude<RunOutcome, null>, reason: string | null, patch: Partial<Run> = {}): Run | null {
  const r = run(runId);
  if (!r || r.outcome !== null || r.stage !== 'waiting' || live.has(runId)) return null;
  const ended: Run = { ...r, ...patch, id: r.id, jobId: r.jobId, outcome, endedReason: reason, endedAt: iso(), stage: 'done' };
  saveRun(ended);
  record('run.ended', { runId, jobId: r.jobId, outcome, reason, summary: ended.summary ?? null, run: ended });
  emit('run.ended', { runId, outcome, reason });
  const j = storedJob(r.jobId);
  const site: SiteState = {
    repo: r.repo,
    runId,
    jobId: r.jobId,
    agentId: r.agentId,
    firmId: r.firmId,
    stage: outcome === 'merged' ? 'curing' : 'teardown',
    progress: 1,
    size: TIER_SIZE[j?.tier ?? 'normal'],
    since: iso(),
  };
  emit('site.changed', { site });
  return ended;
}

/**
 * At engine start: runs left in a live stage by the last engine can never
 * finish. Each ends `crashed`, and its job fails one attempt and returns to
 * the board if it has one left (ruling 16).
 */
export async function failInterruptedRuns(opts: { reap?: (runRoot: string) => Promise<number[]> } = {}): Promise<Run[]> {
  const reap = opts.reap ?? reapRun;
  const out: Run[] = [];
  for (const r of listRuns()) {
    if (r.outcome !== null || !LIVE_STAGES.includes(r.stage)) continue;
    const ended: Run = { ...r, outcome: 'crashed', endedReason: INTERRUPTED_RUN, endedAt: new Date().toISOString(), stage: 'done' };
    saveRun(ended);
    record('run.ended', { runId: r.id, jobId: r.jobId, outcome: 'crashed', reason: INTERRUPTED_RUN, summary: r.summary ?? null, run: ended });
    emit('run.ended', { runId: r.id, outcome: 'crashed', reason: INTERRUPTED_RUN });
    settleJob({ run: ended }, 'fail', false);
    // Whatever the run left running (a daemon that outlived the engine) is killed before its files go.
    const runRoot = join(paths().runs, r.id);
    try {
      if (existsSync(runRoot)) await reap(runRoot);
    } catch (err) {
      console.warn(`palimpsest: reaping interrupted run ${r.id} failed: ${errText(err)}`);
    }
    removeRunDir(r.id);
    out.push(ended);
  }
  return out;
}

// ---------------------------------------------------------------- halts (self-halt, ruling 30)

/**
 * Halts the market on a repo: every job not yet settled moves to `halted`
 * (a waiting one remembers it, ruling 30) and its live run is killed.
 * Records `repo.halted`. Tasks 15 and 16 call it for three failed
 * inspections and for a revert.
 */
export function haltRepo(fullName: string, reason: string, at: string = new Date().toISOString(), o: { exceptRun?: string } = {}): Repo {
  const repo = updateRepoMarket(fullName, { halted: { at, reason } });
  record('repo.halted', { repo: fullName, reason, at });
  emit('repo.halted', { repo });
  const spared = o.exceptRun ? (live.get(o.exceptRun)?.run.jobId ?? run(o.exceptRun)?.jobId ?? null) : null;
  for (const j of listJobs({ repo: fullName, status: HALTABLE })) {
    // The run that halts its own repo (its inspection was the third failure) settles its job itself.
    if (j.id === spared) continue;
    try {
      transition(j, 'halted');
    } catch (err) {
      console.error(`palimpsest: could not halt job ${j.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const st of [...live.values()]) if (st.run.repo === fullName && st.run.id !== o.exceptRun) kill(st.run.id, `The market on ${fullName} is halted: ${reason}`);
  return repo;
}

/**
 * Clears a repo's halt and strikes (`repo.resumed`) and moves each halted
 * job back: to `waiting` when it was halted from waiting (its PR is still
 * open, so it is never re-bid), else to `open`.
 */
export function resumeRepo(fullName: string, at: string = new Date().toISOString()): Repo {
  const repo = updateRepoMarket(fullName, { halted: null, strikes: 0 });
  record('repo.resumed', { repo: fullName, at });
  emit('repo.resumed', { repo });
  for (const j of listJobs({ repo: fullName, status: 'halted' })) {
    try {
      if (j.haltedFrom === 'waiting') transition(j, 'waiting');
      else transition(j, 'open', { runId: null, awardedBid: null, bidsCloseAt: null, inconclusive: 0, haltNote: null });
    } catch (err) {
      console.error(`palimpsest: could not resume job ${j.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return repo;
}

// ---------------------------------------------------------------- the scheduler

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The scheduler. Creating it wires keep-awake into the treasury and listens
 * for the hard stop; start() is always called at engine start and every tick
 * gates itself on the stop file.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const given = Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)) as Partial<Config>;
  config = { ...defaults(), ...given };
  registerKeepAwake(keepAwakeState);
  onHardStop(() => {
    // The treasury has already aborted the leases; name the reason on the runs it hit.
    for (const st of live.values()) if (st.lease.signal.aborted && !st.killReason) st.killReason = reasonOf(st);
    updateKeepAwake();
  });

  const lastPoll = new Map<string, number>();
  const collecting = new Set<string>();
  let lastDay: string | null = null;
  let lastRefusal: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  async function startRuns(now: number, eligible: Set<string>): Promise<void> {
    const due = listJobs({ status: 'awarded' }).filter((j) => eligible.has(j.repo) && !(j.runId && live.has(j.runId)));
    if (due.length === 0) return;
    const problem = await config.preflight();
    if (problem) {
      if (problem !== lastRefusal) console.warn(`palimpsest: ${problem}`);
      lastRefusal = problem;
      return;
    }
    lastRefusal = null;
    const busy = new Set<string>();
    for (const j of due) {
      if (busy.has(j.repo) || repoBusy(j.repo)) continue;
      const bid = j.awardedBid ? bidById(j.awardedBid) : null;
      const a = bid ? storedAgent(bid.agentId) : null;
      if (!bid || !a || a.retired) {
        // The winner can no longer work (retired, bankrupt firm): the job goes back on the board.
        try {
          transition(j, 'open', { awardedBid: null, bidsCloseAt: null, runId: null });
        } catch (err) {
          console.error(`palimpsest: could not reopen job ${j.id}: ${errText(err)}`);
        }
        continue;
      }
      const got = await acquire(a.model, 'work', bid.price, { now });
      if (!got.ok) continue;
      busy.add(j.repo);
      track(startRun(bid, { lease: got.lease })).catch((err) => console.error(`palimpsest: run for job ${j.id} did not start: ${errText(err)}`));
    }
  }

  async function tickOnce(): Promise<void> {
    const now = config.now();
    if (existsSync(paths().stop)) {
      for (const id of [...live.keys()]) kill(id, STOP_REASON);
      // The treasury read sees the stop file and aborts every lease, bid-time plan calls included, even with no run live.
      try {
        treasury(now);
      } catch (err) {
        console.warn(`palimpsest: the treasury could not be read: ${errText(err)}`);
      }
      updateKeepAwake();
      return;
    }
    try {
      treasury(now);
    } catch (err) {
      console.warn(`palimpsest: the treasury could not be read: ${errText(err)}`);
    }

    const repos = listRepos().filter((r) => r.connected && r.market && !r.halted);
    const eligible = new Set(repos.map((r) => r.fullName));

    for (const r of repos) {
      const last = lastPoll.get(r.fullName);
      if (last !== undefined && now - last < POLL_MS) continue;
      lastPoll.set(r.fullName, now);
      try {
        await config.pollJobs(r, { kill: (jobId) => killJob(jobId) });
      } catch (err) {
        console.warn(`palimpsest: polling ${r.fullName} failed: ${errText(err)}`);
      }
    }

    for (const j of listJobs({ status: 'open' })) {
      if (!eligible.has(j.repo)) continue;
      try {
        openBidding(j, now);
      } catch (err) {
        console.error(`palimpsest: could not open bidding on ${j.id}: ${errText(err)}`);
      }
    }

    for (const j of listJobs({ status: 'bidding' })) {
      if (!eligible.has(j.repo)) continue;
      const key = `${j.id} ${j.bidsCloseAt}`;
      if (collecting.has(key)) continue;
      collecting.add(key);
      track(collectBids(j, now)).catch((err) => console.error(`palimpsest: collecting bids on ${j.id} failed: ${errText(err)}`));
    }

    for (const j of listJobs({ status: 'bidding' })) {
      if (!eligible.has(j.repo)) continue;
      try {
        award(j, now);
      } catch (err) {
        console.error(`palimpsest: the award on ${j.id} failed: ${errText(err)}`);
      }
    }
    // Forget rounds that are over.
    const biddingNow = new Set(listJobs({ status: 'bidding' }).map((j) => `${j.id} ${j.bidsCloseAt}`));
    for (const key of [...collecting]) if (!biddingNow.has(key)) collecting.delete(key);

    await startRuns(now, eligible);

    for (const step of [config.pollPRs, config.watchReverts]) {
      try {
        await step?.(now);
      } catch (err) {
        console.warn(`palimpsest: ${errText(err)}`);
      }
    }
    const day = localDay(now);
    if (lastDay !== null && day !== lastDay && config.daily) {
      try {
        await config.daily(lastDay);
      } catch (err) {
        console.warn(`palimpsest: the daily tick failed: ${errText(err)}`);
      }
    }
    lastDay = day;
    updateKeepAwake();
  }

  const tick = (): Promise<void> => {
    if (current) return current;
    current = tickOnce()
      .catch((err) => console.error(`palimpsest: the scheduler tick failed: ${errText(err)}`))
      .finally(() => {
        current = null;
      });
    return current;
  };

  return {
    tick,
    start(intervalMs = TICK_MS) {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      // Shutdown: every live run is killed, then closed, reaped and released by its own lifecycle;
      // every other lease (bid-time plan calls, queued ones too) is aborted so nothing keeps the wait open.
      for (const id of [...live.keys()]) kill(id, SHUTDOWN_REASON);
      abortAllLeases(new Error(SHUTDOWN_REASON));
      while (current || pending.size > 0) await Promise.allSettled([current, ...pending]);
    },
    async idle() {
      while (current || pending.size > 0) {
        await Promise.allSettled([current, ...pending]);
      }
    },
    watch: watchOnce,
  };
}

/** Grace a shutdown gets before the process exits anyway. */
export const SHUTDOWN_GRACE_MS = 10_000;

/** Reaps every live run's root, best effort, each bounded by `ms`. */
export async function reapLiveRuns(ms = 3_000): Promise<void> {
  await Promise.allSettled(
    [...live.values()].map((st) =>
      Promise.race([config.reap(st.runRoot), new Promise((r) => setTimeout(r, ms).unref?.())]),
    ),
  );
}

/**
 * The engine's signal handler. The first signal stops the scheduler (live
 * runs killed and reaped, every lease aborted), closes the server and
 * exits; past `graceMs` it reaps what is left, best effort, and exits
 * anyway. A second signal exits at once.
 */
export function shutdownHandler(
  scheduler: Pick<Scheduler, 'stop'>,
  o: { close: () => Promise<void>; exit: (code: number) => void; graceMs?: number; log?: (line: string) => void },
): (signal: string) => void {
  let shuttingDown = false;
  return (signal) => {
    if (shuttingDown) {
      o.log?.(`Palimpsest engine received ${signal} again, exiting now`);
      o.exit(1);
      return;
    }
    shuttingDown = true;
    o.log?.(`Palimpsest engine received ${signal}, shutting down`);
    const hard = setTimeout(() => {
      o.log?.('Palimpsest engine shutdown took too long, exiting');
      void reapLiveRuns().finally(() => o.exit(1));
    }, o.graceMs ?? SHUTDOWN_GRACE_MS);
    void scheduler
      .stop()
      .catch(() => {})
      .then(() => o.close())
      .then(
        () => {
          clearTimeout(hard);
          o.exit(0);
        },
        () => {
          clearTimeout(hard);
          o.exit(1);
        },
      );
  };
}

/** Forgets every live run, the watcher, keep-awake and the configuration. For tests. */
export function resetRuns(): void {
  for (const st of live.values()) abortLease(st.lease, new Error('reset'));
  live.clear();
  pending.clear();
  if (watcher) clearInterval(watcher);
  watcher = null;
  if (caffeinate) caffeinate.kill('SIGTERM');
  caffeinate = null;
  preflightOk = null;
  config = defaults();
}
