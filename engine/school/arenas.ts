/**
 * Arenas (Phase 4 ruling 20, Decision 8): races built from his own repos.
 * The build half: planted bugs (Task 19) and past changes (Task 20). The
 * race half (ruling 21, Task 21): `toBeagleArena()` turns a built arena into
 * a Beagle arena whose tools and grade run his own suite in fresh clones of
 * the arena base, and `registerArenas()` registers every ready one.
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
 *    it must pass (planted bugs only);
 * 3. plants up to ARENA.mutants one-line bugs in source files that are not
 *    tests (`mutate()`), and grades each in a fresh clone the same way: a
 *    bug the suite catches (a non-zero exit) is kept, one it passes (or one
 *    whose suite outlasts the mutant cap, `mutantCapMs`) is dropped; a bug
 *    whose file is a link or resolves outside the clone is never written
 *    (skipped); at most ARENA.keepPlanted kept;
 * 4. writes the kept bugs as tasks to `arena_tasks` and to Beagle's store
 *    (`putArena`, `putTasks`, with `Arena.data` the arena id), split by
 *    Beagle's `splitOf()`, and records `arena.built` with Beagle's
 *    `sealedHash` of the arena.
 *
 * A past-change arena (`buildPast`) is built the same way, with step 3
 * taken from his verified history (`verifiedChanges()`, ruling 23): each
 * change that touched source and tests (a rebase-merged PR whose parent is
 * the PR's own commit, not the branch before it, is skipped) is graded
 * twice in fresh clones of the base, read only from the mirror's objects:
 * at its parent with the change's test files applied (it must fail) and at
 * the change (it must pass). At most ARENA.keepPast kept. The head need
 * not pass: the grading cap comes from the first candidate run that passed
 * in full. A change whose parent or self has other dependency manifests or
 * lockfiles than the head is skipped with that reason, since the base
 * carries the head's install. Its task shows
 * the change's test diff and the failure, never the fix; `arena_tasks.ref`
 * is the PR number or the sha.
 *
 * Every command runs through `execTool()` under the tool profile. A build
 * holds a train of kind `arena` (`holdTrain`) and is refused while any other
 * train runs, so the school runs one train at a time. It is recorded
 * `building` as it starts. The gate is read before each candidate and every
 * `GATE.pollMs` while a grade runs; a gate loss (or a gate that cannot be
 * read), the school turned off or `pauseAll` stops the grade in flight and
 * pauses the build (`arena.built` with status `paused`), and the next build
 * of that repo, or `resumeArenas()` on a later night, tries only the
 * candidates not yet tried. A build an engine crash left `building` is
 * paused at the next start (`pauseStrandedBuilds`). The wall time of each session is charged as
 * local `school` credits to the city.
 *
 * What a build has tried lives in `<school>/arenas/<id>/state.json`; its
 * log in `<school>/arenas/<id>/log.jsonl`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

import { localCredits } from '../../shared/credits.js';
import { poolOfModel } from '../../shared/market-rules.js';
import { ARENA, arenaRefusal, BUSY_REFUSAL, GATE, RACE_REFUSAL } from '../../shared/school-rules.js';
import type { ArenaInfo, ModelRef, Repo, TrainState } from '../../shared/types.js';
import { openDb } from '../db.js';
import { getRunner } from '../exec.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { mirrorDir, mirrorReadEnv, syncMirror } from '../mirror.js';
import { charge, unattended } from '../market/budget.js';
import { CHECK_MS } from '../guild/checks.js';
import { execFileTool, execTool, forgetRun, MAX_RETURN_BYTES, reapRun, type FileOp } from '../market/broker.js';
import { listAgents, toGenome } from '../market/firms.js';
import { startEgress, type Egress } from '../market/egress.js';
import { DEPENDENCY_FILES, installDeps, type RunContext } from '../market/install.js';
import { redact } from '../market/jobs.js';
import type { RunLogLine } from '../market/provider.js';
import { BASE_SCRATCH } from '../market/sandbox.js';
import { controlFiles, createBaseDir, engineGit, ENGINE_GIT_FLAGS, recordGitConfig, removeOwned } from '../market/worktree.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import type { BeagleApi, BeagleArena, BeagleGenome, BeagleSplit, BeagleToolSpec } from './beagle-api.js';
import { loadBeagle } from './beagle.js';
import { isSourceFile, verifiedChanges, type VerifiedChange } from './history.js';
import { isTestFile } from '../audit/schema.js';
import { mutable, mutate, shuffled, type Mutant } from './mutants.js';
import { registerAbort, TURNED_OFF_REASON } from './tick.js';
import { ENGINE_STOPPED_REASON, holdTrain, liveTrains, readGate, takeMachine } from './trainer.js';

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
  kind: 'planted';
  failing: string[];
}

/** What a past task shows the agent: the change's test diff and how it fails at the parent, never the fix. */
export interface PastInput {
  kind: 'past';
  repo: string;
  test: string;
  /** `git diff parent sha` of the change's test files. */
  tests: string;
  failing: string[];
  output: string;
}

/** What a past task's grade knows: the change, its files, and the fix (the change's diff of its other files). */
export interface PastTruth {
  kind: 'past';
  /** The verified ref: `pr:<n>`, `city:<jobId>` or `commit:<sha>`. */
  ref: string;
  sha: string;
  parent: string;
  testFiles: string[];
  sourceFiles: string[];
  failing: string[];
  fix: string;
  /** Every commit the change brought in (`git rev-list parent..sha`): a merge's inner commits with it. */
  commits: string[];
}

export interface ArenaTask {
  id: string;
  arena: string;
  split: BeagleSplit;
  /** The PR number or sha a past change came from (Task 20); null for a planted bug. */
  ref: string | null;
  input: PlantedInput | PastInput;
  truth: PlantedTruth | PastTruth;
}

/** `skipped`: the bug could not be planted safely (its file is a link, or resolves outside the clone). */
export type CandidateState = 'untried' | 'kept' | 'dropped' | 'skipped';

export interface Candidate {
  /** Stable within the arena: a hash of the file, line and planted text. */
  key: string;
  mutant: Mutant;
  state: CandidateState;
  failing: string[];
  output: string;
}

/** A verified change tried as a past task. */
export interface PastCandidate {
  key: string;
  change: VerifiedChange;
  testFiles: string[];
  sourceFiles: string[];
  /** The diffs, read from the base's objects when the change is planted as a candidate. */
  tests: string;
  fix: string;
  /** `git rev-list parent..sha`, 40 hex only. */
  commits?: string[];
  state: CandidateState;
  /** Why a candidate was skipped without grading (its dependencies moved), or null. */
  reason?: string | null;
  failing: string[];
  output: string;
}

interface BuildState {
  /** Absent in a planted build from before Task 20. */
  kind?: ArenaInfo['kind'];
  id: string;
  repo: string;
  sha: string | null;
  installed: boolean;
  headPassed: boolean;
  /**
   * The wall time of a full passing suite run, which sets each grade's cap:
   * the head's for planted bugs; for past changes, the first candidate run
   * that passed (the head is never required to pass). Null before one ran.
   */
  headMs?: number | null;
  candidates: Candidate[] | null;
  past?: PastCandidate[] | null;
  startedAt: string;
}

/** The model a build's wall time is charged under: local, sized 0 GB (no model runs). */
export const ARENA_BUILD_MODEL: ModelRef = 'mlx:arena-build';

/**
 * Each mutant's grade is cut at max(floor, factor x the head suite's wall
 * time) plus slack, never past CHECK_MS: a planted bug that makes the suite
 * hang is dropped quickly. Races grade at the full CHECK_MS (ruling 21).
 */
const MUTANT_CAP = { floorMs: 60_000, factor: 5, slackMs: 10_000 };
const MUTANT_CAP_DEFAULT = { ...MUTANT_CAP };

/** Replaces the mutant cap's floor and slack (tests); null restores them. */
export function setMutantCap(o: { floorMs: number; slackMs: number } | null): void {
  Object.assign(MUTANT_CAP, o ?? MUTANT_CAP_DEFAULT);
}

/** How long one mutant's grade may run, from the head suite's wall time. */
export function mutantCapMs(headMs: number | null | undefined): number {
  const base = Math.max(MUTANT_CAP.floorMs, MUTANT_CAP.factor * (headMs ?? 0));
  return Math.min(CHECK_MS, base + MUTANT_CAP.slackMs);
}

/** A diff a past task keeps (its test diff, its fix): at most this many characters. */
const MAX_DIFF = 24_000;

