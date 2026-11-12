import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BANKS,
  BOARD_WAIT_S,
  BRIDGES,
  CAB_WAIT_S,
  cabRanks,
  crossesRiver,
  extentBlocks,
  inChannel,
  network,
  POD_STREET,
  streetWay,
  tramHeight,
  PIERS,
  POD_Y,
  podRail,
  podStations,
  RAIL_Y,
  railLoop,
  railStations,
  RIVER,
  route,
  SPEED,
  tramLoop,
  tramStops,
} from '../shared/commute.js';
import { districtOrigin, QUARTER_COURT } from '../shared/district-layout.js';
import type { Trip } from '../shared/types.js';

type Leg = Trip['legs'][number];
type P = { x: number; z: number };

/** The sample city: six repos and five firms on slots 0 to 10, plus the exchange's own district list. */
const SAMPLE_SLOTS = Array.from({ length: 11 }, (_, i) => districtOrigin(i));
const NET = network({ blocks: extentBlocks(SAMPLE_SLOTS), districts: SAMPLE_SLOTS.slice(0, 6) });

const length = (path: ReadonlyArray<readonly number[]>): number => {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i][0] - path[i - 1][0], path[i][path[i].length - 1] - path[i - 1][path[i - 1].length - 1]);
  return d;
};
const xz = (p: readonly number[]): P => ({ x: p[0], z: p[p.length - 1] });
const first = (l: Leg): P => xz(l.path[0]);
const last = (l: Leg): P => xz(l.path[l.path.length - 1]);
const near = (a: P, b: P, tol = 0.5): boolean => Math.hypot(a.x - b.x, a.z - b.z) <= tol;

/** True when p lies strictly inside the closed polygon (even-odd rule). */
function inside(p: P, poly: ReadonlyArray<readonly number[]>): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = xz(poly[i]);
    const b = xz(poly[j]);
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/** Every leg joins the next, the trip starts and ends where asked, and each leg's time is its distance at its speed plus the wait. */
function wellFormed(legs: Leg[], from: P, to: P): void {
  assert.ok(legs.length > 0);
  assert.ok(near(first(legs[0]), from), `starts at ${JSON.stringify(first(legs[0]))}`);
  assert.ok(near(last(legs[legs.length - 1]), to), `ends at ${JSON.stringify(last(legs[legs.length - 1]))}`);
  for (let i = 1; i < legs.length; i++) assert.ok(near(last(legs[i - 1]), first(legs[i]), 1), `leg ${i} starts where leg ${i - 1} ends`);
  for (const l of legs) {
    const wait = l.mode === 'walk' ? 0 : l.mode === 'cab' ? CAB_WAIT_S : BOARD_WAIT_S;
    const want = (wait + length(l.path) / SPEED[l.mode]) * 1000;
    assert.ok(Math.abs(l.ms - want) <= 2, `${l.mode} takes ${l.ms} ms, want ${want.toFixed(0)}`);
  }
}

/** Walking keeps to the street grid: every step runs along x or along z. */
function manhattan(l: Leg): void {
  for (let i = 1; i < l.path.length; i++) {
    const a = xz(l.path[i - 1]);
    const b = xz(l.path[i]);
    assert.ok(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6, `step ${i} of a ${l.mode} leg runs on the grid: ${JSON.stringify([a, b])}`);
  }
}

/** Where a leg's path crosses the river's centre line: the z of each crossing. */
function riverCrossings(l: Leg): number[] {
  const out: number[] = [];
  for (let i = 1; i < l.path.length; i++) {
    const a = xz(l.path[i - 1]);
    const b = xz(l.path[i]);
    if (crossesRiver(a, b)) out.push(a.z + ((b.z - a.z) * (RIVER.x - a.x)) / (b.x - a.x));
  }
  return out;
}

test('the speeds and waits are the ruling 26 values', () => {
  assert.deepEqual({ ...SPEED }, { walk: 1.4, tram: 12, rail: 20, pod: 25, ferry: 6, cab: 11 });
  assert.equal(BOARD_WAIT_S, 20);
  assert.equal(CAB_WAIT_S, 30);
  assert.equal(RAIL_Y, 12);
  assert.equal(POD_Y, 18);
});

test('route walks a short trip', () => {
  const from = { x: 230, z: 250 };
  const to = { x: 310, z: 330 };
  const legs = route(from, to, NET);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].mode, 'walk');
  wellFormed(legs, from, to);
  manhattan(legs[0]);
  for (const p of legs[0].path) assert.equal(p[1], 0);
});

