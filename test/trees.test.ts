import './kit-setup.js';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

import * as THREE from 'three';

import { buildSite, KIND, TERRACE } from '../app/src/city/campus/site.js';
import { LAMP_EDGE, LAMP_OFFSETS, PITCH, PLAZA_RADIUS } from '../app/src/city/lots.js';
import { streetTreeSpots } from '../app/src/city/trees.js';
import {
  atlasCover,
  createTrees,
  hasTrees,
  LEAF_ALBEDO_MAX,
  LEAF_SUN_MAX,
  LEAF_UNDER_BLOOM,
  leafAtlas,
  leafSunTerm,
  registerTrees,
  SPECIES,
  swayOffset,
  TREE_HEIGHT,
  TREE_LEVELS,
  TREE_NEAR,
  treeGeometry,
  treeLook,
  type TreeSpot,
} from '../app/src/city/trees.js';
import { inChannel } from '../shared/commute.js';

// The trees (Phase 5 Task 9): tools/kits/trees.py -> app/public/kits/trees.glb, drawn by app/src/city/trees.ts.

const GLB = new URL('../app/public/kits/trees.glb', import.meta.url);
{
  const b = readFileSync(GLB);
  registerTrees(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Spots in a ring round the origin, every species, as a street would plant them. */
function ring(n: number, r: number): TreeSpot[] {
  return Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * 2.399) * r * (0.2 + (i % 7) / 7), y: 0.15, z: Math.sin(i * 2.399) * r * (0.2 + (i % 7) / 7), species: SPECIES[i % 3], size: 0.6 + (i % 5) * 0.08 }));
}

test('trees.glb carries three species at two levels, each a bole, branches and leaf cards, inside its 600 KB cap', () => {
  assert.ok(hasTrees(), 'every species at both levels');
  const size = statSync(GLB).size;
  assert.ok(size <= 600_000, `trees.glb is ${(size / 1000).toFixed(0)} KB (at most 600 KB, its own cap)`);
  for (const s of SPECIES) {
    const near = treeGeometry(s, 'near');
    const far = treeGeometry(s, 'far');
    for (const [level, g] of [['near', near], ['far', far]] as const) {
      const kind = g.getAttribute('aTree') as THREE.BufferAttribute;
      assert.ok(kind && g.getAttribute('uv') && g.getAttribute('color'), `${s}.${level}: its tree attributes`);
      let bark = 0;
      let leaf = 0;
      for (let i = 0; i < kind.count; i++) (kind.getX(i) > 0.5 ? leaf++ : bark++);
      assert.ok(bark > 0 && leaf > 0, `${s}.${level}: bark (${bark}) and leaves (${leaf})`);
      // The root never moves in the wind; somewhere in the crown it moves fully.
      let rootSway = 0;
      let maxSway = 0;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < kind.count; i++) {
        if (pos.getY(i) < 0.5) rootSway = Math.max(rootSway, kind.getY(i));
        maxSway = Math.max(maxSway, kind.getY(i));
      }
      assert.ok(rootSway < 20 && maxSway > 180, `${s}.${level}: still at the root (${rootSway}), swaying at the rim (${maxSway})`);
    }
    const tris = (g: THREE.BufferGeometry): number => g.index!.count / 3;
    assert.ok(tris(near) > 4 * tris(far) && tris(far) <= 160, `${s}: the far level is light (${tris(far)} triangles against ${tris(near)})`);
    near.computeBoundingBox();
    const h = near.boundingBox!.max.y;
    assert.ok(Math.abs(h - TREE_HEIGHT[s]) < TREE_HEIGHT[s] * 0.12, `${s} stands ${h.toFixed(1)} m in the kit (TREE_HEIGHT ${TREE_HEIGHT[s]})`);
  }
  // The columnar hornbeam is a column: far narrower for its height than the plane.
  const shape = (s: (typeof SPECIES)[number]): number => {
    const b = treeGeometry(s, 'near').boundingBox ?? (treeGeometry(s, 'near').computeBoundingBox(), treeGeometry(s, 'near').boundingBox!);
    return (b.max.x - b.min.x) / b.max.y;
  };
  assert.ok(shape('hornbeam') < shape('plane') * 0.6, `the hornbeam is columnar (${shape('hornbeam').toFixed(2)} wide for its height, the plane ${shape('plane').toFixed(2)})`);
});

