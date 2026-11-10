import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { hasKit, kitsFallback, registerFallbackKits } from '../app/src/city/kits.js';
import { buildTower } from '../app/src/city/tower/build.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import type { Era, Floor, TowerSpec } from '../shared/types.js';

// No kit-setup import: this file runs in its own process without the Blender kits, as the app does when kits.glb is missing.

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

test('without the kits a tower still builds from plain stand-ins, its crown left to the family', () => {
  assert.equal(hasKit('course_a.hi'), false);
  registerFallbackKits();
  assert.equal(kitsFallback(), true);
  for (const name of ['course_a.hi', 'course_a.lo', 'course_b.hi', 'pier_block.lo', 'band_course.hi', 'water_tank', 'tank_cap', 'tank_stand', 'bulkhead', 'penthouse', 'screen_panel', 'rooftop_unit', 'car', 'bay', 'bay_glass', 'chamfer_box', 'round_box']) {
    assert.ok(hasKit(name), `${name} has a stand-in`);
  }
  const eras: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
  const floors: Floor[] = eras.flatMap((era, e) =>
    Array.from({ length: 4 }, (_, j) => ({
      id: `acme/w#${e * 4 + j}`,
      repo: 'acme/w',
      kind: 'commits' as const,
      refs: [],
      title: 't',
      at: '2025-01-01T00:00:00Z',
      era,
      size: 'medium' as const,
      lines: 1,
      claude: false,
      founding: true,
      url: null,
    })),
  );
  const spec: TowerSpec = { id: 'acme/w#founding', repo: 'acme/w', kind: 'founding', root: 'roman', floors, datumIndex: floors.length };
  const t = buildTower(spec, 'high', plainMaterials());
  const box = new THREE.Box3();
  t.group.updateMatrixWorld(true);
  t.group.traverseVisible((c) => {
    if ((c as THREE.Mesh).isMesh) box.expandByObject(c, false);
  });
  assert.ok(Math.abs(box.max.y - t.top) < 1e-3, `the tower still reaches its top (${box.max.y} vs ${t.top})`);
  let beacons = 0;
  t.group.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).name === 'beacon') beacons++;
  });
  assert.ok(beacons > 0, 'the top floor builds its own roof and warning lights where the kit crown would stand');
});
