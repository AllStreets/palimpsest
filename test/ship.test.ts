/**
 * Shipping (Task 16). GitHub is two stand-ins: a temp bare repo the mirror
 * was cloned from (real git pushes land there and nowhere else, rule 5) and
 * a fake runner answering every gh call (rule 4). The sandbox is off on a
 * temp home (rule 7); no model is called (rule 6).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { mirrorDir } from '../engine/mirror.js';
import { forbidden } from '../engine/market/guard.js';
import { agentTowerId } from '../engine/market/firms.js';
import { openBidding } from '../engine/market/bids.js';
import { job as storedJob, transition } from '../engine/market/jobs.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import { setProvider } from '../engine/market/providers.js';
import { createScheduler, run as storedRun, startRun } from '../engine/market/runs.js';
import { pollPRs, pushFlags, pushTarget, resetShipping, ship, shipClone, watchReverts, PR_POLL_MS, REVERT_WATCH_MS } from '../engine/market/ship.js';
import { createPR, prState } from '../engine/github.js';
import { createShipDir } from '../engine/market/worktree.js';
import { earnedFloors, getRepo } from '../engine/repos.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Bid, CheckResult, Inspection, Job, Repo, RepoChecks, Run } from '../shared/types.js';
import { addAgent, checks, FULL, git, makeRun, postJob, setUp, tearDown, tempDir } from './guild-fixtures.js';

const TOWER = `${FULL}#founding`;
let events: Event[] = [];
let unsubscribe: () => void = () => {};

type GhCall = string[];
let ghCalls: GhCall[] = [];
let gitCalls: string[][] = [];
let prStates = new Map<number, object>();
/** What `gh pr view --json commits` answers per PR, and who `gh api user` says he is. */
let prCommits = new Map<number, Array<{ oid: string; authors: Array<{ login: string }> }>>();
let viewer = 'connorevans';
let nextPr = 12;
/** Runs before a git command reaches real git (to move the stand-in remote under a push). */
let beforeGit: ((args: string[]) => void) | null = null;

