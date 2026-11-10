import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { buildTower, FLOOR_WIDTH } from '../app/src/city/tower/build.js';
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
  const aw = [2, 10, 18].map((f) => floorWidth(arc.t, arc.lay, f));
  // Only the tower's own taper between the first and the last: no setbacks, no batter.
  assert.ok(aw[2] > aw[0] * 0.9 && aw[1] > aw[2], `arcology keeps its mass: ${aw.map((x) => x.toFixed(1)).join(', ')}`);
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
