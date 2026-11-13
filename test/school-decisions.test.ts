/**
 * His decisions, never the city's, and the master's agreement (Phase 4 Task
 * 15, rulings 14 to 16). The market moves jobs and runs as it does for real
 * (transition, finishWaitingRun); installDecisions() hears them on the bus.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit } from '../engine/events.js';
import { query, record } from '../engine/ledger.js';
import { acceptProposed, dismissProposed, job as storedJob, postProposal, setTier, transition } from '../engine/market/jobs.js';
import { finishWaitingRun } from '../engine/market/runs.js';
import { PR_CLOSED_REASON } from '../engine/market/ship.js';
import { agreement, agreements, installDecisions, registerPrediction, resolve } from '../engine/school/decisions.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Decision, Job, Repo, Run, WorkKind } from '../shared/types.js';
import { FULL, setUp, tearDown } from './guild-fixtures.js';
import { constant, installNet } from './school-fixtures.js';

const OTHER = 'acme/gadgets';
let stop: (() => void) | null = null;
let clock = Date.now();
let suspended: Array<{ kind: WorkKind; repo: string; reason: string }> = [];

beforeEach(() => {
  setUp('school-decisions');
  putRepo(FULL);
  putRepo(OTHER);
  school(true);
  clock = Date.now();
  suspended = [];
  stop = installDecisions({ now: () => clock, suspend: (kind, repo, reason) => suspended.push({ kind, repo, reason }) });
});
afterEach(async () => {
  stop?.();
  stop = null;
  await tearDown();
});

function school(on: boolean): void {
  patchSettings({ school: { ...getSettings().school, enabled: on } });
}

function putRepo(fullName: string): void {
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
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
}

let n = 0;
function propose(title = `Document the CLI flags ${++n}`): Job {
  return postProposal({
    repo: FULL,
    title,
    body: 'The README names flags the CLI does not have.',
    scope: ['README.md'],
    acceptance: ['The README names only real flags'],
    tier: 'low',
    key: `proposal:${title}`,
    source: 'proposal',
    proposal: null,
  });
}

/** A job written straight to the store: nothing heard it posted, so no guess was made on it. */
function storeJob(id: string, over: Partial<Job>): Job {
  const j: Job = {
    id,
    repo: FULL,
    source: 'manual',
    issue: null,
    url: null,
    title: `Job ${id}`,
    body: '',
    scope: ['**'],
    acceptance: ['it works'],
    tier: 'normal',
    value: 60,
    status: 'waiting',
    attempts: 0,
    postedAt: '2026-11-12T01:00:00.000Z',
    bidsCloseAt: null,
    awardedBid: null,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO jobs (id, repo, status, json, key) VALUES (?, ?, ?, ?, ?)').run(j.id, j.repo, j.status, JSON.stringify(j), null);
  return j;
}

function storeRun(id: string, jobId: string, over: Partial<Run> = {}): Run {
  const r: Run = {
    id,
    jobId,
    bidId: `bid-${jobId}`,
    agentId: 'w1',
    firmId: 'quickset',
    repo: FULL,
    model: 'claude:sonnet',
    branch: `palimpsest/${jobId}`,
    dir: null,
    baseSha: null,
    headSha: 'b'.repeat(40),
    stage: 'waiting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 1, testsRun: 0, turns: 1, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: '2026-11-12T01:00:00.000Z',
    endedAt: null,
    prNumber: 9,
    prUrl: `https://github.com/${FULL}/pull/9`,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  return r;
}

/** A city PR waiting on him, its guess written down when it opened. */
function waitingPR(id: string, o: { tier?: Job['tier']; predict?: boolean } = {}): { job: Job; run: Run } {
  const j = storeJob(`job-${id}`, { tier: o.tier ?? 'normal', runId: `run-${id}` });
  const r = storeRun(`run-${id}`, j.id);
  if (o.predict !== false) registerPrediction(j, r, clock);
  clock += 60_000;
  return { job: j, run: r };
}

type Row = Decision & { id: number; inputs?: Record<string, unknown> };
const resolved = (jobId?: string): Row[] =>
  query({ kind: 'decision.resolved' })
    .map((e) => ({ ...(e.data as Decision & { inputs?: Record<string, unknown> }), id: e.id }))
    .filter((d) => !jobId || d.jobId === jobId);
const tableRows = (): Decision[] => (openDb().prepare('SELECT json FROM decisions ORDER BY rowid').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Decision);
const later = () => {
  clock += 60_000;
};

/** The city acted on this job under a grant (Task 17's row, by jobId). */
function acted(jobId: string, kind: WorkKind, repo = FULL): void {
  record('autonomy.acted', { kind, repo, jobId, key: `${kind}:${jobId}`, at: new Date(clock).toISOString() });
}

// ---------------------------------------------------------------- proposals

test('accepting a proposal predicted 0.8 records approved and agreed', () => {
  installNet(constant('master', 2, 0.8));
  const j = propose();
  later();
  acceptProposed(j.id);
  const [d] = resolved(j.id);
  assert.equal(d.key, `propose:readme-gap:${j.id}`);
  assert.equal(d.kind, 'propose:readme-gap');
  assert.equal(d.repo, FULL);
  assert.equal(d.approved, true);
  assert.equal(d.by, 'accept');
  assert.equal(d.agreed, true);
  const [pred] = query({ kind: 'master.predicted', jobId: j.id });
  assert.equal(d.predictionId, pred.id);
  // the inputs the master read before he decided, for its own training rows
  assert.deepEqual(d.inputs, (pred.data as { inputs: unknown }).inputs);
  // the table keeps the Decision, as replay rebuilds it
  const { inputs: _inputs, id: _id, ...decision } = d;
  assert.deepEqual(tableRows(), [decision]);
  assert.equal(resolved().length, 1);
});

test('dismissing it records agreed false', () => {
  installNet(constant('master', 2, 0.8));
  const j = propose();
  later();
  dismissProposed(j.id);
  const [d] = resolved(j.id);
  assert.equal(d.approved, false);
  assert.equal(d.by, 'dismiss');
  assert.equal(d.agreed, false);
  // a master that guessed decline agrees with a dismissal
  installNet(constant('master', 3, 0.2));
  const k = propose();
  later();
  dismissProposed(k.id);
  assert.equal(resolved(k.id)[0].agreed, true);
});

test('a city withdrawal and a tier change are not his decisions', () => {
  const j = propose();
  later();
  setTier(j.id, 'normal');
  transition(storedJob(j.id)!, 'withdrawn');
  const k = storeJob('job-open', { source: 'proposal', status: 'open' });
  transition(k, 'withdrawn', {}, { by: 'him' });
  assert.equal(resolved().length, 0);
});

// ---------------------------------------------------------------- PRs

test('a merged PR with his changes approves', () => {
  installNet(constant('master', 2, 0.7));
  const a = waitingPR('a', { tier: 'low' });
  finishWaitingRun(a.run.id, 'merged', null, { hisChanges: { headRefOid: 'c'.repeat(40), commits: ['c'.repeat(40)] } });
  transition(storedJob(a.job.id)!, 'merged');
  const [d] = resolved(a.job.id);
  assert.equal(d.key, `merge:low:${a.job.id}`);
  assert.equal(d.approved, true);
  assert.equal(d.by, 'merge');
  assert.equal(d.agreed, true);
  // merged with someone else's changes: the run ends closed, and it is still his approval
  const b = waitingPR('b');
  finishWaitingRun(b.run.id, 'closed', 'The PR was merged with changes: the PR head was ccccccc, not the inspected bbbbbbb.', {
    mergedWithChanges: { headRefOid: 'c'.repeat(40), baseRefName: 'main', mergeSha: null },
  });
  transition(storedJob(b.job.id)!, 'closed');
  const [e] = resolved(b.job.id);
  assert.equal(e.key, `merge:normal:${b.job.id}`);
  assert.equal(e.approved, true);
  assert.equal(e.by, 'merge');
  assert.equal(resolved().length, 2);
});

test('a PR he closed declines', () => {
  installNet(constant('master', 2, 0.7));
  const a = waitingPR('a');
  finishWaitingRun(a.run.id, 'closed', PR_CLOSED_REASON);
  transition(storedJob(a.job.id)!, 'closed');
  const all = resolved(a.job.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].approved, false);
  assert.equal(all[0].by, 'close');
  assert.equal(all[0].agreed, false);
});

test('a job closed because its issue closed records no decision', () => {
  const a = waitingPR('a');
  finishWaitingRun(a.run.id, 'closed', 'The issue was closed.');
  transition(storedJob(a.job.id)!, 'closed');
  const b = waitingPR('b');
  transition(storedJob(b.job.id)!, 'closed');
  assert.equal(resolved().length, 0);
});

test('a push-mode merge records no decision', () => {
  const j = storeJob('job-push', { status: 'shipping', runId: 'run-push' });
  storeRun('run-push', j.id, { stage: 'shipping', prNumber: null, prUrl: null });
  transition(j, 'merged');
  assert.equal(resolved().length, 0);
});

test('a revert after an approve supersedes it as a decline', () => {
  installNet(constant('master', 2, 0.3));
  const a = waitingPR('a');
  finishWaitingRun(a.run.id, 'merged', null);
  transition(storedJob(a.job.id)!, 'merged');
  assert.equal(resolved(a.job.id)[0].agreed, false);
  later();
  const data = { jobId: a.job.id, runId: a.run.id, repo: FULL, floorId: 'f1', mergeSha: 'd'.repeat(40), revertSha: 'e'.repeat(40), at: new Date(clock).toISOString() };
  record('merge.reverted', data);
  emit('merge.reverted', data);
  const all = resolved(a.job.id);
  assert.equal(all.length, 2);
  assert.equal(all[1].key, all[0].key);
  assert.equal(all[1].approved, false);
  assert.equal(all[1].by, 'revert');
  assert.equal(all[1].predictionId, all[0].predictionId);
  assert.equal(all[1].agreed, true, 'the master guessed decline at 0.3');
  // the window reads the latest resolution of the key: one row, agreed
  const g = agreement('merge:normal');
  assert.equal(g.rows, 1);
  assert.equal(g.agreed, 1);
  // heard again, nothing more
  emit('merge.reverted', data);
  assert.equal(resolved(a.job.id).length, 2);
  // a revert of a merge that was not his decision (push mode) supersedes nothing
  const p = storeJob('job-push', { status: 'merged' });
  emit('merge.reverted', { ...data, jobId: p.id });
  assert.equal(resolved(p.id).length, 0);
});

// ---------------------------------------------------------------- prospective only

test('a decision with no earlier prediction has agreed null and is in no window', () => {
  installNet(constant('master', 2, 0.9));
  const j = storeJob('job-none', { source: 'proposal', status: 'proposed' });
  acceptProposed(j.id);
  const [d] = resolved(j.id);
  assert.equal(d.predictionId, null);
  assert.equal(d.agreed, null);
  assert.equal(agreement('propose:readme-gap').rows, 0);
  // a guess written at the same moment as the decision is not strictly before it
  const k = storeJob('job-same', { source: 'proposal', status: 'proposed' });
  registerPrediction(k, null, clock);
  acceptProposed(k.id);
  assert.equal(resolved(k.id)[0].agreed, null);
  // nor is one written after it
  const m = storeJob('job-after', { source: 'proposal', status: 'proposed' });
  registerPrediction(m, null, clock + 1);
  assert.equal(resolve(storedJob(m.id)!, 'accept', clock)?.agreed, null);
  assert.equal(agreement('propose:readme-gap').rows, 0);
});

test('an abstention counts as a disagreement', () => {
  installNet(constant('master', 2, 0.9));
  school(false);
  const j = propose();
  school(true);
  later();
  acceptProposed(j.id);
  const [d] = resolved(j.id);
  assert.notEqual(d.predictionId, null);
  assert.equal(d.agreed, false);
  const g = agreement('propose:readme-gap');
  assert.equal(g.rows, 1);
  assert.equal(g.agreed, 0);
});

// ---------------------------------------------------------------- the city's own acts

test('an autonomous accept and an autonomous merge record no decision.resolved', () => {
  installNet(constant('master', 2, 0.95));
  const j = propose();
  later();
  acted(j.id, 'propose:readme-gap');
  acceptProposed(j.id);
  assert.equal(resolved().length, 0);
  // a PR whose merge the city made under a grant
  const a = waitingPR('a');
  acted(a.job.id, 'merge:normal');
  finishWaitingRun(a.run.id, 'merged', null);
  transition(storedJob(a.job.id)!, 'merged');
  // and any later merge of the PR an auto-accepted job produced, matched by jobId
  const b = waitingPR('b');
  acted(b.job.id, 'propose:readme-gap');
  finishWaitingRun(b.run.id, 'merged', null);
  transition(storedJob(b.job.id)!, 'merged');
  assert.equal(resolved().length, 0);
  assert.equal(tableRows().length, 0);
  assert.deepEqual(suspended, []);
  // resolve() itself refuses the city's own acts
  assert.equal(resolve(storedJob(a.job.id)!, 'merge', clock), null);
});

test('his withdrawal of an auto-accepted job records agreed false, by undo, and suspends the pair', () => {
  installNet(constant('master', 2, 0.95));
  const j = propose();
  later();
  acted(j.id, 'propose:readme-gap');
  acceptProposed(j.id);
  later();
  transition(storedJob(j.id)!, 'withdrawn', {}, { by: 'him' });
  const all = resolved(j.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].key, `propose:readme-gap:${j.id}`);
  assert.equal(all[0].kind, 'propose:readme-gap');
  assert.equal(all[0].by, 'undo');
  assert.equal(all[0].approved, false);
  assert.equal(all[0].agreed, false);
  assert.deepEqual(suspended, [{ kind: 'propose:readme-gap', repo: FULL, reason: 'he undid it' }]);
  assert.equal(agreement('propose:readme-gap').rows, 1);
  // a city withdrawal of an acted job is no undo
  const k = propose();
  later();
  acted(k.id, 'propose:readme-gap');
  acceptProposed(k.id);
  transition(storedJob(k.id)!, 'withdrawn');
  assert.equal(resolved(k.id).length, 0);
});

