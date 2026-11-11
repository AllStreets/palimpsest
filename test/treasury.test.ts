/**
 * The treasury (Task 17): payments, costs, bankruptcy, dark tower sales and
 * hiring. Events are emitted by hand with an injected clock; no model, gh or
 * real home is ever touched (temp home from the guild fixtures).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit, subscribe, type Event } from '../engine/events.js';
import { entries } from '../engine/ledger.js';
import { charge } from '../engine/market/budget.js';
import { agentTowerId, firm, listAgents, quarters, seedFirms, BANKRUPT_REASON } from '../engine/market/firms.js';
import { balances, bankruptcyTick, cityLedger, dailyTick, installTreasury, negativeSinceOf, replayBalances } from '../engine/market/treasury.js';
import { job as storedJob } from '../engine/market/jobs.js';
import { layEarnedFloor } from '../engine/repos.js';
import { HIRE_FEE, START_BALANCE } from '../shared/market-rules.js';
import type { Bid, Floor, Inspection, Job, ModelRef, Trip } from '../shared/types.js';
import { HOUR, setUp, tearDown } from './guild-fixtures.js';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
const INSTALLED = ['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b', 'qwen3:1.7b'];
const LOCAL: ModelRef = 'ollama:qwen2.5-coder:7b';

let clock = T0;
let uninstall: () => void = () => {};
let events: Event[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  setUp('treasury');
  clock = T0;
  seedFirms(INSTALLED, new Date(T0 - HOUR));
  uninstall = installTreasury({ now: () => clock });
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  uninstall();
  await tearDown();
});

// ---------------------------------------------------------------- fixtures

function creditRows(kind?: string): Array<{ id: number; firm_id: string | null; run_id: string | null; kind: string; amount: number; json: string }> {
  const all = openDb().prepare('SELECT id, firm_id, run_id, kind, amount, json FROM credits ORDER BY id').all() as Array<{ id: number; firm_id: string | null; run_id: string | null; kind: string; amount: number; json: string }>;
  return kind ? all.filter((r) => r.kind === kind) : all;
}

function moved(kind?: string): Array<Record<string, unknown>> {
  return entries()
    .filter((e) => e.kind === 'credits.moved')
    .map((e) => e.data as Record<string, unknown>)
    .filter((d) => !kind || d.kind === kind);
}

/** A local model call charged to a firm, as bids.ts and runs.ts charge them. */
function spend(firmId: string, kind: 'bid' | 'run', credits: number, runId: string | null = null): number {
  return charge({ runId, firmId, model: LOCAL, kind, usage: { weightedTokens: 0, seconds: 1, usd: 0, credits }, unattended: false, at: clock });
}

let n = 0;
/** A job awarded to `firmId`'s bid at `price`, stored as bids.ts and jobs.ts store them. */
function awardedJob(firmId: string, agentId: string, price: number, over: Partial<Job> = {}): { job: Job; bid: Bid } {
  const id = `job-t${n++}`;
  const bid: Bid = {
    id: `bid-${id}`,
    jobId: id,
    firmId,
    agentId,
    plan: 'do it',
    price,
    confidence: 0.8,
    calibrated: 0.7,
    appraisal: null,
    ev: 10,
    cost: 3,
    at: new Date(clock).toISOString(),
  };
  const job: Job = {
    id,
    repo: 'acme/widgets',
    source: 'manual',
    issue: null,
    url: null,
    title: 'Change the widgets',
    body: '',
    scope: ['**'],
    acceptance: [],
    tier: 'normal',
    value: 60,
    status: 'waiting',
    attempts: 0,
    postedAt: new Date(clock).toISOString(),
    bidsCloseAt: null,
    awardedBid: bid.id,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, id, JSON.stringify({ round: 'r', bid }));
  saveJob(job);
  return { job, bid };
}

function saveJob(job: Job): void {
  openDb().prepare('INSERT OR REPLACE INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)').run(job.id, job.repo, job.status, JSON.stringify(job));
}

