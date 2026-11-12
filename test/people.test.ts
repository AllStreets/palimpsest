import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { extentBlocks, network, route } from '../shared/commute.js';
import { districtOrigin } from '../shared/district-layout.js';
import type { Agent, Trip } from '../shared/types.js';
import { createPeople, strideRate } from '../app/src/city/people.js';
import { createVehicles } from '../app/src/city/vehicles.js';
import { FOUNTAIN } from '../app/src/city/exchange.js';

type P = { x: number; z: number };

const SLOTS = Array.from({ length: 11 }, (_, i) => districtOrigin(i));
const NET = network({ blocks: extentBlocks(SLOTS), districts: SLOTS.slice(0, 6) });

const agentOf = (id: string, retired = false): Agent =>
  ({ id, firmId: 'firm-a', name: id, persona: '', retired, retiredReason: null, towerIndex: 0, silhouette: 'plain' }) as unknown as Agent;

const tripOf = (agentId: string, from: P, to: P, startedAt = new Date(0).toISOString()): Trip => {
  const legs = route(from, to, NET);
  return { id: `trip-${agentId}`, agentId, firmId: 'firm-a', reason: 'job', jobId: null, from, to, legs, startedAt, ms: legs.reduce((s, l) => s + l.ms, 0), endedAt: null };
};

/** The point `s` metres along a leg's path. */
function along(path: Array<[number, number, number]>, s: number): [number, number, number] {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (s <= len) {
      const t = len ? s / len : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    s -= len;
  }
  return path[path.length - 1];
}

test("a figure's position follows its legs by elapsed time", () => {
  // A 120 m walk (under WALK_MAX): one walk leg at 1.4 m/s.
  const trip = tripOf('ada', { x: 440, z: 200 }, { x: 440, z: 320 });
  assert.equal(trip.legs.length, 1);
  assert.equal(trip.legs[0].mode, 'walk');
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => null, net: () => NET, now: () => start });
  people.set([trip], [agentOf('ada')]);
  people.update(10);
  const p = people.positionOf('ada');
  assert.ok(p, 'the figure stands somewhere');
  // The leg runs up the street's centre line toward +z; the figure keeps to the pavement 6 m to its right.
  const want = along(trip.legs[0].path, 14);
  want[0] -= 6;
  assert.ok(Math.hypot(p.x - want[0], p.z - want[2]) < 0.3, `ten seconds in it has walked 14 m along the pavement (${p.x.toFixed(1)}, ${p.z.toFixed(1)} against ${want[0]}, ${want[2]})`);
  // A trip that started 30 s before the page looked picks up where it would be.
  const late = createPeople({ vehicles: () => null, net: () => NET, now: () => start + 30_000 });
  late.set([trip], [agentOf('ada')]);
  late.update(0);
  const q = late.positionOf('ada')!;
  const want30 = along(trip.legs[0].path, 42);
  want30[0] -= 6;
  assert.ok(Math.hypot(q.x - want30[0], q.z - want30[2]) < 0.3, `it joins its trip 42 m along (${q.x.toFixed(1)}, ${q.z.toFixed(1)})`);
  // Past the trip's time it stands at the destination, and a moment later has stopped walking.
  people.update(200);
  people.update(1);
  const end = people.positionOf('ada')!;
  assert.ok(Math.hypot(end.x - trip.to.x, end.z - trip.to.z) < 0.3, 'it arrives and stands at the end');
  const fig = people.figures().find((f) => f.agentId === 'ada')!;
  assert.equal(fig.walking, 0, 'and stops walking there');
});

test('the stride turns at the pace the figure moves, so the feet do not slide', () => {
  // One cycle of the walk (phase 2 pi) is two steps of 2 L sin(A) each: the phase rate follows the speed.
  const A = 0.42;
  const step = 2 * 0.86 * Math.sin(A);
  const rate = strideRate(1.4, A, 1);
  assert.ok(Math.abs((rate / Math.PI) * step - 1.4) < 1e-9, `${rate.toFixed(3)} rad/s at 1.4 m/s`);
  assert.ok(strideRate(0.7, A, 1) < rate, 'a slower walk turns slower');
  assert.ok(strideRate(1.4, A, 1.1) < rate, 'a taller figure takes fewer steps');
});

