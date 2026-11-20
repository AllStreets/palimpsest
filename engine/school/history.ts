/**
 * Verified history (Phase 4 ruling 23, Decision 7): the past work the
 * school may learn from and race on.
 *
 * - `city`: the city's merges whose inspection passed, merged at least
 *   SURVIVE_DAYS ago, never reverted and never followed by a fix of his.
 * - `pr`: his merged PRs (never a city branch's) that were never reverted.
 * - `commit` (only with `commitsAsWork`): his direct commits on the
 *   default branch's first-parent line that touch source, are SURVIVE_DAYS
 *   old, were never reverted nor followed by a fix within FOLLOWUP_DAYS,
 *   and, where the repo declares a test check, whose tests passed at the
 *   commit when the school checked them.
 *
 * Everything is read from the bare mirror with getRunner() and hooks and
 * fsmonitor off, argv only; every sha is checked as 40 hex before it is
 * used. The test check runs the repo's declared install and test commands
 * through execTool() under the tool profile, in a fresh run root, and only
 * while the heavy gate holds. Its results, and the last list of verified
 * changes, are kept in `verified` (repo, sha).
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Repo } from '../../shared/types.js';
import { SURVIVE_DAYS } from '../../shared/school-rules.js';
import { isTestFile } from '../audit/schema.js';
import { openDb } from '../db.js';
import { getRunner } from '../exec.js';
import { mergedPRs } from '../github.js';
import { CITY_BRANCH, JOB_TRAILER } from '../history.js';
import { paths } from '../home.js';
import { query } from '../ledger.js';
import { mirrorDir, syncMirror } from '../mirror.js';
import { forgetRun, reapRun } from '../market/broker.js';
import { startEgress, type Egress } from '../market/egress.js';
import { installDeps, type RunContext } from '../market/install.js';
import type { RunLogLine } from '../market/provider.js';
import { listRuns, VERIFY_RUN_PREFIX } from '../market/runs.js';
import { followupOf } from '../market/ship.js';
import { createRunDir, engineGit, ENGINE_GIT_FLAGS, removeRunDir } from '../market/worktree.js';
import { listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import { runCheck } from '../guild/checks.js';
import { gateNow } from './gate.js';

export type VerifiedKind = 'city' | 'pr' | 'commit';

export interface VerifiedChange {
  /** `city:<jobId>`, `pr:<number>` or `commit:<sha>`. */
  ref: string;
  sha: string;
  /** The first parent: the default branch just before the change. */
  parent: string;
  kind: VerifiedKind;
  /** What the change brought into the branch (a merge read against its first parent), sorted. */
  files: string[];
  touchesTests: boolean;
  at: string;
}

/** What the test check found at one sha; null when it could not tell (nothing is cached then). */
export interface TestCheckResult {
  passed: boolean;
  detail: string;
}

export type TestCheck = (repo: Repo, sha: string, signal: AbortSignal) => Promise<TestCheckResult | null>;

/** At most this many test checks per call: each is an install and a suite, and the gate is read before each. */
export const CHECKS_PER_CALL = 10;
/** No new test check starts once a call has run this long (a check already started finishes). */
export const CHECK_BUDGET_MS = 3 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const GIT_MS = 120_000;
const RS = '\x1e';
const US = '\x1f';

/** The extensions of source files: code a coder writes, never prose, data or lockfiles. */
const SOURCE_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'go', 'rs', 'rb', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'ex', 'exs', 'erl', 'hs', 'lua', 'dart', 'zig',
  'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'sass', 'less', 'html',
]);

/** A source file that is not a test. */
export function isSourceFile(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_EXT.has(name.slice(dot + 1).toLowerCase()) && !isTestFile(path);
}

/** The subject git or GitHub gives a merge of one of the city's branches. */
const CITY_MERGE_SUBJECT = new RegExp(
  `^Merge (?:pull request #\\d+ from [^\\s/]+/${CITY_BRANCH}|branch '(?:origin/)?${CITY_BRANCH}|remote-tracking branch '[^'/]+/${CITY_BRANCH})`,
);

// ---------------------------------------------------------------- the test check

let testCheck: TestCheck | null = null;

/** Replaces the test check (tests); null restores the real one. */
export function setTestCheck(fn: TestCheck | null): void {
  testCheck = fn;
}

