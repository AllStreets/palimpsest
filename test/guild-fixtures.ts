/**
 * Shared fixtures for the inspection guild's tests (Task 15): a temp home
 * with the sandbox off (test safety rule 7), a fresh usage reading, temp
 * bare mirrors (rule 5), firms and agents in the database, and runs whose
 * change is really committed in a run dir. No model is ever called: every
 * backend is the fake provider (rule 6).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { mirrorDir } from '../engine/mirror.js';
import { acquire, resetBudget, type Lease } from '../engine/market/budget.js';
import { postManualJob, settleJobEffects } from '../engine/market/jobs.js';
import { resetProviders } from '../engine/market/providers.js';
import { resetRuns, type RunDiff } from '../engine/market/runs.js';
import { commitAll, createRunDir, diffOf } from '../engine/market/worktree.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Agent, Firm, Job, ModelRef, Repo, RepoChecks, Run } from '../shared/types.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const FULL = 'acme/widgets';

const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_SANDBOX'];
const saved: Record<string, string | undefined> = {};
export let tempDir = '';

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

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A temp home with the sandbox off and a fresh reading (so Claude is not paused as stale). */
export function setUp(name: string): void {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), `palimpsest-${name}-test-`));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  process.env.PALIMPSEST_SANDBOX = 'off';
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetRuns();
  resetBudget();
  resetProviders();
  reading();
}

export async function tearDown(): Promise<void> {
  resetRuns();
  await settleJobEffects();
  resetBudget();
  resetProviders();
  setSpawner(realSpawner);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
}

/** His usage reading, taken now; `five` is his five-hour percent. */
export function reading(five = 10): void {
  const now = Date.now();
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(now / 1000),
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: Math.floor((now + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((now + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

/** No reading at all: the Claude pool is paused as stale. */
export function noReading(): void {
  rmSync(join(paths().usage, 'latest.json'), { force: true });
}

export function checks(over: Partial<RepoChecks> = {}): RepoChecks {
  return { test: null, typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: ['/'], install: null, ecosystems: [], detected: true, ...over };
}

/** A tiny real node --test suite: two passing tests, or one failing when `broken`. */
export function suite(broken = false): string {
  return broken
    ? "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => { throw new Error('no'); });\n"
    : "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n";
}

/** A connected repo with the market on, whose bare mirror holds `files` in one commit on main. */
export function makeRepo(c: RepoChecks, files: Record<string, string>, full = FULL): Repo {
  const repo: Repo = {
    fullName: full,
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
    market: true,
    joinedAt: '2026-11-01T00:00:00.000Z',
    checks: c,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'work', full.replace('/', '__'));
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  mkdirSync(paths().mirrors, { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', work, mirrorDir(full));
  return repo;
}

let slot = 0;
export function addFirm(id: string, over: Partial<Firm> = {}): Firm {
  const f: Firm = {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    root: 'roman',
    motto: '',
    slot: 100 + slot++,
    balance: 300,
    status: 'active',
    negativeSince: null,
    bankruptAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO firms (id, json) VALUES (?, ?)').run(f.id, JSON.stringify(f));
  return f;
}

export function addAgent(id: string, firmId: string, model: ModelRef, over: Partial<Agent> = {}): Agent {
  const a: Agent = {
    id,
    firmId,
    name: `Agent ${id}`,
    model,
    persona: `${id} reads carefully.`,
    temperament: 'careful',
    instructions: 'Do good work.',
    tools: [],
    workflow: { shape: 'single' },
    memory: { examples: 0 },
    lineage: { origin: 'seeded', parents: [], generation: 0, at: '2026-11-01T00:00:00.000Z' },
    silhouette: 'plain',
    maxTurns: 30,
    capability: 'scifi',
    bidsOn: ['low', 'normal', 'high'],
    retired: false,
    retiredReason: null,
    towerIndex: 0,
    ...over,
  };
  if (!openDb().prepare('SELECT id FROM firms WHERE id = ?').get(firmId)) addFirm(firmId);
  openDb().prepare('INSERT OR REPLACE INTO agents (id, firm_id, json) VALUES (?, ?, ?)').run(a.id, a.firmId, JSON.stringify(a));
  return a;
}

export function postJob(scope: string[], full = FULL): Job {
  return postManualJob({ repo: full, title: 'Change the widgets', body: 'Change the widgets.', tier: 'normal', scope });
}

export async function workLease(model: ModelRef = 'claude:sonnet'): Promise<Lease> {
  const got = await acquire(model, 'work', 10);
  assert.ok(got.ok, `no work lease: ${got.ok ? '' : got.reason.detail}`);
  return got.lease;
}

let runN = 0;
/**
 * A run of `worker` on `job`: a real run dir cloned from the mirror, the
 * change `edit` makes, committed by the engine (headSha), and its diff.
 */
export async function makeRun(repo: Repo, job: Job, worker: Agent, edit: (dir: string) => void): Promise<{ run: Run; diff: RunDiff; dir: string }> {
  const id = `run-test${String(runN++).padStart(4, '0')}`;
  const branch = `palimpsest/${job.id}`;
  const { runRoot, dir, baseSha } = await createRunDir(repo, id, branch);
  edit(dir);
  const headSha = await commitAll(dir, job.title, job.id);
  assert.ok(headSha, 'the edit changed nothing');
  const d = await diffOf(dir, baseSha);
  const patchPath = join(runRoot, 'diff.patch');
  writeFileSync(patchPath, d.patch);
  const run: Run = {
    id,
    jobId: job.id,
    bidId: `bid-${id}`,
    agentId: worker.id,
    firmId: worker.firmId,
    repo: repo.fullName,
    model: worker.model,
    branch,
    dir,
    baseSha,
    headSha,
    stage: 'inspecting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: new Date().toISOString(),
    endedAt: null,
    prNumber: null,
    prUrl: null,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    summary: 'I changed the widgets.',
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(run.id, run.jobId, run.repo, run.stage, JSON.stringify(run));
  return { run, diff: { ...d, patchPath }, dir };
}

export function write(dir: string, name: string, text: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
}

/** A 1 x 1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