test('three species, one draw each per level', () => {
  const trees = createTrees('high');
  const meshes = (): THREE.InstancedMesh[] => trees.object.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
  trees.place(ring(300, 900));
  trees.update({ time: 0, eye: new THREE.Vector3(0, 2, 0) });
  const names = meshes().map((m) => m.name).sort();
  assert.deepEqual(names, SPECIES.flatMap((s) => TREE_LEVELS.map((l) => `trees:${s}.${l}`)).sort(), 'one instanced mesh per species and level');
  assert.equal(trees.object.children.length, 6, 'nothing else drawn');
  // Ten times the trees: the same six draws.
  trees.place(ring(3000, 1500));
  trees.update({ time: 0, eye: new THREE.Vector3(500, 2, 0) });
  assert.equal(meshes().length, 6, 'the same six draws for ten times the trees');
  const c = trees.counts();
  assert.equal(c.trees, 3000);
  // Every tree draws at some level; the near level holds only the trees near the eye.
  const near = meshes().filter((m) => m.name.endsWith('.near'));
  const far = meshes().filter((m) => m.name.endsWith('.far'));
  const sum = (ms: THREE.InstancedMesh[]): number => ms.reduce((n, m) => n + m.count, 0);
  assert.ok(sum(near) > 0 && sum(near) < 300, `the near level holds the trees round the eye (${sum(near)})`);
  assert.ok(sum(far) + sum(near) >= 3000, 'every tree draws at one level or the other');
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (const mesh of near) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      assert.ok(p.distanceTo(new THREE.Vector3(500, 2, 0)) < TREE_NEAR.high + 40, `a near tree stands within the near radius (${p.distanceTo(new THREE.Vector3(500, 2, 0)).toFixed(0)} m)`);
    }
  }
  // A level with nothing to draw is hidden, not drawn empty; the AO's pass never sees a tree.
  trees.place(ring(30, 40).map((t) => ({ ...t, species: 'plane' as const })));
  trees.update({ time: 0, eye: new THREE.Vector3(5000, 2, 0) });
  for (const mesh of meshes()) {
    if (!mesh.name.startsWith('trees:plane')) assert.equal(mesh.visible, false, `${mesh.name} is hidden with no tree`);
    assert.ok(!mesh.layers.isEnabled(3) && mesh.layers.isEnabled(1) && mesh.layers.isEnabled(2), `${mesh.name}: the view and the shadow map, not the AO`);
    assert.ok(mesh.castShadow && mesh.customDepthMaterial, `${mesh.name} casts its cut-out shadow`);
  }
  trees.dispose();
});

test("a tree's look is stable by its spot", () => {
  const spots = ring(200, 300);
  const a = treeLook(spots[17]);
  assert.deepEqual(treeLook({ ...spots[17] }), a, 'the same spot, the same tree');
  // Placed among others, in any order, a tree is the same instance.
  const t1 = createTrees('high');
  const t2 = createTrees('medium');
  t1.place(spots);
  t2.place([...spots].reverse());
  assert.deepEqual(t1.instanceOf(spots[17]), t2.instanceOf(spots[17]), 'the order planted changes nothing');
  // No two alike: turn, size, lean and green spread across a street of the same species.
  const street = Array.from({ length: 60 }, (_, i): TreeSpot => ({ x: 194, y: 0.15, z: -200 + i * 16, species: 'plane', size: 0.6 }));
  const looks = street.map(treeLook);
  const spread = (f: (l: ReturnType<typeof treeLook>) => number): number => Math.max(...looks.map(f)) - Math.min(...looks.map(f));
  assert.ok(spread((l) => l.height) > 0.08, `heights spread (${spread((l) => l.height).toFixed(3)})`);
  assert.ok(spread((l) => l.width / l.height) > 0.15, `crowns broader and narrower (${spread((l) => l.width / l.height).toFixed(3)})`);
  assert.ok(spread((l) => l.tint[0] / l.tint[2]) > 0.25, `greens yellower and bluer (${spread((l) => l.tint[0] / l.tint[2]).toFixed(3)})`);
  assert.ok(spread((l) => Math.hypot(...l.lean)) > 0.3, 'some crowns lean more than others');
  assert.equal(new Set(looks.map((l) => l.yaw.toFixed(3))).size, looks.length, 'every tree turned its own way');
  t1.dispose();
  t2.dispose();
});

