import './figure-setup.js';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';

import { figureLevel, FIGURES_BUDGET, hasFigures } from '../app/src/city/figures.js';
import { FIGURE_CODE, FIGURE_PART, JOINT, skinPoint } from '../app/src/city/ambient.js';

// The people modelled in the kit pipeline (tools/kits/figures.py), read from figures.glb in Node.

const levelOf = (l: 'hi' | 'lo'): THREE.BufferGeometry => {
  const g = figureLevel(l);
  assert.ok(g, `figure.${l} is registered`);
  return g;
};
const trianglesBy = (g: THREE.BufferGeometry, pick: (code: number, part: number) => boolean): number => {
  const idx = g.index!;
  const surf = g.attributes.aSurf;
  let n = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const v = idx.getX(i);
    if (pick(Math.round(surf.getX(v)), Math.round(surf.getY(v)))) n++;
  }
  return n;
};

test('figures.glb stays inside its budget', () => {
  assert.ok(hasFigures(), 'both levels load');
  const size = statSync(new URL('../app/public/kits/figures.glb', import.meta.url)).size;
  assert.ok(size <= FIGURES_BUDGET, `figures.glb is ${(size / 1000).toFixed(0)} KB (budget ${FIGURES_BUDGET / 1000} KB)`);
});

test('the close level is a modelled person: a face, hands, clothes and every variant a crowd wears', () => {
  const hi = levelOf('hi');
  const tris = hi.index!.count / 3;
  assert.ok(tris > 9000 && tris < 19000, `${tris} triangles across every variant`);
  const C = FIGURE_CODE;
  assert.ok(trianglesBy(hi, (c) => c === C.eye) >= 100, 'eyes');
  assert.ok(trianglesBy(hi, (c) => c === C.lip) >= 40, 'lips');
  assert.ok(trianglesBy(hi, (c) => c === C.skin) >= 3000, 'a sculpted head and two hands');
  assert.ok(trianglesBy(hi, (c) => c === C.coat) >= 3000, 'a coat with its sleeves');
  assert.ok(trianglesBy(hi, (c) => c === C.shirt) > 0 && trianglesBy(hi, (c) => c === C.sole) > 0, 'a shirt in the V and soles under the shoes');
  for (const [name, part] of Object.entries(FIGURE_PART)) {
    if (part === 0) continue;
    assert.ok(trianglesBy(hi, (_, p) => p === part) >= 300, `variant ${name}`);
  }
  // The baked occlusion darkens somewhere (the eye sockets, under the collar) and leaves the open faces lit.
  const ao = hi.attributes.aSurf;
  let dark = 0;
  let lit = 0;
  for (let i = 0; i < ao.count; i++) (ao.getW(i) < 140 ? dark++ : ao.getW(i) > 200 ? lit++ : 0);
  assert.ok(dark > 100 && lit > ao.count / 3, `occlusion baked (${dark} dark, ${lit} lit of ${ao.count})`);
});

test('every point has a unit normal and a finite position (a zero normal turns to NaN in the shader and blacks out the frame)', () => {
  for (const l of ['hi', 'lo'] as const) {
    const g = levelOf(l);
    const n = g.attributes.normal;
    const p = g.attributes.position;
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      assert.ok(len > 0.9 && len < 1.1, `${l} point ${i} has a normal of length ${len.toFixed(3)}`);
      assert.ok(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i)), `${l} point ${i} is finite`);
    }
  }
});

test('the near level is the same figure at a fraction of the triangles', () => {
  const hi = levelOf('hi').index!.count / 3;
  const lo = levelOf('lo').index!.count / 3;
  assert.ok(lo < hi * 0.25 && lo > 1500, `lo ${lo} against hi ${hi}`);
});

test('every point is bound to the bones that move it, blending across the joints', () => {
  const g = levelOf('hi');
  const p = g.attributes.position;
  const s = g.attributes.aSkin;
  let blended = 0;
  for (let i = 0; i < p.count; i++) {
    const a = s.getX(i);
    const b = s.getY(i);
    const w = s.getZ(i) / 255;
    assert.ok(a >= 0 && a <= 9 && b >= 0 && b <= 9 && w >= 0 && w <= 1, `point ${i} has bones ${a}, ${b} and weight ${w}`);
    if (w > 0.05 && w < 0.95 && a !== b) blended++;
    const y = p.getY(i);
    const z = p.getZ(i);
    const bone = w < 0.5 ? a : b;
    if (y > 1.6) assert.equal(bone, 1, `a point at ${y.toFixed(2)} m goes with the head`);
    if (y < 0.4 && y > 0.05 && Math.abs(z) > 0.04 && Math.abs(z) < 0.16) assert.equal(bone, z < 0 ? 3 : 5, `a point at ${y.toFixed(2)} m goes with its shin`);
  }
  assert.ok(blended > 500, `${blended} points blend two bones (knees, elbows, hips, shoulders, neck)`);
});

test('skinning bends the knee smoothly: no point of the trouser leg is torn from its neighbours', () => {
  const g = levelOf('hi');
  const idx = g.index!;
  const p = g.attributes.position;
  const skin = g.attributes.aSkin;
  const surf = g.attributes.aSurf;
  const pose = { kneeR: 1.2, hipR: 0.6 };
  const at = (i: number): THREE.Vector3 => skinPoint(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)), skin.getX(i), skin.getY(i), skin.getZ(i) / 255, pose);
  let worst = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const v = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    if (Math.round(surf.getX(v[0])) !== FIGURE_CODE.legs || p.getZ(v[0]) < 0.03) continue;
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      const rest = new THREE.Vector3(p.getX(a), p.getY(a), p.getZ(a)).distanceTo(new THREE.Vector3(p.getX(b), p.getY(b), p.getZ(b)));
      const bent = at(a).distanceTo(at(b));
      if (rest > 1e-4) worst = Math.max(worst, bent / rest);
    }
  }
  assert.ok(worst < 3, `the most an edge stretches with the knee bent is ${worst.toFixed(2)} times`);
  assert.ok(JOINT.knee[1] > 0.4, 'the knee joint the test bends about');
});
