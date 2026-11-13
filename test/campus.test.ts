/**
 * The campus site (Phase 4 Task 34): the university's terrace, quads and
 * halls stand on the plot the engine took, inside their block, with the
 * ambient city kept off it, and the four halls drawn in the calls of one.
 * Pure three.js in Node: plain materials stand in for the window shader and
 * the masonry.
 */
import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { drawnMeshes } from '../app/src/city/batch.js';
import { createCampus, type CampusAnchors } from '../app/src/city/campus/index.js';
import { buildHall, instanceHalls } from '../app/src/city/campus/halls.js';
import { CAMPUS_HALF, campusPlaza, TERRACE } from '../app/src/city/campus/site.js';
import { PITCH, standingLots } from '../app/src/city/lots.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { DISTRICT_PITCH, districtOrigin } from '../shared/district-layout.js';

/** Plain materials, one per key, so the campus builds in Node. */
function plainMaterials(): TowerMaterials {
  const made = new Map<string | symbol, THREE.Material>();
  return new Proxy({} as TowerMaterials, {
    get(_, key) {
      let m = made.get(key);
      if (!m) made.set(key, (m = new THREE.MeshStandardMaterial({ name: String(key) })));
      return m;
    },
  });
}

const plain = (): THREE.Material => new THREE.MeshStandardMaterial({ vertexColors: true });

function drawnTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    n += tris * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return n;
}

test('the campus stands on its slot’s origin, inside its block', () => {
  const origin = districtOrigin(5);
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(origin);
  campus.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(campus.group);
  // The whole campus, halls and terrace, stands within its own 240 m block, the streets round it kept clear.
  const half = DISTRICT_PITCH / 2 - 8;
  assert.ok(box.min.x >= origin.x - half - 1e-6 && box.max.x <= origin.x + half + 1e-6, `within the block in x (${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)} round ${origin.x})`);
  assert.ok(box.min.z >= origin.z - half - 1e-6 && box.max.z <= origin.z + half + 1e-6, `within the block in z (${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)} round ${origin.z})`);
  assert.ok(box.min.y >= -0.5, 'nothing below the street');
  // The terrace stands 6 m up, and the halls on it.
  assert.equal(TERRACE, 6);
  assert.ok(box.max.y > TERRACE + 12, `the halls rise above the terrace (${box.max.y.toFixed(1)} m)`);
  // Every anchor for the later buildings is on the terrace, inside the block.
  const anchors: CampusAnchors = campus.anchors();
  for (const [name, p] of Object.entries(anchors) as Array<[keyof CampusAnchors, THREE.Vector3]>) {
    assert.ok(Math.abs(p.x - origin.x) <= CAMPUS_HALF && Math.abs(p.z - origin.z) <= CAMPUS_HALF, `${name} stands inside the campus`);
    assert.ok(Math.abs(p.y - TERRACE) < 1e-6, `${name} stands on the terrace`);
  }
  // Moved, it goes whole, anchors and all.
  const other = districtOrigin(9);
  campus.set(other);
  assert.ok(Math.abs(campus.anchors().gate.x - anchors.gate.x - (other.x - origin.x)) < 1e-6 || Math.abs(campus.anchors().gate.z - anchors.gate.z - (other.z - origin.z)) < 1e-6, 'the gate moves with the campus');
  campus.dispose();
});

test('the gate faces the city, whichever side of it the campus stands', () => {
  for (const slot of [0, 1, 2, 3, 6, 11]) {
    const origin = districtOrigin(slot);
    const campus = createCampus({ quality: 'medium', materials: plainMaterials(), masonry: plain() });
    campus.set(origin);
    const gate = campus.anchors().gate;
    // The gate is on the campus's edge toward the centre of the city: nearer the civic plaza than the origin is.
    assert.ok(Math.hypot(gate.x, gate.z) < Math.hypot(origin.x, origin.z) - 50, `slot ${slot}: the gate at (${gate.x.toFixed(0)}, ${gate.z.toFixed(0)}) faces the centre from (${origin.x}, ${origin.z})`);
    campus.dispose();
  }
});

test('no ambient lot overlaps it, and no lamp or lantern stands on it', () => {
  const origin = districtOrigin(4);
  const plaza = campusPlaza(origin);
  const bi = Math.round(origin.x / PITCH);
  const bj = Math.round(origin.z / PITCH);
  let lots = 0;
  for (let i = bi - 3; i <= bi + 3; i++) {
    for (let j = bj - 3; j <= bj + 3; j++) {
      for (const lot of standingLots(i, j, [plaza])) {
        lots++;
        const dx = Math.abs(lot.x - origin.x) - lot.w / 2;
        const dz = Math.abs(lot.z - origin.z) - lot.d / 2;
        assert.ok(dx >= CAMPUS_HALF || dz >= CAMPUS_HALF, `lot at (${lot.x}, ${lot.z}) ${lot.w}x${lot.d} stays off the campus`);
      }
    }
  }
  assert.ok(lots > 20, `the blocks round the campus still stand (${lots} lots)`);
  // A terrace is a court for the lots and the lamps (grid.ts keeps them off a court), but carries none of a
  // quarter's court lanterns on its top and is never paved by the ground: the flag the grid and the scene read.
  assert.ok(plaza.court !== undefined && plaza.court >= CAMPUS_HALF && plaza.terrace === true, 'the campus is a terrace court');
});

test('four halls cost the calls of one', () => {
  const materials = plainMaterials();
  const one = buildHall({ quality: 'high', materials, masonry: plain(), seed: 'campus' });
  const single = instanceHalls(one, [new THREE.Matrix4()]);
  const four = instanceHalls(one, [0, 1, 2, 3].map((i) => new THREE.Matrix4().makeTranslation(i * 80, 0, 0)));
  assert.equal(drawnMeshes(four.group), drawnMeshes(single.group), `four halls draw in as many calls as one (${drawnMeshes(four.group)})`);
  assert.ok(drawnMeshes(four.group) <= 2, `a hall is one masonry draw and one of panes (${drawnMeshes(four.group)})`);
  assert.equal(drawnTriangles(four.group), 4 * drawnTriangles(single.group), 'and four times the triangles');
  // Light enough that four of them, three passes each, stay under the campus's 900k triangles.
  assert.ok(drawnTriangles(single.group) < 60_000, `a hall is under 60k triangles (${drawnTriangles(single.group).toFixed(0)})`);
  // The windows are lit panes in the tower window shader, a pane per light.
  let panes = 0;
  four.group.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && (im.material as THREE.Material).name === 'window') panes += im.count;
  });
  assert.ok(panes >= 4 * 40, `the four halls carry their windows (${panes} panes)`);
  single.dispose();
  four.dispose();
  one.dispose();
});

test('the whole campus draws in at most 3 calls a pass, at high and at medium', () => {
  for (const quality of ['high', 'medium'] as const) {
    const campus = createCampus({ quality, materials: plainMaterials(), masonry: plain() });
    campus.set(districtOrigin(2));
    assert.ok(drawnMeshes(campus.group) <= 3, `${quality}: the campus draws in ${drawnMeshes(campus.group)} meshes`);
    assert.ok(drawnTriangles(campus.group) < 300_000, `${quality}: ${drawnTriangles(campus.group).toFixed(0)} triangles a pass`);
    campus.dispose();
  }
});
