import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extentBlocks, network, RIVER, route, streetWay, TRAM_DECK, tramHeight, type Leg } from '../shared/commute.js';
import { districtOrigin } from '../shared/district-layout.js';
import type { Trip } from '../shared/types.js';
import { createVehicles, kerbOf, motionPlan, trackOf, type VehicleRef } from '../app/src/city/vehicles.js';
import { PIERS, RIVER as RIVER_, streetLine } from '../shared/commute.js';

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
  assert.ok(picked && dist(picked, kerbOf(start, NET)) < 0.5, 'it stops for the rider at the kerb by the leg\'s start');
  assert.ok(setDown && dist(setDown, kerbOf(end, NET)) < 0.5, `it sets down at the kerb by the leg's end (${setDown && dist(setDown, kerbOf(end, NET)).toFixed(2)} m off)`);
  assert.ok(dist(at(cab), nearest) < 12, 'and goes back to its rank');
  assert.equal(v.vehicles('cab').length, parked, 'the rank keeps its cabs');
  v.dispose();
});

// ---------------------------------------------------------------- fix round 1

type Mode = Trip['legs'][number]['mode'];
const legTrip = (mode: Mode, path: Array<[number, number, number]>): Trip => ({ id: `syn:${mode}:${path[0]?.join(',') ?? 'none'}`, agentId: 'a', firmId: 'f', reason: 'home', jobId: null, from: path.length ? xz(path[0]) : { x: 0, z: 0 }, to: path.length ? xz(path[path.length - 1]) : { x: 0, z: 0 }, legs: [{ mode, path, ms: 0 }], startedAt: '', ms: 0, endedAt: null });
/** A leg along a straight line from stop a to stop b (the second point a few metres on, so the leg's way reads). */
const straightLeg = (mode: Mode, a: P, b: P, y: number): Trip => {
  const l = dist(a, b);
  const step = { x: a.x + ((b.x - a.x) / l) * 5, z: a.z + ((b.z - a.z) / l) * 5 };
  return legTrip(mode, [
    [a.x, y, a.z],
    [step.x, y, step.z],
    [b.x, y, b.z],
  ]);
};

/** Boards, waits for the vehicle, rides, and checks it stands at each end: returns the ride. */
function rideThrough(v: ReturnType<typeof createVehicles>, trip: Trip, kind: string): { ref: VehicleRef; at: P } {
  const ride = v.board(trip, 0);
  assert.ok(ride, `a ${kind} is boarded`);
  assert.equal(ride.kind, kind);
  const leg = trip.legs[0];
  const a = xz(leg.path[0]);
  const b = xz(leg.path[leg.path.length - 1]);
  const wait = ride.boardsIn();
  const ride0 = ride.alightsIn();
  assert.ok(wait >= 0 && ride0 > wait, `boards in ${wait} s and alights after (${ride0} s)`);
  v.update(wait + 1);
  const at = at2(ride);
  const tol = kind === 'ferry' ? 24 : 4;
  assert.ok(dist(at, a) < tol, `${kind} stands at the boarding stop (${dist(at, a).toFixed(1)} m off)`);
  assert.ok(ride.speed() < 0.01);
  v.update(ride.alightsIn() + 1);
  assert.ok(dist(at2(ride), b) < tol, `${kind} stands at the alighting stop (${dist(at2(ride), b).toFixed(1)} m off)`);
  return { ref: ride, at };
}
const at2 = (r: VehicleRef): P => ({ x: r.position()[0], z: r.position()[2] });

test('board takes the train either way round the elevated loop', () => {
  const v = createVehicles(NET, 'high');
  const [s0, s1] = NET.rail.stops;
  const out = rideThrough(v, straightLeg('rail', s0, s1, 12), 'rail');
  const back = rideThrough(v, straightLeg('rail', s1, s0, 12), 'rail');
  assert.notEqual(out.ref.track, back.ref.track, 'the two ways run on their own tracks');
  v.dispose();
});

