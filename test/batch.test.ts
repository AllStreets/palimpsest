import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import * as batch from '../app/src/city/batch.js';
import { batchPieces, drawnMeshes } from '../app/src/city/batch.js';

const stone = new THREE.MeshStandardMaterial();
const glass = new THREE.MeshStandardMaterial();

/** A small block of two materials stood at (x, z). */
function block(x: number, z: number): THREE.Group {
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  const a = new THREE.Mesh(new THREE.BoxGeometry(8, 20, 8), stone);
  a.position.y = 10;
  const b = new THREE.Mesh(new THREE.BoxGeometry(8.4, 1, 8.4), glass);
  b.position.y = 20.5;
  root.add(a, b);
  return root;
}

/** The camera at eye level at the origin, looking down +z. */
function forward(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1.6, 0.5, 4000);
  cam.position.set(0, 2, 0);
  cam.lookAt(0, 2, 100);
  cam.updateMatrixWorld(true);
  return cam;
}

type Clustered = THREE.Mesh & {
  clusters: Array<{ start: number; count: number; box: THREE.Box3 }>;
  visibleRanges(camera: THREE.Camera): Array<[number, number]>;
};

const clustered = (g: THREE.Object3D): Clustered[] => g.children.filter((c) => Array.isArray((c as Clustered).clusters)) as Clustered[];
const triangles = (ranges: Array<[number, number]>): number => ranges.reduce((n, [, c]) => n + c / 3, 0);

test('a cluster behind the camera is not drawn', () => {
  const ahead = block(0, 120);
  const behind = block(0, -120);
  const b = batchPieces([ahead, behind]);
  const meshes = clustered(b.group);
  assert.equal(meshes.length, 2, 'one clustered batch for the stone and one for the glass');
  const cam = forward();
  for (const m of meshes) {
    assert.ok(m.clusters.length >= 2, 'the two blocks, 240 m apart, fall in clusters of their own');
    const all = m.geometry.index!.count / 3;
    assert.equal(triangles(m.visibleRanges(cam)), all / 2, 'only the block ahead is drawn');
    // As the renderer draws it: the multi-draw list the frame reads holds the block ahead alone.
    m.onBeforeRender(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.Scene, cam, m.geometry, m.material as THREE.Material, null as unknown as THREE.Group);
    const own = m as unknown as { _multiDrawCount: number; _multiDrawCounts: Int32Array };
    let drawn = 0;
    for (let i = 0; i < own._multiDrawCount; i++) drawn += own._multiDrawCounts[i] / 3;
    assert.equal(drawn, all / 2);
  }
  b.dispose();
});

test('the shadow pass culls against its own camera, not the view', () => {
  const b = batchPieces([block(0, 120), block(0, -120)]);
  const m = clustered(b.group)[0];
  // A sun camera over the whole city: both blocks cast, though one stands behind the view.
  const sun = new THREE.OrthographicCamera(-400, 400, 400, -400, 1, 2000);
  sun.position.set(0, 600, 0);
  sun.lookAt(0, 0, 0);
  sun.updateMatrixWorld(true);
  m.onBeforeShadow(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.Scene, forward(), sun, m.geometry, m.material as THREE.Material, null as unknown as THREE.Group);
  const own = m as unknown as { _multiDrawCount: number; _multiDrawCounts: Int32Array };
  let drawn = 0;
  for (let i = 0; i < own._multiDrawCount; i++) drawn += own._multiDrawCounts[i];
  assert.equal(drawn, m.geometry.index!.count, 'every cluster under the sun casts');
  b.dispose();
});

