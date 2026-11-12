/**
 * The exterior lift ride up a tower (Task 35): a glass car on a guide rail
 * bolted up one face of a standing tower (following a lens tower's twist,
 * stepping out round a cantilever and off the root), or the crew's hoist car
 * on a tower under construction, with the camera riding nine metres out
 * from the facade, looking a little up. The plan (shared/ride.ts) says where
 * the car stops and what each stop says; this draws the car, moves it, holds
 * the camera to it and sets the captions at the lower left.
 *
 * Escape ends the ride and the view returns to where it was; a drag or a
 * scroll ends it where it stands, the camera in the user's hands. With
 * prefers-reduced-motion the ride cuts from stop to stop instead of
 * travelling, and nothing sways.
 */
import * as THREE from 'three';

import { RIDE, rideAt, rideLength, rideNextStop, rideSway, type RideCaption, type RideKey } from '../../../shared/ride.js';
import type { ScriptPose } from './camera';
import { Parts } from './construction.js';

/** One floor of a tower as the ride sees it, in the world: its plan centre, its height band, its half-width and its turn. The root has no id. */
export interface RideFloor {
  id: string | null;
  x: number;
  z: number;
  y0: number;
  h: number;
  half: number;
  ry: number;
}

/** What the ride needs of the city (scene.ts gives all of it). */
export interface RideHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rideTower(key: string): RideFloor[] | null;
  siteHoist(repo: string): { object: THREE.Object3D; height: number; setCar(y: number): void } | null;
  script(path: (dt: number) => ScriptPose | null, onRelease?: (why: 'user' | 'end') => void): void;
  unscript(): void;
  highlightFloor(repo: string, floorId: string | null): void;
  redrawShadows(): void;
  flyView(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Jumps the camera to an eye and a target (reduced motion's way back). */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  highlightLook(look: { color: THREE.Color; alpha: number } | null): void;
  /** What the view looks at now (the orbit's centre). */
  viewTarget(): THREE.Vector3;
}

export type RideEnd = 'end' | 'escape' | 'user';

export interface RideOptions {
  /** Where the captions are set (document.body). */
  parent: HTMLElement;
  /** prefers-reduced-motion: cut from stop to stop. */
  still?: boolean;
  /** Ride the crew's hoist on this repo's site rather than a glass car (the plan ends at the live work). */
  hoist?: string | null;
  /**
   * Phase 3's floor dossier: content for a floor the car waits at, set under
   * its caption while it waits. Asked once per stop; null leaves it empty.
   */
  dossier?(floorId: string): HTMLElement | null;
  /** Each floor as the car passes it (null over the root and the roof), with its number from the street. */
  onFloor?(floorId: string | null, n: number): void;
  /** Each stop as the car reaches it. */
  onStop?(key: RideKey, index: number): void;
  /** The ride is over: at its end or by Escape (the view has started back), or by a drag (the camera stays). */
  onEnd?(why: RideEnd): void;
}

export interface RideState {
  key: string;
  /** Seconds into the plan (negative while the camera comes to the car). */
  t: number;
  length: number;
  /** The car's floor and the eye, in metres over the street. */
  car: number;
  eye: number;
  /** The floor the ride is passing, or null. */
  floorId: string | null;
  /** The caption showing, as its title, or null. */
  caption: string | null;
  held: boolean;
  hoist: boolean;
  /** The plan's stops: when the car reaches each, and what it marks (captures). */
  stops: Array<{ t: number; dwell: number; mark: string | null; title: string | null }>;
}

export interface Ride {
  readonly key: string;
  state(): RideState;
  /** Holds the clock (captures and tests), or lets it run. */
  hold(on: boolean): void;
  /** Sets the clock (captures). */
  seek(t: number): void;
  /** Ends the ride: Escape's way, the view going back where it was. */
  stop(): void;
  /** On to the next stop at once, as Space and Right do. */
  next(): void;
}

/** The camera rides this far out from the facade... */
const CAMERA_OUT = 9;
/** ...this far to one side of the car, so the car and its rail read in depth... */
const CAMERA_SIDE = 4.2;
/** ...looking this far along the face past the car, so the face recedes beside it and the city opens beyond it... */
const LOOK_ALONG = -2.5;
/** ...this far over the eye in the car... */
const CAMERA_LIFT = -0.25;
/** ...looking up at this slope (rise over run). */
const LOOK_UP = 0.17;
/**
 * At the street the camera stands back along the face at a person's height,
 * the car at its landing and the street beyond it; it swings round to its
 * riding place over the first floors of the climb.
 */
const STREET = { along: 11, out: 6.5, eye: 1.7, lookAlong: -7, lookOut: 4.2, lookUp: 5.5, over: 14 };
/** Seconds the camera takes to come to the car. */
const APPROACH = 2.2;
/** The guide rails' centre off the face, and half the gap between the two rails. */
const RAIL_GAP = 0.42;
const RAIL_SPREAD = 0.62;
/** The car: width along the face, depth out from it, height. */
const CAR = { w: 2.1, d: 1.75, h: 2.75 };
/** How far a root's base stands past the top of the root (cornices, a plinth course). */
const ROOT_BASE = 1.4;
/** A step in the face is taken over at least this height. */
const STEP_RISE = 2.8;
/** Seconds a stop shows for when the ride cuts from stop to stop. */
const STILL_STOP = 2.6;
/** The orbit's sweep over the roof, in radians. */
const ORBIT_SWEEP = 0.8;

/** The ride's mark on a floor: the datum's bronze, under the bloom threshold. */
const MARK_BRONZE = new THREE.Color(0.86, 0.6, 0.34);

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Face {
  y0: number;
  y1: number;
  /** The face's outward normal and its distance from the tower's axis along it. */
  nx: number;
  nz: number;
  dist: number;
  id: string | null;
}

/** The rail up a tower, sampled every quarter metre: where it stands and which way the face it is bolted to looks. */
interface Rail {
  ax: number;
  az: number;
  top: number;
  faces: Face[];
  at(y: number): { x: number; z: number; nx: number; nz: number };
  /** The face behind the rail at a height (the floor's own, before any blend). */
  faceAt(y: number): Face;
}

function railFor(floors: RideFloor[], camera: THREE.Vector3, forced: { nx: number; nz: number } | null): Rail {
  const root = floors.find((f) => f.id === null) ?? floors[0];
  const ax = root.x;
  const az = root.z;
  // The face toward the eye, in the root's frame; the floors above turn it with them.
  let local = { x: 0, z: 1 };
  if (forced) {
    const c = Math.cos(-root.ry);
    const s = Math.sin(-root.ry);
    local = { x: forced.nx * c + forced.nz * s, z: -forced.nx * s + forced.nz * c };
  } else {
    const vx = camera.x - ax;
    const vz = camera.z - az;
    let best = -Infinity;
    for (const d of [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
    ]) {
      const c = Math.cos(root.ry);
      const s = Math.sin(root.ry);
      const wx = d.x * c + d.z * s;
      const wz = -d.x * s + d.z * c;
      const dot = wx * vx + wz * vz;
      if (dot > best) {
        best = dot;
        local = d;
      }
    }
  }
  const faces: Face[] = floors.map((f) => {
    const c = Math.cos(f.ry);
    const s = Math.sin(f.ry);
    // three.js turns +x toward -z for a positive turn about y.
    const nx = local.x * c + local.z * s;
    const nz = -local.x * s + local.z * c;
    const half = f.id === null ? f.half - 3 + ROOT_BASE : f.half;
    return { y0: f.y0, y1: f.y0 + f.h, nx, nz, dist: (f.x - ax) * nx + (f.z - az) * nz + half, id: f.id };
  });
  const top = faces[faces.length - 1].y1;
  const faceAt = (y: number): Face => {
    for (let i = faces.length - 1; i >= 0; i--) if (y >= faces[i].y0 - 1e-6) return faces[i];
    return faces[0];
  };
  // Each boundary between faces is blended over a rise: a step in is taken above the boundary, a step out below it,
  // so the rail never cuts into the wider face; a small turn (a lens) is blended across it.
  const STEP = 0.25;
  const n = Math.ceil((top + CAR.h + 2) / STEP) + 1;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  const nxs = new Float32Array(n);
  const nzs = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const y = k * STEP;
    const f = faceAt(y);
    let nx = f.nx;
    let nz = f.nz;
    let dist = f.dist;
    for (let i = 1; i < faces.length; i++) {
      const a = faces[i - 1];
      const b = faces[i];
      const step = b.dist - a.dist;
      const rise = Math.max(STEP_RISE, Math.abs(step) * 0.9);
      let from: number;
      let to: number;
      if (Math.abs(step) < 0.3) {
        from = b.y0 - 1.2;
        to = b.y0 + 1.2;
      } else if (step < 0) {
        from = b.y0;
        to = b.y0 + rise;
      } else {
        from = b.y0 - rise;
        to = b.y0;
      }
      if (y < from || y > to) continue;
      const w = smooth((y - from) / (to - from));
      nx = a.nx + (b.nx - a.nx) * w;
      nz = a.nz + (b.nz - a.nz) * w;
      dist = a.dist + (b.dist - a.dist) * w;
      break;
    }
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    xs[k] = ax + nx * (dist + RAIL_GAP);
    zs[k] = az + nz * (dist + RAIL_GAP);
    nxs[k] = nx;
    nzs[k] = nz;
  }
  return {
    ax,
    az,
    top,
    faces,
    faceAt,
    at(y) {
      const u = Math.min(n - 1.0001, Math.max(0, y / STEP));
      const k = Math.floor(u);
      const w = u - k;
      const nx = nxs[k] + (nxs[k + 1] - nxs[k]) * w;
      const nz = nzs[k] + (nzs[k + 1] - nzs[k]) * w;
      const l = Math.hypot(nx, nz) || 1;
      return { x: xs[k] + (xs[k + 1] - xs[k]) * w, z: zs[k] + (zs[k + 1] - zs[k]) * w, nx: nx / l, nz: nz / l };
    },
  };
}

