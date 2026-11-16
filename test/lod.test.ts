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
  frustumBlocks,
  SHADOW_REST,
  SHADOW_STEP,
  shadowBoxMoves,
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

// ---------------------------------------------------------------- the view's blocks (Task 12)

function streetEye(dir: [number, number]): THREE.Frustum {
  const cam = new THREE.PerspectiveCamera(50, 1.7, 0.5, 6000);
  cam.position.set(0, 1.7, 0);
  cam.lookAt(dir[0] * 100, 1.7, dir[1] * 100);
  cam.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
}

function city(): { blocks: BlockBox[]; used: Uint8Array } {
  const blocks: BlockBox[] = [];
  for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) blocks.push({ ...block(i * 80, j * 80), maxY: 30 });
  return { blocks, used: new Uint8Array(blocks.length).fill(1) };
}

const boxOf = (b: BlockBox): THREE.Box3 => new THREE.Box3(new THREE.Vector3(b.minX, b.minY, b.minZ), new THREE.Vector3(b.maxX, b.maxY, b.maxZ));

test('a block behind the eye is not drawn in the view, and every block the frustum meets is', () => {
  const { blocks, used } = city();
  const held = new Uint8Array(blocks.length);
  const f = streetEye([0, 1]);
  const eye = new THREE.Vector3(0, 1.7, 0);
  assert.equal(frustumBlocks(blocks, used, f, eye, held), true, 'the first look fills the view');
  let n = 0;
  for (const [k, b] of blocks.entries()) {
    if (f.intersectsBox(boxOf(b))) assert.equal(held[k], 1, 'a block in the frustum is held');
    if (b.maxZ < -40) assert.equal(held[k], 0, 'a block well behind the eye is not');
    n += held[k];
  }
  assert.ok(n < blocks.length * 0.5, `looking one way holds under half the city (${n} of ${blocks.length})`);
});

test("the view's blocks are refilled only when the frustum leaves them, and follow the eye round", () => {
  const { blocks, used } = city();
  const held = new Uint8Array(blocks.length);
  const eye = new THREE.Vector3(0, 1.7, 0);
  frustumBlocks(blocks, used, streetEye([0, 1]), eye, held);
  // A turn of under a degree stays inside the margin: nothing to refill.
  assert.equal(frustumBlocks(blocks, used, streetEye([0.01, 1]), eye, held), false);
  // Turned round: refilled, and the blocks now in front are held.
  const back = streetEye([0, -1]);
  assert.equal(frustumBlocks(blocks, used, back, eye, held), true);
  for (const [k, b] of blocks.entries()) if (back.intersectsBox(boxOf(b))) assert.equal(held[k], 1);
  // A mask (the AO's near blocks) narrows it further.
  const near = new Uint8Array(blocks.length).map((_, k) => (boxDistance(eye, blocks[k]) < 400 ? 1 : 0));
  const ao = new Uint8Array(blocks.length);
  frustumBlocks(blocks, near, back, eye, ao);
  for (let k = 0; k < blocks.length; k++) if (ao[k]) assert.equal(near[k], 1);
});

test('the shadow box follows a moving eye in steps and comes to rest exactly where it stopped', () => {
  // The first frame always draws the map (no box yet).
  assert.equal(shadowBoxMoves(NaN, 0), true);
  // Moving: under a step, the map is not redrawn; past a step it is, at once.
  assert.equal(shadowBoxMoves(3, 0), false);
  assert.equal(shadowBoxMoves(SHADOW_STEP - 0.1, 0.1), false);
  assert.equal(shadowBoxMoves(SHADOW_STEP + 0.1, 0), true);
  // Stopped for SHADOW_REST: it lands on the eye's own centre, however near.
  assert.equal(shadowBoxMoves(0.5, SHADOW_REST), true);
  assert.equal(shadowBoxMoves(0, 5), false, 'already there: nothing to redraw');
});

// ---------------------------------------------------------------- Task 15: the tower kit's cross-fade and the AO's reach

/** Read off the module, so a build without them fails these tests alone. */
const L = (await import('../app/src/city/lod.js')) as unknown as Record<string, unknown>;

