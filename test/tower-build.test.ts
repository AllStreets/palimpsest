import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { buildTower, FLOOR_WIDTH } from '../app/src/city/tower/build.js';
import { crownFloors } from '../app/src/city/tower/eras.js';
import { PANE_CHANNEL, PANE_FULL, type TowerMaterials } from '../app/src/city/tower/kit.js';
import { FAMILIES, type Look, lookFor, VARIANTS } from '../app/src/city/tower/variants.js';
import { DATUM_HEIGHT } from '../app/src/city/tower/datum.js';
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

/** The sci-fi variant of a family. */
function familyVariant(family: string) {
  const v = VARIANTS.scifi.find((x) => x.family === family);
  if (!v) throw new Error(`no sci-fi variant in the ${family} family`);
  return v;
}

test('a sci-fi datum below more floors wraps the floor under it, close to its facade, in every family', () => {
  for (const family of FAMILIES) {
    // Massing changes every few floors in most families, so try every datum height in a run of nine.
    for (let datumIndex = 1; datumIndex < 9; datumIndex++) {
      const floors = Array.from({ length: 10 }, (_, i) => floor(i, 'scifi'));
      const s: TowerSpec = { id: 'acme/mid#founding', repo: 'acme/mid', kind: 'founding', root: 'chicago', floors, datumIndex };
      const mats = plainMaterials();
      const t = buildTower(s, 'high', mats, { ...lookFor('acme/mid'), scifi: familyVariant(family) });
      const lay = layoutTower(s);
      const band = vertsOf(t.group, mats.datum);
      assert.ok(band.length > 0, `${family}: the datum band is drawn`);
      // Everything the floor below the band draws (its own mass, not the slab of the floor above), at the band's height.
      const under = lay.floors[datumIndex - 1];
      const ys = { lo: under.y0 + under.h - DATUM_HEIGHT - 0.05, hi: under.y0 + under.h + 0.05 };
      let reach = 0;
      t.group.updateMatrixWorld(true);
      t.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m.material === mats.pick || m.material === mats.datum) return;
        const pos = m.geometry.getAttribute('position');
        const v = new THREE.Vector3();
        const im = m as THREE.InstancedMesh;
        const n = im.isInstancedMesh ? im.count : 1;
        const mat = new THREE.Matrix4();
        for (let k = 0; k < n; k++) {
          if (im.isInstancedMesh) im.getMatrixAt(k, mat);
          else mat.identity();
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mat).applyMatrix4(m.matrixWorld);
            if (v.y > ys.lo && v.y < ys.hi) reach = Math.max(reach, Math.hypot(v.x, v.z));
          }
        }
      });
      const bandReach = Math.max(...band.map((v) => Math.hypot(v.x, v.z)));
      const bandInner = Math.min(...band.map((v) => Math.max(Math.abs(v.x), Math.abs(v.z))));
      // The band stands just proud of what it wraps: never buried inside the facade, never floating far from it.
      assert.ok(bandReach <= reach + 1.2, `${family} datum ${datumIndex}: band reaches ${bandReach.toFixed(2)} but the floor only ${reach.toFixed(2)}`);
      assert.ok(bandInner >= 1, `${family} datum ${datumIndex}: band collapsed`);
      t.dispose();
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

test('the carbon cluster sets light seams into its core; the ceramic shell carries none', () => {
  const lit = (id: string): number => {
    const mats = plainMaterials();
    const t = buildTower(single('scifi', 3), 'high', mats, lookWith(id));
    return vertsOf(t.group, mats.lightLine).length;
  };
  assert.ok(lit('scifi:cluster') > lit('scifi:organic'), 'the cluster has more light-line geometry than the organic shell');
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
    // The floor's own tone is its brightest vertex: weathering stains only ever darken it.
    const top = new THREE.Color(0, 0, 0);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > y0 + 0.05 && y < y0 + h - 0.05 && col.getY(i) > top.g) top.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    }
    return top;
  };
  const diff = (a: THREE.Color, b: THREE.Color): number => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
  assert.ok(diff(tone(0), tone(2)) < 1e-6, 'one year, one tone');
  const d = diff(tone(1), tone(4));
  assert.ok(d > 0.01 && d < 0.1, `two years drift ${d.toFixed(3)}`);
});