function merge(job: Job): void {
  const merged: Job = { ...job, status: 'merged' };
  saveJob(merged);
  emit('job.changed', { job: merged, from: 'waiting' });
}

function inspection(job: Job, reviewerFirmId: string | null, over: Partial<Inspection> = {}): Inspection {
  return {
    id: `insp-${job.id}`,
    runId: `run-${job.id}`,
    jobId: job.id,
    repo: job.repo,
    reviewerAgentId: reviewerFirmId ? 'oskar-kiln' : null,
    reviewerFirmId,
    checks: [],
    passed: true,
    pushable: false,
    design: null,
    cost: 4,
    at: new Date(clock).toISOString(),
    inconclusive: null,
    ...over,
  };
}

function floorsOn(towerId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const f: Floor = {
      id: `${towerId}#f${i}`,
      repo: 'acme/widgets',
      kind: 'pr',
      refs: [],
      title: `floor ${i}`,
      at: new Date(clock).toISOString(),
      era: 'stone',
      size: 'small',
      lines: 10,
      claude: false,
      founding: false,
      url: null,
    };
    layEarnedFloor(towerId, f);
  }
}

// ---------------------------------------------------------------- tests

test('a merge pays the price', () => {
  const { job } = awardedJob('quickset', 'priya-rao', 42);
  merge(job);
  const pay = creditRows('pay');
  assert.equal(pay.length, 1);
  assert.equal(pay[0].firm_id, 'quickset');
  assert.equal(pay[0].amount, 42);
  assert.equal(balances().quickset, START_BALANCE + 42);
  assert.equal(firm('quickset')?.balance, START_BALANCE + 42, 'the stored balance follows');
  const m = moved('pay');
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'quickset');
  assert.equal(m[0].from, 'city');
  assert.equal(m[0].amount, 42);
  assert.equal(m[0].jobId, job.id);
  assert.ok(events.some((e) => e.type === 'credits.moved'));

  // The same merge seen again (a replayed event) is not paid twice.
  merge(job);
  assert.equal(creditRows('pay').length, 1);
  // A job that closed is never paid.
  const { job: other } = awardedJob('kiln', 'oskar-kiln', 30);
  emit('job.changed', { job: { ...other, status: 'closed' }, from: 'waiting' });
  assert.equal(creditRows('pay').length, 1);
});

test('the reviewer share is paid once per inspection', () => {
  const { job } = awardedJob('quickset', 'priya-rao', 42, { value: 60 });
  // The reviewer's own Anthropic review call carries its firm id but is the city's cost, never the firm's.
  charge({ runId: `run-${job.id}`, firmId: 'kiln', model: 'anthropic:claude-sonnet-4-5' as ModelRef, kind: 'review', usage: { weightedTokens: 0, seconds: 1, usd: 0.1, credits: 2 }, unattended: false, at: clock });
  emit('inspection.done', { inspection: inspection(job, 'kiln') });
  emit('inspection.done', { inspection: inspection(job, 'kiln') });
  merge(job);

  const rp = creditRows('review-pay');
  assert.equal(rp.length, 1, 'one review-pay row');
  assert.equal(rp[0].firm_id, 'kiln');
  assert.equal(rp[0].amount, 3, '5% of 60');
  assert.equal(balances().kiln, START_BALANCE + 3, 'the review call cost is not on the reviewer');
  assert.equal(moved('review-pay').length, 1);

  // No reviewer (inconclusive, nobody read it): nobody is paid.
  const { job: j2 } = awardedJob('quickset', 'priya-rao', 10);
  emit('inspection.done', { inspection: inspection(j2, null, { inconclusive: 'too large to review', passed: false }) });
  assert.equal(creditRows('review-pay').length, 1);
});

