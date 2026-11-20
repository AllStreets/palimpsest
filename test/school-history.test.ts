/**
 * Verified history (Phase 4 Task 18, ruling 23). GitHub is a temp bare repo
 * the mirror is cloned from and a fake runner answering `gh pr list`; the
 * Mac's gate probes are canned; the test check is a fake that names the
 * shas it was asked about. Temp home only; nothing reaches a real repo.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, realSpawner, setRunner, setSpawner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { record } from '../engine/ledger.js';
import { mirrorDir } from '../engine/mirror.js';
import { getRepo } from '../engine/repos.js';
import { resetGateCache } from '../engine/school/gate.js';
import { CHECK_BUDGET_MS, setTestCheck, verifiedChanges, verifiedCounts, type VerifiedChange } from '../engine/school/history.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Inspection, Repo } from '../shared/types.js';
import { checks, FULL, setUp, tearDown, tempDir } from './guild-fixtures.js';
import { storeJobRow, storeRunRow } from './school-fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
/** 03:00 local on 12 November 2026: inside the default training window. */
const NOW = new Date(2026, 10, 12, 3, 0).getTime();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const FIX = join(import.meta.dirname, 'fixtures', 'pmset');
const fx = (name: string): string => readFileSync(join(FIX, `${name}.txt`), 'utf8');

let battery = false;
let prs: object[] = [];
let checked: string[] = [];
let failing = new Set<string>();

const fake: Runner = async (cmd, args, opts) => {
  const base = cmd.split('/').pop() ?? cmd;
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  if (base === 'gh') {
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(prs));
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  if (base === 'pmset' && args.join(' ') === '-g batt') return ok(fx(battery ? 'batt-battery' : 'batt-ac'));
  if (base === 'pmset' && args.join(' ') === '-g therm') return ok(fx('therm-none'));
  if (base === 'pmset' && args.join(' ') === '-g') return ok(fx('g-automatic'));
  if (base === 'ioreg') return ok(`+-o IOHIDSystem\n    | {\n    |   "HIDIdleTime" = ${3600n * 1_000_000_000n}\n    | }\n`);
  if (base === 'df') return ok(`Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971298980 636638860 ${Math.round(300e9 / 1024)} 68% 1 1 0% /System/Volumes/Data\n`);
  if (base === 'git') return realRunner(cmd, args, opts);
  return { stdout: '', stderr: `unexpected ${base}`, code: 1 };
};

function gitAt(cwd: string, date: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

interface World {
  repo: Repo;
  work: string;
  remote: string;
  first: string;
  c40: string;
  c20: string;
  reverted: string;
  revert: string;
  fixed: string;
  fix: string;
  failed: string;
  prMerge: string;
  prSide: string;
  cityPass: string;
  cityFail: string;
}

/** A commit at `days` ago writing `files`, with `message`. */
function commit(work: string, days: number, files: Record<string, string>, message: string): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  gitAt(work, ago(days), 'add', '.');
  gitAt(work, ago(days), 'commit', '-q', '-m', message);
  return gitAt(work, ago(days), 'rev-parse', 'HEAD');
}

/** A branch off main with one commit, merged with --no-ff at `days` ago. */
function merge(work: string, days: number, branch: string, files: Record<string, string>, message: string, subject: string): { merge: string; side: string } {
  gitAt(work, ago(days + 1), 'checkout', '-q', '-b', branch);
  const side = commit(work, days + 1, files, message);
  gitAt(work, ago(days), 'checkout', '-q', 'main');
  gitAt(work, ago(days), 'merge', '-q', '--no-ff', '-m', subject, branch);
  return { merge: gitAt(work, ago(days), 'rev-parse', 'HEAD'), side };
}

function inspection(runId: string, jobId: string, passed: boolean): void {
  const i: Inspection = { id: `insp-${runId}`, runId, jobId, repo: FULL, reviewerAgentId: null, reviewerFirmId: null, checks: [], passed, pushable: passed, design: null, cost: 0, at: ago(46) };
  record('inspection.done', { inspection: i });
}

