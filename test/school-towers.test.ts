import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { KIND } from '../app/src/city/campus/site.js';
import { schoolBatch, SCHOOL_KIND } from '../app/src/city/school-towers.js';
import { buildTower } from '../app/src/city/tower/build.js';
import type { MatKey, TowerMaterials } from '../app/src/city/tower/kit.js';
import { lookFor } from '../app/src/city/tower/variants.js';
import type { Era, Floor, TowerSpec } from '../shared/types.js';

/** Plain materials, one per key, named by key, so the tower builds in Node. */
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

function floor(agentId: string, i: number, era: Era): Floor {
  return {
    id: `agent:${agentId}#job-${i}`,
    repo: 'acme/widgets',
    kind: 'pr',
    refs: [],
    title: `change ${i}`,
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    era,
    size: 'medium',
    lines: 10,
    claude: false,
    founding: false,
    url: null,
    earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId, firmId: 'quickset', state: 'lit', reverted: false },
  };
}

function graduate(agentId: string, n: number, era: Era = 'brick'): TowerSpec {
  return {
    id: `agent:${agentId}`,
    repo: '',
    kind: 'agent',
    root: 'collegiate',
    floors: Array.from({ length: n }, (_, i) => floor(agentId, i, era)),
    datumIndex: 0,
    firmId: 'quickset',
    agentId,
    silhouette: 'plain',
    towerIndex: 0,
  };
}

/** A built school tower stood at x in a group of its own, as a quarter stands it. */
function stand(spec: TowerSpec, x: number, quality: 'high' | 'medium' = 'high'): THREE.Group {
  const built = buildTower(spec, quality, plainMaterials(), lookFor('quickset'));
  built.group.position.set(x, 0, 0);
  const holder = new THREE.Group();
  holder.add(built.group);
  return built.group;
}

const drawnPanes = (g: THREE.Object3D): number => {
  let n = 0;
  g.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith('tower:pane')) n += (o as THREE.InstancedMesh).count;
  });
  return n;
};

test('every tower slot is given a kind in the campus masonry, or is a pane', () => {
  const keys: MatKey[] = ['sand', 'travertine', 'gothic', 'limestone', 'granite', 'datum', 'steel', 'graphite', 'slab', 'window', 'stained', 'roofTile', 'timber', 'plaster', 'lightLine', 'accent', 'earnedLine', 'handLine', 'firmMark', 'primer', 'darkGlass', 'lens', 'galvanised', 'unlit', 'vent', 'beacon', 'roof', 'pick'];
  for (const era of ['stone', 'brick', 'glass', 'titanium', 'scifi'] as const) for (const slot of ['Wall', 'Trim', 'Band', 'Win', 'Face'] as const) keys.push(`${era}${slot}`);
  for (const key of keys) {
    const k = SCHOOL_KIND[key];
    if (key === 'pick') {
      assert.equal(k, null);
      continue;
    }
    assert.ok(k !== undefined, `${key} has a kind`);
    if (k === 'pane') continue;
    assert.ok(k !== null && k.kind in KIND, `${key} maps to a campus kind`);
  }
  for (const key of ['window', 'brickWin', 'glassWin', 'darkGlass']) assert.equal(SCHOOL_KIND[key as MatKey], 'pane');
});