test('the sun term stays under LEAF_SUN_MAX', () => {
  let worst = 0;
  for (const sun of [0.5, 1, 2.4, 4, 8])
    for (const ndl of [-0.5, 0, 0.3, 0.7, 1])
      for (const back of [-1, 0, 0.5, 0.9, 1])
        for (const sheen of [0, 0.2, 1, 3])
          for (const albedo of [0.02, 0.1, 0.25, LEAF_ALBEDO_MAX]) {
            const t = leafSunTerm({ sun, ndl, back, sheen, albedo });
            worst = Math.max(worst, t / albedo);
            assert.ok(t <= albedo * LEAF_SUN_MAX + 1e-9, `sun ${sun}, ndl ${ndl}, back ${back}, sheen ${sheen}, albedo ${albedo}: ${t.toFixed(3)} over the cap`);
          }
  assert.ok(worst > LEAF_SUN_MAX * 0.99, 'the cap is what holds the brightest leaf, not a term too weak to reach it');
  assert.ok(LEAF_UNDER_BLOOM, 'the brightest sunlit leaf stays under the bloom threshold after the exposure');
  // The shader holds the same cap: compile the view material's patch against three's own standard shader.
  const trees = createTrees('high');
  trees.place(ring(3, 10));
  const mesh = trees.object.children[0] as THREE.InstancedMesh;
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
  assert.ok(sh.fragmentShader.includes(`diffuseColor.rgb * ${LEAF_SUN_MAX.toFixed(3)}`), 'the fragment shader caps the sun term at LEAF_SUN_MAX');
  assert.ok(sh.fragmentShader.includes('reflectedLight.directSpecular = vec3(0.0)'), "a leaf's sheen is inside the cap, not added after it");
  trees.dispose();
});

test('leaf cards up close: an edge-on card thins out and the leaves part round the eye (Task 15a)', async () => {
  const mod = (await import('../app/src/city/trees.js')) as unknown as { LEAF_EDGE_NEAR?: number; LEAF_EDGE_ON?: number; LEAF_EYE_CLEAR?: number };
  // Within 10 m no card shows its edge or a streak: the edge-on fade reaches past 10 m, and an eye at a tree's foot
  // (the street still's, 1.6 m up under a street tree) looks out through a clearing at least two metres deep.
  assert.ok((mod.LEAF_EDGE_NEAR ?? 0) >= 10, `edge-on cards thin out within ${mod.LEAF_EDGE_NEAR} m`);
  assert.ok((mod.LEAF_EDGE_ON ?? 0) > 0.1 && (mod.LEAF_EDGE_ON ?? 1) < 0.5, `a card is cut past ${mod.LEAF_EDGE_ON}`);
  assert.ok((mod.LEAF_EYE_CLEAR ?? 0) >= 3, `the leaves part ${mod.LEAF_EYE_CLEAR} m round the eye`);
  const trees = createTrees('high');
  trees.place(ring(3, 10));
  const mat = (trees.object.children[0] as THREE.InstancedMesh).material as THREE.MeshStandardMaterial;
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
  assert.ok(sh.fragmentShader.includes('cross(dFdx(vViewPosition), dFdy(vViewPosition))') && sh.fragmentShader.includes(`leafD < ${mod.LEAF_EYE_CLEAR!.toFixed(1)}`), 'the leaf shader cuts edge-on cards and clears the eye');
  trees.dispose();
});

test('the wind sways a crown under 5 cm and never moves the root', () => {
  let most = 0;
  for (let t = 0; t < 60; t += 0.07)
    for (const ph of [0, 0.3, 0.71])
      for (const leaf of [false, true]) {
        const o = swayOffset(1, ph, 0.4, t, leaf, 7);
        most = Math.max(most, Math.hypot(...o));
      }
  assert.ok(most < 0.05 && most > 0.02, `the rim sways ${(most * 100).toFixed(1)} cm at most`);
  assert.deepEqual(swayOffset(0, 0.2, 0.3, 12.5, true).map((v) => Math.abs(v)), [0, 0, 0], 'the root is still');
});

