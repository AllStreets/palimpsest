/**
 * The install stage of a run (Task 13 interface; Task 14 fills the
 * per-ecosystem commands and their detection).
 *
 * The runner sets the run's egress proxy to stage `install` (the registries
 * of the repo's ecosystems only) before it calls `installDeps`, and back to
 * `working` after. The install command runs through `execTool()` under the
 * tool profile like any agent command, so the sandbox, not the engine,
 * bounds it.
 */
import type { CheckResult, Repo } from '../../shared/types.js';
import { execTool } from './broker.js';
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
  const r = await execTool({ ...ctx, command, timeoutMs: INSTALL_MS, stage: 'install' });
  const durationMs = Date.now() - started;
  if (r.refused) return { name: 'install', status: 'fail', detail: `Refused: ${r.refused}`, durationMs, logPath: null, testsRun: null };
  if (r.code !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
    return { name: 'install', status: 'fail', detail: `${command} exited ${r.code ?? 'without a code'}${tail ? `: ${tail}` : ''}`, durationMs, logPath: null, testsRun: null };
  }
  return { name: 'install', status: 'pass', detail: command, durationMs, logPath: null, testsRun: null };
};