/** Source files larger than this are not mutated (a generated or vendored file, most likely). */
const MAX_SOURCE_BYTES = 200_000;
/** The test output a task keeps: its tail. */
const MAX_OUTPUT = 4_000;
const SHA = /^[0-9a-f]{40}$/;

/** The one build running now, if any. */
let live: { id: string; repo: string } | null = null;

/** Why a build is refused while another train holds the machine (shared with the district page). */
export { BUSY_REFUSAL };

/** How often a build reads the gate while a grade runs (GATE.pollMs; tests shorten it). */
let gatePollMs: number = GATE.pollMs;

/** Replaces how often a build reads the gate mid-grade (tests); null restores GATE.pollMs. */
export function setArenaGatePoll(ms: number | null): void {
  gatePollMs = ms ?? GATE.pollMs;
}

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

/** What a past-change build has tried so far, change by change. */
export function pastCandidatesOf(id: string): PastCandidate[] {
  return readState(id)?.past ?? [];
}

/**
 * Every ref and sha in any sealed split (ruling 25): a LoRA example from one
 * of these changes would let the adapter see a sealed answer. For each
 * sealed past task: the task's ref (the PR number or sha), history's ref
 * (`pr:<n>`, `commit:<sha>`, `city:<jobId>`), the change's sha, and every
 * commit it brought in (a merge's inner commits too).
 */
export function sealedRefs(): Set<string> {
  const out = new Set<string>();
  const rows = openDb().prepare("SELECT ref, json FROM arena_tasks WHERE split = 'sealed'").all() as Array<{ ref: string | null; json: string }>;
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) out.add(v);
  };
  for (const r of rows) {
    add(r.ref);
    try {
      const truth = (JSON.parse(r.json) as { truth?: { ref?: unknown; sha?: unknown; commits?: unknown } }).truth;
      add(truth?.ref);
      add(truth?.sha);
      if (Array.isArray(truth?.commits)) for (const c of truth.commits) add(c);
    } catch {
      // a row that does not parse names nothing more
    }
  }
  return out;
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
  return arenaRefusal(repo, getSettings().school.enabled);
}