test('the LOD cross-fade spans 430 to 470 m', async () => {
  const band = L.TOWER_LOD as { near: number; far: number } | undefined;
  assert.deepEqual(band, { near: 430, far: 470 });
  const blend = L.towerLodBlend as (d: number) => { near: number; far: number };
  for (let d = 380; d <= 520; d += 2) {
    const b = blend(d);
    assert.ok(Math.abs(b.near + b.far - 1) < 1e-9, `the levels' shares sum to one at ${d} m`);
    if (d <= 430) assert.equal(b.far, 0, `only the near level at ${d} m`);
    if (d >= 470) assert.equal(b.near, 0, `only the far level at ${d} m`);
  }
  assert.ok(Math.abs(blend(450).far - 0.5) < 1e-9, 'an even split at 450 m, the old switch');
  // The LOD keeps both levels standing while any of its instances is in the band, and only one outside it.
  const Fade = L.FadeLOD as new () => THREE.LOD & { reach: number };
  const lod = new Fade();
  const near = new THREE.Object3D();
  const far = new THREE.Object3D();
  lod.addLevel(near, 0);
  lod.addLevel(far, 450);
  lod.reach = 20;
  const cam = new THREE.PerspectiveCamera();
  const at = (d: number): [boolean, boolean] => {
    cam.position.set(d, 0, 0);
    cam.updateMatrixWorld(true);
    lod.updateMatrixWorld(true);
    lod.update(cam);
    return [near.visible, far.visible];
  };
  assert.deepEqual(at(300), [true, false]);
  assert.deepEqual(at(420), [true, true], 'an instance 20 m nearer is already in the band');
  assert.deepEqual(at(450), [true, true]);
  assert.deepEqual(at(485), [true, true], 'an instance 20 m nearer is still in the band');
  assert.deepEqual(at(600), [false, true]);
  // Two levels of one geometry (a kit part at medium) switch once at 450 m and are never drawn twice.
  const g = new THREE.BoxGeometry();
  const same = new Fade();
  const a = new THREE.Mesh(g);
  const z = new THREE.Mesh(g);
  same.addLevel(a, 0);
  same.addLevel(z, 450);
  same.reach = 20;
  for (const d of [440, 460]) {
    cam.position.set(d, 0, 0);
    cam.updateMatrixWorld(true);
    same.updateMatrixWorld(true);
    same.update(cam);
    assert.ok(a.visible !== z.visible, `one level of the same blocks at ${d} m`);
  }
  // Each level's shader dissolves by each instance's own distance over the same band, the source's patch first.
  const { towerLodMaterial } = await import('../app/src/city/lod-shader.js');
  const src = new THREE.MeshStandardMaterial();
  let own = 0;
  src.onBeforeCompile = () => {
    own++;
  };
  src.customProgramCacheKey = () => 'palimpsest-scan';
  const n = towerLodMaterial(src, 'near');
  const f = towerLodMaterial(src, 'far');
  assert.equal(towerLodMaterial(src, 'near'), n, 'one copy per source and level');
  const sh = { uniforms: {}, vertexShader: '#include <common>\n#include <project_vertex>', fragmentShader: '#include <common>\nvoid main() {' } as unknown as THREE.WebGLProgramParametersWithUniforms;
  n.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
  assert.equal(own, 1, "the source's own patch runs first");
  assert.match(sh.vertexShader, /smoothstep\(430\.0, 470\.0/);
  assert.match(sh.fragmentShader, /lodN < vLodFade\) discard/);
  assert.ok(n.customProgramCacheKey().startsWith('palimpsest-scan|') && n.customProgramCacheKey() !== f.customProgramCacheKey(), 'each level has its own program key, after the source');
});

test('AO reaches 1,250 m', async () => {
  await import('./kit-setup.js');
  const { createGrid } = await import('../app/src/city/grid.js');
  const { AO_FADE_END } = await import('../app/src/city/post.js');
  assert.equal(AO_NEAR, 1250);
  assert.ok(AO_NEAR >= AO_FADE_END);
  const g = createGrid('high', { sun: SUN, half: 320, offset: 800, near: 10, far: 1600 });
  // An eye at the city's edge, high: the roof kit is near it, and far off across the city.
  const eye = new THREE.Vector3(1200, 200, 0);
  g.update(eye, new THREE.Vector3(0, 0, 0));
  const ao = (g.group.children as THREE.InstancedMesh[]).filter((c) => c.isInstancedMesh && c.layers.mask === 1 << LAYER.ao);
  const farKit = ao.find((c) => c.name === 'ao:far-kit');
  assert.ok(farKit, 'the roof kit past its near level joins the AO as its boxes');
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let reach = 0;
  for (let j = 0; j < farKit!.count; j++) {
    m.fromArray(farKit!.instanceMatrix.array, j * 16);
    const d = p.setFromMatrixPosition(m).distanceTo(eye);
    reach = Math.max(reach, d);
    assert.ok(d > AMBIENT_LOD.far - 120, `a far kit box in the AO stands past the near kit (${d.toFixed(0)} m)`);
  }
  assert.ok(reach > 1150 && reach < AO_NEAR + 120 + 120, `the roof kit's AO reaches ${reach.toFixed(0)} m`);
  g.dispose();
});
