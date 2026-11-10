import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { batchPieces, drawnMeshes } from '../app/src/city/batch.js';
import { ambientCap, COURT_APRON } from '../app/src/city/collar.js';
import { standingLots } from '../app/src/city/lots.js';
import { occupancy, plazasOf } from '../app/src/city/occupancy.js';
import { quarterCenterpiece, quarterLooks, QUARTER_OFFSETS } from '../app/src/city/quarters.js';
import { AGENT_FLOOR_WIDTH } from '../app/src/city/tower/build.js';
import type { TowerMaterials } from '../app/src/city/tower/kit.js';
import { type Look, lookKey } from '../app/src/city/tower/variants.js';
import { DISTRICT_PITCH, districtOrigin, QUARTER_COURT } from '../shared/district-layout.js';
import { agentRootHeight, layoutTower } from '../shared/tower-layout.js';
import type { Era, Floor, Quarter, RootStyle, Silhouette, TowerSpec } from '../shared/types.js';

/** Plain materials, one per key, named by key, so the quarter builds in Node. */
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

function floor(agentId: string, firmId: string, i: number, era: Era): Floor {
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
    earned: { jobId: `job-${i}`, runId: `run-${i}`, agentId, firmId, state: 'lit', reverted: false },
  };
}

function tower(agentId: string, firmId: string, root: RootStyle, silhouette: Silhouette, n: number, towerIndex: number, era: Era = 'glass'): TowerSpec {
  return {
    id: `agent:${agentId}`,
    repo: '',
    kind: 'agent',
    root,
    floors: Array.from({ length: n }, (_, i) => floor(agentId, firmId, i, era)),
    datumIndex: 0,
    firmId,
    agentId,
    silhouette,
    towerIndex,
  };
}

/** A firm's quarter of four towers at the tallest an agent of the sample economy stands (14 floors). */
function fullQuarter(root: RootStyle, silhouette: Silhouette, slot = 7): Quarter {
  const firmId = `firm-${root}`;
  return {
    firmId,
    slot,
    origin: districtOrigin(slot),
    root,
    dark: false,
    towers: [0, 1, 2, 3].map((i) => tower(`${root}-${silhouette}-${i}`, firmId, root, silhouette, 14, i)),
  };
}

/** The plan of every visible mesh under `o` except the quarter's own court pieces, in the quarter's frame. */
function planOf(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3();
  o.traverseVisible((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) box.expandByObject(m, true);
  });
  return box;
}

const PITCH = DISTRICT_PITCH / 3;

