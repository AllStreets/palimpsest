/**
 * A firm's story as its page reads it (Task 38): the books as a running
 * balance from the ledger's credits.moved, every round it bid in (won, or
 * lost with the EV that lost it), its reputation over time, and its hires,
 * purchases and sales.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { record } from '../engine/ledger.js';
import { firmBooks, firmDeals, firmRounds } from '../engine/market/firm-story.js';
import { seedFirms } from '../engine/market/firms.js';
import { reputation, reputationLine } from '../engine/market/reputation.js';
import { START_BALANCE } from '../shared/market-rules.js';
import type { Bid, Job } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-firm-story-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  seedFirms(['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b', 'qwen3:1.7b']);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function bid(jobId: string, firmId: string, agentId: string, ev: number, confidence = 0.8): Bid {
  return { id: `bid-${jobId}-${firmId}`, jobId, firmId, agentId, plan: 'plan', price: 20, confidence, calibrated: confidence, appraisal: null, ev, cost: 1, at: '2026-11-10T09:00:00.000Z' };
}

function job(id: string, title: string): Job {
  const j: Job = {
    id,
    repo: 'acme/widgets',
    source: 'manual',
    issue: null,
    url: null,
    title,
    body: '',
    scope: [],
    acceptance: [],
    tier: 'normal',
    value: 60,
    status: 'merged',
    attempts: 1,
    postedAt: '2026-11-10T08:00:00.000Z',
    bidsCloseAt: null,
    awardedBid: null,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
  };
  openDb().prepare('INSERT INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)').run(j.id, j.repo, j.status, JSON.stringify(j));
  return j;
}

function moved(firmId: string, kind: string, delta: number, extra: Record<string, unknown> = {}): void {
  record('credits.moved', { kind, firmId, from: delta < 0 ? firmId : 'city', to: delta < 0 ? 'spent' : firmId, amount: Math.abs(delta), delta, rowIds: [], runId: null, jobId: null, inspectionId: null, agentId: null, at: new Date().toISOString(), ...extra });
}

test('the books run from the seeded balance through every movement, in micro-credits', () => {
  job('job-1', 'Fix the parser');
  moved('quickset', 'bid', -0.1);
  moved('quickset', 'bid', -0.2);
  moved('quickset', 'pay', 31.5, { jobId: 'job-1' });
  moved('ashlar-vane', 'pay', 99);
  moved('quickset', 'hire', -80, { agentId: 'dagny-hollis' });
  const books = firmBooks('quickset');
  assert.equal(books.opening, START_BALANCE, 'it opened with its seeded balance');
  assert.equal(books.truncated, false);
  const rows = books.rows;
  assert.deepEqual(rows.map((r) => r.kind), ['bid', 'bid', 'pay', 'hire']);
  assert.deepEqual(rows.map((r) => r.delta), [-0.1, -0.2, 31.5, -80]);
  assert.equal(rows[1].balance, START_BALANCE - 0.3, '0.1 + 0.2 is 0.3 on these books');
  assert.equal(rows.at(-1)!.balance, START_BALANCE - 0.3 + 31.5 - 80);
  assert.equal(rows[2].jobId, 'job-1');
  assert.equal(rows[2].title, 'Fix the parser', 'a movement for a job carries its title');
  assert.equal(rows[3].agentId, 'dagny-hollis');
});

test('the rounds a firm bid in: won, or lost with its EV and the winner it lost to', () => {
  job('job-a', 'Fix the parser');
  job('job-b', 'Add a CSV export');
  job('job-c', 'Nobody wanted this');
  const winA = bid('job-a', 'quickset', 'mack-quickset', 9);
  record('job.awarded', { jobId: 'job-a', tier: 'normal', considered: [winA, bid('job-a', 'kiln', 'oskar-kiln', 4)], satOut: [], chosen: winA, why: '' });
  const winB = bid('job-b', 'kiln', 'oskar-kiln', 12);
  record('job.awarded', { jobId: 'job-b', tier: 'normal', considered: [winB, bid('job-b', 'quickset', 'priya-rao', 6.5), { ...bid('job-b', 'quickset', 'mack-quickset', 3), id: 'b2' }], satOut: [], chosen: winB, why: '' });
  record('job.awarded', { jobId: 'job-c', tier: 'normal', considered: [bid('job-c', 'quickset', 'priya-rao', -2)], satOut: [], chosen: null, why: '' });
  record('job.awarded', { jobId: 'job-c', tier: 'normal', considered: [bid('job-c', 'sparrow', 'wren-sparrow', 2)], satOut: [], chosen: null, why: '' });

  const rounds = firmRounds('quickset');
  assert.deepEqual(rounds.map((r) => [r.jobId, r.won]), [['job-a', true], ['job-b', false], ['job-c', false]]);
  assert.equal(rounds[0].title, 'Fix the parser');
  assert.equal(rounds[1].bid.agentId, 'priya-rao', 'the firm’s best bid of the round stands for it');
  assert.equal(rounds[1].bid.ev, 6.5);
  assert.equal(rounds[1].winner?.firmId, 'kiln');
  assert.equal(rounds[1].winner?.ev, 12);
  assert.equal(rounds[2].winner, null, 'a round nobody won');
  assert.deepEqual(firmRounds('meridian'), [], 'a firm that never bid has no rounds');
});

test('reputation over time: a point per resolved bid, ending at the firm’s reputation now', () => {
  const a = bid('job-1', 'quickset', 'mack-quickset', 5, 0.8);
  record('job.awarded', { jobId: 'job-1', tier: 'normal', chosen: a });
  record('merge.detected', { jobId: 'job-1' });
  const b = bid('job-2', 'quickset', 'mack-quickset', 5, 0.9);
  record('job.awarded', { jobId: 'job-2', tier: 'normal', chosen: b });
  record('run.ended', { run: { jobId: 'job-2', outcome: 'failed' } });
  record('merge.reverted', { jobId: 'job-1' });

  const line = reputationLine('quickset');
  assert.equal(line.length, 3, 'two resolutions and a revert');
  assert.deepEqual(line.map((p) => p.event), ['pass', 'fail', 'revert']);
  assert.equal(line[0].passRate, 1);
  assert.equal(line[0].durability, 1);
  assert.equal(line[1].passRate, 0.5);
  assert.equal(line[1].durability, 1, 'the merge still stood after the second resolution');
  assert.equal(line[2].durability, 0, 'the revert takes durability down when it lands');
  const now = reputation('quickset');
  assert.equal(line.at(-1)!.score, now.score);
  assert.equal(line.at(-1)!.calibration, 1 - now.brier!);
  assert.ok(line.every((p) => typeof p.at === 'string' && p.at.length > 0));
  assert.deepEqual(reputationLine('meridian'), []);
});

test('a firm’s deals: the specialists it hired, the towers it bought and the towers sold from it', () => {
  record('agent.hired', { agent: { id: 'dagny-hollis', firmId: 'quickset', name: 'Dagny Hollis' } });
  // A hire whose event names its fee is priced at it.
  record('agent.hired', { agent: { id: 'sabine-okoro', firmId: 'kiln', name: 'Sabine Okoro' }, fee: 95 });
  assert.deepEqual(firmDeals('kiln').map((d) => d.price), [95]);
  record('tower.sold', { from: 'kiln', to: 'quickset', price: 34, agentId: 'oskar-kiln' });
  moved('quickset', 'hire', -80, { agentId: 'dagny-hollis' });
  const q = firmDeals('quickset');
  assert.deepEqual(q.map((d) => [d.kind, d.agentId, d.other, d.price]), [
    ['hired', 'dagny-hollis', null, 80],
    ['bought', 'oskar-kiln', 'kiln', 34],
  ]);
  const k = firmDeals('kiln').filter((d) => d.kind !== 'hired');
  assert.deepEqual(k.map((d) => [d.kind, d.agentId, d.other, d.price]), [['sold', 'oskar-kiln', 'quickset', 34]]);
});

test('a firm with a long history returns capped payloads, newest kept, the balance still exact', () => {
  for (let i = 0; i < 1200; i++) moved('quickset', 'bid', -0.01);
  for (let i = 0; i < 30; i++) moved('kiln', 'bid', -1);
  const books = firmBooks('quickset', 1000);
  assert.equal(books.rows.length, 1000);
  assert.equal(books.truncated, true);
  assert.equal(books.opening, START_BALANCE);
  assert.equal(books.rows.at(-1)!.balance, START_BALANCE - 12, 'the last balance counts every movement, kept or not');
  assert.equal(Math.round((books.rows[0].balance - books.rows[0].delta) * 100) / 100, START_BALANCE - 2, 'the first row kept starts where the dropped ones left it');

  for (let i = 0; i < 450; i++) {
    const b = bid(`job-${i}`, 'quickset', 'mack-quickset', 5);
    record('job.awarded', { jobId: `job-${i}`, tier: 'normal', considered: [b], satOut: [], chosen: b, why: '' });
    record('merge.detected', { jobId: `job-${i}` });
  }
  const rounds = firmRounds('quickset', 400);
  assert.equal(rounds.length, 400);
  assert.equal(rounds.at(-1)!.jobId, 'job-449', 'the newest rounds are kept, oldest first');
  assert.equal(rounds[0].jobId, 'job-50');
  const line = reputationLine('quickset');
  assert.equal(line.length, 300, 'the reputation line keeps its newest 300 points');
  assert.equal(line.at(-1)!.samples, 450, 'and still counts every resolved bid');
  assert.equal(line.at(-1)!.score, reputation('quickset').score);
});

test('charges written but not yet settled close the books as one pending line, so they end at the treasury’s balance', () => {
  moved('quickset', 'pay', 10);
  // A run's cost is charged at call time and settled into the ledger later.
  openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'quickset', 'run-x', 'run', 3.25, NULL, '{}')").run(new Date().toISOString());
  const rows = firmBooks('quickset').rows;
  assert.equal(rows.at(-1)!.kind, 'pending');
  assert.equal(rows.at(-1)!.delta, -3.25);
  assert.equal(rows.at(-1)!.balance, START_BALANCE + 10 - 3.25);
  // Settled books have no pending line.
  assert.ok(!firmBooks('kiln').rows.some((r) => r.kind === 'pending'));
});

test('a charge stays pending until its own row is settled, even when a later row was booked first', () => {
  const ins = openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'quickset', ?, ?, ?, NULL, '{}')");
  ins.run(new Date().toISOString(), 'run-a', 'run', 4);
  const later = Number(ins.run(new Date().toISOString(), null, 'pay', 20).lastInsertRowid);
  moved('quickset', 'pay', 20, { rowIds: [later] });
  const rows = firmBooks('quickset').rows;
  assert.equal(rows.at(-1)!.kind, 'pending', 'the run’s cost is not in the ledger yet');
  assert.equal(rows.at(-1)!.balance, START_BALANCE + 20 - 4);
});
