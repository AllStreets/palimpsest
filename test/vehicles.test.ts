import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extentBlocks, network, RIVER, route, streetWay, TRAM_DECK, tramHeight, type Leg } from '../shared/commute.js';
import { districtOrigin } from '../shared/district-layout.js';
import type { Trip } from '../shared/types.js';
import { createVehicles, motionPlan, trackOf, type VehicleRef } from '../app/src/city/vehicles.js';

type P = { x: number; z: number };

/** The sample city's slots, as the commute tests lay them. */
const SLOTS = Array.from({ length: 11 }, (_, i) => districtOrigin(i));
const NET = network({ blocks: extentBlocks(SLOTS), districts: SLOTS.slice(0, 6) });

const tripOf = (from: P, to: P): Trip => {
  const legs = route(from, to, NET);
  return { id: 't', agentId: 'a', firmId: 'f', reason: 'home', jobId: null, from, to, legs, startedAt: '', ms: 0, endedAt: null };
};
const xz = (p: readonly number[]): P => ({ x: p[0], z: p[2] });
const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);
const pathLength = (pts: P[]): number => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
const at = (r: VehicleRef): P => {
  const p = r.position();
  return { x: p[0], z: p[2] };
};

test('a vehicle advances along its polyline at its speed and wraps the loop', () => {
  // A 400 m square: no stops, corners sharp (no slowing for a curve it does not have).
  const track = trackOf(
    [
      [0, 0, 0],
      [100, 0, 0],
      [100, 0, 100],
      [0, 0, 100],
    ],
    true,
  );
  assert.equal(track.length, 400);
  const plan = motionPlan(track, [], { speed: 12, accel: 1.2, dwell: 20 });
  // Without stops it runs the loop at its speed: one lap every 400 / 12 s.
  assert.ok(Math.abs(plan.period - 400 / 12) < 0.05, `period ${plan.period}`);
  const s0 = plan.at(3).s;
  const s1 = plan.at(4).s;
  assert.ok(Math.abs(s1 - s0 - 12) < 0.05, `advances 12 m in a second (${s1 - s0})`);
  // It wraps: a lap later it is back where it was, and it never leaves [0, length).
  assert.ok(Math.abs(plan.at(3 + plan.period).s - s0) < 0.05);
  for (let t = 0; t < 200; t += 0.7) {
    const s = plan.at(t).s;
    assert.ok(s >= 0 && s < track.length, `s ${s} at ${t}`);
  }
  // On the second side it runs along z.
  const p = track.point(150);
  assert.deepEqual([p.x, p.z], [100, 50]);

  // With a stop it eases in, dwells and eases out: slower near the stop, still at the stop for the dwell.
  const stopping = motionPlan(track, [200], { speed: 12, accel: 1.2, dwell: 20 });
  assert.ok(stopping.period > plan.period + 20, 'the stop costs its dwell and the braking');
  const arrive = stopping.timeAt(200);
  assert.ok(Math.abs(stopping.at(arrive + 10).s - 200) < 0.01, 'stands at the stop through its dwell');
  assert.ok(stopping.at(arrive - 1).v < 3, `slows into the stop (${stopping.at(arrive - 1).v} m/s a second out)`);
  assert.ok(stopping.at(arrive + 21).v < 3, 'pulls away gently');
});

test('board returns the next tram on the leg\'s line', () => {
  const trip = tripOf({ x: 560, z: -300 }, { x: 600, z: 200 });
  const k = trip.legs.findIndex((l) => l.mode === 'tram');
  assert.ok(k >= 0, 'the trip rides the tram');
  const leg = trip.legs[k];
  const v = createVehicles(NET, 'high');
  v.update(37);
  const ref = v.board(trip, k);
  assert.ok(ref, 'a tram is boarded');
  assert.equal(ref.kind, 'tram');
  const stop = xz(leg.path[0]);
  const wait = ref.arrivesIn(stop);
  assert.ok(wait >= 0, 'it has not yet left the stop');
  // No other tram running the same way reaches the stop sooner.
  for (const other of v.vehicles('tram')) {
    if (other.track !== ref.track || other.id === ref.id) continue;
    assert.ok(other.arrivesIn(stop) >= wait - 1e-6, `${other.id} would come sooner`);
  }
  // When it arrives it stands at the stop on the near track, heading the way the leg goes.
  v.update(wait + 2);
  assert.ok(dist(at(ref), stop) < 2.6, `at the stop (${dist(at(ref), stop).toFixed(2)} m off)`);
  assert.ok(ref.speed() < 0.01, 'standing');
  const next = xz(leg.path[1]);
  const h = ref.heading();
  assert.ok(Math.cos(h) * (next.x - stop.x) + Math.sin(h) * (next.z - stop.z) > 0, 'faces along the leg');
  // It carries the rider to the leg's end.
  const end = xz(leg.path[leg.path.length - 1]);
  v.update(ref.arrivesIn(end) + 2);
  assert.ok(dist(at(ref), end) < 2.6, 'sets down at the leg\'s far stop');
  v.dispose();
});