test('a figure in a cab moves with the cab', () => {
  // 446.5, 330 to 1100, -200 is a cab trip (over TRAM_MAX, under CAB_MAX).
  const trip = tripOf('bo', { x: 446.5, z: 330 }, { x: 1100, z: -200 });
  const k = trip.legs.findIndex((l) => l.mode === 'cab');
  assert.ok(k >= 0, 'the trip takes a cab');
  const v = createVehicles(NET, 'high');
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => v, net: () => NET, now: () => start });
  people.set([trip], [agentOf('bo')]);
  people.update(0);
  let ride = people.rideOf('bo');
  assert.ok(ride && ride.mode === 'cab' && ride.id, `a cab is summoned at once (${JSON.stringify(ride)})`);
  const cab = v.vehicles('cab').find((c) => c.id === ride!.id)!;
  // Until the cab pulls in, the figure waits at the kerb by the leg's start.
  const wait = people.positionOf('bo')!;
  assert.ok(Math.hypot(wait.x - 446.5, wait.z - 330) < 8, `it waits by the leg's start (${wait.x.toFixed(1)}, ${wait.z.toFixed(1)})`);
  let t = 0;
  for (; t < 600 && cab.phase() !== 'carrying'; t++) {
    v.update(1);
    people.update(1);
  }
  assert.equal(cab.phase(), 'carrying', 'the cab picks it up and drives');
  // Through the pickup the figure got in: it now sits in the cab and moves with it.
  const fig = people.figures().find((f) => f.agentId === 'bo')!;
  assert.equal(fig.stage, 'ride');
  assert.ok(fig.sit > 0.99, `it sits (${fig.sit})`);
  for (let i = 0; i < 8; i++) {
    v.update(1);
    people.update(1);
    const p = people.positionOf('bo')!;
    const c = cab.position();
    assert.ok(Math.hypot(p.x - c[0], p.z - c[2]) < 1.5, `it rides in the cab (${Math.hypot(p.x - c[0], p.z - c[2]).toFixed(2)} m off)`);
    assert.ok(Math.abs(p.y - cab.floorY()) < 1.0, `at the cab's floor (${p.y.toFixed(2)} against ${cab.floorY().toFixed(2)})`);
  }
  const far = people.positionOf('bo')!;
  assert.ok(Math.hypot(far.x - wait.x, far.z - wait.z) > 10, 'and has left the kerb behind');
  // The cab sets it down at the leg's end and the figure walks on.
  for (let i = 0; i < 900 && people.figures().find((f) => f.agentId === 'bo')!.stage === 'ride'; i++) {
    v.update(1);
    people.update(1);
  }
  ride = people.rideOf('bo');
  const out = people.positionOf('bo')!;
  const end = trip.legs[k].path.at(-1)!;
  assert.ok(Math.hypot(out.x - end[0], out.z - end[2]) < 12, `it steps out by the leg's end (${Math.hypot(out.x - end[0], out.z - end[2]).toFixed(1)} m)`);
});

test('beyond 400 m only the lantern renders', () => {
  const trip = tripOf('cy', { x: 440, z: 200 }, { x: 440, z: 320 });
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => null, net: () => NET, now: () => start });
  people.set([trip], [agentOf('cy')]);
  const camera = new THREE.PerspectiveCamera(36, 1.6, 0.5, 20000);
  const look = (d: number): void => {
    camera.position.set(440 + d, 1.7 + d * 0.3, 200);
    camera.lookAt(440, 1, 200);
    camera.updateMatrixWorld();
    people.update(0.016, camera);
  };
  look(20);
  let v = people.view(camera);
  assert.equal(v.figures, 1);
  assert.ok(v.near === 1 && v.far === 0 && v.lanterns === 0, `at 20 m the near figure draws (${JSON.stringify(v)})`);
  assert.ok(v.triangles > 1500, `with real detail (${v.triangles} triangles)`);
  look(250);
  v = people.view(camera);
  assert.ok(v.near === 0 && v.far === 1 && v.lanterns === 0, `at 250 m the far figure draws (${JSON.stringify(v)})`);
  look(500);
  v = people.view(camera);
  assert.ok(v.near === 0 && v.far === 0 && v.lanterns === 1, `at 500 m only its lantern draws (${JSON.stringify(v)})`);
  assert.ok(v.meshes <= 1, `in one call (${v.meshes})`);
});

test('follow releases when the trip ends', () => {
  const trip = tripOf('di', { x: 440, z: 200 }, { x: 440, z: 320 });
  const start = Date.parse(trip.startedAt);
  let released = 0;
  const people = createPeople({ vehicles: () => null, net: () => NET, now: () => start, onRelease: () => released++ });
  people.set([trip], [agentOf('di')]);
  people.update(1);
  people.follow('di');
  assert.equal(people.following(), 'di');
  people.update(1);
  const pose = people.followPose();
  assert.ok(pose, 'the camera has a figure to follow');
  const p = people.positionOf('di')!;
  assert.ok(pose!.position.distanceTo(p) < 1e-6, 'the pose is the figure itself');
  // The trip ends (it is no longer among the live trips): the follow lets go, and the figure stands where it got to.
  people.set([], [agentOf('di')]);
  assert.equal(people.following(), null);
  assert.equal(released, 1);
  assert.equal(people.followPose(), null);
  assert.ok(people.positionOf('di'), 'the figure stays in the city');
  // Following an agent that retires lets go too.
  people.set([trip], [agentOf('di')]);
  people.follow('di');
  people.set([trip], [agentOf('di', true)]);
  assert.equal(people.following(), null);
  assert.equal(released, 2);
  assert.equal(people.positionOf('di'), null, 'a retired agent has no figure');
  // Following an agent with no figure does nothing.
  people.follow('nobody');
  assert.equal(people.following(), null);
});