test('instanced parts take the year drift too; window data never does', () => {
  const floors = Array.from({ length: 4 }, (_, i) => ({ ...floor(i, 'glass'), at: new Date(Date.UTC(i < 2 ? 2019 : 2020, 3, 1 + i)).toISOString() }));
  const s: TowerSpec = { id: 'acme/years#founding', repo: 'acme/years', kind: 'founding', root: 'chicago', floors, datumIndex: 4 };
  const t = buildTower(s, 'high', plainMaterials(), lookWith('glass:blue'));
  const sp = instances(t.group, 'tower:spandrel')!;
  assert.ok(sp.instanceColor, 'spandrels carry a colour');
  const c0 = new THREE.Color();
  const c1 = new THREE.Color();
  const perFloor = sp.count / 4;
  sp.getColorAt(0, c0);
  sp.getColorAt(perFloor * 3, c1);
  assert.ok(Math.abs(c0.r - c1.r) > 0.01, `two years drift (${c0.r.toFixed(3)} vs ${c1.r.toFixed(3)})`);
  const panes = instances(t.group, 'tower:pane:glass')!;
  const c = new THREE.Color();
  for (let i = 0; i < panes.count; i++) {
    panes.getColorAt(i, c);
    assert.ok(c.r <= 1 && c.g <= 1 && Math.abs(c.b - PANE_FULL) < 1e-6, 'pane data is untouched');
  }
});

test('a curtain wall takes its spandrel height and mullion depth from the variant', () => {
  const scaleOf = (m: THREE.InstancedMesh): THREE.Vector3 => {
    const mat = new THREE.Matrix4();
    m.getMatrixAt(0, mat);
    const sc = new THREE.Vector3();
    mat.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
    return sc;
  };
  const green = buildTower(single('glass'), 'high', plainMaterials(), lookWith('glass:green'));
  assert.ok(Math.abs(scaleOf(instances(green.group, 'tower:spandrel')!).y - 1.5) < 1e-6, 'green runs ribbon spandrels 1.5 m tall');
  const bronze = buildTower(single('glass'), 'high', plainMaterials(), lookWith('glass:bronze'));
  const blue = buildTower(single('glass'), 'high', plainMaterials(), lookWith('glass:blue'));
  assert.ok(scaleOf(instances(bronze.group, 'tower:mullion')!).z > scaleOf(instances(blue.group, 'tower:mullion')!).z * 1.8, 'bronze mullions stand twice as deep');
});

test("a variant's lights set how its windows burn", () => {
  const warmShare = (id: string): number => {
    const t = buildTower(single('glass', 30), 'high', plainMaterials(), lookWith(id));
    const m = instances(t.group, 'tower:pane:glass')!;
    const c = new THREE.Color();
    let lit = 0;
    let warm = 0;
    for (let i = 0; i < m.count; i++) {
      m.getColorAt(i, c);
      if (c.r > 0.3) {
        lit++;
        if (c.g > 0.5) warm++;
      }
    }
    return warm / Math.max(1, lit);
  };
  assert.ok(warmShare('glass:bronze') > warmShare('glass:blue') + 0.4, 'bronze glass burns warm, blue burns cool');
});

test('masonry weathers: stains run down from every sill and from a run-end cornice, darkest at the top', () => {
  for (const id of ['stone:sandstone', 'brick:cream']) {
    const mats = plainMaterials();
    const era = id.split(':')[0] as Era;
    const t = buildTower(single(era, 2), 'high', mats, lookWith(id));
    const wall = [...t.group.children].find((c) => (c as THREE.Mesh).material === mats[`${era}Wall`] && !(c as THREE.InstancedMesh).isInstancedMesh) as THREE.Mesh;
    const col = wall.geometry.getAttribute('color');
    const pos = wall.geometry.getAttribute('position');
    let dark = 0;
    let darkTopY = -Infinity;
    let darkBottomY = Infinity;
    for (let i = 0; i < col.count; i++) {
      if (col.getY(i) < 0.85) {
        dark++;
        darkTopY = Math.max(darkTopY, pos.getY(i));
        darkBottomY = Math.min(darkBottomY, pos.getY(i));
      }
    }
    const panes = instances(t.group, `tower:pane:${era}`)!.count;
    // Eight box corners per stain, four of them on its dark top edge.
    assert.ok(dark >= panes * 4, `${id}: ${dark} dark stain vertices for ${panes} windows`);
    assert.ok(darkTopY > darkBottomY, `${id}: stains are darkest along their top edge`);
  }
});

/** How wide the drawn, merged faces are across x between heights `y0` and `y1` (boxes carry vertices only at their corners, so a floor is measured over its lower half, base included). */
function widthBetween(t: ReturnType<typeof buildTower>, y0: number, y1: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  t.group.updateMatrixWorld(true);
  t.group.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
    const pos = m.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y >= y0 && v.y <= y1) {
        lo = Math.min(lo, v.x);
        hi = Math.max(hi, v.x);
      }
    }
  });
  return hi - lo;
}

