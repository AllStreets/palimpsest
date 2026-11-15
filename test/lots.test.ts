import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CollarPlaza } from '../app/src/city/collar.js';
import { blockLots, farLot, farLotStands, lotParts, PITCH, RING_REACH, standingLots, towerTones } from '../app/src/city/lots.js';
import { lookFor } from '../app/src/city/tower/variants.js';
import { BANKS, BRIDGE_APPROACH, BRIDGE_DECK, BRIDGES, QUAY } from '../shared/commute.js';
import { districtOrigin } from '../shared/district-layout.js';

const CIVIC: CollarPlaza = { x: 0, z: 0 };
const overlaps = (x: number, w: number, a: number, b: number): boolean => x + w / 2 > a && x - w / 2 < b;

test('lots the river crosses become quays with no buildings', () => {
  let given = 0;
  // The block columns either side of the river, the length of the detailed city.
  for (let i = -7; i <= -2; i++) {
    for (let j = -22; j <= 22; j++) {
      const before = blockLots(i, j).filter((l) => overlaps(l.x, l.w, BANKS.west - QUAY, BANKS.east + QUAY)).length;
      given += before;
      for (const plazas of [[CIVIC], [CIVIC, { ...districtOrigin(4), rootHeight: 30 }]]) {
        for (const lot of standingLots(i, j, plazas)) {
          assert.ok(!overlaps(lot.x, lot.w, BANKS.west - QUAY, BANKS.east + QUAY), `block ${i},${j}: a ${lot.archetype} on the quay`);
          // Not a bay, a tank or a roof part reaches over the quay either.
          for (const p of lotParts(lot)) assert.ok(!overlaps(p.x, p.sx, BANKS.west - QUAY + 0.5, BANKS.east + QUAY - 0.5), `block ${i},${j}: ${p.kind} over the quay`);
        }
      }
    }
  }
  // The river really took lots: the blocks it runs through had buildings there.
  assert.ok(given > 40, `${given} lots given to the river`);
  // The far ring keeps off the river too.
  for (let i = -6; i <= -3; i++) {
    for (let j = -40; j <= 40; j++) {
      const l = farLot(i, j);
      if (farLotStands(i, j)) assert.ok(!overlaps(l.x, l.w, BANKS.west - QUAY, BANKS.east + QUAY), `far lot ${i},${j}`);
    }
  }
});

test('no building stands across a bridge approach', () => {
  for (const bz of BRIDGES) {
    for (let i = -7; i <= -2; i++) {
      for (let j = Math.round(bz / 80) - 2; j <= Math.round(bz / 80) + 2; j++) {
        for (const lot of standingLots(i, j, [CIVIC])) {
          const inX = overlaps(lot.x, lot.w, BANKS.west - QUAY - BRIDGE_APPROACH, BANKS.east + QUAY + BRIDGE_APPROACH);
          const inZ = overlaps(lot.z, lot.d, bz - BRIDGE_DECK / 2 - 2, bz + BRIDGE_DECK / 2 + 2);
          assert.ok(!(inX && inZ), `block ${i},${j}: a ${lot.archetype} across the bridge at ${bz}`);
        }
      }
    }
  }
});

test('blocks away from the river keep every lot', () => {
  for (const [i, j] of [[0, 5], [3, -2], [-1, 9], [-8, 0], [6, 6]]) {
    assert.equal(standingLots(i, j, []).length, blockLots(i, j).length, `block ${i},${j}`);
  }
});