const fakeGh: Runner = async (cmd, args, opts) => {
  if (cmd === 'gh') {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'create') return { stdout: `https://github.com/${FULL}/pull/${nextPr}\n`, stderr: '', code: 0 };
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('commits')) {
      return { stdout: JSON.stringify({ commits: prCommits.get(Number(args[2])) ?? [] }), stderr: '', code: 0 };
    }
    if (args[0] === 'api' && args[1] === 'user') return { stdout: `${viewer}\n`, stderr: '', code: 0 };
    if (args[0] === 'pr' && args[1] === 'view') {
      const s = prStates.get(Number(args[2])) ?? { state: 'OPEN', mergedAt: null, mergeCommit: null, closedAt: null };
      return { stdout: JSON.stringify(s), stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
    if (args[0] === 'auth') return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  if (cmd === 'git') {
    gitCalls.push(args);
    beforeGit?.(args);
  }
  return realRunner(cmd, args, opts);
};

beforeEach(() => {
  setUp('ship');
  resetShipping();
  ghCalls = [];
  gitCalls = [];
  prStates = new Map();
  prCommits = new Map();
  viewer = 'connorevans';
  nextPr = 12;
  beforeGit = null;
  setRunner(fakeGh);
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  setRunner(realRunner);
  await tearDown();
});

// ---------------------------------------------------------------- fixtures

/** The stand-in for GitHub: a bare repo; the mirror is cloned from it, as `gh repo clone --bare` would. */
function makeRemoteRepo(c: RepoChecks, over: Partial<Repo> = {}): { repo: Repo; remote: string } {
  const repo: Repo = {
    fullName: FULL,
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
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'origin-work');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'widgets\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  const remote = join(tempDir, 'github', 'acme__widgets.git');
  mkdirSync(join(tempDir, 'github'), { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', work, remote);
  mkdirSync(paths().mirrors, { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', remote, mirrorDir(FULL));
  return { repo, remote };
}

/** Someone else pushes to main on the stand-in remote (a concurrent merge on GitHub). */
function pushElsewhere(remote: string, name: string): string {
  const w = join(tempDir, `elsewhere-${name}`);
  git(tempDir, 'clone', '-q', remote, w);
  writeFileSync(join(w, `${name}.txt`), `${name}\n`);
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', `elsewhere ${name}`);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  return git(w, 'rev-parse', 'HEAD');
}

const pass = (name: CheckResult['name']): CheckResult => ({ name, status: 'pass', detail: name, durationMs: 1, logPath: null, testsRun: null });

function inspectionOf(r: Run, o: { pushable?: boolean } = {}): Inspection {
  return {
    id: `insp-${r.id}`,
    runId: r.id,
    jobId: r.jobId,
    repo: r.repo,
    reviewerAgentId: 'rev',
    reviewerFirmId: 'meridian',
    checks: [pass('install'), pass('test'), { ...pass('typecheck'), status: 'skipped' }, { ...pass('lint'), status: 'skipped' }, pass('build'), pass('scope'), pass('review')],
    passed: true,
    pushable: o.pushable ?? true,
    design: null,
    cost: 0,
    at: new Date().toISOString(),
  };
}

/** A job moved to `shipping`, as the runner leaves it when the inspection passed. */
function shippingJob(): Job {
  let j = postJob(['**']);
  for (const to of ['bidding', 'awarded', 'running', 'inspecting', 'shipping'] as const) j = transition(j, to);
  return j;
}

function saveRun(r: Run): void {
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
}

/** A committed run and the inspection's ship clone, ready to ship. */
async function readyRun(c: RepoChecks, over: Partial<Repo> = {}, edit?: (dir: string) => void) {
  const { repo, remote } = makeRemoteRepo(c, over);
  const worker = addAgent('w1', 'quickset', 'claude:sonnet');
  const job = shippingJob();
  const made = await makeRun(repo, job, worker, edit ?? ((dir) => writeFileSync(join(dir, 'widgets.md'), '# widgets\n\nnew\n')));
  const r = { ...made.run, stage: 'shipping' as const };
  saveRun(r);
  await createShipDir(repo, r.id, made.dir, r.branch, r.headSha as string);
  return { repo, remote, job, run: r, dir: made.dir, worker };
}

const ctl = () => new AbortController().signal;

/** git with a fixed committer and author date (a commit that looks old). */
function gitAt(cwd: string, date: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** The ledger with its data readable by key. */
const all = () => entries() as Array<{ kind: string; data: Record<string, unknown> }>;
const kinds = (k: string) => all().filter((e) => e.kind === k);
const remoteRef = (remote: string, ref: string) => {
  try {
    return git(remote, 'rev-parse', '--verify', '-q', ref);
  } catch {
    return '';
  }
};
const pushArgv = () => gitCalls.filter((a) => a.includes('push'));
const noForce = () => {
  for (const a of pushArgv()) {
    for (const w of a) {
      assert.ok(!['-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror'].includes(w), `force flag in ${a.join(' ')}`);
      assert.ok(!/^\+/.test(w), `forced refspec in ${a.join(' ')}`);
    }
  }
};

async function shipPr() {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }));
  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] });
  saveRun(out);
  return { ...ready, out };
}

// ---------------------------------------------------------------- tests

test('PR mode pushes from the ship clone and lays a waiting floor', async () => {
  const { remote, job, run: r, out } = await shipPr();
  const branch = `palimpsest/${job.id}`;

  assert.equal(remoteRef(remote, `refs/heads/${branch}`), r.headSha, 'the inspected sha, by name');
  assert.notEqual(remoteRef(remote, 'refs/heads/main'), r.headSha, 'main is never touched in PR mode');
  const create = ghCalls.find((a) => a[1] === 'create') as string[];
  assert.ok(create.includes(`--head=${branch}`) && create.includes('--base=main') && create.includes('-R') && create.includes(FULL));
  const body = (create.find((a) => a.startsWith('--body=')) ?? '').slice(7);
  assert.match(body, /## Plan/);
  assert.match(body, /\| Check \| State \| Detail \|/);
  assert.match(body, /\| review \| pass \|/);
  assert.match(body, /## Ledger/);
  assert.doesNotMatch(body, /—| -- /);

  assert.equal(out.stage, 'waiting');
  assert.equal(out.prNumber, 12);
  assert.equal(out.prUrl, `https://github.com/${FULL}/pull/12`);
  assert.equal(storedJob(job.id)?.status, 'waiting');
  assert.equal(storedJob(job.id)?.floorId, `${FULL}#job-${job.id}`);
  assert.equal(kinds('pr.opened').length, 1);

  const [floor] = earnedFloors(TOWER);
  assert.equal(floor.id, `${FULL}#job-${job.id}`);
  assert.equal(floor.kind, 'pr');
  assert.deepEqual(floor.refs, ['#12']);
  assert.equal(floor.founding, false);
  assert.equal(floor.claude, true);
  assert.equal(floor.earned?.state, 'waiting');
  const [mine] = earnedFloors(agentTowerId('w1'));
  assert.equal(mine.id, `agent:w1#job-${job.id}`);
  assert.equal(mine.earned?.state, 'waiting');
  assert.ok(events.some((e) => e.type === 'floor.laid'));

  // The engine's own push: hooks and fsmonitor off, an explicit git dir in the ship clone, never forced.
  const [p] = pushArgv();
  assert.ok(p.includes('core.hooksPath=/dev/null') && p.includes('core.fsmonitor=false'));
  assert.ok(p.some((a) => a.startsWith('--git-dir=') && a.endsWith(join('ship', '.git'))));
  assert.ok(p.includes(`${r.headSha}:refs/heads/${branch}`));
  noForce();
  // Belt and braces: the guard would refuse this very push from any agent.
  assert.ok(forbidden(['git', ...p].join(' '), r.dir as string, paths().runs), 'the guard refuses an agent push');
});

test('the ship clone refuses a run dir whose tip moved after commitAll', async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }));
  writeFileSync(join(ready.dir, 'late.txt'), 'late\n');
  git(ready.dir, 'add', '.');
  git(ready.dir, 'commit', '-q', '-m', 'a commit the engine did not make');

  await assert.rejects(shipClone(ready.run), /moved after the engine's commit/);
  await assert.rejects(ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] }), /moved/);
  assert.equal(remoteRef(ready.remote, `refs/heads/palimpsest/${ready.job.id}`), '', 'nothing was pushed');
  assert.equal(ghCalls.length, 0);
});