/** The run id (and run root name) of the test check of `fullName` at `sha`. */
export function verifyRunId(fullName: string, sha: string): string {
  return `${VERIFY_RUN_PREFIX}${fullName.replace('/', '__')}-${sha.slice(0, 12)}`;
}

/**
 * The repo's declared test check at `sha`, as the baseline runs it: a fresh
 * clone of the mirror checked out at the sha, the install (egress to the
 * repo's registries only), then the test command (egress allows nothing),
 * each through execTool() under the tool profile. Null when it cannot tell
 * (no test declared, the install failed, or it was stopped).
 */
const realTestCheck: TestCheck = async (repo, sha, signal) => {
  const command = repo.checks?.test ?? null;
  if (!command || !SHA.test(sha)) return null;
  const runId = verifyRunId(repo.fullName, sha);
  const runRoot = join(paths().runs, runId);
  const logFile = join(runRoot, 'log.jsonl');
  const log = (line: RunLogLine) => {
    try {
      appendFileSync(logFile, `${JSON.stringify(line)}\n`);
    } catch {
      // best effort
    }
  };
  if (existsSync(join(runRoot, 'repo'))) {
    await reapRun(runRoot);
    removeRunDir(runId);
  }
  let egress: Egress | null = null;
  try {
    const { dir } = await createRunDir(repo, runId, `palimpsest/verify-${sha.slice(0, 12)}`, { signal });
    const co = await engineGit(dir, ['checkout', '--quiet', '--detach', sha]);
    if (co.code !== 0) return null;
    egress = await startEgress(runId, log);
    const ctx: RunContext = { runId, runRoot, dir, log, signal, egress };
    const install = await installDeps(ctx, repo);
    if (install.status === 'fail' || signal.aborted) return null;
    egress.setStage('checks', []);
    const r = await runCheck(ctx, 'test', command, log);
    if (signal.aborted) return null;
    return { passed: r.status === 'pass', detail: r.detail.slice(0, 500) };
  } finally {
    try {
      await egress?.close();
    } catch {
      // best effort
    }
    try {
      if (existsSync(runRoot)) await reapRun(runRoot);
    } catch {
      // best effort
    }
    forgetRun(runId);
    removeRunDir(runId);
  }
};

// ---------------------------------------------------------------- the cache

interface VerifiedRow {
  /** The test check at this sha, with the command it ran (a changed command is not this result). */
  check: (TestCheckResult & { command: string; at: string }) | null;
  /** The change as the last read found it verified; null when it is not (or no longer) verified. */
  change: VerifiedChange | null;
}

function rowsOf(fullName: string): Map<string, VerifiedRow> {
  const rows = openDb().prepare('SELECT sha, json FROM verified WHERE repo = ?').all(fullName) as Array<{ sha: string; json: string }>;
  return new Map(rows.map((r) => [r.sha, JSON.parse(r.json) as VerifiedRow]));
}

function putRow(fullName: string, sha: string, row: VerifiedRow): void {
  openDb().prepare('INSERT OR REPLACE INTO verified (repo, sha, json) VALUES (?, ?, ?)').run(fullName, sha, JSON.stringify(row));
}

// ---------------------------------------------------------------- the mirror

interface LogEntry {
  sha: string;
  parents: string[];
  at: string;
  author: string;
  subject: string;
  body: string;
  files: string[];
  lines: number;
}

/**
 * Every commit on the default branch, newest first, each with its parents
 * and the files it brought in (a merge against its first parent), from one
 * `git log` of the mirror.
 */
async function readBranch(repo: Repo): Promise<LogEntry[]> {
  const r = await getRunner()(
    'git',
    [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), 'log', '--diff-merges=first-parent', '--name-only', `--format=${RS}%H${US}%P${US}%aI${US}%an${US}%s${US}%b${US}`, `refs/heads/${repo.defaultBranch}`, '--'],
    { timeoutMs: GIT_MS },
  );
  if (r.code !== 0) throw new Error(`git log failed for ${repo.fullName}: ${r.stderr.trim()}`);
  return r.stdout
    .split(RS)
    .filter((c) => c.trim().length > 0)
    .map((chunk) => {
      const [sha, parents, at, author, subject, body, names] = chunk.split(US);
      return {
        sha: (sha ?? '').trim(),
        parents: (parents ?? '').split(' ').filter(Boolean),
        at: at ?? '',
        author: author ?? '',
        subject: subject ?? '',
        body: (body ?? '').trim(),
        files: [...new Set((names ?? '').split('\n').map((l) => l.trim()).filter(Boolean))].sort(),
        lines: 0,
      };
    })
    .filter((c) => SHA.test(c.sha) && c.parents.every((p) => SHA.test(p)));
}

