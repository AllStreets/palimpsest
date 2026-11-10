/**
 * The inspection guild's verdict (Task 15): whether an agent's change ships
 * or becomes a scar floor.
 *
 * It inspects exactly the commit the engine made (`run.headSha`): the run
 * dir must still be at that commit with nothing changed after it, and the
 * diff the reviewer and the scope read is `baseSha..headSha` from git, so
 * nothing written after the commit can be reviewed or shipped (Task 16
 * ships that same sha).
 *
 * In order, every step under the run's work lease, whose signal aborts the
 * running check, the review and the judge:
 * 1. the install again when the diff touches a manifest or lockfile;
 * 2. every configured check (test, typecheck, lint, build) after the
 *    change, compared with the baseline at the base commit (ruling 12): a
 *    check failing before and after is `preexisting`; a missing command is
 *    `skipped`, never a pass;
 * 3. scope: every changed file matches one of the job's globs and none
 *    matches DENY_SCOPE; a lockfile rides along only with its manifest; a
 *    gitlink (a nested repo) is always out;
 * 4. the review by another firm (review.ts);
 * 5. the design check when the diff touches UI_FILES (design.ts).
 *
 * `passed` is canOpenPR, `pushable` is canPush. Each check is recorded
 * (`check.done`) and the verdict too (`inspection.done`, with the reviewer,
 * which the treasury pays from, Task 17). Three failed inspections in a
 * row halt the repo (`repo.halted`); a pass resets the strikes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
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
import { engineGit } from '../market/worktree.js';
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

/** The longest diff handed to the reviewer and the judge (the providers cut further). */
const MAX_REVIEW_DIFF = 400_000;

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

  // 0. Exactly the committed change: the run dir is at headSha with nothing after it.
  const base = run.baseSha;
  const head = run.headSha;
  let patch = '';
  let files: ChangedFile[] = [];
  let moved: string | null = null;
  if (!base || !head) moved = 'The run has no committed change to inspect.';
  else {
    const at = (await engineGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();
    const dirty = (await engineGit(dir, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
    if (at !== head) moved = `The run dir is at ${at.slice(0, 7)}, not the engine's commit ${head.slice(0, 7)}.`;
    else if (dirty) moved = `The run dir changed after the engine's commit: ${dirty.split('\n').slice(0, 10).join('; ')}`;
    const p = await engineGit(dir, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', base, head, '--']);
    if (p.code !== 0) throw new Error(`git diff failed: ${p.stderr.trim()}`);
    patch = p.stdout;
    files = await changedFiles(dir, base, head);
    if (diff.files.length && diff.files.slice().sort().join('\0') !== files.map((f) => f.path).sort().join('\0')) {
      note('the diff the runner kept differs from the commit; the commit is what is inspected');
    }
  }
  halt();

  if (moved) {
    // Nothing that does not match the commit is run or reviewed.
    done(check('scope', 'fail', moved));
  } else {
    // 1. The install again, when the change touches a manifest or a lockfile.
    let installFailed = false;
    if (needsReinstall(files.map((f) => f.path)) && repo.checks?.install) {
      note('the change touches dependencies: installing again before the checks');
      const install = await (ictx.installDeps ?? defaultInstallDeps)(ctx, repo);
      egress?.setStage('checks', []);
      halt();
      done(install);
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
      const r = await runCheck(ctx, name, command, log);
      halt();
      if (r.status === 'fail' && before?.find((b) => b.name === name)?.status === 'fail') {
        done({ ...r, status: 'preexisting', detail: `Failing before the change too. ${r.detail}`.slice(0, 4000) });
      } else done(r);
    }

    // 3. Scope.
    done(scopeCheck(files, job.scope));
  }
  halt();

  // 4. The review, by another firm, of the committed diff (nothing is reviewed that is not the commit).
  const shown = patch.length > MAX_REVIEW_DIFF ? `${patch.slice(0, MAX_REVIEW_DIFF)}\n[diff cut: ${patch.length - MAX_REVIEW_DIFF} more characters]\n` : patch;
  if (!moved) {
    const rv = await review(run, job, shown, checks.slice(), lease);
    halt();
    cost += rv.credits;
    reviewer = { agentId: rv.reviewerAgentId, firmId: rv.reviewerFirmId };
    done(rv.result);
  }

  // 5. The design check, for a UI change. A head that did not build cannot be shown, so it is not judged.
  if (!moved && files.some((f) => !f.gitlink && UI_FILES.test(f.path))) {
    if (statusOf(checks, 'build') === 'fail') {
      design = { before: null, after: 0, diffOnly: false, shots: [] };
      done(check('design', 'fail', 'Not judged: the change does not build, so it cannot be shown.'));
    } else {
      const d = await designCheck(ctx, run, repo, files, shown, lease, ictx, statusOf(checks, 'build') === 'pass');
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
  const routes = routesOf(repo);
  const note = (text: string) => ctx.log({ at: new Date().toISOString(), kind: 'engine', text: `[design] ${text}` });
  const stoppedOr = (err: unknown) => {
    if (ctx.signal.aborted) throw err;
    note(err instanceof Error ? err.message : String(err));
  };
  let before: Shot[] = [];
  let after: Shot[] = [];
  if (renderable) {
    try {
      const baseCtx = await prepareBase(ctx, repo, run.baseSha as string, { egress: ctx.egress, installDeps: ictx.installDeps });
      before = await shoot(baseCtx, repo, run.baseSha as string, routes, { side: 'before', screenshotter: ictx.screenshotter });
    } catch (err) {
      stoppedOr(err);
    }
    try {
      after = await shoot(ctx, repo, run.headSha as string, routes, { side: 'after', screenshotter: ictx.screenshotter, built: headBuilt });
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