// ---------------------------------------------------------------- the car and its rail

interface Rig {
  group: THREE.Group;
  car: THREE.Group;
  ropes: THREE.Mesh;
  /** Puts the car's floor at `y`, swaying by `roll` (radians) about its outward axis. */
  place(y: number, roll: number, bounce: number): void;
  dispose(): void;
}

/** The guide rails and their brackets up the face, the headframe and its sheave over the roof, and the glass car. */
function buildCar(rail: Rail): Rig {
  const group = new THREE.Group();
  group.name = 'ride';
  // Dark bronze paint on the rails and the car's frame, metallic enough to catch the sky along its edges.
  const paint = new THREE.MeshStandardMaterial({ color: 0x4a3e33, roughness: 0.36, metalness: 0.82 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa3a5a4, roughness: 0.28, metalness: 0.92 });
  // Laminated glass: a grey-green body, mostly clear, its reflection carrying the sky; a little of the car's own
  // light comes through it, so the car reads as a lit room at dusk.
  const glass = new THREE.MeshStandardMaterial({
    color: 0x55666a,
    roughness: 0.05,
    metalness: 0.35,
    transparent: true,
    opacity: 0.34,
    emissive: new THREE.Color(1.0, 0.78, 0.55),
    emissiveIntensity: 0.05,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // A honed limestone floor, lit by the ceiling panel over it.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x8b8073, roughness: 0.7, metalness: 0.02, emissive: new THREE.Color(1.0, 0.8, 0.6), emissiveIntensity: 0.16 });
  // The car's ceiling: a warm 3000 K panel, under the bloom threshold so it reads as a lit room, not a lamp.
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.58).multiplyScalar(0.92) });
  const rope = new THREE.MeshStandardMaterial({ color: 0x1b1c1d, roughness: 0.5, metalness: 0.8 });

  // ---------------------------------------------------------------- the rail
  const railTop = rail.top + CAR.h + 0.9;
  const rails = new Parts();
  const pts: THREE.Vector3[][] = [[], []];
  const lateral = (y: number, side: number): THREE.Vector3 => {
    const p = rail.at(y);
    return new THREE.Vector3(p.x - p.nz * side * RAIL_SPREAD, y, p.z + p.nx * side * RAIL_SPREAD);
  };
  // The rail's knots: every floor's boundary and every half metre where it bends.
  const knots = new Set<number>([0, railTop]);
  for (const f of rail.faces) knots.add(f.y0).add(f.y1);
  for (let y = 0; y < railTop; y += 0.5) {
    const a = rail.at(y);
    const b = rail.at(y + 0.5);
    if (Math.hypot(a.x - b.x, a.z - b.z) > 0.01 || Math.abs(a.nx - b.nx) + Math.abs(a.nz - b.nz) > 0.002) knots.add(y).add(y + 0.5);
  }
  const ys = [...knots].filter((y) => y >= 0 && y <= railTop).sort((a, b) => a - b);
  for (const side of [-1, 1]) for (const y of ys) pts[side < 0 ? 0 : 1].push(lateral(y, side));
  for (const line of pts) {
    for (let i = 1; i < line.length; i++) {
      // A T-section guide rail, drawn as a flat bar: 90 mm across its blade, 120 mm deep.
      rails.bar(line[i - 1], line[i], 0.09);
    }
  }
  // A bracket from the face to each rail at every floor line, and an anchor plate where it meets the face.
  for (const y of [...rail.faces.map((f) => f.y0 + 0.35), rail.top + 0.35]) {
    if (y > railTop) continue;
    const f = rail.faceAt(y);
    for (const side of [-1, 1]) {
      const r = lateral(y, side);
      const p = rail.at(y);
      const face = new THREE.Vector3(rail.ax + f.nx * f.dist - p.nz * side * RAIL_SPREAD, y, rail.az + f.nz * f.dist + p.nx * side * RAIL_SPREAD);
      if (face.distanceTo(r) < 0.05) continue;
      rails.bar(face, r, 0.07);
      rails.box(face.x, y, face.z, 0.32, 0.32, 0.03, Math.atan2(f.nx, f.nz));
    }
  }
  // The headframe over the roof: a crossbeam on the two rails and the rope sheave in it.
  const head = rail.at(railTop);
  const hl = lateral(railTop, -1);
  const hr = lateral(railTop, 1);
  rails.bar(hl, hr, 0.22);
  const sheaveAt = new THREE.Vector3(head.x + head.nx * (CAR.d * 0.5 + 0.3), railTop + 0.1, head.z + head.nz * (CAR.d * 0.5 + 0.3));
  // The machine head: a cantilevered beam off the crossbeam carrying the traction machine's housing over the car.
  const headTurn = Math.atan2(head.nx, head.nz);
  rails.bar(new THREE.Vector3(head.x, railTop, head.z), new THREE.Vector3(head.x + head.nx * (CAR.d + 0.5), railTop, head.z + head.nz * (CAR.d + 0.5)), 0.2);
  rails.box(sheaveAt.x, railTop + 0.36, sheaveAt.z, 0.95, 0.52, 0.8, headTurn);
  rails.box(sheaveAt.x, railTop + 0.64, sheaveAt.z, 1.05, 0.05, 0.9, headTurn);
  // The landing at the street: a steel sill the car comes to rest on.
  const base = rail.at(0);
  rails.box(base.x + base.nx * (CAR.d * 0.5 + 0.05), 0.04, base.z + base.nz * (CAR.d * 0.5 + 0.05), CAR.w + 0.6, 0.08, CAR.d + 0.4, Math.atan2(base.nx, base.nz));
  const railMesh = new THREE.Mesh(rails.build(), paint);
  railMesh.name = 'ride:rail';
  railMesh.castShadow = true;
  railMesh.receiveShadow = true;
  group.add(railMesh);

  // ---------------------------------------------------------------- the car (its own frame: x along the face, z out, y up; its floor at 0)
  const car = new THREE.Group();
  car.name = 'ride:car';
  const W = CAR.w;
  const D = CAR.d;
  const H = CAR.h;
  const frame = new Parts();
  const zb = -D / 2;
  const zf = D / 2;
  // Floor slab with its fascia, roof slab, four corner posts and the mullions.
  frame.box(0, -0.09, 0, W, 0.18, D);
  frame.box(0, H + 0.07, 0, W + 0.04, 0.14, D + 0.04);
  for (const [x, z] of [
    [-W / 2, zb],
    [W / 2, zb],
    [W / 2, zf],
    [-W / 2, zf],
  ]) {
    frame.box(x, H / 2, z, 0.08, H, 0.08);
  }
  frame.box(0, H / 2, zf, 0.05, H, 0.06);
  // A kick rail and a head rail round the glass.
  for (const y of [0.22, H - 0.12]) {
    frame.box(0, y, zf, W, 0.07, 0.06);
    frame.box(-W / 2, y, 0, 0.06, 0.07, D);
    frame.box(W / 2, y, 0, 0.06, 0.07, D);
  }
  // The sling: two uprights at the rails, the crosshead over the roof and the guide shoes on the rails.
  for (const s of [-1, 1]) {
    frame.box(s * RAIL_SPREAD, H / 2 + 0.2, zb - 0.12, 0.12, H + 0.8, 0.12);
    for (const y of [0.1, H + 0.4]) frame.box(s * RAIL_SPREAD, y, zb - 0.28, 0.2, 0.26, 0.2);
  }
  frame.box(0, H + 0.62, zb - 0.12, RAIL_SPREAD * 2 + 0.2, 0.22, 0.16);
  frame.box(0, H + 0.62, -0.1, 0.18, 0.18, D * 0.6);
  const frameMesh = new THREE.Mesh(frame.build(), paint);
  frameMesh.name = 'ride:car-frame';
  // The car casts no shadow: a moving caster would have the city's whole shadow map redrawn every frame.
  frameMesh.castShadow = false;
  frameMesh.receiveShadow = true;
  car.add(frameMesh);

  const panes = new Parts();
  panes.box(0, H / 2 + 0.11, zf, W - 0.1, H - 0.36, 0.02);
  panes.box(-W / 2, H / 2 + 0.11, 0, 0.02, H - 0.36, D - 0.1);
  panes.box(W / 2, H / 2 + 0.11, 0, 0.02, H - 0.36, D - 0.1);
  panes.box(0, H / 2 + 0.11, zb, W - 0.1, H - 0.36, 0.02);
  const paneMesh = new THREE.Mesh(panes.build(), glass);
  paneMesh.name = 'ride:car-glass';
  paneMesh.renderOrder = 2;
  car.add(paneMesh);

  const fittings = new Parts();
  // A brushed handrail round three sides at hip height, on stand-offs.
  fittings.box(0, 0.95, zf - 0.09, W - 0.3, 0.04, 0.04);
  for (const s of [-1, 1]) {
    fittings.box(s * (W / 2 - 0.09), 0.95, 0.05, 0.04, 0.04, D - 0.4);
    fittings.box(s * (W / 2 - 0.2), 0.95, zf - 0.05, 0.03, 0.03, 0.08);
  }
  const fitMesh = new THREE.Mesh(fittings.build(), steel);
  fitMesh.name = 'ride:car-rail';
  car.add(fitMesh);
  const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(W - 0.12, 0.02, D - 0.12), floorMat);
  floorMesh.position.y = 0.01;
  floorMesh.receiveShadow = true;
  car.add(floorMesh);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.5, D - 0.5), lamp);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H - 0.005;
  ceiling.name = 'ride:car-light';
  car.add(ceiling);
  group.add(car);

  // Two hoist ropes from the crosshead up to the sheave.
  const ropeGeo = new THREE.CylinderGeometry(0.019, 0.019, 1, 6, 1);
  ropeGeo.translate(0, 0.5, 0);
  const ropes = new THREE.Mesh(
    (() => {
      const p = new Parts();
      for (const s of [-1, 1]) p.add(ropeGeo, new THREE.Matrix4().makeTranslation(s * 0.07, 0, 0));
      return p.build();
    })(),
    rope,
  );
  ropes.name = 'ride:ropes';
  group.add(ropes);

  const q = new THREE.Quaternion();
  const roll = new THREE.Quaternion();
  const out = new THREE.Vector3();
  return {
    group,
    car,
    ropes,
    place(y, r, bounce) {
      const p = rail.at(y + 1);
      const heading = Math.atan2(p.nx, p.nz);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, heading);
      out.set(p.nx, 0, p.nz);
      roll.setFromAxisAngle(out, r);
      car.quaternion.copy(roll).multiply(q);
      // The car's back (the sling) runs on the rails; the car stands out from them.
      car.position.set(p.x + p.nx * (D / 2 + 0.4), y + bounce, p.z + p.nz * (D / 2 + 0.4));
      // The ropes run from the crosshead up to the sheave.
      const from = new THREE.Vector3(0, H + 0.73, -0.1).applyQuaternion(car.quaternion).add(car.position);
      const to = new THREE.Vector3(sheaveAt.x, railTop + 0.06, sheaveAt.z);
      const len = Math.max(0.1, to.y - from.y);
      ropes.position.copy(from);
      ropes.quaternion.copy(q);
      ropes.scale.set(1, len, 1);
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      ropeGeo.dispose();
      for (const m of [paint, steel, glass, floorMat, lamp, rope]) m.dispose();
      group.removeFromParent();
    },
  };
}

