/**
 * The one-time restatement (tools/restate-economy.ts) of the week's books
 * under the economy change of Nov 19, on records written as the old engine
 * wrote them, in a temp home; nothing touches his data home.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { entries, record } from '../engine/ledger.js';
import { charge } from '../engine/market/budget.js';
import { firm } from '../engine/market/firms.js';
import { balances, installTreasury, refunded, replayBalances } from '../engine/market/treasury.js';
import type { ModelRef } from '../shared/types.js';
import { applyRestatement, main, planRestatement } from '../tools/restate-economy.js';
import { addAgent, addFirm, HOUR, MIN, setUp, tearDown } from './guild-fixtures.js';

const NOW = Date.parse('2026-11-19T20:00:00.000Z');
const T0 = NOW - 2 * 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();

let savedPort: string | undefined;
beforeEach(() => {
  setUp('restate');
  savedPort = process.env.PALIMPSEST_PORT;
});
afterEach(async () => {
  if (savedPort === undefined) delete process.env.PALIMPSEST_PORT;
  else process.env.PALIMPSEST_PORT = savedPort;
  await tearDown();
});

/** A credits row charged as bids.ts and runs.ts charge them, at `t`. */
function spend(firmId: string, model: ModelRef, kind: 'bid' | 'run', amount: number, t: number, runId: string | null = null): void {
  charge({ runId, firmId, model, kind, usage: { weightedTokens: 0, seconds: 1, usd: 0, credits: amount }, unattended: false, at: t, minCredits: amount });
}

let nBid = 0;
/** A bid as the old engine stored and charged it: its row in `bids`, its `bid.placed` and its credits row. */
function oldBid(jobId: string, firmId: string, agentId: string, model: ModelRef, close: number, cost = 3, calls = 1): void {
  const id = `bid-${nBid++}`;
  const bid = { id, jobId, firmId, agentId, plan: 'p', price: 10, confidence: 0.5, calibrated: 0.4, appraisal: null, ev: -1, cost, at: iso(close - MIN) };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(id, jobId, JSON.stringify({ round: iso(close), bid }));
  record('bid.placed', { bid, calls, charged: { kind: 'bid', credits: cost, by: 'budget' } });
  spend(firmId, model, 'bid', cost, close - MIN);
}

function round(jobId: string, close: number, chosen: { id: string } | null = null): void {
  record('job.awarded', { jobId, tier: 'normal', considered: [], satOut: [], chosen, why: 'x', at: iso(close), coolOffUntil: chosen ? null : iso(close + 10 * MIN) });
}

function endedRun(id: string, firmId: string, outcome: string, scar: boolean, t: number): void {
  const r = { id, jobId: `job-${id}`, bidId: 'b', agentId: 'mack', firmId, repo: 'acme/widgets', model: 'claude:haiku', branch: 'b', dir: null, baseSha: null, headSha: null, stage: 'done', outcome, endedReason: 'x', progress: {}, startedAt: iso(t), endedAt: iso(t), prNumber: null, prUrl: null, mergeSha: null, inspectionId: null, scar, unattended: false, summary: null };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(id, r.jobId, r.repo, r.stage, JSON.stringify(r));
}

/**
 * A week as the old rules booked it. Job J had five empty rounds ten minutes
 * apart: under cooling off only the 1st, 2nd and 4th would have happened.
 * Ashlar (Claude) and Kiln (local) bid 3 on each. Quickset's run crashed on
 * the engine (12 back); its scarred run keeps its 5. A bid from 9 days ago
 * is outside the window.
 */
function oldWeek(): void {
  addFirm('ashlar', { balance: 300 });
  addFirm('kiln', { balance: 300 });
  addFirm('quickset', { balance: 300 });
  for (const f of ['ashlar', 'kiln', 'quickset']) record('firm.seeded', { firm: firm(f) });
  addAgent('ines', 'ashlar', 'claude:sonnet');
  addAgent('bruno', 'kiln', 'ollama:gpt-oss:20b');
  addAgent('mack', 'quickset', 'claude:haiku');
  for (let i = 0; i < 5; i++) {
    const close = T0 + i * 10 * MIN;
    oldBid('job-J', 'ashlar', 'ines', 'claude:sonnet', close);
    oldBid('job-J', 'kiln', 'bruno', 'ollama:gpt-oss:20b', close);
    round('job-J', close);
  }
  // Kiln, deep in the red from a long week of bids: 400 more, in rounds that were all kept (an award each time).
  for (let i = 0; i < 10; i++) {
    const close = T0 + HOUR + i * HOUR;
    oldBid(`job-K${i}`, 'kiln', 'bruno', 'ollama:gpt-oss:20b', close, 40, 1);
    round(`job-K${i}`, close, { id: 'won' });
  }
  oldBid('job-old', 'ashlar', 'ines', 'claude:sonnet', NOW - 9 * 24 * HOUR);
  spend('quickset', 'claude:haiku', 'run', 12, T0, 'run-crash');
  endedRun('run-crash', 'quickset', 'crashed', false, T0 + MIN);
  spend('quickset', 'claude:haiku', 'run', 5, T0, 'run-scar');
  endedRun('run-scar', 'quickset', 'failed', true, T0 + MIN);
}