test('a hook planted in the run dir never runs during shipping', async () => {
  const marker = join(tempDir, 'HOOK-RAN');
  const ready = await readyRun(checks({ test: 'true', build: 'true' }), { pushMode: true });
  const hook = `#!/bin/sh\ntouch '${marker}'\n`;
  for (const dir of [ready.dir, join(paths().runs, ready.run.id, 'ship')]) {
    for (const name of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-commit', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'post-rewrite']) {
      writeFileSync(join(dir, '.git', 'hooks', name), hook);
      chmodSync(join(dir, '.git', 'hooks', name), 0o755);
    }
  }
  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] });
  assert.equal(out.outcome, 'merged', 'push mode ran: checkout, merge, commit and two pushes');
  assert.equal(existsSync(marker), false, 'no hook ran');
});

test('merged PR lights the floor', async () => {
  const { job, run: r } = await shipPr();
  const t0 = Date.now();
  await pollPRs(t0);
  assert.equal(ghCalls.filter((a) => a[1] === 'view').length, 1);
  assert.equal(storedJob(job.id)?.status, 'waiting', 'still open');

  const mergeSha = 'a'.repeat(40);
  prStates.set(12, { state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: { oid: mergeSha }, closedAt: '2026-11-10T12:00:00Z', headRefOid: r.headSha, baseRefName: 'main' });
  await pollPRs(t0 + PR_POLL_MS - 1);
  assert.equal(ghCalls.filter((a) => a[1] === 'view').length, 1, 'each PR is asked about at most every five minutes');
  await pollPRs(t0 + PR_POLL_MS);

  assert.equal(kinds('merge.detected').length, 1);
  assert.equal(kinds('merge.detected')[0].data.mergeSha, mergeSha);
  assert.equal(earnedFloors(TOWER)[0].earned?.state, 'lit');
  assert.equal(earnedFloors(agentTowerId('w1'))[0].earned?.state, 'lit');
  assert.equal(kinds('floor.lit').length, 2);
  assert.equal(storedJob(job.id)?.status, 'merged');
  // The payment (Task 17) is driven by job.changed to merged.
  assert.ok(all().some((e) => e.kind === 'job.changed' && e.data.to === 'merged' && e.data.id === job.id));
  const ended = storedRun(r.id) as Run;
  assert.equal(ended.outcome, 'merged');
  assert.equal(ended.mergeSha, mergeSha);
  const runEnded = kinds('run.ended').at(-1);
  assert.ok(runEnded && 'summary' in runEnded.data, 'the summary is top-level in run.ended');
});