/** A floor's width: its merged faces over its lower half. */
function floorWidth(t: ReturnType<typeof buildTower>, lay: ReturnType<typeof layoutTower>, f: number): number {
  const { y0, h } = lay.floors[f];
  return widthBetween(t, y0 - 0.01, y0 + h * 0.5);
}

/** A sci-fi run of `n` floors in `family`, root to top, over a chicago root. */
function familyTower(family: string, n: number, mats = plainMaterials()) {
  const s = single('scifi', n);
  return { t: buildTower(s, 'high', mats, { ...lookFor('acme/one'), scifi: familyVariant(family) }), lay: layoutTower(s), mats };
}

test('every sci-fi family builds inside its height and the reserve, at every run length, and draws its own silhouette', () => {
  const profiles = new Set<string>();
  for (const family of FAMILIES) {
    for (const n of [1, 2, 3, 6, 12, 40]) {
      const { t } = familyTower(family, n);
      const box = bounds(t.group);
      // Heights are the layout's alone: no family adds a spire, mast or taller storey.
      assert.ok(Math.abs(box.max.y - t.top) < 1e-3, `${family} x${n}: top ${box.max.y} vs ${t.top}`);
      const reach = Math.max(...[box.min.x, box.max.x].flatMap((x) => [box.min.z, box.max.z].map((z) => Math.hypot(x, z))));
      assert.ok(reach < RESERVE_RADIUS, `${family} x${n} reaches ${reach.toFixed(1)}`);
      assert.equal(t.pickables.size, n, `${family} x${n}: one pick per floor`);
      t.dispose();
    }
    const { t, lay } = familyTower(family, 12);
    const widths = [2, 5, 8, 10, 11].map((f) => floorWidth(t, lay, f).toFixed(0));
    profiles.add(widths.join(','));
    t.dispose();
  }
  assert.equal(profiles.size, FAMILIES.length, `family silhouettes: ${[...profiles].join(' | ')}`);
});

test('a ziggurat and a needle narrow as they rise; an arcology and a deco tower keep their mass until the deco setbacks', () => {
  for (const family of ['ziggurat', 'needle'] as const) {
    const { t, lay } = familyTower(family, 20);
    const w = [1, 9, 18].map((f) => floorWidth(t, lay, f));
    assert.ok(w[0] > w[1] + 0.5 && w[1] > w[2] + 0.5, `${family} narrows: ${w.map((x) => x.toFixed(1)).join(' > ')}`);
  }
  const deco = familyTower('deco', 20);
  const dw = [2, 5, 14, 19].map((f) => floorWidth(deco.t, deco.lay, f));
  // Only the tower's own 0.6 percent per floor taper between them.
  assert.ok(dw[1] > dw[0] * 0.95, `deco shaft holds its width low down (${dw[0].toFixed(1)} vs ${dw[1].toFixed(1)})`);
  assert.ok(dw[1] > dw[2] + 1 && dw[2] > dw[3] + 1, `deco steps back toward the crown: ${dw.map((x) => x.toFixed(1)).join(' > ')}`);
  const arc = familyTower('arcology', 20);
  const aw = [2, 10, 14].map((f) => floorWidth(arc.t, arc.lay, f));
  // Only the tower's own taper between the first and the last storey under the crown: no setbacks, no batter.
  assert.ok(aw[2] > aw[0] * 0.9 && aw[1] > aw[2], `arcology keeps its mass: ${aw.map((x) => x.toFixed(1)).join(', ')}`);
  // Its crown (the top five floors) throws a sky-garden deck out past the shaft.
  assert.ok(widthBetween(arc.t, arc.lay.floors[15].y0, arc.lay.top) > aw[2] + 2, 'the arcology crown cantilevers its deck past the shaft');
});

test('an arcology hangs habitation pods clear of its piers; a cluster climbs its core in offset boxes', () => {
  const arc = familyTower('arcology', 12);
  const pods = arc.t.group.getObjectByName('tower:pod') as THREE.InstancedMesh | undefined;
  assert.ok(pods && pods.count >= 4, 'an arcology of twelve floors hangs several pods');
  // Every pod reaches past the pier line of its floor.
  const mat = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (let i = 0; i < pods!.count; i++) {
    pods!.getMatrixAt(i, mat);
    mat.decompose(p, new THREE.Quaternion(), sc);
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) + Math.min(sc.x, sc.z) / 2 > FLOOR_WIDTH / 2 + 1, `pod ${i} cantilevers past the face`);
  }
  const cl = familyTower('cluster', 12);
  // Boxes offset in different directions on different floors: their plan centres are not all on the axis.
  const centres = new Set<string>();
  for (const [proxy] of cl.t.pickables) {
    const b = proxyBounds(proxy);
    centres.add(`${((b.min.x + b.max.x) / 2).toFixed(1)},${((b.min.z + b.max.z) / 2).toFixed(1)}`);
  }
  assert.ok(centres.size >= 4, `cluster floors centre at ${centres.size} places`);
});

