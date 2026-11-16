import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { createGrid, type Grid } from '../app/src/city/grid.js';
import { LAYER } from '../app/src/city/lod.js';
import { flushRemerges, pendingRemerges, runRemerges } from '../app/src/city/batch.js';

const SUN = new THREE.Vector3(-0.908, 0.3, 0.419).normalize();
const grid = (): Grid => createGrid('medium', { sun: SUN, half: 320, offset: 800, near: 10, far: 1600 });

/** A street-level eye at (x, z) looking along `dir`. */
function eyeAt(x: number, z: number, dir: [number, number]): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1.7, 0.5, 6000);
  cam.position.set(x, 1.7, z);
  cam.lookAt(x + dir[0] * 100, 1.7, z + dir[1] * 100);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Each hidden city-wide batch with the view's copy of it (the view's layer only, the same name). */
function pairs(g: Grid): Array<{ source: THREE.InstancedMesh; copy: THREE.InstancedMesh }> {
  const view = 1 << LAYER.view;
  const meshes = (g.group.children as THREE.InstancedMesh[]).filter((c) => c.isInstancedMesh && c.layers.mask === view);
  const out: Array<{ source: THREE.InstancedMesh; copy: THREE.InstancedMesh }> = [];
  const names = new Map<string, THREE.InstancedMesh[]>();
  for (const m of meshes) names.set(m.name, [...(names.get(m.name) ?? []), m]);
  for (const [name, list] of names) {
    // A name belongs to one batch and its one copy, so neither can be read against another batch's.
    assert.equal(list.length, 2, `the view's layer holds one batch and one copy named ${JSON.stringify(name)}`);
    assert.equal(list[0].visible, false, `${name}: the batch itself is hidden, its copy draws`);
    out.push({ source: list[0], copy: list[1] });
  }
  return out;
}

const SOURCE_COUNT = (m: THREE.InstancedMesh): number => m.count;
const keyOf = (a: ArrayLike<number>, i: number): string => Array.from({ length: 16 }, (_, k) => Math.round(a[i * 16 + k] * 1000)).join(',');

