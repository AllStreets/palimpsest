/**
 * The agent personas as people in the city (Task 34). Each agent with a
 * trip (engine/market/trips.ts, read through /api/live) has one figure: a
 * 1.8 m articulated person in a coat of its firm's colour, walking its
 * trip's legs at the pace the legs say and riding the vehicles between
 * them (vehicles.ts: a cab summoned to the kerb, the next tram, train, pod
 * or ferry calling at its stop). The figure waits at the kerb or on the
 * platform until its vehicle stands there, steps in, sits in a cab, a train
 * or a ferry (stands holding on in a tram or a pod), and steps out at the
 * other end. A trip that ends while it is still on its way is finished on
 * foot; then the figure stands where it arrived until its next trip.
 *
 * The figures share the ambient crowd's rig and pose shader (ambient.ts),
 * so they sit in the same light as everyone else, with more of a person on
 * them: a face with eyes, brows, ears and a mouth, hands with fingers, coat
 * lapels and buttons, and a lantern carried in the right hand, lit after
 * dusk. Near (to 150 m) the full figure draws, far (to 440 m) the crowd's
 * box figure on the same rig, both in one instanced call each and
 * cross-faded by the screen-door dissolve; beyond 400 m the figure is only
 * its lantern, a warm point of light, so a trip reads from the overview.
 * A plate (name, where it is going) stands over the figure within 150 m.
 *
 * follow() gives the camera a pose to keep 12 m behind and above; it lets go
 * when the trip ends or the agent retires (camera.ts lets go on a drag or
 * Escape).
 */
import * as THREE from 'three';

import { inChannel, SPEED, streetLine, type Network } from '../../../shared/commute.js';
import type { Agent, Trip, TripMode } from '../../../shared/types.js';
import { asSkinned, B, bodyOf, Builder, dissolve, FIGURE_CODE, figureGeometry, figureShader, SHOULDER_IN, wornTriangles } from './ambient.js';
import type { Plate } from './labels.js';
import { LAYER, setLayers } from './lod.js';
import { LOD_EYE } from './lod-shader.js';
import { FOUNTAIN } from './exchange.js';
import { kerbOf, type Ride, type VehicleRef, type Vehicles } from './vehicles.js';

type V3 = [number, number, number];
type P = { x: number; z: number };

/** Eye distances: the modelled figure in full to 24 m and reduced to 150 m, the plain figure to 440 m, the lantern alone from 400 m. */
export const PEOPLE_LOD = { close: { near: 16, far: 24 }, near: { near: 110, far: 150 }, out: { near: 380, far: 440 }, plate: 150 } as const;
/** The lantern lights between these hours (the city is lit for dusk; the lantern says the hour on the figure). */
const DUSK = { from: 16.5, to: 7.5 } as const;
/** Where the hips sit above a seat, and how far down the figure drops into it; a cab's bench is low under its 1 m roof. */
const SEAT = 0.45;
const CAB_SEAT = 0.14;
/** The leg's length in the rig (hip to ankle), the stride's half angle at a walk. */
const LEG = 0.86;
const STRIDE = 0.42;
/** Seconds to step into a cab (within its pickup stand), out of it, and onto or off a line's vehicle. */
const BOARD_S = { cab: 3.4, line: 1.8 } as const;
/** How many figures the buffers hold at first; they grow when the roster outgrows them. */
const CAP = 48;

/**
 * The walk cycle's phase rate for a speed: one cycle is two steps of
 * 2 L sin(A) each (a figure `k` times the rig's height steps that much
 * further), so the feet are planted as far as the body moves and do not
 * slide.
 */
export function strideRate(speed: number, A: number = STRIDE, k = 1): number {
  const step = 2 * LEG * k * Math.sin(A);
  return (Math.PI * speed) / step;
}

export type FigureStage = 'walk' | 'wait' | 'board' | 'ride' | 'alight' | 'idle';

export interface FigureView {
  agentId: string;
  name: string;
  tripId: string | null;
  /** Whether its trip is still among the live ones (a figure finishes an ended trip on foot). */
  live: boolean;
  leg: number;
  mode: TripMode | null;
  stage: FigureStage;
  position: V3;
  heading: number;
  walking: number;
  sit: number;
  /** The lantern's light, 0 (dark) to 1 (lit for dusk). */
  lit: number;
  /** The vehicle it waits for or rides, or null on foot. */
  ride: { mode: TripMode; id: string; phase: string } | null;
}

export interface PeopleView {
  figures: number;
  /** Figures drawn at the close level, the near level, the far level and as lanterns (one in a dissolve band counts in both). */
  close: number;
  near: number;
  far: number;
  lanterns: number;
  /** Draw calls of the main pass and the triangles they draw. */
  meshes: number;
  triangles: number;
  following: string | null;
  time: number;
}

export interface PeopleDeps {
  /** The vehicles to board (null before the network is laid, or in a test of the walking alone). */
  vehicles(): Vehicles | null;
  /** The network as laid (kerbOf needs it), or null. */
  net(): Network | null;
  /** The street lamp lighting a point most (ambient.ts), for the figures' sodium light. */
  lampLight?(x: number, y: number, z: number, out: [number, number, number, number]): void;
  /** The clock trips are measured against (tests pin it). */
  now?(): number;
  /** The local hour, 0 to 24 (the lantern lights for dusk). */
  hour?(): number;
  /** The coat for an agent, linear RGB: its firm's colour (main.ts); left out, a muted wool from the id. */
  coatOf?(agent: Agent): [number, number, number];
  /** The plate's second line for a trip: "to <district> for <job title>". */
  describe?(trip: Trip, agent: Agent): string;
  /** Clicking a figure's plate. */
  onActivate?(agentId: string): void;
  /** The follow let go of itself: its trip ended or its agent retired. */
  onRelease?(): void;
}

