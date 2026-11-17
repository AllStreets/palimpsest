import './kit-setup.js';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';

import * as THREE from 'three';

import { blockLots, lotParts } from '../app/src/city/lots.js';
import { crownSlots, hasKit, kitShared, parseGlb } from '../app/src/city/kits.js';
import { buildTower } from '../app/src/city/tower/build.js';
import { LOD_FAR, type TowerMaterials } from '../app/src/city/tower/kit.js';
import { towerLodMaterial } from '../app/src/city/lod-shader.js';
import { FAMILIES, lookFor, VARIANTS } from '../app/src/city/tower/variants.js';
import type { Floor, TowerSpec } from '../shared/types.js';

// The Blender-authored architecture kits (tools/kits/kits.py -> app/public/kits/kits.glb) and what the city builds from them.

const bbox = (name: string): THREE.Box3 => {
  const g = kitShared(name);
  g.computeBoundingBox();
  return g.boundingBox!;
};

test('the kit file is small and holds every piece the city asks for', () => {
  assert.ok(statSync(new URL('../app/public/kits/kits.glb', import.meta.url)).size < 1_000_000, 'kits.glb stays under 1 MB');
  // The trees have their own file and their own cap (tools/kits/trees.py TREES_BUDGET): kits.glb has no room left under its own.
  assert.ok(statSync(new URL('../app/public/kits/trees.glb', import.meta.url)).size <= 600_000, 'trees.glb stays within its 600 KB');
  const asked = ['course_a', 'course_b', 'pier_block', 'band_course'].flatMap((n) => [`${n}.hi`, `${n}.lo`]);
  asked.push('water_tank', 'tank_cap', 'tank_stand', 'bulkhead', 'penthouse', 'screen_panel', 'rooftop_unit', 'car', 'bay', 'bay_glass', 'bay_foot', 'bay_roof', 'chamfer_box', 'round_box');
  for (const n of asked) assert.ok(hasKit(n), `kit piece ${n}`);
  for (const f of FAMILIES) {
    const slots = crownSlots(f);
    assert.ok(slots.includes('wall') && slots.includes('beacon'), `${f} crown has a wall and warning lights: ${slots.join(',')}`);
  }
});

test('masonry courses carry real joints near and the same blocks flat far', () => {
  for (const n of ['course_a', 'course_b', 'pier_block']) {
    const hi = bbox(`${n}.hi`);
    const lo = bbox(`${n}.lo`);
    // The same unit rectangle, so the two levels swap without a jump.
    for (const k of ['x', 'y'] as const) {
      assert.ok(Math.abs(hi.min[k] - lo.min[k]) < 1e-4 && Math.abs(hi.max[k] - lo.max[k]) < 1e-4, `${n} ${k} extent matches`);
    }
    assert.ok(Math.abs(hi.min.z + 0.05) < 1e-4 && Math.abs(hi.max.z) < 1e-4, `${n}.hi joints run 5 cm deep`);
    assert.ok(Math.abs(lo.min.z) < 1e-4 && Math.abs(lo.max.z) < 1e-4, `${n}.lo is flat`);
    // Each block its own tone, and the joints darker than the faces.
    const col = kitShared(`${n}.hi`).getAttribute('color');
    const tones = new Set<string>();
    for (let i = 0; i < col.count; i++) tones.add(col.getX(i).toFixed(3));
    assert.ok(tones.size >= 2, `${n} has toned blocks and darker joints`);
  }
});

test('every crown stands on its plan and inside its height', () => {
  for (const f of FAMILIES) {
    for (const s of crownSlots(f)) {
      const b = bbox(`crown_${f}.${s}`);
      assert.ok(b.min.y >= -1e-4 && b.max.y <= 1 + 1e-4, `crown_${f}.${s} spans ${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}`);
      assert.ok(Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z) <= 1.35, `crown_${f}.${s} stays near its plan`);
    }
  }
});

function plain(): TowerMaterials {
  const made = new Map<string | symbol, THREE.Material>();
  return new Proxy({} as TowerMaterials, {
    get(_, key) {
      let m = made.get(key);
      if (!m) made.set(key, (m = new THREE.MeshStandardMaterial({ name: String(key) })));
      return m;
    },
  });
}

function stoneTower(n: number): TowerSpec {
  const floors: Floor[] = Array.from({ length: n }, (_, i) => ({
    id: `acme/s#f${i}`,
    repo: 'acme/s',
    kind: 'commits',
    refs: [`f${i}`],
    title: `f${i}`,
    at: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
    era: i < n / 2 ? 'stone' : 'brick',
    size: 'medium',
    lines: 10,
    claude: false,
    founding: true,
    url: null,
  }));
  return { id: 'acme/s#founding', repo: 'acme/s', kind: 'founding', root: 'chicago', floors, datumIndex: n };
}