test('route takes the ferry across the river between piers and a bridge when far from piers', () => {
  // Beside the civic pier (east bank, z 72) to beside the west pier at z -72: the ferry.
  const from = { x: -300, z: 110 };
  const to = { x: -430, z: -120 };
  const legs = route(from, to, NET);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['walk', 'ferry', 'walk'],
  );
  wellFormed(legs, from, to);
  const ferry = legs[1];
  const civic = PIERS.find((p) => p.civic)!;
  const west = PIERS.find((p) => p.bank === 'west' && p.z === -72)!;
  assert.ok(near(first(ferry), { x: civic.x, z: civic.z }, 1), 'boards at the civic pier');
  assert.ok(near(last(ferry), { x: west.x, z: west.z }, 1), 'lands at the west pier');
  for (const p of ferry.path) assert.ok(p[0] >= BANKS.west - 0.01 && p[0] <= BANKS.east + 0.01, 'the ferry keeps to the river');
  for (const l of [legs[0], legs[2]]) assert.deepEqual(riverCrossings(l), [], 'nobody walks on water');

  // Far from every pier, across the river: on foot over the nearest bridge.
  const a = { x: -300, z: -300 };
  const b = { x: -420, z: -300 };
  for (const p of PIERS) assert.ok(Math.hypot(p.x - a.x, p.z - a.z) > 200 || Math.hypot(p.x - b.x, p.z - b.z) > 200);
  const walk = route(a, b, NET);
  assert.ok(walk.every((l) => l.mode !== 'ferry'));
  wellFormed(walk, a, b);
  const crossings = walk.flatMap(riverCrossings);
  assert.equal(crossings.length, 1);
  assert.ok((BRIDGES as readonly number[]).includes(Math.round(crossings[0])), `crosses on a bridge (z ${crossings[0]})`);
});

test('route takes a cab between 700 and 1500 m', () => {
  for (const [from, to] of [
    [{ x: 250, z: 230 }, { x: 250, z: -700 }],
    [{ x: -100, z: 300 }, { x: 900, z: 200 }],
  ] as Array<[P, P]>) {
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    assert.ok(d >= 700 && d <= 1500);
    const legs = route(from, to, NET);
    assert.deepEqual(
      legs.map((l) => l.mode),
      ['cab'],
    );
    wellFormed(legs, from, to);
    manhattan(legs[0]);
  }
  // A cab across the river drives over a bridge.
  const from = { x: -600, z: -260 };
  const to = { x: 200, z: 100 };
  const legs = route(from, to, NET);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['cab'],
  );
  const crossings = riverCrossings(legs[0]);
  assert.equal(crossings.length, 1);
  assert.ok((BRIDGES as readonly number[]).includes(Math.round(crossings[0])));
});

test('route takes the tram between 150 and 700 m, boarding and alighting at stops on the loop', () => {
  const loop = tramLoop(NET.blocks);
  const stops = tramStops(loop);
  const from = { x: 560, z: -300 };
  const to = { x: 600, z: 200 };
  const legs = route(from, to, NET);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['walk', 'tram', 'walk'],
  );
  wellFormed(legs, from, to);
  const tram = legs[1];
  assert.ok(stops.some((s) => near(s, first(tram))));
  assert.ok(stops.some((s) => near(s, last(tram))));
  for (const p of tram.path) assert.equal(p[1], 0);
});

test('route takes the pod across the city along a pod line and the rail when no pod line serves both ends', () => {
  const [xLine, zLine] = podRail(NET.blocks);
  // Along the x line, 1.5 km and more apart, each end within 300 m of it.
  const from = { x: -640, z: 160 };
  const to = { x: 900, z: 60 };
  assert.ok(Math.hypot(to.x - from.x, to.z - from.z) > 1500);
  const legs = route(from, to, NET);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['walk', 'pod', 'walk'],
  );
  wellFormed(legs, from, to);
  const pod = legs[1];
  const stations = podStations(xLine);
  assert.ok(stations.some((s) => near(s, first(pod))) && stations.some((s) => near(s, last(pod))), 'boards and alights at x-line stations');
  for (const p of pod.path) assert.equal(p[1], POD_Y);
  for (const p of pod.path) assert.equal(p[2], xLine[0][2], 'rides along the x line');
  assert.ok(zLine.every((p) => p[0] === zLine[0][0]), 'the z line runs along z');

  // Corner to corner, neither end within 300 m of a pod line: the elevated rail.
  const a = { x: 620, z: -640 };
  const b = { x: -640, z: 620 };
  const rail = route(a, b, NET);
  assert.deepEqual(
    rail.map((l) => l.mode),
    ['walk', 'rail', 'walk'],
  );
  wellFormed(rail, a, b);
  const ride = rail[1];
  const st = railStations(railLoop(NET.blocks));
  assert.ok(st.some((s) => near(s, first(ride))) && st.some((s) => near(s, last(ride))));
  for (const p of ride.path) assert.equal(p[1], RAIL_Y);
  for (const l of [rail[0], rail[2]]) assert.deepEqual(riverCrossings(l), []);
});

