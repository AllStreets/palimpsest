/**
 * Acting under a grant (Phase 4 Task 17, rulings 18 and 19). Temp home, a
 * fake gh that answers `pr view` and records `pr merge`, a local bare repo
 * as the stand-in for GitHub where a revert or a real merge is needed. The
 * city acts only where he granted it, `mayAct` is asked immediately before
 * every act, `autonomy.acted` is written strictly before the act, and a
 * revert stands it down.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { query, record } from '../engine/ledger.js';
import { acceptProposed, job as storedJob, transition } from '../engine/market/jobs.js';
import { run as storedRun } from '../engine/market/runs.js';
import { pollPRs, repoTowerId, resetShipping, watchRevertsFor } from '../engine/market/ship.js';
import { mirrorDir } from '../engine/mirror.js';
import { getRepo, layEarnedFloor } from '../engine/repos.js';
import { act, askDue, closeOrphanedActs, grant, grantOf, mayAct, noteActed } from '../engine/school/autonomy.js';
import { agreement, installDecisions, registerPrediction } from '../engine/school/decisions.js';
import { startSchool } from '../engine/school/tick.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import { AGREE } from '../shared/school-rules.js';
import type { Decision, Inspection, Job, Repo, RepoChecks, Run, WorkKind } from '../shared/types.js';
import { checks, FULL, git, setUp, tearDown, tempDir } from './guild-fixtures.js';
import { agreedDecisions, constant, installNet, storeJobRow, storeRunRow } from './school-fixtures.js';

const DAY = 24 * 60 * 60_000;
/** 12 November 2026, 03:00 local. */
const T0 = new Date(2026, 10, 12, 3, 0).getTime();
const HEAD = 'b'.repeat(40);
const SQUASH_ONLY = 'GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)';

let clock = T0;
let stop: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;
let events: Event[] = [];
/** Every gh call the fake saw. */
let ghCalls: string[][] = [];
/** What the fake gh answers to `pr view <n>`. */
let prStates: Map<number, { state: string; headRefOid: string | null; mergeCommit?: { oid: string } | null; mergedAt?: string | null }>;
/** What `gh pr merge` answers; by default success. */
let mergeAnswer: (args: string[]) => { stdout: string; stderr: string; code: number };

const fakeGh: Runner = async (cmd, args, opts) => {
  if (cmd === 'gh') {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      const s = prStates.get(Number(args[2])) ?? { state: 'OPEN', headRefOid: HEAD };
      return { stdout: JSON.stringify({ mergedAt: null, mergeCommit: null, closedAt: null, baseRefName: 'main', ...s }), stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'merge') return mergeAnswer(args);
    if (args[0] === 'auth') return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  return realRunner(cmd, args, opts);
};

beforeEach(() => {
  setUp('school-act');
  resetShipping();
  clock = T0;
  ghCalls = [];
  prStates = new Map();
  mergeAnswer = () => ({ stdout: '', stderr: '', code: 0 });
  events = [];
  setRunner(fakeGh);
  putRepo(FULL);
  school(true);
  installNet(constant('master', 2, 0.95), { at: new Date(T0 - DAY).toISOString() });
  stop = installDecisions({ now: () => clock });
  unsubscribe = subscribe((e) => events.push(e));
});
afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  stop?.();
  stop = null;
  setRunner(realRunner);
  await tearDown();
});

function school(on: boolean): void {
  patchSettings({ school: { ...getSettings().school, enabled: on } });
}