function cityRun(id: string, jobId: string, mergeSha: string, passed: boolean, days: number): void {
  storeJobRow(jobId, { status: 'merged', repo: FULL });
  storeRunRow(id, jobId, FULL, { stage: 'done', outcome: 'merged', mergeSha, endedAt: ago(days), prNumber: null });
  inspection(id, jobId, passed);
  record('merge.detected', { jobId, runId: id, repo: FULL, pr: null, mergeSha, mergedAt: ago(days), at: ago(days) });
}

function world(test: string | null = 'node --test'): World {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-01-01T00:00:00.000Z',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
    checks: checks({ test }),
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'his-work');
  mkdirSync(work, { recursive: true });
  gitAt(work, ago(100), 'init', '-q', '-b', 'main');
  const first = commit(work, 100, { 'README.md': 'widgets\n' }, 'first');
  const failed = commit(work, 70, { 'src/e.ts': 'export const e = 1;\n' }, 'Add the errors');
  const fixed = commit(work, 60, { 'src/d.ts': 'export const d = 1;\n' }, 'Add the dates');
  const fix = commit(work, 55, { 'src/d.ts': 'export const d = 2;\n' }, 'Fix the dates');
  const reverted = commit(work, 50, { 'src/c.ts': 'export const c = 1;\n' }, 'Add the cache');
  gitAt(work, ago(47), 'revert', '--no-edit', reverted);
  const revert = gitAt(work, ago(47), 'rev-parse', 'HEAD');
  const cityPass = merge(work, 45, 'palimpsest/job-c1', { 'src/g.ts': 'export const g = 1;\n' }, 'Add g\n\nPalimpsest-Job: job-c1', 'Merge pull request #7 from acme/palimpsest/job-c1').merge;
  const cityFail = merge(work, 44, 'palimpsest/job-c2', { 'src/h.ts': 'export const h = 1;\n' }, 'Add h\n\nPalimpsest-Job: job-c2', 'Merge pull request #8 from acme/palimpsest/job-c2').merge;
  const c40 = commit(work, 40, { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': "import { test } from 'node:test';\ntest('a', () => {});\n" }, 'Add the parser');
  const pr = merge(work, 35, 'feature', { 'src/f.ts': 'export const f = 1;\n' }, 'Add f', 'Merge pull request #5 from acme/feature');
  const c20 = commit(work, 20, { 'src/b.ts': 'export const b = 1;\n' }, 'Add the bins');
  const remote = join(tempDir, 'github', 'acme__widgets.git');
  mkdirSync(dirname(remote), { recursive: true });
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', work, remote);
  mkdirSync(paths().mirrors, { recursive: true });
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', remote, mirrorDir(FULL));

  cityRun('run-c1', 'job-c1', cityPass, true, 45);
  cityRun('run-c2', 'job-c2', cityFail, false, 44);
  prs = [
    { number: 5, title: 'Add f', mergedAt: ago(35), mergeCommit: { oid: pr.merge }, url: `https://github.com/${FULL}/pull/5`, headRefName: 'feature' },
    { number: 7, title: 'Add g', mergedAt: ago(45), mergeCommit: { oid: cityPass }, url: `https://github.com/${FULL}/pull/7`, headRefName: 'palimpsest/job-c1' },
    { number: 8, title: 'Add h', mergedAt: ago(44), mergeCommit: { oid: cityFail }, url: `https://github.com/${FULL}/pull/8`, headRefName: 'palimpsest/job-c2' },
  ];
  failing = new Set([failed]);
  return { repo: getRepo(FULL)!, work, remote, first, c40, c20, reverted, revert, fixed, fix, failed, prMerge: pr.merge, prSide: pr.side, cityPass, cityFail };
}

const byKind = (list: VerifiedChange[], kind: VerifiedChange['kind']) => list.filter((c) => c.kind === kind).map((c) => c.sha);

beforeEach(() => {
  setUp('school-history');
  battery = false;
  prs = [];
  checked = [];
  failing = new Set();
  resetGateCache();
  setRunner(fake);
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  setTestCheck(async (_repo, sha) => {
    checked.push(sha);
    return { passed: !failing.has(sha), detail: failing.has(sha) ? 'node --test exited 1' : 'passed' };
  });
});

afterEach(async () => {
  setTestCheck(null);
  setRunner(realRunner);
  resetGateCache();
  await tearDown();
});

test('a 40-day-old commit touching source with passing tests is verified', async () => {
  const w = world();
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  const c = list.find((x) => x.sha === w.c40);
  assert.ok(c, 'the 40-day-old commit is verified');
  assert.equal(c.kind, 'commit');
  assert.equal(c.ref, `commit:${w.c40}`);
  assert.equal(c.parent, w.cityFail, 'its parent is the commit before it on main');
  assert.deepEqual(c.files, ['src/a.ts', 'test/a.test.ts']);
  assert.equal(c.touchesTests, true);
  assert.equal(Date.parse(c.at), NOW - 40 * DAY);
  assert.ok(checked.includes(w.c40), 'its tests were checked');
  // the README-only first commit touches no source
  assert.ok(!list.some((x) => x.sha === w.first));
});

test('a 20-day-old commit is not', async () => {
  const w = world();
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  assert.ok(!list.some((x) => x.sha === w.c20));
  assert.ok(!checked.includes(w.c20), 'a commit too young is never checked');
});

test('a reverted commit and one followed by a fix are not', async () => {
  const w = world();
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  const shas = list.map((x) => x.sha);
  assert.ok(!shas.includes(w.reverted), 'the reverted commit is out');
  assert.ok(!shas.includes(w.revert), 'the revert itself is not his work to learn from');
  assert.ok(!shas.includes(w.fixed), 'the commit a fix followed is out');
  assert.ok(shas.includes(w.fix), 'the fix itself, never followed, counts');
});

test('a commit whose tests fail at it is not', async () => {
  const w = world();
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  assert.ok(checked.includes(w.failed));
  assert.ok(!list.some((x) => x.sha === w.failed));
  // the result is cached by sha: a second read checks nothing again and still leaves it out
  checked = [];
  const again = await verifiedChanges(w.repo, NOW, { check: true });
  assert.deepEqual(checked, []);
  assert.ok(!again.some((x) => x.sha === w.failed));
  assert.ok(again.some((x) => x.sha === w.c40));
  const row = openDb().prepare('SELECT json FROM verified WHERE repo = ? AND sha = ?').get(FULL, w.failed) as { json: string };
  assert.equal(JSON.parse(row.json).check.passed, false);
});

test('the test check runs only under the heavy gate, and an unchecked commit is not verified', async () => {
  const w = world();
  battery = true;
  const closed = await verifiedChanges(w.repo, NOW, { check: true });
  assert.deepEqual(checked, [], 'on battery nothing is checked');
  assert.ok(!closed.some((x) => x.sha === w.c40), 'unchecked is not verified');
  const without = await verifiedChanges(w.repo, NOW, {});
  assert.deepEqual(checked, []);
  assert.deepEqual(byKind(without, 'commit'), []);
  // city merges and PRs never wait on the check
  assert.deepEqual(byKind(without, 'city'), [w.cityPass]);
  assert.deepEqual(byKind(without, 'pr'), [w.prMerge]);
});

test('a pass that starts inside the window stops starting checks once its clock crosses the window end', async () => {
  const w = world();
  const start = new Date(2026, 10, 12, 5, 30).getTime();
  let calls = 0;
  // the first check is gated at 05:50, inside the window; the next at 06:10, after it closed
  const clock = () => start + 20 * 60 * 1000 * ++calls;
  const list = await verifiedChanges(w.repo, start, { check: true, clock });
  assert.equal(checked.length, 1, 'only the check begun inside the window ran');
  assert.ok(calls >= 2, 'every check re-read the clock');
  assert.ok(list.every((x) => x.sha !== w.failed || x.kind !== 'commit'), 'an unchecked commit is not verified');
});

test('no new test check starts once the call has run past CHECK_BUDGET_MS', async () => {
  const w = world();
  let calls = 0;
  // the first read is at the call's start; every later one is past the budget
  const clock = () => NOW + (calls++ === 0 ? 0 : CHECK_BUDGET_MS + 1);
  await verifiedChanges(w.repo, NOW, { check: true, clock });
  assert.equal(checked.length, 1, 'only the check begun inside the budget ran');
});

test('checks run normally under CHECK_BUDGET_MS', async () => {
  const w = world();
  let calls = 0;
  const clock = () => NOW + 1000 * ++calls;
  await verifiedChanges(w.repo, NOW, { check: true, clock });
  assert.ok(checked.length > 1, 'several checks ran');
  assert.ok(checked.includes(w.c40));
  assert.ok(checked.includes(w.failed));
});

test('with no test check declared, a surviving commit is verified without one', async () => {
  const w = world(null);
  const list = await verifiedChanges(w.repo, NOW, {});
  assert.deepEqual(checked, []);
  assert.ok(list.some((x) => x.sha === w.c40));
  assert.ok(list.some((x) => x.sha === w.failed), 'nothing says its tests fail');
});

test('a city commit is counted as city only when it passed inspection', async () => {
  const w = world();
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  assert.deepEqual(byKind(list, 'city'), [w.cityPass]);
  const city = list.find((x) => x.kind === 'city')!;
  assert.equal(city.ref, 'city:job-c1');
  assert.deepEqual(city.files, ['src/g.ts']);
  assert.equal(city.touchesTests, false);
  assert.ok(!list.some((x) => x.sha === w.cityFail), 'the merge that failed inspection is neither city, PR nor commit');
  // the city's PRs are never his PRs, and its branch commits are never his commits
  assert.deepEqual(byKind(list, 'pr'), [w.prMerge]);
  const pr = list.find((x) => x.kind === 'pr')!;
  assert.equal(pr.ref, 'pr:5');
  assert.deepEqual(pr.files, ['src/f.ts']);
  assert.ok(!list.some((x) => x.sha === w.prSide), 'a PR branch commit is not a direct commit');
});

test('a city merge reverted or followed by a fix, or under 30 days old, is not city', async () => {
  const w = world();
  record('merge.reverted', { jobId: 'job-c1', runId: 'run-c1', repo: FULL, floorId: 'f', mergeSha: w.cityPass, revertSha: 'e'.repeat(40), at: ago(10) });
  assert.deepEqual(byKind(await verifiedChanges(w.repo, NOW, {}), 'city'), []);
  const young = world2();
  assert.deepEqual(byKind(await verifiedChanges(young.repo, NOW, {}), 'city'), []);
});

/** A second repo whose city merge (passed inspection) is ten days old. */
function world2(): { repo: Repo } {
  const full = 'acme/gadgets';
  const repo: Repo = { ...getRepo(FULL)!, fullName: full, slot: 1 };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(full, JSON.stringify(repo));
  const work = join(tempDir, 'gadgets-work');
  mkdirSync(work, { recursive: true });
  gitAt(work, ago(100), 'init', '-q', '-b', 'main');
  commit(work, 100, { 'README.md': 'gadgets\n' }, 'first');
  const m = merge(work, 10, 'palimpsest/job-g1', { 'src/g.ts': 'export const g = 1;\n' }, 'Add g\n\nPalimpsest-Job: job-g1', 'Merge pull request #2 from acme/palimpsest/job-g1').merge;
  const remote = join(tempDir, 'github', 'acme__gadgets.git');
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', work, remote);
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', remote, mirrorDir(full));
  storeJobRow('job-g1', { status: 'merged', repo: full });
  storeRunRow('run-g1', 'job-g1', full, { stage: 'done', outcome: 'merged', mergeSha: m, endedAt: ago(10), prNumber: null });
  const i: Inspection = { id: 'insp-g1', runId: 'run-g1', jobId: 'job-g1', repo: full, reviewerAgentId: null, reviewerFirmId: null, checks: [], passed: true, pushable: true, design: null, cost: 0, at: ago(11) };
  record('inspection.done', { inspection: i });
  record('merge.detected', { jobId: 'job-g1', runId: 'run-g1', repo: full, pr: null, mergeSha: m, mergedAt: ago(10), at: ago(10) });
  prs = [];
  return { repo: getRepo(full)! };
}

test('with commitsAsWork off only city merges and PRs count', async () => {
  const w = world();
  patchSettings({ school: { ...getSettings().school, commitsAsWork: false } });
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  assert.deepEqual(checked, [], 'no commit is checked when commits do not count');
  assert.deepEqual(byKind(list, 'commit'), []);
  assert.deepEqual(byKind(list, 'city'), [w.cityPass]);
  assert.deepEqual(byKind(list, 'pr'), [w.prMerge]);
  assert.deepEqual(verifiedCounts()[FULL], { city: 1, pr: 1, commit: 0 });
});

test('verifiedCounts reports each kind', async () => {
  const w = world();
  assert.deepEqual(verifiedCounts(), { [FULL]: { city: 0, pr: 0, commit: 0 } }, 'nothing read yet');
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  // the 40-day-old commit and the fix that was never followed
  assert.deepEqual(byKind(list, 'commit').sort(), [w.c40, w.fix].sort());
  assert.deepEqual(verifiedCounts(), { [FULL]: { city: 1, pr: 1, commit: 2 } });
  // turning commitsAsWork off drops the commits from the count at once
  patchSettings({ school: { ...getSettings().school, commitsAsWork: false } });
  assert.deepEqual(verifiedCounts(), { [FULL]: { city: 1, pr: 1, commit: 0 } });
});

test('every git call is argv with hooks and fsmonitor off, and no sha reaches a shell', async () => {
  const w = world();
  const calls: Array<[string, string[]]> = [];
  setRunner(async (cmd, args, opts) => {
    calls.push([cmd, args]);
    return fake(cmd, args, opts);
  });
  await verifiedChanges(w.repo, NOW, { check: true });
  const gits = calls.filter(([c, a]) => c === 'git' && !a.includes('fetch'));
  assert.ok(gits.length > 0);
  for (const [, a] of gits) assert.ok(a.includes('core.hooksPath=/dev/null') && a.includes('core.fsmonitor=false'), a.join(' '));
  assert.ok(!calls.some(([c]) => /(^|\/)(sh|bash|zsh)$/.test(c)), 'no shell');
});

test('a run whose merge sha is not 40 hex is never read', async () => {
  const w = world();
  storeJobRow('job-bad', { status: 'merged', repo: FULL });
  storeRunRow('run-bad', 'job-bad', FULL, { stage: 'done', outcome: 'merged', mergeSha: 'HEAD; rm -rf /', endedAt: ago(60), prNumber: null });
  inspection('run-bad', 'job-bad', true);
  const calls: string[][] = [];
  setRunner(async (cmd, args, opts) => {
    if (cmd === 'git') calls.push(args);
    return fake(cmd, args, opts);
  });
  const list = await verifiedChanges(w.repo, NOW, {});
  assert.ok(!list.some((x) => x.ref === 'city:job-bad'));
  assert.ok(!calls.some((a) => a.some((x) => x.includes('rm -rf'))));
});

test('the real check runs the declared test in a fresh clone at the sha through the tool runner, and caches it', async () => {
  const w = world();
  setTestCheck(null);
  // The suite never runs: a fake spawner stands in for it, failing where the clone holds src/e.ts at its own commit only.
  const seen: Array<{ cmd: string; args: string[]; cwd: string | undefined }> = [];
  setSpawner((cmd, args, opts) => {
    seen.push({ cmd, args, cwd: opts.cwd });
    const fails = opts.cwd !== undefined && existsSync(join(opts.cwd, 'src', 'e.ts')) && !existsSync(join(opts.cwd, 'src', 'd.ts'));
    return realSpawner('/bin/sh', ['-c', fails ? 'exit 1' : 'exit 0'], { ...opts, env: { PATH: '/usr/bin:/bin' }, clearEnv: true });
  });
  const list = await verifiedChanges(w.repo, NOW, { check: true });
  const tests = seen.filter((x) => x.args.at(-1) === 'node --test');
  assert.ok(tests.length >= 3, `the declared test ran per commit: ${tests.length}`);
  for (const t of tests) assert.match(t.cwd ?? '', /\/runs\/verify-acme__widgets-[0-9a-f]{12}\/repo$/);
  assert.ok(list.some((x) => x.sha === w.c40));
  assert.ok(!list.some((x) => x.sha === w.failed));
  const row = openDb().prepare('SELECT json FROM verified WHERE repo = ? AND sha = ?').get(FULL, w.failed) as { json: string };
  assert.equal(JSON.parse(row.json).check.passed, false);
  assert.equal(JSON.parse(row.json).check.command, 'node --test');
  assert.ok(!existsSync(join(paths().runs, `verify-acme__widgets-${w.c40.slice(0, 12)}`, 'repo')), 'the clone is removed after');
});