test('trams ride on their bridge\'s deck, and the legs a rider follows ride at the vehicle\'s height', () => {
  // The tram's track over the river is at the deck's height, not at the water's.
  const over = NET.tram.track.filter(([x]) => Math.abs(x - RIVER.x) < 5);
  assert.ok(over.length >= 2, 'the track is laid across the river');
  for (const [x, y, z] of over) assert.ok(Math.abs(y - tramHeight(x, z)) < 1e-6 && y > 1, `over the river at ${y}`);
  // A tram leg across the river climbs onto the deck.
  let leg: Leg | null = null;
  let trip: Trip | null = null;
  for (const [from, to] of [
    [{ x: -200, z: 600 }, { x: -560, z: 600 }],
    [{ x: -200, z: -600 }, { x: -560, z: -600 }],
  ] as Array<[P, P]>) {
    const t = tripOf(from, to);
    const l = t.legs.find((g) => g.mode === 'tram' && g.path.some(([x]) => Math.abs(x - RIVER.x) < 5));
    if (l) {
      leg = l;
      trip = t;
      break;
    }
  }
  assert.ok(leg && trip, 'a tram leg crosses the river');
  const mid = leg.path.filter(([x]) => Math.abs(x - RIVER.x) < 5);
  assert.ok(mid.length > 0 && mid.every(([, y]) => Math.abs(y - TRAM_DECK.height) < 1e-6), 'the leg rides the deck');
  // The ramps are in the leg too, not a jump: no step between points over 0.25 m.
  for (let i = 1; i < leg.path.length; i++) assert.ok(Math.abs(leg.path[i][1] - leg.path[i - 1][1]) < 0.25);
  // The boarded tram's running surface where it crosses is the leg's own height.
  const v = createVehicles(NET, 'high');
  const ref = v.board(trip, trip.legs.indexOf(leg));
  assert.ok(ref);
  v.update(ref.arrivesIn(xz(leg.path[0])) + 5);
  let seen = 0;
  for (let s = 0; s < 200 && ref.speed() + 1 > 0; s++) {
    v.update(0.25);
    const p = ref.position();
    if (Math.abs(p[0] - RIVER.x) < 3) {
      assert.ok(Math.abs(p[1] - tramHeight(p[0], p[2])) < 0.03, `the tram rides the deck (${p[1]})`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'the tram crossed the river');
  assert.ok(ref.floorY() > ref.position()[1], 'its floor stands over the rail');
  v.dispose();
});

test('a summoned cab drives from the nearest rank and ends at the leg\'s end', () => {
  const from = { x: 200, z: -40 };
  const to = { x: 1000, z: 300 };
  const trip = tripOf(from, to);
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  assert.ok(k >= 0, `a cab is taken (${trip.legs.map((l) => l.mode).join(', ')})`);
  const leg = trip.legs[k];
  const start = xz(leg.path[0]);
  const end = xz(leg.path[leg.path.length - 1]);
  const nearest = [...NET.ranks].sort((a, b) => pathLength(streetWay(a, start)) - pathLength(streetWay(b, start)))[0];
  const v = createVehicles(NET, 'high');
  const parked = v.vehicles('cab').length;
  const cab = v.summonCab(trip, k);
  assert.equal(cab.kind, 'cab');
  assert.equal(cab.phase(), 'to-pickup');
  assert.ok(dist(at(cab), nearest) < 12, `it leaves the nearest rank (${dist(at(cab), nearest).toFixed(1)} m off)`);
  let picked: P | null = null;
  let setDown: P | null = null;
  const phases: string[] = [];
  for (let i = 0; i < 20000 && cab.phase() !== 'parked'; i++) {
    v.update(0.1);
    const ph = cab.phase();
    if (phases[phases.length - 1] !== ph) phases.push(ph);
    if (ph === 'pickup') picked ??= at(cab);
    if (ph === 'setdown') setDown = at(cab);
  }
  assert.deepEqual(phases, ['to-pickup', 'pickup', 'carrying', 'setdown', 'returning', 'parked']);
  assert.ok(picked && dist(picked, start) < 0.5, 'it stops for the rider at the leg\'s start');
  assert.ok(setDown && dist(setDown, end) < 0.5, `it sets down at the leg's end (${setDown && dist(setDown, end).toFixed(2)} m off)`);
  assert.ok(dist(at(cab), nearest) < 12, 'and goes back to its rank');
  assert.equal(v.vehicles('cab').length, parked, 'the rank keeps its cabs');
  v.dispose();
});
