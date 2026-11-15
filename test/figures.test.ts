import './figure-setup.js';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';

import { figureLevel, FIGURES_BUDGET, FIGURES_SKIN_BUDGET, hasFigures } from '../app/src/city/figures.js';
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
  assert.ok(tris > 9000 && tris < 21000, `${tris} triangles across every variant`);
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

// ---------------------------------------------------------------- faces, hands and hair up close (Phase 5 Task 3)

test('figures-skin.webp stays within FIGURES_SKIN_BUDGET', () => {
  assert.equal(FIGURES_SKIN_BUDGET, 262_144);
  const file = new URL('../app/public/kits/figures-skin.webp', import.meta.url);
  const size = statSync(file).size;
  assert.ok(size > 20_000 && size <= FIGURES_SKIN_BUDGET, `figures-skin.webp is ${size} bytes (budget ${FIGURES_SKIN_BUDGET})`);
  // A WebP of 1024 by 1024 (RIFF....WEBPVP8X carries the canvas size minus one in 24 bits each).
  const b = readFileSync(file);
  assert.equal(b.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(b.subarray(8, 12).toString('latin1'), 'WEBP');
  const chunk = b.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    assert.deepEqual([w, h], [1024, 1024]);
  } else if (chunk === 'VP8 ') {
    const w = b.readUInt16LE(26) & 0x3fff;
    const h = b.readUInt16LE(28) & 0x3fff;
    assert.deepEqual([w, h], [1024, 1024]);
  } else assert.fail(`a VP8 or VP8X WebP, not ${chunk}`);
});

test('the close level maps the face and hands onto the skin atlas and wears its hair as shaped cards', () => {
  const hi = levelOf('hi');
  const uv = hi.attributes.uv;
  assert.ok(uv && uv.itemSize === 2, 'the close level carries uvs');
  const surf = hi.attributes.aSurf;
  const p = hi.attributes.position;
  let skinMapped = 0;
  let skinPoints = 0;
  let other = 0;
  for (let i = 0; i < surf.count; i++) {
    const code = Math.round(surf.getX(i));
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (code === FIGURE_CODE.skin || code === FIGURE_CODE.lip) {
      skinPoints++;
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `skin point ${i} maps inside the atlas (${u.toFixed(3)}, ${v.toFixed(3)})`);
      if (u > 0 || v > 0) skinMapped++;
    } else if (u !== 0 || v !== 0) other++;
  }
  assert.ok(skinMapped > skinPoints * 0.98, `${skinMapped} of ${skinPoints} skin points carry a uv`);
  assert.equal(other, 0, 'nothing but skin is mapped');
  // Hair cards: thin strips of a few triangles each over the hair masses of the short, long and bun styles, in their variant.
  const idx = hi.index!;
  const cards = (part: number): number => {
    // A card's triangles have a point lifted off the hair mass: count hair triangles whose blush (the card's shade) is set.
    let n = 0;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i);
      if (Math.round(surf.getX(a)) === FIGURE_CODE.hair && Math.round(surf.getY(a)) === part && hi.attributes.aSkin.getW(a) > 0 && hi.attributes.aSkin.getW(a) !== 128) n++;
    }
    return n;
  };
  for (const [name, part] of [['short', FIGURE_PART.short], ['long', FIGURE_PART.long], ['bun', FIGURE_PART.bun]] as const) {
    assert.ok(cards(part) >= 300, `${name} hair wears cards (${cards(part)} triangles)`);
  }
  assert.equal(cards(FIGURE_PART.buzz), 0, 'a buzz cut wears none');
  // The cards lie over the scalp, within the head's reach.
  for (let i = 0; i < p.count; i++) {
    if (Math.round(surf.getX(i)) !== FIGURE_CODE.hair) continue;
    assert.ok(p.getY(i) > 1.35 && p.getY(i) < 1.86 && Math.abs(p.getZ(i)) < 0.16 && p.getX(i) > -0.2 && p.getX(i) < 0.16, `hair point ${i} is on the head`);
  }
  const tris = hi.index!.count / 3;
  assert.ok(tris < 21000, `${tris} triangles across every variant`);
});

test("the crowd level's positions are quantised and read back in metres", () => {
  const b = readFileSync(new URL('../app/public/kits/figures.glb', import.meta.url));
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString()) as { nodes: Array<{ name: string; mesh: number; translation?: number[]; scale?: number[] }>; meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>; accessors: Array<{ componentType: number; normalized?: boolean }>; extensionsRequired?: string[] };
  assert.ok(j.extensionsRequired?.includes('KHR_mesh_quantization'));
  for (const name of ['figure.hi', 'figure.lo']) {
    const node = j.nodes.find((n) => n.name === name)!;
    const pos = j.accessors[j.meshes[node.mesh].primitives[0].attributes.POSITION];
    assert.equal(pos.componentType, 5122, `${name} positions are int16`);
    assert.equal(pos.normalized, true);
    assert.ok(node.scale && node.translation, `${name} carries the node transform that puts them back in metres`);
    const nrm = j.accessors[j.meshes[node.mesh].primitives[0].attributes.NORMAL];
    assert.equal(nrm.componentType, 5120, `${name} normals are int8`);
  }
  for (const l of ['hi', 'lo'] as const) {
    const g = levelOf(l);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    assert.ok(box.min.y > -0.03 && box.max.y > 1.7 && box.max.y < 1.9, `${l} stands 1.75 m tall from the ground (${box.min.y.toFixed(3)} to ${box.max.y.toFixed(3)})`);
    assert.ok(Math.abs(box.min.z + box.max.z) < 0.02, `${l} is symmetrical about z (${box.min.z.toFixed(3)}, ${box.max.z.toFixed(3)})`);
  }
});
