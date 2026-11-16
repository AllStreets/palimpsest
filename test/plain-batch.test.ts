import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { plainBatch } from '../app/src/city/plain-batch.js';

const stone = new THREE.MeshStandardMaterial();
const glass = new THREE.MeshStandardMaterial();

/** A tower-like piece: a plain mesh per material, an instanced part and a hidden pick proxy, stood at x. */
function piece(x: number): { root: THREE.Group; proxy: THREE.Mesh; inst: THREE.InstancedMesh } {
  const root = new THREE.Group();
  root.position.set(x, 0, 0);
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 2), stone);
  a.position.y = 5;
  a.castShadow = a.receiveShadow = true;
  a.name = 'tower:stone';
  const b = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1, 2.2).toNonIndexed(), glass);
  b.castShadow = b.receiveShadow = true;
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), stone, 3);
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), stone);
  root.add(a, b, inst, proxy);
  return { root, proxy, inst };
}

const drawCalls = (g: THREE.Object3D): number => g.children.length;
const worldBox = (g: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(g);

test('the plain meshes of every tower draw as one mesh per material, in place, and the instanced parts stay', () => {
  const pieces = [piece(0), piece(100), piece(-60)];
  const batch = plainBatch();
  const proxies = new Set<THREE.Object3D>(pieces.map((p) => p.proxy));
  assert.equal(batch.set(pieces.map((p) => p.root), (o) => proxies.has(o)), true);
  assert.equal(drawCalls(batch.group), 2, 'one mesh for the stone, one for the glass');
  const stoneMesh = batch.group.children.find((m) => (m as THREE.Mesh).material === stone) as THREE.Mesh;
  assert.equal(stoneMesh.name, 'tower:stone');
  assert.equal(stoneMesh.castShadow, true);
  const box = worldBox(stoneMesh);
  assert.ok(Math.abs(box.min.x - -61) < 1e-4 && Math.abs(box.max.x - 101) < 1e-4 && Math.abs(box.max.y - 10) < 1e-4, 'the merged stone stands where the towers stood');
  assert.equal((stoneMesh.userData.lodParts as THREE.Sphere[]).length, 3, 'each tower is a part for the distance pass');
  for (const p of pieces) {
    assert.equal(p.inst.visible, true, 'instanced parts draw on their tower');
    assert.equal(p.proxy.visible, true, 'a skipped proxy is left alone');
    assert.equal(p.root.children.filter((c) => !(c as THREE.InstancedMesh).isInstancedMesh && c !== p.proxy && c.visible).length, 0, 'the plain meshes hide');
  }
  // Nothing changed: nothing re-merged.
  assert.equal(batch.set(pieces.map((p) => p.root)), false);
  batch.dispose();
});

test('a tower rebuilt or let go re-merges, and the merged mesh holds only the towers listed', () => {
  const a = piece(0);
  const b = piece(50);
  const batch = plainBatch();
  batch.set([a.root, b.root]);
  const tri = (): number => batch.group.children.reduce((n, m) => n + ((m as THREE.Mesh).geometry.index?.count ?? 0) / 3, 0);
  const two = tri();
  const c = piece(50);
  c.root.scale.y = 2;
  batch.set([a.root, c.root]);
  assert.equal(tri(), two, 'the rebuilt tower replaces the old one');
  assert.ok(Math.abs(worldBox(batch.group).max.y - 20) < 1e-4, 'and draws as rebuilt');
  batch.set([a.root]);
  assert.equal(tri(), two / 2);
  batch.set([]);
  assert.equal(drawCalls(batch.group), 0);
  batch.dispose();
});

test('a rebuild lets go of the merged geometry it replaces', () => {
  const a = piece(0);
  const b = piece(50);
  const batch = plainBatch();
  batch.set([a.root, b.root]);
  const before = batch.group.children.map((m) => (m as THREE.Mesh).geometry);
  assert.ok(before.length > 0 && before.every((g) => g.index !== null), 'the towers merged into geometries of their own');
  let disposed = 0;
  for (const g of before) g.addEventListener('dispose', () => disposed++);
  // One tower rebuilt: every material it drew in re-merges, and each old merged geometry is disposed once.
  const c = piece(50);
  batch.set([a.root, c.root]);
  assert.equal(disposed, before.length, `each replaced geometry disposed once (${disposed} of ${before.length})`);
  const after = batch.group.children.map((m) => (m as THREE.Mesh).geometry);
  assert.ok(after.every((g) => !before.includes(g)), 'and the batch draws new ones');
  // Let go whole: the merged geometries go too.
  let gone = 0;
  for (const g of after) g.addEventListener('dispose', () => gone++);
  batch.dispose();
  assert.equal(gone, after.length, 'dispose lets go of every merged geometry');
});

test('a tower behind the camera is not drawn: its clusters drop out of the merged draw', () => {
  const ahead = piece(0);
  ahead.root.position.z = 150;
  const behind = piece(0);
  behind.root.position.z = -150;
  const batch = plainBatch();
  batch.set([ahead.root, behind.root], (o) => o === ahead.proxy || o === behind.proxy);
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.5, 4000);
  cam.position.set(0, 2, 0);
  cam.lookAt(0, 2, 100);
  cam.updateMatrixWorld(true);
  type C = THREE.Mesh & { clusters?: unknown[]; visibleRanges(c: THREE.Camera): Array<[number, number]> };
  const meshes = batch.group.children as C[];
  assert.ok(meshes.length === 2 && meshes.every((m) => Array.isArray(m.clusters)), 'each merged mesh is laid out in clusters');
  for (const m of meshes) {
    const drawn = m.visibleRanges(cam).reduce((n, [, k]) => n + k, 0);
    assert.equal(drawn, m.geometry.index!.count / 2, 'only the tower ahead is drawn');
  }
  batch.dispose();
});
