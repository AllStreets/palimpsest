import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { contactQuad, contactWeight, createContactShadows, lightAxes } from '../app/src/city/contact-shadow.js';
import { LAYER } from '../app/src/city/lod.js';
import { SUN_DIRECTION } from '../app/src/city/sky.js';

const HALF = 320;

test('far towers are shadowed at wide home: a contact shadow past the shadow map, none inside it', () => {
  const axes = lightAxes(SUN_DIRECTION);
  const at = { x: -40, y: 0, z: 0 };
  // Inside the map's box: the real shadow map shades it, so no contact shadow doubles it.
  assert.equal(contactWeight({ x: -40, z: 0 }, at, axes, HALF), 0);
  assert.equal(contactWeight({ x: 60, z: 80 }, at, axes, HALF), 0);
  // Well past the box (the sample's far towers from home's target): the whole contact shadow.
  assert.equal(contactWeight({ x: 900, z: 700 }, at, axes, HALF), 1);
  // It fades in across the box's last quarter, never a step.
  let last = 0;
  for (let d = 0; d <= 1200; d += 10) {
    const w = contactWeight({ x: at.x + d, z: at.z }, at, axes, HALF);
    assert.ok(w >= last - 1e-12, `monotonic at ${d} m`);
    assert.ok(w - last < 0.2, `no step at ${d} m`);
    last = w;
  }
});

test("a contact shadow covers its tower's foot and runs away from the sun, longer for a taller tower up to its cap", () => {
  const foot = { x: 100, z: 200, half: 14, height: 300 };
  const q = contactQuad(foot, SUN_DIRECTION);
  const away = new THREE.Vector2(-SUN_DIRECTION.x, -SUN_DIRECTION.z).normalize();
  const dir = new THREE.Vector2(Math.sin(q.heading), Math.cos(q.heading));
  assert.ok(dir.dot(away) > 0.999, 'it points away from the sun');
  // Its start lies behind the foot's centre by the half width: the footprint stands in it.
  const start = new THREE.Vector2(q.x, q.z).addScaledVector(dir, -q.length / 2);
  assert.ok(Math.abs(start.distanceTo(new THREE.Vector2(foot.x, foot.z)) - foot.half) < 1e-6);
  assert.ok(q.width >= foot.half * 2, 'as wide as the tower');
  const short = contactQuad({ ...foot, height: 80 }, SUN_DIRECTION);
  const tall = contactQuad({ ...foot, height: 2000 }, SUN_DIRECTION);
  assert.ok(short.length < q.length && q.length <= tall.length);
  assert.ok(tall.length <= 220 + foot.half, 'capped');
});

test('the contact shadows are one draw, in the view alone', () => {
  const c = createContactShadows(SUN_DIRECTION, HALF);
  c.set([
    { x: 0, z: 0, half: 14, height: 200 },
    { x: 400, z: -300, half: 17, height: 120 },
  ]);
  assert.equal(c.object.count, 2);
  assert.equal(c.object.layers.mask, 1 << LAYER.view, 'never in the shadow map or the AO');
  assert.ok(!c.object.castShadow);
  c.dispose();
});

test("a tongue's tip never draws NaN: every pow in its shader takes a base held at or above zero", () => {
  // The rasteriser interpolates v a hair past 1 at the tip's pixels; pow of a negative base is NaN in GLSL (on Metal
  // too), and the bloom's mip chain spread one such pixel over the whole frame: the overview drawn flat black.
  const shadows = createContactShadows(SUN_DIRECTION, HALF);
  const mat = shadows.object.material as THREE.ShaderMaterial;
  for (const src of [mat.vertexShader, mat.fragmentShader]) {
    for (const m of src.matchAll(/\bpow\s*\(/g)) {
      const base = src.slice(m.index! + m[0].length).trimStart();
      assert.match(base, /^(max|clamp|abs)\s*\(/, `pow(${base.slice(0, 30)}... may take a negative base`);
    }
  }
  shadows.dispose();
});
