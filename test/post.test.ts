import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOOM_THRESHOLD, cocInfinity, createLens, DOF, focusModeFor, LENS_COMPOSITE_GLSL, LENS_GLSL, SUN_BLOOM_MAX } from '../app/src/city/post.js';
import * as THREE from 'three';

import { installSkyFog, SKY_DITHER, SKY_GLSL, skyAir, skyClear, skyHaze, SUN_DIRECTION } from '../app/src/city/sky.js';

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

// ---------------------------------------------------------------- the lens (Phase 5 Task 11, ruling 16)

/** Steps a lens for `seconds` in sixtieths. */
function run(lens: ReturnType<typeof createLens>, seconds: number): number {
  let a = lens.state().amount;
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) a = lens.step(1 / 60).amount;
  return a;
}

test('depth of field is off from home, the overview and past 160 m', () => {
  // From home and the overview the camera holds no close mode: nothing scripted, followed or inspected.
  assert.equal(focusModeFor({ script: null, following: false, inspecting: false }), null);
  assert.equal(focusModeFor({ script: 'ride', following: false, inspecting: true }), 'ride');
  assert.equal(focusModeFor({ script: 'tour', following: false, inspecting: false }), 'tour');
  assert.equal(focusModeFor({ script: null, following: true, inspecting: true }), 'follow');
  assert.equal(focusModeFor({ script: null, following: false, inspecting: true }), 'inspect');
  const lens = createLens('high');
  for (const distance of [1180, 640]) {
    lens.set({ mode: null, distance });
    assert.equal(run(lens, 2), 0, `no mode at ${distance} m is off`);
    assert.equal(lens.state().on, false);
  }
  // Any close mode farther than DOF.reach from its subject is off, and the lens fades to nothing before it.
  assert.equal(DOF.reach, 160);
  for (const mode of ['ride', 'follow', 'tour', 'inspect'] as const) {
    lens.set({ mode, distance: 161 });
    assert.equal(run(lens, 2), 0, `${mode} past 160 m is off`);
  }
  assert.equal(cocInfinity(160), 0);
  assert.equal(cocInfinity(400), 0);
  for (let d = 4; d < 160; d += 4) assert.ok(cocInfinity(d) >= cocInfinity(d + 4) - 1e-12, `the aperture closes as the subject recedes (${d} m)`);
  // Close up the lens is on, with a real background blur.
  lens.set({ mode: 'ride', distance: 9 });
  assert.equal(run(lens, 1), 1);
  assert.ok(lens.state().on);
  assert.ok(lens.state().blur > 0.003, `the background's blur at 9 m is ${lens.state().blur}`);
});

test('it is never on at medium', () => {
  const lens = createLens('medium');
  for (const mode of ['ride', 'follow', 'tour', 'inspect'] as const) {
    for (const distance of [2, 9, 40, 120]) {
      lens.set({ mode, distance });
      assert.equal(run(lens, 1.5), 0, `${mode} at ${distance} m on medium`);
      assert.equal(lens.state().on, false);
      assert.equal(lens.state().blur, 0);
    }
  }
});

test('focus eases over 0.6 s', () => {
  assert.equal(DOF.ease, 0.6);
  const lens = createLens('high');
  lens.set({ mode: 'follow', distance: 12 });
  const quarter = run(lens, 0.15);
  const half = run(lens, 0.15);
  assert.ok(quarter > 0 && quarter < half && half < 1, `on: ${quarter.toFixed(3)} then ${half.toFixed(3)} by 0.3 s`);
  assert.ok(Math.abs(half - 0.5) < 0.05, `halfway at 0.3 s (${half.toFixed(3)})`);
  assert.ok(run(lens, 0.25) < 1, 'not there before 0.6 s');
  assert.equal(run(lens, 0.06), 1, 'there at 0.6 s');
  // Off again over the same 0.6 s, the focus held where it was while the blur goes.
  lens.set({ mode: null, distance: 900 });
  const off = run(lens, 0.3);
  assert.ok(Math.abs(off - 0.5) < 0.05, `halfway off at 0.3 s (${off.toFixed(3)})`);
  assert.equal(lens.state().distance, 12, 'the focus holds its subject while it eases off');
  assert.equal(run(lens, 0.31), 0, 'gone at 0.6 s');
  // The blur eases with it: never a jump in one frame.
  lens.set({ mode: 'inspect', distance: 60 });
  let last = 0;
  for (let i = 0; i < 40; i++) {
    const b = lens.step(1 / 60).blur;
    assert.ok(b - last <= cocInfinity(60) / 12, `frame ${i} steps the blur by ${(b - last).toFixed(5)}`);
    last = b;
  }
});

test("the lens's composite dithers what it blurs, as the sky does, so the dusk gradient does not band again", () => {
  assert.ok(LENS_COMPOSITE_GLSL.includes(SKY_DITHER.toFixed(6)), 'the composite carries the sky dither');
  // No GLSL ES 3.0 reserved word as a name (Task 10 lost a round to one).
  for (const word of ['patch', 'sample', 'input', 'output', 'filter', 'active', 'common', 'partition', 'resource']) {
    for (const src of LENS_GLSL) assert.doesNotMatch(src, new RegExp(`\\b(float|vec[234]|int)\\s+${word}\\b`), `${word} is not a name`);
  }
});
