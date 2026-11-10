import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CollarPlaza } from '../app/src/city/collar.js';
import { blockLots, farLot, farLotStands, lotParts, standingLots } from '../app/src/city/lots.js';
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