test('the restatement charges the week again under cooling off, the local floor and the refunds, by the proposal’s method', () => {
  oldWeek();
  const plan = planRestatement(NOW);
  assert.equal(plan.alreadyApplied, false);
  assert.deepEqual(plan.rounds, { was: 15, kept: 13 });
  const by = Object.fromEntries(plan.firms.map((f) => [f.firmId, f]));
  // Ashlar: 15 in bids in the window, 9 of them in rounds that would have happened.
  assert.deepEqual(by.ashlar.bids, { was: 15, restated: 9 });
  assert.equal(by.ashlar.correction, 6);
  assert.equal(by.ashlar.before, 300 - 18);
  assert.equal(by.ashlar.after, 288);
  // Kiln: three kept 3-credit calls at a quarter each, and its ten 40-credit bids (one call each, real cost above the floor) less 2.75 each.
  assert.equal(by.kiln.bids.was, 415);
  assert.equal(by.kiln.bids.restated, 3 * 0.25 + 10 * (40 - 2.75));
  assert.equal(by.kiln.correction, 415 - 373.25);
  assert.equal(by.kiln.after, 300 - 415 + 41.75);
  // Quickset: its crashed run back, its scarred one not.
  assert.equal(by.quickset.refunds, 12);
  assert.deepEqual(by.quickset.refundedRuns, ['run-crash']);
  assert.equal(by.quickset.after, 300 - 17 + 12);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'correction'").get()!.n, 0, 'planning writes nothing');
});

test('applying books one correction per firm, restarts the 72 hours of a firm still below zero, and never runs twice', () => {
  oldWeek();
  const backupDir = planRestatement(NOW);
  const kilnSince = '2026-11-17T08:00:00.000Z';
  openDb().prepare('UPDATE firms SET json = json_set(json, \'$.negativeSince\', ?) WHERE id = ?').run(kilnSince, 'kiln');
  const backup = applyRestatement(backupDir, NOW);
  assert.ok(existsSync(backup), 'the database is copied before anything is written');
  const rows = openDb().prepare("SELECT firm_id, amount, json FROM credits WHERE kind = 'correction' ORDER BY firm_id").all() as Array<{ firm_id: string; amount: number; json: string }>;
  assert.deepEqual(rows.map((r) => [r.firm_id, r.amount]), [['ashlar', 6], ['kiln', 41.75], ['quickset', 12]]);
  const moved = entries().filter((e) => e.kind === 'credits.moved' && (e.data as { kind: string }).kind === 'correction').map((e) => e.data as { firmId: string; from: string; delta: number; reason: string });
  assert.deepEqual(moved.map((m) => [m.firmId, m.from, m.delta, m.reason]), [['ashlar', 'city', 6, 'restatement'], ['kiln', 'city', 41.75, 'restatement'], ['quickset', 'city', 12, 'restatement']]);
  assert.equal(balances().kiln, 300 - 415 + 41.75);
  assert.equal(firm('kiln')?.negativeSince, iso(NOW), 'still below zero: its 72 hours start again');
  assert.equal(firm('ashlar')?.negativeSince, null);
  assert.equal(replayBalances(entries()).kiln, balances().kiln, 'the ledger alone gives the same balance');
  // The crashed run is refunded once: the treasury's own refund sees the correction.
  assert.ok(refunded('run-crash'));
  const off = installTreasury({ now: () => NOW });
  off();
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'refund'").get()!.n, 0);
  // Never twice.
  assert.equal(planRestatement(NOW).alreadyApplied, true);
  assert.ok(planRestatement(NOW).firms.every((f) => f.correction === 0 && f.after === f.before), 'once restated, nothing more is owed');
  assert.throws(() => applyRestatement(planRestatement(NOW), NOW), /already restated/);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'correction'").get()!.n, 3);
});

test('the tool is a dry run unless told --apply, and refuses while the engine answers on its port', async () => {
  oldWeek();
  const server: Server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  process.env.PALIMPSEST_PORT = String(port);
  const said: string[] = [];
  try {
    assert.equal(await main([], (s) => said.push(s), NOW), 1);
    assert.match(said.join('\n'), new RegExp(`Refused: the engine answers on port ${port}`));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  said.length = 0;
  assert.equal(await main([], (s) => said.push(s), NOW), 0);
  const out = said.join('\n');
  assert.match(out, /before/);
  assert.match(out, /correction/);
  assert.match(out, /after/);
  assert.match(out, /Dry run: nothing written/);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'correction'").get()!.n, 0);
  assert.equal(await main(['--dry-run'], () => {}, NOW), 0);
  assert.equal(await main(['--apply', '--dry-run'], () => {}, NOW), 2);
  assert.equal(await main(['apply'], () => {}, NOW), 2, 'only the flag writes');
  said.length = 0;
  assert.equal(await main(['--apply'], (s) => said.push(s), NOW), 0);
  assert.match(said.join('\n'), /Booked/);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'correction'").get()!.n, 3);
  assert.equal(await main(['--apply'], () => {}, NOW), 1, 'a second apply writes nothing');
});
