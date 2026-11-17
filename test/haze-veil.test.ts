/**
 * The haze's veil over the mid-distance band (tools/haze-veil.ts): read
 * against clear air in the same run, so the city's own lights never count as
 * haze.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HAZE_VEIL_LUMA, hazeVeil } from '../tools/haze-veil.js';

test('the milky haze of round 0 is a veil; the city lit brighter under a thin haze is not', () => {
  // Round 0 from home: 76.7 over clear air's 57, the veil Task 15a cleared.
  assert.equal(hazeVeil({ mean: 76.7 }, { mean: 57 }).holds, false);
  // Task 15a's after: 58.14 over 57.
  assert.equal(hazeVeil({ mean: 58.14 }, { mean: 57 }).holds, true);
  // The full run on phase-5 (2026-11-17): 63.37 over clear air's 61.43. The absolute 62 failed it on the city's lights.
  const now = hazeVeil({ mean: 63.37 }, { mean: 61.43 });
  assert.equal(now.holds, true);
  assert.ok(Math.abs(now.veil - 1.94) < 1e-9);
  // Task 15a's ceiling, 62 over 57, is the line.
  assert.equal(hazeVeil({ mean: 57 + HAZE_VEIL_LUMA }, { mean: 57 }).holds, true);
  assert.equal(hazeVeil({ mean: 57 + HAZE_VEIL_LUMA + 0.01 }, { mean: 57 }).holds, false);
  assert.equal(hazeVeil({ mean: NaN }, { mean: 57 }).holds, false);
});
