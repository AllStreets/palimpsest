/**
 * Arenas (Phase 4 ruling 20, Decision 8): races built from his own repos.
 * This is the build half, for planted bugs (Task 19); past changes and the
 * Beagle side (tools, grading for races) come in Tasks 20 and 21.
 *
 * A planted-bug arena is built only on his click, only for a connected repo
 * with the market on and a test command, and only while the heavy gate
 * holds. The build:
 *
 * 1. clones the repo's head into an arena base (`<runs>/arena-<id>/base`)
 *    and installs its dependencies there once, through the install egress
 *    (the repo's registries only); the egress is then closed and forgotten,
 *    so nothing after it has a proxy to reach;
 * 2. runs the repo's test command at the head in a fresh APFS clone of the
 *    base (the grading root, `<runs>/arena-<id>-grade`), with no proxy:
 *    it must pass;
 * 3. plants up to ARENA.mutants one-line bugs in source files that are not
 *    tests (`mutate()`), and grades each in a fresh clone the same way: a
 *    bug the suite catches (a non-zero exit) is kept, one it passes (or one
 *    whose suite never ends) is dropped; at most ARENA.keepPlanted kept;
 * 4. writes the kept bugs as tasks to `arena_tasks` and to Beagle's store
 *    (`putArena`, `putTasks`, with `Arena.data` the arena id), split by
 *    Beagle's `splitOf()`, and records `arena.built` with Beagle's
 *    `sealedHash` of the arena.
 *
 * Every command runs through `execTool()` under the tool profile. The gate
 * is read before each candidate; a gate loss, or the school turned off,
 * pauses the build (`arena.built` with status `paused`), and the next build
 * of that repo, or `resumeArenas()` on a later night, tries only the
 * candidates not yet tried. The wall time of each session is charged as
 * local `school` credits to the city.
 *
 * What a build has tried lives in `<school>/arenas/<id>/state.json`; its
 * log in `<school>/arenas/<id>/log.jsonl`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { localCredits } from '../../shared/credits.js';
import { ARENA } from '../../shared/school-rules.js';
import type { ArenaInfo, ModelRef, Repo } from '../../shared/types.js';
import { openDb } from '../db.js';
import { getRunner } from '../exec.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { mirrorDir, syncMirror } from '../mirror.js';
import { charge, unattended } from '../market/budget.js';
import { CHECK_MS } from '../guild/checks.js';
import { execTool, forgetRun, reapRun } from '../market/broker.js';
import { startEgress, type Egress } from '../market/egress.js';
import { installDeps, type RunContext } from '../market/install.js';
import { redact } from '../market/jobs.js';
import type { RunLogLine } from '../market/provider.js';
import { BASE_SCRATCH } from '../market/sandbox.js';
import { controlFiles, createBaseDir, engineGit, ENGINE_GIT_FLAGS, removeOwned } from '../market/worktree.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import type { BeagleApi, BeagleArena, BeagleSplit } from './beagle-api.js';
import { loadBeagle } from './beagle.js';
import { mutable, mutate, shuffled, type Mutant } from './mutants.js';
import { registerAbort, TURNED_OFF_REASON } from './tick.js';
import { readGate } from './trainer.js';

/** What a planted task shows the agent: which tests fail and how, never where the bug is. */
export interface PlantedInput {
  kind: 'planted';
  repo: string;
  test: string;
  failing: string[];
  output: string;
}

/** What a planted task's grade knows: the bug, and the tests it broke. */
export interface PlantedTruth extends Mutant {
  failing: string[];
}

export interface ArenaTask {
  id: string;
  arena: string;
  split: BeagleSplit;
  /** The PR number or sha a past change came from (Task 20); null for a planted bug. */
  ref: string | null;
  input: PlantedInput;
  truth: PlantedTruth;
}

export type CandidateState = 'untried' | 'kept' | 'dropped';

