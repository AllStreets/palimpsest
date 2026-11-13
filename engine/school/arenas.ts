/**
 * Arenas (Phase 4 ruling 20, Decision 8): races built from his own repos.
 * This is the build half: planted bugs (Task 19) and past changes (Task
 * 20); the Beagle side (tools, grading for races) comes in Task 21.
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
import { appendFileSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readFileSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

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
import { DEPENDENCY_FILES, installDeps, type RunContext } from '../market/install.js';
import { redact } from '../market/jobs.js';
import type { RunLogLine } from '../market/provider.js';
import { BASE_SCRATCH } from '../market/sandbox.js';
import { controlFiles, createBaseDir, engineGit, ENGINE_GIT_FLAGS, recordGitConfig, removeOwned } from '../market/worktree.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import type { BeagleApi, BeagleArena, BeagleSplit } from './beagle-api.js';
import { loadBeagle } from './beagle.js';
import { isSourceFile, verifiedChanges, type VerifiedChange } from './history.js';
import { isTestFile } from '../audit/schema.js';
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
  if (!getSettings().school.enabled) return 'The school is off';
  if (!repo.connected) return `${repo.fullName} is not connected`;
  if (!repo.market) return `The market is off on ${repo.fullName}; an arena is built only from a market-on repo`;
  if (!repo.checks?.test) return `${repo.fullName} has no test command, so its tests cannot judge a planted bug`;
  return null;
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
    const root = realpathSync(dir);
    const real = realpathSync(p);
    return real.startsWith(root + sep) && real === join(root, file) ? p : null;
  } catch {
    return null;
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
  return getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), ...args], { timeoutMs: 120_000 });
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
  // The history goes: the tree is the parent's state and the tests, with nothing behind it.
  removeOwned(join(dir, '.git'));
  if (existsSync(join(dir, '.git'))) return 'the clone history could not be removed';
  return null;
}

/** The change itself. */
const atChange = (c: PastCandidate): Prepare => async (dir) => {
  const co = await engineGit(dir, ['checkout', '--quiet', '--force', '--detach', c.change.sha]);
  return co.code === 0 ? null : `could not check out ${c.change.sha.slice(0, 7)}: ${co.stderr.trim()}`;
};

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
  return { counts, sealedHash: sealedHashOf(b, id) };
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
  const why = refusal(repo);
  if (why) return refused(repo, why, now, kind);
  if (live) return refused(repo, `An arena is already being built (${live.repo})`, now, kind);

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
      state.candidates = await plant(state.id, state.sha);
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
    o.signal?.removeEventListener('abort', onOuter);
    unregister();
    live = null;
  }
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
