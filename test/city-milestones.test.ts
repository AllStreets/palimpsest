/**
 * The lit spire and the founding finial (Phase 3 Task 14): each skyline
 * milestone stands on its tower's true top in the city, the holder's lamp
 * lit, a passed holder's mast dark, and the founding skyline a bronze finial;
 * the ornaments leave with their tower. Built in Node from plain materials.
 */
import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { createMilestones, findTowerPiece, milestoneNote, SPIRE, spireHeight, type TowerPiece } from '../app/src/city/milestones.js';
import { quarterCenterpiece, quarterLooks } from '../app/src/city/quarters.js';
import { buildTower } from '../app/src/city/tower/build.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { lookFor } from '../app/src/city/tower/variants.js';
import { crownFor } from '../shared/silhouette.js';
import { BLOOM_THRESHOLD, EXPOSURE } from '../app/src/city/post.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { Era, Floor, Milestone, Quarter, TowerSpec } from '../shared/types.js';

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

function floor(owner: string, i: number, era: Era, earned: boolean): Floor {
  return {
    id: `${owner}#f${i}`,
    repo: 'acme/widgets',
    kind: 'pr',
    refs: [],
    title: `change ${i}`,
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    era,
    size: 'medium',
    lines: 10,
    claude: false,
    founding: !earned,
    url: null,
    ...(earned ? { earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId: 'a1', firmId: 'f1', state: 'lit' as const, reverted: false } } : {}),
  };
}

function districtSpec(): TowerSpec {
  const floors = [...Array.from({ length: 6 }, (_, i) => floor('acme/widgets#founding', i, 'stone', false)), ...Array.from({ length: 3 }, (_, i) => floor('acme/widgets#founding', 6 + i, 'glass', true))];
  return { id: 'acme/widgets#founding', repo: 'acme/widgets', kind: 'founding', root: 'beauxarts', floors, datumIndex: 6 };
}

function agentSpec(agentId: string, towerIndex: number, silhouette: 'needle' | 'lens' | 'plain'): TowerSpec {
  return {
    id: `agent:${agentId}`,
    repo: '',
    kind: 'agent',
    root: 'chicago',
    floors: Array.from({ length: 8 }, (_, i) => floor(`agent:${agentId}`, i, 'glass', true)),
    datumIndex: 0,
    firmId: 'f1',
    agentId,
    silhouette,
    towerIndex,
  };
}

function scene(): { districts: Parameters<typeof findTowerPiece>[1]; quarters: Parameters<typeof findTowerPiece>[2]; district: TowerSpec; quarter: Quarter; root: THREE.Group; dispose(): void } {
  const mats = plainMaterials();
  const root = new THREE.Group();
  const district = districtSpec();
  const built = buildTower(district, 'high', mats, lookFor(district.repo));
  built.group.position.set(300, 0, -120);
  root.add(built.group);
  const quarter: Quarter = { firmId: 'f1', slot: 7, origin: { x: -400, z: 200 }, root: 'chicago', dark: false, towers: [agentSpec('a1', 0, 'needle'), agentSpec('a2', 1, 'plain')] };
  const looks = quarterLooks(quarter);
  const piece = quarterCenterpiece(quarter, 'high', (t) => looks.get(t.id)!, { name: 'Firm', materials: () => mats });
  piece.object.position.set(quarter.origin.x, 0, quarter.origin.z);
  root.add(piece.object);
  root.updateMatrixWorld(true);
  return {
    districts: [{ spec: district, object: built.group }],
    quarters: [{ quarter, object: piece.object }],
    district,
    quarter,
    root,
    dispose() {
      built.dispose();
      piece.dispose();
    },
  };
}

function row(kind: Milestone['kind'], towerId: string, lit: boolean): Milestone {
  return { id: `${kind}:${towerId}`, kind, towerId, repo: null, firmId: null, agentId: null, floorId: null, at: '2026-11-10T09:00:00Z', until: null, lit, title: kind === 'skyline' ? 'The skyline' : 'The founding skyline', detail: '' };
}

/** The instanced meshes under the ornaments' group, each with how many it draws. */
function drawn(group: THREE.Object3D): Array<{ name: string; mat: THREE.Material; count: number }> {
  const out: Array<{ name: string; mat: THREE.Material; count: number }> = [];
  group.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (m.isInstancedMesh) out.push({ name: m.name, mat: m.material as THREE.Material, count: m.visible ? m.count : 0 });
  });
  return out;
}

