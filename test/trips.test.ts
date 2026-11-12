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
import { award, collectBid, eligibleAgents, openBidding } from '../engine/market/bids.js';
import { charge } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import { review } from '../engine/guild/review.js';
import { setProvider } from '../engine/market/providers.js';
import { agent as storedAgent, firm, seedFirms } from '../engine/market/firms.js';
import { job as storedJob, transition } from '../engine/market/jobs.js';
import { finishWaitingRun } from '../engine/market/runs.js';
import { bankruptcyTick, installTreasury } from '../engine/market/treasury.js';
import { activeTrips, EXCHANGE, homeOf, siteOf, startTrip, whereIs } from '../engine/market/trips.js';
import type { Agent, Bid, Job, ModelRef, Run, Trip } from '../shared/types.js';
import { addAgent, checks, FULL, HOUR, makeRepo, makeRun, MIN, postJob, setUp, tearDown, workLease, write } from './guild-fixtures.js';

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
  assert.deepEqual(cab.path[0], [EXCHANGE.x, 0, EXCHANGE.z]);
  assert.deepEqual(cab.path[cab.path.length - 1], [EXCHANGE.x + 1000, 0, EXCHANGE.z]);
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

test('a bid through collectBid sends the bidder to the exchange', async () => {
  farRepo();
  const a = worker();
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, fakeProvider());
  const j = openBidding(postJob(['**']), T0);
  assert.ok(eligibleAgents(j).some((e) => e.id === a.id), 'eligible');
  const bid = await collectBid(j, a, T0);
  assert.ok(bid, 'a bid');
  const trip = activeTrips(T0).find((t) => t.agentId === a.id);
  assert.ok(trip, 'a trip');
  assert.equal(trip.reason, 'bid');
  assert.equal(trip.jobId, j.id);
  assert.deepEqual(trip.from, homeOf(a));
  assert.deepEqual(trip.to, EXCHANGE);
  assert.ok(trip.legs.length >= 1);
});

test('a review sends the reviewer to the site and then home', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks(), { 'src/a.ts': 'export const a = 1;\n' });
  const job = postJob(['src/**']);
  const w = addAgent('ann', 'aaa', 'claude:sonnet');
  const { run, diff } = await makeRun(repo, job, w, (dir) => write(dir, 'src/a.ts', 'export const a = 2;\n'));
  const p = fakeProvider({ review: () => ({ approve: true, notes: 'Fine.', concerns: [], usage: { weightedTokens: 600, seconds: 2, usd: 0, credits: 1 } }) });
  setProvider('claude', p);
  const lease = await workLease();
  let out: Awaited<ReturnType<typeof review>>;
  try {
    out = await review(run, job, diff.patch, [], lease);
  } finally {
    lease.release();
  }
  assert.equal(out.result.status, 'pass');
  const bea = storedAgent(out.reviewerAgentId ?? '');
  assert.ok(bea && bea.firmId !== w.firmId, 'a reviewer from another firm');
  const mine = storedTrips().filter((t) => t.agentId === bea.id).sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  assert.deepEqual(mine.map((t) => t.reason), ['inspect', 'home']);
  const [inspect, home] = mine;
  assert.equal(inspect.jobId, job.id);
  assert.deepEqual(inspect.from, homeOf(bea));
  assert.deepEqual(inspect.to, siteOf(FULL));
  assert.ok(inspect.endedAt, 'the trip to the site ended when the trip home began');
  assert.deepEqual(home.from, siteOf(FULL));
  assert.deepEqual(home.to, homeOf(bea));
  assert.equal(home.endedAt, null);
  assert.ok(storedTrips().every((t) => t.agentId !== w.id), 'the worker, who did not travel, stays put');
});

test('a trip over 1,500 m rides the rail or the pods', () => {
  farRepo();
  const a = worker();
  const trip = startTrip(a, 'job', null, { x: 600, z: -600 }, { x: -600, z: 600 }, T0);
  const ride = trip.legs.find((l) => l.mode === 'rail' || l.mode === 'pod');
  assert.ok(ride, trip.legs.map((l) => l.mode).join(','));
  assert.ok(ride.path.every((p) => p[1] >= 12), 'the ride runs at its line height');
  assert.ok(trip.legs.length >= 3, 'walks to and from the station');
});

test('the trips table stays bounded: ended trips older than an hour go, each agent keeps its latest', () => {
  const a = worker();
  const wren = storedAgent('wren-sparrow');
  assert.ok(wren);
  const count = () => (openDb().prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n;
  const other = startTrip(wren, 'bid', null, homeOf(wren), EXCHANGE, T0);
  for (let i = 0; i < 40; i++) startTrip(a, i % 2 ? 'home' : 'bid', null, homeOf(a), EXCHANGE, T0 + i * MIN);
  assert.equal(count(), 41);
  // Within the hour nothing is pruned.
  activeTrips(T0 + 40 * MIN);
  assert.equal(count(), 41);
  // Three hours on, the worker keeps only its latest row and wren keeps hers, though both ended long ago.
  activeTrips(T0 + 3 * HOUR);
  assert.equal(count(), 2);
  const left = storedTrips();
  assert.ok(left.some((t) => t.id === other.id));
  const mine = left.find((t) => t.agentId === a.id);
  assert.equal(mine?.startedAt, new Date(T0 + 39 * MIN).toISOString());
  assert.deepEqual(whereIs(a), EXCHANGE);
  assert.deepEqual(whereIs(wren), EXCHANGE);
});

test('the exchange point stands on the forecourt, off the fountain and the hall', () => {
  // The forecourt fountain (app/src/city/exchange.ts FOUNTAIN) is centred at (0, 42) with a 10 m basin, and the
  // hall with its steps reaches to z 21: a bidder stands between them, clear of both.
  assert.ok(Math.hypot(EXCHANGE.x - 0, EXCHANGE.z - 42) > 12, `outside the fountain (${JSON.stringify(EXCHANGE)})`);
  assert.ok(EXCHANGE.z > 23, 'off the hall steps');
});