test('every family tops out with aircraft warning lights and never with a spire', () => {
  for (const family of FAMILIES) {
    const { t, lay, mats } = familyTower(family, 8);
    const beacons = vertsOf(t.group, mats.beacon);
    assert.ok(beacons.length >= 8, `${family}: warning lights on the roof`);
    assert.ok(beacons.every((v) => v.y > lay.top - 1.2 && v.y <= lay.top + 1e-6), `${family}: the lights sit on the top floor's roof`);
    // Nothing thin reaches the top alone: the top 0.5 m is at least 1.5 m wide (no needle).
    assert.ok(widthBetween(t, lay.top - 0.6, lay.top) >= 1.5, `${family}: the top is a crown, not a spire`);
  }
});

test('the top floors of every sci-fi run carry its family crown from the Blender kit, scaled to the shaft and inside the height', () => {
  for (const family of FAMILIES) {
    for (const n of [1, 5, 9]) {
      const { t, lay } = familyTower(family, n);
      const first = lay.floors.length - crownFloors(n);
      // The crown floors draw no storey of their own: no window panes over the crown's first floor.
      const panes = instances(t.group, 'pane:scifi');
      const mat = new THREE.Matrix4();
      const p = new THREE.Vector3();
      let above = 0;
      for (let i = 0; i < (panes?.count ?? 0); i++) {
        panes!.getMatrixAt(i, mat);
        if (p.setFromMatrixPosition(mat).y > lay.floors[first].y0 + 0.1) above++;
      }
      assert.equal(above, 0, `${family} x${n}: the crown replaces the storeys above floor ${first}`);
      assert.ok(Math.abs(bounds(t.group).max.y - t.top) < 1e-3, `${family} x${n}: the crown tops out at the tower's own top`);
      t.dispose();
    }
  }
});

test('a datum inside the crown floors moves the crown up above the band', () => {
  const floors = Array.from({ length: 9 }, (_, i) => floor(i, 'scifi'));
  const s: TowerSpec = { id: 'acme/c#founding', repo: 'acme/c', kind: 'founding', root: 'chicago', floors, datumIndex: 8 };
  const mats = plainMaterials();
  const t = buildTower(s, 'high', mats, { ...lookFor('acme/c'), scifi: familyVariant('deco') });
  const lay = layoutTower(s);
  // A run of nine would crown its top three floors; the band tops floor 7, so the crown is the top floor alone,
  // and its lit slots all stand on floor 8, never across the band.
  const slots = vertsOf(t.group, mats.vent);
  assert.ok(slots.length > 0 && slots.every((v) => v.y >= lay.floors[8].y0 - 1e-3), 'the deco crown stands above the band');
  t.dispose();
});

test('the organic family stands on a round plan and its datum wraps it as a ring', () => {
  const floors = Array.from({ length: 6 }, (_, i) => floor(i, 'scifi'));
  const s: TowerSpec = { id: 'acme/round#founding', repo: 'acme/round', kind: 'founding', root: 'chicago', floors, datumIndex: 3 };
  const mats = plainMaterials();
  const t = buildTower(s, 'high', mats, { ...lookFor('acme/round'), scifi: familyVariant('organic') });
  const band = vertsOf(t.group, mats.datum);
  const radii = band.map((v) => Math.hypot(v.x, v.z));
  const spread = Math.max(...radii) - Math.min(...radii);
  assert.ok(spread < 0.8, `a ring's radii vary by ${spread.toFixed(2)}, a square band's by more`);
  // The shell's corners are not at the plan's half-width diagonals: a round plan's extent along x equals its extent along the diagonal.
  const wall = vertsOf(t.group, mats.scifiWall);
  const alongX = Math.max(...wall.map((v) => Math.abs(v.x)));
  const diag = Math.max(...wall.map((v) => Math.hypot(v.x, v.z)));
  assert.ok(diag < alongX * 1.1, `round plan: diagonal reach ${diag.toFixed(1)} vs ${alongX.toFixed(1)} along x`);
});

test('the ziggurat sets its light vents into the sloped faces, the deco crown lights its fin slots', () => {
  const zig = familyTower('ziggurat', 9);
  assert.ok(vertsOf(zig.t.group, zig.mats.vent).length > 0, 'ziggurat has warm vents');
  const deco = familyTower('deco', 9);
  const slots = vertsOf(deco.t.group, deco.mats.vent).filter((v) => v.y > deco.lay.floors[8].y0);
  assert.ok(slots.length > 0, 'the deco crown floor carries lit slots');
});

