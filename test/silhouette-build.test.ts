import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { AGENT_FLOOR_WIDTH, buildTower } from '../app/src/city/tower/build.js';
import { LENS_MULLIONS } from '../app/src/city/tower/crowns.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { crownFor, LENS_TWIST_DEG } from '../shared/silhouette.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { Era, Floor, Silhouette, TowerSpec } from '../shared/types.js';

/** Plain materials, one per key, named by key, so the tower builds in Node and each piece says what it is drawn in. */
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

function floor(i: number, era: Era, founding: boolean): Floor {
  return {
    id: founding ? `acme/widgets#f${i}` : `agent:priya-rao#job-${i}`,
    repo: 'acme/widgets',
    kind: founding ? 'commits' : 'pr',
    refs: [],
    title: `change ${i}`,
    at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    era,
    size: 'medium',
    lines: 10,
    claude: false,
    founding,
    url: null,
    ...(founding ? {} : { earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId: 'priya-rao', firmId: 'quickset', state: 'lit' as const, reverted: false } }),
  };
}

/** An agent's tower: `n` earned floors in one era over its root, the datum at the root. */
function agentSpec(silhouette: Silhouette, n: number, era: Era = 'stone'): TowerSpec {
  const floors = Array.from({ length: n }, (_, i) => floor(i, era, false));
  return { id: 'agent:priya-rao', repo: '', kind: 'agent', root: 'chicago', floors, datumIndex: 0, agentId: 'priya-rao', firmId: 'quickset', silhouette };
}

function proxyOf(t: ReturnType<typeof buildTower>, id: string): THREE.Object3D {
  for (const [p, fid] of t.pickables) if (fid === id) return p;
  throw new Error(`no proxy for ${id}`);
}

/** World positions of every instance of the instanced parts named `name`. */
function instancesOf(o: THREE.Object3D, name: string): THREE.Vector3[] {
  o.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  const m = new THREE.Matrix4();
  o.traverse((c) => {
    const im = c as THREE.InstancedMesh;
    if (!im.isInstancedMesh || im.name !== name) return;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      out.push(new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(im.matrixWorld));
    }
  });
  return out;
}

/** The bounds of every visible mesh drawn in the material named `name`. */
function boundsOf(o: THREE.Object3D, name: string): THREE.Box3 {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3();
  o.traverseVisible((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).name === name) box.expandByObject(m, true);
  });
  return box;
}

const deg = (r: number): number => (r * 180) / Math.PI;

test("a lens tower's tenth earned floor is rotated 15 degrees and carries a crown with two rings", () => {
  const s = agentSpec('lens', 10);
  const t = buildTower(s, 'high', plainMaterials());
  const tenth = proxyOf(t, s.floors[9].id).rotation.y;
  assert.ok(Math.abs(deg(tenth) - 15) < 1e-6, `the tenth floor turns 15 degrees (${deg(tenth).toFixed(3)})`);
  // The twist grows floor by floor.
  for (let i = 0; i < 10; i++) {
    const r = deg(proxyOf(t, s.floors[i].id).rotation.y);
    assert.ok(Math.abs(r - (i + 1) * LENS_TWIST_DEG) < 1e-6, `floor ${i + 1} turns ${(i + 1) * LENS_TWIST_DEG} degrees (${r.toFixed(3)})`);
  }
  assert.deepEqual(t.crown, { kind: 'lens', rings: 2, height: crownFor('lens', 10).height });
  const top = layoutTower(s).top;
  // Each ring is a tier of mullions round the glazed drum.
  const mullions = instancesOf(t.group, 'tower:lens-mullion');
  assert.equal(mullions.length, 2 * LENS_MULLIONS, 'two rings of mullions');
  assert.ok(mullions.every((p) => p.y > top), 'the mullions stand on the roof');
  const tiers = new Set(mullions.map((p) => p.y.toFixed(2)));
  assert.equal(tiers.size, 2, 'in two tiers');
  // A polished lens disc caps the drum, inside the crown's height.
  const lens = boundsOf(t.group, 'lens');
  assert.ok(!lens.isEmpty(), 'a lens disc');
  assert.ok(lens.min.y > top && lens.max.y <= top + crownFor('lens', 10).height + 1e-3, `the lens sits on the drum within the crown (${lens.min.y.toFixed(2)} to ${lens.max.y.toFixed(2)}, roof ${top})`);
  // A lens tower under five floors still carries its drum and lens, with no ring yet.
  const young = buildTower(agentSpec('lens', 4), 'high', plainMaterials());
  assert.equal(young.crown.rings, 0);
  assert.equal(instancesOf(young.group, 'tower:lens-mullion').length, 0);
  assert.ok(!boundsOf(young.group, 'lens').isEmpty());
});