function refused(repo: Repo, reason: string, now: number, kind: ArenaInfo['kind'] = 'planted'): ArenaInfo {
  return {
    id: '',
    repo: repo.fullName,
    kind,
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
  /** The bug was not planted: its file is a link or resolves outside the clone. */
  skipped: boolean;
  /** The command's wall time. */
  ms: number;
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
/** What a grade does to its fresh clone before the suite runs: null when ready, else why it was not set up (skipped). */
type Prepare = (dir: string) => Promise<string | null>;

/** Plants `mutant` in the clone, never through a link. */
const plantIn = (mutant: Mutant): Prepare => async (dir) => {
  const p = insideClone(dir, mutant.file);
  if (!p) return `${mutant.file} is a link or lies outside the clone; nothing was written`;
  const lines = readFileSync(p, 'utf8').split('\n');
  if (lines[mutant.line - 1] !== mutant.original) return `${mutant.file}:${mutant.line} is not the line this bug was planted in`;
  lines[mutant.line - 1] = mutant.mutated;
  writeFileSync(p, lines.join('\n'));
  return null;
};

async function grade(id: string, repo: Repo, prepare: Prepare | null, timeoutMs: number, signal: AbortSignal, log: (l: RunLogLine) => void): Promise<Graded> {
  const runId = gradeRunId(id);
  const runRoot = join(paths().runs, runId);
  // The root is made once per session; each grade gets a fresh clone (execTool reaps after every command).
  for (const d of ['tmp', 'ctmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  controlFilesFor(runId);
  const dir = join(runRoot, 'repo');
  removeOwned(dir);
  // An APFS clone of each file where the disk can; links stay links, never pointed back at the base.
  cpSync(arenaBase(id), dir, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  // No code has run in this clone yet: its .git/config is the base's, recorded so engine git trusts it.
  recordGitConfig(dir);
  try {
    if (prepare) {
      const why = await prepare(dir);
      if (why) return { skipped: true, failed: false, passed: false, aborted: false, ms: 0, output: why };
    }
    const t0 = Date.now();
    const r = await execTool({ runId, runRoot, dir, command: repo.checks?.test ?? '', timeoutMs, stage: 'checks', signal, log });
    const ms = Date.now() - t0;
    const aborted = signal.aborted;
    // A suite cut at its cap may exit non-zero on the SIGTERM: that is a hang, never a catch.
    if (ms >= timeoutMs || r.stderr.includes('[palimpsest] timed out after')) {
      return { skipped: false, ms, failed: false, passed: false, aborted, output: `the suite ran past ${Math.round(timeoutMs / 1000)} s` };
    }
    const output = scrub(`${r.stdout}\n${r.stderr}`, [dir, runRoot]);
    return { skipped: false, ms, failed: !aborted && r.refused === null && r.code !== null && r.code !== 0, passed: !aborted && r.refused === null && r.code === 0, aborted, output };
  } finally {
    removeOwned(dir);
  }
}

/**
 * The path of `file` in `dir` when it is a regular file (not a link) that
 * resolves inside `dir`, link-free all the way; else null.
 */
function insideClone(dir: string, file: string): string | null {
  const p = join(dir, file);
  try {
    if (!lstatSync(p).isFile()) return null;
    // The on-disk spelling: APFS ignores case, so `Test/x.js` would open `test/x.js`.
    const root = realpathSync.native(dir);
    const real = realpathSync.native(p);
    return real.startsWith(root + sep) && real === join(root, file) ? p : null;
  } catch {
    return null;
  }
}

/** Test output with no path of this Mac in it, cut to its tail (`max` characters). */
function scrub(text: string, dirs: string[], max = MAX_OUTPUT): string {
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
  return s.length > max ? s.slice(-max) : s;
}

// ---------------------------------------------------------------- the base

/** The head of the repo's default branch in the mirror (after a sync). */
async function headSha(repo: Repo): Promise<string> {
  await syncMirror(repo.fullName);
  const r = await getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), 'rev-parse', `refs/heads/${repo.defaultBranch}`], { timeoutMs: 60_000, env: mirrorReadEnv() });
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
async function plant(id: string, sha: string, command: string): Promise<Candidate[]> {
  const base = arenaBase(id);
  const ls = await engineGit(base, ['ls-files', '-z']);
  if (ls.code !== 0) throw new Error(`could not list the files at ${sha.slice(0, 7)}: ${ls.stderr.trim()}`);
  const seed = parseInt(sha.slice(0, 8), 16) >>> 0;
  const all: Mutant[] = [];
  for (const file of ls.stdout.split('\0').filter(Boolean).sort()) {
    // A racer may not edit test files or their configuration, so no bug is planted there.
    if (!mutable(file) || protectedReason(file, command)) continue;
    const p = join(base, file);
    let text: string;
    try {
      // Never a link: a bug is planted only in a regular file that stays inside the clone.
      const st = lstatSync(p);
      if (!st.isFile() || st.size > MAX_SOURCE_BYTES || !insideClone(base, file)) continue;
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

// ---------------------------------------------------------------- past changes

/** git on the mirror, as the engine reads it (hardened flags, argv only). */
async function mirrorGit(repo: Repo, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), ...args], { timeoutMs: 120_000, env: mirrorReadEnv() });
}

/** A commit's parents and committer time (seconds), from the mirror. */
async function commitOf(repo: Repo, sha: string): Promise<{ parents: string[]; ct: number } | null> {
  if (!SHA.test(sha)) return null;
  const r = await mirrorGit(repo, ['show', '-s', '--format=%P%x1f%ct', sha]);
  if (r.code !== 0) return null;
  const [parents, ct] = r.stdout.trim().split('\x1f');
  return { parents: (parents ?? '').split(' ').filter((p) => SHA.test(p)), ct: Number(ct) };
}

/**
 * Whether a PR's change is the last commit of a rebase merge: one parent,
 * and that parent itself a one-parent commit written in the same second (a
 * rebase merge writes every rebased commit at once). Its parent is then the
 * PR's own commit, not the branch before the PR, so the task base would
 * already hold part of the PR (ruling 20). A merge commit or a squash, whose
 * parent is the branch, is not.
 */
async function rebasedPR(repo: Repo, c: VerifiedChange): Promise<boolean> {
  if (c.kind !== 'pr') return false;
  const me = await commitOf(repo, c.sha);
  if (!me || me.parents.length !== 1) return false;
  const parent = await commitOf(repo, me.parents[0]);
  if (!parent) return true;
  return parent.parents.length === 1 && parent.ct === me.ct;
}

/** The task ref of a verified change: a PR's number, else its sha. */
function refOf(c: VerifiedChange): string {
  return c.kind === 'pr' ? c.ref.slice('pr:'.length) : c.sha;
}

/**
 * His verified changes that touched source and tests, newest first, each
 * with its test diff and fix read from the base's objects. A rebase-merged
 * PR, a change whose test files are links (mode 120000) or absent at the
 * change, and one whose parent is not 40 hex are left out.
 */
async function plantPast(id: string, repo: Repo, head: string, now: number, signal: AbortSignal): Promise<PastCandidate[]> {
  const base = arenaBase(id);
  const changes = await verifiedChanges(repo, now, { check: true, signal });
  const out: PastCandidate[] = [];
  for (const c of [...changes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.sha.localeCompare(b.sha))) {
    if (!SHA.test(c.sha) || !SHA.test(c.parent) || !c.touchesTests) continue;
    const sourceFiles = c.files.filter(isSourceFile);
    const tests = c.files.filter(isTestFile);
    if (sourceFiles.length === 0 || tests.length === 0) continue;
    // A fix a racer could not make (it touches test configuration or a runner file) is no task.
    if (sourceFiles.some((f) => protectedReason(f, repo.checks?.test ?? ''))) continue;
    if (await rebasedPR(repo, c)) continue;
    // Only test files the change leaves as regular files: never a link, never one it deleted.
    const tree = await engineGit(base, ['ls-tree', c.sha, '--', ...tests]);
    if (tree.code !== 0) continue;
    const modes = new Map(tree.stdout.split('\n').filter(Boolean).map((l) => [l.slice(l.indexOf('\t') + 1), l.split(' ')[0]]));
    const testFiles = tests.filter((f) => modes.get(f) === '100644' || modes.get(f) === '100755');
    if (testFiles.length !== tests.length) continue;
    const testDiff = await engineGit(base, ['diff', '--no-ext-diff', '--no-textconv', c.parent, c.sha, '--', ...testFiles]);
    const fixDiff = await engineGit(base, ['diff', '--no-ext-diff', '--no-textconv', c.parent, c.sha, '--', ...sourceFiles]);
    if (testDiff.code !== 0 || fixDiff.code !== 0) continue;
    // The base carries the head's install: a change whose parent or self has other manifests or lockfiles is not graded on it.
    const moved = await movedDeps(base, head, [c.parent, c.sha]);
    const revs = await engineGit(base, ['rev-list', `${c.parent}..${c.sha}`]);
    if (revs.code !== 0) continue;
    const commits = revs.stdout.split('\n').map((l) => l.trim()).filter((l) => SHA.test(l));
    if (!commits.includes(c.sha)) continue;
    out.push({
      key: c.sha.slice(0, 12),
      change: c,
      testFiles,
      sourceFiles,
      tests: testDiff.stdout.slice(0, MAX_DIFF),
      fix: fixDiff.stdout.slice(0, MAX_DIFF),
      commits,
      state: moved.length ? 'skipped' : 'untried',
      reason: moved.length ? `Its dependencies differ from the head's (${moved.join(', ')}), whose install the arena grades on` : null,
      failing: [],
      output: '',
    });
  }
  return out;
}

/** The dependency manifests and lockfiles that differ between `head` and any of `shas`, from the base's objects. */
async function movedDeps(base: string, head: string, shas: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const sha of shas) {
    if (sha === head) continue;
    const d = await engineGit(base, ['diff', '--no-ext-diff', '--name-only', '-z', sha, head]);
    if (d.code !== 0) return ['the diff could not be read'];
    for (const f of d.stdout.split('\0').filter(Boolean)) if (DEPENDENCY_FILES.has(f.split('/').pop() ?? f)) out.add(f);
  }
  return [...out].sort();
}

/** The task base: the change's parent with the change's test files applied, all from the clone's own objects. */
const atParentWithTests = (c: PastCandidate): Prepare => (dir) => pastTaskTree(dir, { parent: c.change.parent, sha: c.change.sha, testFiles: c.testFiles });

/**
 * Turns a fresh clone of the arena base into a past task's working tree:
 * the change's parent with the change's test files applied, then the
 * clone's `.git` removed, so no object of the fix (nor any later commit)
 * can be reached from the task's directory by any tool. Task 21 makes each
 * task directory the same way. Null when ready, else why not.
 */
export async function pastTaskTree(dir: string, t: Pick<PastTruth, 'parent' | 'sha' | 'testFiles'>): Promise<string | null> {
  if (!SHA.test(t.parent) || !SHA.test(t.sha)) return 'the change names no commit';
  const co = await engineGit(dir, ['checkout', '--quiet', '--force', '--detach', t.parent]);
  if (co.code !== 0) return `could not check out ${t.parent.slice(0, 7)}: ${co.stderr.trim()}`;
  const tests = await engineGit(dir, ['checkout', t.sha, '--', ...t.testFiles]);
  if (tests.code !== 0) return `could not apply the tests of ${t.sha.slice(0, 7)}: ${tests.stderr.trim()}`;
  for (const f of t.testFiles) if (!insideClone(dir, f)) return `${f} is a link or lies outside the clone`;
  // The history goes: the tree is the parent's state and the tests, in one fresh commit with nothing behind it.
  return freshHistory(dir);
}

/** The committer of a task copy's one commit. */
const TASK_IDENTITY = ['-c', 'user.name=Palimpsest', '-c', 'user.email=arena@palimpsest.invalid'];

/**
 * Replaces the clone's history with one fresh commit of its tracked files
 * as they stand now (the task's state): the old `.git` is removed whole, so
 * no object of the head, the fix or any later commit is left, and a repo
 * whose tests need git still has one. Null when done, else why not.
 */
async function freshHistory(dir: string): Promise<string | null> {
  const ls = await engineGit(dir, ['ls-files', '-z']);
  if (ls.code !== 0) return `could not list the task's files: ${ls.stderr.trim()}`;
  const files = ls.stdout.split('\0').filter(Boolean);
  removeOwned(join(dir, '.git'));
  if (existsSync(join(dir, '.git'))) return 'the clone history could not be removed';
  const init = await getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', dir, 'init', '--quiet'], { timeoutMs: 60_000 });
  if (init.code !== 0) return `could not start the task's history: ${init.stderr.trim()}`;
  recordGitConfig(dir);
  for (let i = 0; i < files.length; i += 500) {
    const add = await engineGit(dir, ['--literal-pathspecs', 'add', '--force', '--', ...files.slice(i, i + 500).filter((f) => existsSync(join(dir, f)) || isLink(join(dir, f)))]);
    if (add.code !== 0) return `could not record the task's files: ${add.stderr.trim()}`;
  }
  const commit = await engineGit(dir, [...TASK_IDENTITY, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '-m', 'The task']);
  if (commit.code !== 0) return `could not commit the task's files: ${commit.stderr.trim()}`;
  return null;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The change itself. */
const atChange = (c: PastCandidate): Prepare => async (dir) => {
  const co = await engineGit(dir, ['checkout', '--quiet', '--force', '--detach', c.change.sha]);
  return co.code === 0 ? null : `could not check out ${c.change.sha.slice(0, 7)}: ${co.stderr.trim()}`;
};

// ---------------------------------------------------------------- Beagle

/**
 * Beagle's `sealedHash` of the arena, with the real arena registered
 * (`toBeagleArena`): Beagle reads the sealed split through `Arena.data`,
 * which is the arena id.
 */
function sealedHashOf(b: BeagleApi, info: Pick<ArenaInfo, 'id' | 'repo' | 'kind'>): string {
  registerOne(b, info);
  return b.race.sealedHash(info.id);
}

/** Writes the kept bugs as tasks, to `arena_tasks` and to Beagle's store; returns the counts by split and Beagle's sealed hash. */
async function writeTasks(id: string, repo: Repo, kept: Candidate[], past: PastCandidate[]): Promise<{ counts: ArenaInfo['tasks']; sealedHash: string }> {
  const b = await loadBeagle();
  const test = repo.checks?.test ?? '';
  const planted: ArenaTask[] = kept.map((c) => {
    const taskId = `${id}:${c.key}`;
    return {
      id: taskId,
      arena: id,
      split: b.arenas.splitOf(taskId),
      ref: null,
      input: { kind: 'planted', repo: repo.fullName, test, failing: c.failing, output: c.output },
      truth: { kind: 'planted', ...c.mutant, failing: c.failing },
    };
  });
  const fromPast: ArenaTask[] = past.map((c) => {
    const taskId = `${id}:${c.key}`;
    return {
      id: taskId,
      arena: id,
      split: b.arenas.splitOf(taskId),
      ref: refOf(c.change),
      input: { kind: 'past', repo: repo.fullName, test, tests: c.tests, failing: c.failing, output: c.output },
      truth: { kind: 'past', ref: c.change.ref, sha: c.change.sha, parent: c.change.parent, testFiles: c.testFiles, sourceFiles: c.sourceFiles, failing: c.failing, fix: c.fix, commits: c.commits ?? [c.change.sha] },
    };
  });
  const tasks = [...planted, ...fromPast];
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
  b.store.putArena(id, `${repo.fullName}: ${past.length ? 'past changes' : 'planted bugs'}`);
  b.store.putTasks(id, tasks.map((t) => ({ id: t.id, input: t.input, truth: t.truth, split: t.split })));
  const counts = { breeding: 0, race: 0, sealed: 0 };
  for (const t of tasks) counts[t.split]++;
  return { counts, sealedHash: sealedHashOf(b, { id, repo: repo.fullName, kind: past.length ? 'past' : 'planted' }) };
}

// ---------------------------------------------------------------- the build

function newId(repo: Repo, kind: ArenaInfo['kind']): string {
  const slug = repo.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${kind}-${slug}-${randomUUID().slice(0, 6)}`;
}

const kindOf = (s: BuildState): ArenaInfo['kind'] => s.kind ?? 'planted';

function infoOf(s: BuildState, status: ArenaInfo['status'], reason: string | null, at: number, extra: Partial<ArenaInfo> = {}): ArenaInfo {
  const c: Array<{ state: CandidateState }> = kindOf(s) === 'past' ? (s.past ?? []) : (s.candidates ?? []);
  return {
    id: s.id,
    repo: s.repo,
    kind: kindOf(s),
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

/** The paused arena of `repo` of this kind, if it has one. */
function pausedOf(fullName: string, kind: ArenaInfo['kind']): BuildState | null {
  for (const a of listArenas(fullName)) {
    if (a.kind === kind && a.status === 'paused') return readState(a.id);
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
export function buildPlanted(repo: Repo, now: number, o: { signal?: AbortSignal } = {}): Promise<ArenaInfo> {
  return build('planted', repo, now, o);
}

/**
 * Builds (or resumes) a past-change arena from `repo` (ruling 20): his
 * verified changes that touched source and tests, kept when the change's
 * tests fail at its parent and pass at the change; at most ARENA.keepPast.
 * Everything is read from the mirror; nothing else is fetched. Refused,
 * gated, paused and resumed as `buildPlanted` is.
 */
export function buildPast(repo: Repo, now: number, o: { signal?: AbortSignal } = {}): Promise<ArenaInfo> {
  return build('past', repo, now, o);
}

async function build(kind: ArenaInfo['kind'], repo: Repo, now: number, o: { signal?: AbortSignal }): Promise<ArenaInfo> {
  // a graduation's sealed race holds the graduates' server: a build would take the machine from under it
  if (liveTrains().some((t) => t.kind === 'eval')) return refused(repo, RACE_REFUSAL, now, kind);
  const why = refusal(repo);
  if (why) return refused(repo, why, now, kind);
  if (live) return refused(repo, `An arena is already being built (${live.repo})`, now, kind);
  // one train at a time (the school's rule): a build waits for the nets, a LoRA or a voyage, as they wait for it
  if (liveTrains().length > 0) return refused(repo, BUSY_REFUSAL, now, kind);

  const state: BuildState = pausedOf(repo.fullName, kind) ?? {
    kind,
    id: newId(repo, kind),
    repo: repo.fullName,
    sha: null,
    installed: false,
    headPassed: false,
    candidates: null,
    past: null,
    startedAt: new Date(now).toISOString(),
  };
  live = { id: state.id, repo: repo.fullName };
  const started = Date.now();
  const at = () => now + (Date.now() - started);
  const ctl = new AbortController();
  // the build is a train of kind arena: liveTrains() sees it, so the nets, a LoRA, a voyage and the tick wait,
  // and pauseAll (the stop file, the engine stopping) stops it as it stops any train
  const train: TrainState = { id: `train-arena-${randomUUID().slice(0, 8)}`, kind: 'arena', status: 'running', reason: null, startedAt: new Date(now).toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 };
  const unhold = holdTrain(train, (reason) => ctl.abort(reason));
  const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
  const onOuter = () => ctl.abort(o.signal?.reason ?? 'stopped');
  o.signal?.addEventListener('abort', onOuter, { once: true });
  const signal = ctl.signal;
  // the gate re-read every GATE.pollMs while a grade runs: closed or unreadable, the grade in flight is stopped
  const checkGate = async () => {
    if (signal.aborted) return;
    try {
      const g = await readGate('heavy', at());
      if (!g.ok && !signal.aborted) ctl.abort(g.reason ?? 'the gate closed');
    } catch (err) {
      if (!signal.aborted) ctl.abort(`the gate could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const gateTimer = setInterval(() => void checkGate(), gatePollMs);
  gateTimer.unref?.();
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
  let giveBack: () => void = () => {};
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

  /** Step 3 for past changes: each change graded at its parent with its tests, then at itself. */
  const buildPastTasks = async (): Promise<ArenaInfo> => {
    if (!state.past) {
      state.past = await plantPast(state.id, repo, state.sha ?? '', now, signal);
      if (signal.aborted) return await pause(stopReason());
      writeState(state);
    }
    // Until one candidate's suite has passed in full, a grade has the whole check time; after, the cap.
    const cap = () => (state.headMs == null ? CHECK_MS : mutantCapMs(state.headMs));
    const measure = (g: { passed: boolean; ms: number }) => {
      if (g.passed && state.headMs == null) state.headMs = g.ms;
    };
    for (const c of state.past) {
      if (c.state !== 'untried') continue;
      if (state.past.filter((x) => x.state === 'kept').length >= ARENA.keepPast) break;
      if (signal.aborted) return await pause(stopReason());
      const g0 = await readGate('heavy', at());
      if (!g0.ok) return await pause(g0.reason ?? 'the gate closed');
      const before = await grade(state.id, repo, atParentWithTests(c), cap(), signal, log);
      if (before.aborted) return await pause(stopReason());
      measure(before);
      if (before.skipped || !before.failed) {
        c.state = before.skipped ? 'skipped' : 'dropped';
        writeState(state);
        continue;
      }
      const after = await grade(state.id, repo, atChange(c), cap(), signal, log);
      if (after.aborted) return await pause(stopReason());
      measure(after);
      c.state = after.skipped ? 'skipped' : after.passed ? 'kept' : 'dropped';
      c.failing = c.state === 'kept' ? failingTests(before.output) : [];
      c.output = c.state === 'kept' ? before.output : '';
      writeState(state);
    }
    await clearRoot(gradeRunId(state.id));
    const kept = state.past.filter((x) => x.state === 'kept');
    if (kept.length === 0) return await fail('None of his verified changes has a test that fails before it and passes after');
    const { counts, sealedHash } = await writeTasks(state.id, repo, [], kept);
    writeState(state);
    return putInfo(infoOf(state, 'ready', null, at(), { tasks: counts, sealedHash }));
  };

  try {
    // the row says building from the start, so the screens show it and a crash leaves something to pause and resume
    writeState(state);
    putInfo(infoOf(state, 'building', null, now));
    const first = await readGate('heavy', at());
    if (!first.ok) return await pause(first.reason ?? 'the gate closed');
    // the build is a heavy train: the graduates' server (ruling 26) ends its calls, stops, and stays down until it ends
    giveBack = await takeMachine('an arena build');
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
    // Past changes grade at their own parents: the head need not pass (the cap comes from a candidate run).
    if (kind === 'past') return await buildPastTasks();
    if (!state.headPassed) {
      const g = await grade(state.id, repo, null, CHECK_MS, signal, log);
      if (g.aborted) return await pause(stopReason());
      if (!g.passed) return await fail(`The tests do not pass at the head (${state.sha.slice(0, 7)}), so a failing task cannot be told apart`);
      state.headPassed = true;
      state.headMs = g.ms;
      writeState(state);
    }
    if (!state.candidates) {
      state.candidates = await plant(state.id, state.sha, repo.checks?.test ?? '');
      writeState(state);
    }

    for (const c of state.candidates) {
      if (c.state !== 'untried') continue;
      if (state.candidates.filter((x) => x.state === 'kept').length >= ARENA.keepPlanted) break;
      if (signal.aborted) return await pause(stopReason());
      const g0 = await readGate('heavy', at());
      if (!g0.ok) return await pause(g0.reason ?? 'the gate closed');
      const g = await grade(state.id, repo, plantIn(c.mutant), mutantCapMs(state.headMs), signal, log);
      if (g.aborted) return await pause(stopReason());
      c.state = g.skipped ? 'skipped' : g.failed ? 'kept' : 'dropped';
      c.failing = g.failed ? failingTests(g.output) : [];
      c.output = g.failed ? g.output : '';
      writeState(state);
    }

    await clearRoot(gradeRunId(state.id));
    const kept = state.candidates.filter((x) => x.state === 'kept');
    if (kept.length === 0) return await fail('None of the planted bugs made the tests fail');
    const { counts, sealedHash } = await writeTasks(state.id, repo, kept, []);
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
    giveBack();
    clearInterval(gateTimer);
    o.signal?.removeEventListener('abort', onOuter);
    unregister();
    unhold();
    live = null;
  }
}

/**
 * At engine start: a build the last engine was running when it stopped can
 * never report again. Its `building` row becomes `paused` with
 * `ENGINE_STOPPED_REASON` (recorded), so `resumeArenas` goes on with it under
 * its own id, its state and base kept. Returns the arenas it moved.
 */
export function pauseStrandedBuilds(now: number = Date.now()): ArenaInfo[] {
  const out: ArenaInfo[] = [];
  for (const a of listArenas()) {
    if (a.status !== 'building' || live?.id === a.id) continue;
    out.push(putInfo({ ...a, status: 'paused', reason: ENGINE_STOPPED_REASON, builtAt: new Date(now).toISOString() }));
  }
  return out;
}

/**
 * Resumes each paused arena (planted or past) whose repo still qualifies, one after
 * another, each while the heavy gate holds (a later night's work; never a
 * new arena, which only his click builds). Returns the arenas it moved.
 */
export async function resumeArenas(now: number): Promise<ArenaInfo[]> {
  const out: ArenaInfo[] = [];
  for (const a of listArenas()) {
    if (a.status !== 'paused' || live) continue;
    const repo = getRepo(a.repo);
    if (!repo || refusal(repo)) continue;
    const g = await readGate('heavy', now);
    if (!g.ok) break;
    out.push(await build(a.kind, repo, now, {}));
  }
  return out;
}

/** The repos an arena could be built from now (connected, market on, with a test command). */
export function arenaRepos(): Repo[] {
  return listRepos().filter((r) => refusal(r) === null);
}

// ---------------------------------------------------------------- racing (ruling 21)

/** The turns a racing agent gets on an arena task (ruling 21). */
export const ARENA_MAX_TURNS = 24;
/** The most any one tool call returns to a racer (the broker's own per-stream cap, 64 KB); past it, the tail is kept. */
export const ARENA_TOOL_OUTPUT = MAX_RETURN_BYTES;
/** The arena's tools, by Beagle's names. */
export const ARENA_TOOLS = ['read_file', 'list_files', 'search', 'run_tests'] as const;
/** A Palimpsest agent's tool as the arena's: edit and write have none here, since the answer is the edit. */
const TOOL_OF: Record<string, (typeof ARENA_TOOLS)[number]> = { read: 'read_file', glob: 'list_files', grep: 'search', run: 'run_tests' };
/** The most lines read_file returns in one call. */
const READ_LINES = 400;
/** At most this many edits in one answer. */
const MAX_EDITS = 50;
/**
 * The grade's suite is cut this long before Beagle's grader timeout
 * (`graderTimeoutMs`, CHECK_MS), so a hanging suite is killed and scored 0
 * by the grade itself, with its clone removed, rather than left running
 * after Beagle gives up on the grade.
 */
const GRADE_MARGIN_MS = 30_000;

export interface ArenaEdit {
  file: string;
  find: string;
  replace: string;
}

/** The arenas this process registered with Beagle. */
const registered = new Set<string>();

/** The task trees the read tools look at, one per task, kept for a race's later turns. */
const views = new Map<string, Promise<Scratch | { error: string }>>();
/** Every scratch run root this process has open (views, run_tests, grades). */
const liveScratch = new Set<string>();
let exitHook = false;

interface Scratch {
  runId: string;
  runRoot: string;
  dir: string;
}

const noLog = (_l: RunLogLine) => {};

/** An arena task by its id. */
function taskById(id: string): ArenaTask | null {
  const row = openDb().prepare('SELECT json FROM arena_tasks WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as ArenaTask) : null;
}

/**
 * A fresh scratch clone of the arena base, under its own run root, made into
 * the task's tree: a planted bug planted (never through a link), or a past
 * change's parent with its tests applied (`pastTaskTree`). In both the
 * clone's history is replaced by one fresh commit of the task's state
 * (`freshHistory`), so nothing can reach the head or the fix.
 */
async function scratchFor(arenaId: string, truth: PlantedTruth | PastTruth, purpose: 'view' | 'try' | 'grade'): Promise<Scratch | { error: string }> {
  const base = arenaBase(arenaId);
  if (!existsSync(base)) return { error: 'This arena has no base any more; it must be built again' };
  const runId = `arena-${arenaId}-${purpose}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(paths().runs, runId);
  liveScratch.add(runId);
  try {
    for (const d of ['tmp', 'ctmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
    controlFilesFor(runId);
    const dir = join(runRoot, 'repo');
    cpSync(base, dir, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    // No code has run in this clone yet: its .git/config is the base's.
    recordGitConfig(dir);
    const why = truth.kind === 'past' ? await pastTaskTree(dir, truth) : await plantedTaskTree(dir, truth);
    if (why) {
      await dropScratch(runId);
      return { error: noLocalPaths(why) };
    }
    return { runId, runRoot, dir };
  } catch (err) {
    await dropScratch(runId);
    return { error: noLocalPaths(`the task's copy could not be made: ${(err as Error).message}`) };
  }
}

/** The planted bug's tree: the bug written in (only into a regular file inside the clone), then one fresh commit of it as its whole history. */
async function plantedTaskTree(dir: string, truth: Mutant): Promise<string | null> {
  const why = await plantIn(truth)(dir);
  if (why) return why;
  return freshHistory(dir);
}

async function dropScratch(runId: string): Promise<void> {
  await clearRoot(runId);
  liveScratch.delete(runId);
}

/**
 * A path a racer named, as a clean path relative to the clone, or null when
 * it is absolute, climbs out (`..`), or names `.git`.
 */
function relPath(path: unknown): string | null {
  if (path === undefined || path === null || path === '') return '.';
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) return null;
  const n = normalize(path).replace(/\/+$/, '');
  if (n === '.' || n === '') return '.';
  if (n === '..' || n.startsWith(`..${sep}`)) return null;
  if (n.split('/').some((p) => p.toLowerCase() === '.git')) return null;
  return n;
}

/**
 * Whether `rel` lies under the clone with no link anywhere on the way: each
 * component is lstat-ed (a symlink refuses), and the realpath must be the
 * clone's realpath joined with `rel`. `want` names what it must be.
 */
function underClone(dir: string, rel: string, want: 'file' | 'dir' | 'any'): boolean {
  try {
    // The on-disk spelling, so a path in another case (APFS ignores case) is refused.
    const root = realpathSync.native(dir);
    if (rel === '.') return want !== 'file';
    let at = dir;
    for (const part of rel.split('/')) {
      at = join(at, part);
      if (lstatSync(at).isSymbolicLink()) return false;
    }
    const st = lstatSync(at);
    if (want === 'file' && !st.isFile()) return false;
    if (want === 'dir' && !st.isDirectory()) return false;
    if (want === 'any' && !st.isFile() && !st.isDirectory()) return false;
    return realpathSync.native(at) === join(root, rel);
  } catch {
    return false;
  }
}

const OUTSIDE = "The path is a link, lies outside the task's copy, or is not there; file tools never follow a link.";

/** Folders whose files are tests or test support, at any depth, compared lower-cased (APFS ignores case). */
const ARENA_TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__', 'fixtures']);
/** Test configuration and runner files, by lower-cased name. */
const TEST_CONFIG = [
  /^conftest\.py$/,
  /\.config\.[^.]+$/,
  /^\.[^/]*rc(\.[^.]+)?$/,
  /^(mocharc|nycrc|c8rc|avarc|jestrc|vitestrc|karmarc|babelrc|swcrc|eslintrc|prettierrc|stylelintrc|npmrc|yarnrc|pnpmrc|coveragerc|pylintrc|flake8rc)(\.[^.]+)?$/,
  /^setuptests\./,
  /^test-setup\./,
  /^(jest|vitest|karma)\./,
  /\.sh$/,
  /^package\.json$/,
  /^(pytest|tox)\.ini$/,
  /^makefile$/,
];
const TESTS_REFUSED = 'the tests may not be changed';
const CONFIG_REFUSED = 'test configuration and runner files may not be changed';

/** The repo paths a test command names (`node --test test/a.js`, `sh scripts/check.sh`), relative and lower-cased; only a file named whole is protected by it, never a folder's contents. */
function commandPaths(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;&|()]+/)) {
    let tok = raw.replace(/^['"]|['"]$/g, '');
    if (!tok || tok.startsWith('-') && !tok.includes('=')) continue;
    if (tok.includes('=')) tok = tok.slice(tok.indexOf('=') + 1);
    const rel = relPath(tok);
    if (rel && rel !== '.' && /[/.]/.test(rel)) out.push(rel.toLowerCase());
  }
  return out;
}

/**
 * Why a racer may not edit `rel` (ruling 21), or null: a test file or a
 * file in a test folder (its setup files with it), test configuration or a
 * runner file (setup only by a test setup name: `setupTests.*`,
 * `test-setup.*`, `jest.setup.*`, `vitest.setup.*`), or a file the
 * declared test command names (never a whole folder it names). Every
 * comparison is on the path lower-cased, since APFS ignores case.
 */
export function protectedReason(rel: string, command: string): string | null {
  const lower = rel.toLowerCase();
  const parts = lower.split('/');
  const name = parts[parts.length - 1];
  if (isTestFile(rel) || isTestFile(lower) || parts.slice(0, -1).some((p) => ARENA_TEST_FOLDERS.has(p))) return TESTS_REFUSED;
  if (TEST_CONFIG.some((re) => re.test(name))) return CONFIG_REFUSED;
  for (const c of commandPaths(command)) if (lower === c) return CONFIG_REFUSED;
  return null;
}

/**
 * Applies an answer's edits to a scratch clone (ruling 21): source files
 * only, never a test file, test configuration or a file the test command
 * names (`protectedReason`), never through a link, outside the clone or in
 * another case than the file's own, and each `find` exactly once in its
 * file. Null when all applied, else why not (and the clone is thrown away
 * by the caller).
 */
export function applyEdits(dir: string, edits: unknown, command: string): string | null {
  if (!Array.isArray(edits)) return 'edits must be a list';
  if (edits.length > MAX_EDITS) return `at most ${MAX_EDITS} edits`;
  for (const e of edits as Array<Partial<ArenaEdit> | null>) {
    if (!e || typeof e !== 'object' || typeof e.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') return 'each edit needs a file, a find and a replace';
    const file = relPath(e.file);
    if (!file || file === '.') return `${e.file} is not a file of the repository`;
    const asked = protectedReason(file, command);
    if (asked) return asked;
    if (!isSourceFile(file)) return `${file} is not a source file; only source files may be edited`;
    // The file as it is spelled on disk must be the file asked for, case and all.
    if (!underClone(dir, file, 'file')) return `there is no ${file} (in that spelling), or it is a link`;
    const p = insideClone(dir, file);
    if (!p) return `there is no ${file} (in that spelling), or it is a link`;
    if (e.find === '') return `the find text for ${file} is empty`;
    const text = readFileSync(p, 'utf8');
    const n = text.split(e.find).length - 1;
    if (n !== 1) return `the find text appears ${n} times in ${file}; it must appear exactly once`;
    writeFileSync(p, text.replace(e.find, () => e.replace!));
  }
  return null;
}

/** Folders a walk for protected files never enters: history and installed dependencies. */
const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox']);

/** Every regular file in the clone a racer may not edit (`protectedReason`), relative. */
function protectedFiles(dir: string, command: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!WALK_SKIP.has(d.name)) walk(r);
      } else if (d.isFile() && protectedReason(r, command)) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** Each protected file's content hash, to tell whether a run changed one. */
function fingerprint(dir: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    try {
      out.set(f, lstatSync(join(dir, f)).isFile() ? createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') : 'not a file');
    } catch {
      out.set(f, 'gone');
    }
  }
  return out;
}

/** The names of the tests that passed: TAP `ok`, node's and Jest's spec marks, pytest `PASSED`, Go `--- PASS`. */
export function passingTests(output: string): string[] {
  const out = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const tap = /^\s*ok \d+ - (.+?)(\s+#\s*(\S+).*)?$/.exec(line);
    if (tap && /^(skip|todo)$/i.test(tap[3] ?? '')) continue;
    const m =
      tap ??
      /^\s*[✔✓]\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/.exec(line) ??
      /^(\S+::\S+)\s+PASSED/.exec(line) ??
      /^PASSED\s+(\S+)/.exec(line) ??
      /^--- PASS: (\S+)/.exec(line);
    const name = m?.[1]?.trim();
    if (name) out.add(name);
  }
  return [...out];
}

interface SuiteRun {
  code: number | null;
  refused: string | null;
  timedOut: boolean;
  aborted: boolean;
  raw: string;
  /** The protected files (tests, their configuration) the run changed, created away or removed: any scores 0. */
  tampered: string[];
}

/**
 * His test command in a scratch clone, through `execTool` under the tool
 * profile. No egress runs for a scratch root, so its children's proxy is the
 * closed port 9: the tests have no network, as in the build's grading.
 */
async function runSuite(s: Scratch, command: string, timeoutMs: number, signal: AbortSignal): Promise<SuiteRun> {
  // The tests and their configuration are read-only to the code under test: the tool profile denies
  // writing them, and their content is compared after the run whatever the profile did.
  const guarded = protectedFiles(s.dir, command);
  const before = fingerprint(s.dir, guarded);
  const root = realpathSync.native(s.dir);
  const t0 = Date.now();
  const r = await execTool({ runId: s.runId, runRoot: s.runRoot, dir: s.dir, command, timeoutMs, stage: 'checks', signal, log: noLog, readOnly: guarded.map((f) => join(root, f)) });
  const timedOut = Date.now() - t0 >= timeoutMs || r.stderr.includes('[palimpsest] timed out after');
  const after = fingerprint(s.dir, guarded);
  const tampered = guarded.filter((f) => before.get(f) !== after.get(f));
  return { code: r.code, refused: r.refused, timedOut, aborted: signal.aborted, raw: `${r.stdout}\n${r.stderr}`, tampered };
}

/**
 * Ruling 21's grade, from one run of his suite on a pristine task tree with
 * only the answer's edits to allowed source files applied:
 *
 * - 1 when the suite passes (exit 0) and every target test is named among
 *   those that passed: the targets pass and nothing that passed at the
 *   task base fails;
 * - 0.5 when every target is named among those that passed and none among
 *   those that failed, but the suite fails: another test fails. Also 0.5,
 *   at most, when the suite exits 0 but no test name at all was parsed
 *   from its output: it passed, but the targets cannot be seen passing;
 * - 0 otherwise: a target still fails or never ran (a source file that
 *   exits 0 before the tests run shows no target passing), the run changed
 *   a test file or its configuration, or the suite ran out of time, was
 *   refused or stopped.
 *
 * The targets are the failing test names parsed when the task was built
 * (`truth.failing`). At the task base only they failed (a planted bug: the
 * head passed in full; a past change: its parent failed on exactly the
 * parsed tests), so "nothing that passed at base fails" is "nothing fails
 * but the targets".
 *
 * Fallback, when no failing test names were parsed at the build (a runner
 * that prints none of the forms `failingTests` reads): grading falls back
 * to "the suite passes". Such a task scores 1 on exit 0 and 0 otherwise.
 */
export function scoreOf(r: Pick<SuiteRun, 'code' | 'refused' | 'timedOut' | 'aborted' | 'raw' | 'tampered'>, targets: string[]): number {
  if (r.refused !== null || r.timedOut || r.aborted || r.code === null || r.tampered.length) return 0;
  // The fallback: with no parsed targets, only a passing suite counts.
  if (targets.length === 0) return r.code === 0 ? 1 : 0;
  const failed = new Set(failingTests(r.raw));
  const passed = new Set(passingTests(r.raw));
  const targetsPass = targets.every((t) => passed.has(t)) && !targets.some((t) => failed.has(t));
  if (r.code === 0) {
    if (targetsPass) return 1;
    return failed.size === 0 && passed.size === 0 ? 0.5 : 0;
  }
  return targetsPass ? 0.5 : 0;
}

/** The repo's test command now, or null. */
function testCommand(info: Pick<ArenaInfo, 'repo'>): string | null {
  return getRepo(info.repo)?.checks?.test ?? null;
}

/** An answer's grade (ruling 21): its edits applied to a fresh task clone, the suite run, and `scoreOf`. Never throws. */
async function gradeAnswer(info: Pick<ArenaInfo, 'id' | 'repo'>, answer: unknown, truth: PlantedTruth | PastTruth): Promise<number> {
  const edits = answer && typeof answer === 'object' ? (answer as { edits?: unknown }).edits : undefined;
  if (!Array.isArray(edits) || !truth || typeof truth !== 'object') return 0;
  const command = testCommand(info);
  if (!command) return 0;
  const ctl = new AbortController();
  const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
  let s: Scratch | { error: string } | null = null;
  try {
    s = await scratchFor(info.id, truth, 'grade');
    if ('error' in s) return 0;
    if (applyEdits(s.dir, edits, command)) return 0;
    const r = await runSuite(s, command, CHECK_MS - GRADE_MARGIN_MS, ctl.signal);
    // Where no failing test names were parsed, this falls back to "the suite passes" (see scoreOf).
    return scoreOf(r, Array.isArray(truth.failing) ? truth.failing : []);
  } catch {
    return 0;
  } finally {
    unregister();
    if (s && !('error' in s)) await dropScratch(s.runId);
  }
}

/** The arena task a tool call is for, from `ctx.task` (the only thing Beagle passes a tool). */
function taskOf(info: Pick<ArenaInfo, 'id'>, ctx: { task: { id: string; input: unknown } } | undefined): ArenaTask | { error: string } {
  const id = ctx?.task?.id;
  if (typeof id !== 'string' || !id.startsWith(`${info.id}:`)) return { error: 'no task of this arena' };
  return taskById(id) ?? { error: 'no task of this arena' };
}

/** The task's tree the read tools look at, made once per task and kept for the race's later turns. */
async function viewOf(info: Pick<ArenaInfo, 'id'>, task: ArenaTask): Promise<Scratch | { error: string }> {
  const held = views.get(task.id);
  if (held) {
    const got = await held;
    if (!('error' in got) && existsSync(got.dir)) return got;
    views.delete(task.id);
  }
  if (!exitHook) {
    exitHook = true;
    // A view outlives its turn; whatever is left goes when the engine exits.
    process.once('exit', () => {
      for (const runId of liveScratch) {
        try {
          removeOwned(join(paths().runs, runId));
        } catch {
          // best effort
        }
      }
    });
  }
  const made = scratchFor(info.id, task.truth, 'view');
  views.set(task.id, made);
  const got = await made;
  if ('error' in got) views.delete(task.id);
  return got;
}

/** Removes every task tree the read tools made (of one arena, or all). */
export async function releaseArenaViews(arenaId?: string): Promise<void> {
  for (const [taskId, v] of [...views]) {
    if (arenaId !== undefined && !taskId.startsWith(`${arenaId}:`)) continue;
    views.delete(taskId);
    const got = await v;
    if (!('error' in got)) await dropScratch(got.runId);
  }
}

/** One file tool call (ruling 29) in the view, under the tool profile. */
async function fileTool(v: Scratch, op: FileOp, args: Record<string, unknown>): Promise<{ refused: string } | { error: string } | { result: Record<string, unknown> }> {
  const r = await execFileTool({ runId: v.runId, runRoot: v.runRoot, dir: v.dir, op, args, signal: new AbortController().signal, log: noLog, stage: 'working' });
  if (r.refused) return { refused: noLocalPaths(r.refused) };
  const result = r.result as Record<string, unknown> | null;
  if (!result || result.ok !== true) return { error: noLocalPaths(typeof result?.error === 'string' ? result.error : 'the file tool failed') };
  return { result };
}

/** A tool's result as a racer gets it: at most ARENA_TOOL_OUTPUT bytes of JSON, the tail kept when longer. */
function capped(v: unknown): unknown {
  const text = JSON.stringify(v) ?? 'null';
  const buf = Buffer.from(text);
  if (buf.length <= ARENA_TOOL_OUTPUT) return v;
  return { truncated: true, note: `The result was ${buf.length} bytes; the last ${ARENA_TOOL_OUTPUT} follow.`, tail: buf.subarray(buf.length - ARENA_TOOL_OUTPUT).toString('utf8') };
}

const hasGit = (p: string) => p.split('/').some((x) => x.toLowerCase() === '.git');

/** Wraps a tool so it never throws a message with a path of this Mac in it, and never returns more than the cap. */
function guarded(spec: Omit<BeagleToolSpec, 'run'> & { run(args: Record<string, unknown>, ctx?: { task: { id: string; input: unknown } }): Promise<unknown> }): BeagleToolSpec {
  return {
    ...spec,
    run: async (args, ctx) => {
      try {
        return capped(await spec.run(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, ctx));
      } catch (err) {
        return { error: noLocalPaths((err as Error).message ?? String(err)) };
      }
    },
  };
}

function toolsOf(info: Pick<ArenaInfo, 'id' | 'repo'>): BeagleToolSpec[] {
  const inView = async (ctx: { task: { id: string; input: unknown } } | undefined): Promise<Scratch | { error: string }> => {
    const t = taskOf(info, ctx);
    return 'error' in t ? t : viewOf(info, t);
  };
  return [
    guarded({
      name: 'read_file',
      describe: `Read a file of the repository, with line numbers; give from and to to read part of it (at most ${READ_LINES} lines at once).`,
      args: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } } },
      run: async (a, ctx) => {
        const v = await inView(ctx);
        if ('error' in v) return v;
        const file = relPath(a.file);
        if (!file || file === '.' || !underClone(v.dir, file, 'file')) return { refused: OUTSIDE };
        const r = await fileTool(v, 'read', { path: file });
        if (!('result' in r)) return r;
        const lines = String(r.result.content ?? '').split('\n');
        const from = Math.max(1, Math.floor(Number(a.from) || 1));
        const to = Math.min(lines.length, Math.floor(Number(a.to) || from + READ_LINES - 1), from + READ_LINES - 1);
        return { file, of: lines.length, lines: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n'), ...(r.result.truncated ? { truncated: true } : {}) };
      },
    }),
    guarded({
      name: 'list_files',
      describe: 'List the files of the repository (or of one folder of it), without .git or installed dependencies.',
      args: { type: 'object', properties: { path: { type: 'string' } } },
      run: async (a, ctx) => {
        const v = await inView(ctx);
        if ('error' in v) return v;
        const path = relPath(a.path);
        if (!path || !underClone(v.dir, path, 'dir')) return { refused: OUTSIDE };
        const r = await fileTool(v, 'list', { path, recursive: true, skipDeps: true });
        if (!('result' in r)) return r;
        const entries = (Array.isArray(r.result.entries) ? r.result.entries : []) as Array<{ path: string; type: string }>;
        return {
          files: entries.filter((e) => !hasGit(e.path) && e.type !== 'dir').map((e) => (e.type === 'file' ? e.path : `${e.path} (${e.type})`)),
          ...(r.result.truncated ? { truncated: true } : {}),
        };
      },
    }),
    guarded({
      name: 'search',
      describe: 'Search the repository (or one folder or file of it) for a regular expression; returns file:line: text for each match (at most 200). It never looks in .git or installed dependencies, and never follows a link.',
      args: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } } },
      run: async (a, ctx) => {
        const v = await inView(ctx);
        if ('error' in v) return v;
        if (typeof a.pattern !== 'string' || !a.pattern) return { error: 'pattern must be a regular expression' };
        const path = relPath(a.path);
        if (!path || !underClone(v.dir, path, 'any')) return { refused: OUTSIDE };
        const args: Record<string, unknown> = { pattern: a.pattern, path };
        if (typeof a.glob === 'string' && a.glob) args.glob = a.glob;
        const r = await fileTool(v, 'search', args);
        if (!('result' in r)) return r;
        const matches = (Array.isArray(r.result.matches) ? r.result.matches : []) as Array<{ path: string; line: number; text: string }>;
        return { matches: matches.filter((m) => !hasGit(m.path)).map((m) => `${m.path}:${m.line}: ${m.text}`), ...(r.result.truncated ? { truncated: true } : {}) };
      },
    }),
    guarded({
      name: 'run_tests',
      describe: "Run the repository's test suite with your proposed edits applied to a fresh copy (the same edits you would answer with). Returns whether it passed, the tests that fail, and the end of the output.",
      args: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } } } } },
      run: async (a, ctx) => {
        const t = taskOf(info, ctx);
        if ('error' in t) return t;
        const command = testCommand(info);
        if (!command) return { error: 'the repository has no test command' };
        // A fresh scratch clone per call: racing genomes share only ctx.task, never a working copy.
        const s = await scratchFor(info.id, t.truth, 'try');
        if ('error' in s) return s;
        const ctl = new AbortController();
        const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
        try {
          const bad = applyEdits(s.dir, a.edits ?? [], command);
          if (bad) return { error: bad };
          const r = await runSuite(s, command, mutantCapMs(readState(info.id)?.headMs), ctl.signal);
          if (r.refused) return { error: noLocalPaths(`the tests could not run: ${r.refused}`) };
          if (r.aborted) return { error: 'stopped: the school was turned off' };
          if (r.tampered.length) return { passed: false, error: `the run changed ${r.tampered.join(', ')}, which the code under test may not write; such an answer scores 0` };
          return {
            passed: r.code === 0 && !r.timedOut,
            ...(r.timedOut ? { timedOut: true } : {}),
            failing: failingTests(r.raw).slice(0, 50),
            output: noLocalPaths(scrub(r.raw, [s.dir, s.runRoot], ARENA_TOOL_OUTPUT - 4096)),
          };
        } finally {
          unregister();
          await dropScratch(s.runId);
        }
      },
    }),
  ];
}

