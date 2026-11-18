/**
 * The one-off repair (tools/repair-inspect-timeouts.ts) of runs an
 * inspection blamed on their firm when the test check only ran out of time.
 * The old runner's records are written as it wrote them, in a temp home with
 * the sandbox off; nothing touches his data home.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { entries, record } from '../engine/ledger.js';
import { job, transition } from '../engine/market/jobs.js';
import { resolvedBids } from '../engine/market/reputation.js';
import { run as storedRun } from '../engine/market/runs.js';
import { layScar, repoTowerId } from '../engine/market/ship.js';
import { earnedFloors, getRepo, updateRepoMarket } from '../engine/repos.js';
import type { CheckResult, Inspection, Job, Run } from '../shared/types.js';
import { applyRepair, FAILED_INSPECTION, planRepair } from '../tools/repair-inspect-timeouts.js';
import { addAgent, checks, FULL, makeRepo, postJob, setUp, tearDown } from './guild-fixtures.js';

beforeEach(() => setUp('repair'));
afterEach(tearDown);

const timedOut: CheckResult = { name: 'test', status: 'fail', detail: 'npm test exited without a code: ok 47 - the credit cap', durationMs: 900_954, logPath: null, testsRun: null, inconclusive: 'timed out' };
const built: CheckResult = { name: 'build', status: 'pass', detail: 'npm run build', durationMs: 1_622, logPath: null, testsRun: null };
const typeErrors: CheckResult = { name: 'typecheck', status: 'fail', detail: 'tsc found 2 errors', durationMs: 900, logPath: null, testsRun: null };

let n = 0;
/** A run of `firmId` on `j` that failed inspection with `checks`, recorded the way the runner did before the fix. */
function failedAsBefore(j: Job, firmId: string, cs: CheckResult[]): Run {
  const id = `run-old${n++}`;
  const bid = { id: `bid-${id}`, jobId: j.id, firmId, agentId: `${firmId}-a`, confidence: 0.8 };
  addAgent(`${firmId}-a`, firmId, 'claude:sonnet');
  record('job.awarded', { jobId: j.id, tier: j.tier, considered: [bid], satOut: [], chosen: bid, why: 'test', at: new Date().toISOString(), coolOffUntil: null });
  const insp: Inspection = { id: `insp-${id}`, runId: id, jobId: j.id, repo: FULL, reviewerAgentId: null, reviewerFirmId: null, checks: cs, passed: false, pushable: false, design: null, cost: 0, at: new Date().toISOString(), inconclusive: null };
  openDb().prepare('INSERT INTO inspections (id, run_id, json) VALUES (?, ?, ?)').run(insp.id, id, JSON.stringify(insp));
  record('inspection.done', { inspectionId: insp.id, runId: id, jobId: j.id, repo: FULL, value: j.value, reviewerAgentId: null, reviewerFirmId: null, passed: false, pushable: false, inconclusive: null, summary: 'Failed: test.', inspection: insp });
  updateRepoMarket(FULL, { strikes: (getRepo(FULL)?.strikes ?? 0) + 1 });
  const r: Run = {
    id, jobId: j.id, bidId: bid.id, agentId: bid.agentId, firmId, repo: FULL, model: 'claude:sonnet', branch: `palimpsest/${j.id}`, dir: null,
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), stage: 'done', outcome: 'failed', endedReason: FAILED_INSPECTION,
    progress: { toolCalls: 1, filesChanged: 1, testsRun: 0, turns: 1, weightedTokens: 1, credits: 1, refusals: 0 },
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), prNumber: null, prUrl: null, mergeSha: null, inspectionId: insp.id, scar: true, unattended: false, summary: 'done',
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  layScar(r, j, 10);
  record('run.ended', { runId: id, jobId: j.id, outcome: 'failed', reason: FAILED_INSPECTION, summary: 'done', run: r });
  const cur = job(j.id) as Job;
  const moved = transition(transition(transition(transition(cur, 'bidding'), 'awarded'), 'running'), 'inspecting');
  const failed = transition(moved, 'failed', { excludedFirms: [...moved.excludedFirms, firmId] });
  if (failed.attempts < 2) transition(failed, 'open');
  return r;
}