for (const [what, change] of [
  ['a head that moved after the city pushed', { headRefOid: 'b'.repeat(40) }],
  ['another base branch', { baseRefName: 'release' }],
] as const) {
  test(`a PR merged with ${what} is not paid and is flagged for his brief`, async () => {
    const { job, run: r } = await shipPr();
    prStates.set(12, { state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, closedAt: '2026-11-10T12:00:00Z', headRefOid: r.headSha, baseRefName: 'main', ...change });
    await pollPRs(Date.now());

    assert.equal(kinds('merge.detected').length, 0);
    assert.equal(kinds('floor.lit').length, 0);
    assert.deepEqual(earnedFloors(TOWER), [], 'no floor for work the city did not ship');
    assert.deepEqual(earnedFloors(agentTowerId('w1')), []);
    assert.ok(!all().some((e) => e.kind === 'job.changed' && e.data.to === 'merged'), 'no payment');
    assert.equal(storedJob(job.id)?.status, 'closed');
    const ended = storedRun(r.id) as Run;
    assert.ok(ended.mergedWithChanges, 'marked merged with changes');
    assert.equal(ended.outcome, 'closed');
    const note = kinds('run.note').find((e) => e.data.runId === r.id);
    assert.match(String(note?.data.note), /merged with changes/);
    // Not the firm's failure: reputation skips it.
    const { resolvedBids } = await import('../engine/market/reputation.js');
    assert.equal(resolvedBids().filter((b) => b.jobId === job.id && !b.passed).length, 0);
  });
}

test('a PR he finished with his own commits counts as merged, pays and notes his changes', async () => {
  const { job, run: r } = await shipPr();
  const his = 'd'.repeat(40);
  prCommits.set(12, [
    { oid: r.headSha as string, authors: [{ login: 'palimpsest-city' }] },
    { oid: 'e'.repeat(40), authors: [{ login: 'ConnorEvans' }] },
    { oid: his, authors: [{ login: 'connorevans' }] },
  ]);
  prStates.set(12, { state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, closedAt: '2026-11-10T12:00:00Z', headRefOid: his, baseRefName: 'main' });
  await pollPRs(Date.now());

  assert.equal(kinds('merge.detected').length, 1);
  assert.equal(kinds('merge.detected')[0].data.withHisChanges, true);
  assert.equal(storedJob(job.id)?.status, 'merged', 'paid through job.changed to merged');
  assert.ok(all().some((e) => e.kind === 'job.changed' && e.data.to === 'merged' && e.data.id === job.id));
  const ended = storedRun(r.id) as Run;
  assert.equal(ended.outcome, 'merged');
  assert.ok(!ended.mergedWithChanges);
  for (const tower of [TOWER, agentTowerId('w1')]) {
    const f = earnedFloors(tower)[0];
    assert.equal(f.earned?.state, 'lit');
    assert.equal(f.earned?.note, 'merged with his changes');
  }
  const note = kinds('run.note').find((e) => e.data.runId === r.id);
  assert.match(String(note?.data.note), /merged with his changes/);
});

test("a PR with someone else's commits on top is merged with changes and not paid", async () => {
  const { job, run: r } = await shipPr();
  const head = 'd'.repeat(40);
  prCommits.set(12, [
    { oid: r.headSha as string, authors: [{ login: 'palimpsest-city' }] },
    { oid: 'e'.repeat(40), authors: [{ login: 'connorevans' }] },
    { oid: head, authors: [{ login: 'connorevans' }, { login: 'someone-else' }] },
  ]);
  prStates.set(12, { state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, closedAt: '2026-11-10T12:00:00Z', headRefOid: head, baseRefName: 'main' });
  await pollPRs(Date.now());

  assert.equal(kinds('merge.detected').length, 0);
  assert.equal(storedJob(job.id)?.status, 'closed');
  assert.ok(!all().some((e) => e.kind === 'job.changed' && e.data.to === 'merged'), 'no payment');
  assert.ok((storedRun(r.id) as Run).mergedWithChanges);
  assert.deepEqual(earnedFloors(TOWER), []);
});

test('a fast-forward merge is found at the head, not at a later commit on top of it', async () => {
  const { remote, job, run: r } = await shipPr();
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  git(w, 'merge', '-q', '--ff-only', `origin/palimpsest/${job.id}`);
  writeFileSync(join(w, 'later.txt'), 'later\n');
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', 'Later work on top');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  prStates.set(12, { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: null, closedAt: new Date().toISOString(), headRefOid: r.headSha, baseRefName: 'main' });
  await pollPRs(Date.now());
  assert.equal(storedRun(r.id)?.mergeSha, r.headSha);
});

