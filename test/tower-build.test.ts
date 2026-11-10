import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { buildTower, FLOOR_WIDTH } from '../app/src/city/tower/build.js';
import { PANE_CHANNEL, type TowerMaterials } from '../app/src/city/tower/kit.js';
import { type Look, lookFor, VARIANTS } from '../app/src/city/tower/variants.js';
import { layoutTower, ROOT_HEIGHT } from '../shared/tower-layout.js';
import type { Era, Floor, FloorSize, RootStyle, TowerSpec } from '../shared/types.js';

const ROOTS: RootStyle[] = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];
const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
const SIZES: FloorSize[] = ['small', 'medium', 'large'];
/** The ambient city keeps this far from a district's origin. */
const RESERVE_RADIUS = 90;

/** Plain materials: no textures, no DOM, so the tower builds in Node. One material per key, made on first use. */
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
    const slab = vertsOf(t.group, mats.scifiTrim).filter((v) => v.y > lay.datumY - 1e-3 && v.y < lay.datumY + 0.96);
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

// ---------------------------------------------------------------- per-repo variants

/** A look with `era` swapped to the named variant. */
function lookWith(id: string): Look {
  const era = id.split(':')[0] as Era;
  const v = VARIANTS[era].find((x) => x.id === id);
  if (!v) throw new Error(`no variant ${id}`);
  return { ...lookFor('acme/widgets'), [era]: v };
}

function single(era: Era, n = 1): TowerSpec {
  const floors = Array.from({ length: n }, (_, i) => floor(i, era));
  return { id: 'acme/one#founding', repo: 'acme/one', kind: 'founding', root: 'chicago', floors, datumIndex: n };
}

const instances = (o: THREE.Object3D, name: string): THREE.InstancedMesh | undefined =>
  o.getObjectByName(name) as THREE.InstancedMesh | undefined;

test('every variant of every era builds inside its height and the city reserve', () => {
  for (const era of ERAS) {
    for (const v of VARIANTS[era]) {
      const s = spec('beauxarts', 3);
      const t = buildTower(s, 'high', plainMaterials(), lookWith(v.id));
      const box = bounds(t.group);
      assert.ok(Math.abs(box.max.y - t.top) < 1e-3, `${v.id}: top ${box.max.y} vs ${t.top}`);
      const reach = Math.max(...[box.min.x, box.max.x].flatMap((x) => [box.min.z, box.max.z].map((z) => Math.hypot(x, z))));
      assert.ok(reach < RESERVE_RADIUS, `${v.id}: footprint reaches ${reach.toFixed(1)} m`);
      assert.equal(t.pickables.size, s.floors.length);
      t.dispose();
    }
  }
});

test('each era draws its own slots: a tower uses one material per slot, never one per floor', () => {
  const mats = plainMaterials();
  const t = buildTower(spec('roman', 6), 'high', mats, lookWith('brick:ironspot'));
  const used = new Map<THREE.Material, number>();
  t.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material !== mats.pick && !(o as THREE.InstancedMesh).isInstancedMesh) used.set(m.material as THREE.Material, (used.get(m.material as THREE.Material) ?? 0) + 1);
  });
  for (const [m, n] of used) assert.equal(n, 1, `${m.name} is merged into one mesh, not ${n}`);
  for (const key of ['stoneWall', 'brickWall', 'brickTrim', 'brickBand', 'glassWall', 'glassTrim', 'titaniumWall', 'scifiWall', 'scifiTrim'] as const) {
    assert.ok(used.has(mats[key]) || [...t.group.children].some((c) => (c as THREE.Mesh).material === mats[key]), `${key} is drawn`);
  }
});