test('board takes a pod out on one beam and back on the other', () => {
  const v = createVehicles(NET, 'high');
  const line = NET.pods[0];
  const inner = line.stops.filter((s) => !s.interchange).slice(1, 3);
  const out = rideThrough(v, straightLeg('pod', inner[0], inner[1], 18), 'pod');
  const back = rideThrough(v, straightLeg('pod', inner[1], inner[0], 18), 'pod');
  // The line runs along x on z = 120: one way stands either side of it.
  const side = (p: P): number => Math.sign(p.z - line.path[0][2]);
  assert.notEqual(side(out.at), side(back.at), 'outbound and inbound run on the two beams');
  v.dispose();
});

test('board takes the ferry down the river and back up it', () => {
  const v = createVehicles(NET, 'high');
  const piers = [...PIERS].sort((a, b) => a.z - b.z);
  const path = (a: (typeof PIERS)[number], b: (typeof PIERS)[number]): Array<[number, number, number]> => {
    const sa = a.bank === 'west' ? -1 : 1;
    const sb = b.bank === 'west' ? -1 : 1;
    return [
      [a.x, -5.2, a.z],
      [RIVER_.x + sa * 12, -5.2, a.z],
      [RIVER_.x + sb * 12, -5.2, b.z],
      [b.x, -5.2, b.z],
    ];
  };
  const down = v.board(legTrip('ferry', path(piers[2], piers[3])), 0);
  const up = v.board(legTrip('ferry', path(piers[3], piers[2])), 0);
  assert.ok(down && up);
  rideThrough(v, legTrip('ferry', path(piers[2], piers[3])), 'ferry');
  rideThrough(v, legTrip('ferry', path(piers[3], piers[2])), 'ferry');
  v.dispose();
});

test('board returns null for a walk, a cab, or a stop no line calls at', () => {
  const v = createVehicles(NET, 'high');
  assert.equal(v.board(legTrip('walk', [[0, 0, 0], [40, 0, 0]]), 0), null);
  assert.equal(v.board(legTrip('cab', [[0, 0, 0], [40, 0, 0]]), 0), null);
  assert.equal(v.board(straightLeg('tram', { x: 3, z: 3 }, { x: 300, z: 3 }, 0), 0), null);
  assert.equal(v.board(legTrip('tram', [[0, 0, 0]]), 0), null);
  assert.equal(v.board(legTrip('tram', []), 0), null);
  v.dispose();
});

test('a transfer rides one pod line to the interchange and boards the other', () => {
  const big = network({ blocks: 4, districts: [] });
  const legs = route({ x: -1150, z: 150 }, { x: 150, z: 1150 }, big);
  assert.deepEqual(legs.map((l) => l.mode), ['walk', 'pod', 'pod', 'walk']);
  const trip: Trip = { id: 'x', agentId: 'a', firmId: 'f', reason: 'home', jobId: null, from: { x: -1150, z: 150 }, to: { x: 150, z: 1150 }, legs, startedAt: '', ms: 0, endedAt: null };
  const v = createVehicles(big, 'high');
  const first = v.board(trip, 1);
  assert.ok(first);
  v.update(first.alightsIn() + 1);
  const second = v.board(trip, 2);
  assert.ok(second);
  assert.notEqual(first.track, second.track, 'the change is onto the other line');
  v.update(second.boardsIn() + 1);
  assert.ok(dist(at2(second), { x: 120, z: 120 }) < 4, 'the second pod stands at the interchange');
  v.dispose();
});