// ---------------------------------------------------------------- earned floors (Task 22)

/** A floor earned in the market above the datum: its job, agent and firm, and how it stands. */
function earned(i: number, era: Era, state: 'lit' | 'waiting' | 'scar', extra: Partial<Floor> = {}): Floor {
  const scar = state === 'scar';
  return {
    ...floor(100 + i, era),
    id: scar ? `acme/widgets#scar-run-${i}` : `acme/widgets#job-job-${i}`,
    kind: scar ? 'commits' : 'pr',
    refs: scar ? [] : [`#${300 + i}`],
    title: scar ? `Failed inspection: job ${i}` : `job ${i}`,
    founding: false,
    url: scar ? null : `https://github.com/acme/widgets/pull/${300 + i}`,
    earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId: 'priya-rao', firmId: 'quickset', state, reverted: false },
    ...extra,
  };
}

/** Founding floors in every era, then the earned floors given, the datum between them. */
function earnedSpec(above: Floor[], root: RootStyle = 'beauxarts'): TowerSpec {
  const base = spec(root, 3);
  return { ...base, floors: [...base.floors, ...above], datumIndex: base.floors.length };
}

/** Window panes whose centre falls between y0 and y1, as world-space pane data (r = how lit). */
function panesBetween(o: THREE.Object3D, y0: number, y1: number): THREE.Color[] {
  o.updateMatrixWorld(true);
  const out: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  o.traverse((c) => {
    const im = c as THREE.InstancedMesh;
    if (!im.isInstancedMesh || !im.name.startsWith('tower:pane:')) return;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      p.setFromMatrixPosition(m).applyMatrix4(im.matrixWorld);
      if (p.y < y0 || p.y > y1) continue;
      const col = new THREE.Color();
      im.getColorAt(i, col);
      out.push(col);
    }
  });
  return out;
}

/** Vertices of every merged mesh in `mat` (by material name) between y0 and y1. */
function namedVertsBetween(o: THREE.Object3D, name: string, y0: number, y1: number): number {
  o.updateMatrixWorld(true);
  let n = 0;
  const v = new THREE.Vector3();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || (m.material as THREE.Material).name !== name) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y >= y0 - 1e-6 && v.y <= y1 + 1e-6) n++;
    }
  });
  return n;
}

/** The pick proxy of a floor, by id. */
function proxyOf(t: ReturnType<typeof buildTower>, id: string): THREE.Object3D {
  for (const [p, fid] of t.pickables) if (fid === id) return p;
  throw new Error(`no proxy for ${id}`);
}

test('an earned floor builds above the datum', () => {
  const above = [earned(1, 'glass', 'lit'), earned(2, 'brick', 'lit'), earned(3, 'titanium', 'lit'), earned(4, 'scifi', 'lit'), earned(5, 'stone', 'lit')];
  const s = earnedSpec(above);
  const lay = layoutTower(s);
  const t = buildTower(s, 'high', plainMaterials());
  const box = bounds(t.group);
  assert.ok(Math.abs(box.max.y - lay.top) < 1e-3, `the tower tops out at the last earned floor (${box.max.y} vs ${lay.top})`);
  for (const f of above) {
    const b = proxyBounds(proxyOf(t, f.id));
    assert.ok(b.min.y >= lay.datumY - 1e-6, `${f.id} stands above the datum (${b.min.y} vs ${lay.datumY})`);
  }
  // A lit earned floor carries the cool line at its slab edge; founding floors never do.
  assert.ok(namedVertsBetween(t.group, 'earnedLine', lay.datumY, lay.top) > 0, 'lit earned floors draw the cool line');
  assert.equal(namedVertsBetween(t.group, 'earnedLine', 0, lay.datumY - 0.01), 0, 'no founding floor draws it');
  // Earned floors come in whatever era their agent works in, floor by floor: they hold one width (with the
  // taper) instead of stepping in at every change of era, and the first stands inside the datum band, a ledge.
  const first = layoutTower(s).floors[s.datumIndex];
  const firstHalf = proxyBounds(proxyOf(t, first.floor.id)).getSize(new THREE.Vector3()).x / 2;
  const lastFounding = proxyBounds(proxyOf(t, s.floors[s.datumIndex - 1].id)).getSize(new THREE.Vector3()).x / 2;
  assert.ok(firstHalf < lastFounding, `the first earned floor steps in from the founding top (${firstHalf.toFixed(2)} vs ${lastFounding.toFixed(2)})`);
  // The datum is a ledge under the earned floors: a concrete deck across the founding top, not a band on the roof.
  assert.ok(namedVertsBetween(t.group, 'datum', lay.datumY - 2, lay.datumY + 0.01) > 0, 'the bronze band wraps the founding top');
});

