import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Paths {
  db: string;
  mirrors: string;
  usage: string;
  logs: string;
  stop: string;
  dist: string;
  /** One directory per market run (worktree, logs, control files). */
  runs: string;
  /** The daily reports. */
  reports: string;
}

/** Where the data lives when PALIMPSEST_HOME is not set: ~/Library/Application Support/Palimpsest. */
export function defaultHome(): string {
  return join(homedir(), 'Library', 'Application Support', 'Palimpsest');
}

/** The configured data home, unchecked. An empty value (PALIMPSEST_HOME="") means unset, never the current folder. */
function configuredHome(env: NodeJS.ProcessEnv): string {
  return env.PALIMPSEST_HOME || defaultHome();
}

/** True inside a `node --test` process (the runner sets NODE_TEST_CONTEXT in every test file's process). */
function underTest(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || (env === process.env && process.execArgv.includes('--test'));
}

/**
 * The data home. Honours PALIMPSEST_HOME, read fresh on every call.
 *
 * Under a test it fails closed: a test whose home is unset (a tearDown that
 * ran before a run's async tail) or that names the real home, however it is
 * spelled, throws here, so no test can open, create or write anything in
 * his real data home.
 */
export function home(env: NodeJS.ProcessEnv = process.env): string {
  const h = configuredHome(env);
  if (underTest(env) && (!env.PALIMPSEST_HOME || isRealDataHome(h))) {
    throw new Error(`refused: a test reached the real data home (PALIMPSEST_HOME is ${env.PALIMPSEST_HOME ? 'the real home' : 'unset'})`);
  }
  return h;
}

/**
 * True when the configured home is the real data home. Never throws, so the
 * real-home refusals (sandbox off, GitHub writes, push targets) still answer
 * under a test without opening anything there.
 */
export function onRealDataHome(env: NodeJS.ProcessEnv = process.env): boolean {
  return isRealDataHome(configuredHome(env));
}

/**
 * Resolves every data path under the home, creating the directories that
 * hold files (mirrors, usage, logs, runs, reports). `db` and `stop` are file paths whose
 * parent (the home itself) is created, but the files are not. `dist` is
 * the built UI's output directory, resolved from this module's own location
 * (not the data home), overridable with PALIMPSEST_DIST.
 */
export function paths(): Paths {
  const base = home();
  const mirrors = join(base, 'mirrors');
  const usage = join(base, 'usage');
  const logs = join(base, 'logs');
  const db = join(base, 'palimpsest.db');
  const stop = join(base, 'STOP');
  const runs = join(base, 'runs');
  const reports = join(base, 'reports');

  for (const dir of [base, mirrors, usage, logs, runs, reports]) {
    mkdirSync(dir, { recursive: true });
  }
  // Spotlight never indexes a run, so it never holds a sandbox extension for a run's files.
  const neverIndex = join(runs, '.metadata_never_index');
  if (!existsSync(neverIndex)) writeFileSync(neverIndex, '');

  const engineDir = dirname(fileURLToPath(import.meta.url));
  const dist = process.env.PALIMPSEST_DIST ?? join(engineDir, '..', 'dist');

  return { db, mirrors, usage, logs, stop, dist, runs, reports };
}

/**
 * A path in a canonical form for comparison: the real path of its deepest
 * existing ancestor (resolving symlinks and parent steps), lowercased because
 * the Mac's default volume ignores letter case.
 */
function canonical(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs).toLowerCase();
  const parent = dirname(abs);
  if (parent === abs) return abs.toLowerCase();
  return join(canonical(parent), basename(abs).toLowerCase());
}

/** True when `dir` is the real data home, however it is spelled: through a symlink, a parent step or another letter case. */
export function isRealDataHome(dir: string, real: string = defaultHome()): boolean {
  return canonical(dir) === canonical(real);
}
