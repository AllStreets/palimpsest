import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { batchPieces, drawnMeshes } from '../app/src/city/batch.js';
import { quarterCenterpiece } from '../app/src/city/quarters.js';
import { lookFor } from '../app/src/city/tower/variants.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { districtOrigin } from '../shared/district-layout.js';
import type { Floor, Quarter, TowerSpec } from '../shared/types.js';
import { CAMPANILE, onExchange, CIVIC_LAMPS, EXCHANGE_SLOTS, FOUNTAIN, HALL, JOBS_ROUTE, LAMPS_PER_SLOT, boardLabel, makeExchange, toteBoard } from '../app/src/city/exchange.js';
import { BLOCK, PITCH, standingLots } from '../app/src/city/lots.js';
import type { JobStatus } from '../shared/types.js';

/** Instances of a named instanced mesh whose colour is lit (an emitter above the bloom threshold). */
function litCount(root: THREE.Object3D, name: string): number {
  const mesh = root.getObjectByName(name) as THREE.InstancedMesh | undefined;
  assert.ok(mesh, `${name} exists`);
  const c = new THREE.Color();
  let n = 0;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getColorAt(i, c);
    if (Math.max(c.r, c.g, c.b) > 1) n++;
  }
  return n;
}

function slotCount(root: THREE.Object3D): number {
  return (root.getObjectByName('exchange:slots') as THREE.InstancedMesh).count;
}

/** The civic plaza's paved radius (grid.ts PLAZA_RADIUS; grid.ts itself is browser code outside the node project). */
const PLAZA_RADIUS = 72;

const jobs = (n: number, status: JobStatus, bids: number): Array<{ status: JobStatus; bids: number }> => Array.from({ length: n }, () => ({ status, bids }));

test('the tote board lights one slot per bidding job and one lamp per bid', () => {
  const ex = makeExchange('high');
  ex.setBoard([
    { status: 'bidding', bids: 3 },
    { status: 'open', bids: 0 },
  ]);
  const board = toteBoard([
    { status: 'bidding', bids: 3 },
    { status: 'open', bids: 0 },
  ]);
  assert.deepEqual(board.slice(0, 2), [
    { state: 'bidding', lamps: 3 },
    { state: 'open', lamps: 0 },
  ]);
  assert.ok(board.slice(2).every((s) => s.state === 'empty' && s.lamps === 0), 'every other slot is empty and dark');
  assert.equal(litCount(ex.object, 'exchange:slots'), 1, 'one lit slot');
  assert.equal(litCount(ex.object, 'exchange:lamps'), 3, 'three lit lamps');
  // The open job's slot stands dark but posted: its shutter is up, its card unlit.
  assert.equal(ex.slots()[1].state, 'open');
  assert.equal(ex.slots()[1].lamps, 0);
  // A bid placed later ticks one more lamp, and only real counts show.
  ex.setBoard([{ status: 'bidding', bids: 4 }]);
  assert.equal(litCount(ex.object, 'exchange:lamps'), 4);
  ex.setBoard([]);
  assert.equal(litCount(ex.object, 'exchange:slots'), 0);
  assert.equal(litCount(ex.object, 'exchange:lamps'), 0);
  ex.dispose();
});

test('the board holds 24 slots and ignores the rest', () => {
  assert.equal(EXCHANGE_SLOTS, 24);
  const ex = makeExchange('high');
  assert.equal(slotCount(ex.object), 24);
  ex.setBoard([...jobs(30, 'bidding', 2), ...jobs(5, 'running', 9), ...jobs(3, 'merged', 4)]);
  assert.equal(litCount(ex.object, 'exchange:slots'), 24, 'only 24 slots light');
  assert.equal(litCount(ex.object, 'exchange:lamps'), 48, 'two lamps on each of the 24');
  // Jobs past bidding never reach the board, whatever their bids.
  const board = toteBoard([...jobs(2, 'awarded', 5), ...jobs(1, 'bidding', 1)]);
  assert.deepEqual(board[0], { state: 'bidding', lamps: 1 });
  assert.equal(board.filter((s) => s.state !== 'empty').length, 1);
  // More bids than a slot has lamps light every lamp it has, never more; a negative or fractional count lights none past the real whole bids.
  assert.equal(toteBoard([{ status: 'bidding', bids: 40 }])[0].lamps, LAMPS_PER_SLOT);
  assert.equal(toteBoard([{ status: 'bidding', bids: -2 }])[0].lamps, 0);
  assert.equal(toteBoard([{ status: 'bidding', bids: 2.7 }])[0].lamps, 2);
  ex.dispose();
});