test('glazed terracotta pairs its windows; ironspot runs tall and narrow', () => {
  const panes = (id: string): THREE.InstancedMesh => {
    const t = buildTower(single('brick'), 'high', plainMaterials(), lookWith(id));
    const m = instances(t.group, 'tower:pane:brick');
    assert.ok(m, `${id} has brick panes`);
    return m!;
  };
  const bays = (bay: number): number => Math.max(3, Math.round(FLOOR_WIDTH / bay));
  const red = VARIANTS.brick.find((v) => v.id === 'brick:red')!;
  const tc = VARIANTS.brick.find((v) => v.id === 'brick:terracotta')!;
  assert.equal(panes('brick:red').count, 4 * bays(red.masonry?.bay ?? 2.9));
  assert.equal(panes('brick:terracotta').count, 8 * bays(tc.masonry!.bay!));
  // Pairs: the two panes of a bay sit closer to each other than to the next bay's.
  const m = panes('brick:terracotta');
  const xs: number[] = [];
  const p = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat);
    p.setFromMatrixPosition(mat);
    // The +z face: the panes just inside the wall line.
    if (p.z > FLOOR_WIDTH / 2 - 1) xs.push(p.x);
  }
  xs.sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  const inPair = gaps.filter((_, i) => i % 2 === 0);
  const between = gaps.filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...inPair) < Math.min(...between), `paired gaps ${inPair.map((g) => g.toFixed(2))} vs ${between.map((g) => g.toFixed(2))}`);
  // Ironspot: windows taller than they are wide.
  const iron = panes('brick:ironspot');
  iron.getMatrixAt(0, mat);
  const sc = new THREE.Vector3();
  mat.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
  assert.ok(sc.y > sc.x * 2, `ironspot window ${sc.x.toFixed(2)} x ${sc.y.toFixed(2)}`);
});

test('ribbed channel glass marks its panes as channel glass', () => {
  const t = buildTower(single('glass', 2), 'high', plainMaterials(), lookWith('glass:channel'));
  const m = instances(t.group, 'tower:pane:glass')!;
  assert.ok(m.instanceColor, 'pane data is set');
  const c = new THREE.Color();
  for (let i = 0; i < m.count; i++) {
    m.getColorAt(i, c);
    assert.ok(Math.abs(c.b - PANE_CHANNEL) < 1e-6, `pane ${i} style ${c.b}`);
  }
});

test('dark carbon sets light seams into its masts', () => {
  const lit = (id: string): number => {
    const mats = plainMaterials();
    const t = buildTower(single('scifi', 3), 'high', mats, lookWith(id));
    return vertsOf(t.group, mats.lightLine).length;
  };
  assert.ok(lit('scifi:carbon') > lit('scifi:ceramic'), 'carbon has more light-line geometry than ceramic');
});

test('floors laid in different years drift a few percent in colour; one year matches itself', () => {
  const floors = Array.from({ length: 6 }, (_, i) => ({ ...floor(i, 'brick'), at: new Date(Date.UTC(i < 3 ? 2019 : 2022, 3, 1 + i)).toISOString() }));
  const s: TowerSpec = { id: 'acme/years#founding', repo: 'acme/years', kind: 'founding', root: 'chicago', floors, datumIndex: 6 };
  const mats = plainMaterials();
  const t = buildTower(s, 'high', mats, lookWith('brick:cream'));
  const lay = layoutTower(s);
  let wall: THREE.Mesh | null = null;
  t.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === mats.brickWall && !(o as THREE.InstancedMesh).isInstancedMesh) wall = o as THREE.Mesh;
  });
  assert.ok(wall, 'a brick wall mesh');
  const g = (wall as unknown as THREE.Mesh).geometry;
  const col = g.getAttribute('color');
  assert.ok(col, 'the wall carries a per-floor colour');
  const pos = g.getAttribute('position');
  const tone = (fi: number): THREE.Color => {
    const { y0, h } = lay.floors[fi];
    const sum = new THREE.Color(0, 0, 0);
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > y0 + 0.05 && y < y0 + h - 0.05) {
        sum.r += col.getX(i);
        sum.g += col.getY(i);
        sum.b += col.getZ(i);
        n++;
      }
    }
    return sum.multiplyScalar(1 / n);
  };
  const diff = (a: THREE.Color, b: THREE.Color): number => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
  assert.ok(diff(tone(0), tone(2)) < 1e-6, 'one year, one tone');
  const d = diff(tone(1), tone(4));
  assert.ok(d > 0.01 && d < 0.1, `two years drift ${d.toFixed(3)}`);
});
