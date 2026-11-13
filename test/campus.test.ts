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
import { afterSunset, handAngles, makeClockTower, TOWER } from '../app/src/city/campus/clock.js';
import { buildHall, instanceHalls } from '../app/src/city/campus/halls.js';
import { Kit } from '../app/src/city/tower/kit.js';
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
  const other = districtOrigin(4);
  campus.set(other);
  // Slot 4 stands on the same side of the city as slot 5, so the campus keeps its yaw and the gate moves by exactly the shift.
  const moved = campus.anchors().gate;
  assert.ok(Math.abs(moved.x - anchors.gate.x - (other.x - origin.x)) < 1e-6 && Math.abs(moved.z - anchors.gate.z - (other.z - origin.z)) < 1e-6, `the gate moves with the campus (${moved.x.toFixed(1)}, ${moved.z.toFixed(1)})`);
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

test('the whole campus draws in at most 4 calls a pass, at high and at medium', () => {
  for (const quality of ['high', 'medium'] as const) {
    const campus = createCampus({ quality, materials: plainMaterials(), masonry: plain() });
    campus.set(districtOrigin(2));
    // The site with the library and the tower's masonry, the halls, the panes, and the clock's hands.
    assert.ok(drawnMeshes(campus.group) <= 4, `${quality}: the campus draws in ${drawnMeshes(campus.group)} meshes`);
    assert.ok(drawnTriangles(campus.group) < 300_000, `${quality}: ${drawnTriangles(campus.group).toFixed(0)} triangles a pass`);
    campus.dispose();
  }
});

test('a disposed campus lets go of every geometry it made', () => {
  const campus = createCampus({ quality: 'high', materials: plainMaterials(), masonry: plain() });
  campus.set(districtOrigin(3));
  const geometries = new Set<THREE.BufferGeometry>();
  campus.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) geometries.add(m.geometry);
  });
  assert.ok(geometries.size >= 3, `the site, the halls and the panes (${geometries.size} geometries)`);
  let disposed = 0;
  for (const g of geometries) g.addEventListener('dispose', () => disposed++);
  campus.dispose();
  assert.equal(disposed, geometries.size, 'each geometry disposed once');
  // The lamps are in the site's draw: lit heads that cost no call of their own.
  assert.equal(drawnMeshes(campus.group), 4, 'and the group still names only its four meshes');
});

/** A clock tower built in Node: a Kit of plain materials, a plain masonry whose userData carries the dial's emission as the app's does. */
function tower(at: Date): ReturnType<typeof makeClockTower> & { masonry: THREE.Material } {
  const masonry = plain();
  masonry.userData.dialLit = { value: 0 };
  const k = new Kit(plainMaterials());
  const t = makeClockTower(k, () => at, { masonry, quality: 'high' });
  return Object.assign(t, { masonry });
}

test('the hands point at 10:10 for 10:10', () => {
  const at = new Date(2026, 10, 12, 10, 10);
  // Clockwise from twelve: the minute hand at two, the hour hand a sixth of the way from ten to eleven.
  const a = handAngles(at);
  assert.ok(Math.abs(a.minute - Math.PI / 3) < 1e-9, `the minute hand at two (${a.minute})`);
  assert.ok(Math.abs(a.hour - ((10 + 10 / 60) / 12) * Math.PI * 2) < 1e-9, `the hour hand past ten (${a.hour})`);
  const t = tower(at);
  t.update();
  // Four faces, two hands each, in one instanced draw; each hand's up, taken back into its dial's frame, points its way.
  assert.equal(t.hands.count, 8, 'eight hands');
  assert.equal(t.faces.length, 4, 'four dials');
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const origin = new THREE.Vector3();
  for (let f = 0; f < 4; f++) {
    const inv = t.faces[f].clone().invert();
    for (const [i, want] of [[0, a.hour], [1, a.minute]] as Array<[number, number]>) {
      t.hands.getMatrixAt(f * 2 + i, m);
      // The hand's own +y, as a direction in the dial's frame (x right, y up, z out of the face).
      up.set(0, 1, 0).applyMatrix4(m).sub(origin.set(0, 0, 0).applyMatrix4(m)).applyMatrix4(new THREE.Matrix4().extractRotation(inv));
      const got = Math.atan2(up.x, up.y);
      const diff = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
      assert.ok(diff < 1e-6, `face ${f} ${i === 0 ? 'hour' : 'minute'} hand points at ${((got / Math.PI) * 180).toFixed(1)} deg, wanted ${((want / Math.PI) * 180).toFixed(1)}`);
    }
  }
  // The hands turn with the time: an hour later the hour hand has moved a twelfth of the way round.
  const later = tower(new Date(2026, 10, 12, 11, 10));
  later.update();
  later.hands.getMatrixAt(0, m);
  const h2 = new THREE.Matrix4();
  t.hands.getMatrixAt(0, h2);
  assert.ok(!m.equals(h2), 'the hour hand has moved');
  t.dispose();
  later.dispose();
});

test('the faces emit only after sunset', () => {
  // Sunset by the season, in his local time: a December evening is dark by half past five, a June one not at five.
  assert.equal(afterSunset(new Date(2026, 11, 21, 17, 30)), true, 'December, half past five');
  assert.equal(afterSunset(new Date(2026, 11, 21, 10, 10)), false, 'December, ten past ten');
  assert.equal(afterSunset(new Date(2026, 5, 21, 17, 0)), false, 'June, five');
  assert.equal(afterSunset(new Date(2026, 5, 21, 22, 30)), true, 'June, half past ten');
  assert.equal(afterSunset(new Date(2026, 5, 21, 3, 0)), true, 'June, three in the morning');
  // The tower's dials: dark at ten past ten in the morning, lit at night, the emission a real one under the bloom threshold.
  const day = tower(new Date(2026, 10, 12, 10, 10));
  day.update();
  assert.equal(day.lit(), false, 'dark by day');
  assert.equal((day.masonry.userData.dialLit as { value: number }).value, 0, 'the dial kind emits nothing by day');
  const night = tower(new Date(2026, 10, 12, 22, 10));
  night.update();
  assert.equal(night.lit(), true, 'lit at night');
  assert.equal((night.masonry.userData.dialLit as { value: number }).value, 1, 'the dial kind emits at night');
  // A tower whose clock crosses sunset switches on without being rebuilt.
  let at = new Date(2026, 10, 12, 16, 0);
  const t = tower(at);
  t.update();
  assert.equal(t.lit(), false);
  at = new Date(2026, 10, 12, 19, 0);
  const t2 = makeClockTower(new Kit(plainMaterials()), () => at, { masonry: t.masonry, quality: 'medium' });
  t2.update();
  assert.equal(t2.lit(), true);
  // Four stages, 48 m: the tallest piece of masonry on the campus.
  assert.equal(TOWER.height, 48);
  assert.equal(TOWER.stages, 4);
  day.dispose();
  night.dispose();
  t.dispose();
  t2.dispose();
});