test('earned floors of mixed eras never step in more than the datum ledge', () => {
  const eras: Era[] = ['glass', 'brick', 'titanium', 'scifi', 'stone', 'glass', 'titanium', 'brick', 'scifi', 'glass', 'stone', 'titanium'];
  const s = earnedSpec(eras.map((e, i) => earned(i, e, 'lit')), 'chicago');
  const t = buildTower(s, 'high', plainMaterials());
  const datumFloor = proxyBounds(proxyOf(t, s.floors[s.datumIndex - 1].id)).getSize(new THREE.Vector3()).x;
  const top = proxyBounds(proxyOf(t, s.floors[s.floors.length - 1].id)).getSize(new THREE.Vector3()).x;
  // Twelve changes of era would step a founding run in by 19 m; the earned zone keeps its width (sci-fi
  // families and fins aside, which the proxies include, so compare with a generous margin).
  assert.ok(top > datumFloor * 0.6, `the top earned floor is still ${top.toFixed(1)} m across (datum floor ${datumFloor.toFixed(1)} m)`);
  const box = bounds(t.group);
  assert.ok(Math.abs(box.max.y - t.top) < 1e-3);
});

test('a scar floor has no panes', () => {
  for (const era of ERAS) {
    const s = earnedSpec([earned(1, era, 'lit'), earned(2, era, 'scar'), earned(3, era, 'lit')]);
    const lay = layoutTower(s);
    const scar = lay.floors[s.datumIndex + 1];
    const t = buildTower(s, 'high', plainMaterials());
    assert.equal(panesBetween(t.group, scar.y0, scar.y0 + scar.h).length, 0, `${era}: the scar floor is not glazed`);
    assert.ok(panesBetween(t.group, lay.floors[s.datumIndex].y0, lay.floors[s.datumIndex].y0 + lay.floors[s.datumIndex].h).length > 0, `${era}: the lit floor below it is`);
    assert.ok(namedVertsBetween(t.group, 'primer', scar.y0, scar.y0 + scar.h) > 0, `${era}: the scar is laid in primer`);
    assert.ok(namedVertsBetween(t.group, 'steel', scar.y0, scar.y0 + scar.h) > 0, `${era}: its studs show at the corners`);
    assert.equal(namedVertsBetween(t.group, 'earnedLine', scar.y0 + 0.01, scar.y0 + scar.h - 0.01), 0, `${era}: a scar carries no light line`);
    const b = proxyBounds(proxyOf(t, scar.floor.id));
    assert.ok(Math.abs(b.min.y - scar.y0) < 1e-6 && Math.abs(b.max.y - (scar.y0 + scar.h)) < 1e-6, `${era}: the scar is as tall as its size`);
  }
});

test('a waiting floor has no lit panes', () => {
  for (const era of ERAS) {
    // A floor of another era above, so the waiting floor stands in its run's shaft rather than under a crown.
    const s = earnedSpec([earned(1, era, 'lit'), earned(2, era, 'waiting'), earned(3, era === 'stone' ? 'glass' : 'stone', 'lit')]);
    const lay = layoutTower(s);
    const wait = lay.floors[s.datumIndex + 1];
    const t = buildTower(s, 'high', plainMaterials());
    const panes = panesBetween(t.group, wait.y0, wait.y0 + wait.h);
    assert.ok(panes.length > 0, `${era}: the waiting floor is glazed, finished`);
    for (const c of panes) assert.equal(c.r, 0, `${era}: every pane of a waiting floor is unlit`);
    assert.equal(namedVertsBetween(t.group, 'earnedLine', wait.y0 + 0.01, wait.y0 + wait.h), 0, `${era}: no light line until it merges`);
    assert.ok(namedVertsBetween(t.group, 'slab', wait.y0 - 0.01, wait.y0 + 0.5) > 0, `${era}: its slab edge is bare concrete`);
  }
});

test('a floor merged with his changes reads apart from a plain lit floor, never in the Claude amber', () => {
  const s = earnedSpec([earned(1, 'glass', 'lit'), earned(2, 'glass', 'lit', { earned: { jobId: 'job-2', runId: 'run-2', agentId: 'priya-rao', firmId: 'quickset', state: 'lit', reverted: false, note: 'merged with his changes' } })]);
  const lay = layoutTower(s);
  const t = buildTower(s, 'high', plainMaterials());
  const [a, b] = [lay.floors[s.datumIndex], lay.floors[s.datumIndex + 1]];
  assert.ok(namedVertsBetween(t.group, 'earnedLine', a.y0, a.y0 + 0.5) > 0);
  assert.ok(namedVertsBetween(t.group, 'handLine', b.y0, b.y0 + b.h) > 0, 'his floor draws its own line');
  assert.equal(namedVertsBetween(t.group, 'earnedLine', b.y0 + 0.001, b.y0 + b.h - 0.001), 0, 'and not the plain one');
});