function putRepo(fullName: string, over: Partial<Repo> = {}, c: Partial<RepoChecks> = {}): Repo {
  const repo: Repo = {
    fullName,
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
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-11-01T00:00:00.000Z',
    checks: checks({ test: 'npm test', build: 'npm run build', ...c }),
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

/** `kind` eligible, with `repo` passing its test: 50 agreed decisions there. */
function eligible(kind: WorkKind, repo = FULL): void {
  clock = agreedDecisions(kind, repo, AGREE.window, clock);
}

/** The pair asked and granted by him. */
function granted(kind: WorkKind, repo = FULL): void {
  eligible(kind, repo);
  const asked = askDue(clock);
  assert.ok(asked.some((g) => g.kind === kind && g.repo === repo), `${kind} on ${repo} was asked`);
  grant(kind, repo, clock);
  assert.equal(grantOf(kind, repo)?.state, 'granted');
}

type Row = Record<string, unknown> & { id: number };
const ledger = (kind: Parameters<typeof query>[0]['kind']): Row[] => query({ kind }).map((e) => ({ ...(e.data as Record<string, unknown>), id: e.id }));
const actedRows = (jobId: string): Row[] => ledger('autonomy.acted').filter((r) => r.jobId === jobId);
const decisions = (jobId: string): Decision[] => query({ kind: 'decision.resolved' }).map((e) => e.data as Decision).filter((d) => d.jobId === jobId);
const merges = () => ghCalls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
const later = (ms = 60_000) => {
  clock += ms;
};

function inspectionOf(r: Run, over: Partial<Inspection> = {}): Inspection {
  const i: Inspection = {
    id: `insp-${r.id}`,
    runId: r.id,
    jobId: r.jobId,
    repo: r.repo,
    reviewerAgentId: null,
    reviewerFirmId: null,
    checks: [],
    passed: true,
    pushable: true,
    design: null,
    cost: 1,
    at: new Date(clock).toISOString(),
    ...over,
  };
  record('inspection.done', { runId: r.id, jobId: r.jobId, repo: r.repo, inspectionId: i.id, passed: i.passed, inspection: i });
  return i;
}

/** A city PR of `tier` waiting on him on `repo`, inspected, its guess written down at `clock`. */
function waitingPR(id: string, o: { tier?: Job['tier']; repo?: string; headSha?: string; run?: Partial<Run> } = {}): { job: Job; run: Run } {
  const repo = o.repo ?? FULL;
  const job = storeJobRow(`job-${id}`, { repo, tier: o.tier ?? 'normal', status: 'waiting', runId: `run-${id}`, title: `Add the ${id} widget` });
  const run = storeRunRow(`run-${id}`, job.id, repo, { headSha: o.headSha ?? HEAD, ...o.run });
  const insp = inspectionOf(run);
  registerPrediction(job, run, clock, insp);
  later();
  return { job, run };
}

/** A proposal waiting on him, its guess written down. */
function proposal(id: string, repo = FULL): Job {
  const job = storeJobRow(`job-${id}`, { repo, source: 'proposal', status: 'proposed', tier: 'low', title: `Add the ${id} note` });
  registerPrediction(job, null, clock);
  later();
  return job;
}

/** A merged city PR on `repo` with a lit floor, as the revert watch reads it. */
function litFloor(id: string, mergeSha: string, repo = FULL, o: { runId?: string; jobId?: string; title?: string } = {}): { job: Job; run: Run } {
  const jobId = o.jobId ?? `job-${id}`;
  const runId = o.runId ?? `run-${id}`;
  const title = o.title ?? `Add the ${id} widget`;
  const had = storedJob(jobId);
  const job = had ?? storeJobRow(jobId, { repo, status: 'merged', runId, floorId: `floor-${id}`, title });
  const run = storedRun(runId) ?? storeRunRow(runId, job.id, repo, { stage: 'waiting', outcome: 'merged', endedAt: new Date(clock).toISOString(), prNumber: 12, mergeSha });
  layEarnedFloor(repoTowerId(repo), {
    id: `floor-${id}`,
    repo,
    kind: 'pr',
    refs: [],
    title,
    at: new Date(clock).toISOString(),
    era: 'glass',
    size: 'small',
    lines: 1,
    claude: false,
    founding: false,
    url: null,
    earned: { jobId: job.id, runId: run.id, agentId: 'w1', firmId: 'quickset', state: 'lit', reverted: false },
  });
  return { job, run };
}

/** The stand-in for GitHub: a bare remote with one commit, mirrored under the home; his clone to push from. */
function remoteRepo(): { remote: string; w: string } {
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
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  return { remote, w };
}

/** A commit in his clone pushed to `ref` (main by default). */
function commitOn(w: string, file: string, message: string, ref = 'HEAD:main'): string {
  writeFileSync(join(w, file), `${message}\n`);
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', message);
  git(w, 'push', '-q', 'origin', ref);
  return git(w, 'rev-parse', 'HEAD');
}

const kindsOf = (es: Event[]) => es.map((e) => e.type);

// ---------------------------------------------------------------- the acts (ruling 18)

test('a granted proposal kind is accepted with acted recorded first', async () => {
  granted('propose:readme-gap');
  const p = proposal('p');
  const n = await act(clock);
  assert.equal(n, 1);
  assert.equal(storedJob(p.id)?.status, 'open', 'the proposal went on the board');
  const rows = actedRows(p.id);
  assert.equal(rows.length, 2, 'the row before and the result after');
  const [before, after] = rows;
  assert.equal(before.kind, 'propose:readme-gap');
  assert.equal(before.repo, FULL);
  assert.equal((before.grant as { acted: number }).acted, 1);
  assert.equal(before.at, new Date(clock).toISOString());
  assert.deepEqual(after.result, { ok: true, reason: null });
  assert.equal(after.grant, undefined);
  // strictly before: the acted row's ledger id is lower than the accept's
  const accept = query({ kind: 'job.changed' }).find((e) => (e.data as { id: string; to: string }).id === p.id && (e.data as { to: string }).to === 'open')!;
  assert.ok(accept, 'the accept is on the ledger');
  assert.ok(before.id < accept.id, 'acted is written before the accept');
  assert.ok(accept.id < after.id, 'the result is written after');
  // the city's accept is not his decision
  assert.deepEqual(decisions(p.id), []);
  assert.equal(grantOf('propose:readme-gap', FULL)?.acted, 1);
  // a second tick does not accept it again, or anything else
  assert.equal(await act(clock + 60_000), 0);
  assert.equal(actedRows(p.id).length, 2);
});

test('a granted merge kind runs exactly gh pr merge with --merge and --match-head-commit', async () => {
  granted('merge:normal');
  const a = waitingPR('a');
  const n = await act(clock);
  assert.equal(n, 1);
  assert.deepEqual(merges(), [['pr', 'merge', '9', '--repo', FULL, '--merge', '--match-head-commit', HEAD]]);
  const [before, after] = actedRows(a.job.id);
  assert.equal(before.kind, 'merge:normal');
  assert.equal(before.repo, FULL);
  assert.equal(before.jobId, a.job.id);
  assert.deepEqual(after.result, { ok: true, reason: null });
  // the merge call sits between the two rows in time: the before row is recorded before gh ran
  const mergeAt = ghCalls.findIndex((c) => c[1] === 'merge');
  assert.ok(mergeAt >= 0);
  assert.ok(before.id < after.id);
  // the city's merge is not his decision
  assert.deepEqual(decisions(a.job.id), []);
  // the PR is still waiting on the poll, which will see it merged; the act is not repeated
  assert.equal(await act(clock + 60_000), 0);
  assert.equal(merges().length, 1);
});

test("a revert pushed one minute before the next act is found by that act's own check, which refuses", async () => {
  const { w } = remoteRepo();
  granted('merge:normal');
  const mergeSha = commitOn(w, 'widgets.md', 'Add the m widget');
  const m = litFloor('m', mergeSha);
  noteActed('merge:normal', FULL, m.job.id, clock);
  const b = waitingPR('b');
  assert.deepEqual(await mayAct('merge:normal', FULL, b.job.id, clock), { ok: true, reason: null }, 'sanity: it would act now');
  git(w, 'revert', '--no-edit', mergeSha);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  later();
  const n = await act(clock);
  assert.equal(n, 0);
  assert.deepEqual(merges(), [], 'no merge ran');
  assert.deepEqual(actedRows(b.job.id), [], 'nothing was recorded as acted on b');
  assert.equal(query({ kind: 'merge.reverted' }).length, 1, 'the act\'s own forced read found it');
  const g = grantOf('merge:normal', FULL)!;
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'revert');
  const revoked = ledger('autonomy.revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].jobId, m.job.id);
  assert.ok(getRepo(FULL)?.halted, 'the repo halts after the revocation');
  assert.ok(kindsOf(events).indexOf('autonomy.revoked') < kindsOf(events).indexOf('repo.halted'), 'revoked before halted');
  assert.equal(storedRun(b.run.id)?.stage, 'waiting', 'the PR still waits on him');
});

test('the stop file mid-tick stops further acts', async () => {
  granted('propose:readme-gap');
  const p1 = proposal('p1');
  const p2 = proposal('p2');
  const off = subscribe((e) => {
    if (e.type === 'job.changed' && (e.data as { job: Job }).job.id === p1.id) writeFileSync(paths().stop, '');
  });
  try {
    const n = await act(clock);
    assert.equal(n, 1);
  } finally {
    off();
  }
  assert.equal(storedJob(p1.id)?.status, 'open');
  assert.equal(storedJob(p2.id)?.status, 'proposed', 'the second act never happened');
  assert.deepEqual(actedRows(p2.id), []);
  assert.equal(actedRows(p1.id).length, 2);
  rmSync(paths().stop);
  // with the stop file cleared, the next tick takes p2
  assert.equal(await act(clock), 1);
  assert.equal(storedJob(p2.id)?.status, 'open');
  // the school turned off mid-tick does the same
  const p3 = proposal('p3');
  const p4 = proposal('p4');
  const off2 = subscribe((e) => {
    if (e.type === 'job.changed' && (e.data as { job: Job }).job.id === p3.id) school(false);
  });
  try {
    assert.equal(await act(clock), 1);
  } finally {
    off2();
  }
  assert.equal(storedJob(p3.id)?.status, 'open');
  assert.equal(storedJob(p4.id)?.status, 'proposed');
  school(true);
  assert.equal(await act(clock), 1, 'with the school back on, the next tick takes it');
  assert.equal(storedJob(p4.id)?.status, 'open');
});

test("a squash-only repo's refusal suspends the pair with that reason", async () => {
  granted('merge:normal');
  const a = waitingPR('a');
  mergeAnswer = () => ({ stdout: '', stderr: SQUASH_ONLY, code: 1 });
  const n = await act(clock);
  assert.equal(n, 0, 'nothing merged');
  assert.equal(merges().length, 1, 'the merge was tried once');
  const g = grantOf('merge:normal', FULL)!;
  assert.equal(g.state, 'suspended');
  assert.equal(g.by, 'school');
  assert.match(g.reason!, /allows only squash or rebase merges/);
  assert.match(g.reason!, /Merge commits are not allowed on this repository/);
  const [before, after] = actedRows(a.job.id);
  assert.equal(before.kind, 'merge:normal');
  assert.equal((after.result as { ok: boolean }).ok, false);
  assert.equal((after.result as { reason: string }).reason, g.reason);
  const suspended = ledger('autonomy.suspended');
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0].reason, g.reason);
  // the PR still waits on him, and the suspended pair acts no more
  assert.equal(storedRun(a.run.id)?.stage, 'waiting');
  assert.equal(storedJob(a.job.id)?.status, 'waiting');
  waitingPR('b');
  assert.equal(await act(clock), 0);
  assert.equal(merges().length, 1);
  // any other gh failure is a failed act with its reason, and no suspension
  mergeAnswer = () => ({ stdout: '', stderr: 'X Pull request #9 is not mergeable: the head branch was modified.', code: 1 });
  grant('merge:normal', FULL, clock, { fromSettings: true });
  const c = waitingPR('c');
  assert.equal(await act(clock), 0);
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted');
  const [, result] = actedRows(c.job.id);
  assert.equal((result.result as { ok: boolean }).ok, false);
  assert.match((result.result as { reason: string }).reason, /head branch was modified/);
});