/** Text with no path of this Mac in it: the data home, the runs folder, the temp folder and his home, in every form. */
function noLocalPaths(text: string): string {
  const forms = new Set<string>();
  const add = (d: string | null) => {
    if (!d || d === '/' || d.length < 4) return;
    const t = d.replace(/\/+$/, '');
    forms.add(t);
    forms.add(`/private${t}`);
    try {
      forms.add(realpathSync(t));
    } catch {
      // not there
    }
  };
  try {
    add(paths().runs);
    add(paths().school);
  } catch {
    // no data home: nothing of it to hide
  }
  add(tmpdir());
  add(homedir());
  let s = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.split(f).join('.');
  return s;
}

const DESCRIBE =
  "A repository's test suite has started to fail. Find the cause in its source and fix it with as small a change as you can. " +
  'You may not change the tests. Answer with find-and-replace edits to the repository\'s source files: each find must be text that appears exactly once in its file, and is replaced whole. ' +
  'Your fix scores 1 when the whole suite passes, 0.5 when the failing tests pass but another test now fails, and 0 otherwise.';

/** What a task shows a racer: the failing tests and how they fail (and for a past change, the tests it added), never the fix or a path of this Mac. */
export function showTask(input: unknown): string {
  const i = (input ?? {}) as Partial<PlantedInput> & Partial<PastInput>;
  const failing = Array.isArray(i.failing) && i.failing.length ? i.failing.map((n) => `- ${n}`).join('\n') : '(the test runner named none: the suite as a whole fails)';
  const parts =
    i.kind === 'past'
      ? [`A change to ${i.repo} added or changed these tests, and they fail on the code before it. Change the source so they pass.`, '', 'The tests it added or changed:', String(i.tests ?? '')]
      : [`The test suite of ${i.repo} has started to fail: one line of its source has been broken.`];
  parts.push('', `The test command: ${i.test ?? ''}`, '', 'These tests fail:', failing, '', 'The output:', String(i.output ?? ''));
  return noLocalPaths(parts.join('\n'));
}