// ---------------------------------------------------------------- the captions

interface Captions {
  el: HTMLElement;
  show(c: RideCaption | null, key: number, floorId: string | null): void;
  floor(n: string, of: string): void;
  dispose(): void;
}

const MARK_WORDS: Record<NonNullable<RideCaption['mark']>, string> = {
  datum: '',
  scar: 'Failed inspection',
  claude: 'With Claude',
  live: 'At work now',
};

function captions(parent: HTMLElement, dossier: RideOptions['dossier'], act: { off(): void; next(): void }): Captions {
  const el = document.createElement('div');
  el.className = 'ride';
  const floor = document.createElement('p');
  floor.className = 'ride-floor';
  const n = document.createElement('span');
  n.className = 'ride-n';
  const of = document.createElement('span');
  of.className = 'ride-of';
  floor.append(n, of);
  const cap = document.createElement('div');
  cap.className = 'ride-caption';
  cap.setAttribute('role', 'status');
  cap.setAttribute('aria-live', 'polite');
  const mark = document.createElement('p');
  mark.className = 'ride-mark';
  const title = document.createElement('p');
  title.className = 'ride-title';
  const line = document.createElement('p');
  line.className = 'ride-line';
  const date = document.createElement('span');
  date.className = 'ride-date';
  const who = document.createElement('span');
  who.className = 'ride-who';
  line.append(date, who);
  const slot = document.createElement('div');
  slot.className = 'ride-dossier';
  cap.append(mark, title, line, slot);
  const keys = document.createElement('p');
  keys.className = 'ride-keys';
  // Tappable as well as keyed: a touch screen has no Escape.
  const keyed = (cls: string, kbd: string, word: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    const k = document.createElement('kbd');
    k.textContent = kbd;
    b.append(k, document.createTextNode(word));
    b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    return b;
  };
  keys.append(keyed('ride-off', 'Esc', 'Step off', 'Step off the ride', act.off), keyed('ride-next', 'Space', 'Next stop', 'Go on to the next stop', act.next));
  el.append(floor, cap, keys);
  parent.append(el);
  requestAnimationFrame(() => el.classList.add('on'));
  let shown = -2;
  return {
    el,
    show(c, key, floorId) {
      if (key === shown) return;
      shown = key;
      if (!c) {
        cap.classList.remove('on');
        return;
      }
      cap.dataset.mark = c.mark ?? '';
      mark.textContent = c.mark ? MARK_WORDS[c.mark] : '';
      mark.hidden = !mark.textContent;
      title.textContent = c.title;
      date.textContent = c.date;
      date.hidden = !c.date;
      who.textContent = c.who;
      who.hidden = !c.who;
      const extra = floorId && dossier ? dossier(floorId) : null;
      slot.replaceChildren(...(extra ? [extra] : []));
      slot.hidden = !extra;
      // Re-set so the change reads as a new line, not a flicker in place.
      cap.classList.remove('on');
      void cap.offsetWidth;
      cap.classList.add('on');
    },
    floor(a, b) {
      if (n.textContent !== a) n.textContent = a;
      if (of.textContent !== b) of.textContent = b;
    },
    dispose() {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 400);
    },
  };
}