test('act does nothing with the school off', async () => {
  granted('propose:readme-gap');
  granted('merge:normal');
  const p = proposal('p');
  const a = waitingPR('a');
  school(false);
  assert.equal(await act(clock), 0);
  assert.equal(storedJob(p.id)?.status, 'proposed');
  assert.equal(storedRun(a.run.id)?.stage, 'waiting');
  assert.deepEqual(merges(), []);
  assert.deepEqual(ledger('autonomy.acted'), []);
  assert.deepEqual(ghCalls, [], 'gh was not even asked');
  // and the tick, which carries the acts, does nothing either
  const s = startSchool({ intervalMs: 60 * 60_000, gate: async () => ({ kind: 'light', ok: false, reason: 'test', power: 'ac', powerMode: null, idleMin: null, inWindow: true, trainNowUntil: null, freeGB: null, thermal: 'nominal' }) });
  try {
    const r = await s.tick(clock);
    assert.equal(r.reason, 'the school is off');
    assert.equal(r.acted, 0);
    school(true);
    const again = await s.tick(clock);
    assert.equal(again.acted, 2, 'the tick acts before the gate');
    assert.equal(again.reason, 'test');
  } finally {
    s.stop();
  }
  assert.equal(storedJob(p.id)?.status, 'open');
  assert.equal(merges().length, 1);
});

