import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { buildTower } from '../app/src/city/tower/build.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { layoutTower, ROOT_HEIGHT } from '../shared/tower-layout.js';
import type { Era, Floor, FloorSize, RootStyle, TowerSpec } from '../shared/types.js';

const ROOTS: RootStyle[] = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];
const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
const SIZES: FloorSize[] = ['small', 'medium', 'large'];
/** The ambient city keeps this far from a district's origin. */
const RESERVE_RADIUS = 90;

/** Plain materials: no textures, no DOM, so the tower builds in Node. */
function plainMaterials(): TowerMaterials {
  const keys: Array<keyof TowerMaterials> = [
    'sand', 'travertine', 'gothic', 'limestone', 'granite', 'brick', 'bronze', 'datum', 'titanium', 'steel', 'graphite', 'slab',
    'window', 'stained', 'roofTile', 'timber', 'plaster', 'lightLine', 'accent', 'pick',
  ];
  return Object.fromEntries(keys.map((k) => [k, new THREE.MeshStandardMaterial()])) as unknown as TowerMaterials;
}

function floor(i: number, era: Era, claude = false): Floor {
  return {
    id: `acme/widgets#f${i}`,
    repo: 'acme/widgets',
    kind: 'commits',
    refs: [`f${i}`],
    title: `change ${i}`,
    at: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    era,
    size: SIZES[i % 3],
    lines: 10 * i,
    claude,
    founding: true,
    url: null,
  };
}

/** Every era in order, `per` floors each, every third floor co-authored by Claude. */
function spec(root: RootStyle, per = 3): TowerSpec {
  const floors = ERAS.flatMap((era, e) => Array.from({ length: per }, (_, j) => floor(e * per + j, era, (e * per + j) % 3 === 0)));
  return { id: `acme/widgets#founding`, repo: 'acme/widgets', kind: 'founding', root, floors, datumIndex: floors.length };
}

/** Bounds of what renders: invisible pick proxies are left out, so a short structure cannot pass on its proxies alone. */
function bounds(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3();
  o.traverseVisible((c) => {
    if ((c as THREE.Mesh).isMesh) box.expandByObject(c, false);
  });
  return box;
}

/** Bounds of one object regardless of visibility (pick proxies). */
function proxyBounds(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

test('tower height equals layoutTower top', () => {
  const s = spec('beauxarts', 4);
  const t = buildTower(s, 'high', plainMaterials());
  const top = layoutTower(s).top;
  assert.equal(t.top, top);
  const box = bounds(t.group);
  assert.ok(Math.abs(box.max.y - top) < 1e-3, `tallest point ${box.max.y} should equal layout top ${top}`);
  assert.ok(box.min.y >= -1e-6, `nothing below ground (min y ${box.min.y})`);
});

test('one pickable per floor', () => {
  const s = spec('roman', 2);
  const t = buildTower(s, 'high', plainMaterials());
  assert.equal(t.pickables.size, s.floors.length);
  assert.deepEqual([...t.pickables.values()].sort(), s.floors.map((f) => f.id).sort());
  // Each floor's pick proxy spans exactly that floor's slice of the layout.
  const laid = new Map(layoutTower(s).floors.map((l) => [l.floor.id, l]));
  for (const [proxy, id] of t.pickables) {
    const l = laid.get(id)!;
    const b = proxyBounds(proxy);
    assert.ok(Math.abs(b.min.y - l.y0) < 1e-6 && Math.abs(b.max.y - (l.y0 + l.h)) < 1e-6, `proxy for ${id} spans its floor`);
  }
});

test('empty spec builds only the root', () => {
  for (const root of ROOTS) {
    const s: TowerSpec = { id: 'acme/empty#founding', repo: 'acme/empty', kind: 'founding', root, floors: [], datumIndex: 0 };
    const t = buildTower(s, 'high', plainMaterials());
    assert.equal(t.pickables.size, 0);
    assert.equal(t.top, ROOT_HEIGHT[root]);
    const box = bounds(t.group);
    assert.ok(Math.abs(box.max.y - ROOT_HEIGHT[root]) < 1e-3, `${root} root is ${box.max.y} m, expected ${ROOT_HEIGHT[root]}`);
  }
});

test('every RootStyle and Era builds without throwing', () => {
  for (const quality of ['high', 'medium'] as const) {
    for (const root of ROOTS) {
      const s = spec(root, 3);
      const t = buildTower(s, quality, plainMaterials());
      const box = bounds(t.group);
      assert.ok(Math.abs(box.max.y - t.top) < 1e-3, `${root}/${quality}: top ${box.max.y} vs ${t.top}`);
      // The footprint stays inside the reserve the ambient city keeps clear.
      const reach = Math.max(
        ...[box.min.x, box.max.x].flatMap((x) => [box.min.z, box.max.z].map((z) => Math.hypot(x, z))),
      );
      assert.ok(reach < RESERVE_RADIUS, `${root}: footprint reaches ${reach.toFixed(1)} m`);
      t.dispose();
    }
  }
});

test('the root alone stands at its own height for every style', () => {
  for (const root of ROOTS) {
    const s = spec(root, 1);
    const t = buildTower(s, 'medium', plainMaterials());
    const rootBox = proxyBounds(t.rootPick);
    assert.ok(Math.abs(rootBox.max.y - ROOT_HEIGHT[root]) < 1e-6, `${root} root proxy tops out at ${ROOT_HEIGHT[root]}`);
  }
});

test('dispose frees instanced buffers as well as geometry', () => {
  const t = buildTower(spec('gothic', 2), 'high', plainMaterials());
  let instanced = 0;
  let freed = 0;
  t.group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      instanced++;
      o.addEventListener('dispose', () => freed++);
    }
  });
  t.dispose();
  assert.ok(instanced > 0);
  assert.equal(freed, instanced);
});

