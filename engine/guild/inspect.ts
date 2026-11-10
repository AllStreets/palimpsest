/**
 * The inspection guild's verdict (Task 15): whether an agent's change ships
 * or becomes a scar floor.
 *
 * It inspects exactly the commit the engine made (`run.headSha`), in a
 * fresh engine clone at `<runRoot>/ship` (ruling 20): the run branch is
 * fetched from the run dir as data and its tip must be that commit. Nothing
 * the agent left in its run dir (ignored files, installed tools, build
 * output) is ever run, served or reviewed. Before the clean install the
 * run is reaped and its fake home, caches and tmp are emptied; they are
 * emptied again before the base side's install, so neither the agent nor
 * the head's code reaches the before shot. The diff the reviewer reads is
 * `baseSha..headSha` as text with the base commit's attributes, so a head
 * `.gitattributes` cannot hide a line (and changing one fails scope).
 *
 * In order, every step under the run's work lease, whose signal aborts the
 * running check, the review and the judge:
 * 1. a clean install in the fresh clone;
 * 2. every configured check (test, typecheck, lint, build) after the
 *    change, compared with the baseline at the base commit (ruling 12): a
 *    check failing before and after is `preexisting`; a missing command is
 *    `skipped`, never a pass; fewer tests than the baseline ran is a fail;
 * 3. scope: every changed file matches one of the job's globs and none
 *    matches DENY_SCOPE; a lockfile rides along only with its manifest; a
 *    gitlink (a nested repo) and any `.gitattributes` are always out;
 * 4. the review by another firm (review.ts), skipped when a check already
 *    failed; a diff longer than every reviewer's window fails it unread;
 * 5. the design check when the diff touches UI_FILES (design.ts); a
 *    screenshot script the change touches fails it.
 *
 * `passed` is canOpenPR, `pushable` is canPush. Each check is recorded
 * (`check.done`) and the verdict too (`inspection.done`, with the reviewer,
 * which the treasury pays from, Task 17). Three failed inspections in a
 * row halt the repo (`repo.halted`); a pass resets the strikes.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CheckName, CheckResult, Inspection, Job, ModelRef, Repo, Run } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { getRepo, updateRepoMarket } from '../repos.js';
import type { Lease } from '../market/budget.js';
import type { Egress } from '../market/egress.js';
import { installDeps as defaultInstallDeps, needsReinstall, type InstallDeps, type RunContext } from '../market/install.js';
import type { RunLogLine } from '../market/provider.js';
import { haltRepo, type RunDiff } from '../market/runs.js';
import { reapRun } from '../market/reaper.js';
import { createShipDir, engineGit } from '../market/worktree.js';
import { cachedBaseline } from './baseline.js';
import { CHECK_ORDER, runCheck } from './checks.js';
import { designPasses, judgeDesign, prepareBase, shoot, UI_FILES, type Screenshotter, type Shot } from './design.js';
import { review } from './review.js';

/** Paths no job may change, whatever its scope. */
export const DENY_SCOPE = ['.github/workflows/**', '.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '.claude/**', '.git/**'];

/** Each lockfile and the manifest beside it that must change with it. */
export const LOCK_MANIFEST: Record<string, string> = {
  'package-lock.json': 'package.json',
  'npm-shrinkwrap.json': 'package.json',
  'pnpm-lock.yaml': 'package.json',
  'yarn.lock': 'package.json',
  'bun.lockb': 'package.json',
  'Cargo.lock': 'Cargo.toml',
  'go.sum': 'go.mod',
  'poetry.lock': 'pyproject.toml',
  'uv.lock': 'pyproject.toml',
  'Pipfile.lock': 'Pipfile',
  'Gemfile.lock': 'Gemfile',
  'composer.lock': 'composer.json',
};

/** Failed inspections in a row that halt a repo. */
export const HALT_STRIKES = 3;
export const HALT_REASON = 'Three inspections in a row failed.';

/** The longest diff handed to the design judge (the reviewer gets the whole diff or none, review.ts). */
const MAX_JUDGE_DIFF = 100_000;

/** The checks whose failure skips the review call. */
const CHECK_NAMES: ReadonlySet<CheckName> = new Set(['install', 'test', 'typecheck', 'lint', 'build']);

/** The run's scratch dirs: its fake home, caches and tmp, emptied before each clean install. */
const SCRATCH = ['home', 'cache', 'tmp'] as const;

// ---------------------------------------------------------------- globs and scope

/** A glob as a whole-path regex: `**` crosses folders (dot folders too), `*` and `?` stay in one, `{a,b}` alternates. */
export function globRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  let depth = 0;
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '');
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        const atStart = i === 0 || g[i - 1] === '/';
        if (atStart && slashAfter) {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      re += '(?:';
      depth++;
    } else if (ch === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (ch === ',' && depth > 0) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}${')'.repeat(depth)}$`);
}

const denyRes = DENY_SCOPE.map((g) => ({ g, re: globRegex(g), anywhere: !g.includes('/') }));

/** The deny pattern `path` matches, or null. A pattern without a slash matches the file name at any depth; `.git` and `.claude` folders are out at any depth. */
export function denied(path: string): string | null {
  const parts = path.split('/');
  if (parts.includes('.git')) return '.git/**';
  if (parts.slice(0, -1).includes('.claude')) return '.claude/**';
  for (const d of denyRes) if (d.re.test(path) || (d.anywhere && d.re.test(posix.basename(path)))) return d.g;
  return null;
}

export interface ChangedFile {
  path: string;
  /** A submodule pointer (mode 160000) on either side: a nested repo. */
  gitlink: boolean;
}

const check = (name: CheckName, status: CheckResult['status'], detail: string, durationMs = 0): CheckResult => ({ name, status, detail: detail.slice(0, 4000), durationMs, logPath: null, testsRun: null });

/** The scope check over the changed files. */
export function scopeCheck(files: ChangedFile[], scope: string[]): CheckResult {
  const globs = (scope.length ? scope : ['**']).map(globRegex);
  const changed = new Set(files.map((f) => f.path));
  const out: string[] = [];
  for (const f of files) {
    if (f.gitlink) {
      out.push(`${f.path} is a nested repository (a gitlink), which no job may change`);
      continue;
    }
    if (posix.basename(f.path) === '.gitattributes') {
      out.push(`${f.path} changes how git shows and filters files, which no job may change`);
      continue;
    }
    const deny = denied(f.path);
    if (deny) {
      out.push(`${f.path} is never in scope (${deny})`);
      continue;
    }
    const manifest = LOCK_MANIFEST[posix.basename(f.path)];
    if (manifest) {
      const beside = posix.join(posix.dirname(f.path), manifest).replace(/^\.\//, '');
      if (!changed.has(beside)) out.push(`${f.path} changed without its ${beside}`);
      continue;
    }
    if (!globs.some((re) => re.test(f.path))) out.push(`${f.path} is outside the job's scope (${scope.join(', ')})`);
  }
  if (out.length === 0) return check('scope', 'pass', `${files.length} file${files.length === 1 ? '' : 's'}, all inside ${scope.join(', ')}.`);
  return check('scope', 'fail', out.join('\n'));
}