export interface Candidate {
  /** Stable within the arena: a hash of the file, line and planted text. */
  key: string;
  mutant: Mutant;
  state: CandidateState;
  failing: string[];
  output: string;
}

interface BuildState {
  id: string;
  repo: string;
  sha: string | null;
  installed: boolean;
  headPassed: boolean;
  candidates: Candidate[] | null;
  startedAt: string;
}

/** The model a build's wall time is charged under: local, sized 0 GB (no model runs). */
export const ARENA_BUILD_MODEL: ModelRef = 'mlx:arena-build';

/** Source files larger than this are not mutated (a generated or vendored file, most likely). */
const MAX_SOURCE_BYTES = 200_000;
/** The test output a task keeps: its tail. */
const MAX_OUTPUT = 4_000;
const SHA = /^[0-9a-f]{40}$/;

/** The one build running now, if any. */
let live: { id: string; repo: string } | null = null;

// ---------------------------------------------------------------- where things live

/** The run id (and run root name) of an arena's base: `<runs>/arena-<id>/base` holds the head with its install. */
export function arenaRunId(id: string): string {
  return `arena-${id}`;
}

/** The arena base: the head with its dependencies installed, which every grading clone is cloned from. */
export function arenaBase(id: string): string {
  return join(paths().runs, arenaRunId(id), 'base');
}

const gradeRunId = (id: string) => `arena-${id}-grade`;
const arenaDir = (id: string) => join(paths().school, 'arenas', id);
const stateFile = (id: string) => join(arenaDir(id), 'state.json');

function readState(id: string): BuildState | null {
  try {
    return JSON.parse(readFileSync(stateFile(id), 'utf8')) as BuildState;
  } catch {
    return null;
  }
}

function writeState(s: BuildState): void {
  mkdirSync(arenaDir(s.id), { recursive: true });
  writeFileSync(stateFile(s.id), JSON.stringify(s));
}

/** What a build has tried so far, candidate by candidate (empty before its candidates are planted). */
export function candidatesOf(id: string): Candidate[] {
  return readState(id)?.candidates ?? [];
}

// ---------------------------------------------------------------- reading

export function arenaInfo(id: string): ArenaInfo | null {
  const row = openDb().prepare('SELECT json FROM arenas WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as ArenaInfo) : null;
}

export function listArenas(repo?: string): ArenaInfo[] {
  const rows = (repo === undefined
    ? openDb().prepare('SELECT json FROM arenas').all()
    : openDb().prepare('SELECT json FROM arenas WHERE repo = ?').all(repo)) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as ArenaInfo).sort((a, b) => a.builtAt.localeCompare(b.builtAt) || a.id.localeCompare(b.id));
}

/** An arena's tasks, of one split or all, in id order. */
export function arenaTasks(id: string, split?: BeagleSplit): ArenaTask[] {
  const rows = (split === undefined
    ? openDb().prepare('SELECT json FROM arena_tasks WHERE arena = ? ORDER BY id').all(id)
    : openDb().prepare('SELECT json FROM arena_tasks WHERE arena = ? AND split = ? ORDER BY id').all(id, split)) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as ArenaTask);
}

/** Writes the arena's row and records it whole (`arena.built`), so the ledger replays it. */
function putInfo(info: ArenaInfo): ArenaInfo {
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
  record('arena.built', { arena: info });
  return info;
}

// ---------------------------------------------------------------- refusals

/** Why `repo` cannot have an arena built now, or null. */
export function refusal(repo: Repo): string | null {
  if (!getSettings().school.enabled) return 'The school is off';
  if (!repo.connected) return `${repo.fullName} is not connected`;
  if (!repo.market) return `The market is off on ${repo.fullName}; an arena is built only from a market-on repo`;
  if (!repo.checks?.test) return `${repo.fullName} has no test command, so its tests cannot judge a planted bug`;
  return null;
}