test('a cantilever tower offsets its third and sixth earned floors to opposite sides with brackets', () => {
  const s = agentSpec('cantilever', 7, 'glass');
  const lay = layoutTower(s);
  const t = buildTower(s, 'high', plainMaterials());
  const x = (i: number): number => proxyOf(t, s.floors[i].id).position.x;
  assert.ok(Math.abs(x(2) - 3) < 1e-6, `the third floor steps out 3 m (${x(2)})`);
  assert.ok(Math.abs(x(5) + 3) < 1e-6, `the sixth floor steps out 3 m the other way (${x(5)})`);
  for (const i of [0, 1, 3, 4, 6]) assert.ok(Math.abs(x(i)) < 1e-6, `floor ${i + 1} stays on the axis (${x(i)})`);
  const brackets = instancesOf(t.group, 'tower:bracket');
  // Brackets under a floor hang from the face of the floor below it, inside that floor's height.
  const under = (i: number): THREE.Vector3[] => brackets.filter((p) => p.y > lay.floors[i - 1].y0 + 1e-3 && p.y <= lay.floors[i].y0 + 1e-3);
  const third = under(2);
  assert.equal(third.length, 2, 'a pair of brackets carries the third floor');
  assert.ok(third.every((p) => p.x > AGENT_FLOOR_WIDTH / 2 - 0.5), 'on its overhanging side');
  assert.ok(Math.abs(third[0].z + third[1].z) < 1e-6 && Math.abs(third[0].z) > 2, 'one each side of the centre line');
  const sixth = under(5);
  assert.equal(sixth.length, 2, 'a pair of brackets carries the sixth floor');
  assert.ok(sixth.every((p) => p.x < -(AGENT_FLOOR_WIDTH / 2 - 0.5)), 'on the other side');
  // No floor overhangs without a bracket under it: the floor back over the axis rests on brackets over its own overhang.
  const fourth = under(3);
  assert.equal(fourth.length, 2);
  assert.ok(fourth.every((p) => p.x < 0), 'the fourth floor is carried where it overhangs the third');
  assert.equal(under(1).length, 0, 'a floor flush with the one below has no brackets');
});

test("a needle tower's twentieth earned floor is 60 percent wide and ends in a spire", () => {
  const s = agentSpec('needle', 22, 'stone');
  const t = buildTower(s, 'high', plainMaterials());
  const w = (tw: ReturnType<typeof buildTower>, id: string): number => proxyOf(tw, id).scale.x;
  // The same floor built plain at 60 percent of the agent width.
  const narrow = buildTower(agentSpec('plain', 1, 'stone'), 'high', plainMaterials(), undefined, { width: AGENT_FLOOR_WIDTH * 0.6 });
  const want = w(narrow, agentSpec('plain', 1).floors[0].id);
  const got = w(t, s.floors[19].id);
  assert.ok(Math.abs(got - want) < 0.05, `the twentieth floor is 60 percent wide (${got.toFixed(2)} m, want ${want.toFixed(2)} m)`);
  // Narrowing floor by floor, then holding.
  for (let i = 1; i < 20; i++) assert.ok(w(t, s.floors[i].id) < w(t, s.floors[i - 1].id), `floor ${i + 1} is narrower than floor ${i}`);
  assert.ok(Math.abs(w(t, s.floors[21].id) - got) < 0.05, 'and holds past the twentieth');
  const top = layoutTower(s).top;
  const spire = crownFor('needle', 22);
  assert.deepEqual(t.crown, { kind: 'spire', rings: 0, height: spire.height });
  const mast = boundsOf(t.group, 'galvanised');
  assert.ok(Math.abs(mast.max.y - (top + spire.height)) < 0.5, `a spire rises ${spire.height} m over the roof (to ${mast.max.y.toFixed(1)}, roof ${top.toFixed(1)})`);
  const lamp = boundsOf(t.group, 'beacon');
  assert.ok(lamp.max.y > top + spire.height - 0.6, `an aviation lamp at its tip (${lamp.max.y.toFixed(1)})`);
});

test('founding floors are never transformed', () => {
  for (const sil of ['lens', 'cantilever', 'needle'] as const) {
    const founding = Array.from({ length: 6 }, (_, i) => floor(i, 'stone', true));
    const above = Array.from({ length: 9 }, (_, i) => floor(10 + i, 'stone', false));
    const s: TowerSpec = { ...agentSpec(sil, 0), floors: [...founding, ...above], datumIndex: founding.length };
    const t = buildTower(s, 'high', plainMaterials());
    const plain = buildTower({ ...s, silhouette: 'plain' }, 'high', plainMaterials());
    for (const f of founding) {
      const a = proxyOf(t, f.id);
      const b = proxyOf(plain, f.id);
      assert.ok(a.position.equals(b.position) && a.rotation.y === b.rotation.y && a.scale.equals(b.scale), `${sil}: founding floor ${f.id} stands as it would plain`);
    }
    // The earned floors above do take the silhouette.
    const moved = above.some((f) => {
      const a = proxyOf(t, f.id);
      const b = proxyOf(plain, f.id);
      return !a.position.equals(b.position) || a.rotation.y !== b.rotation.y || !a.scale.equals(b.scale);
    });
    assert.ok(moved, `${sil}: the earned floors take the silhouette`);
  }
  // A repo's own tower never takes a silhouette, whatever its spec says.
  const repo: TowerSpec = { ...agentSpec('lens', 6), kind: 'founding', id: 'acme/widgets#founding', repo: 'acme/widgets' };
  const t = buildTower(repo, 'high', plainMaterials());
  assert.ok(repo.floors.every((f) => proxyOf(t, f.id).rotation.y === 0), 'a repo tower is never twisted');
  assert.equal(t.crown.kind, 'none');
});
