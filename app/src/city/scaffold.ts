import * as THREE from 'three';

import { makePlinth } from './ground';
import { BAY, bar, DEPTH, HALF, instanced, LIFT, LIFTS, PLINTH_TOP, type Scaffold, scaffoldMaterials, TUBE } from './scaffold-kit.js';

export { FESTOON_LAMPS, makeLitScaffold, makeRecladScaffold, type LitScaffold, type RecladScaffold, type Scaffold, type ScaffoldStage } from './scaffold-kit.js';

/**
 * The quiet state of a district whose first analysis is still running:
 * the district's stone plinth with a bare scaffold standing round the
 * first lift of a concrete core, netting hung on two faces. No crane and no lights: those mean
 * real construction, which arrives in Phase 2.
 */
export function makeScaffold(): Scaffold {
  const m = scaffoldMaterials();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const group = new THREE.Group();
  group.name = 'scaffold';

  const tubes: THREE.Matrix4[] = [];
  const boards: THREE.Matrix4[] = [];
  const sheets: THREE.Matrix4[] = [];
  const top = LIFT * LIFTS;
  const bays = Math.round((HALF * 2) / BAY);

  // One face at a time, in the face's own frame: u along the face, the inner row at HALF, the outer at HALF + DEPTH.
  for (let side = 0; side < 4; side++) {
    const rot = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
    const p = (u: number, y: number, out: number): THREE.Vector3 => new THREE.Vector3(u, y, out).applyMatrix4(rot);
    const rows = [HALF, HALF + DEPTH];

    for (let i = 0; i <= bays; i++) {
      const u = -HALF + i * BAY;
      for (const r of rows) tubes.push(bar(p(u, 0, r), p(u, top + 1, r), TUBE));
      // Transoms tie the two rows at every lift.
      for (let l = 1; l <= LIFTS; l++) tubes.push(bar(p(u, l * LIFT, rows[0]), p(u, l * LIFT, rows[1]), TUBE * 0.8));
    }
    for (let l = 1; l <= LIFTS; l++) {
      const y = l * LIFT;
      for (const r of rows) tubes.push(bar(p(-HALF - DEPTH, y, r), p(HALF + DEPTH, y, r), TUBE));
      // Guard rail on the outer row, a metre above each working deck.
      tubes.push(bar(p(-HALF - DEPTH, y + 1, rows[1]), p(HALF + DEPTH, y + 1, rows[1]), TUBE * 0.8));
      // Boards on every other lift, and toe boards along their outer edge.
      if (l % 2 === 0 || l === LIFTS) {
        const c = p(0, y + 0.03, HALF + DEPTH / 2);
        boards.push(new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromRotationMatrix(rot), new THREE.Vector3(HALF * 2 + DEPTH * 2, 0.06, DEPTH)));
        const t = p(0, y + 0.12, HALF + DEPTH);
        boards.push(new THREE.Matrix4().compose(t, new THREE.Quaternion().setFromRotationMatrix(rot), new THREE.Vector3(HALF * 2 + DEPTH * 2, 0.18, 0.04)));
      }
    }
    // Facade bracing: a zigzag of rakers across the outer face, one per three bays.
    for (let i = 0; i + 3 <= bays; i += 3) {
      const u0 = -HALF + i * BAY;
      const u1 = u0 + 3 * BAY;
      const up = (i / 3) % 2 === 0;
      tubes.push(bar(p(up ? u0 : u1, 0.2, rows[1] + 0.1), p(up ? u1 : u0, top, rows[1] + 0.1), TUBE));
    }
    // Netting hangs full height on the two faces turned away from the plaza's approach.
    if (side === 1 || side === 2) {
      // Hung in strips two bays wide, lapped loosely so the seams show; the top lift is left open.
      const h = top - LIFT;
      const q = new THREE.Quaternion().setFromRotationMatrix(rot);
      for (let i = 0; i + 2 <= bays; i += 2) {
        const u = -HALF + (i + 1) * BAY;
        const sag = (i / 2) % 2 === 0 ? 0 : 0.06;
        sheets.push(new THREE.Matrix4().compose(p(u, h / 2 + 0.3, HALF + DEPTH + 0.22 + sag), q, new THREE.Vector3(BAY * 2 - 0.12, h, 0.02)));
      }
    }
  }

  group.add(instanced(box, m.tube, tubes), instanced(box, m.board, boards));
  const net = instanced(box, m.sheet, sheets);
  net.castShadow = false;
  group.add(net);

  // The district's stone plinth is already laid; the scaffold and the first lift of a concrete core stand on it.
  const core = new THREE.Mesh(box, m.pour);
  core.scale.set(9, 7, 7);
  core.position.y = 3.5;
  core.castShadow = core.receiveShadow = true;
  group.add(core);
  group.position.y = PLINTH_TOP;
  const plinth = makePlinth();
  const site = new THREE.Group();
  site.name = 'site';
  site.add(plinth, group);

  return {
    object: site,
    dispose() {
      group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      plinth.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      box.dispose();
    },
  };
}