test('closed PR removes the floor with no scar', async () => {
  const { job, run: r } = await shipPr();
  prStates.set(12, { state: 'CLOSED', mergedAt: null, mergeCommit: null, closedAt: '2026-11-10T12:00:00Z' });
  await pollPRs(Date.now());

  assert.deepEqual(earnedFloors(TOWER), []);
  assert.deepEqual(earnedFloors(agentTowerId('w1')), []);
  assert.equal(kinds('floor.removed').length, 2);
  assert.equal(kinds('floor.scarred').length, 0);
  assert.equal(storedJob(job.id)?.status, 'closed');
  assert.ok(!all().some((e) => e.kind === 'job.changed' && e.data.to === 'merged'), 'no payment');
  assert.equal(storedRun(r.id)?.outcome, 'closed');
  assert.equal(storedRun(r.id)?.scar, false);
});

test('push mode merges, reruns checks in the ship clone and pushes main', async () => {
  const c = checks({ install: 'echo install >> "$TMPDIR/rechecks.log"', test: 'echo test "$(pwd)" >> "$TMPDIR/rechecks.log"', build: 'echo build >> "$TMPDIR/rechecks.log"', ecosystems: ['npm'] });
  const ready = await readyRun(c, { pushMode: true });
  const oldMain = remoteRef(ready.remote, 'refs/heads/main');
  const stages: Array<[string, string[]]> = [];
  const egress = { setStage: (s: 'install' | 'working' | 'checks', hosts: string[]) => void stages.push([s, hosts]) };

  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [], egress });

  assert.equal(out.outcome, 'merged');
  assert.equal(out.stage, 'done');
  assert.ok(out.mergeSha && /^[0-9a-f]{40}$/.test(out.mergeSha));
  assert.equal(remoteRef(ready.remote, 'refs/heads/main'), out.mergeSha, 'main moved to the recorded merge sha');
  const parents = git(ready.remote, 'rev-list', '--parents', '-n', '1', out.mergeSha as string).split(' ');
  assert.deepEqual(parents.slice(1), [oldMain, ready.run.headSha]);
  assert.match(git(ready.remote, 'log', '-1', '--format=%B', out.mergeSha as string), new RegExp(`^Palimpsest-Job: ${ready.job.id}$`, 'm'));
  noForce();
  assert.ok(pushArgv().some((a) => a.includes(`${out.mergeSha}:refs/heads/main`)));

  const log = readFileSync(join(paths().runs, ready.run.id, 'tmp', 'rechecks.log'), 'utf8').trim().split('\n');
  assert.equal(log[0], 'install');
  assert.match(log[1], /^test .*\/ship$/, 'the test ran in the ship clone');
  assert.equal(log[2], 'build');
  assert.deepEqual(stages.map(([s]) => s), ['install', 'checks']);
  assert.deepEqual(stages[1][1], [], 'nothing reachable after the install');

  assert.equal(kinds('pushed').length, 1);
  assert.equal(kinds('pushed')[0].data.mergeSha, out.mergeSha);
  assert.equal(storedJob(ready.job.id)?.status, 'merged');
  const [floor] = earnedFloors(TOWER);
  assert.equal(floor.kind, 'commits');
  assert.deepEqual(floor.refs, [(out.mergeSha as string).slice(0, 7)]);
  assert.equal(floor.earned?.state, 'lit');
  assert.equal(earnedFloors(agentTowerId('w1'))[0].earned?.state, 'lit');
  assert.equal(ghCalls.filter((a) => a[1] === 'create').length, 0, 'no PR in push mode');
  assert.equal(remoteRef(ready.remote, `refs/heads/palimpsest/${ready.job.id}`), '', "the city's branch is deleted once main has it");
});

test('a check that rewrites HEAD in the ship clone stops the push', async () => {
  const ready = await readyRun(checks({ test: 'git update-ref HEAD HEAD^1', build: 'true' }), { pushMode: true });
  const oldMain = remoteRef(ready.remote, 'refs/heads/main');
  await assert.rejects(ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] }), /HEAD in the ship clone moved/);
  assert.equal(remoteRef(ready.remote, 'refs/heads/main'), oldMain, 'main never moved');
  assert.equal(kinds('pushed').length, 0);
  assert.notEqual(storedJob(ready.job.id)?.status, 'merged');
  assert.equal(remoteRef(ready.remote, `refs/heads/palimpsest/${ready.job.id}`), '', "the city's branch is deleted");
});