// ---------------------------------------------------------------- the ride

/**
 * Rides up the tower `key` (a district's repo, or `agent:<id>`) by `plan`.
 * Null when the tower does not stand, or the hoist asked for is not up.
 */
export function startRide(city: RideHost, key: string, plan: RideKey[], opts: RideOptions): Ride | null {
  const floors = city.rideTower(key);
  if (!floors || floors.length === 0 || plan.length === 0) return null;
  const hoist = opts.hoist ? city.siteHoist(opts.hoist) : null;
  if (opts.hoist && !hoist) return null;
  const camera = city.camera;
  // Where the view stood: Escape and the ride's end glide back to it.
  const fromEye = camera.position.clone();
  const fromTarget = city.viewTarget();

  let rail: Rail;
  let rig: Rig | null = null;
  let hoistTop = Infinity;
  if (hoist) {
    // The hoist's mast stands on the tower's +x face: the ride rides that face, its rail the mast.
    hoist.object.updateWorldMatrix(true, false);
    const mast = hoist.object.getWorldPosition(new THREE.Vector3());
    const faces = railFor(floors, camera.position, { nx: 1, nz: 0 });
    const ax = faces.ax;
    const dist = mast.x - ax - 0.68;
    rail = {
      ...faces,
      at: () => ({ x: ax + dist + RAIL_GAP, z: mast.z, nx: 1, nz: 0 }),
      faceAt: (y) => ({ ...faces.faceAt(y), nx: 1, nz: 0, dist }),
    };
    hoistTop = hoist.height - 2.4;
  } else {
    rail = railFor(floors, camera.position, null);
    rig = buildCar(rail);
    city.scene.add(rig.group);
  }
  const numbered = floors.filter((f) => f.id !== null);
  const total = numbered.length;
  const length = rideLength(plan);
  const last = plan[plan.length - 1];
  const orbit = last.caption?.mark !== 'live';
  const still = !!opts.still;
  /** Reduced motion: the stops alone, each shown a while, cut from one to the next. */
  const stops = plan.map((k, i) => ({ k, i })).filter(({ k, i }) => k.dwell > 0 || i === 0 || i === plan.length - 1);
  const stillLength = stops.length * STILL_STOP;

  let t = still ? 0 : -APPROACH;
  let held = false;
  let ended = false;
  let floorNow: string | null | undefined;
  let markedNow: string | null = null;
  let stopNow = -1;
  const cap = captions(opts.parent, opts.dossier, { off: () => api.stop(), next: () => skip() });
  const eye = new THREE.Vector3();
  const target = new THREE.Vector3();
  let carY = 0;
  let eyeY: number = RIDE.eye;
  let captionTitle: string | null = null;

  /** The ride's pose at a time: the eye over the car, nine metres out, a little to the side, looking a little up. */
  function poseAt(time: number): { eye: THREE.Vector3; target: THREE.Vector3; car: number; eyeY: number; key: number; caption: RideCaption | null; captionKey: number; roll: number; bounce: number } {
    let y: number;
    let key: number;
    let caption: RideCaption | null;
    let captionKey: number;
    let localT = time;
    if (still) {
      const s = stops[Math.min(stops.length - 1, Math.max(0, Math.floor(time / STILL_STOP)))];
      y = s.k.y;
      key = s.i;
      caption = s.k.caption;
      captionKey = s.k.caption ? s.i : -1;
      localT = s.k.t + Math.min(s.k.dwell, time - Math.floor(time / STILL_STOP) * STILL_STOP);
    } else {
      const now = rideAt(plan, Math.max(0, time));
      y = now.y;
      key = now.key;
      caption = now.caption;
      captionKey = now.captionKey;
    }
    const sway = still ? { bounce: 0, roll: 0 } : rideSway(plan, Math.max(0, time));
    const car = Math.max(0, Math.min(y - RIDE.eye, rail.top, hoistTop));
    const p = rail.at(car + 1);
    const tx = -p.nz;
    const tz = p.nx;
    // The face behind the car.
    const fx = p.x - p.nx * RAIL_GAP;
    const fz = p.z - p.nz * RAIL_GAP;
    const e = new THREE.Vector3(fx + p.nx * CAMERA_OUT + tx * CAMERA_SIDE, y + CAMERA_LIFT, fz + p.nz * CAMERA_OUT + tz * CAMERA_SIDE);
    const g = new THREE.Vector3(fx + p.nx * 1.0 + tx * LOOK_ALONG, y + CAMERA_LIFT + CAMERA_OUT * LOOK_UP, fz + p.nz * 1.5 + tz * LOOK_ALONG);
    // At the street: stood back along the face, the car at its landing and the street beyond; swung round as it climbs.
    const w = 1 - smooth((car - 0.4) / STREET.over);
    if (w > 0) {
      const se = new THREE.Vector3(fx + p.nx * STREET.out + tx * STREET.along, STREET.eye, fz + p.nz * STREET.out + tz * STREET.along);
      const sg = new THREE.Vector3(fx + p.nx * STREET.lookOut + tx * STREET.lookAlong, STREET.lookUp, fz + p.nz * STREET.lookOut + tz * STREET.lookAlong);
      e.lerp(se, w);
      g.lerp(sg, w);
    }
    const lastStop = plan.length - 1;
    if (key === lastStop) {
      const u = Math.min(1, Math.max(0, (localT - last.t) / Math.max(1e-6, last.dwell)));
      if (orbit) {
        // Over the roof: the eye swings slowly round the tower and draws back, looking across the roof (or the crown).
        const sweep = still ? 0 : ORBIT_SWEEP * Math.sin((u * Math.PI) / 2);
        const ox = e.x - rail.ax;
        const oz = e.z - rail.az;
        const r0 = Math.hypot(ox, oz);
        const a0 = Math.atan2(oz, ox);
        const r = r0 + (still ? 10 : 14 * smooth(u));
        const a = a0 + sweep;
        const blend = still ? 1 : smooth(u * 3.2);
        const oe = new THREE.Vector3(rail.ax + Math.cos(a) * r, last.y + 3 + 5 * smooth(u), rail.az + Math.sin(a) * r);
        const og = new THREE.Vector3(rail.ax, last.y - 2.5, rail.az);
        e.lerp(oe, blend);
        g.lerp(og, blend);
      } else {
        // At the work: the eye draws back a little and looks up at the new floor going up on the roof.
        const blend = still ? 1 : smooth(u * 2.5);
        const ox = e.x - rail.ax;
        const oz = e.z - rail.az;
        const r = Math.hypot(ox, oz) || 1;
        e.x += (ox / r) * 9 * blend;
        e.z += (oz / r) * 9 * blend;
        e.y += 3 * blend;
        g.lerp(new THREE.Vector3(rail.ax, rail.top + 3.5, rail.az), blend);
      }
    }
    return { eye: e, target: g, car, eyeY: y, key, caption, captionKey, roll: sway.roll, bounce: sway.bounce };
  }

  const end = (why: RideEnd): void => {
    if (ended) return;
    ended = true;
    removeEventListener('keydown', onKey, true);
    city.highlightFloor(key, null);
    city.highlightLook(null);
    cap.dispose();
    rig?.dispose();
    city.redrawShadows();
    if (hoist) hoist.setCar(0);
    // With reduced motion the view cuts straight back; otherwise it glides.
    if (why !== 'user') {
      if (still) city.view(fromEye, fromTarget);
      else city.flyView(fromEye, fromTarget);
    }
    opts.onEnd?.(why);
  };

  /** Space or Right: on to the next stop at once. */
  const skip = (): void => {
    if (ended) return;
    if (still) {
      t = Math.min(stillLength - 1e-3, (Math.floor(Math.max(0, t) / STILL_STOP) + 1) * STILL_STOP);
      return;
    }
    const next = rideNextStop(plan, Math.max(0, t));
    if (next !== null) t = next;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (ended || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      city.unscript();
    } else if (e.key === ' ' || e.key === 'ArrowRight') {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tgt.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      skip();
    }
  };
  addEventListener('keydown', onKey, true);

  /** Why the script let go, as the ride ends: Escape and the end both unscript ('end'); a drag or a scroll is 'user'. */
  let reason: RideEnd = 'escape';
  let shadowAt = -Infinity;
  let shadowClock = Infinity;
  // The rail stands for the whole ride: the shadow map takes it once.
  city.redrawShadows();
  const step = (dt: number): ScriptPose | null => {
    if (ended) return null;
    if (!held) t += dt;
    const over = still ? t >= stillLength : t >= length;
    if (over) {
      reason = 'end';
      return null;
    }
    const pose = poseAt(t);
    carY = pose.car;
    eyeY = pose.eyeY;
    if (t < 0) {
      // Coming to the car: a glide from where the view stood.
      const k = easeInOut(1 + t / APPROACH);
      eye.lerpVectors(fromEye, pose.eye, k);
      target.lerpVectors(fromTarget, pose.target, k);
    } else {
      eye.copy(pose.eye);
      target.copy(pose.target);
    }
    if (rig) rig.place(carY, pose.roll, pose.bounce);
    else if (hoist) {
      hoist.setCar(carY + pose.bounce);
      // The hoist casts its shadow (it is the site's steel): the shadow map follows it in half metres, ten times a second at most.
      shadowClock += dt;
      if (Math.abs(carY - shadowAt) > 0.5 && shadowClock >= 0.1) {
        shadowAt = carY;
        shadowClock = 0;
        city.redrawShadows();
      }
    }
    // The floor the eye looks across, outlined as the inspector outlines a floor.
    const look = eyeY + CAMERA_LIFT + 1.2;
    const at = pose.key === plan.length - 1 && orbit && t > last.t ? null : (numbered.find((f) => look >= f.y0 && look < f.y0 + f.h) ?? null);
    const id = at?.id ?? null;
    if (id !== floorNow) {
      floorNow = id;
      opts.onFloor?.(id, at ? numbered.indexOf(at) + 1 : 0);
    }
    // The floor a caption speaks of is marked in bronze, fading in and out with its caption.
    const ck = pose.captionKey >= 0 ? plan[pose.captionKey] : null;
    const marked = ck?.floorId ?? null;
    if (marked !== markedNow) {
      markedNow = marked;
      city.highlightFloor(key, marked);
    }
    if (ck && marked) {
      const since = still ? 1 : (t - ck.t) / 0.45;
      const until = ck === last ? Infinity : ck.t + ck.dwell + RIDE.hold - t;
      city.highlightLook({ color: MARK_BRONZE, alpha: smooth(since) * smooth(until / 0.45) });
    }
    const n = at ? numbered.indexOf(at) + 1 : 0;
    cap.floor(at ? String(n) : eyeY > rail.top ? 'Roof' : 'Street', at ? `of ${total}` : total ? `${total} floors` : 'root only');
    const showKey = pose.captionKey;
    cap.show(pose.caption, showKey, showKey >= 0 ? plan[showKey].floorId : null);
    captionTitle = pose.caption?.title ?? null;
    if (pose.key !== stopNow && t >= 0) {
      stopNow = pose.key;
      opts.onStop?.(plan[pose.key], pose.key);
    }
    return { eye, target };
  };
  city.script(step, (why) => end(why === 'user' ? 'user' : reason));

  const api: Ride = {
    key,
    state: () => ({
      key,
      t,
      length: still ? stillLength : length,
      car: carY,
      eye: eyeY,
      floorId: floorNow ?? null,
      caption: captionTitle,
      held,
      hoist: !!hoist,
      stops: plan.filter((k) => k.dwell > 0).map((k) => ({ t: k.t, dwell: k.dwell, mark: k.caption?.mark ?? null, title: k.caption?.title ?? null })),
    }),
    hold(on) {
      held = on;
    },
    seek(at) {
      t = at;
    },
    stop() {
      if (ended) return;
      reason = 'escape';
      city.unscript();
    },
    next: skip,
  };
  return api;
}