test('the repair gives the firm back its attempt and its place, ends the run crashed without a scar, and clears its record', () => {
  makeRepo(checks(), { 'README.md': 'widgets\n' });
  const j = postJob(['**']);
  const r = failedAsBefore(j, 'quickset', [timedOut, built]);
  assert.equal(resolvedBids().filter((x) => x.jobId === j.id).length, 1, 'before: the firm carries the failure');
  assert.equal(getRepo(FULL)!.strikes, 1);

  const plan = planRepair();
  assert.deepEqual(plan.runs.map((p) => p.runId), [r.id]);
  assert.deepEqual(plan.jobs, [{ jobId: j.id, status: 'open', attempts: { from: 1, to: 0 }, excludedFirms: { from: ['quickset'], to: [] } }]);
  assert.deepEqual(plan.repos, [{ repo: FULL, strikes: { from: 1, to: 0 } }]);
  assert.equal(storedRun(r.id)?.outcome, 'failed', 'planning writes nothing');

  const backup = applyRepair(plan);
  assert.ok(existsSync(backup), 'the database before the repair is kept');
  const after = storedRun(r.id) as Run;
  assert.equal(after.outcome, 'crashed');
  assert.equal(after.scar, false);
  assert.match(after.endedReason ?? '', /could not reach a verdict: The test check ran out of its 15 minute limit/);
  const fixed = job(j.id) as Job;
  assert.equal(fixed.attempts, 0);
  assert.deepEqual(fixed.excludedFirms, []);
  assert.equal(fixed.status, 'open', 'the job keeps its status');
  assert.equal(getRepo(FULL)!.strikes, 0);
  assert.ok(!earnedFloors(repoTowerId(FULL)).some((f) => f.id === `${FULL}#scar-${r.id}`), 'the scar is off the tower');
  assert.equal(resolvedBids().filter((x) => x.jobId === j.id).length, 0, 'no outcome for the firm');
  const done = entries().find((e) => e.kind === 'inspection.done' && (e.data as { runId: string }).runId === r.id)?.data as { inconclusive: string; inspection: Inspection };
  assert.match(done.inconclusive, /ran out of its 15 minute limit/);
  assert.equal(done.inspection.inconclusive, done.inconclusive);
  const ended = entries().find((e) => e.kind === 'run.ended' && (e.data as { runId: string }).runId === r.id)?.data as { outcome: string; run: Run };
  assert.equal(ended.outcome, 'crashed');
  assert.equal(ended.run.outcome, 'crashed');
  assert.ok(!entries().some((e) => e.kind === 'floor.scarred' && (e.data as { runId: string }).runId === r.id));
  assert.ok(entries().some((e) => e.kind === 'run.note' && (e.data as { runId: string; note: string }).runId === r.id && /repaired/.test((e.data as { note: string }).note)));
  const changed = entries().filter((e) => e.kind === 'job.changed').at(-1)?.data as { job: Job };
  assert.equal(changed.job.attempts, 0, 'replay reads the repaired job');
  assert.deepEqual(planRepair().runs, [], 'a second run finds nothing to repair');
});

test('a run whose inspection also really failed is left alone, and the firm behind it stays excluded', () => {
  makeRepo(checks(), { 'README.md': 'widgets\n' });
  const j = postJob(['**']);
  const own = failedAsBefore(j, 'kiln', [timedOut, typeErrors]);
  assert.deepEqual(planRepair().runs, [], 'a check that really failed is a verdict');
  const timed = failedAsBefore(j, 'quickset', [timedOut, built]);
  const plan = planRepair();
  assert.deepEqual(plan.runs.map((p) => p.runId), [timed.id]);
  assert.deepEqual(plan.jobs[0].attempts, { from: 2, to: 1 });
  assert.deepEqual(plan.jobs[0].excludedFirms, { from: ['kiln', 'quickset'], to: ['kiln'] });
  assert.deepEqual(plan.repos[0].strikes, { from: 2, to: 1 }, 'the real failure still counts');
  applyRepair(plan);
  assert.equal(storedRun(own.id)?.outcome, 'failed');
  assert.equal(resolvedBids().filter((x) => x.jobId === j.id && x.firmId === 'kiln').length, 1, "kiln's own failure stays on its record");
});

test('naming jobs limits the repair to them', () => {
  makeRepo(checks(), { 'README.md': 'widgets\n' });
  const a = postJob(['**']);
  const b = postJob(['**']);
  failedAsBefore(a, 'quickset', [timedOut, built]);
  failedAsBefore(b, 'quickset', [timedOut, built]);
  assert.deepEqual(planRepair([b.id]).jobs.map((x) => x.jobId), [b.id]);
});