// ---------------------------------------------------------------- the verdict

const statusOf = (checks: CheckResult[], name: CheckName) => checks.find((c) => c.name === name)?.status;

/** A PR may open: no failure, the review passed, the test or the build ran (or the repo has neither), and the design passed when it ran. */
export function canOpenPR(checks: CheckResult[]): boolean {
  if (checks.some((c) => c.status === 'fail')) return false;
  if (statusOf(checks, 'review') !== 'pass') return false;
  const ran = (n: CheckName) => ['pass', 'preexisting'].includes(statusOf(checks, n) ?? '');
  const none = (n: CheckName) => (statusOf(checks, n) ?? 'skipped') === 'skipped';
  if (!ran('test') && !ran('build') && !(none('test') && none('build'))) return false;
  const design = statusOf(checks, 'design');
  return design === undefined || design === 'pass';
}

/** Push mode may push: the PR could open, nothing failed before and after, and the test and the build both passed. */
export function canPush(checks: CheckResult[]): boolean {
  return canOpenPR(checks) && !checks.some((c) => c.status === 'preexisting') && statusOf(checks, 'test') === 'pass' && statusOf(checks, 'build') === 'pass';
}

/** A short public line about an inspection: the checks' names and states only, never their output. */
export function inspectionSummary(i: Inspection): string {
  const by = (s: CheckResult['status']) => i.checks.filter((c) => c.status === s).map((c) => c.name);
  const failed = by('fail');
  const pre = by('preexisting');
  const parts = [i.passed ? 'Passed.' : failed.length ? `Failed: ${failed.join(', ')}.` : 'Failed.'];
  if (pre.length) parts.push(`Failing before the change too: ${pre.join(', ')}.`);
  if (i.design) parts.push(i.design.diffOnly ? `Design ${i.design.after} of 10 from the diff alone.` : `Design ${i.design.before ?? 'none'} before, ${i.design.after} after.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- the inspection

export interface InspectContext {
  /** The run's log (default: append to `<runRoot>/log.jsonl`). */
  log?: (line: RunLogLine) => void;
  /** The run's egress proxy: opened to the registries for a reinstall, else allowing nothing. */
  egress?: Pick<Egress, 'setStage'> | null;
  /** The install stage (default installDeps). */
  installDeps?: InstallDeps;
  /** The browser side of the design check (default the real Playwright screenshotter). */
  screenshotter?: Screenshotter;
  /** Judge models to try, in order (default design.ts's). */
  judgeModels?: ModelRef[];
  /** Kills whatever of the run is left before its scratch dirs are wiped (default reapRun). */
  reap?: (runRoot: string) => Promise<unknown>;
}

class Stopped extends Error {
  constructor(signal: AbortSignal) {
    const r = signal.reason;
    super(r instanceof Error ? r.message : r ? String(r) : 'The inspection was stopped.');
  }
}

function fileLog(runRoot: string): (line: RunLogLine) => void {
  return (line) => {
    try {
      mkdirSync(runRoot, { recursive: true });
      appendFileSync(join(runRoot, 'log.jsonl'), `${JSON.stringify(line)}\n`);
    } catch {
      // the log must never stop the inspection
    }
  };
}

/**
 * Empties the run's fake home, caches and tmp (after the reap, so nothing
 * of the run is alive to write there), so what one side's code left there
 * (the agent's work, the head's checks) never reaches the next install.
 */
export function wipeScratch(runRoot: string): void {
  for (const d of SCRATCH) {
    const p = join(runRoot, d);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // A folder the code made unwritable: make it writable, then remove it.
      spawnSync('/bin/chmod', ['-R', 'u+rwx', p]);
      rmSync(p, { recursive: true, force: true });
    }
    mkdirSync(p, { recursive: true });
  }
}

/** Attributes come from the base commit (never the head's .gitattributes), and no driver, textconv or binary flag hides a line. */
function diffArgs(base: string): string[] {
  return ['-c', 'core.attributesFile=/dev/null', `--attr-source=${base}`];
}
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-renames'];

/** The committed change as the reviewer reads it: every changed file as text, with the base's attributes. */
async function reviewDiff(dir: string, base: string, head: string): Promise<string> {
  let r = await engineGit(dir, [...diffArgs(base), 'diff', ...DIFF_FLAGS, base, head, '--']);
  // A git older than 2.40 has no --attr-source; --text alone still shows every line.
  if (r.code !== 0 && /attr-source/.test(r.stderr)) r = await engineGit(dir, ['-c', 'core.attributesFile=/dev/null', 'diff', ...DIFF_FLAGS, base, head, '--']);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The changed files of `base..head` with their gitlink flags, from `git diff --raw`. */
async function changedFiles(dir: string, base: string, head: string): Promise<ChangedFile[]> {
  const r = await engineGit(dir, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--']);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  const parts = r.stdout.split('\0');
  const out: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const path = parts[i + 1];
    if (!meta.startsWith(':') || !path) continue;
    const [srcMode, dstMode] = meta.slice(1).split(' ');
    out.push({ path, gitlink: srcMode === '160000' || dstMode === '160000' });
  }
  return out;
}

/**
 * Inspects `run`'s committed change under its work `lease` (Task 13 calls it
 * in the `inspecting` stage with the egress set to allow nothing). Rejects,
 * recording no verdict, when the lease aborts.
 */
export async function inspect(run: Run, job: Job, repo: Repo, diff: RunDiff, lease: Lease, ictx: InspectContext = {}): Promise<Inspection> {
  const runRoot = join(paths().runs, run.id);
  const dir = run.dir ?? join(runRoot, 'repo');
  const log = ictx.log ?? fileLog(runRoot);
  const signal = lease.signal;
  const egress = ictx.egress ?? undefined;
  const ctx: RunContext = { runId: run.id, runRoot, dir, log, signal, ...(egress ? { egress } : {}) };
  const note = (text: string) => log({ at: new Date().toISOString(), kind: 'engine', text: `[inspection] ${text}` });
  const halt = () => {
    if (signal.aborted) throw new Stopped(signal);
  };
  const checks: CheckResult[] = [];
  const done = (c: CheckResult) => {
    checks.push(c);
    record('check.done', { runId: run.id, jobId: job.id, check: c });
  };
  let cost = 0;
  let reviewer: { agentId: string | null; firmId: string | null } = { agentId: null, firmId: null };
  let design: Inspection['design'] = null;
  halt();

  // 0. Exactly the committed change, in a fresh engine clone at headSha (ruling 20). Nothing the
  //    agent left in its run dir (ignored files, installed tools, build output) is run or served.
  const base = run.baseSha;
  const head = run.headSha;
  let patch = '';
  let files: ChangedFile[] = [];
  let moved: string | null = null;
  let ship = '';
  if (!base || !head) moved = 'The run has no committed change to inspect.';
  else {
    // The agent's processes are gone and its scratch dirs (fake home, caches, tmp) are emptied before the clean install.
    await (ictx.reap ?? reapRun)(runRoot);
    halt();
    wipeScratch(runRoot);
    try {
      ship = await createShipDir(repo, run.id, dir, run.branch, head);
    } catch (err) {
      halt();
      moved = `The change could not be taken from the engine's commit: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (ship) {
      patch = await reviewDiff(ship, base, head);
      files = await changedFiles(ship, base, head);
      if (diff.files.length && diff.files.slice().sort().join('\0') !== files.map((f) => f.path).sort().join('\0')) {
        note('the diff the runner kept differs from the commit; the commit is what is inspected');
      }
    }
  }
  halt();
  const headCtx: RunContext = { ...ctx, dir: ship || dir };

  if (moved) {
    // Nothing that does not match the commit is run or reviewed.
    done(check('scope', 'fail', moved));
  } else {
    // 1. A clean install in the fresh clone.
    let installFailed = false;
    if (repo.checks?.install) {
      const install = await (ictx.installDeps ?? defaultInstallDeps)(headCtx, repo);
      egress?.setStage('checks', []);
      halt();
      done(needsReinstall(files.map((f) => f.path)) ? { ...install, detail: `${install.detail} (the change touches dependencies)`.slice(0, 4000) } : install);
      installFailed = install.status === 'fail';
    }

    // 2. The repo's checks after the change, against the baseline.
    const before = cachedBaseline(repo.fullName, base as string);
    if (!before) note('no baseline at the base commit: a failing check cannot be called preexisting');
    for (const name of CHECK_ORDER) {
      const command = repo.checks?.[name] ?? null;
      if (!command) {
        done(check(name, 'skipped', `No ${name} command: skipped, never counted as a pass.`));
        continue;
      }
      if (installFailed) {
        done(check(name, 'fail', 'Not run: the install failed.'));
        continue;
      }
      const r = await runCheck(headCtx, name, command, log);
      halt();
      const was = before?.find((b) => b.name === name);
      // Tests that ran before and no longer run are a failure, whatever the exit code says.
      if (name === 'test' && r.status !== 'fail' && r.testsRun !== null && typeof was?.testsRun === 'number' && r.testsRun < was.testsRun) {
        done({ ...r, status: 'fail', detail: `${was.testsRun} tests ran before the change, ${r.testsRun} after: tests disappeared. ${r.detail}`.slice(0, 4000) });
      } else if (r.status === 'fail' && was?.status === 'fail') {
        const fewer = name === 'test' && r.testsRun !== null && typeof was.testsRun === 'number' && r.testsRun < was.testsRun;
        if (fewer) done({ ...r, detail: `${was.testsRun} tests ran before the change, ${r.testsRun} after: tests disappeared. ${r.detail}`.slice(0, 4000) });
        else done({ ...r, status: 'preexisting', detail: `Failing before the change too. ${r.detail}`.slice(0, 4000) });
      } else done(r);
    }

    // 3. Scope.
    done(scopeCheck(files, job.scope));
  }
  halt();

  // 4. The review, by another firm, of the committed diff. A failed check already fails the
  //    inspection, so no review call is spent on it; scope and design alone still get one.
  const checkFailed = checks.some((c) => CHECK_NAMES.has(c.name) && c.status === 'fail');
  if (!moved && !checkFailed) {
    const rv = await review(run, job, patch, checks.slice(), lease);
    halt();
    cost += rv.credits;
    reviewer = { agentId: rv.reviewerAgentId, firmId: rv.reviewerFirmId };
    done(rv.result);
  } else if (checkFailed) note('a check failed: no review call is made');

  // 5. The design check, for a UI change. A head that did not build cannot be shown, so it is not judged.
  if (!moved && files.some((f) => !f.gitlink && UI_FILES.test(f.path))) {
    if (statusOf(checks, 'build') === 'fail') {
      design = { before: null, after: 0, diffOnly: false, shots: [] };
      done(check('design', 'fail', 'Not judged: the change does not build, so it cannot be shown.'));
    } else {
      const d = await designCheck(headCtx, run, repo, files, patch.slice(0, MAX_JUDGE_DIFF), lease, ictx, statusOf(checks, 'build') === 'pass');
      halt();
      cost += d.credits;
      design = d.design;
      done(d.result);
    }
  }

  const passed = canOpenPR(checks);
  const inspection: Inspection = {
    id: `insp-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    runId: run.id,
    jobId: job.id,
    repo: repo.fullName,
    reviewerAgentId: reviewer.agentId,
    reviewerFirmId: reviewer.firmId,
    checks,
    passed,
    pushable: passed && canPush(checks),
    design,
    cost: Math.round(cost * 1e6) / 1e6,
    at: new Date().toISOString(),
  };
  openDb().prepare('INSERT OR REPLACE INTO inspections (id, run_id, json) VALUES (?, ?, ?)').run(inspection.id, run.id, JSON.stringify(inspection));
  record('inspection.done', {
    inspectionId: inspection.id,
    runId: run.id,
    jobId: job.id,
    repo: repo.fullName,
    value: job.value,
    reviewerAgentId: reviewer.agentId,
    reviewerFirmId: reviewer.firmId,
    passed: inspection.passed,
    pushable: inspection.pushable,
    summary: inspectionSummary(inspection),
    inspection,
  });
  emit('inspection.done', { inspection });
  note(inspectionSummary(inspection));
  strike(repo.fullName, passed, run.id);
  return inspection;
}

/** Counts a failed inspection against the repo (three in a row halt it) or clears the count on a pass. */
function strike(fullName: string, passed: boolean, runId: string): void {
  const repo = getRepo(fullName);
  if (!repo) return;
  if (passed) {
    if (repo.strikes !== 0) updateRepoMarket(fullName, { strikes: 0 });
    return;
  }
  const strikes = repo.strikes + 1;
  updateRepoMarket(fullName, { strikes });
  // The run being inspected is not killed by its own halt: it ends failed, with its scar.
  if (strikes >= HALT_STRIKES && !repo.halted) haltRepo(fullName, HALT_REASON, new Date().toISOString(), { exceptRun: runId });
}

/** The routes to shoot: his list, each made a path on the served origin. */
function routesOf(repo: Repo): string[] {
  const list = (repo.checks?.shots ?? []).filter((r) => typeof r === 'string' && r.trim());
  const out = (list.length ? list : ['/']).map((r) => (r.startsWith('/') ? r : `/${r}`)).filter((r) => !r.startsWith('//'));
  return out.length ? [...new Set(out)].slice(0, 12) : ['/'];
}

async function designCheck(
  ctx: RunContext,
  run: Run,
  repo: Repo,
  files: ChangedFile[],
  diff: string,
  lease: Lease,
  ictx: InspectContext,
  headBuilt: boolean,
): Promise<{ result: CheckResult; design: NonNullable<Inspection['design']>; credits: number }> {
  const started = Date.now();
  const c = repo.checks;
  const renderable = !!c && (!!c.screenshot || !!c.preview);
  // The repo's own script runs only when there is no preview for the engine's Chromium to shoot,
  // and never when the change touches it: a script the agent wrote can draw any picture it likes.
  if (c?.screenshot && !c.preview) {
    const touched = await scriptTouched(ctx.dir, run.baseSha as string, run.headSha as string, c.screenshot, files.map((f) => f.path));
    if (touched.length) {
      return {
        result: check('design', 'fail', `The change touches the screenshot script (${touched.join(', ')}), so its pictures cannot be trusted and the change is not judged.`, Date.now() - started),
        design: { before: null, after: 0, diffOnly: false, shots: [] },
        credits: 0,
      };
    }
  }
  const routes = routesOf(repo);
  const note = (text: string) => ctx.log({ at: new Date().toISOString(), kind: 'engine', text: `[design] ${text}` });
  const stoppedOr = (err: unknown) => {
    if (ctx.signal.aborted) throw err;
    note(err instanceof Error ? err.message : String(err));
  };
  let before: Shot[] = [];
  let after: Shot[] = [];
  if (renderable) {
    // The head first, from the engine's clone; then the run's processes are reaped and its scratch
    // dirs emptied, so nothing the head's code left in the fake home or the caches reaches the base.
    try {
      after = await shoot(ctx, repo, run.headSha as string, routes, { side: 'after', screenshotter: ictx.screenshotter, built: headBuilt });
    } catch (err) {
      stoppedOr(err);
    }
    try {
      await (ictx.reap ?? reapRun)(ctx.runRoot);
      if (ctx.signal.aborted) throw new Error('The design check was stopped.');
      wipeScratch(ctx.runRoot);
      const baseCtx = await prepareBase(ctx, repo, run.baseSha as string, { egress: ctx.egress, installDeps: ictx.installDeps });
      before = await shoot(baseCtx, repo, run.baseSha as string, routes, { side: 'before', screenshotter: ictx.screenshotter });
    } catch (err) {
      stoppedOr(err);
    }
  }
  const shots = routes
    .map((route) => ({ route, before: before.find((s) => s.route === route)?.path ?? null, after: after.find((s) => s.route === route)?.path ?? null }))
    .filter((s) => s.before || s.after);
  const ui = files.filter((f) => UI_FILES.test(f.path)).map((f) => f.path);
  if (renderable && after.length === 0) {
    // The repo can render, so a change that does not render is never judged from its text instead.
    return {
      result: check('design', 'fail', `The change touches ${ui.join(', ')} but could not be rendered, so it could not be judged.`, Date.now() - started),
      design: { before: null, after: 0, diffOnly: false, shots },
      credits: 0,
    };
  }
  try {
    const j = await judgeDesign(ctx, before, after, diff, lease, { models: ictx.judgeModels, unattended: run.unattended });
    const pass = designPasses(j.before, j.after);
    const how = j.diffOnly
      ? 'Judged from the diff text alone: the repo has no screenshot script and nothing to preview.'
      : `Shot ${routes.length} route${routes.length === 1 ? '' : 's'} before and after at 1440 x 900.`;
    const detail = `${how} Before ${j.before ?? 'none'}, after ${j.after} of 10 (pass at 6, no more than a point below before). ${j.notes}`;
    return { result: check('design', pass ? 'pass' : 'fail', detail, Date.now() - started), design: { before: j.before, after: j.after, diffOnly: j.diffOnly, shots }, credits: j.credits };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return {
      result: check('design', 'fail', err instanceof Error ? err.message : String(err), Date.now() - started),
      design: { before: null, after: 0, diffOnly: !renderable, shots },
      credits: 0,
    };
  }
}

/** Words of a command that may name files: no options, no assignments, no shell punctuation. */
function words(command: string): string[] {
  return command
    .split(/[\s;&|()<>]+/)
    .map((w) => w.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''))
    .filter((w) => w && !w.startsWith('-') && !w.includes('=') && !w.includes('$'));
}

async function packageScripts(dir: string, sha: string): Promise<Record<string, string>> {
  const r = await engineGit(dir, ['show', `${sha}:package.json`]);
  if (r.code !== 0) return {};
  try {
    const scripts = (JSON.parse(r.stdout) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object') return {};
    return Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The changed paths that make up the repo's screenshot command: a file the
 * command or the package script it runs names (or a file under a folder it
 * names), and package.json when that package script changed. Empty when the
 * change leaves the script alone.
 */
export async function scriptTouched(dir: string, base: string, head: string, command: string, changed: string[]): Promise<string[]> {
  const named = new Set(words(command));
  const out = new Set<string>();
  const run = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:._-]+)/.exec(command);
  if (run) {
    const [b, h] = [await packageScripts(dir, base), await packageScripts(dir, head)];
    const name = run[1];
    for (const n of [name, `pre${name}`, `post${name}`]) {
      if (b[n] !== h[n]) out.add('package.json');
      for (const w of [...words(b[n] ?? ''), ...words(h[n] ?? '')]) named.add(w);
    }
  }
  for (const p of changed) {
    for (const w of named) {
      const d = w.replace(/\/+$/, '');
      if (p === d || p.startsWith(`${d}/`)) out.add(p);
    }
  }
  return [...out];
}