test('school towers draw as one masonry mesh and one pane draw, however many stand, in the campus kinds, in place', () => {
  const masonry = new THREE.MeshStandardMaterial({ name: 'masonry' });
  const window = new THREE.MeshStandardMaterial({ name: 'window' });
  const towers = [stand(graduate('a', 3), 0), stand(graduate('b', 0), 100), stand(graduate('c', 5, 'stone'), -100)];
  const panes = towers.reduce((n, t) => n + drawnPanes(t), 0);
  assert.ok(panes > 0);
  const batch = schoolBatch(masonry, window);
  assert.equal(batch.set(towers), true);
  assert.equal(batch.group.children.length, 2, 'one masonry draw and one pane draw');
  const stone = batch.group.children.find((c) => (c as THREE.Mesh).material === masonry) as THREE.Mesh;
  const glass = batch.group.children.find((c) => (c as THREE.Mesh).material === window) as THREE.InstancedMesh;
  assert.ok(stone && !(stone as unknown as THREE.InstancedMesh).isInstancedMesh, 'the masonry is one merged mesh');
  assert.ok(glass?.isInstancedMesh && glass.count === panes, `every pane rides in the one pane draw (${glass?.count} of ${panes})`);
  assert.equal(stone.castShadow, true);
  assert.equal(glass.castShadow, false);
  assert.equal((stone.userData.lodParts as THREE.Sphere[]).length, 3, 'each tower is a part for the distance pass');
  // The masonry carries a kind per vertex, every one a campus kind, and brick and limestone among them.
  const kinds = stone.geometry.attributes.aKind as THREE.BufferAttribute;
  assert.ok(kinds && kinds.count === stone.geometry.attributes.position.count);
  const seen = new Set<number>();
  for (let i = 0; i < kinds.count; i++) seen.add(kinds.getX(i));
  const valid = new Set(Object.values(KIND));
  for (const k of seen) assert.ok(valid.has(k), `kind ${k} is a campus kind`);
  assert.ok(seen.has(KIND.brick) && seen.has(KIND.limestone), 'brick and limestone');
  // In place: the merged masonry spans the three towers where they stand.
  stone.geometry.computeBoundingBox();
  const b = stone.geometry.boundingBox!;
  assert.ok(b.min.x < -100 && b.max.x > 100 && b.min.y > -1e-3 && b.max.y > 20, `spans the towers (${b.min.x.toFixed(0)} to ${b.max.x.toFixed(0)}, up to ${b.max.y.toFixed(1)})`);
  // The towers' own meshes hide, the pick proxies are left alone.
  for (const t of towers) {
    t.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      if (o.parent?.name === 'tower:picks') return;
      assert.equal(o.visible, false, `${o.name} hides behind the batch`);
    });
    assert.ok(t.getObjectByName('tower:picks'), 'the pick proxies stay');
  }
  // Nothing changed: nothing re-merged. One tower let go: the rest re-merge.
  assert.equal(batch.set(towers), false);
  assert.equal(batch.set(towers.slice(0, 2)), true);
  assert.equal((batch.group.children.find((c) => (c as THREE.Mesh).material === masonry)!.userData.lodParts as THREE.Sphere[]).length, 2);
  batch.set([]);
  assert.equal(batch.group.children.length, 0);
  batch.dispose();
});

test('a dark tower keeps its panes, dark, and the AO sees the batch only within its reach', () => {
  const masonry = new THREE.MeshStandardMaterial();
  const window = new THREE.MeshStandardMaterial();
  const lit = stand(graduate('a', 2), 0);
  const dark = stand({ ...graduate('b', 2), dark: true }, 60, 'medium');
  const batch = schoolBatch(masonry, window);
  batch.set([lit, dark]);
  const glass = batch.group.children.find((c) => (c as THREE.Mesh).material === window) as THREE.InstancedMesh;
  assert.equal(glass.count, drawnPanes(lit) + drawnPanes(dark));
  const c = new THREE.Color();
  let unlit = 0;
  for (let i = 0; i < glass.count; i++) if ((glass.getColorAt(i, c), c.r < 0.05)) unlit++;
  assert.ok(unlit >= drawnPanes(dark), 'the dark tower’s panes carry no light');
  const stone = batch.group.children.find((c) => (c as THREE.Mesh).material === masonry) as THREE.Mesh;
  batch.update(new THREE.Vector3(0, 50, 200));
  assert.ok(stone.layers.isEnabled(0), 'near: every pass draws the masonry');
  assert.ok(!glass.layers.isEnabled(0) && glass.layers.isEnabled(1), 'the panes are the view’s alone');
  batch.update(new THREE.Vector3(0, 50, 5000));
  assert.ok(!stone.layers.isEnabled(0) && stone.layers.isEnabled(1) && stone.layers.isEnabled(2), 'far: the view and the shadow map, never the AO');
  batch.dispose();
});