// ---------------------------------------------------------------- his undoing (ruling 14) and the revert (ruling 19), end to end

test('an autonomous accept, then his withdrawal of that job, records one decision.resolved with by undo and agreed false and suspends the propose pair', async () => {
  granted('propose:readme-gap');
  const p = proposal('p');
  assert.equal(await act(clock), 1);
  assert.deepEqual(decisions(p.id), [], 'the city\'s accept is not his');
  later();
  transition(storedJob(p.id)!, 'withdrawn', {}, { by: 'him' });
  const all = decisions(p.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].key, `propose:readme-gap:${p.id}`);
  assert.equal(all[0].kind, 'propose:readme-gap');
  assert.equal(all[0].by, 'undo');
  assert.equal(all[0].approved, false);
  assert.equal(all[0].agreed, false);
  const g = grantOf('propose:readme-gap', FULL)!;
  assert.equal(g.state, 'suspended');
  assert.equal(g.reason, 'he undid it');
  assert.equal(ledger('autonomy.suspended').length, 1);
  // the undo sits in the window against the master
  assert.ok(agreement('propose:readme-gap').agreed < agreement('propose:readme-gap').rows);
  // and the suspended pair acts no more
  const q = proposal('q');
  assert.equal(await act(clock), 0);
  assert.equal(storedJob(q.id)?.status, 'proposed');
});