test('a failed run leaves the cost on the firm', () => {
  // A bid already charged by bids.ts: bid.placed must not debit it again.
  spend('quickset', 'bid', 3);
  const { bid } = awardedJob('quickset', 'priya-rao', 20);
  emit('bid.placed', { bid });
  emit('bid.placed', { bid });
  assert.equal(creditRows('bid').length, 1, 'bid charged once');
  assert.equal(balances().quickset, START_BALANCE - 3);
  assert.equal(moved('bid').length, 1);
  assert.equal(moved('bid')[0].amount, 3);

  spend('quickset', 'run', 7.25, 'run-1');
  spend('quickset', 'run', 5.25, 'run-1');
  emit('run.ended', { runId: 'run-1', outcome: 'failed', reason: 'tests failed' });
  emit('run.ended', { runId: 'run-1', outcome: 'failed', reason: 'tests failed' });
  assert.equal(balances().quickset, START_BALANCE - 3 - 12.5);
  assert.equal(firm('quickset')?.balance, START_BALANCE - 15.5);
  const runMoves = moved('run');
  assert.equal(runMoves.length, 1, 'one movement for the run');
  assert.equal(runMoves[0].amount, 12.5);
  assert.equal(runMoves[0].from, 'quickset');
  assert.equal(runMoves[0].runId, 'run-1');
  assert.equal(creditRows('pay').length, 0, 'no payment');
});

test('bankruptcy after 72 hours negative retires agents and darkens towers', () => {
  const trip: Trip = {
    id: 'trip-1',
    agentId: 'wren-sparrow',
    firmId: 'sparrow',
    reason: 'job',
    jobId: null,
    from: { x: 0, z: 0 },
    to: { x: 10, z: 0 },
    legs: [],
    startedAt: new Date(T0).toISOString(),
    ms: 60_000,
    endedAt: null,
  };
  openDb().prepare('INSERT INTO trips (id, json) VALUES (?, ?)').run(trip.id, JSON.stringify(trip));

  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  assert.equal(balances().sparrow, -100);
  bankruptcyTick(T0);
  assert.equal(firm('sparrow')?.negativeSince, new Date(T0).toISOString());

  // Checked hourly: still active through hour 71, bankrupt on the hour the 72 are up.
  for (let h = 1; h < 72; h++) bankruptcyTick(T0 + h * HOUR);
  assert.equal(firm('sparrow')?.status, 'active', 'not yet');
  dailyTick(T0 + 72 * HOUR);
  assert.equal(firm('sparrow')?.status, 'active', 'the daily tick does not declare bankruptcy');

  bankruptcyTick(T0 + 72 * HOUR);
  assert.equal(firm('sparrow')?.status, 'bankrupt');
  const sparrows = listAgents('sparrow');
  assert.ok(sparrows.length > 0);
  for (const a of sparrows) {
    assert.equal(a.retired, true);
    assert.equal(a.retiredReason, BANKRUPT_REASON);
  }
  assert.ok(entries().some((e) => e.kind === 'firm.bankrupt' && (e.data as { firmId: string }).firmId === 'sparrow'));
  assert.ok(entries().some((e) => e.kind === 'agent.retired' && (e.data as { firmId: string }).firmId === 'sparrow'));
  const q = quarters().find((x) => x.firmId === 'sparrow');
  assert.ok(q?.dark);
  assert.ok(q?.towers.length && q.towers.every((t) => t.dark), 'every tower stands dark until a later tick sells it');
  assert.equal(entries().filter((e) => e.kind === 'tower.sold').length, 0, 'nothing sells on the tick it goes dark');

  const ended = JSON.parse((openDb().prepare('SELECT json FROM trips WHERE id = ?').get('trip-1') as { json: string }).json) as Trip;
  assert.ok(ended.endedAt, 'the live trip ended');
  assert.ok(entries().some((e) => e.kind === 'trip.ended' && (e.data as { tripId: string }).tripId === 'trip-1'));
  assert.ok(events.some((e) => e.type === 'firm.bankrupt'));
});

test('a firm back above zero is no longer counted as negative', () => {
  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  bankruptcyTick(T0);
  const { job } = awardedJob('sparrow', 'wren-sparrow', 150);
  clock = T0 + 40 * HOUR;
  merge(job);
  assert.equal(firm('sparrow')?.negativeSince, null);
  bankruptcyTick(T0 + 80 * HOUR);
  assert.equal(firm('sparrow')?.status, 'active');
});