test("a ride that passes the loop's seam alights after it boards, the short way round", () => {
  const v = createVehicles(NET, 'high');
  // The last stop in the loop's order to the first: forward round the loop through its start.
  const stops = NET.tram.stops;
  const a = stops[stops.length - 1];
  const b = stops[0];
  const corners = NET.tram.path.map(xz);
  const loopDir = (p: P): P => {
    for (let i = 0; i < corners.length; i++) {
      const c0 = corners[i];
      const c1 = corners[(i + 1) % corners.length];
      const onX = c0.z === c1.z && Math.abs(p.z - c0.z) < 1e-6 && (p.x - c0.x) * (p.x - c1.x) <= 0;
      const onZ = c0.x === c1.x && Math.abs(p.x - c0.x) < 1e-6 && (p.z - c0.z) * (p.z - c1.z) <= 0;
      if (onX || onZ) {
        const l = dist(c0, c1);
        return { x: (c1.x - c0.x) / l, z: (c1.z - c0.z) / l };
      }
    }
    throw new Error('stop off the loop');
  };
  const d = loopDir(a);
  const trip = legTrip('tram', [
    [a.x, 0, a.z],
    [a.x + d.x * 5, 0, a.z + d.z * 5],
    [b.x, 0, b.z],
  ]);
  const ride = v.board(trip, 0);
  assert.ok(ride);
  const span = ride.alightsIn() - ride.boardsIn();
  assert.ok(span > 0 && span < 600, `it rides the short way (${span.toFixed(0)} s)`);
  v.update(ride.alightsIn() + 1);
  assert.ok(dist(at2(ride), b) < 3, 'and alights at the first stop past the seam');
  v.dispose();
});

