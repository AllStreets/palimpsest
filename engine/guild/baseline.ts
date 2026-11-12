/**
 * Baselines (ruling 12) and the harness proposal (ruling 23).
 *
 * "No previously passing test fails" is measured against the repo's own
 * checks at the run's base commit. A baseline is computed once per sha in
 * its own run root, `<home>/runs/baseline-<repoSlug>-<sha7>`, under a tool
 * profile generated for that root: a fresh clone at the sha, the install
 * (egress to the repo's registries only), then every configured check
 * (egress allows nothing). The result is cached in `baselines`; a baseline
 * whose install failed, or that was stopped, is never cached, so a failure
 * of the city's own is never taken for a preexisting one.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CheckResult, Job, Repo } from '../../shared/types.js';
import { openDb } from '../db.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { forgetRun, reapRun } from '../market/broker.js';
import { startEgress, type Egress } from '../market/egress.js';
import { installDeps as defaultInstallDeps, type InstallDeps, type RunContext } from '../market/install.js';
import { proposeHarnessJob } from '../market/jobs.js';
import type { RunLogLine } from '../market/provider.js';
import { createRunDir, engineGit, removeRunDir } from '../market/worktree.js';
import { CHECK_ORDER, runCheck } from './checks.js';

/** The run id (and run root name) of `fullName`'s baseline at `sha`. */
export function baselineRunId(fullName: string, sha: string): string {
  return `baseline-${fullName.replace('/', '__')}-${sha.slice(0, 7)}`;
}

/** The cached baseline of `fullName` at `sha`, or null. */
export function cachedBaseline(fullName: string, sha: string): CheckResult[] | null {
  const row = openDb().prepare('SELECT json FROM baselines WHERE repo = ? AND sha = ?').get(fullName, sha) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as CheckResult[]) : null;
}

/** Forgets every cached baseline of `fullName` (its checks changed, so they no longer say what passed). */
export function clearBaselines(fullName: string): void {
  openDb().prepare('DELETE FROM baselines WHERE repo = ?').run(fullName);
}

export interface BaselineOptions {
  /** The caller's signal (the run's): an abort stops the baseline's commands and caches nothing. */
  signal?: AbortSignal;
  /** Where the baseline's log lines go besides its own `log.jsonl`. */
  log?: (line: RunLogLine) => void;
  /** The install stage (default installDeps). */
  installDeps?: InstallDeps;
}

const inFlight = new Map<string, Promise<CheckResult[]>>();

class Stopped extends Error {
  constructor() {
    super('The baseline was stopped.');
  }
}

/**
 * The repo's checks at `sha`: the install result, then each configured
 * check in CHECK_ORDER. From the cache when there; else computed on a fresh
 * run root and cached. Rejects when `signal` aborts.
 */
export function baseline(repo: Repo, sha: string, opts: BaselineOptions = {}): Promise<CheckResult[]> {
  const cached = cachedBaseline(repo.fullName, sha);
  if (cached) return Promise.resolve(cached);
  if (opts.signal?.aborted) return Promise.reject(new Stopped());
  const key = `${repo.fullName}@${sha}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = compute(repo, sha, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function compute(repo: Repo, sha: string, opts: BaselineOptions): Promise<CheckResult[]> {
  const checks = repo.checks;
  if (!checks) return [];
  const signal = opts.signal ?? new AbortController().signal;
  const runId = baselineRunId(repo.fullName, sha);
  const runRoot = join(paths().runs, runId);
  const logFile = join(runRoot, 'log.jsonl');
  const log = (line: RunLogLine) => {
    try {
      appendFileSync(logFile, `${JSON.stringify(line)}\n`);
    } catch {
      // the log is best effort; the results are what is kept
    }
    opts.log?.(line);
  };
  const stopped = () => {
    if (signal.aborted) throw new Stopped();
  };

  // A root left by an engine that stopped part way is cleared first.
  if (existsSync(join(runRoot, 'repo'))) {
    await reapRun(runRoot);
    removeRunDir(runId);
  }
  let egress: Egress | null = null;
  try {
    const { dir } = await createRunDir(repo, runId, `palimpsest/baseline-${sha.slice(0, 7)}`);
    stopped();
    const co = await engineGit(dir, ['checkout', '--quiet', '--detach', sha]);
    if (co.code !== 0) throw new Error(`The baseline could not check out ${sha.slice(0, 7)}: ${co.stderr.trim()}`);
    log({ at: new Date().toISOString(), kind: 'engine', text: `baseline of ${repo.fullName} at ${sha}` });
    egress = await startEgress(runId, log);
    stopped();

    const ctx: RunContext = { runId, runRoot, dir, log, signal, egress };
    const install = await (opts.installDeps ?? defaultInstallDeps)(ctx, repo);
    stopped();
    const results: CheckResult[] = [install];
    record('check.done', { runId, baseline: true, repo: repo.fullName, sha, check: install });
    // Without its dependencies no check says anything about the repo: nothing is cached.
    if (install.status === 'fail') return results;

    egress.setStage('checks', []);
    for (const name of CHECK_ORDER) {
      const command = checks[name];
      if (!command) continue;
      const r = await runCheck(ctx, name, command, log);
      stopped();
      results.push(r);
      record('check.done', { runId, baseline: true, repo: repo.fullName, sha, check: r });
    }
    openDb()
      .prepare('INSERT OR REPLACE INTO baselines (repo, sha, json) VALUES (?, ?, ?)')
      .run(repo.fullName, sha, JSON.stringify(results));
    return results;
  } finally {
    try {
      await egress?.close();
    } catch {
      // best effort; the port registry entry goes with it
    }
    try {
      if (existsSync(runRoot)) await reapRun(runRoot);
    } catch (err) {
      console.warn(`palimpsest: reaping baseline ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    forgetRun(runId);
    removeRunDir(runId);
  }
}

/**
 * Proposes "Add a baseline test and build harness" (ruling 23) when the
 * repo's detected checks have no test or no build command. The proposal
 * waits for his click; the key rule (`HARNESS_KEY`, `keyTaken`) returns the
 * job already posted, dismissed or merged under it, so a re-analysis never
 * doubles it and a merged harness is not proposed again by itself. Null
 * when checks are not detected yet or both exist.
 */
export function ensureHarnessProposal(repo: Repo): Job | null {
  const c = repo.checks;
  if (!c) return null;
  if (c.test && c.build) return null;
  return proposeHarnessJob(repo);
}