/** The default branch's first-parent line, newest first. */
function firstParentLine(all: LogEntry[]): LogEntry[] {
  const bySha = new Map(all.map((c) => [c.sha, c]));
  const named = new Set(all.flatMap((c) => c.parents));
  const line: LogEntry[] = [];
  const seen = new Set<string>();
  for (let c = all.find((x) => !named.has(x.sha)); c && !seen.has(c.sha); c = bySha.get(c.parents[0] ?? '')) {
    seen.add(c.sha);
    line.push(c);
  }
  return line;
}

const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether any commit on the branch reverts `sha` (by its body) or `subject` (git's and GitHub's subjects). */
function revertedIn(all: LogEntry[], sha: string, subjects: string[]): boolean {
  const byBody = new RegExp(`This reverts commit ${sha}\\b`);
  const bySubject = subjects.filter(Boolean).map((t) => new RegExp(`^Revert "${quote(t)}(?: \\(#\\d+\\))?"(?: \\(#\\d+\\))?$`));
  return all.some((c) => c.sha !== sha && (byBody.test(c.body) || bySubject.some((re) => re.test(c.subject))));
}

function isRevert(c: LogEntry): boolean {
  return /^Revert "/.test(c.subject) || /This reverts commit [0-9a-f]{7,40}\b/.test(c.body);
}

function ageOk(at: string, now: number): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && t <= now - SURVIVE_DAYS * DAY_MS;
}

function changeOf(c: LogEntry, kind: VerifiedKind, ref: string, at: string): VerifiedChange {
  return { ref, sha: c.sha, parent: c.parents[0] ?? '', kind, files: c.files, touchesTests: c.files.some(isTestFile), at };
}

// ---------------------------------------------------------------- verified changes

/**
 * His verified past work on `repo` at `now` (ruling 23), oldest first. With
 * `check`, commits awaiting a test check are checked (at most
 * CHECKS_PER_CALL, each only while the heavy gate holds at the moment it
 * would start, read on `o.clock`, by default `now` plus the time since the call began) and the results
 * cached by sha; a commit not yet checked is not verified. The list is
 * written to `verified` for `verifiedCounts()`. Throws when the mirror or
 * GitHub cannot be read, leaving the last list in place.
 */