test('stone and brick floors are laid in coursed kit blocks, near and far levels at high quality, the far level alone at medium', () => {
  const mats = plain();
  const t = buildTower(stoneTower(6), 'high', mats, lookFor('acme/s'));
  const lods: THREE.LOD[] = [];
  t.group.traverse((o) => {
    if ((o as THREE.LOD).isLOD) lods.push(o as THREE.LOD);
  });
  assert.ok(lods.length >= 2, `stone and brick each draw coursed blocks (${lods.length} LODs)`);
  for (const l of lods) {
    assert.equal(l.levels.length, 2);
    assert.equal(l.levels[1].distance, LOD_FAR);
    const [near, far] = l.levels.map((x) => x.object as THREE.InstancedMesh);
    assert.equal(near.count, far.count, 'both levels lay the same blocks');
    // Each level draws a copy of the Face slot that cross-fades it with the other level (lod.ts TOWER_LOD, Task 15).
    const face = (m: unknown): boolean => [mats.stoneFace, mats.brickFace].some((f) => m === towerLodMaterial(f as THREE.Material, 'near') || m === towerLodMaterial(f as THREE.Material, 'far'));
    assert.ok(face(near.material) && face(far.material) && near.material !== far.material, 'coursed blocks take the Face slot, a level copy each');
  }
  t.dispose();
  const m = buildTower(stoneTower(6), 'medium', plain(), lookFor('acme/s'));
  let reliefMedium = 0;
  let courses = 0;
  m.group.traverse((o) => {
    const l = o as THREE.LOD;
    if (l.isLOD) {
      // At medium both levels are the far blocks: the near one casts the shadow, the far one none (as at high).
      const [near, far] = l.levels.map((x) => x.object as THREE.InstancedMesh);
      if (near.geometry !== far.geometry) reliefMedium++;
      assert.ok(near.castShadow && !far.castShadow, 'a far block casts no shadow past LOD_FAR');
      assert.ok(near.material === far.material, 'at medium the same blocks switch as before, with no cross-fade copy');
    }
    if (o.name.startsWith('tower:course:') && o.name.endsWith(':lo')) courses++;
  });
  assert.equal(reliefMedium, 0, 'medium quality builds no near level');
  assert.ok(courses >= 2, 'medium quality still lays the far blocks');
  m.dispose();
});

test('the same tower lays the same blocks every time', () => {
  const key = (t: ReturnType<typeof buildTower>): string => {
    const out: string[] = [];
    t.group.updateMatrixWorld(true);
    t.group.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || !o.name.startsWith('tower:course')) return;
      const mm = new THREE.Matrix4();
      for (let i = 0; i < im.count; i += 7) {
        im.getMatrixAt(i, mm);
        out.push(`${o.name}:${mm.elements.map((e) => e.toFixed(3)).join(',')}`);
      }
    });
    return out.join('|');
  };
  const a = buildTower(stoneTower(5), 'high', plain(), lookFor('acme/s'));
  const b = buildTower(stoneTower(5), 'high', plain(), lookFor('acme/s'));
  assert.equal(key(a), key(b));
  a.dispose();
  b.dispose();
});

test('the ambient city draws its roofs and massing from the kit: bays on walk-ups, cut corners on offices, kit roof pieces', () => {
  const kinds = new Map<string, number>();
  let cut = 0;
  let walkups = 0;
  let bayed = 0;
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      for (const lot of blockLots(i, j)) {
        const parts = lotParts(lot);
        for (const p of parts) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
        if (parts.some((p) => p.chamfer)) {
          cut++;
          assert.ok(['commercial', 'midcentury', 'glass'].includes(lot.archetype), 'only offices and slabs cut their corners');
          assert.ok(lot.front.length > 1, 'a cut corner stands where two street fronts meet');
        }
        if (lot.archetype === 'walkup') {
          walkups++;
          const bays = parts.filter((p) => p.kind === 'bay');
          if (bays.length) bayed++;
          for (const b of bays) assert.ok(b.y + b.sy / 2 <= lot.h + 1e-6, 'a bay stays under the parapet');
        }
      }
    }
  }
  for (const k of ['bulkhead', 'penthouse', 'screen', 'unit', 'car', 'bay', 'bayGlass', 'tank', 'stand', 'tankCap']) assert.ok((kinds.get(k) ?? 0) > 0, `the city draws ${k}`);
  assert.ok(cut > 10, `some corner offices are cut (${cut})`);
  assert.ok(bayed > walkups * 0.4 && bayed < walkups, `most but not all walk-ups throw out bays (${bayed} of ${walkups})`);
});

test('every sci-fi variant still names a family the kit crowns', () => {
  for (const v of VARIANTS.scifi) assert.ok(v.family && crownSlots(v.family).length >= 3, v.id);
});

test('parseGlb reads quantised positions through the node scale and translation, and the uvs a mesh carries', () => {
  // A GLB by hand: one triangle with int16 normalized positions (KHR_mesh_quantization), a node that scales them to metres
  // and lifts them, and uint16 normalized uvs.
  const pos = new Int16Array([0, 0, 0, 0, 32767, 32767, 0, 0, 16384, 0, 0, 0]);
  const uv = new Uint16Array([0, 0, 65535, 0, 0, 65535]);
  const idx = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(pos.byteLength + uv.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(uv.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + uv.byteLength);
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'tri', mesh: 0, translation: [0, 0.5, 0], scale: [2, 2, 2] }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5122, normalized: true, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, normalized: true, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, byteStride: 8, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + uv.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  let js = Buffer.from(JSON.stringify(doc));
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.byteLength, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(js.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.byteLength, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([head, jh, js, bh, Buffer.from(bin)]);
  const g = parseGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)).get('tri')!;
  assert.ok(g, 'the mesh by its node name');
  const p = g.attributes.position;
  assert.deepEqual([p.getX(0), p.getY(0), p.getZ(0)], [0, 0.5, 0]);
  assert.ok(Math.abs(p.getX(1) - 2) < 1e-4 && Math.abs(p.getY(1) - 2.5) < 1e-4, `the second point scaled and lifted (${p.getX(1)}, ${p.getY(1)})`);
  assert.ok(Math.abs(p.getX(2) - 1) < 1e-3 && Math.abs(p.getY(2) - 0.5) < 1e-4, `the third point at half (${p.getX(2)}, ${p.getY(2)})`);
  const t = g.attributes.uv;
  assert.deepEqual([t.getX(0), t.getY(0), t.getX(1), t.getY(1), t.getX(2), t.getY(2)], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(g.index!.array as ArrayLike<number>), [0, 1, 2]);
});