function refused(repo: Repo, reason: string, now: number): ArenaInfo {
  return {
    id: '',
    repo: repo.fullName,
    kind: 'planted',
    sha: '',
    tasks: { breeding: 0, race: 0, sealed: 0 },
    candidates: 0,
    kept: 0,
    sealedUses: 0,
    sealedHash: null,
    builtAt: new Date(now).toISOString(),
    status: 'failed',
    reason,
  };
}

// ---------------------------------------------------------------- grading

/** Removes a run root the build made, after killing anything still running in it. */
async function clearRoot(runId: string): Promise<void> {
  const root = join(paths().runs, runId);
  if (!existsSync(root)) return;
  try {
    await reapRun(root);
  } catch {
    // best effort
  }
  forgetRun(runId);
  removeOwned(root);
}

/** The control files a tool command's environment names, empty and read-only, as createRunDir makes them. */
function controlFilesFor(runId: string): void {
  const ctl = controlFiles(runId);
  for (const f of [ctl.gitconfig, ctl.npmrc]) {
    if (existsSync(f)) continue;
    writeFileSync(f, '', { mode: 0o444 });
    chmodSync(f, 0o444);
  }
}

/** The names of the tests that failed, from TAP (`not ok`), node's spec reporter, Jest, Vitest, pytest and Go. */
export function failingTests(output: string): string[] {
  const out = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m =
      /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line) ??
      /^\s*[✖✕×]\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/.exec(line) ??
      /^FAILED\s+(\S+)/.exec(line) ??
      /^--- FAIL: (\S+)/.exec(line);
    const name = m?.[1]?.trim();
    if (name && !/^(failing tests:|tests? failed)/i.test(name)) out.add(name);
  }
  return [...out].slice(0, 50);
}

interface Graded {
  /** The suite exited non-zero: it caught the bug. */
  failed: boolean;
  /** It passed (exit 0). */
  passed: boolean;
  aborted: boolean;
  output: string;
}

/**
 * Runs the repo's test command in a fresh clone of the arena base, with
 * `mutant` planted when given. No egress runs for the grading root, so its
 * children's proxy is a closed port: grading has no network.
 */
async function grade(id: string, repo: Repo, mutant: Mutant | null, signal: AbortSignal, log: (l: RunLogLine) => void): Promise<Graded> {
  const runId = gradeRunId(id);
  const runRoot = join(paths().runs, runId);
  // The root is made once per session; each grade gets a fresh clone (execTool reaps after every command).
  for (const d of ['tmp', 'ctmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  controlFilesFor(runId);
  const dir = join(runRoot, 'repo');
  removeOwned(dir);
  // An APFS clone of each file where the disk can; links stay links, never pointed back at the base.
  cpSync(arenaBase(id), dir, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  try {
    if (mutant) {
      const p = join(dir, mutant.file);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines[mutant.line - 1] !== mutant.original) return { failed: false, passed: false, aborted: false, output: `${mutant.file}:${mutant.line} is not the line this bug was planted in` };
      lines[mutant.line - 1] = mutant.mutated;
      writeFileSync(p, lines.join('\n'));
    }
    const r = await execTool({ runId, runRoot, dir, command: repo.checks?.test ?? '', timeoutMs: CHECK_MS, stage: 'checks', signal, log });
    const aborted = signal.aborted;
    const output = scrub(`${r.stdout}\n${r.stderr}`, [dir, runRoot]);
    return { failed: !aborted && r.refused === null && r.code !== null && r.code !== 0, passed: !aborted && r.refused === null && r.code === 0, aborted, output };
  } finally {
    removeOwned(dir);
  }
}

/** Test output with no path of this Mac in it, cut to its tail. */
function scrub(text: string, dirs: string[]): string {
  let s = text;
  for (const d of dirs) {
    const forms = new Set([d, `/private${d}`]);
    try {
      forms.add(realpathSync(d));
    } catch {
      // already removed
    }
    for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.split(f).join('.');
  }
  s = redact(s).trim();
  return s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s;
}

// ---------------------------------------------------------------- the base

/** The head of the repo's default branch in the mirror (after a sync). */
async function headSha(repo: Repo): Promise<string> {
  await syncMirror(repo.fullName);
  const r = await getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), 'rev-parse', `refs/heads/${repo.defaultBranch}`], { timeoutMs: 60_000 });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA.test(sha)) throw new Error(`could not read the head of ${repo.fullName}: ${r.stderr.trim()}`);
  return sha;
}