test('a dark tower has no emissive material', () => {
  const s = earnedSpec([earned(1, 'glass', 'lit'), earned(2, 'scifi', 'waiting'), earned(3, 'brick', 'scar'), earned(4, 'scifi', 'lit', { claude: true })], 'gothic');
  const lit = buildTower(s, 'high', plainMaterials());
  const names = (o: THREE.Object3D): Set<string> => {
    const out = new Set<string>();
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh && m.visible) out.add((m.material as THREE.Material).name);
    });
    return out;
  };
  const EMITTERS = ['lightLine', 'earnedLine', 'handLine', 'accent', 'vent', 'beacon', 'stained', 'window', 'stoneWin', 'brickWin', 'glassWin', 'titaniumWin', 'scifiWin'];
  assert.ok(EMITTERS.some((e) => names(lit.group).has(e)), 'a lit tower draws its emitters');
  for (const t of [buildTower(s, 'high', plainMaterials(), lookFor(s.repo), { dark: true }), buildTower({ ...s, dark: true }, 'medium', plainMaterials())]) {
    const used = names(t.group);
    for (const e of EMITTERS) assert.ok(!used.has(e), `a dark tower never draws ${e}`);
    assert.ok(used.has('darkGlass'), 'its windows are dark glass');
    assert.ok(used.has('datum'), 'the datum stays');
  }
});

test('agent towers build at width 16', () => {
  const floors = Array.from({ length: 6 }, (_, i) => earned(i, 'glass', 'lit'));
  const agent: TowerSpec = { id: 'agent:priya-rao', repo: 'agent:priya-rao', kind: 'agent', root: 'chicago', floors, datumIndex: 0, agentId: 'priya-rao', firmId: 'quickset' };
  const t = buildTower(agent, 'high', plainMaterials());
  const w = proxyBounds(proxyOf(t, floors[0].id)).getSize(new THREE.Vector3()).x;
  // The glass floor's proxy reaches its mullion tips, 0.3 m each side.
  assert.ok(Math.abs(w - (16 + 0.6)) < 0.05, `an agent's first floor is 16 m across (proxy ${w.toFixed(2)} m)`);
  const wide = buildTower(agent, 'high', plainMaterials(), lookFor(agent.repo), { width: 20 });
  const w2 = proxyBounds(proxyOf(wide, floors[0].id)).getSize(new THREE.Vector3()).x;
  assert.ok(Math.abs(w2 - 20.6) < 0.05, `a width given wins (${w2.toFixed(2)} m)`);
  const repo = buildTower(spec('chicago', 1), 'high', plainMaterials());
  const w3 = proxyBounds(proxyOf(repo, spec('chicago', 1).floors[0].id)).getSize(new THREE.Vector3()).x;
  assert.ok(w3 > FLOOR_WIDTH, 'a repo tower keeps the founding width');
});

// ---------------------------------------------------------------- controller rulings on Task 22

/** Every vertex colour of merged meshes in the material named `name` whose vertex lies between y0 and y1. */
function colorsBetween(o: THREE.Object3D, name: string, y0: number, y1: number): string[] {
  o.updateMatrixWorld(true);
  const out = new Set<string>();
  const v = new THREE.Vector3();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || (m.material as THREE.Material).name !== name) return;
    const pos = m.geometry.getAttribute('position');
    const col = m.geometry.getAttribute('color');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y >= y0 - 1e-6 && v.y <= y1 + 1e-6 && col) out.add([col.getX(i), col.getY(i), col.getZ(i)].map((x) => x.toFixed(3)).join(','));
    }
  });
  return [...out];
}