test('towerPiece finds a district tower and an agent tower', () => {
  const s = scene();
  const d = findTowerPiece(s.district.id, s.districts, s.quarters);
  assert.ok(d, 'the district tower is found by <repo>#founding');
  assert.equal(d.layout.top, layoutTower(s.district).top);
  assert.ok(d.half > 4 && d.half < 20, `its roof's half width (${d.half})`);
  assert.equal(d.crown, 0, 'a district tower carries no roof crown');
  const roof = d.roof();
  assert.ok(Math.abs(roof.x - 300) < 3 && Math.abs(roof.z + 120) < 3, 'its roof stands over its origin');
  const a = findTowerPiece('agent:a1', s.districts, s.quarters);
  assert.ok(a, 'an agent tower is found by agentTowerId');
  const spec = s.quarter.towers[0];
  assert.equal(a.layout.top, layoutTower(spec).top);
  assert.equal(a.crown, crownFor('needle', 8).height, "the needle's spire is its crown");
  const ar = a.roof();
  assert.ok(Math.abs(ar.x - (-400 - 52)) < 3 && Math.abs(ar.z - (200 - 52)) < 3, `the agent tower's roof stands on its plot (${ar.x.toFixed(1)}, ${ar.z.toFixed(1)})`);
  assert.equal(findTowerPiece('agent:nobody', s.districts, s.quarters), null);
  assert.equal(findTowerPiece('gone/repo#founding', s.districts, s.quarters), null);
  s.dispose();
});

test('the spire stands on the tower true top, above a crown, and is sized to the tower', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  ms.set([row('skyline', s.district.id, true), row('skyline', 'agent:a1', false)], towers);
  const shows = ms.shows();
  const d = shows.get(`skyline:${s.district.id}`)!;
  assert.ok(d, 'the district tower shows its spire');
  assert.ok(Math.abs(d.y - layoutTower(s.district).top) < 1e-6, `it stands on the roof (${d.y})`);
  assert.ok(Math.abs(d.height - spireHeight(layoutTower(s.district).top)) < 1e-6);
  assert.equal(spireHeight(100), 12, 'never under 12 m');
  assert.equal(spireHeight(300), 24, '8% of a tall tower');
  const a = shows.get('skyline:agent:a1')!;
  const spec = s.quarter.towers[0];
  assert.ok(Math.abs(a.y - (layoutTower(spec).top + crownFor('needle', 8).height)) < 1e-6, `above the needle's crown (${a.y})`);
  assert.ok(a.tip[1] > a.y + a.height * 0.95, 'its tip stands a spire above its foot');
  ms.dispose();
  s.dispose();
});

test('a lit spire has an emissive tip and an unlit one has none', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  ms.set([row('skyline', s.district.id, true)], towers);
  const lit = drawn(ms.group);
  const lamps = lit.filter((p) => p.mat === ms.lamp);
  const perSpire = lamps.reduce((n, p) => n + p.count, 0);
  assert.ok(perSpire >= 3, `the holder draws its lamps lit: the tip, the mid lamp and the galleries' (${perSpire})`);
  assert.ok(ms.lamp instanceof THREE.MeshBasicMaterial, 'the lamp is a real emitter');
  // Through a whole breath, the colours the lamp and its far point draw in, after the exposure, stay under the bloom threshold.
  let peak = 0;
  let low = Infinity;
  for (let t = 0; t <= SPIRE.period; t += 0.05) {
    ms.update(0.05, t);
    const lamp = Math.max(ms.lamp.color.r, ms.lamp.color.g, ms.lamp.color.b) * EXPOSURE;
    const point = Math.max(ms.point.color.r, ms.point.color.g, ms.point.color.b) * EXPOSURE;
    peak = Math.max(peak, lamp, point);
    low = Math.min(low, lamp);
    assert.ok(ms.lamp.color.r > ms.lamp.color.g * 1.8 && ms.lamp.color.g > ms.lamp.color.b * 2, 'a warm amber, never white');
  }
  assert.ok(peak < BLOOM_THRESHOLD, `the lamp breathes under the bloom threshold (${peak.toFixed(3)})`);
  assert.ok(low < peak * 0.6, `and breathes (${low.toFixed(2)} to ${peak.toFixed(2)})`);
  assert.equal(ms.shows().get(`skyline:${s.district.id}`)!.lit, true);

  ms.set([row('skyline', s.district.id, false)], towers);
  const dark = drawn(ms.group);
  assert.ok(dark.filter((p) => p.mat === ms.lamp).every((p) => p.count === 0), 'a passed holder draws no lit lamp');
  assert.ok(dark.some((p) => p.mat !== ms.lamp && p.count === perSpire && /lamp/.test(p.name)), 'its lamps stand dark glass');
  assert.equal(ms.shows().get(`skyline:${s.district.id}`)!.lit, false);

  // The founding skyline: the same mast, unlit, under a bronze finial; on the holder's own tower, a bronze sleeve on the lit mast.
  ms.set([row('founding-skyline', s.district.id, false)], towers);
  const finial = drawn(ms.group);
  assert.ok(finial.filter((p) => p.mat === ms.lamp).every((p) => p.count === 0), 'the finial is never lit');
  assert.ok(finial.some((p) => /finial/.test(p.name) && p.count === 1), 'it carries the bronze finial');
  ms.set([row('skyline', s.district.id, true), row('founding-skyline', s.district.id, false)], towers);
  const both = drawn(ms.group);
  assert.ok(both.filter((p) => p.mat === ms.lamp).every((p) => p.count === perSpire), 'one tower holding both keeps its lamps lit');
  assert.ok(both.some((p) => /sleeve/.test(p.name) && p.count === 1), 'and wears the bronze sleeve');
  assert.ok(both.filter((p) => /mast/.test(p.name)).every((p) => p.count === 1), 'on one mast');
  ms.dispose();
  s.dispose();
});