test('his close of the PR an auto-accepted proposal produced is matched by jobId and suspends the propose pair', async () => {
  granted('propose:readme-gap');
  const p = proposal('p');
  assert.equal(await act(clock), 1);
  // the job runs and ends as a PR waiting on him
  let j = storedJob(p.id)!;
  for (const to of ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) j = transition(j, to, to === 'running' ? { runId: `run-${p.id}` } : {});
  const run = storeRunRow(`run-${p.id}`, p.id, FULL, { prNumber: 31, prUrl: `https://github.com/${FULL}/pull/31` });
  inspectionOf(run);
  registerPrediction(storedJob(p.id)!, run, clock);
  later();
  assert.deepEqual(decisions(p.id), []);
  // he closes the PR on GitHub without merging
  prStates.set(31, { state: 'CLOSED', headRefOid: HEAD });
  await pollPRs(clock);
  assert.equal(storedRun(run.id)?.outcome, 'closed');
  const all = decisions(p.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].key, `propose:readme-gap:${p.id}`, 'under the kind of the act he undid, by jobId');
  assert.equal(all[0].by, 'undo');
  assert.equal(all[0].approved, false);
  assert.equal(all[0].agreed, false);
  const g = grantOf('propose:readme-gap', FULL)!;
  assert.equal(g.state, 'suspended');
  assert.equal(g.reason, 'he undid it');
});