test('his close of an autonomous PR does the same', () => {
  installNet(constant('master', 2, 0.95));
  // the PR of a job the city accepted on its own: the propose pair acted
  const a = waitingPR('a');
  acted(a.job.id, 'propose:readme-gap');
  finishWaitingRun(a.run.id, 'closed', PR_CLOSED_REASON);
  transition(storedJob(a.job.id)!, 'closed');
  const [d] = resolved(a.job.id);
  assert.equal(d.key, `propose:readme-gap:${a.job.id}`);
  assert.equal(d.by, 'undo');
  assert.equal(d.approved, false);
  assert.equal(d.agreed, false);
  // a PR the city set out to merge on its own (the merge pair acted), closed by him instead
  const b = waitingPR('b', { tier: 'high' });
  acted(b.job.id, 'merge:high', OTHER);
  finishWaitingRun(b.run.id, 'closed', PR_CLOSED_REASON);
  transition(storedJob(b.job.id)!, 'closed');
  const [e] = resolved(b.job.id);
  assert.equal(e.key, `merge:high:${b.job.id}`);
  assert.equal(e.by, 'undo');
  assert.equal(e.agreed, false);
  assert.deepEqual(suspended, [
    { kind: 'propose:readme-gap', repo: FULL, reason: 'he undid it' },
    { kind: 'merge:high', repo: OTHER, reason: 'he undid it' },
  ]);
  // his revert of a merge the city made under a grant enters the window against it, and suspends nothing here
  const c = waitingPR('c');
  acted(c.job.id, 'merge:normal');
  finishWaitingRun(c.run.id, 'merged', null);
  transition(storedJob(c.job.id)!, 'merged');
  emit('merge.reverted', { jobId: c.job.id, runId: c.run.id, repo: FULL, floorId: 'f', mergeSha: 'd'.repeat(40), revertSha: 'e'.repeat(40), at: new Date(clock).toISOString() });
  const [f] = resolved(c.job.id);
  assert.equal(f.by, 'revert');
  assert.equal(f.kind, 'merge:normal');
  assert.equal(f.agreed, false);
  assert.equal(suspended.length, 2);
});