test('a tower removed takes its spire, and the lit spire moves at once', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  ms.set([row('skyline', s.district.id, true)], towers);
  assert.equal(ms.shows().size, 1);
  // Passed to the agent tower: the next set moves the lamp there, the old holder dark.
  ms.set([row('skyline', s.district.id, false), row('skyline', 'agent:a2', true)], towers);
  assert.equal(ms.shows().get('skyline:agent:a2')!.lit, true);
  assert.equal(ms.shows().get(`skyline:${s.district.id}`)!.lit, false);
  // Disconnected: the scene takes the tower out of the city, as placeDistricts does.
  s.districts[0].object.removeFromParent();
  ms.set([row('skyline', s.district.id, false), row('skyline', 'agent:a2', true)], towers);
  assert.equal(ms.shows().has(`skyline:${s.district.id}`), false, 'the disconnected tower takes its mast');
  assert.ok(drawn(ms.group).filter((p) => /mast/.test(p.name)).every((p) => p.count === 1), 'one mast stands');
  ms.set([], towers);
  assert.equal(ms.shows().size, 0);
  assert.ok(drawn(ms.group).every((p) => p.count === 0), 'nothing draws');
  ms.dispose();
  s.dispose();
});

test('a milestone past its end goes dark, and set says when the next one ends', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  const now = Date.parse('2026-11-12T12:00:00Z');
  const ends = '2026-11-12T12:00:30Z';
  const sky = { ...row('skyline', s.district.id, true), until: ends };
  const ended = { ...row('skyline', 'agent:a1', false), until: '2026-11-12T11:00:00Z' };
  assert.equal(ms.set([sky, ended], towers, now), Date.parse(ends), 'the earliest end still to come');
  assert.deepEqual([...ms.shows().keys()], [sky.id], 'an ended milestone shows nothing');
  assert.equal(ms.set([sky], towers, Date.parse(ends)), null, 'nothing left to end');
  assert.equal(ms.shows().size, 0, 'at its end it goes dark');
  ms.dispose();
  s.dispose();
});

function revival(towerId: string, floorId: string, until: string): Milestone {
  return { id: `revival:${floorId}`, kind: 'revival', towerId, repo: 'acme/widgets', firmId: 'f1', agentId: 'a1', floorId, at: '2026-11-10T09:00:00Z', until, lit: true, title: 'Back to life', detail: '' };
}

