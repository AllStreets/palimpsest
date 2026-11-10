/**
 * The inspection (Task 15): the repo's checks after the change against the
 * baseline, the scope, the reviewer and the verdict. Temp home with the
 * sandbox off (test safety rule 7), temp mirrors holding a real
 * `node --test` suite (rule 5), every model the fake provider (rule 6).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import { baseline } from '../engine/guild/baseline.js';
import { canOpenPR, canPush, DENY_SCOPE, inspect, inspectionSummary, scopeCheck } from '../engine/guild/inspect.js';
import { abortLease } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import { setProvider } from '../engine/market/providers.js';
import { getRepo } from '../engine/repos.js';
import type { CheckResult } from '../shared/types.js';
import { addAgent, checks, FULL, makeRepo, makeRun, postJob, setUp, suite, tearDown, workLease, write } from './guild-fixtures.js';

beforeEach(() => {
  setUp('inspect');
  setProvider('claude', fakeProvider());
  setProvider('ollama', fakeProvider());
});
afterEach(tearDown);

const statusOf = (cs: CheckResult[], name: string) => cs.find((c) => c.name === name)?.status;

function team() {
  const worker = addAgent('wanda', 'alpha', 'claude:sonnet');
  const reviewer = addAgent('rex', 'beta', 'claude:sonnet');
  return { worker, reviewer };
}

test('a missing test command is skipped, never passed', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks({ test: null, build: null }), { 'src/header.ts': 'export const header = 1;\n' });
  const { worker } = team();
  const job = postJob(['src/**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'src/header.ts', 'export const header = 2;\n'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    assert.equal(statusOf(insp.checks, 'test'), 'skipped');
    assert.equal(statusOf(insp.checks, 'build'), 'skipped');
    assert.ok(!insp.checks.some((c) => c.name === 'test' && c.status === 'pass'));
    // The repo has neither command: a PR may open, but never a push.
    assert.equal(insp.passed, true);
    assert.equal(insp.pushable, false);
    assert.equal(canPush(insp.checks), false);
  } finally {
    lease.release();
  }
});

test('a test failing before and after is preexisting: PR allowed, push refused', { timeout: 120_000 }, async () => {
  const repo = makeRepo(checks({ test: 'node --test', build: 'node -e 0' }), {
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'test/a.test.mjs': suite(true),
    'src/header.ts': 'export const header = 1;\n',
  });
  const { worker } = team();
  const job = postJob(['src/**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'src/header.ts', 'export const header = 2;\n'));
  const base = await baseline(repo, run.baseSha as string);
  assert.equal(statusOf(base, 'test'), 'fail');
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    assert.equal(statusOf(insp.checks, 'test'), 'preexisting');
    assert.equal(statusOf(insp.checks, 'build'), 'pass');
    assert.equal(insp.passed, true, 'a preexisting failure does not block a PR');
    assert.equal(insp.pushable, false, 'it does block push mode');
  } finally {
    lease.release();
  }
});

test('a new failure fails', { timeout: 120_000 }, async () => {
  const repo = makeRepo(checks({ test: 'node --test' }), {
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'test/a.test.mjs': suite(false),
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'test/a.test.mjs', suite(true)));
  await baseline(repo, run.baseSha as string);
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    assert.equal(statusOf(insp.checks, 'test'), 'fail');
    assert.equal(insp.passed, false);
    assert.equal(insp.pushable, false);
    // Each check and the verdict are on the ledger, the verdict with its reviewer.
    const done = entries().filter((e) => e.kind === 'check.done' && (e.data as { runId: string }).runId === run.id);
    assert.ok(done.some((e) => (e.data as { check: CheckResult }).check.name === 'test'));
    const verdict = entries().find((e) => e.kind === 'inspection.done');
    const v = verdict?.data as { reviewerAgentId: string; reviewerFirmId: string; inspection: { passed: boolean } };
    assert.equal(v.reviewerAgentId, 'rex');
    assert.equal(v.reviewerFirmId, 'beta');
    assert.equal(v.inspection.passed, false);
    assert.match(inspectionSummary(insp), /test/);
    // Stored for the inspection screen.
    assert.ok(openDb().prepare('SELECT id FROM inspections WHERE run_id = ?').get(run.id));
  } finally {
    lease.release();
  }
});

test('out of scope file fails scope', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks(), { 'src/header.ts': 'export const header = 1;\n', 'README.md': 'widgets\n' });
  const { worker } = team();
  const job = postJob(['src/**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => {
    write(dir, 'src/header.ts', 'export const header = 2;\n');
    write(dir, 'README.md', 'widgets, changed\n');
  });
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    assert.equal(statusOf(insp.checks, 'scope'), 'fail');
    assert.match(insp.checks.find((c) => c.name === 'scope')!.detail, /README\.md/);
    assert.equal(insp.passed, false);
  } finally {
    lease.release();
  }
});

test('workflow and .claude files always fail scope', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks(), { 'src/header.ts': 'export const header = 1;\n' });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => {
    write(dir, '.github/workflows/ci.yml', 'on: push\n');
    write(dir, '.claude/settings.json', '{}\n');
  });
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    const scope = insp.checks.find((c) => c.name === 'scope')!;
    assert.equal(scope.status, 'fail');
    assert.match(scope.detail, /\.github\/workflows\/ci\.yml/);
    assert.match(scope.detail, /\.claude\/settings\.json/);
  } finally {
    lease.release();
  }

  // The rules on their own: the deny list wins over any scope, a lockfile needs its manifest, a nested repo is out.
  assert.ok(DENY_SCOPE.includes('.github/workflows/**'));
  const f = (path: string, gitlink = false) => ({ path, gitlink });
  assert.equal(scopeCheck([f('src/a.ts')], ['src/**']).status, 'pass');
  assert.equal(scopeCheck([f('.env')], ['**']).status, 'fail');
  assert.equal(scopeCheck([f('config/.env.local')], ['**']).status, 'fail');
  assert.equal(scopeCheck([f('certs/server.pem')], ['**']).status, 'fail');
  assert.equal(scopeCheck([f('deploy/id_rsa.pub')], ['**']).status, 'fail');
  assert.equal(scopeCheck([f('package-lock.json')], ['src/**']).status, 'fail', 'a lockfile alone is out');
  assert.equal(scopeCheck([f('package.json'), f('package-lock.json')], ['package.json']).status, 'pass', 'with its manifest it rides along');
  assert.equal(scopeCheck([f('web/package.json'), f('package-lock.json')], ['**']).status, 'fail', 'the manifest must sit beside it');
  assert.equal(scopeCheck([f('vendor/lib', true)], ['**']).status, 'fail', 'a gitlink is out of scope');
});

test('three failures halt the repo and a pass resets strikes', { timeout: 120_000 }, async () => {
  const repo = makeRepo(checks(), { 'src/header.ts': 'export const header = 1;\n', 'README.md': 'w\n' });
  const { worker } = team();
  const lease = await workLease();
  const once = async (inScope: boolean, n: number) => {
    const job = postJob(['src/**']);
    const { run, diff } = await makeRun(getRepo(FULL)!, job, worker, (dir) => write(dir, inScope ? 'src/header.ts' : 'README.md', `change ${n}\n`));
    return inspect(run, job, getRepo(FULL)!, diff, lease);
  };
  try {
    assert.equal((await once(false, 1)).passed, false);
    assert.equal((await once(false, 2)).passed, false);
    assert.equal(getRepo(FULL)!.strikes, 2);
    assert.equal(getRepo(FULL)!.halted, null);
    assert.equal((await once(true, 3)).passed, true);
    assert.equal(getRepo(FULL)!.strikes, 0, 'a pass resets strikes');

    for (const n of [4, 5]) await once(false, n);
    assert.equal(getRepo(FULL)!.halted, null);
    await once(false, 6);
    const halted = getRepo(FULL)!;
    assert.equal(halted.strikes, 3);
    assert.ok(halted.halted, 'three failures in a row halt the repo');
    assert.match(halted.halted!.reason, /three/i);
    assert.ok(entries().some((e) => e.kind === 'repo.halted' && (e.data as { repo: string }).repo === repo.fullName));
  } finally {
    lease.release();
  }
});

test('the inspection reads the committed change, not the run dir after it', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks(), { 'src/header.ts': 'export const header = 1;\n' });
  const { worker } = team();
  const job = postJob(['src/**']);
  const { run, diff, dir } = await makeRun(repo, job, worker, (d) => write(d, 'src/header.ts', 'export const header = 2;\n'));
  // Something writes into the run dir after the engine's commit.
  write(dir, 'src/late.ts', 'export const late = true;\n');
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    assert.equal(insp.passed, false);
    assert.match(insp.checks.find((c) => c.name === 'scope')!.detail, /commit/);
  } finally {
    lease.release();
  }
});

test('abort ends the inspection and kills the running check', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks({ test: 'sleep 30' }), { 'src/header.ts': 'export const header = 1;\n' });
  const { worker } = team();
  const job = postJob(['src/**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'src/header.ts', 'export const header = 2;\n'));
  const pids: number[] = [];
  setSpawner((cmd, args, opts) => {
    const child = realSpawner(cmd, args, opts);
    if (args.at(-1) === 'sleep 30' && child.pid) pids.push(child.pid);
    return child;
  });
  const lease = await workLease();
  try {
    const started = Date.now();
    const p = inspect(run, job, repo, diff, lease);
    while (pids.length === 0) {
      if (Date.now() - started > 20_000) throw new Error('the check never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    abortLease(lease, new Error('stop the inspection'));
    await assert.rejects(p, /stop the inspection|stopped|abort/i);
    assert.ok(Date.now() - started < 15_000, 'the inspection ended promptly');
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pids[0], 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the running check was killed');
    assert.equal(entries().some((e) => e.kind === 'inspection.done'), false, 'no verdict for an aborted inspection');
  } finally {
    lease.release();
  }
});

test('canOpenPR and canPush', () => {
  const c = (name: CheckResult['name'], status: CheckResult['status']): CheckResult => ({ name, status, detail: '', durationMs: 0, logPath: null, testsRun: null });
  const good = [c('test', 'pass'), c('build', 'pass'), c('scope', 'pass'), c('review', 'pass')];
  assert.equal(canOpenPR(good), true);
  assert.equal(canPush(good), true);
  assert.equal(canOpenPR([...good.slice(0, 3), c('review', 'fail')]), false);
  assert.equal(canOpenPR([c('test', 'preexisting'), c('build', 'skipped'), c('scope', 'pass'), c('review', 'pass')]), true);
  assert.equal(canPush([c('test', 'preexisting'), c('build', 'pass'), c('scope', 'pass'), c('review', 'pass')]), false);
  assert.equal(canPush([c('test', 'pass'), c('build', 'skipped'), c('scope', 'pass'), c('review', 'pass')]), false);
  assert.equal(canOpenPR([...good, c('design', 'fail')]), false);
  assert.equal(canOpenPR([c('test', 'skipped'), c('build', 'skipped'), c('scope', 'pass')]), false, 'no review, no PR');
});
