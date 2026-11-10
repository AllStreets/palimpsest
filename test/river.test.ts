import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COURT_APRON, RESERVE_RADIUS } from '../app/src/city/collar.js';
import { BANKS, BRIDGE_DECK, BRIDGES, crossesRiver, PIER_HALF, PIERS, RIVER } from '../shared/commute.js';
import { districtOrigin, QUARTER_COURT } from '../shared/district-layout.js';

test('the river is 56 m wide on the street line at x = -360, with bridges at z -480, 0 and 480', () => {
  assert.deepEqual({ ...RIVER }, { x: -360, width: 56 });
  assert.deepEqual([...BRIDGES], [-480, 0, 480]);
  assert.equal(BANKS.east - BANKS.west, 56);
});

test('the river clears every district reserve by 2 m', () => {
  let tightest = Infinity;
  for (let slot = 0; slot < 2000; slot++) {
    const o = districtOrigin(slot);
    // The nearer bank, less the reserve round the district: never under 2 m.
    const gap = Math.abs(o.x - RIVER.x) - RIVER.width / 2 - RESERVE_RADIUS;
    assert.ok(gap >= 2 - 1e-9, `slot ${slot} at x ${o.x}: ${gap} m`);
    tightest = Math.min(tightest, gap);
    // A firm's quarter on the same slot keeps its court and apron inside that reserve.
    assert.ok(Math.abs(o.x - RIVER.x) - RIVER.width / 2 - (QUARTER_COURT + COURT_APRON) >= 2);
  }
  // The columns either side of the river stand exactly 2 m off its banks: the spiral is unchanged.
  assert.equal(tightest, 2);
});

test('crossesRiver detects a crossing', () => {
  assert.equal(crossesRiver({ x: -480, z: 0 }, { x: -240, z: 0 }), true);
  assert.equal(crossesRiver({ x: -240, z: 300 }, { x: -500, z: -900 }), true);
  assert.equal(crossesRiver({ x: -240, z: 0 }, { x: 240, z: 960 }), false);
  assert.equal(crossesRiver({ x: -480, z: 0 }, { x: -1200, z: 480 }), false);
});

test('a pier every 480 m from z -1440 to 1440 on alternating banks, one at the civic end, none on a bridge', () => {
  assert.equal(PIERS.length, 8);
  const listed = PIERS.filter((p) => !p.civic);
  assert.equal(listed.length, 7);
  for (const [k, p] of listed.entries()) {
    const at = -1440 + 480 * k;
    // Where a listed place falls on a bridge the pier stands just upstream of it.
    assert.ok(p.z === at || ((BRIDGES as readonly number[]).includes(at) && p.z < at && at - p.z <= 80), `pier ${k} at ${p.z}`);
    if (k > 0) assert.notEqual(p.bank, listed[k - 1].bank);
    assert.equal(p.x, BANKS[p.bank]);
  }
  const civic = PIERS.find((p) => p.civic)!;
  // The civic end is the city's bank (east), beside the stone bridge on the civic axis.
  assert.equal(civic.bank, 'east');
  assert.ok(Math.abs(civic.z) < 120);
  for (const p of PIERS) for (const b of BRIDGES) assert.ok(Math.abs(p.z - b) - PIER_HALF - BRIDGE_DECK / 2 >= 20, `pier at ${p.z} clears the bridge at ${b}`);
});
