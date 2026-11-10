/**
 * The install stage of a run (Task 13 interface; Task 14 fills the
 * per-ecosystem commands, detected in engine/guild/checks.ts).
 *
 * The runner sets the run's egress proxy to stage `install` (the registries
 * of the repo's ecosystems only) before it calls `installDeps`, and back to
 * `working` after. The install command runs through `execTool()` under the
 * tool profile like any agent command, so the sandbox, not the engine,
 * bounds it.
 */
import { basename } from 'node:path';

import type { CheckResult, Repo } from '../../shared/types.js';
import { execTool } from './broker.js';
import { hostsFor, type Egress } from './egress.js';
import type { RunLogLine } from './provider.js';

/** Wall time the install stage may take. */
export const INSTALL_MS = 10 * 60_000;

/** What the install stage and every check get from the runner. */
export interface RunContext {
  runId: string;
  runRoot: string;
  /** The run's clone: `<runRoot>/repo`. */
  dir: string;
  log: (line: RunLogLine) => void;
  /** The run's signal: a kill, the stop file or a hard stop aborts it. */
  signal: AbortSignal;
  /** The run's egress proxy: the install stage opens it to the repo's registries and nothing else. */
  egress?: Pick<Egress, 'setStage'>;
  /**
   * Which side of the run the clone belongs to (default `head`): the design
   * check's base clone is `base`, with its own home, cache, tmp and tool
   * profile. Named by the caller, never read off the folder's name.
   */
  side?: 'head' | 'base';
}

export type InstallDeps = (ctx: RunContext, repo: Repo) => Promise<CheckResult>;

/**
 * Runs `repo.checks.install` with stage `install` and a 10 minute cap;
 * `skipped` when there is nothing to install. A refusal, a non-zero exit, a
 * timeout or an abort is a `fail`.
 */
export const installDeps: InstallDeps = async (ctx, repo) => {
  const command = repo.checks?.install ?? null;
  const started = Date.now();
  if (!command) {
    return { name: 'install', status: 'skipped', detail: 'Nothing to install.', durationMs: 0, logPath: null, testsRun: null };
  }
  // Only the registries of the ecosystems the repo's lockfiles name; the caller sets the next stage after.
  ctx.egress?.setStage('install', hostsFor('install', repo.checks?.ecosystems ?? [], null));
  const r = await execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, log: ctx.log, signal: ctx.signal, command, timeoutMs: INSTALL_MS, stage: 'install', side: ctx.side });
  const durationMs = Date.now() - started;
  if (r.refused) return { name: 'install', status: 'fail', detail: `Refused: ${r.refused}`, durationMs, logPath: null, testsRun: null };
  if (r.code !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
    return { name: 'install', status: 'fail', detail: `${command} exited ${r.code ?? 'without a code'}${tail ? `: ${tail}` : ''}`, durationMs, logPath: null, testsRun: null };
  }
  return { name: 'install', status: 'pass', detail: command, durationMs, logPath: null, testsRun: null };
};

/** Manifests and lockfiles: a change to any of them, anywhere in the tree, means the install runs again. */
export const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
]);

/** True when a diff touching `files` must be installed again before the after-checks run. */
export function needsReinstall(files: string[]): boolean {
  return files.some((f) => DEPENDENCY_FILES.has(basename(f)));
}