test('an autonomous merge records no decision.resolved, and a revert of it enters the window as agreed false and revokes the merge pair', async () => {
  const { w } = remoteRepo();
  granted('merge:normal');
  // the city's branch on the stand-in, as ship() would have pushed it
  git(w, 'checkout', '-q', '-b', 'palimpsest/job-k');
  const headSha = commitOn(w, 'widgets.md', 'Add the k widget', 'HEAD:refs/heads/palimpsest/job-k');
  git(w, 'checkout', '-q', 'main');
  const k = waitingPR('k', { headSha, run: { prNumber: 41, prUrl: `https://github.com/${FULL}/pull/41` } });
  prStates.set(41, { state: 'OPEN', headRefOid: headSha });
  // gh pr merge merges on the stand-in, as GitHub would
  let mergeSha = '';
  mergeAnswer = () => {
    git(w, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #41', 'palimpsest/job-k');
    mergeSha = git(w, 'rev-parse', 'HEAD');
    git(w, 'push', '-q', 'origin', 'HEAD:main');
    prStates.set(41, { state: 'MERGED', headRefOid: headSha, mergeCommit: { oid: mergeSha }, mergedAt: new Date(clock).toISOString() });
    return { stdout: '', stderr: '', code: 0 };
  };
  assert.equal(await act(clock), 1);
  assert.deepEqual(merges(), [['pr', 'merge', '41', '--repo', FULL, '--merge', '--match-head-commit', headSha]]);
  // the poll sees the merge: the job is merged, and that is not his decision
  later(6 * 60_000);
  await pollPRs(clock);
  assert.equal(storedRun(k.run.id)?.outcome, 'merged');
  assert.equal(storedJob(k.job.id)?.status, 'merged');
  assert.deepEqual(decisions(k.job.id), [], 'an autonomous merge records no decision');
  // the floor as the poll would have lit it, had the PR been shipped through ship()
  litFloor('k', mergeSha, FULL, { jobId: k.job.id, runId: k.run.id, title: k.job.title });
  const before = agreement('merge:normal');
  assert.equal(before.agreed, before.rows, 'sanity: he and the master agreed on every row so far');
  // he reverts it
  git(w, 'revert', '--no-edit', '-m', '1', mergeSha);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  later();
  events = [];
  const read = await watchRevertsFor(getRepo(FULL)!, clock, { force: true });
  assert.deepEqual(read.reverted, [k.job.title]);
  const all = decisions(k.job.id);
  assert.equal(all.length, 1, 'the revert enters the window once');
  assert.equal(all[0].key, `merge:normal:${k.job.id}`);
  assert.equal(all[0].by, 'revert');
  assert.equal(all[0].approved, false);
  assert.equal(all[0].agreed, false);
  const after = agreement('merge:normal');
  assert.equal(after.agreed, after.rows - 1, 'the revert sits in the window as the one disagreement');
  const g = grantOf('merge:normal', FULL)!;
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'revert');
  const revoked = ledger('autonomy.revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].jobId, k.job.id);
  const order = kindsOf(events);
  assert.ok(order.indexOf('autonomy.revoked') < order.indexOf('repo.halted'), 'revoked before the halt');
  assert.ok(getRepo(FULL)?.halted);
});

// ---------------------------------------------------------------- only acts that happened count (fix round 1)

test('a failed merge then his close records a close, not an undo, and suspends nothing', async () => {
  granted('merge:normal');
  const a = waitingPR('a');
  mergeAnswer = () => ({ stdout: '', stderr: 'X Pull request #9 is not mergeable: the head branch was modified.', code: 1 });
  assert.equal(await act(clock), 0);
  const [, result] = actedRows(a.job.id);
  assert.equal((result.result as { ok: boolean }).ok, false);
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted', 'a failed merge suspends nothing');
  // he closes the PR himself
  later(6 * 60_000);
  prStates.set(9, { state: 'CLOSED', headRefOid: HEAD });
  await pollPRs(clock);
  assert.equal(storedRun(a.run.id)?.outcome, 'closed');
  const all = decisions(a.job.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].by, 'close', 'his close, not an undo of an act that never happened');
  assert.equal(all[0].approved, false);
  assert.equal(all[0].agreed, false, 'the master said approve; he closed');
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted');
  assert.deepEqual(ledger('autonomy.suspended'), []);
  // and had he merged it instead, that would have been his merge
  const b = waitingPR('b');
  assert.equal(await act(clock), 0);
  later(6 * 60_000);
  prStates.set(9, { state: 'MERGED', headRefOid: HEAD, mergeCommit: { oid: 'd'.repeat(40) }, mergedAt: new Date(clock).toISOString() });
  await pollPRs(clock);
  assert.equal(storedJob(b.job.id)?.status, 'merged');
  assert.equal(decisions(b.job.id)[0]?.by, 'merge');
  assert.equal(decisions(b.job.id)[0]?.approved, true);
});