test('a dark tower sells to the richest firm that can afford it and is re-clad', () => {
  floorsOn(agentTowerId('wren-sparrow'), 5); // price 2 * 5 + 20 = 30
  // Quickset is the richest; Meridian has money but less.
  const { job: j1 } = awardedJob('quickset', 'priya-rao', 150);
  merge(j1);
  const { job: j2 } = awardedJob('meridian', 'hal-meridian', 100);
  merge(j2);
  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  bankruptcyTick(T0);
  bankruptcyTick(T0 + 72 * HOUR);
  assert.equal(firm('sparrow')?.status, 'bankrupt');
  dailyTick(T0 + 96 * HOUR);

  const sold = entries().filter((e) => e.kind === 'tower.sold');
  // Both sparrow towers sell, each to the richest firm at that moment.
  const wren = sold.find((e) => (e.data as { agentId: string }).agentId === 'wren-sparrow');
  assert.ok(wren, 'the tower with floors sold');
  assert.deepEqual(wren.data, { from: 'sparrow', to: 'quickset', price: 30, agentId: 'wren-sparrow' });
  assert.equal(sold.filter((e) => (e.data as { agentId: string }).agentId === 'wren-sparrow').length, 1, 'recorded once');
  const sale = creditRows('sale').find((r) => JSON.parse(r.json).agentId === 'wren-sparrow');
  assert.ok(sale);
  assert.equal(sale.firm_id, 'quickset');
  assert.equal(sale.amount, 30);

  const tower = quarters().find((q) => q.firmId === 'sparrow')?.towers.find((t) => t.id === agentTowerId('wren-sparrow'));
  assert.ok(tower);
  assert.equal(tower.firmId, 'quickset');
  assert.equal(tower.root, 'chicago', "the buyer's root");
  assert.equal(tower.dark, false);

  // The second tower (no floors, price 20) went to whoever was richest after the first sale.
  const juno = sold.find((e) => (e.data as { agentId: string }).agentId === 'juno-pike');
  assert.ok(juno);
  const after = START_BALANCE + 150 - 30;
  const meridian = START_BALANCE + 100;
  assert.equal((juno.data as { to: string }).to, after >= meridian ? 'quickset' : 'meridian');

  // A later tick sells nothing again.
  dailyTick(T0 + 120 * HOUR);
  assert.equal(entries().filter((e) => e.kind === 'tower.sold').length, sold.length);
});

test('a dark tower does not sell when no firm has the price plus 100', () => {
  floorsOn(agentTowerId('wren-sparrow'), 200); // price 420
  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  bankruptcyTick(T0);
  bankruptcyTick(T0 + 72 * HOUR);
  dailyTick(T0 + 96 * HOUR);
  assert.equal(entries().filter((e) => e.kind === 'tower.sold' && (e.data as { agentId: string }).agentId === 'wren-sparrow').length, 0);
});

test('hiring adds an agent and charges the fee', () => {
  // Ashlar & Vane: two agents, balance 500 after a payment, three open jobs.
  const { job } = awardedJob('ashlar-vane', 'ines-ashlar', 200);
  merge(job);
  for (let i = 0; i < 3; i++) awardedJob('quickset', 'priya-rao', 1, { status: 'open', awardedBid: null });
  const before = listAgents('ashlar-vane').length;
  dailyTick(T0 + HOUR);

  const hired = entries().filter((e) => e.kind === 'agent.hired');
  assert.equal(hired.length, 1, 'only the firm above 400 hires');
  assert.equal((hired[0].data as { agent: { firmId: string } }).agent.firmId, 'ashlar-vane');
  assert.equal(listAgents('ashlar-vane').length, before + 1);
  const fee = creditRows('hire');
  assert.equal(fee.length, 1);
  assert.equal(fee[0].firm_id, 'ashlar-vane');
  assert.equal(fee[0].amount, HIRE_FEE);
  assert.equal(balances()['ashlar-vane'], START_BALANCE + 200 - HIRE_FEE);
  assert.equal(moved('hire').length, 1);
  assert.equal(moved('hire')[0].to, 'city');

  // At 420 with three open jobs and three idle agents it does not hire again.
  dailyTick(T0 + 2 * HOUR);
  assert.equal(entries().filter((e) => e.kind === 'agent.hired').length, 1);
});