/**
 * The arena base at `sha` with its dependencies installed, through the
 * install egress, which is closed and forgotten after. Null when it is
 * ready; else why not.
 */
async function prepareBase(id: string, repo: Repo, sha: string, signal: AbortSignal, log: (l: RunLogLine) => void): Promise<string | null> {
  const runId = arenaRunId(id);
  await clearRoot(runId);
  const runRoot = join(paths().runs, runId);
  const dir = await createBaseDir(repo, runId, sha);
  for (const d of [BASE_SCRATCH.home, BASE_SCRATCH.cache, BASE_SCRATCH.tmp, 'tmp', 'home', 'cache']) mkdirSync(join(runRoot, d), { recursive: true });
  controlFilesFor(runId);
  let egress: Egress | null = null;
  try {
    egress = await startEgress(runId, log);
    const ctx: RunContext = { runId, runRoot, dir, log, signal, egress, side: 'base' };
    const r = await installDeps(ctx, repo);
    if (signal.aborted) return 'aborted';
    if (r.status === 'fail') return `the install failed: ${r.detail}`;
    return null;
  } finally {
    try {
      await egress?.close();
    } catch {
      // best effort
    }
    // Forgotten, so no later command of this run root is pointed at a proxy.
    for (const f of ['egress.json', 'egress.token']) rmSync(join(runRoot, 'ctl', f), { force: true });
    try {
      await reapRun(runRoot);
    } catch {
      // best effort
    }
    forgetRun(runId);
  }
}

/** Every planted-bug candidate at the base, at most ARENA.mutants, in an order seeded by the head. */
async function plant(id: string, sha: string): Promise<Candidate[]> {
  const base = arenaBase(id);
  const ls = await engineGit(base, ['ls-files', '-z']);
  if (ls.code !== 0) throw new Error(`could not list the files at ${sha.slice(0, 7)}: ${ls.stderr.trim()}`);
  const seed = parseInt(sha.slice(0, 8), 16) >>> 0;
  const all: Mutant[] = [];
  for (const file of ls.stdout.split('\0').filter(Boolean).sort()) {
    if (!mutable(file)) continue;
    const p = join(base, file);
    let text: string;
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > MAX_SOURCE_BYTES) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    all.push(...mutate(file, text, ARENA.mutants, seed));
  }
  return shuffled(all, seed)
    .slice(0, ARENA.mutants)
    .map((mutant) => ({
      key: createHash('sha1').update(`${mutant.file}\n${mutant.line}\n${mutant.mutated}`).digest('hex').slice(0, 12),
      mutant,
      state: 'untried' as const,
      failing: [],
      output: '',
    }));
}

// ---------------------------------------------------------------- Beagle

/** Beagle's `sealedHash` of the arena, registering a stand-in for the call if the arena is not registered yet (Task 21 registers it for races). */
function sealedHashOf(b: BeagleApi, id: string): string {
  if (b.arenas.arenaIds().includes(id)) return b.race.sealedHash(id);
  const stub = { id, data: id, name: id, describe: '', answer: {}, grade: () => 0, tools: [], show: () => '' } as BeagleArena;
  b.arenas.registerArena(stub);
  try {
    return b.race.sealedHash(id);
  } finally {
    b.arenas.unregisterArena(id);
  }
}