export async function verifiedChanges(repo: Repo, now: number, o: { check?: boolean; signal?: AbortSignal; clock?: () => number } = {}): Promise<VerifiedChange[]> {
  // The gate is re-read before every check, on the clock of the moment: `now` is when the pass began, and a pass can outlast the window.
  const began = Date.now();
  const clock = o.clock ?? (() => now + (Date.now() - began));
  const fullName = repo.fullName;
  await syncMirror(fullName);
  const all = await readBranch(repo);
  const bySha = new Map(all.map((c) => [c.sha, c]));
  const line = firstParentLine(all);
  const onLine = new Map(line.map((c, i) => [c.sha, i]));
  const out: VerifiedChange[] = [];

  // The city's merges: passed inspection, 30 days, never reverted nor followed by his fix.
  const cityShas = new Set<string>();
  for (const r of listRuns({ repo: fullName })) {
    if (r.outcome !== 'merged' || !r.mergeSha || !SHA.test(r.mergeSha)) continue;
    cityShas.add(r.mergeSha);
    const insp = query({ kind: 'inspection.done', runId: r.id, last: true })[0]?.data as { inspection?: { runId?: unknown; passed?: unknown } } | undefined;
    if (insp?.inspection?.runId !== r.id || insp.inspection.passed !== true) continue;
    const detected = query({ kind: 'merge.detected', runId: r.id, last: true })[0]?.data as { mergedAt?: unknown } | undefined;
    const at = typeof detected?.mergedAt === 'string' ? detected.mergedAt : r.endedAt;
    if (!at || !ageOk(at, now)) continue;
    if (query({ kind: ['merge.reverted', 'merge.followup'], runId: r.id }).length) continue;
    const c = bySha.get(r.mergeSha);
    if (!c || revertedIn(all, c.sha, [])) continue;
    out.push(changeOf(c, 'city', `city:${r.jobId}`, at));
  }

  // His merged PRs: never a city branch, never reverted, merged into the branch as the mirror has it.
  const prShas = new Set<string>();
  for (const pr of await mergedPRs(fullName)) {
    if (!pr.mergeSha || !SHA.test(pr.mergeSha)) continue;
    prShas.add(pr.mergeSha);
    if (pr.headRefName.startsWith(CITY_BRANCH) || cityShas.has(pr.mergeSha)) continue;
    const c = bySha.get(pr.mergeSha);
    if (!c || !onLine.has(c.sha)) continue;
    if (revertedIn(all, c.sha, [pr.title, c.subject])) continue;
    out.push(changeOf(c, 'pr', `pr:${pr.number}`, pr.mergedAt));
  }

  // His direct commits (Decision 7).
  if (getSettings().school.commitsAsWork) {
    const rows = rowsOf(fullName);
    const command = repo.checks?.test ?? null;
    const signal = o.signal ?? new AbortController().signal;
    const filesOf = async (sha: string) => bySha.get(sha)?.files ?? [];
    let checks = 0;
    // Oldest first, so the checks a call can afford go to the work that has waited longest.
    for (const c of [...line].reverse()) {
      if (c.parents.length !== 1 || cityShas.has(c.sha) || prShas.has(c.sha)) continue;
      if (JOB_TRAILER.test(c.body) || CITY_MERGE_SUBJECT.test(c.subject) || isRevert(c)) continue;
      if (!c.files.some(isSourceFile) || !ageOk(c.at, now)) continue;
      if (revertedIn(all, c.sha, [c.subject])) continue;
      const after = line.slice(0, onLine.get(c.sha));
      if (await followupOf(after, filesOf, c.sha, c.files, c.at, now)) continue;
      if (command) {
        let check = rows.get(c.sha)?.check ?? null;
        if (check && check.command !== command) check = null;
        // `now` is when the call began, so clock() - now is the time spent; no new check starts once it reaches the budget.
        let at = 0;
        if (!check && o.check && checks < CHECKS_PER_CALL && !signal.aborted && (at = clock()) - now < CHECK_BUDGET_MS && (await gateNow('heavy', at)).ok) {
          checks++;
          const got = await (testCheck ?? realTestCheck)(repo, c.sha, signal);
          if (got) {
            check = { ...got, command, at: new Date(now).toISOString() };
            const row = rows.get(c.sha) ?? { check: null, change: null };
            row.check = check;
            rows.set(c.sha, row);
            putRow(fullName, c.sha, row);
          }
        }
        if (!check?.passed) continue;
      }
      out.push(changeOf(c, 'commit', `commit:${c.sha}`, c.at));
    }
  }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sha.localeCompare(b.sha));
  store(fullName, out);
  return out;
}

/** Writes the list into `verified`: each change on its sha's row, every other row's change cleared. */
function store(fullName: string, list: VerifiedChange[]): void {
  const db = openDb();
  const rows = rowsOf(fullName);
  const now = new Map(list.map((c) => [c.sha, c]));
  db.exec('BEGIN');
  try {
    for (const [sha, row] of rows) {
      if (!now.has(sha) && row.change) putRow(fullName, sha, { ...row, change: null });
    }
    for (const c of list) putRow(fullName, c.sha, { check: rows.get(c.sha)?.check ?? null, change: c });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Each connected repo's verified changes by kind, as the last read found
 * them (the screen's "11 of 100"). Commits count only while
 * `commitsAsWork` is on.
 */
export function verifiedCounts(): Record<string, { city: number; pr: number; commit: number }> {
  const commits = getSettings().school.commitsAsWork;
  const out: Record<string, { city: number; pr: number; commit: number }> = {};
  for (const repo of listRepos()) {
    if (!repo.connected) continue;
    const n = { city: 0, pr: 0, commit: 0 };
    for (const row of rowsOf(repo.fullName).values()) {
      const k = row.change?.kind;
      if (k === 'city' || k === 'pr' || (k === 'commit' && commits)) n[k]++;
    }
    out[repo.fullName] = n;
  }
  return out;
}