test('visible ranges cover exactly the visible clusters', () => {
  const roots: THREE.Group[] = [];
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) roots.push(block(i * 70, j * 70));
  const b = batchPieces(roots);
  const cam = forward();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  assert.equal(clustered(b.group).length, 2, 'both batches are laid out in clusters');
  for (const m of clustered(b.group)) {
    assert.ok(m.clusters.length > 100, `the grid falls in many clusters (${m.clusters.length})`);
    for (const c of m.clusters) {
      const size = c.box.getSize(new THREE.Vector3());
      assert.ok(size.x <= batch.CLUSTER_SIZE + 9 && size.z <= batch.CLUSTER_SIZE + 9, 'a cluster spans at most its cell and the pieces across its edge');
    }
    const ranges = m.visibleRanges(cam);
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][0] + ranges[i - 1][1], 'ranges are in order, apart and merged where they touch');
    const inRange = (s: number, n: number): boolean => ranges.some(([a, k]) => s >= a && s + n <= a + k);
    let want = 0;
    for (const c of m.clusters) {
      const seen = frustum.intersectsBox(c.box);
      assert.equal(inRange(c.start, c.count), seen, `a cluster is drawn exactly when the frustum meets its bounds`);
      if (seen) want += c.count;
    }
    assert.equal(ranges.reduce((n, [, k]) => n + k, 0), want, 'and nothing else is drawn');
    assert.ok(want < m.geometry.index!.count / 2, 'looking one way down the grid draws under half of it');
  }
  b.dispose();
});

test('calls per batch stay one', () => {
  // (guard) However many clusters a batch falls in, it is one mesh: one draw call a pass.
  const roots: THREE.Group[] = [];
  for (let i = 0; i < 20; i++) roots.push(block(i * 90, (i % 5) * 90));
  const b = batchPieces(roots);
  assert.equal(drawnMeshes(b.group), 2);
  b.dispose();
});

test("three's batched draw still reads the private fields ClusterMesh fills", async () => {
  // ClusterMesh (batch.ts) draws through three r187's batched path by its private field names: an upgrade that renames
  // any of them would draw every batch whole, or nothing, without an error.
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { dirname } = await import('node:path');
  const root = `${dirname(dirname(req.resolve('three')))}/`;
  const renderer = readFileSync(`${root}src/renderers/WebGLRenderer.js`, 'utf8');
  const programs = readFileSync(`${root}src/renderers/webgl/WebGLPrograms.js`, 'utf8');
  for (const name of ['isBatchedMesh', '_multiDrawStarts', '_multiDrawCounts', '_multiDrawCount', '_matricesTexture', '_indirectTexture', '_colorsTexture']) {
    assert.ok(renderer.includes(`object.${name}`) || programs.includes(`object.${name}`), `three still reads object.${name}`);
  }
  const m = clustered(batchPieces([block(0, 0)]).group)[0] as unknown as Record<string, unknown>;
  for (const name of ['_multiDrawStarts', '_multiDrawCounts', '_multiDrawCount', '_matricesTexture', '_indirectTexture', '_colorsTexture']) assert.ok(name in m, `ClusterMesh carries ${name}`);
});

test('scheduleRemerge coalesces a key and does at most 4 ms a frame', () => {
  // A clock each piece of work moves on by a millisecond and a half: four milliseconds hold three pieces.
  let now = 0;
  const q = batch.remergeQueue(4, () => now);
  const ran: string[] = [];
  const work = (name: string) => () => {
    now += 1.5;
    ran.push(name);
  };
  q.schedule('a', work('a-old'));
  for (const k of ['b', 'c', 'd', 'e']) q.schedule(k, work(k));
  // The same key again replaces its work and runs after what was queued since.
  q.schedule('a', work('a'));
  assert.equal(q.pending(), 5);
  q.run();
  assert.deepEqual(ran, ['b', 'c', 'd'], 'a frame stops once four milliseconds of work are spent');
  q.run();
  assert.deepEqual(ran, ['b', 'c', 'd', 'e', 'a'], 'the next frame takes the rest; the replaced work never runs');
  assert.equal(q.pending(), 0);
  // A piece that says it has more to do stays first in line and goes on in the same frame while time is left.
  let steps = 0;
  q.schedule('long', () => {
    now += 1;
    steps++;
    return steps < 10;
  });
  q.schedule('after', work('after'));
  q.run();
  assert.equal(steps, 4, 'a frame runs four steps of a millisecond');
  q.run();
  q.run();
  assert.equal(steps, 10);
  assert.equal(ran.at(-1), 'after', 'what was queued behind it runs once it is done');
  // The shared queue the city's loop runs.
  assert.equal(typeof batch.scheduleRemerge, 'function');
  assert.equal(typeof batch.runRemerges, 'function');
});