/**
 * A built arena as a Beagle arena (ruling 21): `id` and `data` the arena id
 * (Beagle reads its tasks from its store through `data`), kind `fixtest`,
 * the four tools, the grade above, `graderTimeoutMs` CHECK_MS (15 minutes)
 * and `maxTurns` 24. Its starters are the seeded local agents.
 */
export function toBeagleArena(info: Pick<ArenaInfo, 'id' | 'repo' | 'kind'>): BeagleArena {
  return {
    id: info.id,
    data: info.id,
    name: `${info.repo}: ${info.kind === 'past' ? 'past changes' : 'planted bugs'}`,
    describe: DESCRIBE,
    kind: 'fixtest',
    answer: {
      type: 'object',
      required: ['edits'],
      properties: { edits: { type: 'array', items: { type: 'object', required: ['file', 'find', 'replace'], properties: { file: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } } } },
    },
    grade: (answer, truth) => gradeAnswer(info, answer, truth as PlantedTruth | PastTruth),
    graderTimeoutMs: CHECK_MS,
    maxTurns: ARENA_MAX_TURNS,
    tools: toolsOf(info),
    show: showTask,
    brief: (input) => {
      const f = (input as { failing?: unknown })?.failing;
      return Array.isArray(f) && f.length ? f.join('; ') : 'the suite fails';
    },
    valid: (a) => !!a && typeof a === 'object' && Array.isArray((a as { edits?: unknown }).edits),
    example: (truth) => {
      const t = truth as PlantedTruth | PastTruth;
      if (t.kind === 'past') return `The fix was this change to ${t.sourceFiles.join(', ')}:\n${t.fix}`;
      return JSON.stringify({ edits: [{ file: t.file, find: t.mutated.trim(), replace: t.original.trim() }] });
    },
    miss: (answer, truth) => {
      const t = truth as PlantedTruth | PastTruth;
      const e = ((answer as { edits?: ArenaEdit[] } | null)?.edits ?? []) as ArenaEdit[];
      const did = e.length ? `it edited ${e.map((x) => `${x.file} ("${String(x.find).slice(0, 60)}")`).join(', ')}` : 'it edited nothing';
      if (t.kind === 'past') return `the fix changed ${t.sourceFiles.join(', ')}; ${did}`;
      return `the bug was in ${t.file} line ${t.line}: "${t.mutated.trim()}" should be "${t.original.trim()}"; ${did}`;
    },
    selfCheck: (answer) => {
      const e = ((answer as { edits?: ArenaEdit[] } | null)?.edits ?? []) as ArenaEdit[];
      return `You answered with ${e.length} edit(s)${e.length ? ` to ${[...new Set(e.map((x) => x.file))].join(', ')}` : ''}. If you have not run the tests with exactly these edits, run them with run_tests. Then reply with your final answer.`;
    },
    starters: () => starters(),
  };
}