export interface People {
  group: THREE.Group;
  /** The live trips and the agents they belong to, as last read: a figure per agent on its way or arrived this session. */
  set(trips: ReadonlyArray<Trip>, agents: ReadonlyArray<Agent>): void;
  /** Moves everyone on by dt seconds and, with a camera, lays each figure into its level from the eye. */
  update(dt: number, camera?: THREE.PerspectiveCamera): void;
  /** Follows an agent's figure (null, or an agent with no figure, lets go). */
  follow(agentId: string | null): void;
  following(): string | null;
  /** Where the followed figure stands and faces now, for the camera; null when nothing is followed. */
  followPose(): { position: THREE.Vector3; heading: number } | null;
  positionOf(agentId: string): THREE.Vector3 | null;
  /** The vehicle an agent's figure waits for or rides, or null on foot. */
  rideOf(agentId: string): { mode: TripMode; id: string; phase: string } | null;
  figures(): FigureView[];
  /** The plates over the figures within reach of the eye, as laid this frame (scene.ts shows them). */
  plates(): Plate[];
  /** Counts up each time plates() would answer differently. */
  platesVersion(): number;
  view(camera: THREE.Camera): PeopleView;
  /** Holds the lantern lit or dark for a capture, or follows the hour again with null. */
  lantern(on: boolean | null): void;
  setQuality(q: 'high' | 'medium'): void;
  /** Holds the clock (captures); skip moves it on in steps, held or not. */
  hold(on: boolean): void;
  skip(seconds: number): void;
  dispose(): void;
}

interface Look {
  skin: number;
  hair: number;
  height: number;
  build: number;
  coatLen: number;
  hat: number;
  coat: [number, number, number];
  legs: [number, number, number];
  /** The body's shape, hair, hat and scarf (ambient.ts bodyOf): aBody. */
  body: [number, number, number, number];
}

interface Figure {
  agent: Agent;
  look: Look;
  trip: Trip | null;
  live: boolean;
  leg: number;
  /** Metres along a walk leg (or a ride walked for want of a vehicle). */
  s: number;
  stage: FigureStage;
  /** 0 to 1 through a board or alight. */
  k: number;
  ride: VehicleRef | Ride | null;
  /** The clock time before which no vehicle is asked for again after one could not be had, and whether that was logged. */
  retryAt: number;
  warned: boolean;
  /** Where a board or alight started, the door it goes by, and where it ends. */
  from: V3;
  via: V3;
  to: V3;
  /** The leg's path as walked (a walk leg's on the pavement). */
  path: ReadonlyArray<V3>;
  /** Where it waits for its vehicle, and which way it faces there. */
  spot: V3;
  spotHeading: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  phase: number;
  walking: number;
  sit: number;
  hold: number;
  /** Seated lean-back, 0 to 1 (a cab's low bench). */
  lean: number;
  lamp: [number, number, number, number];
  seen: boolean;
  /** Eye distance at the last draw. */
  d: number;
}

const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** A point `fwd` ahead and `right` to the right of p facing h (x forward is cos h, sin h). */
const around = (p: ArrayLike<number>, h: number, fwd: number, right: number, y: number): V3 => [p[0] + Math.cos(h) * fwd - Math.sin(h) * right, y, p[2] + Math.sin(h) * fwd + Math.cos(h) * right];
const turnTo = (from: number, to: number, k: number): number => {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
};

function hashOf(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** The length of a leg's path in plan, and the point and heading `s` metres along it. */
function pathLength(path: ReadonlyArray<V3>): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]);
  return len;
}
function along(path: ReadonlyArray<V3>, s: number, out: { p: V3; h: number }): void {
  if (path.length === 1) {
    out.p = [...path[0]];
    return;
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (s <= len || i === path.length - 1) {
      const t = len ? clamp(s / len, 0, 1) : 1;
      out.p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (len > 1e-6) out.h = Math.atan2(b[2] - a[2], b[0] - a[0]);
      return;
    }
    s -= len;
  }
}

/** Where a walker stands at a point on the ground: the road bridges' decks are a little proud of the streets (vehicles.ts roadY). */
const groundY = (x: number): number => (inChannel(x, 2) ? 0.08 : 0);

/** How far right of a street's centre line a walker keeps: the middle of the pavement (ambient.ts PAVE). */
const PAVEMENT = 6.0;

/**
 * Where a figure stands for a trip's end: the point itself, unless it lies
 * in the exchange's fountain (the engine's exchange point is the forecourt's
 * centre, which the basin fills): then on the paving just off the basin's
 * rim, on the side the point leans to (the hall's side for the centre).
 */
function standPoint(p: V3): V3 {
  const dx = p[0] - FOUNTAIN.x;
  const dz = p[2] - FOUNTAIN.z;
  const d = Math.hypot(dx, dz);
  const keep = FOUNTAIN.radius + 1.8;
  if (d >= keep) return p;
  const ux = d > 1e-6 ? dx / d : 0;
  const uz = d > 1e-6 ? dz / d : -1;
  return [FOUNTAIN.x + ux * keep, p[1], FOUNTAIN.z + uz * keep];
}

/**
 * A walk leg's path moved onto the pavement: the router's streetWay runs
 * along the streets' centre lines, so each point steps to the right of the
 * way it goes (right-hand walking, as the crowd keeps), and the ground's
 * height is read under it.
 */
function pavementPath(path: ReadonlyArray<V3>): V3[] {
  if (path.length < 2) return path.map((p) => [p[0], Math.max(p[1], groundY(p[0])), p[2]] as V3);
  return path.map((p0, i) => {
    const p = i === 0 || i === path.length - 1 ? standPoint(p0) : p0;
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    // The right normal of the way through this point (the mean of the segments either side).
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // At a corner the point steps out along the bisector far enough to lie PAVEMENT off both streets (root 2 at a
    // right angle), never less, so the walker rounds the junction's kerb on the paving rather than cutting it.
    const k = i > 0 && i < path.length - 1 ? clamp(1 / Math.max(Math.abs(dx), Math.abs(dz), 1e-3), 1, 1.5) : 1;
    const x = p[0] - dz * PAVEMENT * k;
    const z = p[2] + dx * PAVEMENT * k;
    return [x, Math.max(p[1], groundY(x)), z] as V3;
  });
}