test('a ride that reports retired() is boarded again', () => {
  // A fake vehicles dep: the first ride is retired at once (its network was laid anew); the second runs.
  const trip = tripOf('ed', { x: 560, z: -300 }, { x: 600, z: 200 });
  const k = trip.legs.findIndex((l) => l.mode === 'tram');
  assert.ok(k >= 0);
  let boards = 0;
  const ride = (retired: boolean, n: number) => ({
    id: `tram:${n}`,
    vehicle: `tram:${n}`,
    kind: 'tram' as const,
    track: 't',
    position: () => [0, 0, 0] as [number, number, number],
    heading: () => 0,
    speed: () => 0,
    floorY: () => 0.4,
    arrivesIn: () => 99,
    phase: () => 'running' as const,
    retired: () => retired,
    boardsIn: () => 99,
    alightsIn: () => 199,
  });
  const fake = {
    board: () => {
      const n = boards++;
      return ride(n === 0, n);
    },
    summonCab: () => ride(false, 9),
  } as unknown as import('../app/src/city/vehicles.js').Vehicles;
  const start = Date.parse(trip.startedAt) - trip.legs[0].ms - 1000;
  const people = createPeople({ vehicles: () => fake, net: () => NET, now: () => start + trip.legs[0].ms + 1000 });
  // Joined with the first walk leg done: it waits for the tram at once.
  people.set([{ ...trip, startedAt: new Date(start).toISOString() }], [agentOf('ed')]);
  people.update(0.1);
  assert.equal(people.rideOf('ed')?.id, 'tram:0', 'the first ride is held');
  people.update(0.1);
  assert.equal(boards, 2, 'a retired ride is boarded again');
  assert.equal(people.rideOf('ed')?.id, 'tram:1');
  people.update(0.1);
  assert.equal(boards, 2, 'a live ride is kept');
});

test('a tram rider stands on the platform, rides, and alights at the far stop', () => {
  const trip = tripOf('fay', { x: 560, z: -300 }, { x: 600, z: 200 });
  const k = trip.legs.findIndex((l) => l.mode === 'tram');
  const leg = trip.legs[k];
  const v = createVehicles(NET, 'high');
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => v, net: () => NET, now: () => start });
  people.set([trip], [agentOf('fay')]);
  const fig = () => people.figures().find((f) => f.agentId === 'fay')!;
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      v.update(1);
      people.update(1);
    }
  };
  for (let t = 0; t < 600 && !(fig().mode === 'tram' && fig().stage === 'wait'); t++) tick(1);
  tick(1);
  assert.equal(fig().stage, 'wait', 'she walks to the stop and waits');
  // On the platform: 4.1 m right of the line's centre (the right-hand track is 2 m out, the platform from 3.45 m),
  // a step up the platform from the stop, 25 cm up on its kerb.
  const a = leg.path[0];
  const b = leg.path[1];
  const h = Math.atan2(b[2] - a[2], b[0] - a[0]);
  const p = people.positionOf('fay')!;
  const right = -(p.x - a[0]) * Math.sin(h) + (p.z - a[2]) * Math.cos(h);
  const fwd = (p.x - a[0]) * Math.cos(h) + (p.z - a[2]) * Math.sin(h);
  assert.ok(Math.abs(right - 4.1) < 0.05 && Math.abs(fwd - 5.5) < 0.05, `on the platform beside the track (${right.toFixed(2)} right, ${fwd.toFixed(2)} along)`);
  assert.ok(Math.abs(p.y - (a[1] + 0.25)) < 0.01, `on the platform's kerb (${p.y})`);
  const tram = people.rideOf('fay')!;
  assert.equal(tram.mode, 'tram');
  const ref = v.vehicles('tram').find((x) => x.id === tram.id)!;
  for (let t = 0; t < 900 && fig().stage !== 'ride'; t++) tick(1);
  assert.equal(fig().stage, 'ride', 'she boards when the tram stands at the stop');
  tick(40);
  const q = people.positionOf('fay')!;
  const at = ref.position();
  assert.ok(Math.hypot(q.x - at[0], q.z - at[2]) < 1.5 && Math.abs(q.y - ref.floorY()) < 0.01, 'and rides at its floor');
  assert.ok(fig().sit === 0, 'standing, holding on');
  for (let t = 0; t < 900 && fig().mode === 'tram'; t++) tick(1);
  assert.notEqual(fig().mode, 'tram', 'she alights');
  const end = leg.path[leg.path.length - 1];
  const r = people.positionOf('fay')!;
  assert.ok(Math.hypot(r.x - end[0], r.z - end[2]) < 12, `by the far stop (${Math.hypot(r.x - end[0], r.z - end[2]).toFixed(1)} m)`);
});