/** Writes the kept bugs as tasks, to `arena_tasks` and to Beagle's store; returns the counts by split and Beagle's sealed hash. */
async function writeTasks(id: string, repo: Repo, kept: Candidate[]): Promise<{ counts: ArenaInfo['tasks']; sealedHash: string }> {
  const b = await loadBeagle();
  const tasks: ArenaTask[] = kept.map((c) => {
    const taskId = `${id}:${c.key}`;
    return {
      id: taskId,
      arena: id,
      split: b.arenas.splitOf(taskId),
      ref: null,
      input: { kind: 'planted', repo: repo.fullName, test: repo.checks?.test ?? '', failing: c.failing, output: c.output },
      truth: { ...c.mutant, failing: c.failing },
    };
  });
  const db = openDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM arena_tasks WHERE arena = ?').run(id);
    const put = db.prepare('INSERT OR REPLACE INTO arena_tasks (id, arena, split, ref, json) VALUES (?, ?, ?, ?, ?)');
    for (const t of tasks) put.run(t.id, id, t.split, t.ref, JSON.stringify(t));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  b.store.putArena(id, `${repo.fullName}: planted bugs`);
  b.store.putTasks(id, tasks.map((t) => ({ id: t.id, input: t.input, truth: t.truth, split: t.split })));
  const counts = { breeding: 0, race: 0, sealed: 0 };
  for (const t of tasks) counts[t.split]++;
  return { counts, sealedHash: sealedHashOf(b, id) };
}

// ---------------------------------------------------------------- the build

function newId(repo: Repo): string {
  const slug = repo.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `planted-${slug}-${randomUUID().slice(0, 6)}`;
}

function infoOf(s: BuildState, status: ArenaInfo['status'], reason: string | null, at: number, extra: Partial<ArenaInfo> = {}): ArenaInfo {
  const c = s.candidates ?? [];
  return {
    id: s.id,
    repo: s.repo,
    kind: 'planted',
    sha: s.sha ?? '',
    tasks: { breeding: 0, race: 0, sealed: 0 },
    candidates: c.length,
    kept: c.filter((x) => x.state === 'kept').length,
    sealedUses: 0,
    sealedHash: null,
    builtAt: new Date(at).toISOString(),
    status,
    reason,
    ...extra,
  };
}

/** The paused planted arena of `repo`, if it has one. */
function pausedOf(fullName: string): BuildState | null {
  for (const a of listArenas(fullName)) {
    if (a.kind === 'planted' && a.status === 'paused') return readState(a.id);
  }
  return null;
}

/**
 * Builds (or resumes) a planted-bug arena from `repo` (ruling 20): only for
 * a connected, market-on repo with a test command, only while the heavy
 * gate holds. Refused with the reason, recording nothing, when the repo
 * does not qualify or another build is running. A gate loss or the school
 * turned off pauses it, recorded; the next call for the repo resumes the
 * paused arena with only the candidates not yet tried.
 */