/**
 * Where a rider waits for its cab: a step back from the kerb the cab pulls
 * in at, on the pavement side (away from the street's centre line).
 */
function kerbSpot(start: V3, net: Network | null): { spot: V3; heading: number } {
  const k = net ? kerbOf({ x: start[0], z: start[2] }, net) : { x: start[0], z: start[2] };
  const dx = k.x - streetLine(k.x);
  const dz = k.z - streetLine(k.z);
  // The kerb lies 6.4 m off one street's centre line: step out along that axis.
  const out = Math.abs(Math.abs(dx) - 6.4) < Math.abs(Math.abs(dz) - 6.4) ? { x: Math.sign(dx) || 1, z: 0 } : { x: 0, z: Math.sign(dz) || 1 };
  // Clear of the cab's body however it comes in to the kerb point: 2.3 m onto the pavement and 1.5 m along the
  // street, so it stands beside the cab's doors rather than at its nose or tail.
  const spot: V3 = [k.x + out.x * 2.3 + out.z * 1.5, groundY(k.x), k.z + out.z * 2.3 + out.x * 1.5];
  // Facing the road.
  return { spot, heading: Math.atan2(-out.z, -out.x) };
}

/**
 * Each line's platform, measured from the line's centre (the ride legs run
 * along it; the right-hand track lies 2 m to the right): how far out a
 * rider stands on it, and how high it is over the leg's height (transit.ts:
 * the tram's raised kerb platform, the rail's and the pods' at floor height,
 * the ferry's pier at quay level).
 */
const PLATFORM: Record<Exclude<TripMode, 'walk' | 'cab'>, { out: number; up: number | 'quay' }> = {
  tram: { out: 4.1, up: 0.25 },
  rail: { out: 4.9, up: 0.95 },
  pod: { out: 3.4, up: 0.35 },
  ferry: { out: 0, up: 'quay' },
};

/** Where a rider waits on a line's platform: beside the leg's first point, to the right of the way it runs. */
function platformSpot(path: ReadonlyArray<V3>, mode: TripMode): { spot: V3; heading: number } {
  const a = path[0];
  const b = path[Math.min(1, path.length - 1)];
  const h = path.length > 1 ? Math.atan2(b[2] - a[2], b[0] - a[0]) : 0;
  const p = PLATFORM[mode as keyof typeof PLATFORM] ?? { out: 2.2, up: 0 };
  // A little up the platform from the stop's centre, clear of the tram shelter's screen (transit.ts), by the edge.
  return { spot: around(a, h, mode === 'tram' ? 5.5 : 0, p.out, p.up === 'quay' ? 0 : a[1] + p.up), heading: h };
}

/** The door a rider steps in and out by: a cab's rear right door at the kerb, a car's right-hand doorway at its floor. */
function doorOf(ref: VehicleRef, mode: TripMode): V3 {
  const p = ref.position();
  const h = ref.heading();
  if (mode === 'cab') return around(p, h, -0.35, 1.45, p[1]);
  return around(p, h, 0, 1.3, ref.floorY());
}

/** Where a rider is aboard its vehicle: a cab's rear right seat, a seat or a standing place in a car, the ferry's deck. */
function aboard(ref: VehicleRef, mode: TripMode): V3 {
  const p = ref.position();
  const h = ref.heading();
  if (mode === 'cab') return around(p, h, -0.45, 0.38, ref.floorY() + CAB_SEAT);
  if (mode === 'ferry') return around(p, h, 0.5, 1.2, ref.floorY() + SEAT);
  if (mode === 'rail') return around(p, h, 0, 0.6, ref.floorY() + SEAT);
  return around(p, h, 0, 0.55, ref.floorY());
}

const SITS: ReadonlySet<TripMode> = new Set(['cab', 'rail', 'ferry']);
const HOLDS: ReadonlySet<TripMode> = new Set(['tram', 'pod']);

// ---------------------------------------------------------------- the model

/**
 * A persona's figure at a level: the crowd's modelled figure (figures.glb,
 * ambient.ts figureGeometry), with a lantern hung from the right hand on a
 * bail: a brass cap and base, four corner posts, the glass between.
 */
function personaModel(level: 'hi' | 'lo'): THREE.BufferGeometry {
  const base = figureGeometry(level);
  const b = new Builder();
  const rig = (bone: number, code: number): number[] => [bone, 1, code];
  const lz = 0.215;
  const lx = 0.024;
  const brass = rig(B.foreR, FIGURE_CODE.brass);
  b.tube([lx, 0.81, lz], [lx, 0.715, lz], 0.0045, 0.0045, 6, brass);
  b.box([lx, 0.708, lz], [0.07, 0.014, 0.07], brass);
  b.box([lx, 0.566, lz], [0.078, 0.014, 0.078], brass);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box([lx + sx * 0.03, 0.637, lz + sz * 0.03], [0.007, 0.13, 0.007], brass);
  b.box([lx, 0.637, lz], [0.052, 0.124, 0.052], rig(B.foreR, FIGURE_CODE.glass));
  return merged(base, asSkinned(b));
}

/** Two figure geometries as one indexed geometry (the lantern on the figure). */
function merged(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const na = a.attributes.position.count;
  const nb = b.attributes.position.count;
  for (const [k, size] of [['position', 3], ['normal', 3], ['aSkin', 4], ['aSurf', 4]] as const) {
    const out = new Float32Array((na + nb) * size);
    const from = (src: THREE.BufferGeometry, at: number): void => {
      const s = src.attributes[k];
      for (let i = 0; i < s.count; i++) for (let c = 0; c < size; c++) out[(at + i) * size + c] = s.getComponent(i, c);
    };
    from(a, 0);
    from(b, na);
    g.setAttribute(k, new THREE.BufferAttribute(out, size));
  }
  const ia = a.index ? Array.from(a.index.array as ArrayLike<number>) : Array.from({ length: na }, (_, i) => i);
  const ib = Array.from({ length: nb }, (_, i) => na + i);
  g.setIndex(new THREE.BufferAttribute(new Uint32Array([...ia, ...ib]), 1));
  g.computeBoundingSphere();
  a.dispose();
  b.dispose();
  return g;
}