test("earned floors carry their firm's mark, never the Claude amber", () => {
  const other = { jobId: 'job-2', runId: 'run-2', agentId: 'ines-ashlar', firmId: 'ashlar-vane', state: 'lit' as const, reverted: false };
  const s = earnedSpec([earned(1, 'glass', 'lit', { claude: true }), earned(2, 'titanium', 'lit', { claude: true, earned: other })]);
  const lay = layoutTower(s);
  const [a, b] = [lay.floors[s.datumIndex], lay.floors[s.datumIndex + 1]];
  const t = buildTower(s, 'high', plainMaterials(), lookFor(s.repo), { firmSlots: new Map([['quickset', 0], ['ashlar-vane', 1]]) });
  assert.equal(namedVertsBetween(t.group, 'accent', lay.datumY + 0.01, lay.top), 0, 'no amber above the datum');
  // Founding floors co-authored with Claude keep it.
  assert.ok(namedVertsBetween(t.group, 'accent', 0, lay.datumY) > 0, 'the amber stays on Claude history');
  const ca = colorsBetween(t.group, 'firmMark', a.y0, a.y0 + a.h - 0.01);
  const cb = colorsBetween(t.group, 'firmMark', b.y0 + 0.01, b.y0 + b.h);
  assert.equal(ca.length, 1, `one firm, one mark on the first floor (${ca.join(' ')})`);
  assert.equal(cb.length, 1);
  assert.notEqual(ca[0], cb[0], 'two firms, two marks');
  // A dark tower keeps its firm's mark: paint, not light.
  const dark = buildTower(s, 'high', plainMaterials(), lookFor(s.repo), { dark: true });
  assert.ok(namedVertsBetween(dark.group, 'firmMark', lay.datumY, lay.top) > 0);
});

test('the family crown caps the true top over earned sci-fi floors', () => {
  const s = earnedSpec([earned(1, 'glass', 'lit'), earned(2, 'scifi', 'lit'), earned(3, 'scifi', 'lit'), earned(4, 'scifi', 'lit')]);
  const mats = plainMaterials();
  const t = buildTower(s, 'high', mats, { ...lookFor(s.repo), scifi: familyVariant('deco') });
  const lay = layoutTower(s);
  const crownFrom = lay.floors[lay.floors.length - crownFloors(3)].y0;
  // The deco crown lights its fin slots: they stand in the crown floors at the top, above every earned storey.
  const slots = vertsOf(t.group, mats.vent);
  assert.ok(slots.length > 0 && slots.every((v) => v.y >= crownFrom - 1e-3), 'the deco crown stands on the earned top');
  assert.ok(Math.abs(bounds(t.group).max.y - lay.top) < 1e-3, 'and tops out at the tower top');
  // Waiting on his review at the top, the crown stands but its slots stay dark.
  const asleep = earnedSpec([earned(1, 'glass', 'lit'), earned(2, 'scifi', 'lit'), earned(3, 'scifi', 'lit'), earned(4, 'scifi', 'waiting')]);
  const ma = plainMaterials();
  const ta = buildTower(asleep, 'high', ma, { ...lookFor(asleep.repo), scifi: familyVariant('deco') });
  assert.equal(vertsOf(ta.group, ma.vent).filter((v) => v.y >= crownFrom - 1e-3).length, 0, 'a waiting crown is not lit');
  assert.ok(vertsOf(ta.group, ma.unlit).length > 0, 'its slots are there, unlit');
  // A founding sci-fi top under earned glass carries no crown in the middle of the tower.
  const mid = earnedSpec([earned(1, 'glass', 'lit'), earned(2, 'glass', 'lit')]);
  const m2 = plainMaterials();
  const t2 = buildTower(mid, 'high', m2, { ...lookFor(mid.repo), scifi: familyVariant('deco') });
  const l2 = layoutTower(mid);
  assert.equal(vertsOf(t2.group, m2.vent).filter((v) => v.y > l2.datumY - 6).length, 0, 'no crown under the earned floors');
});

test('earned floors of one era stand as one run, one width', () => {
  const eras: Era[] = ['glass', 'glass', 'glass', 'titanium', 'titanium', 'brick', 'brick', 'brick', 'brick'];
  const s = earnedSpec(eras.map((e, i) => earned(i, e, i === 5 ? 'scar' : 'lit')), 'chicago');
  const t = buildTower(s, 'high', plainMaterials());
  const w = (k: number): number => proxyBounds(proxyOf(t, s.floors[s.datumIndex + k].id)).getSize(new THREE.Vector3()).x;
  assert.ok(Math.abs(w(0) - w(1)) < 1e-6 && Math.abs(w(1) - w(2)) < 1e-6, 'the glass run is one width');
  assert.ok(Math.abs(w(6) - w(7)) < 1e-6 && Math.abs(w(7) - w(8)) < 1e-6, 'the brick run is one width');
  // A scar inside a run takes the run's width: the stage was built, then failed.
  const scar = proxyBounds(proxyOf(t, s.floors[s.datumIndex + 5].id)).getSize(new THREE.Vector3()).x - 0.4;
  const brick = w(6) - 0.6;
  assert.ok(Math.abs(scar - brick) < 1e-6, `the scar stands at its run's width (${scar.toFixed(2)} vs ${brick.toFixed(2)})`);
});