/** Generation one: the seeded agents on local models, as genomes with the arena's tools for their own. */
function starters(): BeagleGenome[] {
  return listAgents()
    .filter((a) => a.lineage?.origin === 'seeded' && !a.retired && poolOfModel(a.model) === 'local')
    .map((a) => {
      const g = toGenome(a);
      const tools = [...new Set(a.tools.map((t) => TOOL_OF[t]).filter((t): t is (typeof ARENA_TOOLS)[number] => !!t))];
      return { id: g.id, name: g.name, model: g.model, instructions: g.instructions, tools, workflow: g.workflow, memory: { examples: Math.min(8, Math.max(0, g.memory.examples)) } };
    });
}

function registerOne(b: BeagleApi, info: Pick<ArenaInfo, 'id' | 'repo' | 'kind'>): void {
  b.arenas.registerArena(toBeagleArena(info));
  registered.add(info.id);
}

/** A scratch root another process left (`arena-<id>-view|try|grade-<8 hex>`). */
const SCRATCH_ROOT = /^arena-.+-(view|try|grade)-[0-9a-f]{8}$/;

/**
 * Registers every ready (or spent) arena with Beagle as `toBeagleArena`,
 * replacing whatever was registered under its id, and unregisters any this
 * process registered that is no longer ready. Scratch roots an earlier
 * engine left are removed. Returns the registered ids.
 */
export async function registerArenas(): Promise<string[]> {
  const b = await loadBeagle();
  const ready = listArenas().filter((a) => a.status === 'ready' || a.status === 'spent');
  const want = new Set(ready.map((a) => a.id));
  for (const id of [...registered]) {
    if (want.has(id)) continue;
    b.arenas.unregisterArena(id);
    registered.delete(id);
    await releaseArenaViews(id);
  }
  for (const a of ready) registerOne(b, a);
  let left: string[] = [];
  try {
    left = readdirSync(paths().runs);
  } catch {
    left = [];
  }
  for (const name of left) if (SCRATCH_ROOT.test(name) && !liveScratch.has(name)) await clearRoot(name);
  return ready.map((a) => a.id);
}
