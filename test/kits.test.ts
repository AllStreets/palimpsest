import './kit-setup.js';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';

import * as THREE from 'three';

import { blockLots, lotParts } from '../app/src/city/lots.js';
import { crownSlots, hasKit, kitShared } from '../app/src/city/kits.js';
import { buildTower } from '../app/src/city/tower/build.js';
import { LOD_FAR, type TowerMaterials } from '../app/src/city/tower/kit.js';
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
  const asked = ['course_a', 'course_b', 'pier_block', 'band_course'].flatMap((n) => [`${n}.hi`, `${n}.lo`]);
  asked.push('water_tank', 'tank_cap', 'tank_stand', 'bulkhead', 'penthouse', 'screen_panel', 'rooftop_unit', 'car', 'bay', 'bay_glass', 'chamfer_box');
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
    assert.ok(near.material === mats.stoneFace || near.material === mats.brickFace, 'coursed blocks take the Face slot');
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
