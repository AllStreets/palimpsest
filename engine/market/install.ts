/**
 * The install stage of a run (Task 13 interface; Task 14 fills the
 * per-ecosystem commands, detected in engine/guild/checks.ts).
 *
 * The runner sets the run's egress proxy to stage `install` (the registries
 * of the repo's ecosystems, plus the GitHub HTTPS hosts its own lockfiles
 * name, see lock-sources.ts) before it calls `installDeps`, and back to
 * `working` after. The install command runs through `execTool()` under the
 * tool profile like any agent command, so the sandbox, not the engine,
 * bounds it.
 */
import { basename } from 'node:path';

import type { CheckResult, Repo } from '../../shared/types.js';
import { execTool } from './broker.js';
import { hostsFor, type Egress } from './egress.js';
import { lockSources, refusalText } from './lock-sources.js';
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
  /**
   * The run's egress proxy: the install stage opens it to the repo's
   * registries and nothing else, and listens for the hosts it refuses.
   */
  egress?: Pick<Egress, 'setStage'> & Partial<Pick<Egress, 'onRefused'>>;
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
  // A dependency the lockfiles fetch over SSH or git:// can never install here: say which, before the install runs.
  const sources = lockSources(ctx.dir);
  if (sources.refused.length) {
    const detail = `Cannot install: ${refusalText(sources.refused)}.`.slice(0, 4000);
    ctx.log({ at: new Date().toISOString(), kind: 'engine', text: `[palimpsest] ${detail}` });
    return { name: 'install', status: 'fail', detail, durationMs: Date.now() - started, logPath: null, testsRun: null };
  }
  // Only the registries of the ecosystems the repo's lockfiles name, and the GitHub HTTPS hosts they fetch from; the caller sets the next stage after.
  const allowed = [...new Set([...hostsFor('install', repo.checks?.ecosystems ?? [], null), ...sources.hosts])];
  ctx.egress?.setStage('install', allowed);
  // A host the proxy refuses can never answer, and npm retries a refused tunnel until its time limit: the first refusal
  // stops the install at once, with the host named, instead of ten minutes later with nothing said.
  const stop = new AbortController();
  const onRunAbort = () => stop.abort();
  if (ctx.signal.aborted) stop.abort();
  else ctx.signal.addEventListener('abort', onRunAbort, { once: true });
  let refusedHost: string | null = null;
  const unlisten = ctx.egress?.onRefused?.((host) => {
    if (refusedHost !== null) return;
    refusedHost = host;
    stop.abort();
  });
  let r: Awaited<ReturnType<typeof execTool>>;
  try {
    r = await execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, log: ctx.log, signal: stop.signal, command, timeoutMs: INSTALL_MS, stage: 'install', side: ctx.side });
  } finally {
    unlisten?.();
    ctx.signal.removeEventListener('abort', onRunAbort);
  }
  const durationMs = Date.now() - started;
  if (refusedHost !== null && !ctx.signal.aborted) {
    const detail = refusedText(command, refusedHost, allowed);
    ctx.log({ at: new Date().toISOString(), kind: 'engine', text: `[palimpsest] ${detail}` });
    return { name: 'install', status: 'fail', detail, durationMs, logPath: null, testsRun: null };
  }
  if (r.refused) return { name: 'install', status: 'fail', detail: `Refused: ${r.refused}`, durationMs, logPath: null, testsRun: null };
  if (r.code !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
    return { name: 'install', status: 'fail', detail: `${command} exited ${r.code ?? 'without a code'}${tail ? `: ${tail}` : ''}`, durationMs, logPath: null, testsRun: null };
  }
  return { name: 'install', status: 'pass', detail: command, durationMs, logPath: null, testsRun: null };
};

/** Why an install was stopped at the proxy's first refusal. */
export function refusedText(command: string, host: string, allowed: string[]): string {
  return (
    `${command} was stopped: it tried to reach ${host}, which a run's install may not reach ` +
    `(it may reach only ${allowed.length ? allowed.join(', ') : 'no host'}). ` +
    'A dependency that downloads from another host while it installs cannot install here.'
  );
}

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