test('each leaf atlas is a cluster of leaves on a twig, not a solid card', () => {
  for (const s of SPECIES) {
    const a = leafAtlas(s);
    const c = atlasCover(a);
    assert.ok(c > 0.3 && c < 0.8, `${s}: leaves cover ${(c * 100).toFixed(0)}% of the atlas`);
    assert.deepEqual(leafAtlas(s).slice(0, 4096), a.slice(0, 4096), `${s}: drawn the same every time`);
    // Green, and not one flat green: the covered pixels' green channel leads and varies.
    let g = 0;
    let r = 0;
    const greens: number[] = [];
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 128) continue;
      g += a[i + 1];
      r += a[i];
      greens.push(a[i + 1]);
    }
    greens.sort((x, y) => x - y);
    assert.ok(g > r, `${s}: green leads red`);
    assert.ok(greens[Math.floor(greens.length * 0.9)] - greens[Math.floor(greens.length * 0.1)] > 25, `${s}: leaves light and dark`);
    // LEAF_ALBEDO_MAX holds: the palest covered pixel, in linear light, times the brightest tint any tree takes.
    const lin = (v: number): number => ((v / 255) <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    let pale = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i + 3] >= 128) pale = Math.max(pale, lin(a[i]), lin(a[i + 1]), lin(a[i + 2]));
    const tint = Math.max(...Array.from({ length: 400 }, (_, k) => Math.max(...treeLook({ x: k * 3.1, y: 0, z: k * 1.7, species: s, size: 1 }).tint)));
    assert.ok(pale * tint <= LEAF_ALBEDO_MAX, `${s}: the brightest leaf ${(pale * tint).toFixed(3)} within LEAF_ALBEDO_MAX`);
  }
});

test('the street trees stand on the lamps line between the posts, clear of plazas, the river and each other', () => {
  const plazas = [{ x: 0, z: 0 }, { x: 240, z: 480 }];
  const spots = streetTreeSpots('high', plazas);
  assert.ok(spots.length > 400, `${spots.length} street trees`);
  assert.deepEqual(streetTreeSpots('high', plazas), spots, 'the same streets planted every time');
  assert.ok(streetTreeSpots('medium', plazas).length < spots.length, 'medium plants a smaller city');
  for (const s of spots) {
    const lx = s.x - Math.round(s.x / PITCH) * PITCH;
    const lz = s.z - Math.round(s.z / PITCH) * PITCH;
    const onLine = Math.abs(Math.abs(lx) - LAMP_EDGE) < 1e-6 || Math.abs(Math.abs(lz) - LAMP_EDGE) < 1e-6;
    assert.ok(onLine, `(${s.x}, ${s.z}) on a lamp line`);
    const along = Math.abs(Math.abs(lx) - LAMP_EDGE) < 1e-6 ? lz : lx;
    assert.ok(LAMP_OFFSETS.every((o) => Math.abs(along - o) >= 6), `(${s.x}, ${s.z}) clear of the lamp posts`);
    assert.ok(plazas.every((p) => Math.hypot(p.x - s.x, p.z - s.z) >= PLAZA_RADIUS), `(${s.x}, ${s.z}) clear of the plazas`);
    assert.ok(!inChannel(s.x, 20), `(${s.x}, ${s.z}) clear of the river`);
    assert.ok(TREE_HEIGHT[s.species] * s.size * 1.1 <= 10.5, `(${s.x}, ${s.z}) under the viaduct's deck`);
  }
  const species = new Set(spots.map((s) => s.species));
  assert.ok(species.has('plane') && species.has('linden'), 'planes and limes along the streets');
});

test('the campus plants its trees in the shared system: none left in the site', () => {
  const g = buildSite(true);
  const kind = g.getAttribute('aKind') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  let crowns = 0;
  for (let i = 0; i < kind.count; i++) if ((kind.getX(i) === KIND.turf || kind.getX(i) === KIND.yew) && pos.getY(i) > TERRACE + 2) crowns++;
  assert.equal(crowns, 0, 'no crown of turf or yew in the site');
});
