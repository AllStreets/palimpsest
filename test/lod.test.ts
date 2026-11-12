import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';

import {
  AMBIENT_LOD,
  AO_NEAR,
  boxDistance,
  detailHidden,
  LAYER,
  lodFade,
  passLayers,
  selectBlocks,
  setLayers,
  shadowColumn,
  type BlockBox,
} from '../app/src/city/lod.js';

// The sample city's home framing (view.ts) and its target.
const HOME = { x: 540, y: 380, z: 960 };
const HOME_TARGET = { x: -40, y: 70, z: 0 };
const SUN = new THREE.Vector3(-260, 40, 120).normalize();

const block = (x: number, z: number, h = 40): BlockBox => ({ minX: x - 32, maxX: x + 32, minY: 0, maxY: h, minZ: z - 32, maxZ: z + 32 });

test('the fade between the near and the far level runs from 0 to 1 across the band, and is monotonic', () => {
  assert.equal(lodFade(0), 0);
  assert.equal(lodFade(AMBIENT_LOD.near), 0);
  assert.equal(lodFade(AMBIENT_LOD.far), 1);
  assert.equal(lodFade(5000), 1);
  let last = 0;
  for (let d = 0; d < 1000; d += 5) {
    const f = lodFade(d);
    assert.ok(f >= last, `fade never steps back at ${d}`);
    last = f;
  }
  // The near level is gone before the far one has finished arriving: never a gap, never both full.
  const mid = lodFade((AMBIENT_LOD.near + AMBIENT_LOD.far) / 2);
  assert.ok(mid > 0.3 && mid < 0.7);
});

test('a box is as far as its nearest point, and zero from inside it', () => {
  const b = block(0, 0);
  assert.equal(boxDistance({ x: 0, y: 10, z: 0 }, b), 0);
  assert.equal(boxDistance({ x: 132, y: 10, z: 0 }, b), 100);
  assert.equal(boxDistance({ x: 0, y: 140, z: 0 }, b), 100);
  assert.ok(Math.abs(boxDistance({ x: 35, y: 44, z: 0 }, b) - 5) < 1e-9);
});

test('the near set holds every block with any point inside the far edge of the band, and nothing past it', () => {
  const blocks: BlockBox[] = [];
  for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) blocks.push(block(i * 80, j * 80));
  const eye = { x: 0, y: 2, z: 0 };
  const near = new Set(selectBlocks(blocks, (b) => boxDistance(eye, b) < AMBIENT_LOD.far));
  for (const [k, b] of blocks.entries()) {
    // Every point of a block left out is past the band: its kit could only have faded out.
    if (!near.has(k)) assert.ok(boxDistance(eye, b) >= AMBIENT_LOD.far);
    else assert.ok(boxDistance(eye, b) < AMBIENT_LOD.far);
  }
  // From home the camera stands over a kilometre off: no block of the sample city's centre keeps its kit.
  assert.ok(boxDistance(HOME, block(0, 0)) > AMBIENT_LOD.far);
});

test('AO keeps everything that can show any: the near limit lies past where the AO has faded, measured from the eye', () => {
  const post = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'city', 'post.ts'), 'utf8');
  const end = Number(/AO_FADE_END = (\d+)/.exec(post)![1]);
  assert.ok(AO_NEAR >= end, `${AO_NEAR} against ${end}`);
  // The fade runs on distance from the eye, so a frame corner fades no later than its centre.
  assert.match(post, /AO_FADE_END\.toFixed\(1\)\}, dist\)/);
});