test('the tram loop and the rail loop enclose every district slot used', () => {
  for (const n of [1, 2, 8, 9, 11, 24, 25, 48, 49, 80]) {
    const used = Array.from({ length: n }, (_, i) => districtOrigin(i));
    const e = extentBlocks(used);
    const tram = tramLoop(e);
    const rail = railLoop(e);
    for (const o of [...used, { x: 0, z: 0 }]) {
      assert.ok(inside(o, tram), `${n} slots: the tram loop encloses ${JSON.stringify(o)}`);
      assert.ok(inside(o, rail), `${n} slots: the rail loop encloses ${JSON.stringify(o)}`);
    }
    // The rail stands outside the tram.
    for (const p of tram) assert.ok(inside(xz(p), rail), `${n} slots: the tram runs inside the rail`);
  }
});

test('the tram runs on street lines and crosses the river on its own bridge, clear of the road bridges, piers and quay lamps', () => {
  for (const e of [1, 2, 3, 4, 5]) {
    const loop = tramLoop(e);
    for (const [x, z] of loop) {
      assert.ok(((x - 40) / 80) % 1 === 0, `x ${x} is a street line`);
      assert.ok(((z - 40) / 80) % 1 === 0, `z ${z} is a street line`);
    }
    const closed = [...loop, loop[0]];
    let crossings = 0;
    for (let i = 1; i < closed.length; i++) {
      const a = { x: closed[i - 1][0], z: closed[i - 1][1] };
      const b = { x: closed[i][0], z: closed[i][1] };
      if (a.x === b.x) assert.ok(!inChannel(a.x, 12), `extent ${e}: never runs along the river at x ${a.x}`);
      if (!crossesRiver(a, b)) continue;
      crossings++;
      for (const bz of BRIDGES) assert.ok(Math.abs(a.z - bz) >= 30, `extent ${e}: its bridge at z ${a.z} stands clear of the road bridge at ${bz}`);
      for (const p of PIERS) assert.ok(Math.abs(a.z - p.z) >= 30, `extent ${e}: its bridge at z ${a.z} stands clear of the pier at ${p.z}`);
      // Quay lamps stand every 30 m (river.ts): the deck keeps 8 m off them.
      const lamp = Math.abs(a.z - Math.round(a.z / 30) * 30);
      assert.ok(lamp >= 8, `extent ${e}: its bridge at z ${a.z} keeps off the quay lamps (${lamp} m)`);
      assert.ok(tramHeight(RIVER.x, a.z) > 0.95, 'the deck rides over the quay parapets');
    }
    assert.equal(crossings, 2, `extent ${e}: the loop crosses the river twice`);
    for (const s of tramStops(loop)) assert.ok(!inChannel(s.x, 60), `extent ${e}: no stop on the river (${s.x})`);
  }
  assert.equal(tramHeight(0, 0), 0, 'off the river the tram runs at street level');
});

test('no line runs across a district plaza, a quarter court or the exchange', () => {
  for (const n of [1, 5, 9, 13, 25, 49, 80]) {
    const used = Array.from({ length: n }, (_, i) => districtOrigin(i));
    const net = network({ blocks: extentBlocks(used), districts: used });
    const lines: Array<[string, Array<readonly number[]>, boolean]> = [
      ['tram', net.tram.path, true],
      ['rail', net.rail.path, true],
      ...net.pods.map((l, i) => [`pod ${i}`, l.path, false] as [string, Array<readonly number[]>, boolean]),
    ];
    for (const [name, path, closed] of lines) {
      const m = closed ? path.length : path.length - 1;
      for (let i = 0; i < m; i++) {
        const a = xz(path[i]);
        const b = xz(path[(i + 1) % path.length]);
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let t = 0; t <= len; t += 2) {
          const p = { x: a.x + ((b.x - a.x) * t) / len, z: a.z + ((b.z - a.z) * t) / len };
          assert.ok(Math.hypot(p.x, p.z) >= 72, `${n} slots: the ${name} crosses the exchange's plaza at ${p.x},${p.z}`);
          for (const o of used) {
            // A slot is a district's round plaza or a firm's square court: both are kept clear.
            assert.ok(Math.hypot(p.x - o.x, p.z - o.z) >= 72, `${n} slots: the ${name} crosses the plaza at ${o.x},${o.z} (${p.x},${p.z})`);
            assert.ok(Math.max(Math.abs(p.x - o.x), Math.abs(p.z - o.z)) >= QUARTER_COURT, `${n} slots: the ${name} crosses the court at ${o.x},${o.z}`);
          }
        }
      }
    }
  }
});

