/**
 * Baselines and the harness proposal (Task 14). The repo is a temp bare
 * mirror (test safety rule 5) holding a tiny real `node --test` suite. Its
 * checks run under the tool profile through sandbox-exec when the Mac has
 * it, else with PALIMPSEST_SANDBOX=off under the temp home (rule 7).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { mirrorDir } from '../engine/mirror.js';
import { baseline, baselineRunId, cachedBaseline, ensureHarnessProposal } from '../engine/guild/baseline.js';
import { listJobs } from '../engine/market/jobs.js';
import { SANDBOX_EXEC } from '../engine/market/sandbox.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Repo, RepoChecks } from '../shared/types.js';

let tempDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX'];
let commands: string[] = [];
let launchers: string[] = [];

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-baseline-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  if (existsSync(SANDBOX_EXEC)) delete process.env.PALIMPSEST_SANDBOX;
  else process.env.PALIMPSEST_SANDBOX = 'off';
  commands = [];
  launchers = [];
  setSpawner((cmd, args, opts) => {
    commands.push(args.at(-1) ?? cmd);
    launchers.push(cmd);
    return realSpawner(cmd, args, opts);
  });
});

afterEach(() => {
  setSpawner(realSpawner);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function checks(over: Partial<RepoChecks>): RepoChecks {
  return { test: null, typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: ['/'], install: null, ecosystems: [], detected: true, ...over };
}

/** A connected repo whose mirror holds two commits of a tiny node --test suite: the second one breaks a test. */
function makeRepo(c: RepoChecks): { repo: Repo; first: string; second: string } {
  const repo: Repo = {
    fullName: 'acme/widgets',
    private: false,
    defaultBranch: 'main',
    language: 'JavaScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    joinedAt: '2026-11-01T00:00:00.000Z',
    checks: c,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'work');
  mkdirSync(join(work, 'test'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(work, 'test', 'a.test.mjs'), "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n");
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'test', 'a.test.mjs'), "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => { throw new Error('no'); });\ntest('three', () => {});\n");
  git(work, 'commit', '-q', '-am', 'second');
  const second = git(work, 'rev-parse', 'HEAD');
  mkdirSync(paths().mirrors, { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', work, mirrorDir(repo.fullName));
  return { repo, first, second };
}

test('the baseline caches per sha', { timeout: 120_000 }, async () => {
  const { repo, first, second } = makeRepo(checks({ test: 'node --test' }));

  const a = await baseline(repo, first);
  assert.deepEqual(a.map((c) => [c.name, c.status]), [['install', 'skipped'], ['test', 'pass']]);
  assert.equal(a.find((c) => c.name === 'test')?.testsRun, 2);
  assert.deepEqual(cachedBaseline(repo.fullName, first), a);
  const ran = commands.filter((c) => c === 'node --test').length;
  assert.equal(ran, 1);
  // The repo's own suite ran under the tool profile wherever sandbox-exec exists.
  if (existsSync(SANDBOX_EXEC)) assert.deepEqual([...new Set(launchers)], [SANDBOX_EXEC]);

  // The same sha comes from the cache: nothing runs again.
  const again = await baseline(repo, first);
  assert.deepEqual(again, a);
  assert.equal(commands.filter((c) => c === 'node --test').length, 1);

  // Another sha is its own baseline, computed at that commit.
  const b = await baseline(repo, second);
  assert.equal(b.find((c) => c.name === 'test')?.status, 'fail');
  assert.equal(b.find((c) => c.name === 'test')?.testsRun, 3);
  assert.equal(commands.filter((c) => c === 'node --test').length, 2);

  // Each baseline ran in its own run root, and the clone is gone after.
  const root = join(paths().runs, baselineRunId(repo.fullName, first));
  assert.equal(root.endsWith(`baseline-acme__widgets-${first.slice(0, 7)}`), true);
  assert.equal(existsSync(join(root, 'repo')), false);
});

test('an aborted baseline is not cached', { timeout: 60_000 }, async () => {
  const { repo, first } = makeRepo(checks({ test: 'node --test' }));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(baseline(repo, first, { signal: ac.signal }));
  assert.equal(cachedBaseline(repo.fullName, first), null);
  assert.equal(commands.includes('node --test'), false);
});

test('a repo without a build command gets one harness proposal, not two', () => {
  const { repo } = makeRepo(checks({ test: 'node --test' }));
  const one = ensureHarnessProposal(repo);
  const two = ensureHarnessProposal(repo);
  assert.ok(one);
  assert.equal(two?.id, one.id);
  const jobs = listJobs({ repo: repo.fullName, source: 'harness' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'proposed');

  // A repo whose checks are not detected yet gets none.
  assert.equal(ensureHarnessProposal({ ...repo, fullName: 'acme/other', checks: null }), null);
  assert.equal(listJobs({ repo: 'acme/other' }).length, 0);
});

test('a repo with both commands gets none', () => {
  const { repo } = makeRepo(checks({ test: 'node --test', build: 'npm run build' }));
  assert.equal(ensureHarnessProposal(repo), null);
  assert.equal(listJobs({ repo: repo.fullName, source: 'harness' }).length, 0);
});