test('a bankrupt firm never hires', () => {
  const { job } = awardedJob('sparrow', 'wren-sparrow', 300);
  merge(job);
  for (let i = 0; i < 5; i++) awardedJob('quickset', 'priya-rao', 1, { status: 'open', awardedBid: null });
  const f = firm('sparrow');
  assert.ok(f);
  openDb().prepare('UPDATE firms SET json = ? WHERE id = ?').run(JSON.stringify({ ...f, status: 'bankrupt', bankruptAt: new Date(T0).toISOString() }), 'sparrow');
  dailyTick(T0 + HOUR);
  assert.equal(entries().filter((e) => e.kind === 'agent.hired').length, 0);
});

test('balances replay from credits rows', () => {
  spend('quickset', 'bid', 3.333333);
  spend('quickset', 'run', 0.1, 'run-a');
  spend('quickset', 'run', 0.2, 'run-a');
  emit('run.ended', { runId: 'run-a', outcome: 'failed', reason: null });
  const { job } = awardedJob('quickset', 'priya-rao', 17.5);
  emit('inspection.done', { inspection: inspection(job, 'meridian') });
  merge(job);
  const { job: big } = awardedJob('ashlar-vane', 'ines-ashlar', 150);
  merge(big);
  for (let i = 0; i < 3; i++) awardedJob('kiln', 'oskar-kiln', 1, { status: 'open', awardedBid: null });
  dailyTick(T0 + HOUR);

  const live = balances();
  assert.equal(live.quickset, START_BALANCE - 3.333333 - 0.3 + 17.5, 'integer-safe: 0.1 + 0.2 is 0.3');
  assert.equal(live.meridian, START_BALANCE + 3);
  assert.equal(live['ashlar-vane'], START_BALANCE + 150 - HIRE_FEE);

  // Scramble the stored balances: the books are rebuilt from the rows, and from the ledger alone.
  for (const f of ['quickset', 'meridian', 'ashlar-vane']) {
    const cur = firm(f);
    openDb().prepare('UPDATE firms SET json = ? WHERE id = ?').run(JSON.stringify({ ...cur, balance: 999999 }), f);
  }
  assert.deepEqual(balances(), live);
  assert.deepEqual(replayBalances(entries()), live);

  const day = cityLedger(new Date(T0 - 24 * HOUR).toISOString(), new Date(T0 + 24 * HOUR).toISOString());
  assert.equal(day.paid.pay, 167.5);
  assert.equal(day.paid.reviewPay, 3);
  assert.equal(day.received.hire, HIRE_FEE);
  assert.equal(day.spent.bid, 3.333333);
  assert.equal(day.spent.run, 0.3);
});

test("bankruptcy reopens the firm's awarded jobs without spending an attempt", () => {
  const { job } = awardedJob('sparrow', 'wren-sparrow', 10, { status: 'awarded' });
  const { job: other } = awardedJob('kiln', 'oskar-kiln', 10, { status: 'awarded' });
  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  bankruptcyTick(T0);
  bankruptcyTick(T0 + 72 * HOUR);
  assert.equal(firm('sparrow')?.status, 'bankrupt');
  const reopened = storedJob(job.id);
  assert.equal(reopened?.status, 'open');
  assert.equal(reopened?.attempts, 0);
  assert.equal(reopened?.awardedBid, null);
  assert.equal(storedJob(other.id)?.status, 'awarded', "another firm's job is left alone");
});