test('the fountain stops when the engine is stopped', () => {
  const ex = makeExchange('high');
  const jet = ex.object.getObjectByName('exchange:jet');
  assert.ok(jet, 'the fountain has a jet');
  assert.equal(ex.fountainRunning(), true, 'a running engine runs the fountain');
  assert.equal(jet.visible, true);
  ex.setStopped(true);
  assert.equal(ex.fountainRunning(), false);
  // The water falls still over a moment, then the jet is gone.
  for (let i = 0; i < 120; i++) ex.update(1 / 30);
  assert.equal(jet.visible, false, 'no water rises while the engine is stopped');
  ex.setStopped(false);
  assert.equal(ex.fountainRunning(), true);
  ex.update(1 / 30);
  assert.equal(jet.visible, true, 'and it runs again when the engine resumes');
  ex.dispose();
});

test('picking the hall returns the jobs route', () => {
  assert.equal(JOBS_ROUTE, '#/jobs');
  const ex = makeExchange('high');
  ex.object.updateMatrixWorld(true);
  assert.ok(ex.pickables.size > 0);
  for (const route of ex.pickables.values()) assert.equal(route, JOBS_ROUTE);
  const ray = new THREE.Raycaster();
  // From the forecourt at eye height, toward the portico; and from far above, onto the dome.
  for (const [from, to] of [
    [new THREE.Vector3(0, 8, 160), new THREE.Vector3(0, 10, 0)],
    [new THREE.Vector3(260, 300, 260), new THREE.Vector3(0, 30, HALL.z0 + HALL.depth / 2)],
  ]) {
    ray.set(from, to.clone().sub(from).normalize());
    const hits = ray.intersectObjects([...ex.pickables.keys()], false);
    assert.ok(hits.length > 0, `a ray from ${from.toArray()} hits the hall`);
    assert.equal(ex.pickables.get(hits[0].object), JOBS_ROUTE);
  }
  ex.dispose();
});

test('the exchange, its fountain and its lamp standards stand on the civic plaza, clear of every ambient block', () => {
  const ex = makeExchange('medium');
  ex.object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(ex.object);
  // Everything the hall, the campanile and the forecourt set on the ground is on the plaza's paving.
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let far = 0;
  for (const root of ex.statics) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const n = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
      for (let k = 0; k < n; k++) {
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).getMatrixAt(k, m);
        else m.identity();
        m.premultiply(mesh.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          if (v.y < 0.6) far = Math.max(far, Math.hypot(v.x, v.z));
        }
      }
    });
  }
  assert.ok(far < PLAZA_RADIUS, `its foot reaches ${far.toFixed(1)} m from the plaza's centre`);
  // A civic building, not a kiosk: it reads at city distance.
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.x > 60 && size.y > 40, `the hall is ${size.x.toFixed(0)} m wide and ${size.y.toFixed(0)} m high`);
  assert.ok(Math.hypot(FOUNTAIN.x, FOUNTAIN.z) + FOUNTAIN.radius < PLAZA_RADIUS);
  assert.equal(CIVIC_LAMPS.length, 4);
  for (const l of CIVIC_LAMPS) {
    assert.ok(Math.hypot(l.x, l.z) < PLAZA_RADIUS - 6, 'each standard is inside the plaza ring');
    // Never on the stair, the hall or the basin.
    assert.ok(l.z > HALL.z0 + HALL.depth + HALL.stair + 2 || Math.abs(l.x) > HALL.width / 2 + 2, 'clear of the hall and its stair');
    assert.ok(Math.hypot(l.x - FOUNTAIN.x, l.z - FOUNTAIN.z) > FOUNTAIN.radius + 3, 'clear of the basin');
  }
  // The campanile stands on the axis behind the hall, inside the plaza and clear of the ring of lanterns.
  assert.ok(onExchange(0, CAMPANILE.z, 0) && onExchange(0, CAMPANILE.z - CAMPANILE.half, 0));
  // The ambient city stands no lot on the hall.
  const reach = Math.ceil((PLAZA_RADIUS + BLOCK) / PITCH);
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      for (const lot of standingLots(i, j, [{ x: 0, z: 0 }])) {
        const clear = lot.x + lot.w / 2 < box.min.x || lot.x - lot.w / 2 > box.max.x || lot.z + lot.d / 2 < box.min.z || lot.z - lot.d / 2 > box.max.z;
        assert.ok(clear, `lot at ${lot.x}, ${lot.z} stands clear of the exchange`);
      }
    }
  }
  ex.dispose();
});