test('a datum partway up any era builds and stays inside the tower', () => {
  for (const era of ERAS) {
    const floors = Array.from({ length: 6 }, (_, i) => floor(i, era, i % 2 === 0));
    const s: TowerSpec = { id: 'acme/mid#founding', repo: 'acme/mid', kind: 'founding', root: 'chicago', floors, datumIndex: 3 };
    const t = buildTower(s, 'high', plainMaterials());
    const box = bounds(t.group);
    assert.ok(Math.abs(box.max.y - t.top) < 1e-3, `${era}: top ${box.max.y} vs ${t.top}`);
  }
});

/** World positions of every vertex drawn in `mat`, merged meshes only. */
function vertsOf(o: THREE.Object3D, mat: THREE.Material): THREE.Vector3[] {
  o.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || (c as THREE.InstancedMesh).isInstancedMesh || m.material !== mat) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  return out;
}

test('a sci-fi datum below more floors never reaches past the slab above it', () => {
  // Terraces turn side every three floors, so try every datum height in a run of nine.
  for (let datumIndex = 1; datumIndex < 9; datumIndex++) {
    const floors = Array.from({ length: 10 }, (_, i) => floor(i, 'scifi'));
    const s: TowerSpec = { id: 'acme/mid#founding', repo: 'acme/mid', kind: 'founding', root: 'chicago', floors, datumIndex };
    const mats = plainMaterials();
    const t = buildTower(s, 'high', mats);
    const lay = layoutTower(s);
    const band = vertsOf(t.group, mats.datum);
    assert.ok(band.length > 0, 'the datum band is drawn');
    // The slab of the floor directly above: titanium in the first metre over the datum line.
    const slab = vertsOf(t.group, mats.titanium).filter((v) => v.y > lay.datumY - 1e-3 && v.y < lay.datumY + 0.96);
    assert.ok(slab.length > 0, 'the floor above has a slab');
    const sx0 = Math.min(...slab.map((v) => v.x));
    const sx1 = Math.max(...slab.map((v) => v.x));
    const sz0 = Math.min(...slab.map((v) => v.z));
    const sz1 = Math.max(...slab.map((v) => v.z));
    for (const v of band) {
      assert.ok(v.x >= sx0 - 1e-3 && v.x <= sx1 + 1e-3 && v.z >= sz0 - 1e-3 && v.z <= sz1 + 1e-3, `datum ${datumIndex}: band at (${v.x.toFixed(2)}, ${v.z.toFixed(2)}) is past the slab above [${sx0.toFixed(2)}..${sx1.toFixed(2)}] x [${sz0.toFixed(2)}..${sz1.toFixed(2)}]`);
    }
  }
});