/** Every instance a view copy holds is one of its batch's, with the same matrix, colour and instanced attributes. */
function assertFaithful(g: Grid): void {
  for (const { source, copy } of pairs(g)) {
    const at = new Map<string, number>();
    const sm = source.instanceMatrix.array;
    for (let i = 0; i < SOURCE_COUNT(source); i++) at.set(keyOf(sm, i), i);
    const extra = Object.entries(copy.geometry.attributes).filter(([, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute);
    assert.deepEqual(
      extra.map(([n]) => n).sort(),
      Object.entries(source.geometry.attributes).filter(([, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute).map(([n]) => n).sort(),
      `${source.name}'s view copy carries every per-instance attribute of its batch`,
    );
    if (source.instanceColor && copy.count > 0) assert.ok(copy.instanceColor, `${source.name} keeps its colours`);
    for (let j = 0; j < copy.count; j++) {
      const i = at.get(keyOf(copy.instanceMatrix.array, j));
      assert.ok(i !== undefined, `${source.name}: a view copy instance is one its batch holds now`);
      if (source.instanceColor && copy.instanceColor) {
        for (let k = 0; k < 3; k++) assert.equal(copy.instanceColor.array[j * 3 + k], source.instanceColor.array[i * 3 + k]);
      }
      for (const [name, a] of extra) {
        const s = source.geometry.attributes[name] as THREE.InstancedBufferAttribute;
        for (let k = 0; k < a.itemSize; k++) assert.equal(a.array[j * a.itemSize + k], s.array[i * a.itemSize + k], `${source.name} ${name}`);
      }
    }
  }
}

/** No block the frustum meets is dropped: every batch instance whose centre is in view is in the copy. */
function assertComplete(g: Grid, cam: THREE.Camera): void {
  const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (const { source, copy } of pairs(g)) {
    const held = new Set<string>();
    for (let j = 0; j < copy.count; j++) held.add(keyOf(copy.instanceMatrix.array, j));
    for (let i = 0; i < SOURCE_COUNT(source); i++) {
      m.fromArray(source.instanceMatrix.array, i * 16);
      if (!f.containsPoint(p.setFromMatrixPosition(m))) continue;
      assert.ok(held.has(keyOf(source.instanceMatrix.array, i)), `${source.name}: an instance in the frustum is drawn`);
    }
  }
}

/** Nothing far behind the eye is held. */
function assertNothingBehind(g: Grid, cam: THREE.Camera): void {
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (const { source, copy } of pairs(g)) {
    for (let j = 0; j < copy.count; j++) {
      m.fromArray(copy.instanceMatrix.array, j * 16);
      const behind = -p.setFromMatrixPosition(m).sub(cam.position).dot(fwd);
      assert.ok(behind < 200, `${source.name}: nothing 200 m behind the eye is held (${behind.toFixed(0)} m)`);
    }
  }
}

test("the view's copies hold every block the eye sees, nothing far behind it, and each instance as built", () => {
  const g = grid();
  const cam = eyeAt(200, -150, [0, 1]);
  g.update(cam.position, new THREE.Vector3(200, 0, 0), cam);
  const lod = g.lod();
  assert.ok(lod.view > 0 && lod.view < lod.city * 0.5, `looking one way down the street draws under half the city (${lod.view} of ${lod.city})`);
  assert.ok(pairs(g).length > 10, 'every city-wide batch has its view copy');
  assertComplete(g, cam);
  assertNothingBehind(g, cam);
  assertFaithful(g);
  // The batches stay, hidden, as the copies' source and the plates' line of sight.
  assert.ok(g.blockers.every((b) => !b.visible) && g.blockers.some((b) => (b as THREE.InstancedMesh).count > 0));
  // Turned round where it stands: what it now sees is drawn at once, and what was ahead, now behind, is let go over
  // the next frames (the re-merge queue, batch.ts).
  const fills = lod.viewFills;
  const back = eyeAt(200, -150, [0, -1]);
  g.update(back.position, new THREE.Vector3(200, 0, 0), back);
  assertComplete(g, back);
  flushRemerges();
  assert.ok(g.lod().viewFills > fills);
  assertComplete(g, back);
  assertNothingBehind(g, back);
  assertFaithful(g);
  g.dispose();
});

test("the AO's copies hold only blocks in front of the eye", () => {
  const g = grid();
  const all = grid();
  const cam = eyeAt(-100, 80, [1, 0.3]);
  g.update(cam.position, new THREE.Vector3(0, 0, 0), cam);
  all.update(cam.position, new THREE.Vector3(0, 0, 0));
  assert.ok(g.lod().ao > 0 && g.lod().ao < all.lod().ao * 0.6, `(${g.lod().ao} of ${all.lod().ao})`);
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (const c of g.group.children as THREE.InstancedMesh[]) {
    if (!c.isInstancedMesh || !c.name.startsWith('ao:')) continue;
    for (let j = 0; j < c.count; j++) {
      m.fromArray(c.instanceMatrix.array, j * 16);
      assert.ok(-p.setFromMatrixPosition(m).sub(cam.position).dot(fwd) < 200, `${c.name}: nothing far behind the eye`);
    }
  }
  g.dispose();
  all.dispose();
});

test("a rebuild (a district's plaza laid) refills the view's copies from the new build", () => {
  const g = grid();
  const cam = eyeAt(200, -150, [0, 1]);
  g.update(cam.position, new THREE.Vector3(200, 0, 0), cam);
  const before = g.lod();
  // A plaza where the eye looks: its lots give way, and the view must not keep drawing them.
  g.setPlazas([{ x: 200, z: 160, rootHeight: 30 }]);
  const after = g.lod();
  assert.ok(after.viewFills > before.viewFills, 'the rebuild refilled the view');
  assert.notEqual(after.city, before.city, 'the plaza changed what the city holds');
  assertFaithful(g);
  assertComplete(g, cam);
  g.dispose();
});

test('a freed plot fills over 1.2 s, its blocks rising from the ground', () => {
  const g = grid();
  const cam = eyeAt(0, 600, [0, -1]);
  cam.position.y = 300;
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const plaza = { x: 240, z: 0 };
  g.setPlazas([plaza]);
  let now = 0;
  g.update(cam.position, new THREE.Vector3(0, 0, 0), cam, now);
  const tallest = (): number => {
    // The highest top among the view's wall instances standing on the plot.
    let top = 0;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const { copy } of pairs(g)) {
      if (!copy.name.startsWith('wall')) continue;
      for (let j = 0; j < copy.count; j++) {
        m.fromArray(copy.instanceMatrix.array, j * 16).decompose(p, q, s);
        if (Math.hypot(p.x - plaza.x, p.z - plaza.z) < 40) top = Math.max(top, p.y + s.y / 2);
      }
    }
    return top;
  };
  assert.equal(tallest(), 0, 'the plaza stands clear of buildings');
  // The plot is given back: its blocks start at the ground and rise over PLOT_FILL_S.
  g.setPlazas([]);
  g.update(cam.position, new THREE.Vector3(0, 0, 0), cam, now);
  const start = tallest();
  now += 600;
  g.update(cam.position, new THREE.Vector3(0, 0, 0), cam, now);
  const mid = tallest();
  now += 700;
  g.update(cam.position, new THREE.Vector3(0, 0, 0), cam, now);
  const end = tallest();
  assert.ok(end > 10, `the plot is built up again (${end.toFixed(1)} m)`);
  assert.ok(start < end * 0.05, `at first its blocks stand near the ground (${start.toFixed(1)} of ${end.toFixed(1)} m)`);
  assert.ok(mid > start && mid < end, `half way they are rising (${mid.toFixed(1)} m)`);
  assertFaithful(g);
  g.dispose();
});

test('a turn of the eye copies only the blocks it newly meets, and lets the rest go a copy a frame', () => {
  const g = grid();
  const cam = eyeAt(200, -150, [0, 1]);
  g.update(cam.position, new THREE.Vector3(200, 0, 0), cam);
  flushRemerges();
  const held = g.lod().view;
  const writes = g.lod().viewWrites;
  // A quarter turn to the right: new blocks come into view at its edge.
  const turned = eyeAt(200, -150, [0.7, 0.7]);
  g.update(turned.position, new THREE.Vector3(200, 0, 0), turned);
  assertComplete(g, turned);
  const wrote = g.lod().viewWrites - writes;
  assert.ok(wrote > 0 && wrote < held, `the turn copied only what it newly met (${wrote} instances, against ${held} held)`);
  // Turned right round, what is now behind is let go a copy at a time: never every copy in one frame.
  const back = eyeAt(200, -150, [0, -1]);
  g.update(back.position, new THREE.Vector3(200, 0, 0), back);
  assertComplete(g, back);
  const waiting = pendingRemerges();
  assert.ok(waiting > 1, `the letting go waits for the frames after, a copy a piece of work (${waiting} waiting)`);
  for (let frames = 0; pendingRemerges() > 0 && frames < 200; frames++) runRemerges();
  assertNothingBehind(g, back);
  assertFaithful(g);
  g.dispose();
});