test('an orphaned before-row then his accept records his accept', async () => {
  granted('propose:readme-gap');
  const p = proposal('p');
  // the engine died between noteActed and acceptProposed: the before-row alone
  noteActed('propose:readme-gap', FULL, p.id, clock);
  assert.equal(actedRows(p.id).length, 1);
  assert.equal(storedJob(p.id)?.status, 'proposed');
  later();
  acceptProposed(p.id);
  const all = decisions(p.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].by, 'accept');
  assert.equal(all[0].approved, true);
  assert.equal(all[0].agreed, true);
  // and his dismissal of such a job is a dismissal, not an undo
  const q = proposal('q');
  noteActed('propose:readme-gap', FULL, q.id, clock);
  later();
  transition(storedJob(q.id)!, 'withdrawn', {}, { by: 'him' });
  assert.equal(decisions(q.id)[0]?.by, 'dismiss');
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'granted', 'nothing to undo, nothing suspended');
  assert.deepEqual(ledger('autonomy.suspended'), []);
});

test("an orphaned before-row where the merge did land is still the city's", async () => {
  granted('merge:normal');
  const k = waitingPR('k');
  // the engine died after gh merged and before the result row
  noteActed('merge:normal', FULL, k.job.id, clock);
  later(6 * 60_000);
  prStates.set(9, { state: 'MERGED', headRefOid: HEAD, mergeCommit: { oid: 'd'.repeat(40) }, mergedAt: new Date(clock).toISOString() });
  await pollPRs(clock);
  assert.equal(storedJob(k.job.id)?.status, 'merged');
  assert.deepEqual(decisions(k.job.id), [], 'the merge is the city\'s, not his');
  // and his later revert of it is still a revert of the city's merge: in the window against it, under the merge key
  const { resolve } = await import('../engine/school/decisions.js');
  resolve(storedJob(k.job.id)!, 'revert', clock + 60_000);
  assert.equal(decisions(k.job.id).length, 1);
  assert.equal(decisions(k.job.id)[0].by, 'revert');
  assert.equal(decisions(k.job.id)[0].key, `merge:normal:${k.job.id}`);
  assert.equal(decisions(k.job.id)[0].agreed, false);
});