test('quarter offsets keep four 16 m towers clear of each other, their cantilevers and the collar', () => {
  assert.deepEqual(QUARTER_OFFSETS, [
    { x: -52, z: -52 },
    { x: 52, z: -52 },
    { x: -52, z: 52 },
    { x: 52, z: 52 },
  ]);
  assert.equal(AGENT_FLOOR_WIDTH, 16);
  for (const root of ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'] as const) {
    for (const silhouette of ['cantilever', 'lens', 'needle', 'plain'] as const) {
      const q = { ...fullQuarter(root, silhouette), origin: { x: 0, z: 0 } };
      const piece = quarterCenterpiece(q, 'high', (t) => quarterLooks(q).get(t.id)!, { name: 'Firm', materials: plainMaterials });
      const towers = q.towers.map((t) => piece.object.getObjectByName(`tower:${t.id}`));
      assert.ok(towers.every(Boolean), `${root} ${silhouette}: each agent stands as its own tower`);
      const plans = towers.map((t) => planOf(t!));
      plans.forEach((p, i) => {
        const at = QUARTER_OFFSETS[i];
        // Centred on its offset (a cantilever steps out either way, so the plan stays centred).
        assert.ok(Math.abs((p.min.x + p.max.x) / 2 - at.x) < 2 && Math.abs((p.min.z + p.max.z) / 2 - at.z) < 2, `${root} ${silhouette} tower ${i} stands on its plot`);
        // Inside the court with a walkway round it.
        const reach = Math.max(Math.abs(p.min.x), Math.abs(p.max.x), Math.abs(p.min.z), Math.abs(p.max.z));
        assert.ok(reach <= QUARTER_COURT - 6, `${root} ${silhouette} tower ${i} reaches ${reach.toFixed(1)} m, inside the ${QUARTER_COURT} m court with room to walk round`);
      });
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
          const gx = Math.max(plans[a].min.x - plans[b].max.x, plans[b].min.x - plans[a].max.x);
          const gz = Math.max(plans[a].min.z - plans[b].max.z, plans[b].min.z - plans[a].max.z);
          assert.ok(Math.max(gx, gz) >= 40, `${root} ${silhouette} towers ${a} and ${b} stand ${Math.max(gx, gz).toFixed(1)} m apart, room for the covered walk`);
        }
      }
      piece.dispose?.();
    }
  }

  // The collar: no ambient building stands on the court or its apron, and the blocks round it stay under the lowest root.
  const q = fullQuarter('chicago', 'cantilever');
  const plazas = plazasOf(occupancy([], [], [q]));
  const ci = Math.round(q.origin.x / PITCH);
  const cj = Math.round(q.origin.z / PITCH);
  for (let i = ci - 3; i <= ci + 3; i++) {
    for (let j = cj - 3; j <= cj + 3; j++) {
      for (const lot of standingLots(i, j, [{ x: 0, z: 0 }, ...plazas])) {
        const dx = Math.max(Math.abs(lot.x - q.origin.x) - lot.w / 2, 0);
        const dz = Math.max(Math.abs(lot.z - q.origin.z) - lot.d / 2, 0);
        assert.ok(Math.max(dx, dz) >= QUARTER_COURT + COURT_APRON, `lot at ${lot.x},${lot.z} keeps off the court`);
      }
    }
  }
  const low = Math.min(...q.towers.map((t) => layoutTower(t).rootHeight));
  assert.equal(low, agentRootHeight('chicago'));
  assert.ok(ambientCap(q.origin.x + QUARTER_COURT + 20, q.origin.z, plazas) < low, 'beside the court the blocks stay under the roots');
});

test('a quarter stands only the towers it has, each on its own plot by tower index, and its pieces pick as agents or the firm', () => {
  const full = fullQuarter('gothic', 'lens');
  // The second agent retired: the others keep their plots.
  const q: Quarter = { ...full, towers: [full.towers[0], full.towers[2], full.towers[3]] };
  const piece = quarterCenterpiece(q, 'medium', (t) => quarterLooks(q).get(t.id)!, { name: 'Ashlar & Vane', materials: plainMaterials });
  for (const t of q.towers) {
    const g = piece.object.getObjectByName(`tower:${t.id}`)!;
    assert.deepEqual([g.position.x, g.position.z], [QUARTER_OFFSETS[t.towerIndex!].x, QUARTER_OFFSETS[t.towerIndex!].z]);
  }
  const agents = new Set(piece.agents?.values());
  assert.deepEqual([...agents].sort(), q.towers.map((t) => t.agentId!).sort(), 'every tower picks as its agent');
  const picks = [...piece.pickables.keys()];
  assert.ok(picks.some((p) => !piece.agents?.has(p)), 'the plinth picks as the firm');
  // The walk joins neighbouring towers only: three towers on the corners 0, 2, 3 make two walks.
  assert.equal(piece.object.getObjectByName('quarter:walks')?.userData.spans, 2);
  piece.dispose?.();
});

test("a firm's towers share its material family and differ within it, and a re-clad tower takes its buyer's", () => {
  const q = fullQuarter('chicago', 'plain');
  const looks = quarterLooks(q);
  const glass = q.towers.map((t) => looks.get(t.id)!.glass.id);
  assert.equal(new Set(glass).size, 4, `each tower differs (${glass.join(', ')})`);
  // A tower bought by another firm is re-clad in that firm's look.
  const sold: Quarter = { ...q, towers: [{ ...q.towers[0], firmId: 'buyer', root: 'roman' }, ...q.towers.slice(1)] };
  const mine = quarterLooks(q).get(q.towers[0].id)!;
  const theirs = quarterLooks(sold).get(q.towers[0].id)!;
  assert.notDeepEqual(theirs, mine);
  // Deterministic: the same quarter, the same looks.
  assert.deepEqual([...quarterLooks(q)], [...quarterLooks(q)]);
});