test('push mode refuses when inspection is not pushable', async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }), { pushMode: true });
  const oldMain = remoteRef(ready.remote, 'refs/heads/main');
  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run, { pushable: false }), ctl(), { reap: async () => [] });
  assert.equal(out.stage, 'waiting');
  assert.equal(out.outcome, null);
  assert.equal(remoteRef(ready.remote, 'refs/heads/main'), oldMain);
  assert.equal(ghCalls.filter((a) => a[1] === 'create').length, 1, 'a PR instead');
  assert.equal(kinds('pushed').length, 0);
});

test('push mode refuses while the repo has no build command (ruling 23)', async () => {
  const ready = await readyRun(checks({ test: 'true', build: null }), { pushMode: true });
  const oldMain = remoteRef(ready.remote, 'refs/heads/main');
  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] });
  assert.equal(out.stage, 'waiting');
  assert.equal(remoteRef(ready.remote, 'refs/heads/main'), oldMain);
  const body = (ghCalls.find((a) => a[1] === 'create') as string[]).find((a) => a.startsWith('--body=')) as string;
  assert.match(body, /push mode waits for a test and a build command/);
});

test('a rejected push retries once then reopens without a scar', async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }), { pushMode: true });
  let mainPushes = 0;
  beforeGit = (args) => {
    if (args.includes('push') && args.some((a) => a.endsWith(':refs/heads/main'))) {
      mainPushes++;
      pushElsewhere(ready.remote, `race${mainPushes}`);
    }
  };
  const attemptsBefore = storedJob(ready.job.id)?.attempts;
  const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] });

  assert.equal(mainPushes, 2, 'one try and one retry after a fetch');
  assert.equal(out.outcome, 'crashed');
  assert.match(out.endedReason ?? '', /rejected twice/);
  const j = storedJob(ready.job.id) as Job;
  assert.equal(j.status, 'open');
  assert.equal(j.attempts, attemptsBefore, 'no attempt spent');
  assert.equal(kinds('floor.scarred').length, 0);
  assert.deepEqual(earnedFloors(TOWER), []);
  assert.equal(kinds('pushed').length, 0);
  assert.equal(remoteRef(ready.remote, `refs/heads/palimpsest/${ready.job.id}`), '', "the city's own branch is removed for the next attempt");
  noForce();
});

