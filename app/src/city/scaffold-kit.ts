/**
 * The tube-and-board scaffold's parts (scaffold.ts): its dimensions, its
 * materials and the re-clad scaffold, with and without festoon lights. Kept
 * apart from the site scaffold so the city's milestones (milestones.ts) and
 * node tests take it without the ground.
 */
import * as THREE from 'three';


/** Plan half-width of the scaffold, about a tower root's footprint. */
export const HALF = 15;
export const BAY = 2.5;
export const LIFT = 2;
export const LIFTS = 9;
/** Distance between the inner and outer row of standards. */
export const DEPTH = 1.3;
export const TUBE = 0.09;
/** Top of the district plinth's cornice (three 0.45 m steps, a 2.6 m base, a 0.7 m cornice). */
export const PLINTH_TOP = 0.45 * 3 + 2.6 + 0.7;

export const UP = new THREE.Vector3(0, 1, 0);

/** A matrix that stretches a unit box into a bar from `a` to `b`, `t` thick. */
export function bar(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Matrix4 {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(t, len, t));
}

export function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface Scaffold {
  object: THREE.Object3D;
  dispose(): void;
}

let shared: {
  tube: THREE.MeshStandardMaterial;
  board: THREE.MeshStandardMaterial;
  sheet: THREE.MeshStandardMaterial;
  pour: THREE.MeshStandardMaterial;
} | null = null;