test('the shadow column takes what stands round the target and what can throw a shadow into it, and nothing else', () => {
  const inColumn = shadowColumn(SUN, HOME_TARGET, { half: 320, offset: 800, near: 10, far: 1600 });
  // The block under the target casts.
  assert.ok(inColumn(block(-40, 0)));
  // A block 1.5 km away across the sun's line throws no shadow into the box.
  const across = new THREE.Vector3(SUN.z, 0, -SUN.x).normalize().multiplyScalar(1500);
  assert.ok(!inColumn(block(-40 + across.x, across.z)));
  // A tall block 600 m toward the sun does: the low sun lays its shadow over the target.
  const toward = new THREE.Vector3(SUN.x, 0, SUN.z).normalize().multiplyScalar(600);
  assert.ok(inColumn(block(-40 + toward.x, toward.z, 120)));
  // Down-sun, past the box, nothing it casts falls back into it.
  assert.ok(!inColumn(block(-40 - toward.x * 2, -toward.z * 2, 40)));
});

test('each pass sees its own layers: the view, the shadow map and the AO each skip what the others own', () => {
  const p = passLayers();
  const on = (...ls: number[]): THREE.Layers => {
    const l = new THREE.Layers();
    l.disableAll();
    for (const x of ls) l.enable(x);
    return l;
  };
  // Default objects draw in every pass.
  assert.ok(on(0).test(p.view) && on(0).test(p.shadow) && on(0).test(p.ao));
  // View only: the city-wide batches (their shadow and AO come from local copies).
  assert.ok(on(LAYER.view).test(p.view) && !on(LAYER.view).test(p.shadow) && !on(LAYER.view).test(p.ao));
  // View and shadow, no AO: a tower past the AO's reach.
  assert.ok(on(LAYER.view, LAYER.shadow).test(p.shadow) && !on(LAYER.view, LAYER.shadow).test(p.ao));
  // Shadow only and AO only copies never draw in the view.
  assert.ok(on(LAYER.shadow).test(p.shadow) && !on(LAYER.shadow).test(p.view) && !on(LAYER.shadow).test(p.ao));
  assert.ok(on(LAYER.ao).test(p.ao) && !on(LAYER.ao).test(p.view) && !on(LAYER.ao).test(p.shadow));
  // three draws the shadow map with the shadow camera's layers only when one past layer 0 is set (WebGLShadowMap).
  assert.ok((p.shadow.mask & 0xfffffffe) !== 0);
});

test('a tower part hides once it is under half a pixel wide, comes back only well inside that, and crowns and panes never hide', () => {
  const px = (size: number, d: number): number => (size * 940) / (2 * d * Math.tan((18 * Math.PI) / 180));
  // A 0.2 m mullion: under half a pixel past about 600 m.
  assert.equal(detailHidden({ size: 0.2, distance: 300, hidden: false, viewHeight: 940 }), false);
  const out = detailHidden({ size: 0.2, distance: 1000, hidden: false, viewHeight: 940 });
  assert.equal(out, true);
  assert.ok(px(0.2, 1000) < 0.5);
  // Hysteresis: just inside the switch it stays hidden, so a camera at the edge never flickers it.
  let d = 1000;
  while (!(px(0.2, d) >= 0.5)) d -= 1;
  assert.equal(detailHidden({ size: 0.2, distance: d, hidden: true, viewHeight: 940 }), true);
  assert.equal(detailHidden({ size: 0.2, distance: d * 0.7, hidden: true, viewHeight: 940 }), false);
  // A large part never hides at any distance in the city.
  assert.equal(detailHidden({ size: 6, distance: 2500, hidden: false, viewHeight: 940 }), false);
});

test("the AO leaves out what it should through its own camera's layers, not three's private visibility cache", () => {
  const post = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'city', 'post.ts'), 'utf8');
  assert.ok(!/_overrideVisibility|_visibilityCache/.test(post), 'post.ts must not reach into GTAOPass internals');
  assert.match(post, /new GTAOPass\(scene, aoCamera/);
  assert.match(post, /aoCamera\.layers\.mask = aoLayers\.mask/);
  // What the river leaves out of the AO it puts on the view and shadow layers: the AO camera never sees it.
  const p = passLayers();
  const farChunk = new THREE.Object3D();
  setLayers(farChunk, LAYER.view, LAYER.shadow);
  assert.ok(!farChunk.layers.test(p.ao) && farChunk.layers.test(p.view) && farChunk.layers.test(p.shadow));
});
