/**
 * Each repo's own checks (Task 14): what to run for its tests, type check,
 * lint and build, how to install its dependencies, and whether it can be
 * rendered for the design check (ruling 24).
 *
 * Detection only reads manifest and lockfile text and turns it into one of
 * a fixed set of command strings; the engine never executes repo code
 * itself. Every check runs through execTool() under the tool profile with
 * the egress proxy in stage `checks`, which allows no host at all.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { unanswered } from '../../shared/market-rules.js';
import type { CheckName, CheckResult, RepoChecks } from '../../shared/types.js';
import { getRunner } from '../exec.js';
import { mirrorReadEnv } from '../mirror.js';
import { execTool } from '../market/broker.js';
import type { RunContext } from '../market/install.js';
import type { RunLogLine } from '../market/provider.js';

/** Wall time one check may take (the broker's own cap). */
export const CHECK_MS = 15 * 60_000;

/** Manifest text larger than this is not read (a manifest is never this big). */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** The root files detection reads, beyond the names it only looks for. */
const READ = ['package.json', 'Makefile', 'makefile', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'] as const;

/** npm's own placeholder test script, which is no test at all. */
const NPM_PLACEHOLDER = /no test specified/;

/** Checks for a repo nothing was detected in. */
export function emptyChecks(): RepoChecks {
  return { test: null, typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: ['/'], install: null, ecosystems: [], detected: true };
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function parsePackage(text: string | null): PackageJson | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

function makeTargets(text: string | null): Set<string> {
  const targets = new Set<string>();
  if (!text) return targets;
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (m) targets.add(m[1]);
  }
  return targets;
}

/** The install of an npm repo that has dependencies and no lockfile. */
export const NPM_NO_LOCK_INSTALL = 'npm install --no-package-lock --no-audit --no-fund';

/**
 * The detection itself, over a repo root: `names` are the root's entries and
 * `read` returns a root file's text (null when absent or unreadable).
 */
export function detectFrom(names: Set<string>, read: (name: string) => string | null): RepoChecks {
  const c = emptyChecks();
  const has = (n: string) => names.has(n);
  const pkg = has('package.json') ? parsePackage(read('package.json')) : null;

  // Install and ecosystems come from the lockfiles alone.
  const installs: string[] = [];
  const ecosystems: RepoChecks['ecosystems'] = [];
  let manager: 'npm' | 'pnpm' | 'yarn' = 'npm';
  if (has('package-lock.json')) installs.push('npm ci');
  else if (has('pnpm-lock.yaml')) {
    installs.push('pnpm install --frozen-lockfile');
    manager = 'pnpm';
  } else if (has('yarn.lock')) {
    installs.push('yarn install --immutable');
    manager = 'yarn';
  } else if (pkg && [pkg.dependencies, pkg.devDependencies].some((d) => d && typeof d === 'object' && Object.keys(d).length > 0)) {
    // No lockfile, but declared dependencies: without them every check fails before and after a change
    // and reads preexisting. npm installs them and writes no lockfile, so the run's diff stays its own.
    installs.push(NPM_NO_LOCK_INSTALL);
  }
  if (installs.length) ecosystems.push('npm');
  let venv = false;
  if (has('requirements.txt')) {
    installs.push('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
    venv = true;
  } else if (has('pyproject.toml')) {
    installs.push('python3 -m venv .venv && .venv/bin/pip install -e .');
    venv = true;
  }
  if (venv) ecosystems.push('python');
  if (has('Cargo.lock')) {
    installs.push('cargo fetch');
    ecosystems.push('rust');
  }
  if (has('go.sum')) {
    installs.push('go mod download');
    ecosystems.push('go');
  }
  c.install = installs.length ? installs.join(' && ') : null;
  c.ecosystems = ecosystems;

  // package.json scripts, run with the lockfile's package manager.
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const script = (n: string) => (typeof scripts[n] === 'string' && (scripts[n] as string).trim() ? (scripts[n] as string) : null);
    const run = (n: string) => `${manager} run ${n}`;
    const t = script('test');
    if (t && !NPM_PLACEHOLDER.test(t)) c.test = `${manager} test`;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const dep = (n: string) => Object.prototype.hasOwnProperty.call(deps, n);
    if (script('typecheck')) c.typecheck = run('typecheck');
    else if ((dep('typescript') || dep('tsc')) && has('tsconfig.json')) c.typecheck = './node_modules/.bin/tsc --noEmit';
    if (script('lint')) c.lint = run('lint');
    if (script('build')) c.build = run('build');
    if (script('palimpsest:screenshot')) c.screenshot = run('palimpsest:screenshot');

    if (dep('vite')) c.preview = { kind: 'vite', outDir: 'dist' };
    else if (dep('next')) {
      const config = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'].filter(has).map(read).find((t) => t !== null) ?? null;
      if (config && /output\s*:\s*['"`]export['"`]/.test(config)) c.preview = { kind: 'next', outDir: 'out' };
    } else if (dep('astro')) c.preview = { kind: 'astro', outDir: 'dist' };
  }
  if (!c.preview && has('index.html')) c.preview = { kind: 'static', outDir: '.' };

  // The other ecosystems fill whatever package.json left empty.
  if (has('Cargo.toml')) {
    c.test ??= 'cargo test';
    c.build ??= 'cargo build';
  }
  if (has('pyproject.toml') || has('pytest.ini')) c.test ??= venv ? '.venv/bin/python -m pytest' : 'pytest';
  if (has('go.mod')) {
    c.test ??= 'go test ./...';
    c.build ??= 'go build ./...';
  }
  const makefile = has('Makefile') ? 'Makefile' : has('makefile') ? 'makefile' : null;
  if (makefile) {
    const targets = makeTargets(read(makefile));
    if (targets.has('test')) c.test ??= 'make test';
    if (targets.has('build')) c.build ??= 'make build';
  }
  return c;
}

/**
 * Reads a regular file at the root of `dir` without following a symlink,
 * capped at MAX_MANIFEST_BYTES; null otherwise. Detection may read a run
 * dir an agent wrote, so it never follows a link out of it.
 */
function readRootFile(dir: string, name: string): string | null {
  let fd: number;
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The checks of the working tree at `dir`. */
export function detectChecks(dir: string): RepoChecks {
  let names: Set<string>;
  try {
    names = new Set(readdirSync(dir));
  } catch {
    names = new Set();
  }
  return detectFrom(names, (n) => readRootFile(dir, n));
}

/**
 * The checks of `branch` in the bare mirror at `mirror`, read with git
 * (through getRunner(), so the sample engine's stand-in answers it). An
 * unborn branch has no files and so no checks. Throws when git fails
 * otherwise, so a caller keeps what it had.
 */
export async function detectChecksInMirror(mirror: string, branch: string): Promise<RepoChecks> {
  const runner = getRunner();
  const ls = await runner('git', ['-C', mirror, 'ls-tree', '-z', '--name-only', branch], { timeoutMs: 60_000, env: mirrorReadEnv() });
  if (ls.code !== 0) {
    if (/not a valid object name|does not have any commits|unknown revision/i.test(ls.stderr)) return emptyChecks();
    throw new Error(`git ls-tree failed: ${ls.stderr.trim()}`);
  }
  const names = new Set(ls.stdout.split('\0').filter(Boolean));
  const texts = new Map<string, string | null>();
  for (const n of READ) {
    if (!names.has(n)) continue;
    const r = await runner('git', ['-C', mirror, 'show', `${branch}:${n}`], { timeoutMs: 60_000, env: mirrorReadEnv() });
    texts.set(n, r.code === 0 && r.stdout.length <= MAX_MANIFEST_BYTES ? r.stdout : null);
  }
  return detectFrom(names, (n) => texts.get(n) ?? null);
}

// ---------------------------------------------------------------- running

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * The number of tests a runner says it ran, from its own summary: node
 * --test (TAP and spec), vitest, jest, pytest, cargo test and go test -v.
 * Null when the output carries no count.
 */
export function parseTestsRun(output: string): number | null {
  const text = output.replace(ANSI, '');
  const last = (re: RegExp) => {
    const all = [...text.matchAll(re)];
    return all.length ? all[all.length - 1] : null;
  };
  // node --test: "# tests 3" (TAP) or "ℹ tests 3" (spec).
  const node = last(/^\s*(?:#|ℹ)\s*tests\s+(\d+)\s*$/gm);
  if (node) return Number(node[1]);
  // jest: "Tests:       1 failed, 11 passed, 12 total".
  const jest = last(/^\s*Tests:\s+.*?(\d+)\s+total/gm);
  if (jest) return Number(jest[1]);
  // vitest: "Tests  1 failed | 11 passed (12)".
  const vitest = last(/^\s*Tests\s+.*\((\d+)\)\s*$/gm);
  if (vitest) return Number(vitest[1]);
  // cargo test: one "test result:" line per test binary.
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.reduce((s, m) => s + Number(m[1]) + Number(m[2]), 0);
  // pytest: "===== 5 passed, 2 failed, 1 skipped in 0.31s =====".
  const pytest = last(/^=+ (.*?) in [\d.]+s.*=+\s*$/gm);
  if (pytest) {
    let n = 0;
    let found = false;
    for (const m of pytest[1].matchAll(/(\d+) (passed|failed|errors?|xfailed|xpassed)/g)) {
      n += Number(m[1]);
      found = true;
    }
    if (found) return n;
  }
  // go test -v: top-level "--- PASS:" and "--- FAIL:" lines (subtests are indented).
  const go = [...text.matchAll(/^--- (?:PASS|FAIL): /gm)];
  if (go.length) return go.length;
  return null;
}

/** The reason a test gives when it skips itself in the tool sandbox (test/tool-sandbox.ts). */
export const SANDBOX_SKIP = 'not run in the tool sandbox: ';

/** A test the suite skipped because it ran in the tool sandbox, and why. */
export interface SandboxSkip {
  name: string;
  why: string;
}

/**
 * The tests a suite skipped because it ran in the tool sandbox, from node
 * --test's TAP (`ok 1 - name # SKIP reason`) or spec (`﹣ name (1ms) #
 * reason`) lines; any other runner's line that carries the reason is kept
 * whole as the name.
 */
export function parseSandboxSkips(output: string): SandboxSkip[] {
  const out = new Map<string, SandboxSkip>();
  for (const raw of output.replace(ANSI, '').split('\n')) {
    const at = raw.indexOf(SANDBOX_SKIP);
    if (at < 0) continue;
    const why = raw.slice(at + SANDBOX_SKIP.length).trim();
    const tap = /^\s*ok \d+ - (.*?) # SKIP\s*$/.exec(raw.slice(0, at));
    const spec = /^\s*\uFE63 (.*?) \([\d.]+m?s\) #\s*$/.exec(raw.slice(0, at));
    const name = tap?.[1] ?? spec?.[1] ?? raw.trim();
    out.set(`${name}\0${why}`, { name, why });
  }
  return [...out.values()];
}

/** Characters of a test check's detail the sandbox skips may take, so the failure beside them still shows. */
const MAX_SKIP_NOTE = 1500;

/** What a test check's detail says of the tests the sandbox kept from running, grouped by why. */
export function sandboxSkipNote(skips: SandboxSkip[]): string {
  if (!skips.length) return '';
  const byWhy = new Map<string, string[]>();
  for (const s of skips) byWhy.set(s.why, [...(byWhy.get(s.why) ?? []), s.name]);
  let text = `\nNot run in the tool sandbox (${skips.length}):`;
  let shown = 0;
  for (const [why, names] of byWhy) {
    const lead = `\n- ${why || 'no reason given'}: `;
    if (text.length + lead.length > MAX_SKIP_NOTE - 60) break;
    text += lead;
    const kept: string[] = [];
    for (const n of names) {
      if (text.length + kept.join('; ').length + n.length + 2 > MAX_SKIP_NOTE - 60) break;
      kept.push(n);
    }
    text += `${kept.join('; ')}.`;
    shown += kept.length;
    if (kept.length < names.length) break;
  }
  return shown < skips.length ? `${text}\nAnd ${skips.length - shown} more, named in the test log.` : text;
}

/** Output kept per check for its log file and for the count. */
const MAX_CHECK_LOG_BYTES = 4 * 1024 * 1024;

/**
 * Runs one check through execTool() with stage `checks` (the runner or the
 * baseline has set the egress to allow nothing) and a 15 minute cap. The
 * check's output goes to the run log as it streams and to
 * `<runRoot>/inspection/<name>.log`; `testsRun` is parsed from it. A
 * refusal, a non-zero exit, a timeout or an abort is a `fail`; a refusal or
 * a timeout is also `inconclusive`, so no baseline keeps it.
 */
export async function runCheck(
  ctx: RunContext,
  name: CheckName,
  command: string,
  log: (line: RunLogLine) => void = ctx.log,
): Promise<CheckResult> {
  const started = Date.now();
  const kept: string[] = [];
  let bytes = 0;
  const tee = (line: RunLogLine) => {
    log(line);
    if (line.kind === 'tool' && line.data && typeof (line.data as { stream?: unknown }).stream === 'string') {
      bytes += Buffer.byteLength(line.text) + 1;
      kept.push(line.text);
      while (bytes > MAX_CHECK_LOG_BYTES && kept.length > 1) bytes -= Buffer.byteLength(kept.shift()!) + 1;
    }
  };
  const r = await execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, command, timeoutMs: CHECK_MS, stage: 'checks', signal: ctx.signal, log: tee, side: ctx.side });
  const durationMs = Date.now() - started;
  const output = kept.length ? kept.join('\n') : `${r.stdout}\n${r.stderr}`;
  let logPath: string | null = null;
  try {
    const dir = join(ctx.runRoot, 'inspection');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, `${name}.log`);
    writeFileSync(logPath, `$ ${command}\n${output}\n`);
  } catch {
    logPath = null;
  }
  const testsRun = name === 'test' ? parseTestsRun(output) : null;
  // What the suite did not exercise in the sandbox, bounded so the cut at 4000 characters never drops it.
  const skipped = name === 'test' ? sandboxSkipNote(parseSandboxSkips(output)) : '';
  if (r.refused) return { name, status: 'fail', detail: `Refused: ${r.refused}`, durationMs, logPath, testsRun: null, inconclusive: 'refused' };
  if (r.code !== 0 || ctx.signal.aborted) {
    const tail = output.trim().split('\n').slice(-5).join('\n');
    const how = ctx.signal.aborted ? 'was stopped' : `exited ${r.code ?? 'without a code'}`;
    return { name, status: 'fail', detail: `${`${command} ${how}${tail ? `: ${tail}` : ''}`.slice(0, 4000 - MAX_SKIP_NOTE - 100)}${skipped}`, durationMs, logPath, testsRun, ...(r.timedOut ? { inconclusive: 'timed out' as const } : {}) };
  }
  return { name, status: 'pass', detail: `${command.slice(0, 2000)}${skipped}`, durationMs, logPath, testsRun };
}

export { unanswered };

/** Why an unanswered check gave no answer, in words for the verdict and the hold note. */
export function unansweredWhy(c: CheckResult): string {
  return c.inconclusive === 'timed out' ? `The ${c.name} check ran out of its ${CHECK_MS / 60_000} minute limit` : `The ${c.name} check was refused`;
}

/** The configured checks of a repo, in the order they run. */
export const CHECK_ORDER = ['test', 'typecheck', 'lint', 'build'] as const;