export async function buildPlanted(repo: Repo, now: number, o: { signal?: AbortSignal } = {}): Promise<ArenaInfo> {
  const why = refusal(repo);
  if (why) return refused(repo, why, now);
  if (live) return refused(repo, `An arena is already being built (${live.repo})`, now);

  const state: BuildState = pausedOf(repo.fullName) ?? {
    id: newId(repo),
    repo: repo.fullName,
    sha: null,
    installed: false,
    headPassed: false,
    candidates: null,
    startedAt: new Date(now).toISOString(),
  };
  live = { id: state.id, repo: repo.fullName };
  const started = Date.now();
  const at = () => now + (Date.now() - started);
  const ctl = new AbortController();
  const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
  const onOuter = () => ctl.abort(o.signal?.reason ?? 'stopped');
  o.signal?.addEventListener('abort', onOuter, { once: true });
  const signal = ctl.signal;
  const logFile = join(arenaDir(state.id), 'log.jsonl');
  mkdirSync(arenaDir(state.id), { recursive: true });
  const log = (line: RunLogLine) => {
    try {
      appendFileSync(logFile, `${JSON.stringify(line)}\n`);
    } catch {
      // best effort
    }
  };
  let worked = false;
  const stopReason = () => (typeof signal.reason === 'string' ? signal.reason : TURNED_OFF_REASON);
  const pause = async (reason: string) => {
    writeState(state);
    await clearRoot(gradeRunId(state.id));
    return putInfo(infoOf(state, 'paused', reason, at()));
  };
  const fail = async (reason: string) => {
    writeState(state);
    await clearRoot(gradeRunId(state.id));
    await clearRoot(arenaRunId(state.id));
    return putInfo(infoOf(state, 'failed', reason, at()));
  };

  try {
    const first = await readGate('heavy', at());
    if (!first.ok) return await pause(first.reason ?? 'the gate closed');
    worked = true;
    // A grading root an earlier session left (the engine stopped mid-grade) goes first.
    await clearRoot(gradeRunId(state.id));

    if (!state.sha) state.sha = await headSha(repo);
    if (!state.installed || !existsSync(arenaBase(state.id))) {
      const bad = await prepareBase(state.id, repo, state.sha, signal, log);
      if (signal.aborted) return await pause(stopReason());
      if (bad) return await fail(bad);
      state.installed = true;
      writeState(state);
    }
    if (!state.headPassed) {
      const g = await grade(state.id, repo, null, signal, log);
      if (g.aborted) return await pause(stopReason());
      if (!g.passed) return await fail(`The tests do not pass at the head (${state.sha.slice(0, 7)}), so a planted bug cannot be told apart`);
      state.headPassed = true;
      writeState(state);
    }
    if (!state.candidates) {
      state.candidates = await plant(state.id, state.sha);
      writeState(state);
    }

    for (const c of state.candidates) {
      if (c.state !== 'untried') continue;
      if (state.candidates.filter((x) => x.state === 'kept').length >= ARENA.keepPlanted) break;
      if (signal.aborted) return await pause(stopReason());
      const g0 = await readGate('heavy', at());
      if (!g0.ok) return await pause(g0.reason ?? 'the gate closed');
      const g = await grade(state.id, repo, c.mutant, signal, log);
      if (g.aborted) return await pause(stopReason());
      c.state = g.failed ? 'kept' : 'dropped';
      c.failing = g.failed ? failingTests(g.output) : [];
      c.output = g.failed ? g.output : '';
      writeState(state);
    }

    await clearRoot(gradeRunId(state.id));
    const kept = state.candidates.filter((x) => x.state === 'kept');
    if (kept.length === 0) return await fail('None of the planted bugs made the tests fail');
    const { counts, sealedHash } = await writeTasks(state.id, repo, kept);
    writeState(state);
    return putInfo(infoOf(state, 'ready', null, at(), { tasks: counts, sealedHash }));
  } catch (err) {
    return await fail(`The build failed: ${(err as Error).message}`);
  } finally {
    if (worked) {
      const seconds = Math.round(((Date.now() - started) / 1000) * 1000) / 1000;
      charge({
        runId: state.id,
        firmId: null,
        model: ARENA_BUILD_MODEL,
        kind: 'school',
        usage: { weightedTokens: 0, seconds, usd: 0, credits: localCredits(seconds, 0) },
        unattended: unattended(now),
        at: at(),
      });
    }
    o.signal?.removeEventListener('abort', onOuter);
    unregister();
    live = null;
  }
}

/**
 * Resumes each paused planted arena whose repo still qualifies, one after
 * another, each while the heavy gate holds (a later night's work; never a
 * new arena, which only his click builds). Returns the arenas it moved.
 */
export async function resumeArenas(now: number): Promise<ArenaInfo[]> {
  const out: ArenaInfo[] = [];
  for (const a of listArenas()) {
    if (a.kind !== 'planted' || a.status !== 'paused' || live) continue;
    const repo = getRepo(a.repo);
    if (!repo || refusal(repo)) continue;
    const g = await readGate('heavy', now);
    if (!g.ok) break;
    out.push(await buildPlanted(repo, now));
  }
  return out;
}

/** The repos an arena could be built from now (connected, market on, with a test command). */
export function arenaRepos(): Repo[] {
  return listRepos().filter((r) => refusal(r) === null);
}
