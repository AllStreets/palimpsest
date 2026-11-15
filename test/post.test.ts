import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOOM_THRESHOLD, SUN_BLOOM_MAX } from '../app/src/city/post.js';
import * as THREE from 'three';

import { installSkyFog, SKY_GLSL, skyAir, skyClear, skyHaze, SUN_DIRECTION } from '../app/src/city/sky.js';

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

test("the haze takes each surface toward the sky's colour at its own height", () => {
  // At street level the air is the horizon's haze in every bearing, so fogged ground still meets the dome with no seam;
  // higher up it is the cooler sky above the horizon band, so a wall or a crown does not fade into the same mauve as
  // the street under it (the one mauve-brown of round 0).
  const sunAz = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  const blueOverRed = (c: V3): number => c[2] / c[0];
  for (let k = 0; k < 12; k++) {
    const az = sunAz + (k / 12) * Math.PI * 2;
    const d: V3 = [Math.cos(az), -0.1, Math.sin(az)];
    const ground = skyAir(d, 0);
    const haze = skyHaze(d);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(ground[i] - haze[i]) < 1e-9, `at bearing ${k} the street's air is the horizon's haze`);
    let last = blueOverRed(ground);
    for (const y of [30, 80, 150, 250, 400]) {
      const c = skyAir(d, y);
      assert.ok(blueOverRed(c) > last - 1e-9, `at bearing ${k} the air at ${y} m is no warmer than below it`);
      last = blueOverRed(c);
      assert.ok(Math.max(...c) <= SUN_BLOOM_MAX + 1e-9, 'the air stays under the cap');
    }
    // A crown's air is visibly cooler than the street's, not a shade of the same colour.
    assert.ok(blueOverRed(skyAir(d, 400)) > blueOverRed(ground) * 1.3, `at bearing ${k} the crown's air ${blueOverRed(skyAir(d, 400)).toFixed(3)} against the street's ${blueOverRed(ground).toFixed(3)}`);
  }
  // The fog the GPU draws reads the fragment's own height.
  installSkyFog();
  assert.match(THREE.ShaderChunk.fog_fragment, /hazeOver\([^;]*vFogWorld\.y\s*\)/);
  assert.match(SKY_GLSL, /vec3 skyAir\(vec3 dir, float y\)/);
});
