import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COURT_APRON, RESERVE_RADIUS } from '../app/src/city/collar.js';
import { pontoonOf, RIVER_BED, riverFeet, WATER_Y } from '../app/src/city/river-bed.js';
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

test('every pier foot is within 0.2 m of the riverbed', () => {
  const feet = riverFeet();
  // The stone bridge's two piers (a cutwater each face), the steel arch's two abutments, the stayed deck's shelf, and
  // two guide piles at every ferry pier.
  assert.ok(feet.length >= 4 + 2 + 1 + 2 * PIERS.length, `${feet.length} feet`);
  for (const f of feet) {
    assert.ok(Math.abs(f.y - RIVER_BED) <= 0.2, `the ${f.what} at (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) stands at ${f.y} m, the bed at ${RIVER_BED} m`);
    assert.ok(f.x > BANKS.west - 3 && f.x < BANKS.east + 3, `the ${f.what} stands in the river (${f.x.toFixed(1)})`);
  }
  // Under the water, which lies over the bed.
  assert.ok(RIVER_BED < WATER_Y - 2, 'the bed lies under the water');
  for (const p of PIERS) {
    const pt = pontoonOf(p);
    assert.ok(pt.deck > WATER_Y && pt.deck < WATER_Y + 1.2, 'the pontoon floats a deck just over the water');
    for (const q of pt.piles) assert.ok(q.x > BANKS.west && q.x < BANKS.east, 'its piles stand in the water');
  }
});

// ---------------------------------------------------------------- the ferries' wake (Phase 5 Task 5)

import { wakeArm, wakeHeight, WAKE } from '../app/src/city/wake.js';

test('the wake height along its arm has no gap longer than 0.5 m', () => {
  // The crest the water draws along each arm of the Kelvin wedge (wake.ts wakeHeight: the shader's own ridge, its
  // amplitude, width and decay), sampled every 2 cm at the arm's line at several moments, for a ferry at its service
  // speed seen from near. The arm is where the ridge stands over what the water shows as a crest (WAKE.visible): it
  // must reach at least 100 m astern, and within it never fall under that for more than 0.5 m (a dash's gap).
  for (const t of [0, 1.7, 4.3, 9.1]) {
    let reach = 0;
    for (let b = 0; b <= WAKE.reach; b += 0.02) {
      if (wakeHeight(b, 0, t) >= WAKE.visible) reach = b;
    }
    assert.ok(reach >= 100, `at t ${t} the arm is visible to ${reach.toFixed(1)} m astern`);
    let gap = 0;
    let longest = 0;
    for (let b = 0; b <= reach; b += 0.02) {
      if (wakeHeight(b, 0, t) < WAKE.visible) gap += 0.02;
      else gap = 0;
      longest = Math.max(longest, gap);
    }
    assert.ok(longest <= 0.5, `at t ${t} the crest falls away for ${longest.toFixed(2)} m`);
    // The ridge is a ridge: highest on the arm's line, down to nothing a few widths across.
    assert.ok(wakeHeight(40, 0, t) > wakeHeight(40, WAKE.width(40), t) && wakeHeight(40, 4 * WAKE.width(40), t) < WAKE.visible * 0.1);
  }
  // The envelope decays: half as high at 90 m astern as at the bow, or less; a boat lying still leaves none.
  assert.ok(WAKE.decay(90) <= WAKE.decay(0) * 0.5);
  assert.equal(wakeHeight(20, 0, 1, 0), 0);
  // The crest's wander never breaks it: wakeArm stays over 0.7 of its envelope, and is never negative.
  for (let b = 0; b <= WAKE.reach; b += 0.5) assert.ok(wakeArm(b, 2.2) >= 0.7 * WAKE.decay(b) - 1e-9 && wakeArm(b, 2.2) >= 0);
});