test('a look change retones only its own lot', () => {
  // Two towers' rings reach a block: A's covers part of it, B's the far side. When A's look changes (a re-measure, a
  // sale, another firm's colours), the lots in A's ring may take new tones; every lot outside it keeps its tone, its
  // type and its height, and B's ring never hears of it.
  const SAMPLE = ['tidewater/harbor-ledger', 'kestrel/fieldnotes', 'lantern/assay-kit', 'ferro/quarry', 'hoshi/kumo', 'alder/blank-slate'];
  const looks = SAMPLE.map((r) => towerTones(lookFor(r)));
  let inRing = 0;
  let outRing = 0;
  const bad: string[] = [];
  for (const [i, j] of [[0, 5], [3, -2], [-1, 9], [6, 6], [2, 3], [-8, 0], [4, -5], [1, 7], [5, 1], [-3, -6]]) {
    const ax = i * PITCH + 170;
    const az = j * PITCH + 60;
    const b: CollarPlaza = { x: i * PITCH - 150, z: j * PITCH - 80, rootHeight: 30, ...looks[5] };
    for (let k = 0; k < looks.length - 1; k++) {
      const was = standingLots(i, j, [CIVIC, { x: ax, z: az, rootHeight: 30, ...looks[k] }, b]);
      const now = standingLots(i, j, [CIVIC, { x: ax, z: az, rootHeight: 30, ...looks[k + 1] }, b]);
      assert.equal(was.length, now.length, `block ${i},${j}: a look change moved a lot`);
      for (let n = 0; n < was.length; n++) {
        const l0 = was[n];
        const l1 = now[n];
        assert.equal(l0.index, l1.index);
        const same = l0.tone === l1.tone && l0.archetype === l1.archetype && l0.h === l1.h;
        if (Math.hypot(l0.x - ax, l0.z - az) <= RING_REACH) {
          if (!same) inRing++;
        } else {
          outRing++;
          if (!same) bad.push(`block ${i},${j}, look ${k} to ${k + 1}: lot ${n} at ${l0.x.toFixed(0)},${l0.z.toFixed(0)} went ${l0.tone} ${l0.archetype} ${l0.h} to ${l1.tone} ${l1.archetype} ${l1.h}`);
        }
      }
    }
  }
  assert.ok(outRing > 40, `${outRing} lots stood outside A's ring`);
  assert.ok(inRing > 0, 'the looks differ enough that some lot in the ring takes a new tone');
  assert.deepEqual(bad, [], `${bad.length} lots outside the ring retoned:\n${bad.slice(0, 12).join('\n')}`);
});

test('the far ring gathers into clusters and breaks within blocks, off the river and never overlapping', async () => {
  // Task 7: farLots is the far ring's skyline. Deterministic by block; each block's buildings stand inside the block,
  // clear of the river's ground and of each other; some blocks stand two buildings and some carry a cluster's tower.
  const lots = (await import('../app/src/city/lots.js')) as unknown as Record<string, unknown>;
  const farLots = lots.farLots as ((i: number, j: number) => Array<{ x: number; z: number; w: number; d: number; h: number }>) | undefined;
  assert.ok(farLots, 'the far ring has its skyline (lots.ts farLots)');
  let two = 0;
  let tall = 0;
  let blocks = 0;
  for (let i = -40; i <= 40; i += 3) {
    for (let j = -40; j <= 40; j += 3) {
      if (Math.max(Math.abs(i), Math.abs(j)) <= 22 || !farLotStands(i, j)) continue;
      blocks++;
      const a: Array<{ x: number; z: number; w: number; d: number; h: number }> = farLots!(i, j);
      assert.deepEqual(farLots!(i, j), a, `block ${i},${j} is deterministic`);
      if (a.length > 1) two++;
      if (a.some((l) => l.h > 40)) tall++;
      for (const l of a) {
        assert.ok(Math.abs(l.x - i * PITCH) + l.w / 2 <= 32.5 && Math.abs(l.z - j * PITCH) + l.d / 2 <= 32.5, `block ${i},${j}: a building past its block`);
        if (i >= -6 && i <= -3) assert.ok(!overlaps(l.x, l.w, BANKS.west - QUAY, BANKS.east + QUAY), `far lot ${i},${j} on the river`);
      }
      for (let p = 0; p < a.length; p++) {
        for (let q = p + 1; q < a.length; q++) {
          const clear = Math.abs(a[p].x - a[q].x) >= (a[p].w + a[q].w) / 2 || Math.abs(a[p].z - a[q].z) >= (a[p].d + a[q].d) / 2;
          assert.ok(clear, `block ${i},${j}: two buildings overlap`);
        }
      }
    }
  }
  assert.ok(two > blocks * 0.2 && two < blocks * 0.8, `${two} of ${blocks} blocks stand a second building`);
  assert.ok(tall > blocks * 0.03 && tall < blocks * 0.5, `${tall} of ${blocks} blocks carry a cluster's tower`);
  // The facades' far form fades in before it is whole, and only well past the near city's detail.
  const lod = (await import('../app/src/city/lod.js')) as unknown as Record<string, unknown>;
  const form = lod.FAR_FORM as { near: number; full: number } | undefined;
  assert.ok(form && form.near >= 300 && form.near < form.full, `FAR_FORM ${JSON.stringify(form)}`);
});