test('at engine start, every cut-short act gets its result from what the store shows', async () => {
  granted('merge:normal');
  granted('propose:readme-gap');
  // a before-row with nothing to show for it, one whose merge landed, one whose accept landed, and one complete act
  const dead = waitingPR('dead');
  noteActed('merge:normal', FULL, dead.job.id, clock);
  const landed = waitingPR('landed', { run: { prNumber: 41 } });
  noteActed('merge:normal', FULL, landed.job.id, clock);
  prStates.set(41, { state: 'MERGED', headRefOid: HEAD, mergeCommit: { oid: 'd'.repeat(40) }, mergedAt: new Date(clock).toISOString() });
  await pollPRs(clock);
  const p = proposal('p');
  noteActed('propose:readme-gap', FULL, p.id, clock);
  acceptProposed(p.id);
  const done = proposal('done');
  assert.equal(await act(clock), 1);
  assert.equal(actedRows(done.id).length, 2);
  later();
  assert.equal(closeOrphanedActs(clock), 3);
  const row = (id: string) => actedRows(id).at(-1)!.result as { ok: boolean; reason: string };
  assert.deepEqual(row(dead.job.id), { ok: false, reason: 'the engine stopped before the merge was made or confirmed' });
  assert.deepEqual(row(landed.job.id), { ok: true, reason: 'the merge went through, but the engine stopped before it could write that down' });
  assert.deepEqual(row(p.id), { ok: true, reason: 'the accept went through, but the engine stopped before it could write that down' });
  assert.equal(actedRows(done.id).length, 2, 'a complete act is left alone');
  assert.equal(actedRows(dead.job.id).at(-1)!.at, new Date(clock).toISOString());
  // closed once
  assert.equal(closeOrphanedActs(clock), 0);
  // and the closed rows carry the verdict decisions.ts reads: his close of the dead PR is his close
  prStates.set(9, { state: 'CLOSED', headRefOid: HEAD });
  later(6 * 60_000);
  await pollPRs(clock);
  assert.equal(decisions(dead.job.id)[0]?.by, 'close');
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted');
});

// ---------------------------------------------------------------- the pin

test('no autonomous action without a grant', async () => {
  const p = proposal('p');
  const a = waitingPR('a');
  // the master is sure, the repo is fine, the kinds are eligible: still nothing without his grant
  eligible('propose:readme-gap');
  eligible('merge:normal');
  assert.equal(await act(clock), 0);
  // an ask is not a grant
  assert.ok(askDue(clock).length >= 2);
  assert.equal(await act(clock), 0);
  // a grant row written by hand on Beagle, by any spelling, is nothing
  const beagle = 'allstreets/beagle';
  putRepo(beagle);
  const at = new Date(clock).toISOString();
  openDb()
    .prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)')
    .run('propose:readme-gap', beagle, 'granted', at, JSON.stringify({ kind: 'propose:readme-gap', repo: beagle, state: 'granted', at, by: 'him', rate: null, reason: null, acted: 0, quietUntil: null }));
  const bp = proposal('bp', beagle);
  assert.equal(await act(clock), 0);
  assert.equal(storedJob(bp.id)?.status, 'proposed');
  assert.equal(storedJob(p.id)?.status, 'proposed');
  assert.equal(storedRun(a.run.id)?.stage, 'waiting');
  assert.deepEqual(merges(), []);
  assert.deepEqual(ledger('autonomy.acted'), []);
  assert.deepEqual(decisions(p.id), []);
  // and under a grant, a key he has already decided is his, whatever the store says the job is
  grant('propose:readme-gap', FULL, clock);
  const d = proposal('d');
  const { resolve } = await import('../engine/school/decisions.js');
  // his accept recorded while the store still says proposed (an engine that stopped between the two writes)
  resolve(d, 'accept', clock);
  assert.equal((await mayAct('propose:readme-gap', FULL, d.id, clock)).reason, `You have already decided propose:readme-gap:${d.id}.`);
  assert.equal(await act(clock), 1, 'only p, which he has not decided');
  assert.equal(storedJob(d.id)?.status, 'proposed');
  assert.deepEqual(actedRows(d.id), []);
});