test('a waiting PR of a bankrupt firm that merges pays nobody and says why', () => {
  const { job } = awardedJob('sparrow', 'wren-sparrow', 50, { runId: 'run-w' });
  spend('sparrow', 'run', 400, 'run-s');
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  bankruptcyTick(T0);
  bankruptcyTick(T0 + 72 * HOUR);
  assert.equal(storedJob(job.id)?.status, 'waiting', 'a waiting PR stays waiting');
  merge(job);
  assert.equal(creditRows('pay').length, 0, 'nobody is paid');
  const note = entries().find((e) => e.kind === 'run.note' && (e.data as { jobId: string }).jobId === job.id);
  assert.ok(note);
  assert.match(String((note.data as { note: string }).note), /bankrupt/);
  assert.equal((note.data as { runId: string }).runId, 'run-w');
});

test('a hire whose fee cannot be written is undone with it', () => {
  const { job } = awardedJob('ashlar-vane', 'ines-ashlar', 200);
  merge(job);
  for (let i = 0; i < 3; i++) awardedJob('quickset', 'priya-rao', 1, { status: 'open', awardedBid: null });
  const before = listAgents('ashlar-vane').length;
  openDb().exec("CREATE TRIGGER no_fee BEFORE INSERT ON credits WHEN NEW.kind = 'hire' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => dailyTick(T0 + HOUR), /disk full/);
  openDb().exec('DROP TRIGGER no_fee');
  assert.equal(listAgents('ashlar-vane').length, before, 'no agent without the fee');
  assert.equal(entries().filter((e) => e.kind === 'agent.hired').length, 0);
  assert.equal(moved('hire').length, 0);
  assert.ok(!events.some((e) => e.type === 'agent.hired'), 'nothing announced');
  // The next tick hires and charges together.
  dailyTick(T0 + 2 * HOUR);
  assert.equal(listAgents('ashlar-vane').length, before + 1);
  assert.equal(creditRows('hire').length, 1);
});

// ---------------------------------------------------------------- Task 39: one read of the books

test('balances are one sum per firm in micro-credits, with the openings read in one indexed query', () => {
  spend('quickset', 'run', 0.1, 'run-a');
  spend('quickset', 'run', 0.2, 'run-a');
  spend('kiln', 'bid', 3.333333);
  const db = openDb();
  const seen: string[] = [];
  const prepare = db.prepare;
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare.call(db, sql);
  }) as typeof db.prepare;
  let live: Record<string, number>;
  try {
    live = balances();
  } finally {
    db.prepare = prepare;
  }
  assert.equal(seen.length, 2, `two statements, not a row walk in JS (${seen.join(' ;; ')})`);
  const sums = seen.find((s) => /GROUP BY/i.test(s));
  assert.ok(sums && /SUM\(/i.test(sums) && /1000000/.test(sums), `one GROUP BY sum per firm, in micro-credits (${sums})`);
  const openings = seen.find((s) => /firm\.seeded/.test(s))!;
  assert.ok(openings, 'the openings come from firm.seeded');
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${openings}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' ');
  assert.match(plan, /ledger_kind/, `the openings are read through the kind index (${plan})`);
  assert.equal(live!.quickset, START_BALANCE - 0.3, 'exact: 0.1 + 0.2 is 0.3');
  assert.equal(live!.kiln, START_BALANCE - 3.333333);
  assert.equal(Object.keys(live!).length, 5, 'every firm, those with no rows too');
});

test('a firm below zero has been so since the charge that took it there, however often it is asked', () => {
  const at = (h: number) => T0 + h * HOUR;
  clock = at(1);
  spend('kiln', 'run', 200, 'run-1');
  clock = at(2);
  spend('kiln', 'run', 150, 'run-2'); // 300 - 350: below zero from here
  clock = at(3);
  openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'kiln', NULL, 'pay', 100, NULL, '{}')").run(new Date(at(3)).toISOString()); // back to 50
  clock = at(4);
  spend('kiln', 'run', 80, 'run-3'); // -30 again: the streak starts over here
  assert.equal(negativeSinceOf('kiln'), new Date(at(4)).toISOString());
  assert.equal(negativeSinceOf('kiln'), new Date(at(4)).toISOString(), 'the same answer on every read');
  assert.equal(negativeSinceOf('quickset'), null, 'a firm at or above zero is not below it');
});
