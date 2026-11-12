/**
 * Persona trips (Task 33): agents go to the exchange when they bid, to the
 * district when they win, to the site when they inspect and home when a
 * run ends. The legs come from shared/commute.ts's router over the city's
 * own network. No model, gh or real home is ever touched.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit, subscribe, type Event } from '../engine/events.js';
import { entries } from '../engine/ledger.js';
import { award, openBidding } from '../engine/market/bids.js';
import { charge } from '../engine/market/budget.js';
import { agent as storedAgent, firm, seedFirms } from '../engine/market/firms.js';
import { job as storedJob, transition } from '../engine/market/jobs.js';
import { finishWaitingRun } from '../engine/market/runs.js';
import { bankruptcyTick, installTreasury } from '../engine/market/treasury.js';
import { activeTrips, EXCHANGE, homeOf, siteOf, startTrip } from '../engine/market/trips.js';
import type { Agent, Bid, Job, ModelRef, Run, Trip } from '../shared/types.js';
import { checks, FULL, HOUR, makeRepo, postJob, setUp, tearDown } from './guild-fixtures.js';

const T0 = Date.parse('2026-11-10T09:00:00.000Z');
const INSTALLED = ['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b', 'qwen3:1.7b'];
const LOCAL: ModelRef = 'ollama:qwen2.5-coder:7b';

let clock = T0;
let uninstall: () => void = () => {};
let events: Event[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  setUp('trips');
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

/** The widgets repo on district slot 11 (480, 480): a 700 m ride from the exchange. */
function farRepo(): void {
  const repo = makeRepo(checks(), { 'a.txt': 'a\n' });
  openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...repo, slot: 11 }), FULL);
}

function worker(): Agent {
  const a = storedAgent('ola-bergstrom');
  assert.ok(a);
  return a;
}

function storedTrips(): Trip[] {
  return (openDb().prepare('SELECT json FROM trips').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip);
}