// ---------------------------------------------------------------- the window

/** `count` decisions of a proposal kind on `repo`, with the master at 0.9: `agreedFirst` accepts, then dismissals. */
function decisions(count: number, agreed: number, repo = FULL, order: 'agreed-first' | 'agreed-last' = 'agreed-first'): void {
  for (let i = 0; i < count; i++) {
    const id = `w-${repo}-${n++}`;
    const j = storeJob(id, { source: 'proposal', status: 'proposed', repo });
    registerPrediction(j, null, clock);
    later();
    const ok = order === 'agreed-first' ? i < agreed : i >= count - agreed;
    resolve(j, ok ? 'accept' : 'dismiss', clock);
    later();
  }
}

test('49 rows are not eligible, 50 with 48 agreed are, 50 with 47 are not', () => {
  installNet(constant('master', 2, 0.9));
  decisions(49, 49);
  let g = agreement('propose:readme-gap');
  assert.equal(g.rows, 49);
  assert.equal(g.eligible, false);
  // 50 rows, 48 agreed: 0.96
  openDb().exec("DELETE FROM decisions; DELETE FROM ledger WHERE kind = 'decision.resolved'");
  decisions(50, 48, FULL, 'agreed-last');
  g = agreement('propose:readme-gap');
  assert.equal(g.rows, 50);
  assert.equal(g.agreed, 48);
  assert.ok(Math.abs((g.rate?.value as number) - 0.96) < 1e-12);
  assert.ok(g.rate && g.rate.lo <= 0.96 && g.rate.hi >= 0.96 && g.rate.n === 50);
  assert.equal(g.eligible, true);
  assert.equal(g.repo, null);
  assert.equal(g.repoOk, null);
  assert.equal(g.skewed, false);
  // 50 with 47: 0.94
  openDb().exec("DELETE FROM decisions; DELETE FROM ledger WHERE kind = 'decision.resolved'");
  decisions(50, 47, FULL, 'agreed-last');
  g = agreement('propose:readme-gap');
  assert.equal(g.agreed, 47);
  assert.equal(g.eligible, false);
  // only the last 50 count: 10 older disagreements fall out of the window
  openDb().exec("DELETE FROM decisions; DELETE FROM ledger WHERE kind = 'decision.resolved'");
  decisions(60, 50, FULL, 'agreed-last');
  g = agreement('propose:readme-gap');
  assert.equal(g.rows, 50);
  assert.equal(g.agreed, 50);
  assert.equal(g.eligible, true);
  // another kind is its own window, and agreements() lists all six
  assert.equal(agreement('propose:harness').rows, 0);
  assert.equal(agreement('propose:harness').rate, null);
  assert.deepEqual(agreements().map((x) => x.kind), ['propose:harness', 'propose:readme-gap', 'merge:low', 'merge:normal', 'merge:high', 'merge:ui']);
  assert.equal(agreements()[1].eligible, true);
});