test('a revert halts the repo and marks the floor', async () => {
  const { remote, job, run: r } = await shipPr();
  // He merges the PR on GitHub (a merge commit), then reverts it.
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  git(w, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #12', `origin/palimpsest/${job.id}`);
  const mergeSha = git(w, 'rev-parse', 'HEAD');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  // gh reports no merge commit: the city finds it in the default branch by its parents.
  prStates.set(12, { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: null, closedAt: new Date().toISOString(), headRefOid: r.headSha, baseRefName: 'main' });
  const t0 = Date.now();
  await pollPRs(t0);
  assert.equal(storedRun(r.id)?.mergeSha, mergeSha);

  await watchReverts(t0);
  assert.equal(kinds('merge.reverted').length, 0, 'nothing reverted yet');
  // A revert whose committer date is far older than the merge is still found: the watch reads by ancestry, not by date.
  gitAt(w, '2020-01-01T00:00:00Z', 'revert', '--no-edit', '-m', '1', mergeSha);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  await watchReverts(t0 + REVERT_WATCH_MS - 1);
  assert.equal(kinds('merge.reverted').length, 0, 'each repo is read at most every thirty minutes');
  await watchReverts(t0 + REVERT_WATCH_MS);

  assert.equal(kinds('merge.reverted').length, 1);
  assert.equal(kinds('merge.reverted')[0].data.jobId, job.id);
  assert.equal(earnedFloors(TOWER)[0].earned?.reverted, true);
  assert.equal(earnedFloors(agentTowerId('w1'))[0].earned?.reverted, true);
  assert.ok(getRepo(FULL)?.halted, 'the market on the repo is halted');
  assert.ok(events.some((e) => e.type === 'repo.halted'));
  assert.ok(events.some((e) => e.type === 'merge.reverted'));
});

test("a squash merge and GitHub's squash revert are found by the PR title", async () => {
  const { remote, job, run: r } = await shipPr();
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  // GitHub's squash: one commit titled "<PR title> (#n)" whose body keeps the squashed messages (and the trailer).
  git(w, 'merge', '-q', '--squash', `origin/palimpsest/${job.id}`);
  git(w, 'commit', '-q', '-m', `${job.title} (#12)\n\n* ${job.title}\n\nPalimpsest-Job: ${job.id}`);
  const squash = git(w, 'rev-parse', 'HEAD');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  prStates.set(12, { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: null, closedAt: new Date().toISOString(), headRefOid: r.headSha, baseRefName: 'main' });
  await pollPRs(Date.now());
  assert.equal(storedRun(r.id)?.mergeSha, squash, 'the squash commit carrying the trailer');

  // An unrelated commit later does not count; GitHub's revert of the squash does, even with an old date.
  writeFileSync(join(w, 'other.txt'), 'other\n');
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', 'Unrelated work');
  writeFileSync(join(w, 'undo.txt'), 'undo\n');
  git(w, 'add', '.');
  gitAt(w, '2020-01-01T00:00:00Z', 'commit', '-q', '-m', `Revert "${job.title} (#12)"\n\nThis reverts the squash by hand.`);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  await watchReverts(Date.now());
  assert.equal(kinds('merge.reverted').length, 1);
  assert.equal(kinds('merge.reverted')[0].data.mergeSha, squash);
  assert.ok(getRepo(FULL)?.halted);
});

test('a revert of an older commit with the same title before the merge does not count', async () => {
  const { remote, job, run: r } = await shipPr();
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  writeFileSync(join(w, 'early.txt'), 'early\n');
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', `Revert "${job.title}"`);
  git(w, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #12', `origin/palimpsest/${job.id}`);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  prStates.set(12, { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: null, closedAt: new Date().toISOString(), headRefOid: r.headSha, baseRefName: 'main' });
  await pollPRs(Date.now());
  await watchReverts(Date.now());
  assert.equal(kinds('merge.reverted').length, 0, 'only commits after the merge are read');
  assert.equal(getRepo(FULL)?.halted, null);
});

test('failed inspection lays a scar on the repo tower only', async () => {
  const { repo } = makeRemoteRepo(checks());
  const worker = addAgent('w1', 'quickset', 'claude:sonnet');
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, fakeProvider({}));
  const posted = postJob(['**']);
  const open = openBidding(posted, Date.now());
  const bid: Bid = { id: 'bid-1', jobId: posted.id, firmId: worker.firmId, agentId: worker.id, plan: '1. Write it.', price: 20, confidence: 0.8, calibrated: 0.68, appraisal: null, ev: 20, cost: 3, at: new Date().toISOString() };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, bid.jobId, JSON.stringify({ round: open.bidsCloseAt, bid }));
  record('job.awarded', { jobId: posted.id, tier: posted.tier, considered: [bid], satOut: [], chosen: bid, why: 'test', at: new Date().toISOString(), coolOffUntil: null });
  transition(open, 'awarded', { awardedBid: bid.id });
  let shipped = 0;
  createScheduler({
    installDeps: async () => ({ name: 'install', status: 'skipped', detail: '', durationMs: 0, logPath: null, testsRun: null }),
    inspect: async (r) => ({ ...inspectionOf(r), checks: [{ ...pass('test'), status: 'fail' }], passed: false, pushable: false }),
    ship: async (r) => {
      shipped++;
      return r;
    },
    pollJobs: async () => [],
    quiet: async () => {},
    reap: async () => [],
    preflight: async () => null,
    watchMs: 0,
  });
  const r = await startRun(bid);

  assert.equal(r.outcome, 'failed');
  assert.equal(shipped, 0);
  const floors = earnedFloors(TOWER);
  assert.equal(floors.length, 1);
  assert.equal(floors[0].title, `Failed inspection: ${posted.title}`);
  assert.equal(floors[0].earned?.state, 'scar');
  assert.equal(floors[0].earned?.jobId, posted.id);
  assert.deepEqual(earnedFloors(agentTowerId('w1')), [], 'never on the agent tower');
  assert.equal(kinds('floor.scarred').length, 1);
  assert.ok(events.some((e) => e.type === 'floor.scarred'));
  assert.equal(repo.fullName, FULL);
});