function placeBid(j: Job, a: Agent): Bid {
  const bid: Bid = { id: `bid-${j.id}`, jobId: j.id, firmId: a.firmId, agentId: a.id, plan: 'do it', price: 20, confidence: 0.8, calibrated: 0.7, appraisal: null, ev: 10, cost: 3, at: new Date(clock).toISOString() };
  openDb().prepare('INSERT OR REPLACE INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, j.id, JSON.stringify({ round: j.bidsCloseAt, bid }));
  return bid;
}

test('an award starts a trip from the exchange to the district with legs', () => {
  farRepo();
  const a = worker();
  const j = openBidding(postJob(['**']), T0);
  const bid = placeBid(j, a);
  // The agent went to the exchange to bid.
  startTrip(a, 'bid', j.id, homeOf(a), EXCHANGE, T0);

  const chosen = award(j, T0 + HOUR);
  assert.equal(chosen?.id, bid.id);
  const trip = activeTrips(T0 + HOUR).find((t) => t.agentId === a.id);
  assert.ok(trip, 'a trip for the winner');
  assert.equal(trip.reason, 'job');
  assert.equal(trip.jobId, j.id);
  assert.deepEqual(trip.from, EXCHANGE);
  assert.deepEqual(trip.to, siteOf(FULL));
  assert.ok(trip.legs.length >= 1, 'legs');
  assert.ok(trip.legs.every((l) => l.path.length >= 2 && l.ms > 0));
  assert.equal(trip.ms, trip.legs.reduce((s, l) => s + l.ms, 0));
  assert.ok(entries().some((e) => e.kind === 'trip.started' && (e.data as { tripId: string }).tripId === trip.id));
  assert.ok(events.some((e) => e.type === 'trip.started' && (e.data as { trip: Trip }).trip.id === trip.id));
});

test('a 1,000 m trip to a district takes a cab', () => {
  const a = worker();
  const trip = startTrip(a, 'job', null, EXCHANGE, { x: EXCHANGE.x + 1000, z: EXCHANGE.z }, T0);
  assert.deepEqual(trip.legs.map((l) => l.mode), ['cab']);
  const [cab] = trip.legs;
  assert.deepEqual(cab.path[0], [0, 0, 40]);
  assert.deepEqual(cab.path[cab.path.length - 1], [1000, 0, 40]);
  // 1,000 m at 11 m/s plus the 30 s wait at the kerb.
  assert.ok(cab.ms > 100_000 && cab.ms < 130_000, `${cab.ms} ms`);
});

test('run end starts a trip home', () => {
  farRepo();
  const a = worker();
  let j = postJob(['**']);
  for (const to of ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) j = transition(j, to);
  const r: Run = {
    id: 'run-home',
    jobId: j.id,
    bidId: 'bid-x',
    agentId: a.id,
    firmId: a.firmId,
    repo: FULL,
    model: a.model,
    branch: `palimpsest/${j.id}`,
    dir: null,
    baseSha: null,
    headSha: null,
    stage: 'waiting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: new Date(T0).toISOString(),
    endedAt: null,
    prNumber: null,
    prUrl: null,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
  };
  openDb().prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify({ ...j, runId: r.id }), j.id);
  openDb().prepare('INSERT INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));

  assert.ok(finishWaitingRun(r.id, 'merged', null));
  const home = storedTrips().find((t) => t.agentId === a.id && t.reason === 'home');
  assert.ok(home, 'a trip home');
  assert.equal(home.jobId, j.id);
  assert.deepEqual(home.from, siteOf(FULL));
  assert.deepEqual(home.to, homeOf(a));
  assert.ok(home.legs.length >= 1);
  assert.ok(storedJob(j.id));
});

test('a second trip ends the first', () => {
  const a = worker();
  const first = startTrip(a, 'bid', null, homeOf(a), EXCHANGE, T0);
  const second = startTrip(a, 'home', null, EXCHANGE, homeOf(a), T0 + 10_000);
  const live = activeTrips(T0 + 10_000);
  assert.deepEqual(live.map((t) => t.id), [second.id]);
  const stored = storedTrips().find((t) => t.id === first.id);
  assert.equal(stored?.endedAt, new Date(T0 + 10_000).toISOString());
  const ended = entries().filter((e) => e.kind === 'trip.ended').map((e) => e.data as { tripId: string; reason: string });
  assert.deepEqual(ended, [{ tripId: first.id, agentId: a.id, firmId: a.firmId, reason: 'superseded', at: new Date(T0 + 10_000).toISOString() }]);
  assert.ok(events.some((e) => e.type === 'trip.ended' && (e.data as { tripId: string }).tripId === first.id));

  // A trip whose time is up ends as arrived, by the next look.
  const after = T0 + 10_000 + second.ms;
  assert.deepEqual(activeTrips(after), []);
  assert.ok(entries().some((e) => e.kind === 'trip.ended' && (e.data as { tripId: string; reason: string }).tripId === second.id && (e.data as { reason: string }).reason === 'arrived'));
});

test('retiring an agent ends its trip and records trip.ended', () => {
  const wren = storedAgent('wren-sparrow');
  assert.ok(wren);
  const trip = startTrip(wren, 'bid', null, homeOf(wren), EXCHANGE, T0);
  charge({ runId: 'run-s', firmId: 'sparrow', model: LOCAL, kind: 'run', usage: { weightedTokens: 0, seconds: 1, usd: 0, credits: 400 }, unattended: false, at: clock });
  emit('run.ended', { runId: 'run-s', outcome: 'failed', reason: null });
  for (let h = 0; h <= 72; h++) bankruptcyTick(T0 + h * HOUR);
  assert.equal(firm('sparrow')?.status, 'bankrupt');
  assert.equal(storedAgent('wren-sparrow')?.retired, true);

  assert.deepEqual(activeTrips(T0 + HOUR).filter((t) => t.firmId === 'sparrow'), []);
  const ended = entries().find((e) => e.kind === 'trip.ended' && (e.data as { tripId: string }).tripId === trip.id);
  assert.ok(ended, 'trip.ended in the ledger');
  assert.equal((ended.data as { reason: string }).reason, 'firm bankrupt');
  assert.ok(events.some((e) => e.type === 'trip.ended' && (e.data as { tripId: string }).tripId === trip.id));
});
