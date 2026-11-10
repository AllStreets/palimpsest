/**
 * The daily report (Task 18): prose and tables he reads, written to
 * `paths().reports/<day>.md` from the ledger and the credits rows. Temp
 * home only; no model, no gh.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { charge } from '../engine/market/budget.js';
import { hire, seedFirms } from '../engine/market/firms.js';
import { postManualJob, proposeHarnessJob, transition } from '../engine/market/jobs.js';
import { latestReport, writeDailyReport } from '../engine/market/report.js';
import { haltRepo } from '../engine/market/runs.js';
import { installTreasury } from '../engine/market/treasury.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Bid, Job, Repo, Run } from '../shared/types.js';
import { checks, FULL, setUp, tearDown } from './guild-fixtures.js';

let off: () => void = () => {};
beforeEach(() => {
  setUp('report');
  off = installTreasury();
});
afterEach(async () => {
  off();
  await tearDown();
});

function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addRepo(full: string): Repo {
  const repo: Repo = {
    fullName: full,
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
    checks: checks(),
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

function bidOn(j: Job, firmId: string, agentId: string, price: number): Bid {
  const bid: Bid = { id: `bid-${j.id}`, jobId: j.id, firmId, agentId, plan: 'Read, change, test.', price, confidence: 0.8, calibrated: 0.68, appraisal: null, ev: 10, cost: 2, at: new Date().toISOString() };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, bid.jobId, JSON.stringify({ round: 'r', bid }));
  record('bid.placed', { bid, calls: 1, charged: { kind: 'bid', credits: 2, by: 'budget' } });
  record('job.awarded', { jobId: j.id, tier: j.tier, considered: [bid], satOut: [], chosen: bid, why: 'test', at: new Date().toISOString(), coolOffUntil: null });
  return bid;
}

function waitingRun(j: Job, agentId: string, firmId: string, pr: number): Run {
  const r: Run = {
    id: `run-${j.id}`,
    jobId: j.id,
    bidId: `bid-${j.id}`,
    agentId,
    firmId,
    repo: j.repo,
    model: 'claude:sonnet',
    branch: `palimpsest/${j.id}`,
    dir: null,
    baseSha: null,
    headSha: 'b'.repeat(40),
    stage: 'waiting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 1, testsRun: 0, turns: 3, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: new Date().toISOString(),
    endedAt: null,
    prNumber: pr,
    prUrl: `https://github.com/${j.repo}/pull/${pr}`,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    summary: 'Changed it.',
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  record('run.started', { runId: r.id, jobId: j.id, run: r });
  return r;
}

test('the daily report lists the day\'s merges and spend and says what waits on him, including a proposed harness job', () => {
  seedFirms([]);
  const repo = addRepo(FULL);
  addRepo('acme/gears');

  // A job merged today, won by Quickset.
  let merged = postManualJob({ repo: FULL, title: 'Fix the header', body: 'Change `src/header.ts`.', tier: 'normal' });
  merged = transition(merged, 'bidding');
  const bid = bidOn(merged, 'quickset', 'ola-bergstrom', 24);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'] as const) merged = transition(merged, to, to === 'awarded' ? { awardedBid: bid.id } : {});
  record('merge.detected', { jobId: merged.id, runId: 'run-x', repo: FULL, pr: 9, prUrl: `https://github.com/${FULL}/pull/9`, mergeSha: 'c'.repeat(40), size: 'small', withHisChanges: false, at: new Date().toISOString() });

  // A job that failed, and why.
  let failed = postManualJob({ repo: FULL, title: 'Rename the gears', body: 'Rename.', tier: 'low' });
  failed = transition(transition(transition(transition(failed, 'bidding'), 'awarded'), 'running'), 'inspecting');
  record('run.ended', { runId: 'run-f', jobId: failed.id, outcome: 'failed', reason: 'The change failed inspection.', summary: null, run: { id: 'run-f', jobId: failed.id } });
  transition(failed, 'failed');

  // A job waiting on its PR.
  let open = postManualJob({ repo: 'acme/gears', title: 'Tidy the gear table', body: 'Tidy.', tier: 'normal' });
  open = transition(open, 'bidding');
  bidOn(open, 'ashlar-vane', 'ines-ashlar', 30);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) open = transition(open, to);
  waitingRun(open, 'ines-ashlar', 'ashlar-vane', 41);

  // Spend: model calls by firm and model, an API call in dollars.
  charge({ runId: null, firmId: 'quickset', model: 'claude:sonnet', kind: 'bid', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 3 });
  charge({ runId: 'run-x', firmId: 'quickset', model: 'claude:sonnet', kind: 'run', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 18.5 });
  charge({ runId: 'run-y', firmId: 'ashlar-vane', model: 'anthropic:claude-haiku-4-5', kind: 'run', usage: { weightedTokens: 0, seconds: 0, usd: 0.42, credits: 8.4 }, unattended: false });
  hire('kiln');

  // His brief: a proposed harness job, a halt, and the notes the city wrote for him.
  const harness = proposeHarnessJob(repo);
  haltRepo('acme/gears', 'A city merge was reverted: Tidy the gear table');
  record('run.note', { runId: 'run-n', jobId: merged.id, repo: FULL, note: 'merged with his changes: 1 commit of his on top of bbbbbbb', at: new Date().toISOString() });
  record('run.note', { runId: 'run-m', jobId: 'job-m', repo: FULL, note: 'merged after Kiln Brothers went bankrupt: nobody was paid 40 credits (the firm is dissolved)', unpaid: 40, at: new Date().toISOString() });
  record('run.note', { runId: 'run-r', jobId: 'job-r', repo: FULL, note: 'needs a reviewer: the third inspection in a row could not reach a verdict', inconclusive: 3, at: new Date().toISOString() });
  record('run.note', { runId: 'run-l', note: 'login refresh host refused: auth.example.com' });
  record('run.note', { runId: 'run-p', jobId: 'job-p', repo: FULL, note: `merge ${'d'.repeat(40)} recorded for push mode`, mergeSha: 'd'.repeat(40), at: new Date().toISOString() });

  const day = localDay();
  const md = writeDailyReport(day);
  const file = join(paths().reports, `${day}.md`);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), md);

  // The day's work.
  assert.match(md, /Fix the header/);
  assert.match(md, /merged/i);
  assert.match(md, /Rename the gears/);
  assert.match(md, /failed inspection/i, 'a failure says why');
  // The spend, by firm and by model, against the caps.
  assert.match(md, /Quickset/);
  assert.match(md, /21\.5/, "Quickset's model spend today");
  assert.match(md, /claude:sonnet/);
  assert.match(md, /cap/i);
  assert.match(md, /\$0\.42/, 'API dollars');
  assert.match(md, /assumed|measured/, 'the calibration');
  assert.match(md, /hired/i);
  // What waits on him.
  const waits = md.slice(md.indexOf('## Waiting on you'));
  assert.ok(md.includes('## Waiting on you'), md);
  assert.match(waits, new RegExp(harness.title));
  assert.match(waits, /#41/);
  assert.match(waits, /acme\/gears is halted/);
  assert.match(waits, /merged with his changes/);
  assert.match(waits, /nobody was paid 40 credits/);
  assert.match(waits, /needs a reviewer/);
  assert.match(waits, /login refresh host refused/);
  assert.doesNotMatch(md, /recorded for push mode/, 'bookkeeping notes are not his');
  // Plain and in his style.
  assert.doesNotMatch(md, /\u2014|\u2013|--/);
  assert.doesNotMatch(md, /\p{Extended_Pictographic}/u);

  const written = entries().filter((e) => e.kind === 'report.written');
  assert.equal(written.length, 1);
  assert.equal((written[0].data as { day: string }).day, day);

  const latest = latestReport();
  assert.ok(latest);
  assert.equal(latest.day, day);
  assert.equal(latest.markdown, md);
  assert.equal(latest.data.jobs.merged.length, 1);
  assert.equal(latest.data.waiting.proposed[0].id, harness.id);
});

test('a quiet day says so plainly and latestReport is null before any report', () => {
  assert.equal(latestReport(), null);
  const md = writeDailyReport('2026-11-01');
  assert.match(md, /Nothing waits on you\./);
  assert.match(md, /No jobs were posted/);
  assert.doesNotMatch(md, /\u2014|--/);
});