test('GitHub writes refuse outside the real home, bad names and any push target but a local stand-in', async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }));
  // The real runner on a temp home: refused before gh runs (the Task 5 guard).
  setRunner(realRunner);
  await assert.rejects(createPR(FULL, { head: `palimpsest/${ready.job.id}`, base: 'main', title: 't', body: 'b' }), /not the real data home/);
  setRunner(fakeGh);
  await assert.rejects(createPR('-R/x', { head: 'palimpsest/job-1', base: 'main', title: 't', body: 'b' }), /Bad repo name/);
  await assert.rejects(createPR(FULL, { head: 'main', base: 'main', title: 't', body: 'b' }), /Bad branch name/);
  await assert.rejects(createPR(FULL, { head: 'palimpsest/job-1', base: '--force', title: 't', body: 'b' }), /Bad branch name/);
  await assert.rejects(prState(FULL, 0), /Bad issue number/);
  assert.equal(ghCalls.length, 0);

  // A mirror whose origin is GitHub itself is never pushed to from a temp home.
  git(mirrorDir(FULL), 'remote', 'set-url', 'origin', `https://github.com/${FULL}.git`);
  await assert.rejects(pushTarget(ready.repo), /only to a local stand-in/);
  await assert.rejects(ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] }), /local stand-in/);
  assert.equal(pushArgv().length, 0, 'no push ran');
});

test('nothing ships without a passed inspection of this run, or on a halted repo', async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }));
  const failed = { ...inspectionOf(ready.run), passed: false };
  await assert.rejects(ship(ready.run, ready.job, ready.repo, failed, ctl(), { reap: async () => [] }), /passed inspection/);
  const other = { ...inspectionOf(ready.run), runId: 'run-other' };
  await assert.rejects(ship(ready.run, ready.job, ready.repo, other, ctl(), { reap: async () => [] }), /not of this run/);
  const stopped = new AbortController();
  stopped.abort(new Error('The stop file is set.'));
  await assert.rejects(ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), stopped.signal, { reap: async () => [] }), /stop file/);
  openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...ready.repo, halted: { at: new Date().toISOString(), reason: 'test' } }), FULL);
  await assert.rejects(ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] }), /halted/);
  assert.equal(pushArgv().length, 0);
  assert.equal(ghCalls.length, 0);
});

test("the push ignores the engine's git environment: a planted global config, GIT_CONFIG_PARAMETERS and GIT_SSH_COMMAND", async () => {
  const ready = await readyRun(checks({ test: 'true', build: 'true' }));
  const decoy = join(tempDir, 'decoy.git');
  git(tempDir, 'init', '-q', '--bare', decoy);
  const marker = join(tempDir, 'SSH-RAN');
  const planted = join(tempDir, 'planted.gitconfig');
  writeFileSync(planted, `[url "${decoy}"]\n\tinsteadOf = ${ready.remote}\n[core]\n\tsshCommand = touch '${marker}'\n\thooksPath = ${tempDir}\n`);
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_DIR'] as const;
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GIT_CONFIG_GLOBAL = planted;
  process.env.GIT_CONFIG_PARAMETERS = `'url.${decoy}.insteadof'='${ready.remote}'`;
  process.env.GIT_SSH_COMMAND = `touch '${marker}'`;
  process.env.GIT_DIR = decoy;
  let pushEnv: Record<string, string> | undefined;
  beforeGit = null;
  const inner = fakeGh;
  setRunner(async (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('push')) pushEnv = (opts as { env?: Record<string, string> } | undefined)?.env;
    return inner(cmd, args, opts);
  });
  try {
    const out = await ship(ready.run, ready.job, ready.repo, inspectionOf(ready.run), ctl(), { reap: async () => [] });
    assert.equal(out.stage, 'waiting');
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
  assert.equal(remoteRef(ready.remote, `refs/heads/palimpsest/${ready.job.id}`), ready.run.headSha, 'the real stand-in got the push');
  assert.equal(remoteRef(decoy, `refs/heads/palimpsest/${ready.job.id}`), '', 'the decoy got nothing');
  assert.equal(existsSync(marker), false);
  assert.ok(pushEnv, 'the push ran with an explicit environment');
  assert.equal(pushEnv?.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(pushEnv?.GIT_CONFIG_NOSYSTEM, '1');
  assert.deepEqual(Object.keys(pushEnv ?? {}).filter((k) => k.startsWith('GIT_')).sort(), ['GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
  const [p] = pushArgv();
  const i = p.indexOf('credential.helper=');
  assert.ok(i > 0 && p[i + 2] === 'credential.helper=!gh auth git-credential', 'only gh answers for credentials');
});

test('the file protocol is allowed only for a local stand-in, and the real home pushes only to the https URL', () => {
  assert.ok(pushFlags('/tmp/x/remote.git').includes('protocol.file.allow=always'));
  assert.ok(!pushFlags(`https://github.com/${FULL}.git`).includes('protocol.file.allow=always'));
  assert.ok(pushFlags(`https://github.com/${FULL}.git`).includes('core.hooksPath=/dev/null'));
});
