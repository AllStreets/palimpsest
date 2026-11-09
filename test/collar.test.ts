import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ambientCap, cappedHeight, ROOT_RING, ROOF_CLUTTER } from '../app/src/city/collar.js';
import { ROOT_HEIGHT } from '../shared/tower-layout.js';

const district = (rootHeight: number) => ({ x: 240, z: 0, rootHeight });

test('inside the ring round a district, ambient buildings and their roofs stay below its root', () => {
  for (const root of Object.values(ROOT_HEIGHT)) {
    for (let gap = 90; gap < ROOT_RING; gap += 7) {
      const cap = ambientCap(240 + gap, 0, [district(root)]);
      // Any lot, however tall it was drawn, is cut to a whole number of floors under the cap.
      const h = cappedHeight(400, cap);
      assert.ok(h + ROOF_CLUTTER < root, `root ${root} m, ${gap} m out: ${h} m plus roof clutter`);
    }
  }
});

test('past the ring the skyline rises again with distance', () => {
  const near = ambientCap(240 + ROOT_RING + 20, 0, [district(30)]);
  const far = ambientCap(240 + ROOT_RING + 200, 0, [district(30)]);
  assert.ok(near < far);
  assert.ok(far > 60);
});

test('the lowest cap of any nearby plaza wins', () => {
  const both = ambientCap(120, 0, [district(24), { x: 0, z: 0 }]);
  assert.equal(both, Math.min(ambientCap(120, 0, [district(24)]), ambientCap(120, 0, [{ x: 0, z: 0 }])));
});

test('a plaza with no root (the civic plaza, a site) keeps the old collar', () => {
  assert.equal(ambientCap(90, 0, [{ x: 0, z: 0 }]), 26);
  assert.equal(ambientCap(5000, 0, [{ x: 0, z: 0 }]), Infinity);
});

test('cappedHeight never lifts a short lot', () => {
  assert.equal(cappedHeight(12.0, 40), 12.0);
});