test('the repo test needs 10 rows and none of the last 10 against', () => {
  installNet(constant('master', 2, 0.9));
  decisions(9, 9, OTHER);
  assert.equal(agreement('propose:readme-gap', OTHER).repoOk, false, '9 rows');
  decisions(1, 1, OTHER);
  const g = agreement('propose:readme-gap', OTHER);
  assert.equal(g.repo, OTHER);
  assert.equal(g.repoOk, true, '10 rows, all agreed');
  assert.equal(g.rows, 10, 'the window is pooled across repos');
  // one against in its last 10
  decisions(10, 9, OTHER, 'agreed-first');
  assert.equal(agreement('propose:readme-gap', OTHER).repoOk, false);
  // ten more agreed push it out
  decisions(10, 10, OTHER);
  assert.equal(agreement('propose:readme-gap', OTHER).repoOk, true);
  // another repo's disagreements do not touch this repo's test, but do count in the pooled window
  decisions(3, 0, FULL);
  assert.equal(agreement('propose:readme-gap', OTHER).repoOk, true);
  assert.equal(agreement('propose:readme-gap', FULL).repoOk, false);
  assert.equal(agreement('propose:readme-gap').rows, 33);
});

// ---------------------------------------------------------------- fix round 1

test('a revert is judged against the guess its approve was, never a later one', () => {
  installNet(constant('master', 2, 0.3));
  // the approve had no guess before it: the revert has none either
  const a = waitingPR('a', { predict: false });
  finishWaitingRun(a.run.id, 'merged', null);
  transition(storedJob(a.job.id)!, 'merged');
  assert.equal(resolved(a.job.id)[0].agreed, null);
  // a guess squeezed in on the key directly in the table after his approve is ignored by the revert
  const key = resolved(a.job.id)[0].key;
  openDb()
    .prepare('INSERT INTO predictions (id, key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(999_999, key, 'merge:normal', FULL, new Date(clock - 1).toISOString(), JSON.stringify({ id: 999_999, key, kind: 'merge:normal', repo: FULL, jobId: a.job.id, p: 0.1, version: 2, reason: null, at: new Date(clock - 1).toISOString() }));
  later();
  emit('merge.reverted', { jobId: a.job.id, runId: a.run.id, repo: FULL, floorId: 'f', mergeSha: 'd'.repeat(40), revertSha: 'e'.repeat(40), at: new Date(clock).toISOString() });
  const [, rev] = resolved(a.job.id);
  assert.equal(rev.by, 'revert');
  assert.equal(rev.predictionId, null);
  assert.equal(rev.agreed, null);
  assert.equal(agreement('merge:normal').rows, 0);
});

test('no guess is written on a key he has already decided', () => {
  installNet(constant('master', 2, 0.9));
  const j = storeJob('job-late', { source: 'proposal', status: 'proposed' });
  acceptProposed(j.id);
  const got = registerPrediction(storedJob(j.id)!, null, clock + 60_000);
  assert.equal(got.p, null);
  assert.equal(got.id, 0);
  assert.equal(query({ kind: 'master.predicted', jobId: j.id }).length, 0);
  assert.equal((openDb().prepare('SELECT COUNT(*) AS n FROM predictions').get() as { n: number }).n, 0);
  // so a revert can never meet a guess written after his decision
  assert.equal(resolved(j.id)[0].agreed, null);
});