test('the exchange draws its columns and lamps instanced and its stone in few batches', () => {
  const ex = makeExchange('high');
  let meshes = 0;
  const instanced: THREE.InstancedMesh[] = [];
  ex.object.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || !o.visible) return;
    if (o.parent && (o.parent as THREE.LOD).isLOD) return;
    meshes++;
    if ((o as THREE.InstancedMesh).isInstancedMesh) instanced.push(o as THREE.InstancedMesh);
  });
  const shafts = instanced.find((m) => m.name.includes('exchange:shaft'));
  assert.ok(shafts && shafts.count >= 8, 'the colonnade is one instanced batch of fluted shafts');
  assert.equal((ex.object.getObjectByName('exchange:lamps') as THREE.InstancedMesh).count, EXCHANGE_SLOTS * LAMPS_PER_SLOT);
  assert.ok(meshes < 70, `the exchange draws in ${meshes} meshes`);
  ex.dispose();
});

test("a slot's card carries only the repo's short name and the issue number, never a path or a token", () => {
  assert.equal(boardLabel({ repo: 'marlow/harbour-ledger', issue: 14 }), 'harbour-ledger #14');
  assert.equal(boardLabel({ repo: 'marlow/kumo', issue: null }), 'kumo');
  // A name is cut to what fits a card, and anything outside a repo name's characters is dropped.
  const odd = boardLabel({ repo: 'x/ghp_abcdefghijklmnopqrstuvwxyz0123456789/Users/connor/.ssh', issue: 3 });
  assert.ok(!/ghp_|\/Users|\.ssh|connor/.test(odd), odd);
  assert.ok(boardLabel({ repo: 'a/a-very-long-repository-name-that-runs-on', issue: 12345 }).length <= 22);
});

test('the campanile rises well over the hall and stays below the district towers', () => {
  const ex = makeExchange('medium');
  ex.object.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(ex.object).max.y;
  assert.ok(Math.abs(top - CAMPANILE.top) < 0.5, `its finial is the exchange's top (${top.toFixed(1)} m)`);
  // Findable from the home framing over the ambient roofs (the civic collar tops out near 60 m round the plaza)...
  assert.ok(top > 95, `${top.toFixed(0)} m`);
  // ...and never a rival to the market's towers: a 20 floor district already stands over 120 m.
  assert.ok(top < 115, `${top.toFixed(0)} m`);
  // Five clocks (the entrance and each face of the campanile), every hand in one instanced batch.
  assert.equal((ex.object.getObjectByName('exchange:hands') as THREE.InstancedMesh).count, 10);
  ex.dispose();
});

/** Plain materials, one per key, shared by everything built with them (as the city shares its stone across looks). */
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

function quarterOf(slot: number): Quarter {
  const firmId = 'firm-roman';
  const floor = (agent: string, i: number): Floor => ({
    id: `agent:${agent}#job-${i}`,
    repo: 'acme/widgets',
    kind: 'pr',
    refs: [],
    title: `change ${i}`,
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    era: 'glass',
    size: 'medium',
    lines: 10,
    claude: false,
    founding: false,
    url: null,
    earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId: agent, firmId, state: 'lit', reverted: false },
  });
  const towers: TowerSpec[] = [0, 1, 2, 3].map((t) => ({
    id: `agent:a${t}`,
    repo: '',
    kind: 'agent',
    root: 'roman',
    floors: Array.from({ length: 10 }, (_, i) => floor(`a${t}`, i)),
    datumIndex: 0,
    firmId,
    agentId: `a${t}`,
    silhouette: 'plain',
    towerIndex: t,
  }));
  return { firmId, slot, origin: districtOrigin(slot), root: 'roman', dark: false, towers };
}

test('the exchange draws in the city-wide batches, under 30 calls over the city without it', () => {
  const mats = plainMaterials();
  const q = quarterCenterpiece(quarterOf(7), 'high', () => lookFor('firm-roman'), { name: 'Firm', materials: () => mats });
  q.object.position.set(districtOrigin(7).x, 0, districtOrigin(7).z);
  const ex = makeExchange('high', { materials: mats });
  const unbatched = drawnMeshes(ex.object);
  const without = batchPieces([q.object]);
  const before = drawnMeshes(without.group);
  const withEx = batchPieces([q.object, ...ex.statics]);
  for (const r of ex.statics) r.visible = false;
  // The batches, plus what the exchange still draws itself: the board, its words, the water, the hands.
  const after = drawnMeshes(withEx.group) + drawnMeshes(ex.object);
  assert.ok(after - before < 30, `the exchange adds ${after - before} calls (${unbatched} unbatched)`);
  // Nothing is lost: every triangle the exchange drew is still drawn.
  const tris = (o: THREE.Object3D): number => {
    let n = 0;
    o.traverseVisible((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry;
      const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
      n += per * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
    });
    return n;
  };
  for (const r of ex.statics) r.visible = true;
  const exTris = ex.statics.reduce((n, r) => n + tris(r), 0);
  assert.equal(tris(withEx.group), tris(without.group) + exTris);
  without.dispose();
  withEx.dispose();
  ex.dispose();
  q.dispose();
});