test('a ride is taken only when it beats walking: two interior districts walk', () => {
  const walkMs = (a: P, b: P): number => (length(streetWay(a, b).map((p) => [p.x, p.z])) / SPEED.walk) * 1000;
  const a = { x: 240, z: 0 };
  const b = { x: 240, z: -240 };
  const legs = route(a, b, NET);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['walk'],
  );
  wellFormed(legs, a, b);
  // Wherever a ride is taken under 700 m it is quicker than the walk.
  for (const [p, q] of [
    [{ x: 0, z: 0 }, { x: 480, z: 0 }],
    [{ x: 240, z: 240 }, { x: -240, z: 240 }],
    [{ x: 560, z: -300 }, { x: 680, z: 200 }],
  ] as Array<[P, P]>) {
    const r = route(p, q, NET);
    const ms = r.reduce((s, l) => s + l.ms, 0);
    if (r.some((l) => l.mode === 'tram')) assert.ok(ms < walkMs(p, q), `the tram beats walking ${JSON.stringify([p, q])}`);
  }
});

test('pod riders change lines at the interchange when the ends lie by different lines', () => {
  const big = network({ blocks: 4, districts: [] });
  const [xLine, zLine] = big.pods;
  const from = { x: -1150, z: 150 };
  const to = { x: 150, z: 1150 };
  assert.ok(Math.hypot(to.x - from.x, to.z - from.z) > 1500);
  const legs = route(from, to, big);
  assert.deepEqual(
    legs.map((l) => l.mode),
    ['walk', 'pod', 'pod', 'walk'],
  );
  wellFormed(legs, from, to);
  const ix = { x: POD_STREET, z: POD_STREET };
  assert.ok(near(last(legs[1]), ix) && near(first(legs[2]), ix), 'they change at the interchange');
  for (const p of legs[1].path) assert.equal(p[2], xLine.path[0][2], 'the first ride runs along the x line');
  for (const p of legs[2].path) assert.equal(p[0], zLine.path[0][0], 'the second runs along the z line');
});

test('stations stand along their lines: rail stations clear of the river, pod stations every 240 m', () => {
  const rail = railLoop(2);
  for (const p of rail) assert.equal(p[1], RAIL_Y);
  const st = railStations(rail);
  assert.ok(st.length >= 8, `${st.length} rail stations`);
  for (const s of st) assert.ok(!inChannel(s.x, 80), `no station over the river (${s.x})`);
  for (const line of podRail(2)) {
    const ps = podStations(line).filter((s) => !s.interchange);
    for (let i = 1; i < ps.length; i++) assert.equal(Math.round(ps[i].at - ps[i - 1].at), 240);
    assert.ok(podStations(line).some((s) => s.interchange), 'the two lines meet at an interchange');
    for (const p of line) assert.equal(p[1], POD_Y);
  }
});

test('one cab rank per district plaza and one at the exchange', () => {
  const districts = SAMPLE_SLOTS.slice(0, 6);
  const ranks = cabRanks({ blocks: 2, districts });
  assert.equal(ranks.length, districts.length + 1);
  assert.ok(ranks.some((r) => r.exchange));
  for (const d of districts) assert.ok(ranks.some((r) => !r.exchange && Math.hypot(r.x - d.x, r.z - d.z) < 120), `a rank beside ${JSON.stringify(d)}`);
});

test('viaduct bents, pod pylons and catenary poles stand mid-block, never in a street crossing, the river or on a quay', async () => {
  const { spanSupports, QUAY } = await import('../shared/commute.js');
  const runs: Array<[P, P]> = [
    [{ x: 680, z: -680 }, { x: -680, z: -680 }],
    [{ x: -720, z: 120 }, { x: 720, z: 120 }],
    [{ x: 120, z: 720 }, { x: 120, z: -720 }],
  ];
  for (const [a, b] of runs) {
    const along = a.z === b.z ? 'x' : 'z';
    const us = spanSupports(a, b);
    assert.ok(us.length > 30);
    for (let i = 0; i < us.length; i++) {
      const u = us[i];
      // 16 m streets on the 80 m pitch: a support keeps 10 m off a crossing's centre line.
      const off = Math.abs((((u - 40) % 80) + 80) % 80);
      assert.ok(Math.min(off, 80 - off) >= 10, `${u} stands clear of the crossing`);
      if (along === 'x') assert.ok(!inChannel(u, QUAY), `${u} stands off the river and its quays`);
      if (i) assert.ok(Math.abs(us[i] - us[i - 1]) <= 81, `spans stay short off the river (${us[i - 1]} to ${u})`);
    }
    // In order from a to b.
    const sign = Math.sign((along === 'x' ? b.x - a.x : b.z - a.z) || 1);
    for (let i = 1; i < us.length; i++) assert.ok((us[i] - us[i - 1]) * sign > 0);
  }
});
