/**
 * The nets' rows from the ledger (Phase 4 Task 8, ruling 8) and why a net
 * has none (ruling 29). Temp home only; every job, run and bid is written
 * straight into the temp database, and every time is relative to `now`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { query, record } from '../engine/ledger.js';
import { REPUTATION_KINDS, reputation } from '../engine/market/reputation.js';
import { labelCounts, rowsFor, standingsBefore, thinCause } from '../engine/school/datasets.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import { FEATURES } from '../shared/net-features.js';
import type { Agent, Bid, Inspection, Job, NetName, Repo, Run } from '../shared/types.js';

const DAY = 24 * 60 * 60 * 1000;
const FULL = 'acme/widgets';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-school-datasets-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

function putRepo(over: Partial<Repo> = {}): Repo {
  const r: Repo = {
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
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(r.fullName, JSON.stringify(r));
  return r;
}

function putJob(id: string, over: Partial<Job> = {}): Job {
  const j: Job = {
    id,
    repo: FULL,
    source: 'manual',
    issue: null,
    url: null,
    title: `Job ${id}`,
    body: '',
    scope: ['src/**'],
    acceptance: ['it works', 'the tests pass'],
    tier: 'normal',
    value: 40,
    status: 'merged',
    attempts: 1,
    postedAt: '2026-11-01T00:00:00.000Z',
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

function putAgent(id: string, firmId: string): Agent {
  const a: Agent = {
    id,
    firmId,
    name: id,
    model: 'claude:sonnet',
    persona: '',
    temperament: '',
    instructions: '',
    tools: [],
    workflow: { shape: 'single' },
    memory: { examples: 0 },
    lineage: { origin: 'seeded', parents: [], generation: 0, at: '2026-11-01T00:00:00.000Z' },
    silhouette: 'plain',
    maxTurns: 30,
    capability: 'glass',
    bidsOn: ['low', 'normal', 'high'],
    retired: false,
    retiredReason: null,
    towerIndex: 0,
  };
  openDb().prepare('INSERT OR REPLACE INTO agents (id, firm_id, json) VALUES (?, ?, ?)').run(a.id, a.firmId, JSON.stringify(a));
  return a;
}

function makeBid(id: string, jobId: string, firmId: string, agentId: string, over: Partial<Bid> = {}): Bid {
  const b: Bid = { id, jobId, firmId, agentId, plan: 'Read the test, fix the parser, add a case.', price: 20, confidence: 0.8, calibrated: 0.8, appraisal: null, ev: 10, cost: 1, at: '2026-11-02T00:00:00.000Z', ...over };
  openDb().prepare('INSERT OR REPLACE INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(b.id, jobId, JSON.stringify({ round: 'r1', bid: b }));
  return b;
}

function putRun(id: string, jobId: string, bid: Bid, over: Partial<Run> = {}): Run {
  const r: Run = {
    id,
    jobId,
    bidId: bid.id,
    agentId: bid.agentId,
    firmId: bid.firmId,
    repo: FULL,
    model: 'claude:sonnet',
    branch: `palimpsest/${jobId}`,
    dir: null,
    baseSha: null,
    headSha: null,
    stage: 'done',
    outcome: 'merged',
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 2, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: '2026-11-02T01:00:00.000Z',
    endedAt: '2026-11-02T02:00:00.000Z',
    prNumber: 7,
    prUrl: null,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  return r;
}

function charge(runId: string, amount: number): void {
  openDb()
    .prepare('INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('2026-11-02T01:30:00.000Z', null, runId, 'run', amount, null, JSON.stringify({ model: 'claude:sonnet', unattended: false }));
}

function col(net: NetName, name: string): number {
  const i = FEATURES[net].indexOf(name);
  assert.ok(i >= 0, `no column ${name} in ${net}`);
  return i;
}

const NOW = Date.parse('2026-11-12T12:00:00.000Z');

test('an awarded bid whose run passed is one appraiser row with pass 1 and log1p of its credits', () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  putJob('job-1');
  const b = makeBid('bid-1', 'job-1', 'ashlar', 'ines');
  record('job.awarded', { jobId: 'job-1', tier: 'normal', considered: [b], satOut: [], chosen: b, why: '' });
  putRun('run-1', 'job-1', b);
  charge('run-1', 2);
  charge('run-1', 3);
  record('merge.detected', { jobId: 'job-1', runId: 'run-1', repo: FULL, size: 'medium' });

  const pass = rowsFor('appraiser-pass', NOW);
  assert.equal(pass.length, 1);
  assert.equal(pass[0].id, 'bid-1');
  assert.equal(pass[0].y, 1);
  assert.equal(pass[0].weight, 1);
  assert.equal(pass[0].source, 'real');
  assert.equal(pass[0].x.length, FEATURES['appraiser-pass'].length);
  assert.equal(pass[0].x[col('appraiser-pass', 'confidence')], 0.8);
  assert.equal(pass[0].x[col('appraiser-pass', 'tier=normal')], 1);

  const cost = rowsFor('appraiser-cost', NOW);
  assert.equal(cost.length, 1);
  assert.equal(cost[0].y, Math.log1p(5));

  const router = rowsFor('router', NOW);
  assert.equal(router.length, 1);
  assert.equal(router[0].y, 1);
  assert.equal(router[0].x.length, FEATURES.router.length);
  assert.equal(labelCounts(NOW)['appraiser-pass'], 1);
});

test('an unawarded bid is never a row', () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  putAgent('mack', 'quickset');
  putJob('job-1');
  const won = makeBid('bid-won', 'job-1', 'ashlar', 'ines');
  const lost = makeBid('bid-lost', 'job-1', 'quickset', 'mack', { price: 30 });
  record('job.awarded', { jobId: 'job-1', tier: 'normal', considered: [won, lost], satOut: [], chosen: won, why: '' });
  // A run under a bid that no award ever chose (a stray row) is no label either.
  putRun('run-stray', 'job-1', lost, { outcome: 'failed' });
  putJob('job-2');
  makeBid('bid-alone', 'job-2', 'quickset', 'mack');

  assert.deepEqual(rowsFor('appraiser-pass', NOW), []);
  assert.deepEqual(rowsFor('router', NOW), []);
});

test("the firm's pass rate in a row is the one before the award", () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  const award = (jobId: string) => {
    putJob(jobId);
    const b = makeBid(`bid-${jobId}`, jobId, 'ashlar', 'ines');
    record('job.awarded', { jobId, tier: 'normal', considered: [b], satOut: [], chosen: b, why: '' });
    return b;
  };
  award('job-a');
  record('merge.detected', { jobId: 'job-a', runId: 'run-a', size: 'medium' });
  award('job-b');
  record('floor.scarred', { jobId: 'job-b', runId: 'run-b', size: 'medium' });
  const c = award('job-c');
  putRun('run-c', 'job-c', c);
  record('merge.detected', { jobId: 'job-c', runId: 'run-c', size: 'medium' });
  award('job-d');
  record('merge.detected', { jobId: 'job-d', runId: 'run-d', size: 'medium' });

  assert.equal(reputation('ashlar').passRateAll, 0.75);
  const rows = rowsFor('appraiser-pass', NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].x[col('appraiser-pass', 'firm_pass_rate')], 0.5);
  assert.equal(rows[0].x[col('appraiser-pass', 'has_firm_pass_rate')], 1);
  // Brier as of the award: two outcomes at confidence 0.8, one pass and one fail.
  assert.equal(Math.round(rows[0].x[col('appraiser-pass', 'firm_brier')] * 1e6) / 1e6, 0.34);
});

test('a merge 10 days old with no revert is not a durability row; at 31 days it is; a revert at day 3 makes it survived 0', () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  const t0 = Date.parse('2026-10-01T12:00:00.000Z');
  putJob('job-1');
  const b = makeBid('bid-1', 'job-1', 'ashlar', 'ines');
  putRun('run-1', 'job-1', b, { endedAt: iso(t0) });
  record('merge.detected', { jobId: 'job-1', runId: 'run-1', repo: FULL, mergedAt: iso(t0), at: iso(t0) });

  assert.deepEqual(rowsFor('durability', t0 + 10 * DAY), []);
  const later = rowsFor('durability', t0 + 31 * DAY);
  assert.equal(later.length, 1);
  assert.equal(later[0].y, 1);
  assert.equal(later[0].id, 'run-1');

  record('merge.reverted', { jobId: 'job-1', runId: 'run-1', repo: FULL, floorId: 'f', mergeSha: 'a'.repeat(40), revertSha: 'b'.repeat(40), at: iso(t0 + 3 * DAY) });
  const early = rowsFor('durability', t0 + 10 * DAY);
  assert.equal(early.length, 1);
  assert.equal(early[0].y, 0);
  assert.equal(rowsFor('durability', t0 + 31 * DAY)[0].y, 0);
  // Before the revert happened, the merge was still young.
  assert.deepEqual(rowsFor('durability', t0 + 2 * DAY), []);
});

test('a finished brief day with three items and one accepted gives three triage rows', () => {
  putRepo({ market: true });
  putJob('job-p', { source: 'proposal', status: 'open', tier: 'low', postedAt: '2026-11-09T20:00:00.000Z' });
  const day = '2026-11-10';
  const items = ['proposal:job-p', 'usage', `halt:${FULL}`];
  record('brief.opened', { day, since: '2026-11-09T06:40:00.000Z', items, at: '2026-11-10T06:40:00.000Z' });
  record('brief.action', { day, itemId: 'proposal:job-p', kind: 'proposal', action: 'accept', taught: true, at: '2026-11-10T06:41:00.000Z', patch: {} });
  record('brief.action', { day, itemId: 'usage', kind: 'usage', action: 'dismiss', taught: true, at: '2026-11-10T06:42:00.000Z', patch: {} });
  // Today's brief is not finished, so its items are not rows yet.
  record('brief.opened', { day: '2026-11-12', since: '2026-11-10T06:40:00.000Z', items: ['usage'], at: iso(NOW - 60_000) });

  const rows = rowsFor('triage', NOW);
  assert.equal(rows.length, 3);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(`${day}:proposal:job-p`)?.y, 1);
  assert.equal(byId.get(`${day}:usage`)?.y, 0);
  assert.equal(byId.get(`${day}:halt:${FULL}`)?.y, 0);
  const p = byId.get(`${day}:proposal:job-p`)!;
  assert.equal(p.x[col('triage', 'kind=proposal')], 1);
  assert.equal(p.x[col('triage', 'tier=low')], 1);
  assert.equal(p.x[col('triage', 'position')], 0);
  assert.equal(byId.get(`${day}:halt:${FULL}`)!.x[col('triage', 'position')], 2);
});

test('a UI inspection whose PR he closed gives a taste row with approved 0', () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  putJob('job-ui', { status: 'closed' });
  const b = makeBid('bid-ui', 'job-ui', 'ashlar', 'ines');
  putRun('run-ui', 'job-ui', b, { outcome: 'closed', endedReason: 'The PR was closed without a merge.', inspectionId: 'insp-ui' });
  const inspection: Inspection = {
    id: 'insp-ui',
    runId: 'run-ui',
    jobId: 'job-ui',
    repo: FULL,
    reviewerAgentId: null,
    reviewerFirmId: null,
    checks: [],
    passed: true,
    pushable: true,
    design: { before: 6, after: 7.5, diffOnly: false, shots: [{ route: '/', before: null, after: null }, { route: '/about', before: null, after: null }] },
    cost: 0,
    at: '2026-11-02T01:50:00.000Z',
  };
  record('inspection.done', { inspectionId: inspection.id, runId: 'run-ui', jobId: 'job-ui', repo: FULL, passed: true, pushable: true, inspection });
  // An inspection without the design never makes a taste row.
  putJob('job-plain', { status: 'merged' });
  const b2 = makeBid('bid-plain', 'job-plain', 'ashlar', 'ines');
  putRun('run-plain', 'job-plain', b2);
  record('inspection.done', { inspectionId: 'insp-plain', runId: 'run-plain', jobId: 'job-plain', repo: FULL, passed: true, inspection: { ...inspection, id: 'insp-plain', runId: 'run-plain', jobId: 'job-plain', design: null } });

  const rows = rowsFor('taste', NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].y, 0);
  assert.equal(rows[0].x[col('taste', 'after')], 7.5);
  assert.equal(rows[0].x[col('taste', 'before')], 6);
  assert.equal(rows[0].x[col('taste', 'difference')], 1.5);
  assert.equal(rows[0].x[col('taste', 'shots')], 2);

  // An answered Understudy pair, injected, is one more row.
  const pairs = () => [{ id: 'pair-1', at: '2026-11-03T00:00:00.000Z', pick: 'a' as const, scores: { a: 8, b: 5 } }];
  const withPairs = rowsFor('taste', NOW, { understudyPairs: pairs });
  assert.equal(withPairs.length, 2);
  assert.equal(withPairs.find((r) => r.id === 'pair:pair-1')?.y, 1);
});

test('on an empty ledger with every market off thinCause for the appraiser says the market is off on every repo', () => {
  putRepo({ market: false });
  assert.equal(thinCause('appraiser-pass', NOW), 'No bid has been run: the market is off on every repo');
  assert.equal(thinCause('router', NOW), 'No bid has been run: the market is off on every repo');
  assert.equal(thinCause('durability', NOW), 'No city merge has had 30 days yet');
  assert.equal(thinCause('triage', NOW), '0 finished brief days so far');
  assert.equal(thinCause('taste', NOW, { understudyCounts: () => ({ statements: 37, pairs: 4, answered: 0, unreadable: null }) }), 'No UI change has been inspected yet; Understudy has 37 statements and 0 answered pairs');
  assert.equal(thinCause('taste', NOW, { understudyCounts: () => ({ statements: 0, pairs: 0, answered: 0, unreadable: 'no such table: statements' }) }), 'No UI change has been inspected yet; Understudy could not be read: no such table: statements');
  assert.equal(thinCause('master', NOW), 'None of your decisions has had a prediction yet');
  putRepo({ market: true });
  assert.equal(thinCause('appraiser-pass', NOW), '0 of 40 awarded runs ended');
  for (const n of Object.values(labelCounts(NOW))) assert.equal(n, 0);
});

test("the incremental firm standing equals reputation() on the ledger before each award, on a mixed ledger", () => {
  const firms = ['ashlar', 'quickset', 'meridian'];
  const awards: Array<{ id: number; firmId: string }> = [];
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const firmId = firms[i % 3];
    const jobId = `job-${i % 25}`;
    const b: Bid = { id: `bid-${n++}`, jobId, firmId, agentId: 'a', plan: '', price: 10, confidence: ((i * 7) % 10) / 10, calibrated: 0.5, appraisal: null, ev: 1, cost: 1, at: '2026-11-02T00:00:00.000Z' };
    awards.push({ id: record('job.awarded', { jobId, chosen: b }), firmId });
    switch (i % 5) {
      case 0:
        record('merge.detected', { jobId, runId: `run-${i}` });
        break;
      case 1:
        record('floor.scarred', { jobId, runId: `run-${i}` });
        break;
      case 2:
        record('run.ended', { runId: `run-${i}`, jobId, outcome: i % 2 ? 'failed' : 'merged', run: { jobId, outcome: i % 2 ? 'failed' : 'merged' } });
        break;
      case 3:
        record('merge.reverted', { jobId, runId: `run-${i}` });
        break;
      default:
        break;
    }
  }
  const all = query({ kind: REPUTATION_KINDS });
  const got = standingsBefore(awards, all);
  for (const a of awards) {
    const want = reputation(a.firmId, all.filter((e) => e.id < a.id));
    assert.deepEqual(got.get(a.id), { passRate: want.passRateAll, brier: want.brier }, `award ${a.id}`);
  }
});

test('two thousand runs build their appraiser rows in under a second', () => {
  putRepo({ market: true });
  putAgent('ines', 'ashlar');
  const db = openDb();
  db.exec('BEGIN');
  for (let i = 0; i < 2000; i++) {
    const jobId = `job-${i}`;
    putJob(jobId);
    const b = makeBid(`bid-${i}`, jobId, 'ashlar', 'ines', { confidence: 0.6 });
    record('job.awarded', { jobId, tier: 'normal', chosen: b });
    putRun(`run-${i}`, jobId, b, { outcome: i % 3 ? 'merged' : 'failed' });
    record(i % 3 ? 'merge.detected' : 'floor.scarred', { jobId, runId: `run-${i}` });
  }
  db.exec('COMMIT');
  const t = performance.now();
  const rows = rowsFor('appraiser-pass', NOW);
  const took = performance.now() - t;
  assert.equal(rows.length, 2000);
  assert.ok(took < 1000, `took ${Math.round(took)} ms`);
  // Built once: a second read at the same moment, and labelCounts and thinCause, reuse the rows.
  const t2 = performance.now();
  assert.equal(rowsFor('appraiser-pass', NOW).length, 2000);
  const again = performance.now() - t2;
  assert.ok(again < took / 2, `the second read took ${Math.round(again)} ms of ${Math.round(took)}`);
  assert.equal(labelCounts(NOW)['appraiser-pass'], 2000);
  assert.equal(thinCause('router', NOW), '2000 of 40 awarded runs ended');
});