test('a rider stepping into a cab never crosses its body except through the door', () => {
  const trip = tripOf('gus', { x: 446.5, z: 330 }, { x: 1100, z: -200 });
  const v = createVehicles(NET, 'high');
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => v, net: () => NET, now: () => start });
  people.set([trip], [agentOf('gus')]);
  people.update(0);
  const cab = v.vehicles('cab').find((c) => c.id === people.rideOf('gus')!.id)!;
  const fig = () => people.figures().find((f) => f.agentId === 'gus')!;
  // The cab's body: 1.45 m behind its centre to 1.1 m ahead of it inside, 0.8 m wide inside (CAB_INTERIOR), the shell a little more.
  const HALF = { front: 1.45, rear: 1.75, side: 0.95 };
  let worst = Infinity;
  for (let t = 0; t < 900 && fig().stage !== 'ride'; t++) {
    v.update(0.25);
    people.update(0.25);
    const f = fig();
    if (f.sit > 0) continue;
    const c = cab.position();
    const h = cab.heading();
    const fwd = (f.position[0] - c[0]) * Math.cos(h) + (f.position[2] - c[2]) * Math.sin(h);
    const right = -(f.position[0] - c[0]) * Math.sin(h) + (f.position[2] - c[2]) * Math.cos(h);
    const outside = fwd > HALF.front || fwd < -HALF.rear || Math.abs(right) > HALF.side;
    worst = Math.min(worst, Math.max(fwd - HALF.front, -HALF.rear - fwd, Math.abs(right) - HALF.side));
    assert.ok(outside, `on foot the figure stays outside the cab's body (${fwd.toFixed(2)} along, ${right.toFixed(2)} across, ${f.stage})`);
  }
  assert.equal(fig().stage, 'ride');
  assert.ok(worst > 0, `at its closest it was ${worst.toFixed(2)} m clear`);
});

test('a trip ending at the exchange point keeps clear of the fountain', () => {
  // The engine's exchange point used to be the fountain's centre: a figure stands off the basin's rim.
  const trip = tripOf('hal', { x: 0, z: -60 }, { x: 0, z: 40 });
  const start = Date.parse(trip.startedAt);
  const people = createPeople({ vehicles: () => null, net: () => NET, now: () => start });
  people.set([trip], [agentOf('hal')]);
  for (let t = 0; t < 200; t++) {
    people.update(1);
    const p = people.positionOf('hal')!;
    assert.ok(Math.hypot(p.x - FOUNTAIN.x, p.z - FOUNTAIN.z) > FOUNTAIN.radius, `never in the basin (${p.x.toFixed(1)}, ${p.z.toFixed(1)} at ${t} s)`);
  }
  const p = people.positionOf('hal')!;
  const out = Math.hypot(p.x - FOUNTAIN.x, p.z - FOUNTAIN.z);
  assert.ok(out > FOUNTAIN.radius && out < FOUNTAIN.radius + 4, `stands just off the rim (${out.toFixed(1)} m out)`);
});

test('dispose() takes the figures and their meshes away', () => {
  const trip = tripOf('ivy', { x: 440, z: 200 }, { x: 440, z: 320 });
  const start = Date.parse(trip.startedAt);
  let released = 0;
  const people = createPeople({ vehicles: () => null, net: () => NET, now: () => start, onRelease: () => released++ });
  people.set([trip], [agentOf('ivy')]);
  people.follow('ivy');
  assert.ok(people.group.children.length >= 3);
  people.dispose();
  assert.equal(people.group.children.length, 0, 'no meshes stay in the group');
  assert.equal(people.figures().length, 0);
  assert.equal(people.following(), null);
  assert.equal(released, 1, 'a follow is let go');
  assert.equal(people.positionOf('ivy'), null);
  const camera = new THREE.PerspectiveCamera(36, 1.6, 0.5, 20000);
  people.update(0.016, camera);
  assert.equal(people.view(camera).figures, 0, 'an update after dispose is harmless');
});