test('with every cab out the nearest rank sends another, in a bay of its own', () => {
  const v = createVehicles(NET, 'high');
  const cabs = v.vehicles('cab').length;
  const trip = tripOf({ x: 200, z: -40 }, { x: 1000, z: 300 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  const sent: VehicleRef[] = [];
  for (let i = 0; i < cabs + 4; i++) sent.push(v.summonCab({ ...trip, id: `t${i}` }, k));
  assert.equal(new Set(sent.map((r) => r.id)).size, sent.length, 'every summons sends its own cab');
  const all = v.vehicles('cab');
  assert.ok(all.length > cabs && all.length <= NET.ranks.length * 3, `the extra cabs are capped at three a rank (${all.length})`);
  // No two cabs stand in the same bay.
  const parked = all.filter((c) => c.phase() === 'parked').map((c) => c.position().map((n) => n.toFixed(1)).join(','));
  assert.equal(new Set(parked).size, parked.length);
  v.dispose();
});

test('a second summons for the same trip leg brings the same cab', () => {
  const v = createVehicles(NET, 'high');
  const trip = tripOf({ x: 200, z: -40 }, { x: 1000, z: 300 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  const a = v.summonCab(trip, k);
  const b = v.summonCab(trip, k);
  assert.equal(a.id, b.id);
  assert.throws(() => v.summonCab(trip, trip.legs.findIndex((l) => l.mode === 'walk')), /cab leg/);
  v.dispose();
});

test('a cab picks up and sets down at the kerb, never in a plaza', () => {
  const plazas = [{ x: 0, z: 0 }, ...SLOTS.slice(0, 6)];
  for (const p of [{ x: 0, z: 0 }, { x: 240, z: 240 }, { x: 20, z: 300 }, { x: 446.5, z: 330 }, { x: -480, z: 0 }, { x: 1000, z: 300 }]) {
    const k = kerbOf(p, NET);
    for (const o of plazas) assert.ok(dist(k, o) >= 74, `kerb ${k.x},${k.z} for ${p.x},${p.z} is clear of the plaza at ${o.x},${o.z}`);
    const offX = Math.abs(k.x - streetLine(k.x));
    const offZ = Math.abs(k.z - streetLine(k.z));
    assert.ok(Math.abs(Math.min(offX, offZ) - 6.4) < 0.01, `on a street's kerb lane (${offX}, ${offZ})`);
  }
  const v = createVehicles(NET, 'high');
  const trip = tripOf({ x: 20, z: 60 }, { x: 900, z: 400 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  assert.ok(k >= 0);
  const cab = v.summonCab(trip, k);
  for (let i = 0; i < 20000 && cab.phase() !== 'parked'; i++) {
    v.update(0.25);
    for (const o of plazas) assert.ok(dist(at2(cab), o) >= 72, `the cab keeps out of the plaza at ${o.x},${o.z} (${cab.phase()} at ${at2(cab).x.toFixed(0)},${at2(cab).z.toFixed(0)})`);
  }
  v.dispose();
});

test('laying the fleet again keeps its clock: nothing jumps, and held refs carry on or say they are retired', () => {
  const v = createVehicles(NET, 'high');
  v.update(123.4);
  const tram = v.vehicles('tram')[3];
  const before = tram.position();
  const ride = v.board(tripOf({ x: 560, z: -300 }, { x: 600, z: 200 }), 1);
  assert.ok(ride);
  v.relay(NET);
  assert.deepEqual(tram.position(), before, 'the same network: every tram stays where it was');
  assert.equal(tram.retired(), false);
  assert.equal(ride.retired(), false, 'a ride on the same network carries on');
  v.update(2);
  assert.notDeepEqual(tram.position(), before, 'and the held ref keeps moving');
  const bigger = network({ blocks: 3, districts: SLOTS.slice(0, 6) });
  v.relay(bigger);
  assert.equal(ride.retired(), true, 'a ride on a network laid anew is retired: its rider boards again');
  const p = tram.position();
  v.update(2);
  assert.ok(tram.retired() || tram.position().join() !== p.join(), 'a held ref either moves on the new loop or says it is retired');
  v.dispose();
});

test('dispose removes the vehicles from the scene and frees their geometry', () => {
  const v = createVehicles(NET, 'high');
  let freed = 0;
  v.group.traverse((o) => (o as unknown as { geometry?: { addEventListener(t: string, f: () => void): void } }).geometry?.addEventListener('dispose', () => freed++));
  const parent = { children: [] as unknown[] };
  void parent;
  v.dispose();
  assert.ok(freed > 10, `geometries freed (${freed})`);
  assert.equal(v.group.parent, null);
  assert.doesNotThrow(() => v.dispose(), 'a second dispose is harmless');
});

test('three or more ferries run, and the wakes go to those nearest the eye in reused slots', () => {
  const v = createVehicles(NET, 'high');
  assert.ok(v.vehicles('ferry').length >= 3 && v.vehicles('ferry').length <= 4);
  const a = v.wakes({ x: -360, y: 10, z: 0 } as never);
  const b = v.wakes({ x: -360, y: 10, z: 0 } as never);
  assert.equal(a, b, 'the same array each frame');
  assert.ok(a.length <= 4);
  v.dispose();
});

// ---------------------------------------------------------------- fix round 2

test('a summons queued on a busy cab says it is queued and how long the wait really is', () => {
  const v = createVehicles(NET, 'high');
  const trip = tripOf({ x: 200, z: -40 }, { x: 1000, z: 300 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  const start = xz(trip.legs[k].path[0]);
  // Send every cab in the city, filling every bay at every rank.
  const first: VehicleRef[] = [];
  for (let i = 0; i < NET.ranks.length * 3; i++) first.push(v.summonCab({ ...trip, id: `busy${i}` }, k));
  const mine = v.summonCab({ ...trip, id: 'mine' }, k);
  assert.equal(mine.phase(), 'queued', 'my summons waits for a cab to come free');
  // The cab it waits on is out on someone else's errand: that booking shows the errand; mine does not.
  const busy = first.filter((r) => r.vehicle === mine.vehicle);
  assert.equal(busy.length, 1, 'exactly one busy booking is on the cab I wait for');
  assert.notEqual(busy[0].phase(), 'queued');
  assert.notEqual(busy[0].phase(), mine.phase());
  assert.notDeepEqual(mine.position(), busy[0].position(), 'while queued my booking is not where the busy cab is');
  const wait = mine.arrivesIn(kerbOf(start, NET));
  assert.ok(Number.isFinite(wait) && wait > 60, `a real wait (${wait} s)`);
  let t = 0;
  for (let i = 0; i < 40000 && mine.phase() !== 'pickup'; i++) {
    v.update(0.25);
    t += 0.25;
  }
  assert.equal(mine.phase(), 'pickup', 'in the end my cab comes');
  assert.ok(Math.abs(t - wait) < 3, `it comes when it said it would (${t} s against ${wait.toFixed(1)} s)`);
  assert.ok(dist(at(mine), kerbOf(start, NET)) < 0.5, 'to my kerb');
  v.dispose();
});

test('relaying the network re-plans a cab caught mid-errand onto the new streets', () => {
  const v = createVehicles(NET, 'high');
  const trip = tripOf({ x: 200, z: -40 }, { x: 1000, z: 260 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  const end = xz(trip.legs[k].path[trip.legs[k].path.length - 1]);
  const cab = v.summonCab(trip, k);
  for (let i = 0; i < 20000 && cab.phase() !== 'carrying'; i++) v.update(0.5);
  v.update(20);
  assert.equal(cab.phase(), 'carrying');
  const before = at(cab);
  const bigger = network({ blocks: 3, districts: [...SLOTS.slice(0, 6), { x: 960, z: 240 }] });
  v.relay(bigger);
  assert.ok(dist(at(cab), before) < 0.5, 'the cab does not jump');
  assert.equal(cab.phase(), 'carrying', 'and carries on with its rider');
  let setDown: P | null = null;
  for (let i = 0; i < 20000 && cab.phase() !== 'parked'; i++) {
    v.update(0.25);
    if (cab.phase() === 'setdown') setDown = at(cab);
  }
  assert.ok(dist(kerbOf(end, bigger), kerbOf(end, NET)) > 5, 'the new network moves the kerb off its new plaza');
  assert.ok(setDown && dist(setDown, kerbOf(end, bigger)) < 0.5, 'it sets down at the kerb the new network gives');
  v.dispose();
});

// ---------------------------------------------------------------- fix round 3

for (const phase of ['to-pickup', 'returning'] as const) {
  test(`relaying the network re-plans a cab caught ${phase} without a jump, and it still reaches its kerb or bay`, () => {
    const v = createVehicles(NET, 'high');
    const trip = tripOf({ x: 200, z: -40 }, { x: 1000, z: 260 });
    const k = trip.legs.findIndex((l) => l.mode === 'cab');
    const start = xz(trip.legs[k].path[0]);
    const cab = v.summonCab(trip, k);
    for (let i = 0; i < 40000 && cab.phase() !== phase; i++) v.update(0.25);
    v.update(phase === 'to-pickup' ? 5 : 10);
    assert.equal(cab.phase(), phase);
    const before = at(cab);
    const bigger = network({ blocks: 3, districts: [...SLOTS.slice(0, 6), { x: 960, z: 240 }] });
    v.relay(bigger);
    assert.ok(dist(at(cab), before) < 0.5, 'the cab does not jump');
    assert.equal(cab.phase(), phase);
    const phases: string[] = [phase];
    let picked: P | null = null;
    for (let i = 0; i < 40000 && cab.phase() !== 'parked'; i++) {
      v.update(0.25);
      if (phases[phases.length - 1] !== cab.phase()) phases.push(cab.phase());
      if (cab.phase() === 'pickup') picked ??= at(cab);
    }
    assert.equal(phases[phases.length - 1], 'parked', `it gets back to its bay (${phases.join(', ')})`);
    if (phase === 'to-pickup') assert.ok(picked && dist(picked, kerbOf(start, bigger)) < 0.5, 'it picks up at the kerb the new network gives');
    v.dispose();
  });
}