export function scaffoldMaterials(): NonNullable<typeof shared> {
  if (shared) return shared;
  shared = {
    // Galvanised tube: dull zinc, not polished.
    tube: new THREE.MeshStandardMaterial({ color: 0x8f949a, metalness: 0.9, roughness: 0.55 }),
    board: new THREE.MeshStandardMaterial({ color: 0x5e4f3e, roughness: 0.85 }),
    // Fresh concrete: pale and matte, no sheen to pick up the sky.
    pour: new THREE.MeshStandardMaterial({ color: 0xa49c90, roughness: 0.97, envMapIntensity: 0.35 }),
    // Debris netting: pale, loosely woven, lets the frame show through.
    sheet: new THREE.MeshStandardMaterial({
      color: 0x8b958d,
      roughness: 1,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
  return shared;
}

/** One stage of a re-clad scaffold: its inner row `halfX` by `halfZ` from the tower's centre, from `y0` up to `y1`. */
export interface ScaffoldStage {
  halfX: number;
  halfZ: number;
  y0: number;
  y1: number;
}

/**
 * A buyer's re-clad (Task 28): the same tube-and-board scaffold as a site's
 * (the same tube, boards and netting), standing round a whole agent tower in
 * stages that follow its setbacks (round the root, then stepped in round
 * the narrower floors above it, standing on the root's roof), wrapped in
 * netting on every face. Every part is one lift or less tall and
 * the parts are ordered from the ground up, so `setHeight` raises it lift by
 * lift and strikes it from the top down by showing only the parts under a
 * height: no geometry is rebuilt as it moves.
 */
export interface RecladScaffold {
  object: THREE.Object3D;
  /** Shows the scaffold up to this height in metres (0: none); true when what shows changed. */
  setHeight(h: number): boolean;
  readonly height: number;
  dispose(): void;
}

/**
 * How many lifts a stage stands: the top stage rounds up (and stands a lift
 * and a half over the roof as a working deck, when `deck`); a lower stage
 * rounds down, so its top lift never rises into the stage above it.
 */
function liftsOf(stages: ReadonlyArray<ScaffoldStage>, stage: number, deck: boolean): number {
  const { y0, y1 } = stages[stage];
  if (stage < stages.length - 1) return Math.max(1, Math.floor((y1 - y0) / LIFT));
  return Math.max(1, Math.ceil((y1 - y0 + (deck ? 1.5 : 0)) / LIFT));
}

export function makeRecladScaffold(stages: ScaffoldStage[], extraTubes: ReadonlyArray<{ m: THREE.Matrix4; y: number }> = [], deck = true): RecladScaffold {
  const m = scaffoldMaterials();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  let top = 0;
  type Part = { m: THREE.Matrix4; y: number };
  const tubes: Part[] = [...extraTubes];
  const boards: Part[] = [];
  const sheets: Part[] = [];

  stages.forEach(({ halfX, halfZ, y0: base, y1 }, stage) => {
    // The last stage stands a lift and a half over the roof, as a working deck does.
    const lifts = liftsOf(stages, stage, deck);
    top = Math.max(top, base + lifts * LIFT);
    for (let side = 0; side < 4; side++) {
      const rot = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
      // Faces 0 and 2 run along x at +-halfZ; 1 and 3 along z at +-halfX.
      const half = side % 2 === 0 ? halfX : halfZ;
      const reach = side % 2 === 0 ? halfZ : halfX;
      const p = (u: number, y: number, out: number): THREE.Vector3 => new THREE.Vector3(u, y, out).applyMatrix4(rot);
      const rows = [reach, reach + DEPTH];
      const bays = Math.max(2, Math.round((half * 2) / BAY));
      const bay = (half * 2) / bays;
      const q = new THREE.Quaternion().setFromRotationMatrix(rot);
      for (let l = 0; l < lifts; l++) {
        const y0 = base + l * LIFT;
        const y1 = y0 + LIFT;
        for (let i = 0; i <= bays; i++) {
          const u = -half + i * bay;
          // Standards in lift-long lengths, joined at each lift as real tube is.
          for (const r of rows) tubes.push({ m: bar(p(u, y0, r), p(u, y1, r), TUBE), y: y0 });
          tubes.push({
            m: bar(p(u, y1, rows[0]), p(u, y1, rows[1]), TUBE * 0.8),
            y: y1 - 0.01,
          });
        }
        for (const r of rows)
          tubes.push({
            m: bar(p(-half - DEPTH, y1, r), p(half + DEPTH, y1, r), TUBE),
            y: y1 - 0.01,
          });
        tubes.push({
          m: bar(p(-half - DEPTH, y1 + 1, rows[1]), p(half + DEPTH, y1 + 1, rows[1]), TUBE * 0.8),
          y: y1 - 0.01,
        });
        // A raker across every third bay in each lift, alternating, so the bracing zigzags up the face.
        for (let i = 0; i + 3 <= bays; i += 3) {
          const up = (i / 3 + l) % 2 === 0;
          const u0 = -half + i * bay;
          const u1 = u0 + 3 * bay;
          tubes.push({
            m: bar(p(up ? u0 : u1, y0 + 0.1, rows[1] + 0.1), p(up ? u1 : u0, y1, rows[1] + 0.1), TUBE),
            y: y0,
          });
        }
        if (l % 2 === 1 || l === lifts - 1) {
          boards.push({
            m: new THREE.Matrix4().compose(p(0, y1 + 0.03, reach + DEPTH / 2), q, new THREE.Vector3(half * 2 + DEPTH * 2, 0.06, DEPTH)),
            y: y1 - 0.01,
          });
          boards.push({
            m: new THREE.Matrix4().compose(p(0, y1 + 0.12, reach + DEPTH), q, new THREE.Vector3(half * 2 + DEPTH * 2, 0.18, 0.04)),
            y: y1 - 0.01,
          });
        }
        // Netting hung in strips two bays wide, a lift at a time, lapped loosely so the seams show.
        for (let i = 0; i + 2 <= bays; i += 2) {
          const u = -half + (i + 1) * bay;
          const sag = (i / 2 + l) % 2 === 0 ? 0 : 0.06;
          sheets.push({
            m: new THREE.Matrix4().compose(p(u, y0 + LIFT / 2, reach + DEPTH + 0.22 + sag), q, new THREE.Vector3(bay * 2 - 0.12, LIFT + 0.08, 0.02)),
            y: y0,
          });
        }
      }
    }
  });

  const group = new THREE.Group();
  group.name = 'reclad-scaffold';
  const meshes: Array<{ mesh: THREE.InstancedMesh; ys: number[] }> = [];
  for (const [parts, mat, shadow] of [
    [tubes, m.tube, true],
    [boards, m.board, true],
    [sheets, m.sheet, false],
  ] as const) {
    const sorted = [...parts].sort((a, b) => a.y - b.y);
    const mesh = instanced(
      geo,
      mat,
      sorted.map((x) => x.m),
    );
    mesh.castShadow = shadow;
    mesh.count = 0;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push({ mesh, ys: sorted.map((x) => x.y) });
  }

  return {
    object: group,
    height: top,
    setHeight(h) {
      let changed = false;
      for (const { mesh, ys } of meshes) {
        // The parts whose foot is under the height: a binary search over the sorted feet.
        let lo = 0;
        let hi = ys.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ys[mid] < h) lo = mid + 1;
          else hi = mid;
        }
        if (mesh.count !== lo) {
          mesh.count = lo;
          changed = true;
        }
      }
      return changed;
    },
    dispose() {
      for (const { mesh } of meshes) mesh.dispose();
      geo.dispose();
    },
  };
}

/** Lamps on each lift's festoon, round its four faces. */
export const FESTOON_LAMPS = 16;

/** A scaffold that carries festoon lights: the lamps' places in its own frame, a string to a stage. */
export interface LitScaffold extends RecladScaffold {
  lamps: THREE.Vector3[];
}

/**
 * Work lights on a re-clad scaffold (Phase 3 Task 15): round each stage, a
 * festoon of FESTOON_LAMPS bulbs on a black rubber cable, clipped to the
 * outer ledger under the stage's top lift and sagging between the clips at
 * the corners, four bulbs to a face, each on a short drop, outside the
 * netting. The cable is drawn with the scaffold's tubes; the bulbs are left
 * to the caller, who draws every scaffold's in one instanced emitter. With
 * `deck` false (a floor with floors above it) the scaffold stops at its
 * slab rather than standing a working deck over it. Shown whole.
 */
export function makeLitScaffold(stages: ScaffoldStage[], deck = true): LitScaffold {
  const lamps: THREE.Vector3[] = [];
  const cable: Array<{ m: THREE.Matrix4; y: number }> = [];
  const perFace = FESTOON_LAMPS / 4;
  stages.forEach(({ halfX, halfZ, y0: base, y1 }, stage) => {
    const lifts = liftsOf(stages, stage, deck);
    const clip = base + lifts * LIFT - 0.18;
    for (let side = 0; side < 4; side++) {
      const rot = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
      const half = (side % 2 === 0 ? halfX : halfZ) + DEPTH;
      // Outside the netting (hung 0.22 m off the outer row), so the bulbs burn in the open.
      const out = (side % 2 === 0 ? halfZ : halfX) + DEPTH + 0.5;
      const p = (u: number, y: number): THREE.Vector3 => new THREE.Vector3(u, y, out).applyMatrix4(rot);
      // The cable's sag between its corner clips: a shallow parabola, deepest mid-face.
      const sag = Math.min(0.55, half * 0.05);
      const at = (t: number): THREE.Vector3 => p(-half + 2 * half * t, clip - sag * 4 * t * (1 - t));
      const steps = 12;
      for (let i = 0; i < steps; i++) cable.push({ m: bar(at(i / steps), at((i + 1) / steps), 0.022), y: base });
      for (let k = 0; k < perFace; k++) {
        const c = at((k + 0.5) / perFace);
        // A short drop from the cable to the lamp holder.
        cable.push({ m: bar(c, c.clone().add(new THREE.Vector3(0, -0.12, 0)), 0.03), y: base });
        lamps.push(c.clone().add(new THREE.Vector3(0, -0.2, 0)));
      }
    }
  });
  const s = makeRecladScaffold(stages, cable, deck);
  s.setHeight(Infinity);
  return { ...s, object: s.object, height: s.height, lamps };
}
