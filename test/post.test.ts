import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOOM_THRESHOLD, SUN_BLOOM_MAX } from '../app/src/city/post.js';
import { SKY_GLSL, skyClear, skyHaze, SUN_DIRECTION } from '../app/src/city/sky.js';

type V3 = [number, number, number];

/** Directions over the whole sky, dense along the horizon and through the sun's bearing, where the glow peaks. */
function directions(): V3[] {
  const out: V3[] = [];
  const sunAz = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  const heights = [-0.02, 0, 0.0005, 0.002, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8, 1];
  for (let k = 0; k < 720; k++) {
    const az = sunAz + ((k - 360) / 360) * Math.PI;
    for (const h of heights) {
      const r = Math.sqrt(Math.max(0, 1 - h * h));
      out.push([Math.cos(az) * r, h, Math.sin(az) * r]);
    }
  }
  out.push([SUN_DIRECTION.x, 0, SUN_DIRECTION.z]);
  out.push([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);
  return out;
}

test("the sun's bloom stays under SUN_BLOOM_MAX at any view", () => {
  // The cap sits under the bloom threshold: the sky itself, the sun's glow included, never reaches the bloom pass,
  // so a low view toward the sun keeps its upper right (the glow is a bright warm band, not a blown region).
  assert.ok(SUN_BLOOM_MAX < BLOOM_THRESHOLD, `${SUN_BLOOM_MAX} under the threshold ${BLOOM_THRESHOLD}`);
  let peak = 0;
  let raw = 0;
  let hazePeak = 0;
  for (const d of directions()) {
    const c = skyClear(d);
    const h = skyHaze(d);
    const r = skyClear(d, Infinity);
    peak = Math.max(peak, ...c);
    hazePeak = Math.max(hazePeak, ...h);
    raw = Math.max(raw, ...r);
    // The cap scales the colour, never clips a channel: the glow keeps its hue.
    const m = Math.max(...r);
    if (m > 1e-6) for (let k = 0; k < 3; k++) assert.ok(Math.abs(c[k] / Math.max(...c) - r[k] / m) < 1e-9, 'the cap keeps the hue');
  }
  assert.ok(peak <= SUN_BLOOM_MAX + 1e-9, `the sky peaks at ${peak.toFixed(4)}`);
  assert.ok(hazePeak <= SUN_BLOOM_MAX + 1e-9, `the fog colour peaks at ${hazePeak.toFixed(4)}`);
  // The cap is load bearing: uncapped, the glow toward the sun would bloom.
  assert.ok(raw > BLOOM_THRESHOLD, `the uncapped glow peaks at ${raw.toFixed(3)}`);
  // The shader carries the same cap, so what the test holds is what the GPU draws.
  assert.ok(SKY_GLSL.includes(`SUN_BLOOM_MAX = ${SUN_BLOOM_MAX.toFixed(4)}`), 'the GLSL names the cap');
});

test('under the cap the sky is untouched, and the glow still rises toward the sun', () => {
  // Away from the sun the cap does nothing: the zenith and the violet side keep their values to the last digit.
  const away: V3 = [-SUN_DIRECTION.x, 0.05, -SUN_DIRECTION.z];
  assert.deepEqual(skyClear(away), skyClear(away, Infinity));
  assert.deepEqual(skyClear([0, 1, 0]), skyClear([0, 1, 0], Infinity));
  // Toward the sun the capped glow still brightens monotonically as the bearing closes on it (a soft knee, not a plateau).
  const sunAz = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  let last = 0;
  for (let k = 40; k >= 0; k--) {
    const az = sunAz + (k / 40) * 0.6;
    const c = skyClear([Math.cos(az), 0.003, Math.sin(az)]);
    assert.ok(c[0] >= last - 1e-9, `the glow dips at ${k}`);
    last = c[0];
  }
});