test('a revival hangs lights round its floor and the floor below', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  const now = Date.parse('2026-11-12T12:00:00Z');
  const lay = layoutTower(s.district);
  const top = lay.floors[lay.floors.length - 1];
  const below = lay.floors[lay.floors.length - 2];
  const r = revival(s.district.id, top.floor.id, '2026-11-17T09:00:00Z');
  assert.equal(ms.set([r], towers, now), Date.parse(r.until!), 'its end is the next to come');
  const show = ms.shows().get(r.id);
  assert.ok(show, 'the revival shows');
  assert.equal(show.kind, 'revival');
  assert.ok(Math.abs(show.y - below.y0) < 1e-6, `the scaffold stands from the floor below (${show.y} against ${below.y0})`);
  assert.ok(show.y + show.height >= top.y0 + top.h, 'and rises past the revived floor');
  const scaffold = ms.group.getObjectByName(`revival:${r.id}`);
  assert.ok(scaffold, 'a scaffold hangs on the tower');
  const box = new THREE.Box3().setFromObject(scaffold, true);
  assert.ok(Math.abs((box.min.x + box.max.x) / 2 - 300) < 3 && Math.abs((box.min.z + box.max.z) / 2 + 120) < 3, 'round the tower, where it stands');
  const lamps = drawn(ms.group).filter((p) => /festoon/.test(p.name));
  assert.equal(lamps.length, 1, 'one instanced draw for every festoon lamp');
  assert.equal(lamps[0].count, 32, 'sixteen lamps a lift, one lift for each floor');
  assert.ok(lamps[0].mat instanceof THREE.MeshBasicMaterial, 'the lamps are emitters');
  // The scaffold's own steel, boards and netting emit nothing.
  scaffold.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m) assert.ok(!(m instanceof THREE.MeshBasicMaterial) && !((m as THREE.MeshStandardMaterial).emissiveIntensity > 0 && (m as THREE.MeshStandardMaterial).emissive?.getHex()), 'the lamps are the only emitters');
  });
  // The flicker: lamps differ from one another and move with time, under the bloom threshold.
  ms.update(0.016, 1.0);
  const a = lampLevels(ms);
  ms.update(0.016, 1.7);
  const b = lampLevels(ms);
  assert.ok(new Set(a.map((x) => x.toFixed(3))).size > 4, 'each lamp burns its own way');
  assert.ok(a.some((x, i) => Math.abs(x - b[i]) > 1e-3), 'and flickers');
  assert.ok(Math.max(...a, ...b) * EXPOSURE < BLOOM_THRESHOLD, 'under the bloom threshold');
  ms.dispose();
  s.dispose();
});

/** Each festoon lamp's drawn brightness (its instance colour's red, times the material's). */
function lampLevels(ms: ReturnType<typeof createMilestones>): number[] {
  const out: number[] = [];
  ms.group.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh || !/festoon/.test(m.name) || !m.instanceColor) return;
    const c = new THREE.Color();
    for (let i = 0; i < m.count; i++) {
      m.getColorAt(i, c);
      out.push(c.r * (m.material as THREE.MeshBasicMaterial).color.r);
    }
  });
  return out;
}

test('lights come down at until, and with the tower', () => {
  const s = scene();
  const ms = createMilestones({ quality: 'high', materials: plainMaterials() });
  const towers = (id: string): TowerPiece | null => findTowerPiece(id, s.districts, s.quarters);
  const lay = layoutTower(s.district);
  const r = revival(s.district.id, lay.floors[lay.floors.length - 1].floor.id, '2026-11-17T09:00:00Z');
  ms.set([r], towers, Date.parse('2026-11-16T09:00:00Z'));
  assert.ok(ms.group.getObjectByName(`revival:${r.id}`));
  ms.set([r], towers, Date.parse(r.until!));
  assert.equal(ms.shows().has(r.id), false, 'gone at until');
  assert.equal(ms.group.getObjectByName(`revival:${r.id}`), undefined, 'the scaffold struck');
  assert.ok(drawn(ms.group).filter((p) => /festoon/.test(p.name)).every((p) => p.count === 0), 'no lamp burns');
  ms.set([r], towers, Date.parse('2026-11-16T09:00:00Z'));
  s.districts[0].object.removeFromParent();
  ms.set([r], towers, Date.parse('2026-11-16T09:00:00Z'));
  assert.equal(ms.group.getObjectByName(`revival:${r.id}`), undefined, 'a tower taken away takes its scaffold');
  ms.dispose();
  s.dispose();
});

test("a floor's milestone reads in quiet words", () => {
  const now = Date.parse('2026-11-12T15:00:00Z');
  const sky = { ...row('skyline', 'x#founding', true), at: '2026-11-10T09:00:00Z' };
  assert.equal(milestoneNote(sky, now), 'the skyline, since Tuesday');
  assert.equal(milestoneNote({ ...sky, lit: false }, now), 'held the skyline');
  assert.equal(milestoneNote({ ...sky, at: '2026-10-01T09:00:00Z' }, now), 'the skyline, since Oct 1');
  assert.equal(milestoneNote({ ...sky, at: '2026-11-12T09:00:00Z' }, now), 'the skyline, since today');
});