test('an agent root is the district root at the agent scale, and its floors stand on it', () => {
  const t = tower('a', 'f', 'gothic', 'plain', 3, 0);
  const lay = layoutTower(t);
  assert.equal(lay.rootHeight, agentRootHeight('gothic'));
  assert.ok(lay.rootHeight < 34 && lay.rootHeight > 15);
  assert.equal(lay.floors[0].y0, lay.rootHeight);
});

// ---------------------------------------------------------------- batching (draw calls)

/** Plain materials as the city has them: the shared library once, each look's era slots its own. */
function cityMaterials(): (look: Look) => TowerMaterials {
  const library = new Map<string, THREE.Material>();
  const byLook = new Map<string, Map<string, THREE.Material>>();
  return (look) => {
    const key = lookKey(look);
    let own = byLook.get(key);
    if (!own) byLook.set(key, (own = new Map()));
    return new Proxy({} as TowerMaterials, {
      get(_, k) {
        const name = String(k);
        const era = /^(stone|brick|glass|titanium|scifi)(Wall|Trim|Band|Win|Face)$/.test(name);
        const map = era ? own : library;
        let m = map.get(name);
        if (!m) {
          // As in look.ts: the variant materials read vertex colours, and the window glass reads its instance matrix.
          map.set(name, (m = new THREE.MeshStandardMaterial({ name, vertexColors: era && !name.endsWith('Win') })));
          if (name === 'window' || name.endsWith('Win')) m.userData.instanceData = true;
        }
        return m;
      },
    });
  };
}

/** Triangles drawn under `o`, instances counted, an LOD counting its near level. */
function drawnTriangles(o: THREE.Object3D): number {
  let n = 0;
  const visit = (x: THREE.Object3D, top: boolean): void => {
    if ((x as THREE.LOD).isLOD) return visit((x as THREE.LOD).levels[0].object, false);
    const m = x as THREE.Mesh;
    if (m.isMesh && m.visible) {
      const tris = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
      n += tris * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
    }
    if (top || x.visible) x.children.forEach((c) => visit(c, false));
  };
  visit(o, true);
  return n;
}

test("the city's quarters draw in a bounded number of batches, and draw the same triangles where they stood", () => {
  const materials = cityMaterials();
  const roots: RootStyle[] = ['gothic', 'chicago', 'beauxarts', 'roman', 'pagoda', 'beauxarts'];
  const sils: Silhouette[] = ['lens', 'cantilever', 'needle', 'plain'];
  const eras: Era[] = ['glass', 'titanium', 'scifi', 'brick'];
  const pieces = roots.map((root, k) => {
    const firmId = `firm-${k}`;
    const q: Quarter = {
      firmId,
      slot: 6 + k,
      origin: districtOrigin(6 + k),
      root,
      dark: k === 5,
      towers: [0, 1, 2, 3].map((i) => tower(`${firmId}-${i}`, firmId, root, sils[(i + k) % 4], 3 + ((i * 5 + k * 3) % 12), i, eras[(i + k) % 4])),
    };
    const looks = quarterLooks(q);
    const piece = quarterCenterpiece(q, 'high', (t) => looks.get(t.id)!, { name: q.firmId, materials });
    piece.object.position.set(q.origin.x, 0, q.origin.z);
    return piece;
  });
  const unbatched = pieces.reduce((n, p) => n + drawnMeshes(p.object), 0);
  const triangles = pieces.reduce((n, p) => n + drawnTriangles(p.object), 0);
  const bounds = new THREE.Box3();
  for (const p of pieces) bounds.union(planOf(p.object));
  const batched = batchPieces(pieces.map((p) => p.object));
  const calls = drawnMeshes(batched.group);
  const perQuarter = calls / pieces.length;
  assert.ok(perQuarter <= 26, `six full quarters draw in ${calls} batches (${perQuarter.toFixed(1)} a quarter, from ${unbatched} meshes)`);
  assert.ok(calls < unbatched / 2, `batching at least halves the meshes (${unbatched} to ${calls})`);
  assert.equal(drawnTriangles(batched.group), triangles, 'every triangle still drawn');
  const after = planOf(batched.group);
  assert.ok(after.min.distanceTo(bounds.min) < 1e-3 && after.max.distanceTo(bounds.max) < 1e-3, 'and where it stood');
  batched.dispose();
  for (const p of pieces) p.dispose();
});