// ---------------------------------------------------------------- the material

/** The persona's pose: the crowd's walk and stand, and over them sitting (aPose.x) and holding a strap (aPose.z). */
const PERSONA_RIG = /* glsl */ `
  attribute vec4 aPose;
  varying vec3 vEmit;
  Rig figureRig() {
    float w = aAnim.y;
    float ph = aAnim.x;
    float A = aAnim.z;
    float sit = aPose.x;
    float hold = aPose.z;
    float lean = aPose.w;
    float s = sin(ph);
    float hipL = A * s;
    float hipR = -A * s;
    float fold = 0.8 * clamp(A / 0.48, 0.35, 1.0);
    float kneeL = 0.07 + fold * pow(max(0.0, cos(ph + 0.45)), 1.6) + 0.1 * max(0.0, -sin(ph + 0.3));
    float kneeR = 0.07 + fold * pow(max(0.0, -cos(ph + 0.45)), 1.6) + 0.1 * max(0.0, sin(ph + 0.3));
    // The left arm swings; the right, with the lantern, hangs a little forward and swings less.
    float armL = -A * 0.8 * s - 0.04;
    float armR = A * 0.3 * s + 0.16;
    float elbL = 0.22 + 0.26 * max(0.0, -s);
    float elbR = 0.3;
    float idle = 1.0 - w;
    float slow = sin(ph * 0.5);
    Rig R;
    R.hipL = mix(0.035 * slow, hipL, w);
    R.hipR = mix(-0.02 - 0.03 * slow, hipR, w);
    R.kneeL = mix(0.04, kneeL, w);
    R.kneeR = mix(0.12 + 0.06 * max(0.0, slow), kneeR, w);
    R.armL = mix(0.05, armL, w);
    R.armR = mix(0.16, armR, w);
    R.elbL = mix(0.12, elbL, w);
    R.elbR = mix(0.3, elbR, w);
    // Holding a strap: the left arm raised to it.
    R.armL = mix(R.armL, 1.75, hold);
    R.elbL = mix(R.elbL, 0.5, hold);
    // Sitting: hips and knees at right angles, the forearms resting on the thighs.
    R.hipL = mix(R.hipL, 1.5, sit);
    R.hipR = mix(R.hipR, 1.5, sit);
    R.kneeL = mix(R.kneeL, 1.5, sit);
    R.kneeR = mix(R.kneeR, 1.5, sit);
    R.armL = mix(R.armL, 0.45, sit);
    R.armR = mix(R.armR, 0.45, sit);
    R.elbL = mix(R.elbL, 1.0, sit);
    R.elbR = mix(R.elbR, 1.0, sit);
    R.outL = 0.06 + 0.04 * w;
    R.outR = -0.06 - 0.04 * w;
    float look = idle * (1.0 - sit) * 0.38 * sin(ph * 0.31 + aLook.y * 6.0);
    R.head = rotY(look - 0.06 * s * w) * rotZ(-0.04 * w);
    // Seated: the upper body leans back into the seat (more in a cab's low bench).
    R.torso = rotY(0.07 * s * w) * rotZ(-0.055 * w - 0.06 * sit - 0.3 * lean);
    R.shift = ${SHOULDER_IN} * aBody.x;
    R.drop = w * ${LEG.toFixed(2)} * (1.0 - cos(A * s)) + idle * 0.006 * (1.0 + slow) + 0.84 * sit;
    R.sway = w * 0.022 * s + idle * 0.012 * slow;
    return R;
  }`;

/** The persona's own surfaces over the crowd's: brass buttons and lantern, the lantern's glass lit for dusk. */
const PERSONA_SURFACE = /* glsl */ `
  vEmit = vec3(0.0);
  if (code == 5 || code == 14) { vAlb = vec3(0.42, 0.3, 0.14); vRough = 0.38; vMetal = 0.9; }
  else if (code == 6) { vAlb = vec3(0.3, 0.25, 0.17); vRough = 0.2; vEmit = vec3(1.0, 0.58, 0.24) * 1.3 * aPose.y; }`;

/** The figures' material at a level: the persona pose and surfaces on the crowd's figure shader. */
function personaMaterial(level: 'hi' | 'lo' | 'far'): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
  m.name = `people-${level}`;
  m.onBeforeCompile = (sh) => {
    if (level === 'hi') dissolve(sh, PEOPLE_LOD.close, 'near');
    else if (level === 'lo') dissolve(sh, PEOPLE_LOD.close, 'far', PEOPLE_LOD.near);
    else dissolve(sh, PEOPLE_LOD.near, 'far', PEOPLE_LOD.out);
    figureShader(sh, PERSONA_RIG, PERSONA_SURFACE, 'varying vec3 vEmit;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;');
  };
  m.customProgramCacheKey = () => `palimpsest-people-${level}`;
  return m;
}

/** The lanterns far off: a warm point a few pixels across at each figure past 400 m, dimmed less by the haze than a lit surface. */
function lanternMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uLodEye: LOD_EYE, uSize: { value: 4 } },
    vertexShader: /* glsl */ `
      uniform vec3 uLodEye;
      uniform float uSize;
      varying float vIn;
      void main() {
        float d = distance(position, uLodEye);
        vIn = smoothstep(${PEOPLE_LOD.out.near.toFixed(1)}, ${PEOPLE_LOD.out.far.toFixed(1)}, d);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (1.0 + 0.6 * smoothstep(1200.0, 3000.0, d));
        if (vIn <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vIn;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float r = length(q) * 2.0;
        float a = smoothstep(1.0, 0.25, r);
        gl_FragColor = vec4(vec3(1.0, 0.64, 0.3) * 1.6 * a * vIn, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------- the people

export function createPeople(deps: PeopleDeps): People {
  const now = deps.now ?? (() => Date.now());
  const hour = deps.hour ?? (() => new Date().getHours() + new Date().getMinutes() / 60);
  const group = new THREE.Group();
  group.name = 'people';
  const figures = new Map<string, Figure>();
  let time = 0;
  let held = false;
  let followed: string | null = null;
  let lanternHeld: boolean | null = null;
  let disposed = false;
  let version = 0;
  let platesNow: Plate[] = [];
  const lastStats = { close: 0, near: 0, far: 0, lanterns: 0 };

  // ---- the drawing
  const closeMat = personaMaterial('hi');
  const nearMat = personaMaterial('lo');
  const farMat = personaMaterial('far');
  const lanternMat = lanternMaterial();
  const closeGeo = personaModel('hi');
  const nearGeo = personaModel('lo');
  const farGeo = figureGeometry('far');
  const closeTris = wornTriangles(closeGeo);
  const nearTris = wornTriangles(nearGeo);
  const farTris = wornTriangles(farGeo);
  const ATTRS = { aAnim: 4, aLook: 4, aCoat: 3, aLegs: 3, aLampL: 4, aPose: 4, aBody: 4 };
  interface Drawn {
    mesh: THREE.InstancedMesh;
    a: Record<string, THREE.InstancedBufferAttribute>;
    n: number;
  }
  let cap = CAP;
  let close!: Drawn;
  let near!: Drawn;
  let far!: Drawn;
  let lanterns!: THREE.Points;
  let lanternPos!: THREE.BufferAttribute;
  function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): Drawn {
    const a: Record<string, THREE.InstancedBufferAttribute> = {};
    for (const [k, n] of Object.entries(ATTRS)) {
      const at = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(k, at);
      a[k] = at;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    setLayers(mesh, LAYER.view);
    group.add(mesh);
    return { mesh, a, n: 0 };
  }
  function size(): void {
    if (near) {
      group.remove(close.mesh, near.mesh, far.mesh, lanterns);
      close.mesh.dispose();
      near.mesh.dispose();
      far.mesh.dispose();
      lanterns.geometry.dispose();
    }
    close = instanced(closeGeo, closeMat, 'people:close');
    near = instanced(nearGeo, nearMat, 'people:near');
    far = instanced(farGeo, farMat, 'people:far');
    const g = new THREE.BufferGeometry();
    lanternPos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    lanternPos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', lanternPos);
    lanterns = new THREE.Points(g, lanternMat);
    lanterns.name = 'people:lanterns';
    lanterns.frustumCulled = false;
    lanterns.visible = false;
    setLayers(lanterns, LAYER.view);
    group.add(lanterns);
  }
  size();

  // ---- the figures
  function lookOf(agent: Agent): Look {
    const r = hashOf(agent.id);
    const coat = deps.coatOf?.(agent) ?? ([0.08 + 0.1 * r(), 0.07 + 0.06 * r(), 0.06 + 0.05 * r()] as [number, number, number]);
    const g = 0.03 + 0.07 * r();
    const look: Look = {
      skin: r(),
      hair: r(),
      height: 1.64 + 0.24 * r(),
      build: 0.92 + 0.18 * r(),
      coatLen: 0.35 + 0.65 * r(),
      hat: r() < 0.15 ? 1 : 0,
      coat,
      legs: [g, g * (0.95 + 0.1 * r()), g * (0.9 + 0.1 * r())],
      body: [0, 2, 0, 0],
    };
    look.body = bodyOf(Math.floor(r() * 1e6), look.hat);
    return look;
  }

  function newFigure(agent: Agent): Figure {
    return {
      agent,
      look: lookOf(agent),
      trip: null,
      live: false,
      leg: 0,
      s: 0,
      stage: 'idle',
      k: 0,
      ride: null,
      retryAt: 0,
      warned: false,
      from: [0, 0, 0],
      via: [0, 0, 0],
      to: [0, 0, 0],
      path: [],
      spot: [0, 0, 0],
      spotHeading: 0,
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      phase: 0,
      walking: 0,
      sit: 0,
      hold: 0,
      lean: 0,
      lamp: [0, 1, 0, 0],
      seen: false,
      d: Infinity,
    };
  }

  /** Puts a figure on a trip: at the point its elapsed time says, legs by their nominal times (a ride waits for its real vehicle). */
  function startTrip(f: Figure, trip: Trip): void {
    f.trip = trip;
    f.live = true;
    f.ride = null;
    f.leg = 0;
    f.s = 0;
    f.k = 0;
    let elapsed = Math.max(0, (now() - Date.parse(trip.startedAt)) / 1000);
    for (let i = 0; i < trip.legs.length; i++) {
      const leg = trip.legs[i];
      const secs = leg.ms / 1000;
      if (leg.mode !== 'walk' || elapsed < secs) {
        f.leg = i;
        if (leg.mode === 'walk') f.s = (pathLength(leg.path) * elapsed) / Math.max(1e-3, secs);
        enterLeg(f);
        return;
      }
      elapsed -= secs;
    }
    f.leg = trip.legs.length;
    arrive(f);
  }

  function arrive(f: Figure): void {
    const t = f.trip;
    f.stage = 'idle';
    f.ride = null;
    if (t) {
      [f.x, , f.z] = standPoint([t.to.x, 0, t.to.z]);
      f.y = groundY(f.x);
    }
  }

  /** Sets a figure up for the leg it is on: walking, or waiting where its vehicle will call. */
  function enterLeg(f: Figure): void {
    const trip = f.trip!;
    if (f.leg >= trip.legs.length) return arrive(f);
    const leg = trip.legs[f.leg];
    f.ride = null;
    f.k = 0;
    f.path = leg.mode === 'walk' ? pavementPath(leg.path) : leg.path;
    if (leg.mode === 'walk') {
      f.stage = 'walk';
      const at = { p: [0, 0, 0] as V3, h: f.heading };
      along(f.path, f.s, at);
      [f.x, f.y, f.z] = at.p;
      f.heading = at.h;
      return;
    }
    const w = leg.mode === 'cab' ? kerbSpot(leg.path[0], deps.net()) : platformSpot(leg.path, leg.mode);
    f.spot = w.spot;
    f.spotHeading = w.heading;
    f.stage = 'wait';
    f.s = 0;
    [f.x, f.y, f.z] = w.spot;
    f.heading = w.heading;
  }

  function nextLeg(f: Figure): void {
    f.leg++;
    f.s = 0;
    enterLeg(f);
  }

  /** Seconds before a figure asks for a vehicle again after none could be had. */
  const RETRY_S = 5;
  /**
   * The vehicle for a ride leg, found again when the old one was retired by
   * a relay; null walks the leg's path instead. A leg no vehicle can serve
   * (board() answers null, or summonCab() throws) is asked about again
   * after RETRY_S, and logged once per figure rather than every frame.
   */
  function vehicleFor(f: Figure, leg: number, mode: TripMode): VehicleRef | Ride | null {
    if (f.ride && !f.ride.retired()) return f.ride;
    const v = deps.vehicles();
    if (!v || !f.trip) return null;
    if (time < f.retryAt) return null;
    try {
      f.ride = mode === 'cab' ? v.summonCab(f.trip, leg) : v.board(f.trip, leg);
    } catch (err) {
      f.ride = null;
      if (!f.warned) console.warn(`people: no ${mode} for ${f.agent.name}'s leg ${leg}`, err);
      f.warned = true;
    }
    if (!f.ride) f.retryAt = time + RETRY_S;
    return f.ride;
  }

  function stepFigure(f: Figure, dt: number): void {
    const trip = f.trip;
    const k = f.look.height / 1.75;
    if (!trip || f.leg >= trip.legs.length) {
      f.walking = Math.max(0, f.walking - dt * 3);
      f.sit = Math.max(0, f.sit - dt * 2);
      f.hold = 0;
      f.lean = 0;
      f.phase += dt * 1.6;
      return;
    }
    const leg = trip.legs[f.leg];
    const len = pathLength(f.path);
    const walkOn = (speed: number): void => {
      f.s += speed * dt;
      const at = { p: [f.x, f.y, f.z] as V3, h: f.heading };
      along(f.path, f.s, at);
      [f.x, f.y, f.z] = at.p;
      f.heading = turnTo(f.heading, at.h, Math.min(1, dt * 8));
      f.walking = Math.min(1, f.walking + dt * 3);
      f.phase += strideRate(speed, STRIDE, k) * dt;
      if (f.s >= len) nextLeg(f);
    };
    if (leg.mode === 'walk') {
      // At the leg's own pace (its length over its time, 1.4 m/s), measured on the street line it was routed on.
      walkOn(Math.max(0.5, pathLength(leg.path) / Math.max(1e-3, leg.ms / 1000)));
      return;
    }
    const ref = vehicleFor(f, f.leg, leg.mode);
    if (!ref) {
      // No vehicle to board (before the network is laid): the leg is walked along its own path at its mode's pace.
      f.stage = 'walk';
      walkOn(SPEED[leg.mode]);
      return;
    }
    const sits = SITS.has(leg.mode) ? 1 : 0;
    const holds = HOLDS.has(leg.mode) ? 1 : 0;
    const standing = (): void => {
      f.walking = Math.max(0, f.walking - dt * 3);
      f.phase += dt * 1.6;
    };
    if (f.stage === 'wait') {
      [f.x, f.y, f.z] = f.spot;
      f.heading = turnTo(f.heading, f.spotHeading, Math.min(1, dt * 4));
      f.sit = Math.max(0, f.sit - dt * 2);
      standing();
      const stop = { x: leg.path[0][0], z: leg.path[0][2] };
      const at = ref.position();
      const here = dist({ x: at[0], z: at[2] }, stop) < (leg.mode === 'cab' ? 12 : 40);
      const ready = leg.mode === 'cab' ? ref.phase() === 'pickup' : (ref as Ride).boardsIn() <= 0.05 && here;
      if (ready) {
        f.stage = 'board';
        f.k = 0;
        f.from = [f.x, f.y, f.z];
      }
      return;
    }
    // Stepping in: to the door on foot, then in through it to the seat or the standing place, sitting down on the way.
    const AT_DOOR = 0.55;
    if (f.stage === 'board') {
      f.k = Math.min(1, f.k + dt / (leg.mode === 'cab' ? BOARD_S.cab : BOARD_S.line));
      f.via = doorOf(ref, leg.mode);
      f.to = aboard(ref, leg.mode);
      const outside = f.k < AT_DOOR;
      const t = outside ? smooth(f.k / AT_DOOR) : smooth((f.k - AT_DOOR) / (1 - AT_DOOR));
      const p = outside ? lerp3(f.from, f.via, t) : lerp3(f.via, f.to, t);
      const h = outside ? Math.atan2(f.via[2] - f.from[2], f.via[0] - f.from[0]) : ref.heading();
      f.heading = turnTo(f.heading, h, Math.min(1, dt * 6));
      f.walking = outside ? Math.min(1, f.walking + dt * 4) : Math.max(0, f.walking - dt * 4);
      f.phase += strideRate(1.0, STRIDE, k) * dt * (outside ? 1 : 0.2);
      f.sit = sits * (outside ? 0 : t);
      f.hold = holds * (outside ? 0 : t);
      f.lean = leg.mode === 'cab' ? f.sit : 0;
      [f.x, f.y, f.z] = p;
      if (f.k >= 1) f.stage = 'ride';
      return;
    }
    if (f.stage === 'ride') {
      [f.x, f.y, f.z] = aboard(ref, leg.mode);
      f.heading = ref.heading();
      f.sit = sits;
      f.hold = holds;
      f.lean = leg.mode === 'cab' ? 1 : 0;
      standing();
      f.walking = 0;
      let out = false;
      if (leg.mode === 'cab') {
        const ph = ref.phase();
        out = ph === 'setdown' || ph === 'returning' || ph === 'parked';
      } else {
        const end = leg.path[leg.path.length - 1];
        const at = ref.position();
        out = (ref as Ride).alightsIn() <= 0.05 && dist({ x: at[0], z: at[2] }, { x: end[0], z: end[2] }) < 40;
      }
      if (out) {
        f.stage = 'alight';
        f.k = 0;
        f.from = [f.x, f.y, f.z];
        f.via = doorOf(ref, leg.mode);
        const end = leg.path[leg.path.length - 1];
        f.to = leg.mode === 'cab' ? kerbSpot(end, deps.net()).spot : platformSpot([end, ...(leg.path.length > 1 ? [leg.path[leg.path.length - 2]] : [])], leg.mode).spot;
        if (leg.mode !== 'cab' && leg.path.length > 1) {
          // Off onto the platform on the right of the way it came.
          const prev = leg.path[leg.path.length - 2];
          const h = Math.atan2(end[2] - prev[2], end[0] - prev[0]);
          const pl = PLATFORM[leg.mode as keyof typeof PLATFORM];
          f.to = around(end, h, 0, pl.out, pl.up === 'quay' ? 0 : end[1] + pl.up);
        }
      }
      return;
    }
    // Stepping out: up from the seat and out through the door, then on foot to the kerb or along the platform.
    if (f.stage === 'alight') {
      f.k = Math.min(1, f.k + dt / (leg.mode === 'cab' ? BOARD_S.cab * 0.8 : BOARD_S.line));
      const inside = f.k < 1 - AT_DOOR;
      const t = inside ? smooth(f.k / (1 - AT_DOOR)) : smooth((f.k - (1 - AT_DOOR)) / AT_DOOR);
      const p = inside ? lerp3(f.from, f.via, t) : lerp3(f.via, f.to, t);
      const h = inside ? Math.atan2(f.via[2] - f.from[2], f.via[0] - f.from[0]) : Math.atan2(f.to[2] - f.via[2], f.to[0] - f.via[0]);
      f.heading = turnTo(f.heading, h, Math.min(1, dt * 6));
      f.sit = sits * (inside ? 1 - t : 0);
      f.hold = holds * (inside ? 1 - t : 0);
      f.lean = leg.mode === 'cab' ? f.sit : 0;
      f.walking = inside ? 0 : Math.min(1, f.walking + dt * 4);
      f.phase += strideRate(1.0, STRIDE, k) * dt * (inside ? 0 : 1);
      [f.x, f.y, f.z] = p;
      if (f.k >= 1) nextLeg(f);
    }
  }

  function step(dt: number): void {
    time += dt;
    for (const f of figures.values()) stepFigure(f, dt);
  }

  function release(): void {
    if (followed === null) return;
    followed = null;
    deps.onRelease?.();
  }

  const lit = (): number => {
    if (lanternHeld !== null) return lanternHeld ? 1 : 0;
    const h = hour();
    return h >= DUSK.from || h < DUSK.to ? 1 : 0;
  };

  // ---- the draw
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const lampOut: [number, number, number, number] = [0, 1, 0, 0];

  function write(d: Drawn, f: Figure, litNow: number): void {
    if (d.n >= cap) return;
    const i = d.n++;
    d.mesh.setMatrixAt(i, m4);
    const stride = Math.asin(clamp((0.7 * Math.max(0.55, f.walking)) / (2 * LEG), 0, 0.62));
    d.a.aAnim.setXYZW(i, f.phase, f.walking, stride, 0);
    d.a.aLook.setXYZW(i, f.look.skin, f.look.hair, f.look.coatLen, f.look.hat);
    d.a.aCoat.setXYZ(i, f.look.coat[0], f.look.coat[1], f.look.coat[2]);
    d.a.aLegs.setXYZ(i, f.look.legs[0], f.look.legs[1], f.look.legs[2]);
    d.a.aLampL.setXYZW(i, f.lamp[0], f.lamp[1], f.lamp[2], f.lamp[3]);
    d.a.aPose.setXYZW(i, f.sit, litNow, f.hold, f.lean);
    d.a.aBody.setXYZW(i, f.look.body[0], f.look.body[1], f.look.body[2], f.look.body[3]);
  }

  function draw(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    const eye = camera.position;
    if (figures.size > cap) {
      cap = Math.max(figures.size, cap * 2);
      size();
    }
    close.n = 0;
    near.n = 0;
    far.n = 0;
    let ln = 0;
    const litNow = lit();
    const plates: Plate[] = [];
    for (const f of figures.values()) {
      const d = Math.hypot(f.x - eye.x, f.y + 1 - eye.y, f.z - eye.z);
      f.d = d;
      f.seen = frustum.intersectsSphere(sphere.set(pos.set(f.x, f.y + 0.9, f.z), 1.4));
      if (d > PEOPLE_LOD.out.near && f.seen) {
        lanternPos.setXYZ(ln++, f.x, f.y + 0.7, f.z);
      }
      if (!f.seen || d > PEOPLE_LOD.out.far) continue;
      const k = f.look.height / 1.75;
      pos.set(f.x, f.y, f.z);
      q.setFromAxisAngle(up, -f.heading);
      m4.compose(pos, q, scl.set(k * (0.94 + 0.06 * f.look.build), k, k * f.look.build));
      if (deps.lampLight) deps.lampLight(f.x, f.y + 1.3, f.z, f.lamp);
      if (d < PEOPLE_LOD.close.far) write(close, f, litNow);
      if (d < PEOPLE_LOD.near.far) {
        if (d > PEOPLE_LOD.close.near) write(near, f, litNow);
        if (d < PEOPLE_LOD.plate) {
          plates.push({
            key: `person:${f.agent.id}`,
            origin: { x: f.x, z: f.z },
            at: (out) => out.set(f.x, f.y + (f.sit > 0.5 ? 1.45 : 1.95 * k) + 0.25, f.z),
            fade: { start: PEOPLE_LOD.plate - 40, end: PEOPLE_LOD.plate },
            className: 'plate-person',
            name: f.agent.name,
            sub: f.trip && f.live ? (deps.describe?.(f.trip, f.agent) ?? '') : f.trip ? 'Arrived' : '',
            onActivate: deps.onActivate ? () => deps.onActivate!(f.agent.id) : undefined,
          });
        }
      }
      if (d > PEOPLE_LOD.near.near) write(far, f, litNow);
    }
    const upload = (a: THREE.BufferAttribute, n: number): void => {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    };
    const finish = (d: Drawn): void => {
      d.mesh.count = d.n;
      d.mesh.visible = d.n > 0;
      if (d.n === 0) return;
      upload(d.mesh.instanceMatrix, d.n);
      for (const a of Object.values(d.a)) upload(a, d.n);
    };
    finish(close);
    finish(near);
    finish(far);
    lanterns.visible = ln > 0;
    lanterns.geometry.setDrawRange(0, ln);
    if (ln) upload(lanternPos, ln);
    lastStats.close = close.n;
    lastStats.near = near.n;
    lastStats.far = far.n;
    lastStats.lanterns = ln;
    const key = plates.map((p) => `${p.key}|${p.name}|${p.sub}`).join('\n');
    if (key !== platesNow.map((p) => `${p.key}|${p.name}|${p.sub}`).join('\n')) version++;
    platesNow = plates;
  }

  const followVec = new THREE.Vector3();
  const rideOf = (agentId: string): { mode: TripMode; id: string; phase: string } | null => {
    const f = figures.get(agentId);
    const leg = f?.trip?.legs[f.leg];
    if (!f || !leg || leg.mode === 'walk' || !f.ride) return null;
    return { mode: leg.mode, id: f.ride.id, phase: f.ride.phase() };
  };
  return {
    group,
    set(trips, agents) {
      const byId = new Map(agents.map((a) => [a.id, a]));
      const liveBy = new Map<string, Trip>();
      for (const t of trips) if (!t.endedAt) liveBy.set(t.agentId, t);
      // Agents gone or retired take their figures with them.
      for (const [id, f] of figures) {
        const a = byId.get(id);
        if (!a || a.retired) {
          figures.delete(id);
          if (followed === id) release();
        } else f.agent = a;
      }
      for (const [agentId, trip] of liveBy) {
        const a = byId.get(agentId);
        if (!a || a.retired) continue;
        let f = figures.get(agentId);
        if (!f) {
          f = newFigure(a);
          figures.set(agentId, f);
        }
        if (f.trip?.id !== trip.id) startTrip(f, trip);
        else f.live = true;
      }
      // A trip no longer live: the figure finishes it on foot (or as far as its ride goes); the follow lets go.
      for (const [id, f] of figures) {
        if (liveBy.has(id)) continue;
        f.live = false;
        if (followed === id) release();
      }
      version++;
    },
    update(dt, camera) {
      if (disposed) return;
      if (!held) step(dt);
      if (camera) draw(camera);
    },
    follow(agentId) {
      if (agentId === null || !figures.has(agentId)) {
        release();
        return;
      }
      followed = agentId;
    },
    following: () => followed,
    followPose() {
      const f = followed ? figures.get(followed) : null;
      if (!f) return null;
      return { position: followVec.set(f.x, f.y, f.z), heading: f.heading };
    },
    positionOf(agentId) {
      const f = figures.get(agentId);
      return f ? new THREE.Vector3(f.x, f.y, f.z) : null;
    },
    rideOf,
    figures: () =>
      [...figures.values()].map((f) => ({
        agentId: f.agent.id,
        name: f.agent.name,
        tripId: f.trip?.id ?? null,
        live: f.live,
        leg: f.leg,
        mode: f.trip?.legs[f.leg]?.mode ?? null,
        stage: f.stage,
        position: [f.x, f.y, f.z] as V3,
        heading: f.heading,
        walking: f.walking,
        sit: f.sit,
        lit: lit(),
        ride: rideOf(f.agent.id),
      })),
    plates: () => platesNow,
    platesVersion: () => version,
    view: () => ({
      figures: figures.size,
      close: lastStats.close,
      near: lastStats.near,
      far: lastStats.far,
      lanterns: lastStats.lanterns,
      meshes: (close.mesh.visible ? 1 : 0) + (near.mesh.visible ? 1 : 0) + (far.mesh.visible ? 1 : 0) + (lanterns.visible ? 1 : 0),
      triangles: lastStats.close * closeTris + lastStats.near * nearTris + lastStats.far * farTris,
      following: followed,
      time,
    }),
    lantern(on) {
      lanternHeld = on;
    },
    setQuality() {
      // A stub on purpose: the figures are a few dozen at most, in three calls, so medium keeps them whole. The
      // crowd and the vehicles do the stepping down (ambient.ts, vehicles.ts).
    },
    hold(on) {
      held = on;
    },
    skip(seconds) {
      for (let t = 0; t < seconds; t += 0.1) step(Math.min(0.1, seconds - t));
    },
    dispose() {
      release();
      group.remove(close.mesh, near.mesh, far.mesh, lanterns);
      close.mesh.dispose();
      near.mesh.dispose();
      far.mesh.dispose();
      closeGeo.dispose();
      nearGeo.dispose();
      farGeo.dispose();
      lanterns.geometry.dispose();
      closeMat.dispose();
      nearMat.dispose();
      farMat.dispose();
      lanternMat.dispose();
      figures.clear();
      platesNow = [];
      lastStats.close = lastStats.near = lastStats.far = lastStats.lanterns = 0;
      disposed = true;
    },
  };
}
