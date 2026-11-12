import * as THREE from 'three';

import { BANKS, FERRY_Y, inChannel, PIERS, POD_Y, RAIL_Y, RIVER, SPEED, STREET_AT, streetLine, streetWay, tramHeight, type Line, type Network, type Rank } from '../../../shared/commute.js';
import type { Trip, TripMode } from '../../../shared/types.js';
import { LAYER, setLayers } from './lod.js';
import { hasKit, kitShared } from './kits.js';
import { LOD_EYE } from './lod-shader.js';
import { CONTACT_Y, filleted, offsetLoop, POD_BEAM, RAIL_R, RAIL_TRACK, TRAM_R, TRAM_TRACK } from './lines.js';

/**
 * The city's transit vehicles (Task 31): trams on the loop, elevated trains
 * on the viaduct, maglev pods on their guideways, river ferries between the
 * piers, and the persona cabs that wait at the ranks.
 *
 * Motion. Each line's vehicles run a timetable: a plan of the track worked
 * out once (motionPlan), braking into every stop, standing for its dwell,
 * pulling away, and slowing for the curves it cannot take at speed, so the
 * position of every vehicle is a pure function of the clock. Trams and
 * trains run both ways round their loops on the right-hand track; pods
 * shuttle out on one beam and back on the other through a crossover before
 * each terminus; the ferries, double-ended, work down the river calling at
 * every pier and back up it. A cab is summoned from the rank nearest the
 * persona, drives to it on the street grid, carries it along its leg, sets
 * it down and drives back to its bay.
 *
 * Riders. board() finds the next vehicle on a trip's leg that will call at
 * its boarding stop going the leg's way; the figure (Task 34) moves with the
 * vehicle it returns. summonCab() does the same for a cab leg.
 *
 * Drawing. Every car of a kind is one instance of one model, so each model
 * draws in a call per material near the eye (painted body, trim, glazing
 * with its lit interior, lamps) and in one call far off. The near and far
 * levels cross over by the same screen-door dissolve as the ambient roof kit
 * (lod-shader.ts), and only the near level joins the AO pass (lod.ts
 * layers). The cars take the sun's shadows but cast none into its map,
 * which scene.ts redraws only when something changes: trams and cabs lay a
 * soft contact shadow on the street instead. The glazing looks into a lit room: a ray from the
 * eye is followed into a box the size of the car's saloon (its ceiling and
 * light lines, floor, seats, the far windows and standing passengers), so
 * the interiors have depth at any angle, with the sky reflected at a
 * glancing view.
 */

export type VehicleKind = 'tram' | 'rail' | 'pod' | 'ferry' | 'cab';
type V2 = { x: number; z: number };
type V3 = [number, number, number];

// ---------------------------------------------------------------- tracks

export interface Track {
  readonly length: number;
  readonly closed: boolean;
  /** The point s metres along (wrapped round a closed track, clamped on an open one). */
  point(s: number): { x: number; y: number; z: number };
  /** The direction of travel at s, in plan. */
  tangent(s: number): V2;
  /** How far along the track the point nearest p lies. */
  project(p: V2): number;
  /** Turning per metre at s, measured over 4 m. */
  curvature(s: number): number;
}

/** A polyline (x, y, z points) as a track, measured in plan. */
export function trackOf(pts: ReadonlyArray<readonly [number, number, number]>, closed: boolean): Track {
  const P = pts.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
  const n = closed ? P.length : P.length - 1;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const length = cum[n];
  const wrap = (s: number): number => (closed ? ((s % length) + length) % length : Math.min(Math.max(s, 0), length));
  const seg = (s: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const dirOf = (i: number): V2 => {
    for (let k = 0; k < n; k++) {
      const j = (i + k) % n;
      const a = P[j];
      const b = P[(j + 1) % P.length];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l > 1e-9) return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
    }
    return { x: 1, z: 0 };
  };
  const tangent = (s: number): V2 => dirOf(seg(wrap(s)));
  return {
    length,
    closed,
    point(s) {
      const w = wrap(s);
      const i = seg(w);
      const a = P[i];
      const b = P[(i + 1) % P.length];
      const l = cum[i + 1] - cum[i];
      const t = l > 1e-9 ? (w - cum[i]) / l : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    },
    tangent,
    project(p) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const a = P[i];
        const b = P[(i + 1) % P.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
        const d = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
        if (d < bestD - 1e-9) {
          bestD = d;
          best = cum[i] + t * (cum[i + 1] - cum[i]);
        }
      }
      return best;
    },
    curvature(s) {
      const a = tangent(s - 2);
      const b = tangent(s + 2);
      const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
      return Math.acos(dot) / 4;
    },
  };
}

// ---------------------------------------------------------------- the timetable

export interface MotionOptions {
  /** Cruising speed, m/s. */
  speed: number;
  /** Starting and braking, m/s². */
  accel: number;
  decel?: number;
  /** The sideways acceleration it takes a curve at, m/s²; without it, curves are not slowed for. */
  lateral?: number;
  /** Seconds standing at each stop. */
  dwell: number;
}

export interface Plan {
  /** One lap of a closed track, stops and all; on an open track, the run from end to end. */
  period: number;
  /** Where along the track it is at time t (wrapped round the lap on a closed track), and how fast it goes. */
  at(t: number): { s: number; v: number };
  /** When in the lap it reaches s (at a stop: when it comes to a stand there). */
  timeAt(s: number): number;
  dwell: number;
}

/**
 * The run of one vehicle round a track: the fastest that keeps to the speed,
 * slows for each curve (when `lateral` is given), and brakes to a stand at
 * every stop for its dwell. Worked out on a 1 m grid by the usual two passes
 * (braking back from every limit, accelerating out of it), then timed; the
 * motion between grid points is at constant acceleration, so it is smooth.
 * On an open track it starts and ends at a stand.
 */
export function motionPlan(track: Track, stops: readonly number[], o: MotionOptions): Plan {
  const L = track.length;
  const closed = track.closed;
  const decel = o.decel ?? o.accel;
  const raw: number[] = [];
  const steps = Math.max(1, Math.ceil(L));
  for (let i = 0; i < steps; i++) raw.push((i * L) / steps);
  if (!closed) raw.push(L);
  const stopSet = new Set<number>();
  for (const s of stops) {
    const w = closed ? ((s % L) + L) % L : Math.min(Math.max(s, 0), L);
    raw.push(w);
    stopSet.add(w);
  }
  raw.sort((a, b) => a - b);
  const S: number[] = [];
  const isStop: boolean[] = [];
  for (const s of raw) {
    const last = S.length - 1;
    if (last >= 0 && s - S[last] < 1e-6) {
      if (stopSet.has(s)) {
        S[last] = s;
        isStop[last] = true;
      }
      continue;
    }
    S.push(s);
    isStop.push(stopSet.has(s));
  }
  const N = S.length;
  const ds = (i: number): number => (i + 1 < N ? S[i + 1] : closed ? L + S[0] : S[i]) - S[i];
  const next = (i: number): number => (i + 1 < N ? i + 1 : closed ? 0 : i);
  const v = S.map((s, i) => {
    if (isStop[i]) return 0;
    let lim = o.speed;
    if (o.lateral) {
      const k = track.curvature(s);
      if (k > 1e-4) lim = Math.min(lim, Math.sqrt(o.lateral / k));
    }
    return lim;
  });
  if (!closed) {
    v[0] = 0;
    v[N - 1] = 0;
  }
  const rounds = closed ? 2 : 1;
  // Braking back from every limit.
  for (let r = 0; r < rounds; r++) {
    for (let i = (closed ? N : N - 1) - 1; i >= 0; i--) {
      const j = next(i);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * decel * ds(i)));
    }
  }
  // Accelerating out of it.
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < (closed ? N : N - 1); i++) {
      const j = next(i);
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * o.accel * ds(i)));
    }
  }
  // Timing: arrival at each grid point and departure from it (a stop's dwell in between).
  const tA: number[] = new Array(N);
  const tD: number[] = new Array(N);
  let t = 0;
  for (let i = 0; i < N; i++) {
    tA[i] = t;
    tD[i] = t + (isStop[i] ? o.dwell : 0);
    if (i + 1 < N || closed) t = tD[i] + (2 * ds(i)) / Math.max(v[i] + v[next(i)], 1e-3);
  }
  const period = closed ? t : tA[N - 1];
  const find = (tt: number): number => {
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tA[mid] <= tt) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    period,
    dwell: o.dwell,
    at(time) {
      if (!closed && time >= period) return { s: L, v: 0 };
      if (!closed && time <= 0) return { s: 0, v: 0 };
      const tt = closed ? ((time % period) + period) % period : time;
      const i = find(tt);
      if (tt < tD[i]) return { s: S[i], v: 0 };
      const j = next(i);
      const span = (i + 1 < N ? tA[i + 1] : period) - tD[i];
      const tau = Math.min(tt - tD[i], span);
      const v0 = v[i];
      const v1 = v[j];
      const a = span > 1e-9 ? (v1 - v0) / span : 0;
      let s = S[i] + Math.min(v0 * tau + 0.5 * a * tau * tau, ds(i));
      if (closed && s >= L) s -= L;
      return { s, v: Math.max(0, v0 + a * tau) };
    },
    timeAt(s) {
      const w = closed ? ((s % L) + L) % L : Math.min(Math.max(s, 0), L);
      let lo = 0;
      let hi = N - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (S[mid] <= w + 1e-9) lo = mid;
        else hi = mid - 1;
      }
      const i = lo;
      const d = w - S[i];
      if (d < 1e-6) return tA[i];
      const span = (i + 1 < N ? tA[i + 1] : period) - tD[i];
      const v0 = v[i];
      const a = span > 1e-9 ? (v[next(i)] - v0) / span : 0;
      const tau = Math.abs(a) < 1e-9 ? d / Math.max(v0, 1e-3) : (-v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * d))) / a;
      return tD[i] + tau;
    },
  };
}

// ---------------------------------------------------------------- polylines

/** Every piece of an open or closed polyline cut to at most `max` metres, or `fine` where `near` holds. */
function densify(pts: V2[], closed: boolean, max: number, fine = max, near: (p: V2) => boolean = () => false): V2[] {
  const out: V2[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let u = 0;
    while (u < len) {
      const p = { x: a.x + ((b.x - a.x) * u) / len, z: a.z + ((b.z - a.z) * u) / len };
      const step = near(p) ? fine : max;
      u += step;
      if (u < len - 0.25) out.push({ x: a.x + ((b.x - a.x) * u) / len, z: a.z + ((b.z - a.z) * u) / len });
    }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/** An open polyline with each corner rounded to radius r (less where the pieces are short), its ends kept. */
function rounded(pts: V2[], r: number, seg = 8): V2[] {
  const P = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 1e-6);
  if (P.length < 3) return P;
  const out: V2[] = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1];
    const c = P[i];
    const b = P[i + 1];
    const la = Math.hypot(c.x - a.x, c.z - a.z);
    const lb = Math.hypot(b.x - c.x, b.z - c.z);
    const da = { x: (c.x - a.x) / la, z: (c.z - a.z) / la };
    const db = { x: (b.x - c.x) / lb, z: (b.z - c.z) / lb };
    const turn = Math.acos(Math.max(-1, Math.min(1, da.x * db.x + da.z * db.z)));
    if (turn < 0.05) {
      out.push(c);
      continue;
    }
    const cut = Math.min(r * Math.tan(turn / 2), la * 0.45, lb * 0.45);
    const p0 = { x: c.x - da.x * cut, z: c.z - da.z * cut };
    const p1 = { x: c.x + db.x * cut, z: c.z + db.z * cut };
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const u = 1 - t;
      out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, z: u * u * p0.z + 2 * u * t * c.z + t * t * p1.z });
    }
  }
  out.push(P[P.length - 1]);
  return out;
}

/** An open polyline shifted `d` to the right of travel, its two ends kept where they are (the kerb at a pickup). */
function laneOf(pts: V2[], d: number): V2[] {
  if (pts.length < 3) return pts;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const a = pts[i - 1];
    const b = pts[i + 1];
    const t0 = norm({ x: p.x - a.x, z: p.z - a.z });
    const t1 = norm({ x: b.x - p.x, z: b.z - p.z });
    const n0 = { x: -t0.z, z: t0.x };
    const n1 = { x: -t1.z, z: t1.x };
    let m = norm({ x: n0.x + n1.x, z: n0.z + n1.z });
    const k = Math.max(m.x * n0.x + m.z * n0.z, 0.4);
    m = { x: m.x / k, z: m.z / k };
    // The shift eases in and out over the first and last pieces: no sideways jump at the kerb.
    const ends = Math.min(dist(p, pts[0]), dist(p, pts[pts.length - 1]));
    const f = Math.min(1, ends / 12);
    return { x: p.x + m.x * d * f, z: p.z + m.z * d * f };
  });
}

/** Chaikin's corner cutting on an open polyline, its ends kept. */
function smoothOpen(pts: V2[], rounds: number): V2[] {
  let P = pts;
  for (let r = 0; r < rounds; r++) {
    const out: V2[] = [P[0]];
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i];
      const b = P[i + 1];
      if (i > 0) out.push({ x: 0.75 * a.x + 0.25 * b.x, z: 0.75 * a.z + 0.25 * b.z });
      if (i < P.length - 2) out.push({ x: 0.25 * a.x + 0.75 * b.x, z: 0.25 * a.z + 0.75 * b.z });
    }
    out.push(P[P.length - 1]);
    P = out;
  }
  return P;
}

function norm(v: V2): V2 {
  const l = Math.hypot(v.x, v.z);
  return l < 1e-9 ? { x: 1, z: 0 } : { x: v.x / l, z: v.z / l };
}
const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
const pathLength = (pts: V2[]): number => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
const xz = (p: readonly number[]): V2 => ({ x: p[0], z: p[p.length - 1] });

// ---------------------------------------------------------------- the fleet

/** A model of car: what it looks like is drawn per model (models below); how it runs is its service's. */
type ModelName = 'tram' | 'railEnd' | 'railMid' | 'pod' | 'ferry' | 'cab';

/** The make-up of each kind of vehicle: its cars, their spacing centre to centre, and their bogies' spacing. */
const CONSIST: Record<Exclude<VehicleKind, 'cab'>, { models: Array<{ model: ModelName; flip: boolean }>; pitch: number; bogie: number; floor: number }> = {
  // Two articulated sections nose to nose on the outside; the second runs reversed, its nose at the tail.
  tram: { models: [{ model: 'tram', flip: false }, { model: 'tram', flip: true }], pitch: 14.8, bogie: 8.6, floor: 0.34 },
  // Three cars: a cab car each end and a trailer between.
  rail: { models: [{ model: 'railEnd', flip: false }, { model: 'railMid', flip: false }, { model: 'railEnd', flip: true }], pitch: 16.0, bogie: 10.6, floor: 0.95 },
  pod: { models: [{ model: 'pod', flip: false }], pitch: 0, bogie: 3.2, floor: 0.36 },
  ferry: { models: [{ model: 'ferry', flip: false }], pitch: 0, bogie: 12, floor: 0.12 },
};
/** The cab's floor over the road. */
const CAB_FLOOR = 0.42;
/** The tram's and train's rail heads stand this far over the running height commute.ts gives (the sett bed, the slab). */
const RAIL_HEAD: Record<VehicleKind, number> = { tram: 0.098, rail: 0, pod: 0.06, ferry: 0, cab: 0 };

/** Where a service calls: how far along its track, at which stop (the stop's own point, as the network lists it). */
interface Call {
  s: number;
  x: number;
  z: number;
  /** When in the lap it comes to a stand here. */
  t: number;
}

interface Service {
  id: string;
  kind: Exclude<VehicleKind, 'cab'>;
  track: Track;
  plan: Plan;
  calls: Call[];
  line: Line | null;
  units: Unit[];
  /** Keeps the cars' noses along the line's axis rather than the way they move (pods and ferries are double-ended). */
  fold: V2 | null;
}

interface Unit {
  id: string;
  service: Service;
  /** Its place in the timetable: its clock runs this far ahead of the city's. */
  offset: number;
  /** Which way it last moved along the track: +1 forward. Its lamps follow it. */
  lead: number;
}

/** A cab's errand, as its rider sees it: 'queued' while the cab it waits for is still out on someone else's. */
export type CabPhase = 'queued' | 'parked' | 'to-pickup' | 'pickup' | 'carrying' | 'setdown' | 'returning';
/** Seconds a cab stands at the kerb for its rider to get in, and to get out. */
const CAB_BOARD_S = 7;
const CAB_ALIGHT_S = 6;
/** Cabs drive this far right of a street's centre line. */
const CAB_LANE = 2.6;
/** Bays at a rank, along its street from its centre; the first two hold a cab each. */
const BAYS = [-6.5, 0, 6.5];

interface Cab {
  id: string;
  rank: Rank;
  bay: number;
  phase: CabPhase;
  /** The current drive (to the pickup, the ride, the way back) and when it started. */
  run: { track: Track; plan: Plan } | null;
  since: number;
  legs: { pickup: { track: Track; plan: Plan }; carry: { track: Track; plan: Plan }; back: { track: Track; plan: Plan } } | null;
  /** An errand waiting for this cab to be back at its bay (when every bay in the city was out). */
  queue?: { token: string; a: V2; b: V2; est: { pickup: number; carry: number } } | null;
  /** The errand it is on (its booking's token) and that errand's own ends, as the trip gave them. */
  errand?: string;
  ends?: { a: V2; b: V2 };
}

/** Seconds until a cab is back at its bay. */
function cabFreeIn(cab: Cab, time: number): number {
  const legs = cab.legs;
  if (cab.phase === 'parked' || cab.phase === 'queued' || !legs) return 0;
  const t = time - cab.since;
  const rest = { 'to-pickup': [legs.pickup.plan.period, CAB_BOARD_S, legs.carry.plan.period, CAB_ALIGHT_S, legs.back.plan.period], pickup: [CAB_BOARD_S, legs.carry.plan.period, CAB_ALIGHT_S, legs.back.plan.period], carrying: [legs.carry.plan.period, CAB_ALIGHT_S, legs.back.plan.period], setdown: [CAB_ALIGHT_S, legs.back.plan.period], returning: [legs.back.plan.period] }[cab.phase];
  return Math.max(0, rest.reduce((a, b) => a + b, 0) - t);
}

/** A vehicle as a rider sees it: where it is, which way it faces, and when it calls where. */
export interface VehicleRef {
  id: string;
  /** The vehicle itself (a cab booking's id names the booking; this names the cab). */
  vehicle: string;
  kind: VehicleKind;
  /** The track it runs on: vehicles running the same way on the same line share it. */
  track: string;
  /** The middle of the vehicle (the middle car of a train) at its running height: the rail, beam, deck or road. */
  position(): V3;
  /** The way it faces in plan: forward is (cos h, sin h) in x and z. */
  heading(): number;
  speed(): number;
  /** The world height of its floor now: where a rider stands. */
  floorY(): number;
  /** Seconds until it next stands at the stop nearest p (0 while it stands there). */
  arrivesIn(p: V2): number;
  /** A cab's errand; a line's vehicle is always 'running'. */
  phase(): CabPhase | 'running';
  /**
   * True once the vehicle no longer runs: the network was laid again
   * without it. A retired ref stands where it was last seen; its rider
   * boards again.
   */
  retired(): boolean;
}

/** A boarded vehicle: the ref, and when this rider boards and alights on its leg (seconds from now). */
export interface Ride extends VehicleRef {
  boardsIn(): number;
  alightsIn(): number;
  /** Also true once the network this ride was timetabled on has been laid anew: its rider boards again. */
  retired(): boolean;
}

/** How long a unit waits, from time `now`, until it stands at a call. */
function waitFor(u: Unit, c: Call, now: number): number {
  const P = u.service.plan.period;
  const tau = (((now + u.offset) % P) + P) % P;
  let w = c.t - tau;
  if (w < 0) {
    if (tau <= c.t + u.service.plan.dwell) return 0;
    w += P;
  }
  return w;
}

/** The pose of a car whose middle stands s along a track: its middle point between its bogies, its heading and pitch. */
function carPose(track: Track, s: number, bogie: number): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const a = track.point(s + bogie / 2);
  const b = track.point(s - bogie / 2);
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) {
    const t = track.tangent(s);
    const p = track.point(s);
    return { ...p, yaw: Math.atan2(t.z, t.x), pitch: 0 };
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, yaw: Math.atan2(dz, dx), pitch: Math.atan2(a.y - b.y, l) };
}

/** The tram's two tracks: right-hand running, the forward track to the right of the loop's own order. */
function tramTracks(net: Network): Track[] {
  const corners = net.tram.path.map(xz);
  const deck = (p: V2): boolean => Math.abs(p.x - RIVER.x) < RIVER.width / 2 + 24;
  const centre = densify(filleted(corners, TRAM_R), true, 10, 2, deck);
  const lay = (pts: V2[]): Track => trackOf(pts.map((p) => [p.x, tramHeight(p.x, p.z), p.z] as V3), true);
  return [lay(offsetLoop(centre, TRAM_TRACK)), lay(offsetLoop(centre, -TRAM_TRACK).reverse())];
}

function railTracks(net: Network): Track[] {
  const corners = net.rail.path.map(xz);
  const centre = densify(filleted(corners, RAIL_R, 8), true, 10);
  const lay = (pts: V2[]): Track => trackOf(pts.map((p) => [p.x, RAIL_Y, p.z] as V3), true);
  return [lay(offsetLoop(centre, RAIL_TRACK)), lay(offsetLoop(centre, -RAIL_TRACK).reverse())];
}

/** The ferries on the river (at most river.ts's WAKES, so every one can trail its wake). */
const FERRIES = 3;

/** How far before each terminus the pods cross over between the beams, and where they stand at it. */
const POD_CROSS = { start: 46, end: 18, stand: 4 } as const;

/**
 * A pod line's lap: out on the right-hand beam, over a crossover to the
 * other beam before the far terminus, stand, and back on it the same way
 * to the first terminus. Points as [x, y, z], and where each beam's run lies
 * along the lap.
 */
function podLap(line: Line): { track: Track; out: [number, number]; back: [number, number] } {
  const a = xz(line.path[0]);
  const b = xz(line.path[line.path.length - 1]);
  const t = norm({ x: b.x - a.x, z: b.z - a.z });
  const n = { x: -t.z, z: t.x };
  const L = dist(a, b);
  const at = (u: number, side: number): V2 => ({ x: a.x + t.x * u + n.x * side * POD_BEAM, z: a.z + t.z * u + n.z * side * POD_BEAM });
  const ease = (u0: number, u1: number, s0: number, s1: number): V2[] => {
    const out: V2[] = [];
    for (let k = 1; k <= 12; k++) {
      const f = k / 12;
      const e = f * f * (3 - 2 * f);
      const p = at(u0 + (u1 - u0) * f, s0 + (s1 - s0) * e);
      out.push(p);
    }
    return out;
  };
  const S = POD_CROSS;
  const pts: V2[] = [at(S.stand, 1), at(L - S.start, 1), ...ease(L - S.start, L - S.end, 1, -1), at(L - S.stand, -1), at(S.start, -1), ...ease(S.start, S.end, -1, 1)];
  const dense = densify(pts, true, 10);
  const track = trackOf(dense.map((p) => [p.x, POD_Y, p.z] as V3), true);
  const outEnd = track.project(at(L - S.start, 1));
  const backStart = track.project(at(L - S.stand, -1));
  const backEnd = track.project(at(S.start, -1));
  return { track, out: [0, outEnd], back: [backStart, backEnd] };
}

/** The ferries' berths: alongside each pier's pontoon, on the river side of its guide piles. */
export function ferryBerth(p: (typeof PIERS)[number]): V2 {
  const s = p.bank === 'west' ? 1 : -1;
  // river.ts ferryPier: the pontoon's centre stands 9.9 m down the bank from the stairs, its outer edge 12.6 m out.
  return { x: p.x + s * 16.2, z: p.z + 9.9 };
}

/**
 * The ferries' lap: down the river from the northern pier to the southern,
 * calling at each, and back up; between piers out into the stream (down on
 * the east of the channel, up on the west) and in alongside the next.
 */
function ferryLap(): { track: Track; calls: Array<{ s: number; pier: (typeof PIERS)[number] }> } {
  const piers = [...PIERS].sort((a, b) => a.z - b.z);
  const legs: V2[][] = [];
  const run = (from: (typeof PIERS)[number], to: (typeof PIERS)[number], lane: number): V2[] => {
    const A = ferryBerth(from);
    const B = ferryBerth(to);
    const dz = Math.sign(B.z - A.z);
    const span = Math.abs(B.z - A.z);
    const reach = Math.min(46, span * 0.3);
    const mid = RIVER.x + lane;
    return smoothOpen(
      [A, { x: A.x + (mid - A.x) * 0.35, z: A.z + dz * reach * 0.45 }, { x: mid, z: A.z + dz * reach }, { x: mid, z: B.z - dz * reach }, { x: B.x + (mid - B.x) * 0.35, z: B.z - dz * reach * 0.45 }, B],
      4,
    );
  };
  for (let i = 0; i + 1 < piers.length; i++) legs.push(run(piers[i], piers[i + 1], 5));
  for (let i = piers.length - 1; i > 0; i--) legs.push(run(piers[i], piers[i - 1], -5));
  const pts: V2[] = [];
  for (const l of legs) pts.push(...l.slice(0, -1));
  const track = trackOf(pts.map((p) => [p.x, FERRY_Y, p.z] as V3), true);
  const calls: Array<{ s: number; pier: (typeof PIERS)[number] }> = [];
  let s = 0;
  const visit = [...piers, ...piers.slice(1, -1).reverse()];
  legs.forEach((l, i) => {
    calls.push({ s, pier: visit[i] });
    s += pathLength(l);
  });
  return { track, calls };
}

interface Fleet {
  services: Service[];
  units: Unit[];
  cabs: Cab[];
  time: number;
}

function service(kind: Service['kind'], id: string, track: Track, line: Line | null, calls: Array<{ s: number; x: number; z: number }>, opts: MotionOptions, count: number, phase: number, fold: V2 | null): Service {
  const plan = motionPlan(
    track,
    calls.map((c) => c.s),
    opts,
  );
  const svc: Service = { id, kind, track, plan, line, units: [], fold, calls: calls.map((c) => ({ ...c, t: plan.timeAt(c.s) })) };
  for (let k = 0; k < count; k++) svc.units.push({ id: `${id}:${k}`, service: svc, offset: ((k + phase) * plan.period) / count, lead: 1 });
  return svc;
}

/** The vehicles on every line, timetabled, and the cabs at their ranks. */
function makeFleet(net: Network): Fleet {
  const services: Service[] = [];
  // Trams both ways round the loop, one every 700 m or so; the opposite way half a headway out of step.
  tramTracks(net).forEach((track, d) => {
    const calls = net.tram.stops.map((st) => ({ s: track.project(st), x: st.x, z: st.z }));
    const n = Math.max(2, Math.round(track.length / 700));
    services.push(service('tram', `tram:${d ? 'rev' : 'fwd'}`, track, net.tram, calls, { speed: SPEED.tram, accel: 1.1, decel: 1.2, lateral: 0.9, dwell: 20 }, n, d * 0.5, null));
  });
  railTracks(net).forEach((track, d) => {
    const calls = net.rail.stops.map((st) => ({ s: track.project(st), x: st.x, z: st.z }));
    const n = Math.max(2, Math.round(track.length / 1500));
    services.push(service('rail', `rail:${d ? 'rev' : 'fwd'}`, track, net.rail, calls, { speed: SPEED.rail, accel: 0.9, decel: 1.0, lateral: 1.0, dwell: 20 }, n, d * 0.5, null));
  });
  net.pods.forEach((line, i) => {
    const lap = podLap(line);
    const a = xz(line.path[0]);
    const b = xz(line.path[line.path.length - 1]);
    const t = norm({ x: b.x - a.x, z: b.z - a.z });
    const n = { x: -t.z, z: t.x };
    const calls: Array<{ s: number; x: number; z: number }> = [];
    for (const st of line.stops) {
      const u = (st.x - a.x) * t.x + (st.z - a.z) * t.z;
      const L = dist(a, b);
      if (u < POD_CROSS.start) calls.push({ s: 0, x: st.x, z: st.z });
      else if (u > L - POD_CROSS.start) calls.push({ s: lap.back[0], x: st.x, z: st.z });
      else {
        calls.push({ s: lap.track.project({ x: st.x + n.x * POD_BEAM, z: st.z + n.z * POD_BEAM }), x: st.x, z: st.z });
        calls.push({ s: lap.track.project({ x: st.x - n.x * POD_BEAM, z: st.z - n.z * POD_BEAM }), x: st.x, z: st.z });
      }
    }
    services.push(service('pod', `pod:${i}`, lap.track, line, calls, { speed: SPEED.pod, accel: 1.3, decel: 1.4, lateral: 1.2, dwell: 15 }, 3, i * 0.31, t));
  });
  const ferry = ferryLap();
  services.push(
    service(
      'ferry',
      'ferry',
      ferry.track,
      null,
      ferry.calls.map((c) => ({ s: c.s, x: c.pier.x, z: c.pier.z })),
      { speed: SPEED.ferry, accel: 0.22, decel: 0.28, lateral: 0.35, dwell: 25 },
      FERRIES,
      0.1,
      { x: 0, z: 1 },
    ),
  );
  const units = services.flatMap((s) => s.units);
  const cabs: Cab[] = [];
  net.ranks.forEach((rank, r) => {
    for (let k = 0; k < 2; k++) cabs.push({ id: `cab:${r}:${k}`, rank, bay: k, phase: 'parked', run: null, since: 0, legs: null });
  });
  return { services, units, cabs, time: 0 };
}

/** A unit's pose: each car's middle, heading and pitch, and how fast it goes (signed along its track). */
function unitCars(u: Unit, time: number): { cars: Array<{ x: number; y: number; z: number; yaw: number; pitch: number; model: ModelName; lead: number }>; s: number; v: number } {
  const svc = u.service;
  const { s, v } = svc.plan.at(time + u.offset);
  // The way it moves: on a shuttle's lap the track's direction turns back at each terminus.
  const consist = CONSIST[svc.kind];
  const n = consist.models.length;
  const cars = consist.models.map((m, k) => {
    const sc = s + ((n - 1) / 2 - k) * consist.pitch;
    const pose = carPose(svc.track, sc, consist.bogie);
    let yaw = pose.yaw;
    let pitch = pose.pitch;
    let lead = 1;
    if (svc.fold) {
      // Double-ended: the nose stays on the line's axis, whichever way the vehicle moves; its lamps follow the way it goes.
      const fx = Math.cos(yaw) * svc.fold.x + Math.sin(yaw) * svc.fold.z;
      if (fx < 0) {
        yaw += Math.PI;
        pitch = -pitch;
        lead = -1;
      }
    }
    if (m.flip) {
      yaw += Math.PI;
      pitch = -pitch;
      lead = -lead;
    }
    return { ...pose, yaw, pitch, model: m.model, lead };
  });
  return { cars, s, v };
}

const CAB_OPTS: MotionOptions = { speed: SPEED.cab, accel: 1.6, decel: 2.0, lateral: 2.2, dwell: 0 };

/** Road level: the road bridges' decks stand a few centimetres proud of the streets. */
function roadY(p: V2): number {
  return inChannel(p.x, 2) ? 0.08 : 0;
}

/** A cab's drive along a way on the street grid: round the plazas, right of the centre line, corners rounded, a stand at each end. */
function drive(way: V2[], plazas: readonly V2[] = []): { track: Track; plan: Plan } {
  const pts = rounded(laneOf(aroundPlazas(densify(way, false, 1e9), plazas), CAB_LANE), 7);
  const track = trackOf(
    pts.map((p) => [p.x, roadY(p), p.z] as V3),
    false,
  );
  return { track, plan: motionPlan(track, [], CAB_OPTS) };
}

/** Where a cab pulls in to the kerb: this far from the street's centre line. */
const KERB = 6.4;
/** Plazas are paved this far round each district's centre (and the exchange's): no cab drives or stops inside. */
const PLAZA_R = 72;
const PLAZA_CLEAR = 74.5;

/** The plazas a network serves: the exchange's and each district's, found from their ranks (commute.ts cabRanks). */
function plazasOf(net: Network): V2[] {
  return net.ranks.map((r) => ({ x: r.x - STREET_AT - 2, z: r.z - 84 }));
}

/**
 * Where a cab pulls in for a rider at p: the kerb of the street nearest p,
 * slid along that street out of any plaza it would stand in.
 */
export function kerbOf(p: V2, net: Network): V2 {
  return kerbPlan(p, net).kerb;
}

/**
 * The kerb for p (kerbOf), and where on its street's centre line a cab
 * comes to it from: from outside the plaza it was slid clear of, so the
 * approach never crosses the paving.
 */
function kerbPlan(p: V2, net: Network): { kerb: V2; via: V2 } {
  const plazas = plazasOf(net);
  const along = (k: V2, axis: 'x' | 'z'): { kerb: V2; via: V2 } => {
    let q = { ...k };
    let out = 0;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const o of plazas) {
        if (dist(q, o) >= PLAZA_CLEAR) continue;
        // Out along the street to the nearer edge of the plaza.
        const off = axis === 'z' ? q.x - o.x : q.z - o.z;
        const half = Math.sqrt(Math.max(0, PLAZA_CLEAR * PLAZA_CLEAR - off * off)) + 0.5;
        const u = axis === 'z' ? q.z - o.z : q.x - o.x;
        const to = (u >= 0 ? 1 : -1) * half;
        q = axis === 'z' ? { x: q.x, z: o.z + to } : { x: o.x + to, z: q.z };
        out = Math.sign(to);
        moved = true;
      }
      if (!moved) break;
    }
    const line = axis === 'z' ? streetLine(q.x) : streetLine(q.z);
    const via = axis === 'z' ? { x: line, z: q.z + out * 40 } : { x: q.x + out * 40, z: line };
    return { kerb: q, via };
  };
  const sx = streetLine(p.x);
  const sz = streetLine(p.z);
  const onZ = along({ x: sx + (p.x >= sx ? 1 : -1) * KERB, z: p.z }, 'z');
  const onX = along({ x: p.x, z: sz + (p.z >= sz ? 1 : -1) * KERB }, 'x');
  return dist(onZ.kerb, p) <= dist(onX.kerb, p) ? onZ : onX;
}

/**
 * A way on the street grid with every run that would cross a plaza taken
 * round it on the streets a block out (120 m from the plaza's centre).
 */
function aroundPlazas(way: V2[], plazas: readonly V2[]): V2[] {
  let pts = way;
  for (let pass = 0; pass < 6; pass++) {
    const out: V2[] = [pts[0]];
    let changed = false;
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1];
      const b = pts[i];
      const alongZ = Math.abs(a.x - b.x) < 1e-6;
      const alongX = Math.abs(a.z - b.z) < 1e-6;
      let hit: V2 | null = null;
      if (alongZ || alongX) {
        for (const o of plazas) {
          // The lane and the rounded corners can bring the cab a few metres in: keep that much clear too.
          const r = PLAZA_R + 5;
          const off = alongZ ? Math.abs(a.x - o.x) : Math.abs(a.z - o.z);
          if (off >= r) continue;
          const half = Math.sqrt(r * r - off * off);
          const u0 = alongZ ? a.z : a.x;
          const u1 = alongZ ? b.z : b.x;
          const c = alongZ ? o.z : o.x;
          if (Math.max(u0, u1) > c - half && Math.min(u0, u1) < c + half) {
            hit = o;
            break;
          }
        }
      }
      if (!hit) {
        out.push(b);
        continue;
      }
      changed = true;
      // Round it: out to the cross street before the plaza, along the parallel street 120 m out, back after it.
      const sg = alongZ ? Math.sign(b.z - a.z) || 1 : Math.sign(b.x - a.x) || 1;
      const side = alongZ ? (a.x >= hit.x ? 1 : -1) : a.z >= hit.z ? 1 : -1;
      const c = alongZ ? hit.z : hit.x;
      const par = (alongZ ? hit.x : hit.z) + side * 120;
      const u0 = alongZ ? a.z : a.x;
      const u1 = alongZ ? b.z : b.x;
      const e0 = (u0 - c) * sg < -120 ? c - sg * 120 : u0;
      const e1 = (u1 - c) * sg > 120 ? c + sg * 120 : u1;
      const P = (u: number, l: number): V2 => (alongZ ? { x: l, z: u } : { x: u, z: l });
      const lane = alongZ ? a.x : a.z;
      if (Math.abs(e0 - u0) > 1e-6) out.push(P(e0, lane));
      out.push(P(e0, par), P(e1, par));
      if (Math.abs(e1 - u1) > 1e-6) out.push(P(e1, lane));
      out.push(b);
    }
    pts = out;
    if (!changed) break;
  }
  return pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 1e-6);
}

/** Where a cab stands in its bay: in the kerb lane, nose the way the lane's traffic goes. */
function bayPose(rank: Rank, bay: number): { x: number; z: number; yaw: number } {
  const u = BAYS[bay] ?? BAYS[0] + bay * 6.5;
  // Ranks stand in the kerb lane east of a street along z, whose traffic runs north (-z) on the right-hand rule.
  return rank.dir === 'z' ? { x: rank.x, z: rank.z + u, yaw: -Math.PI / 2 } : { x: rank.x + u, z: rank.z, yaw: Math.PI };
}

function cabPose(cab: Cab, time: number): { x: number; y: number; z: number; yaw: number; v: number; braking: boolean } {
  if (cab.phase === 'parked' || !cab.run) {
    const b = bayPose(cab.rank, cab.bay);
    return { x: b.x, y: roadY(b), z: b.z, yaw: b.yaw, v: 0, braking: false };
  }
  const { track, plan } = cab.run;
  const t = time - cab.since;
  const { s, v } = plan.at(t);
  const p = track.point(s);
  const tan = track.tangent(Math.min(s, track.length - 0.01));
  const ahead = plan.at(t + 0.25).v;
  return { ...p, yaw: Math.atan2(tan.z, tan.x), v, braking: ahead < v - 0.05 || (v < 0.05 && t > 0) };
}

/** Moves each summoned cab on to the next part of its errand when the current one is done. */
function advanceCab(cab: Cab, time: number): void {
  for (let guard = 0; guard < 6; guard++) {
    const t = time - cab.since;
    const legs = cab.legs;
    if (!legs) return;
    const done = (run: { plan: Plan }): boolean => t >= run.plan.period;
    let next: CabPhase | null = null;
    let at = 0;
    if (cab.phase === 'to-pickup' && done(legs.pickup)) {
      next = 'pickup';
      at = legs.pickup.plan.period;
    } else if (cab.phase === 'pickup' && t >= CAB_BOARD_S) {
      next = 'carrying';
      at = CAB_BOARD_S;
    } else if (cab.phase === 'carrying' && done(legs.carry)) {
      next = 'setdown';
      at = legs.carry.plan.period;
    } else if (cab.phase === 'setdown' && t >= CAB_ALIGHT_S) {
      next = 'returning';
      at = CAB_ALIGHT_S;
    } else if (cab.phase === 'returning' && done(legs.back)) {
      next = 'parked';
      at = legs.back.plan.period;
    }
    if (!next) return;
    cab.since += at;
    cab.phase = next;
    if (next === 'pickup') cab.run = { track: legs.pickup.track, plan: standAt(legs.pickup.track, legs.pickup.track.length) };
    else if (next === 'carrying') cab.run = legs.carry;
    else if (next === 'setdown') cab.run = { track: legs.carry.track, plan: standAt(legs.carry.track, legs.carry.track.length) };
    else if (next === 'returning') cab.run = legs.back;
    else {
      cab.run = null;
      cab.legs = null;
    }
  }
}

/** A plan that stands still at s for ever (a cab at the kerb). */
function standAt(_track: Track, s: number): Plan {
  return { period: Infinity, dwell: 0, at: () => ({ s, v: 0 }), timeAt: () => 0 };
}

// ---------------------------------------------------------------- models

/** What a face is drawn in: the painted body, the trim (bogies, skirts, rubber, gear), the glazing, the lamps. */
type Part = 'body' | 'trim' | 'glass' | 'lamp';
const PARTS: Part[] = ['body', 'trim', 'glass', 'lamp'];
type RGB = [number, number, number];
/** Metalness and roughness. */
type Surf = [number, number];
/**
 * A lamp's kind, by what it shows while the car's nose (+x) leads and while
 * it trails: a headlamp is white leading and dark trailing, a tail lamp
 * dark leading and red trailing; a double-ender's end lamps ('fore' on the
 * nose, 'aft' on the tail) change between white and red; a cab's 'white'
 * and 'red' bars never change; 'always' shows its own colour.
 */
type LampKind = 'head' | 'tail' | 'fore' | 'aft' | 'white' | 'red' | 'always' | 'board' | 'tramBoard';
/** Per kind: what it shows leading and trailing (0 dark, 1 white, 2 red), and whether it shows its own colour. */
const LAMP_CODE: Record<LampKind, RGB> = { head: [1, 0, 0], tail: [0, 2, 0], fore: [1, 2, 0], aft: [2, 1, 0], white: [1, 1, 0], red: [2, 2, 0], always: [0, 0, 1], board: [0, 0, 2], tramBoard: [0, 0, 3] };

const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

interface Ring {
  y: number;
  /** How far the outline reaches forward (+x) and back (-x) at this height, its half-width, and its corner radii in plan. */
  front: number;
  rear: number;
  w: number;
  rf: number;
  rr: number;
}

/** A face's paint: colour, metalness and roughness. */
interface Paint {
  part: Part;
  colour: RGB;
  surf: Surf;
}

/**
 * Geometry gathered per part, in a car's own frame: x forward, y up from
 * its running surface, z to its left. Every vertex carries a colour and its
 * metalness and roughness; a lamp's vertices say what kind of lamp it is.
 */
class Kit {
  private data = new Map<Part, { pos: number[]; nor: number[]; col: number[]; surf: number[]; kind: number[] }>();
  constructor(readonly lo: boolean) {
    for (const p of PARTS) this.data.set(p, { pos: [], nor: [], col: [], surf: [], kind: [] });
  }
  private vert(part: Part, p: V3, n: V3, c: RGB, s: Surf, k: RGB): void {
    const d = this.data.get(part)!;
    d.pos.push(...p);
    d.nor.push(...n);
    d.col.push(...c);
    d.surf.push(...s);
    d.kind.push(...k);
  }
  tri(part: Part, a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, col: RGB, s: Surf = [0, 0.5], k: RGB = [0, 0, 0]): void {
    this.vert(part, a, na, col, s, k);
    this.vert(part, b, nb, col, s, k);
    this.vert(part, c, nc, col, s, k);
  }
  /** A box by its centre and size, turned `ry` about y and `rz` about z. */
  box(part: Part, c: V3, size: V3, col: RGB, s: Surf = [0, 0.6], kind?: LampKind, ry = 0, rz = 0): void {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...c), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YZX')), new THREE.Vector3(...size));
    this.geometry(part, UNIT, m, col, s, kind);
  }
  /** A round bar from a to b. */
  rod(part: Part, a: V3, b: V3, r: number, col: RGB, s: Surf = [0.6, 0.45], seg = 8): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-5) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    this.geometry(part, cylinderOf(this.lo ? Math.min(seg, 6) : seg), new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r)), col, s);
  }
  /** A flat bar from a to b, w wide and h deep, its depth upright. */
  bar(part: Part, a: V3, b: V3, w: number, h: number, col: RGB, s: Surf = [0.5, 0.5]): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-5) return;
    const x = B.clone().sub(A).normalize();
    let z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(0, 1, 0));
    if (z.lengthSq() < 1e-6) z = new THREE.Vector3(0, 0, 1);
    z.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const m = new THREE.Matrix4().makeBasis(x, y, z).scale(new THREE.Vector3(len, h, w));
    m.setPosition(A.add(B).multiplyScalar(0.5));
    this.geometry(part, UNIT, m, col, s);
  }
  geometry(part: Part, g: THREE.BufferGeometry, m: THREE.Matrix4, col: RGB, s: Surf = [0, 0.6], kind?: LampKind): void {
    const geo = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    const k: RGB = kind ? LAMP_CODE[kind] : [0, 0, 0];
    for (let i = 0; i < p.count; i++) this.vert(part, [p.getX(i), p.getY(i), p.getZ(i)], [n.getX(i), n.getY(i), n.getZ(i)], col, s, k);
    geo.dispose();
  }

  /**
   * A body lofted through rings: at each height an outline in plan, a
   * rectangle with rounded corners (its nose and tail radii apart), joined
   * height to height. The side straights break at `xs` (door and window
   * edges) so faces start and stop there. Each face is painted by `paint`
   * at its middle; the top and bottom are closed flat.
   */
  loft(rings: Ring[], xs: number[], paint: (x: number, y: number, z: number, n: V3) => Paint | null, arc = 6, caps: { top: Paint | null; bottom: Paint | null } = { top: null, bottom: null }): void {
    const a = this.lo ? Math.max(2, Math.round(arc / 3)) : Math.round(arc * 1.7);
    // Far off a door's edges need no faces of their own; near, the rings are eased into a smooth section.
    if (this.lo) xs = [];
    else rings = smoothRings(rings, 4);
    const outline = (r: Ring): V2[] => {
      const half: V2[] = [];
      const fx = r.front - r.rf;
      const fz = r.w - r.rf;
      half.push({ x: r.front, z: 0 }, { x: r.front, z: fz * 0.5 });
      for (let k = 0; k <= a; k++) {
        const t = (k / a) * (Math.PI / 2);
        half.push({ x: fx + r.rf * Math.cos(t), z: fz + r.rf * Math.sin(t) });
      }
      const bx = -(r.rear - r.rr);
      const inner = xs.filter((x) => x < fx - 1e-3 && x > bx + 1e-3);
      for (const x of [...xs].sort((p, q) => q - p)) half.push({ x: Math.min(Math.max(x, bx), fx), z: r.w });
      void inner;
      const rz = r.w - r.rr;
      for (let k = 0; k <= a; k++) {
        const t = Math.PI / 2 + (k / a) * (Math.PI / 2);
        half.push({ x: bx + r.rr * Math.cos(t), z: rz + r.rr * Math.sin(t) });
      }
      half.push({ x: -r.rear, z: rz * 0.5 }, { x: -r.rear, z: 0 });
      const other = half.slice(1, -1).map((p) => ({ x: p.x, z: -p.z })).reverse();
      return [...half, ...other];
    };
    const O = rings.map(outline);
    const K = O[0].length;
    const J = rings.length;
    const P = (j: number, k: number): V3 => [O[j][k].x, rings[j].y, O[j][k].z];
    // Smooth normals: each vertex the sum of its faces' (area-weighted), else straight out from the axis.
    const N: V3[][] = O.map((ring) => ring.map(() => [0, 0, 0] as V3));
    const add = (j: number, k: number, n: V3): void => {
      const v = N[j][k];
      v[0] += n[0];
      v[1] += n[1];
      v[2] += n[2];
    };
    const faceN = (p: V3, q: V3, r: V3): V3 => {
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    };
    // Outline points run anticlockwise seen from above (+x, then +z): with j up, (j,k),(j,k+1),(j+1,k+1) faces outward.
    const quads: Array<[number, number]> = [];
    for (let j = 0; j + 1 < J; j++) for (let k = 0; k < K; k++) quads.push([j, k]);
    for (const [j, k] of quads) {
      const k1 = (k + 1) % K;
      const n1 = faceN(P(j, k), P(j + 1, k1), P(j, k1));
      const n2 = faceN(P(j, k), P(j + 1, k), P(j + 1, k1));
      for (const [jj, kk] of [
        [j, k],
        [j, k1],
        [j + 1, k1],
      ] as Array<[number, number]>)
        add(jj, kk, n1);
      for (const [jj, kk] of [
        [j, k],
        [j + 1, k],
        [j + 1, k1],
      ] as Array<[number, number]>)
        add(jj, kk, n2);
    }
    const nrm = (j: number, k: number): V3 => {
      const v = N[j][k];
      const l = Math.hypot(...v);
      if (l > 1e-9) return [v[0] / l, v[1] / l, v[2] / l];
      const p = O[j][k];
      const r = Math.hypot(p.x, p.z) || 1;
      return [p.x / r, 0, p.z / r];
    };
    for (const [j, k] of quads) {
      const k1 = (k + 1) % K;
      const pts = [P(j, k), P(j, k1), P(j + 1, k1), P(j + 1, k)];
      const area = Math.hypot(...faceN(pts[0], pts[1], pts[2])) + Math.hypot(...faceN(pts[0], pts[2], pts[3]));
      if (area < 1e-8) continue;
      const mid: V3 = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2, (pts[0][2] + pts[2][2]) / 2];
      const nm = nrm(j, k);
      const pa = paint(mid[0], mid[1], mid[2], nm);
      if (!pa) continue;
      const ns = [nrm(j, k), nrm(j, k1), nrm(j + 1, k1), nrm(j + 1, k)];
      this.tri(pa.part, pts[0], pts[2], pts[1], ns[0], ns[2], ns[1], pa.colour, pa.surf);
      this.tri(pa.part, pts[0], pts[3], pts[2], ns[0], ns[3], ns[2], pa.colour, pa.surf);
    }
    const cap = (j: number, up: boolean, pa: Paint | null): void => {
      if (!pa) return;
      const r = rings[j];
      const c: V3 = [(r.front - r.rear) / 2, r.y, 0];
      const n: V3 = [0, up ? 1 : -1, 0];
      for (let k = 0; k < K; k++) {
        const p = P(j, k);
        const q = P(j, (k + 1) % K);
        if (up) this.tri(pa.part, c, q, p, n, n, n, pa.colour, pa.surf);
        else this.tri(pa.part, c, p, q, n, n, n, pa.colour, pa.surf);
      }
    };
    cap(J - 1, true, caps.top);
    cap(0, false, caps.bottom);
  }

  /**
   * A mesh modelled in the kit pipeline (tools/kits/kits.py `veh_*`): each
   * face's material code in its colour's red channel ((code + 0.5) / 32),
   * split into the parts and painted by KIT_CODES.
   */
  coded(g: THREE.BufferGeometry): void {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const col = g.attributes.color;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const vs = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
      const code = kitCode(col.getX(vs[0]));
      const spec = KIT_CODES[code];
      if (!spec) continue;
      const kind: RGB = spec.kind ? LAMP_CODE[spec.kind] : [0, 0, 0];
      for (const v of vs) this.vert(spec.part, [pos.getX(v), pos.getY(v), pos.getZ(v)], [nor.getX(v), nor.getY(v), nor.getZ(v)], spec.kind ? (spec.own ?? [1, 1, 1]) : spec.colour, spec.surf, kind);
    }
  }

  /** The gathered part as a geometry: position, normal, colour, surface, and for lamps their kind. */
  part(p: Part): THREE.BufferGeometry | null {
    const d = this.data.get(p)!;
    if (!d.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(d.surf, 2));
    g.setAttribute('lampKind', new THREE.Float32BufferAttribute(d.kind, 3));
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Every part in one geometry for the far level: the glazing as its lit
   * room's colour (the `glow` attribute), the lamps by kind, the rest as
   * painted.
   */
  merged(glow: RGB): THREE.BufferGeometry {
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const surf: number[] = [];
    const kind: number[] = [];
    const gl: number[] = [];
    for (const p of PARTS) {
      const d = this.data.get(p)!;
      const n = d.pos.length / 3;
      pos.push(...d.pos);
      nor.push(...d.nor);
      for (let i = 0; i < n; i++) {
        if (p === 'glass') {
          col.push(0.02, 0.022, 0.025);
          surf.push(0, 0.15);
          gl.push(...glow);
        } else {
          col.push(d.col[i * 3], d.col[i * 3 + 1], d.col[i * 3 + 2]);
          surf.push(d.surf[i * 2], d.surf[i * 2 + 1]);
          gl.push(0, 0, 0);
        }
        kind.push(d.kind[i * 3], d.kind[i * 3 + 1], d.kind[i * 3 + 2]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 2));
    g.setAttribute('lampKind', new THREE.Float32BufferAttribute(kind, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(gl, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Rings eased between the given ones (Catmull-Rom on each measure, kept
 * between its two neighbours so nothing bulges), `per` steps per pair: a
 * roof's turn, a skirt's tuck and a windscreen's rake read as curves, not
 * as steps. The given rings stay, so a band of paint still starts and ends
 * at their heights.
 */
function smoothRings(keys: Ring[], per: number): Ring[] {
  if (keys.length < 2 || per < 2) return keys;
  const out: Ring[] = [];
  const fields: Array<'front' | 'rear' | 'w' | 'rf' | 'rr'> = ['front', 'rear', 'w', 'rf', 'rr'];
  for (let i = 0; i + 1 < keys.length; i++) {
    const p0 = keys[Math.max(i - 1, 0)];
    const p1 = keys[i];
    const p2 = keys[i + 1];
    const p3 = keys[Math.min(i + 2, keys.length - 1)];
    out.push(p1);
    for (let k = 1; k < per; k++) {
      const t = k / per;
      const r = { y: p1.y + (p2.y - p1.y) * t } as Ring;
      for (const f of fields) {
        const v = 0.5 * (2 * p1[f] + (-p0[f] + p2[f]) * t + (2 * p0[f] - 5 * p1[f] + 4 * p2[f] - p3[f]) * t * t + (-p0[f] + 3 * p1[f] - 3 * p2[f] + p3[f]) * t * t * t);
        r[f] = Math.min(Math.max(v, Math.min(p1[f], p2[f])), Math.max(p1[f], p2[f]));
      }
      r.rf = Math.min(r.rf, r.w * 0.999, r.front);
      r.rr = Math.min(r.rr, r.w * 0.999, r.rear);
      out.push(r);
    }
  }
  out.push(keys[keys.length - 1]);
  return out;
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);
/** The kit pipeline's material codes (tools/kits/kits.py VEH): what each coded face is drawn in. */
const KIT_CODES: Record<number, { part: Part; colour: RGB; surf: Surf; kind?: LampKind; own?: RGB }> = {
  1: { part: 'body', colour: lin('#8e959b'), surf: [0.9, 0.34] },
  2: { part: 'body', colour: lin('#777a7d'), surf: [0.85, 0.42] },
  3: { part: 'body', colour: lin('#3a4348'), surf: [0.25, 0.32] },
  4: { part: 'body', colour: lin('#1f6b6e'), surf: [0.1, 0.32] },
  5: { part: 'trim', colour: lin('#24262a'), surf: [0.3, 0.7] },
  6: { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] },
  7: { part: 'trim', colour: lin('#0c0d0e'), surf: [0.3, 0.55] },
  8: { part: 'trim', colour: lin('#2f2d2a'), surf: [0.55, 0.55] },
  9: { part: 'trim', colour: lin('#4a4540'), surf: [0.9, 0.32] },
  10: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'head' },
  11: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'tail' },
  12: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'board', own: [2.6, 1.15, 0.2] },
  13: { part: 'body', colour: lin('#ddd4bf'), surf: [0, 0.28] },
  14: { part: 'body', colour: lin('#25272a'), surf: [0.1, 0.42] },
  15: { part: 'body', colour: lin('#1c1e21'), surf: [0.2, 0.16] },
  16: { part: 'trim', colour: lin('#a3a19c'), surf: [0.92, 0.25] },
  17: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'white' },
  18: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'red' },
  19: { part: 'lamp', colour: [1, 1, 1], surf: [0, 1], kind: 'always', own: [1.3, 0.62, 0.12] },
  20: { part: 'trim', colour: lin('#111112'), surf: [0, 0.85] },
  21: { part: 'trim', colour: lin('#151618'), surf: [0.2, 0.55] },
  22: { part: 'body', colour: lin('#3d5c62'), surf: [0.15, 0.3] },
};

/** How a modelled mesh's triangles split by its codes: per part, per lamp kind, and any whose code is unknown. */
export function codedParts(g: THREE.BufferGeometry): { parts: Record<Part, number>; kinds: Record<string, number>; unknown: number; total: number } {
  const col = g.attributes.color;
  const idx = g.index;
  const n = (idx ? idx.count : g.attributes.position.count) / 3;
  const parts: Record<Part, number> = { body: 0, trim: 0, glass: 0, lamp: 0 };
  const kinds: Record<string, number> = {};
  let unknown = 0;
  for (let i = 0; i < n; i++) {
    const v = idx ? idx.getX(i * 3) : i * 3;
    const spec = KIT_CODES[kitCode(col.getX(v))];
    if (!spec) {
      unknown++;
      continue;
    }
    parts[spec.part]++;
    if (spec.kind) kinds[spec.kind] = (kinds[spec.kind] ?? 0) + 1;
  }
  return { parts, kinds, unknown, total: n };
}

/** A face's code from its colour's red channel ((code + 0.5) / 32, as kits.py writes it). */
function kitCode(r: number): number {
  return Math.floor(r * 32);
}

/** Triangles per part of a model's near level as built now (tests: the kit meshes or the procedural stand-ins). */
export function modelParts(name: ModelName): Record<Part, number> {
  const kit = new Kit(false);
  MODELS[name].build(kit);
  const out: Record<Part, number> = { body: 0, trim: 0, glass: 0, lamp: 0 };
  for (const p of PARTS) {
    const g = kit.part(p);
    if (g) {
      out[p] = g.attributes.position.count / 3;
      g.dispose();
    }
  }
  return out;
}

/** A lifebuoy: 0.6 m across. */
const RING = new THREE.TorusGeometry(0.26, 0.055, 6, 14);
const CYLS = new Map<number, THREE.BufferGeometry>();
function cylinderOf(seg: number): THREE.BufferGeometry {
  let g = CYLS.get(seg);
  if (!g) CYLS.set(seg, (g = new THREE.CylinderGeometry(1, 1, 1, seg, 1)));
  return g;
}

/** Where a ring's outline stands at lateral z on its nose (+x end): for placing lamps on a rounded front. */
function noseAt(r: Ring, z: number): { x: number; yaw: number } {
  const fz = r.w - r.rf;
  const az = Math.abs(z);
  if (az <= fz) return { x: r.front, yaw: 0 };
  const dz = Math.min(az - fz, r.rf * 0.999);
  const dx = Math.sqrt(r.rf * r.rf - dz * dz);
  // The face's outward normal, turned toward the side.
  const ang = Math.atan2(dz, dx) * Math.sign(z || 1);
  return { x: r.front - r.rf + dx, yaw: -ang };
}

/** A lamp lens flush on a nose: a thin box turned to the surface there. */
function noseLamp(kit: Kit, r: Ring, z: number, y: number, w: number, h: number, kind: LampKind, col: RGB): void {
  const at = noseAt(r, z);
  kit.box('lamp', [at.x + 0.004 * Math.cos(at.yaw), y, z - 0.004 * Math.sin(at.yaw)], [0.03, h, w], col, [0, 1], kind, at.yaw);
}

/** A thin band round a nose at height y: a windscreen's gasket. */
function noseBar(kit: Kit, r: Ring, y: number, h: number, col: RGB): void {
  const n = 9;
  let prev: V3 | null = null;
  for (let k = 0; k <= n; k++) {
    const z = -r.w * 0.98 + (2 * r.w * 0.98 * k) / n;
    const at = noseAt(r, z);
    const p: V3 = [at.x + 0.006, y, z];
    if (prev) kit.bar('trim', prev, p, 0.02, h, col, [0.2, 0.4]);
    prev = p;
  }
}

/** Per model: its glazing's room (a box in the car's frame), the light in it, and its windows' rhythm. */
interface Interior {
  min: V3;
  max: V3;
  light: RGB;
  seat: RGB;
  sill: number;
  head: number;
  pitch: number;
  pillar: number;
  pillarAt: number;
  doors: number[];
  doorW: number;
  seats: boolean;
  crowd: number;
  /** A driver's cab behind the windscreen, past the saloon's front wall. */
  driver?: boolean;
  /** Light lines down the ceiling (a cab's small cabin has a soft dome light instead). */
  lines?: boolean;
}

const WARM: RGB = [1.0, 0.72, 0.46];
const COOL: RGB = [0.92, 0.96, 1.0];
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

// ---- the tram: two low-floor sections, oxblood under a cream upper, a gold line, a raked windscreen.

const TRAM_RINGS: Ring[] = [
  { y: 0.1, front: 6.86, rear: 7.0, w: 1.12, rf: 0.88, rr: 0.1 },
  { y: 0.2, front: 6.98, rear: 7.06, w: 1.2, rf: 0.95, rr: 0.11 },
  { y: 0.38, front: 7.05, rear: 7.1, w: 1.245, rf: 1.0, rr: 0.12 },
  { y: 0.66, front: 7.1, rear: 7.1, w: 1.265, rf: 1.03, rr: 0.12 },
  { y: 0.92, front: 7.12, rear: 7.1, w: 1.27, rf: 1.05, rr: 0.12 },
  { y: 0.97, front: 7.12, rear: 7.1, w: 1.27, rf: 1.05, rr: 0.12 },
  { y: 1.02, front: 7.11, rear: 7.1, w: 1.27, rf: 1.05, rr: 0.12 },
  { y: 1.7, front: 6.98, rear: 7.1, w: 1.262, rf: 1.02, rr: 0.12 },
  { y: 2.32, front: 6.72, rear: 7.1, w: 1.245, rf: 0.96, rr: 0.12 },
  { y: 2.4, front: 6.69, rear: 7.1, w: 1.24, rf: 0.95, rr: 0.12 },
  { y: 2.76, front: 6.52, rear: 7.1, w: 1.22, rf: 0.9, rr: 0.12 },
  { y: 2.96, front: 6.42, rear: 7.08, w: 1.14, rf: 0.86, rr: 0.12 },
  { y: 3.08, front: 6.3, rear: 7.06, w: 0.96, rf: 0.76, rr: 0.12 },
  { y: 3.16, front: 6.18, rear: 7.04, w: 0.62, rf: 0.56, rr: 0.12 },
  { y: 3.2, front: 6.06, rear: 7.02, w: 0.26, rf: 0.25, rr: 0.1 },
];
const TRAM_DOORS = [3.1, -3.7];
const TRAM_DOOR_W = 1.3;

function tramModel(kit: Kit): void {
  const oxblood = lin('#5b1915');
  const gold = lin('#a8843f');
  const cream = lin('#e4dac2');
  const roof = lin('#8e8d89');
  const skirt = lin('#26272a');
  const paint: Surf = [0, 0.38];
  const door = (x: number): boolean => TRAM_DOORS.some((d) => Math.abs(x - d) < TRAM_DOOR_W / 2);
  const xs = [5.6, ...TRAM_DOORS.flatMap((d) => [d + TRAM_DOOR_W / 2, d - TRAM_DOOR_W / 2]), 0.6, -1.4, -5.9, -6.9];
  kit.loft(
    TRAM_RINGS,
    xs,
    (x, y, z, n) => {
      if (y < 0.38) return { part: 'body', colour: skirt, surf: [0.15, 0.55] };
      const rearFace = x < -6.98 && n[0] < -0.5;
      if (!rearFace && y > 1.02 && y < 2.32) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      if (!rearFace && Math.abs(z) > 0.9 && door(x) && y > 0.38 && y < 2.32) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      // A little grime toward the skirt.
      const grime = 0.86 + 0.14 * Math.min(1, (y - 0.38) / 0.5);
      if (y < 0.92) return { part: 'body', colour: scale(oxblood, grime), surf: paint };
      if (y < 0.97) return { part: 'body', colour: gold, surf: [0.6, 0.35] };
      if (y < 2.76) return { part: 'body', colour: cream, surf: paint };
      return { part: 'body', colour: roof, surf: [0.2, 0.55] };
    },
    7,
    { top: { part: 'body', colour: roof, surf: [0.2, 0.6] }, bottom: { part: 'trim', colour: skirt, surf: [0.2, 0.8] } },
  );
  const dark = lin('#1b1c1e');
  const steel = lin('#6c6e70');
  // The articulation's bellows on the tail.
  kit.box('trim', [-7.27, 1.7, 0], [0.36, 2.5, 2.22], lin('#111214'), [0, 0.9]);
  if (!kit.lo) for (let y = 0.6; y < 2.9; y += 0.16) kit.box('trim', [-7.27, y, 0], [0.4, 0.035, 2.26], lin('#1a1b1d'), [0, 0.8]);
  // Roof equipment: the converter and air-conditioning housings.
  kit.box('body', [-1.1, 3.36, 0], [6.6, 0.32, 1.7], lin('#9c9b97'), [0.2, 0.5]);
  kit.box('body', [-5.3, 3.3, 0], [1.6, 0.22, 1.5], lin('#9c9b97'), [0.2, 0.5]);
  kit.box('trim', [-1.1, 3.53, 0], [6.4, 0.02, 1.5], lin('#5e5d5a'), [0.3, 0.6]);
  // The pantograph, raised to the contact wire: base on insulators, lower and upper arms, the collector head.
  const px = 1.1;
  const wire = CONTACT_Y - RAIL_HEAD.tram;
  kit.box('trim', [px, 3.6, 0], [1.3, 0.08, 1.1], dark, [0.6, 0.5]);
  for (const sx of [-0.5, 0.5]) for (const sz of [-0.42, 0.42]) kit.rod('trim', [px + sx, 3.52, sz], [px + sx, 3.6, sz], 0.05, lin('#b9b2a2'), [0, 0.4], 8);
  for (const sz of [-0.28, 0.28]) {
    kit.rod('trim', [px - 0.55, 3.66, sz], [px + 0.75, 4.7, sz * 0.4], 0.035, steel, [0.8, 0.4]);
    kit.rod('trim', [px + 0.75, 4.7, sz * 0.4], [px - 0.05, wire - 0.08, sz * 0.9], 0.028, steel, [0.8, 0.4]);
  }
  kit.bar('trim', [px - 0.05, wire - 0.03, -0.85], [px - 0.05, wire - 0.03, 0.85], 0.07, 0.05, steel, [0.8, 0.35]);
  for (const sz of [-1, 1]) kit.bar('trim', [px - 0.05, wire - 0.03, sz * 0.85], [px - 0.05, wire - 0.2, sz * 1.02], 0.05, 0.04, steel, [0.8, 0.35]);
  // The door frames (rubber edges and the leaves' meeting stile) and a green door-release light.
  if (!kit.lo) {
    for (const d of TRAM_DOORS) {
      for (const sz of [-1, 1]) {
        const z = sz * 1.275;
        for (const e of [-TRAM_DOOR_W / 2, TRAM_DOOR_W / 2]) kit.box('trim', [d + e, 1.35, z], [0.05, 1.95, 0.02], dark, [0, 0.6]);
        kit.box('trim', [d, 2.33, z], [TRAM_DOOR_W + 0.05, 0.05, 0.02], dark, [0, 0.6]);
        kit.box('lamp', [d + TRAM_DOOR_W / 2 + 0.09, 1.25, sz * 1.282], [0.05, 0.05, 0.01], [0.2, 1.6, 0.5], [0, 1], 'always');
        kit.box('trim', [d, 0.36, sz * 1.25], [TRAM_DOOR_W, 0.03, 0.06], lin('#8a8780'), [0.9, 0.35]);
      }
    }
    // Camera arms instead of mirrors, either side of the windscreen.
    for (const sz of [-1, 1]) {
      kit.bar('trim', [6.45, 2.1, sz * 1.2], [6.6, 2.12, sz * 1.42], 0.04, 0.05, dark);
      kit.box('trim', [6.62, 2.06, sz * 1.44], [0.22, 0.12, 0.09], dark, [0.2, 0.5]);
    }
    // The coupler cover under the nose.
    kit.box('trim', [6.95, 0.3, 0], [0.3, 0.16, 0.7], skirt, [0.2, 0.6]);
  }
  if (!kit.lo) {
    // Panel seams down the lower body and the cant rail, where the sections' side panels meet.
    for (const sz of [-1, 1]) {
      for (const x of [5.4, 1.2, -1.6, -5.5]) {
        kit.box('trim', [x, 0.65, sz * 1.268], [0.012, 0.5, 0.008], lin('#2a0c0a'), [0, 0.5]);
        kit.box('trim', [x, 2.55, sz * 1.238], [0.012, 0.3, 0.008], lin('#8f877a'), [0, 0.5]);
      }
      // The skirt's lip.
      kit.box('trim', [-0.2, 0.38, sz * 1.25], [13.2, 0.025, 0.012], lin('#121314'), [0.3, 0.5]);
    }
  }
  // The bogies' running gear, shadowed under the skirt.
  for (const bx of [-4.3, 4.3]) kit.box('trim', [bx, 0.11, 0], [2.0, 0.22, 1.9], lin('#0d0d0e'), [0.3, 0.8]);
  // Lamps: twin headlamps and tail lamps low on the nose, the destination display over the windscreen.
  const low = TRAM_RINGS[2];
  for (const sz of [-1, 1]) {
    noseLamp(kit, low, sz * 0.74, 0.66, 0.3, 0.11, 'head', [1, 1, 1]);
    noseLamp(kit, low, sz * 1.0, 0.66, 0.1, 0.13, 'tail', [1, 1, 1]);
  }
  // The destination display: an amber dot-matrix board (the lamp shader's ledBoard), not a lit slab; a slab at
  // that size and level bloomed to a white billboard over the windscreen.
  noseLamp(kit, TRAM_RINGS[8], 0, 2.53, 1.25, 0.2, 'tramBoard', [1.5, 0.72, 0.16]);
  if (!kit.lo) {
    // Two wipers parked at the foot of the windscreen.
    for (const sz of [-0.45, 0.35]) kit.bar('trim', [7.08, 1.06, sz - 0.3], [7.0, 1.42, sz + 0.25], 0.03, 0.02, lin('#0b0b0c'), [0.3, 0.5]);
  }
}

const TRAM_INTERIOR: Interior = {
  min: [-6.9, 0.36, -1.2],
  max: [6.4, 2.6, 1.2],
  light: scale(WARM, 1.2),
  seat: lin('#4a3a52'),
  sill: 1.02,
  head: 2.32,
  pitch: 1.55,
  pillar: 0.11,
  pillarAt: 0.35,
  doors: TRAM_DOORS,
  doorW: TRAM_DOOR_W,
  seats: true,
  crowd: 0.32,
  driver: true,
};

// ---- the elevated train: stainless cars with a painted nose, teal doors and stripe, bogies under each end.

const RAIL_RINGS = (nose: boolean): Ring[] => {
  const f = (v: number): number => (nose ? v : 7.6);
  const r = (v: number): number => (nose ? v : 0.12);
  return [
    { y: 0.85, front: f(7.35), rear: 7.6, w: 1.36, rf: r(0.9), rr: 0.12 },
    { y: 1.02, front: f(7.52), rear: 7.6, w: 1.4, rf: r(1.0), rr: 0.12 },
    { y: 1.45, front: f(7.6), rear: 7.6, w: 1.42, rf: r(1.05), rr: 0.12 },
    { y: 1.6, front: f(7.6), rear: 7.6, w: 1.42, rf: r(1.05), rr: 0.12 },
    { y: 1.78, front: f(7.58), rear: 7.6, w: 1.42, rf: r(1.05), rr: 0.12 },
    { y: 2.85, front: f(7.12), rear: 7.6, w: 1.4, rf: r(0.96), rr: 0.12 },
    { y: 3.3, front: f(6.95), rear: 7.6, w: 1.36, rf: r(0.9), rr: 0.12 },
    { y: 3.55, front: f(6.8), rear: 7.58, w: 1.2, rf: r(0.82), rr: 0.12 },
    { y: 3.68, front: f(6.7), rear: 7.56, w: 0.86, rf: r(0.6), rr: 0.12 },
    { y: 3.75, front: f(6.6), rear: 7.54, w: 0.4, rf: r(0.38), rr: 0.1 },
  ];
};
const RAIL_DOORS = [3.4, -3.4];
const RAIL_DOOR_W = 1.4;

function railModel(kit: Kit, nose: boolean): void {
  // Near, the cab car is the modelled one from the kit pipeline (its shell subdivided, its gear and lamps on it).
  if (nose && !kit.lo && hasKit('veh_railEnd')) {
    kit.coded(kitShared('veh_railEnd'));
    kit.coded(kitShared('veh_railEnd_gear'));
    return;
  }
  const steel = lin('#8d9093');
  const mask = lin('#2b3d42');
  const teal = lin('#1f6b6e');
  const under = lin('#24262a');
  const rings = RAIL_RINGS(nose);
  const door = (x: number): boolean => RAIL_DOORS.some((d) => Math.abs(x - d) < RAIL_DOOR_W / 2);
  const xs = [6.0, ...RAIL_DOORS.flatMap((d) => [d + RAIL_DOOR_W / 2, d - RAIL_DOOR_W / 2]), 0, -6.0];
  kit.loft(
    rings,
    xs,
    (x, y, z, n) => {
      if (y < 1.02) return { part: 'trim', colour: under, surf: [0.3, 0.7] };
      const endFace = Math.abs(n[0]) > 0.5 && (x < -7.4 || (!nose && x > 7.4));
      const front = nose && x > 6.1;
      if (!endFace && y > 1.78 && y < 2.85) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      if (front) return { part: 'body', colour: mask, surf: [0.1, 0.32] };
      if (Math.abs(z) > 1.0 && door(x) && y < 2.85) return { part: 'body', colour: teal, surf: [0.1, 0.35] };
      if (y > 1.45 && y < 1.6) return { part: 'body', colour: teal, surf: [0.1, 0.35] };
      if (y > 3.3) return { part: 'body', colour: scale(steel, 0.86), surf: [0.85, 0.4] };
      return { part: 'body', colour: steel, surf: [0.88, 0.3] };
    },
    7,
    { top: { part: 'body', colour: scale(steel, 0.8), surf: [0.8, 0.45] }, bottom: { part: 'trim', colour: under, surf: [0.2, 0.8] } },
  );
  const dark = lin('#141517');
  const iron = lin('#2c2b29');
  // Gangway bellows at each end that couples to another car.
  const ends = nose ? [-1] : [-1, 1];
  for (const e of ends) kit.box('trim', [e * 7.8, 2.2, 0], [0.4, 2.3, 1.7], lin('#0f1012'), [0, 0.9]);
  // Under-floor equipment cases between the bogies.
  kit.box('trim', [0, 0.72, 0], [6.0, 0.36, 2.2], lin('#1c1d20'), [0.3, 0.7]);
  // Bogies: side frames, wheels, axle boxes.
  for (const bx of [-5.3, 5.3]) {
    kit.box('trim', [bx, 0.62, 0], [2.6, 0.3, 2.05], iron, [0.4, 0.6]);
    if (!kit.lo) {
      for (const sz of [-1, 1]) kit.box('trim', [bx, 0.5, sz * 1.0], [2.4, 0.32, 0.12], iron, [0.4, 0.6]);
      for (const ax of [-1.1, 1.1]) {
        for (const sz of [-1, 1]) {
          kit.geometry('trim', cylinderOf(14), new THREE.Matrix4().compose(new THREE.Vector3(bx + ax, 0.42, sz * 0.72), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(0.42, 0.12, 0.42)), lin('#3a3633'), [0.85, 0.35]);
          kit.box('trim', [bx + ax, 0.42, sz * 1.08], [0.32, 0.26, 0.12], dark, [0.3, 0.6]);
        }
        kit.rod('trim', [bx + ax, 0.42, -0.8], [bx + ax, 0.42, 0.8], 0.07, iron);
      }
    }
  }
  // Roof: air-conditioning units.
  for (const rx of [-4.2, 4.2]) kit.box('body', [rx, 3.86, 0], [2.6, 0.25, 1.5], lin('#7d8083'), [0.7, 0.45]);
  // Door seams, and a grab rail beside each doorway.
  if (!kit.lo) {
    for (const d of RAIL_DOORS) for (const sz of [-1, 1]) {
      for (const e of [-1, 1]) kit.rod('trim', [d + e * (RAIL_DOOR_W / 2 + 0.12), 1.3, sz * 1.46], [d + e * (RAIL_DOOR_W / 2 + 0.12), 2.4, sz * 1.46], 0.018, lin('#b9b7b2'), [0.9, 0.25], 8);
      kit.box('trim', [d, 1.95, sz * 1.425], [0.03, 1.9, 0.02], dark);
      for (const e of [-RAIL_DOOR_W / 2, RAIL_DOOR_W / 2]) kit.box('trim', [d + e, 1.95, sz * 1.425], [0.04, 1.9, 0.02], dark);
    }
  }
  if (nose) {
    const low = rings[2];
    for (const sz of [-1, 1]) {
      noseLamp(kit, low, sz * 0.92, 1.28, 0.24, 0.08, 'head', [1, 1, 1]);
      noseLamp(kit, low, sz * 1.16, 1.28, 0.1, 0.1, 'tail', [1, 1, 1]);
    }
    noseLamp(kit, rings[5], 0, 3.05, 0.95, 0.13, 'always', [1.5, 0.75, 0.16]);
    // The windscreen's black surround and its wiper.
    if (!kit.lo) {
      const head = rings[5];
      const sill = rings[4];
      for (const [r, y] of [
        [sill, 1.8],
        [head, 2.83],
      ] as Array<[Ring, number]>)
        noseBar(kit, r, y, 0.05, lin('#08090a'));
      kit.bar('trim', [7.6, 1.86, -0.15], [7.48, 2.3, 0.45], 0.03, 0.02, lin('#0b0b0c'), [0.3, 0.5]);
    }
    // The obstacle deflector under the nose, and the coupler: a shank out of its pocket and a head with its horn.
    kit.box('trim', [7.3, 0.62, 0], [0.22, 0.44, 2.3], lin('#202225'), [0.4, 0.55]);
    kit.box('trim', [7.52, 1.02, 0], [0.12, 0.3, 0.5], lin('#0c0c0d'), [0.2, 0.8]);
    kit.rod('trim', [7.4, 0.98, 0], [7.95, 0.98, 0], 0.07, lin('#3c3a37'), [0.8, 0.4], 10);
    kit.box('trim', [7.98, 0.98, 0], [0.12, 0.26, 0.34], lin('#4a4743'), [0.85, 0.35]);
    kit.box('trim', [8.02, 0.86, 0.12], [0.1, 0.12, 0.08], lin('#4a4743'), [0.85, 0.35]);
    if (!kit.lo) {
      // The front's detrainment door: its seams up the nose either side of the middle, and its handle.
      for (const z of [-0.42, 0.42]) {
        const pts: V3[] = [];
        for (let k = 0; k <= 8; k++) {
          const y = 1.05 + (2.82 - 1.05) * (k / 8);
          const r = rings.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
          pts.push([noseAt(r, z).x + 0.008, y, z]);
        }
        for (let k = 1; k < pts.length; k++) kit.bar('trim', pts[k - 1], pts[k], 0.018, 0.012, lin('#0a0b0c'), [0.2, 0.5]);
      }
      kit.box('trim', [noseAt(rings[3], 0.3).x + 0.02, 1.62, 0.3], [0.03, 0.05, 0.14], lin('#9a9893'), [0.9, 0.3]);
      // Bezels round the headlamps.
      for (const sz of [-1, 1]) {
        const at = noseAt(rings[2], sz * 0.98);
        kit.box('trim', [at.x - 0.004, 1.28, sz * 0.98], [0.02, 0.16, 0.5], lin('#0d0e0f'), [0.5, 0.3], undefined, at.yaw);
      }
    }
  }
}

const RAIL_INTERIOR = (nose: boolean): Interior => ({
  min: [-7.5, 0.95, -1.33],
  max: [nose ? 6.4 : 7.5, 3.15, 1.33],
  light: scale(COOL, 1.35),
  seat: lin('#2e4c5a'),
  sill: 1.78,
  head: 2.85,
  pitch: 1.7,
  pillar: 0.14,
  pillarAt: 0.85,
  doors: RAIL_DOORS,
  doorW: RAIL_DOOR_W,
  seats: true,
  crowd: 0.4,
  driver: nose,
});

// ---- the pod: a white capsule on its beam, glazed all round, a lit line along its foot.

const POD_RINGS: Ring[] = [
  { y: 0.14, front: 2.72, rear: 2.72, w: 0.86, rf: 0.84, rr: 0.84 },
  { y: 0.3, front: 2.96, rear: 2.96, w: 0.97, rf: 0.95, rr: 0.95 },
  { y: 0.55, front: 3.06, rear: 3.06, w: 0.995, rf: 0.97, rr: 0.97 },
  { y: 0.88, front: 3.1, rear: 3.1, w: 1.0, rf: 0.98, rr: 0.98 },
  { y: 1.5, front: 3.06, rear: 3.06, w: 0.995, rf: 0.97, rr: 0.97 },
  { y: 2.02, front: 2.94, rear: 2.94, w: 0.96, rf: 0.94, rr: 0.94 },
  { y: 2.28, front: 2.7, rear: 2.7, w: 0.85, rf: 0.83, rr: 0.83 },
  { y: 2.44, front: 2.32, rear: 2.32, w: 0.62, rf: 0.6, rr: 0.6 },
  { y: 2.51, front: 1.8, rear: 1.8, w: 0.3, rf: 0.29, rr: 0.29 },
];
const POD_DOOR_W = 1.5;

function podModel(kit: Kit): void {
  const white = lin('#e6e3dc');
  const graphite = lin('#2a2c2f');
  const xs = [1.6, POD_DOOR_W / 2, -POD_DOOR_W / 2, -1.6];
  kit.loft(
    POD_RINGS,
    xs,
    (x, y, z) => {
      if (y < 0.3) return { part: 'body', colour: graphite, surf: [0.2, 0.5] };
      if (y > 0.88 && y < 2.02) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      if (Math.abs(z) > 0.7 && Math.abs(x) < POD_DOOR_W / 2 && y < 2.02) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      return { part: 'body', colour: white, surf: [0.05, 0.28] };
    },
    10,
    { top: { part: 'body', colour: white, surf: [0.05, 0.3] }, bottom: { part: 'trim', colour: graphite, surf: [0.2, 0.7] } },
  );
  // The running gear straddling the beam's top.
  kit.box('trim', [0, 0.07, 0], [4.4, 0.14, 1.25], lin('#18191b'), [0.4, 0.6]);
  // A cool lit line along each side at the foot, matching the beams' own.
  for (const sz of [-1, 1]) kit.box('lamp', [0, 0.33, sz * 0.975], [3.6, 0.03, 0.02], [0.55, 0.85, 1.3], [0, 1], 'always');
  for (const e of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const at = noseAt(POD_RINGS[2], sz * 0.5);
      kit.box('lamp', [e * (at.x + 0.004), 0.62, sz * 0.5], [0.03, 0.05, 0.32], [1, 1, 1], [0, 1], e > 0 ? 'fore' : 'aft', e > 0 ? at.yaw : Math.PI - at.yaw);
    }
  }
  if (!kit.lo) for (const sz of [-1, 1]) kit.box('trim', [0, 1.45, sz * 1.0], [0.03, 1.12, 0.02], lin('#bdb9b1'), [0.3, 0.4]);
}

const POD_INTERIOR: Interior = {
  min: [-2.6, 0.36, -0.92],
  max: [2.6, 2.25, 0.92],
  light: scale(COOL, 1.25),
  seat: lin('#4e5862'),
  sill: 0.88,
  head: 2.02,
  pitch: 6.0,
  pillar: 0.0,
  pillarAt: 0,
  doors: [0],
  doorW: POD_DOOR_W,
  seats: true,
  crowd: 0.22,
};

// ---- the ferry: a low double-ended river bus, navy hull, a white saloon glazed all round, a wheelhouse amidships.

const HULL: Ring[] = [
  { y: -1.32, front: 8.4, rear: 8.4, w: 1.2, rf: 1.19, rr: 1.19 },
  { y: -1.14, front: 9.7, rear: 9.7, w: 2.35, rf: 2.34, rr: 2.34 },
  { y: -0.86, front: 10.35, rear: 10.35, w: 2.82, rf: 2.8, rr: 2.8 },
  { y: -0.4, front: 10.78, rear: 10.78, w: 3.04, rf: 3.0, rr: 3.0 },
  { y: -0.12, front: 10.95, rear: 10.95, w: 3.1, rf: 3.05, rr: 3.05 },
  { y: 0.04, front: 11.06, rear: 11.06, w: 3.18, rf: 3.12, rr: 3.12 },
  { y: 0.2, front: 11.02, rear: 11.02, w: 3.14, rf: 3.08, rr: 3.08 },
];
const SALOON: Ring[] = [
  { y: 0.2, front: 7.3, rear: 7.3, w: 2.72, rf: 1.7, rr: 1.7 },
  { y: 0.98, front: 7.3, rear: 7.3, w: 2.72, rf: 1.7, rr: 1.7 },
  { y: 2.0, front: 7.12, rear: 7.12, w: 2.66, rf: 1.62, rr: 1.62 },
  { y: 2.22, front: 7.06, rear: 7.06, w: 2.62, rf: 1.6, rr: 1.6 },
  { y: 2.36, front: 6.9, rear: 6.9, w: 2.42, rf: 1.45, rr: 1.45 },
];
const WHEELHOUSE: Ring[] = [
  { y: 2.36, front: 1.55, rear: 1.55, w: 1.35, rf: 0.5, rr: 0.5 },
  { y: 2.78, front: 1.55, rear: 1.55, w: 1.35, rf: 0.5, rr: 0.5 },
  { y: 3.36, front: 1.45, rear: 1.45, w: 1.3, rf: 0.46, rr: 0.46 },
  { y: 3.5, front: 1.4, rear: 1.4, w: 1.22, rf: 0.42, rr: 0.42 },
];

function ferryModel(kit: Kit): void {
  const navy = lin('#16222f');
  const red = lin('#6a1c17');
  const white = lin('#e7e5df');
  const black = lin('#0c0c0d');
  const deck = lin('#3a4541');
  kit.loft(
    HULL,
    [6, 2, -2, -6],
    (_x, y) => {
      if (y < -0.86 && y > -1.32) return { part: 'body', colour: y < -1.14 ? scale(red, 0.7) : red, surf: [0, 0.5] };
      if (y > -0.12 && y < 0.2) return { part: 'trim', colour: black, surf: [0, 0.75] };
      if (y > -0.4) return { part: 'body', colour: white, surf: [0, 0.35] };
      return { part: 'body', colour: navy, surf: [0.1, 0.35] };
    },
    10,
    { top: { part: 'trim', colour: deck, surf: [0, 0.8] }, bottom: { part: 'body', colour: red, surf: [0, 0.6] } },
  );
  kit.loft(
    SALOON,
    [4.5, 0.7, -0.7, -4.5],
    (x, y, z) => {
      if (y > 0.98 && y < 2.0) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      if (Math.abs(z) > 2.0 && Math.abs(x) < 0.7 && y < 2.0) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      return { part: 'body', colour: white, surf: [0, 0.35] };
    },
    8,
    { top: { part: 'body', colour: scale(white, 0.92), surf: [0, 0.5] }, bottom: null },
  );
  kit.loft(
    WHEELHOUSE,
    [0.5, -0.5],
    (_x, y) => (y > 2.78 && y < 3.36 ? { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] } : { part: 'body', colour: white, surf: [0, 0.35] }),
    5,
    { top: { part: 'body', colour: scale(white, 0.9), surf: [0, 0.5] }, bottom: null },
  );
  const iron = lin('#d8d6d0');
  // Railings round the open deck at each end: stanchions and two rails following the gunwale.
  if (!kit.lo) {
    const gun = HULL[HULL.length - 1];
    for (const e of [-1, 1]) {
      const pts: V3[] = [];
      for (let k = 0; k <= 10; k++) {
        const t = (k / 10) * Math.PI - Math.PI / 2;
        const z = Math.sin(t) * (gun.w - 0.12);
        const at = noseAt({ ...gun, front: gun.front - 0.12, w: gun.w - 0.12, rf: gun.rf - 0.12 }, z);
        pts.push([e * at.x, 0.2, z]);
      }
      for (const p of pts) kit.rod('trim', p, [p[0], 1.15, p[2]], 0.025, iron, [0.7, 0.4], 6);
      for (const h of [0.68, 1.15]) for (let k = 1; k < pts.length; k++) kit.rod('trim', [pts[k - 1][0], h, pts[k - 1][2]], [pts[k][0], h, pts[k][2]], 0.022, iron, [0.7, 0.4], 6);
    }
    // Life rings on the saloon's ends, and the mast.
    for (const e of [-1, 1]) for (const sz of [-1, 1]) kit.geometry('trim', RING, new THREE.Matrix4().compose(new THREE.Vector3(e * 7.33, 1.5, sz * 1.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1)), lin('#c8501c'), [0, 0.6]);
  }
  kit.rod('trim', [0, 3.5, 0], [0, 5.6, 0], 0.05, iron);
  kit.box('lamp', [0, 5.65, 0], [0.12, 0.12, 0.12], [3, 2.8, 2.5], [0, 1], 'always');
  // Side lights on the wheelhouse: red to port, green to starboard (each end's own port is the other's starboard: a double-ender shows both).
  kit.box('lamp', [0, 3.3, -1.36], [0.22, 0.12, 0.06], [3.2, 0.15, 0.08], [0, 1], 'always');
  kit.box('lamp', [0, 3.3, 1.36], [0.22, 0.12, 0.06], [0.1, 2.6, 0.6], [0, 1], 'always');
  // Deck lights under the saloon's eaves at each end.
  for (const e of [-1, 1]) kit.box('lamp', [e * 7.0, 2.3, 0], [0.04, 0.05, 1.4], scale(WARM, 2.2), [0, 1], 'always');
  // The bow lamps, white leading, red trailing.
  for (const e of [-1, 1]) kit.box('lamp', [e * 10.9, 0.5, 0], [0.06, 0.12, 0.3], [1, 1, 1], [0, 1], e > 0 ? 'fore' : 'aft');
}

const FERRY_INTERIOR: Interior = {
  min: [-7.0, 0.2, -2.55],
  max: [7.0, 2.22, 2.55],
  light: scale(WARM, 1.5),
  seat: lin('#283a52'),
  sill: 0.98,
  head: 2.0,
  pitch: 1.4,
  pillar: 0.09,
  pillarAt: 0.0,
  doors: [0],
  doorW: 1.4,
  seats: true,
  crowd: 0.18,
};

// ---- the cab: a compact autonomous car, cream with a graphite foot, a glass canopy and an amber roof light.

const CAB_RINGS: Ring[] = [
  { y: 0.18, front: 1.86, rear: 1.84, w: 0.84, rf: 0.62, rr: 0.6 },
  { y: 0.32, front: 1.95, rear: 1.93, w: 0.89, rf: 0.72, rr: 0.66 },
  { y: 0.6, front: 1.98, rear: 1.96, w: 0.905, rf: 0.78, rr: 0.7 },
  { y: 0.84, front: 1.93, rear: 1.94, w: 0.9, rf: 0.78, rr: 0.7 },
  { y: 0.9, front: 1.86, rear: 1.92, w: 0.885, rf: 0.76, rr: 0.68 },
  { y: 1.05, front: 1.58, rear: 1.8, w: 0.855, rf: 0.7, rr: 0.64 },
  { y: 1.34, front: 0.98, rear: 1.4, w: 0.77, rf: 0.56, rr: 0.56 },
  { y: 1.45, front: 0.72, rear: 1.18, w: 0.68, rf: 0.5, rr: 0.5 },
  { y: 1.5, front: 0.5, rear: 0.95, w: 0.5, rf: 0.42, rr: 0.42 },
  { y: 1.53, front: 0.32, rear: 0.75, w: 0.3, rf: 0.28, rr: 0.28 },
];

function cabModel(kit: Kit): void {
  if (!kit.lo && hasKit('veh_cab')) {
    kit.coded(kitShared('veh_cab'));
    kit.coded(kitShared('veh_cab_gear'));
    return;
  }
  const cream = lin('#ddd4bf');
  const graphite = lin('#25272a');
  const arch = (x: number, y: number): boolean => y < 0.72 && (Math.abs(x - 1.28) < 0.44 || Math.abs(x + 1.28) < 0.44);
  kit.loft(
    CAB_RINGS,
    [1.72, 1.28 + 0.44, 1.28 - 0.44, 0.3, -0.3, -1.28 + 0.44, -1.28 - 0.44, -1.72],
    (x, y) => {
      if (y > 1.43) return { part: 'body', colour: lin('#1c1e21'), surf: [0.2, 0.18] };
      if (y > 0.9) return { part: 'glass', colour: [0, 0, 0], surf: [0, 0.05] };
      if (y < 0.32 || arch(x, y)) return { part: 'body', colour: graphite, surf: [0.1, 0.45] };
      return { part: 'body', colour: cream, surf: [0, 0.3] };
    },
    8,
    { top: { part: 'body', colour: lin('#1c1e21'), surf: [0.2, 0.18] }, bottom: { part: 'trim', colour: graphite, surf: [0.1, 0.8] } },
  );
  // Wheels: tyres, and pale hubs.
  for (const wx of [-1.28, 1.28]) {
    for (const sz of [-1, 1]) {
      kit.geometry('trim', cylinderOf(kit.lo ? 6 : 18), new THREE.Matrix4().compose(new THREE.Vector3(wx, 0.33, sz * 0.78), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(0.33, 0.24, 0.33)), lin('#111112'), [0, 0.85]);
      if (!kit.lo) {
        // The rim, a dished alloy disc, and its five spokes' shadows.
        kit.geometry('trim', cylinderOf(18), new THREE.Matrix4().compose(new THREE.Vector3(wx, 0.33, sz * 0.9), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(0.235, 0.012, 0.235)), lin('#8e8c88'), [0.9, 0.28]);
        kit.geometry('trim', cylinderOf(12), new THREE.Matrix4().compose(new THREE.Vector3(wx, 0.33, sz * 0.908), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(0.07, 0.012, 0.07)), lin('#2a2a2b'), [0.6, 0.4]);
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          kit.bar('trim', [wx + Math.cos(a) * 0.08, 0.33 + Math.sin(a) * 0.08, sz * 0.909], [wx + Math.cos(a) * 0.2, 0.33 + Math.sin(a) * 0.2, sz * 0.909], 0.006, 0.05, lin('#202021'), [0.5, 0.5]);
        }
      }
    }
  }
  if (!kit.lo) {
    // Door seams: a sliding door each side, and camera pods where mirrors would be.
    for (const sz of [-1, 1]) {
      for (const x of [0.62, -0.75]) kit.box('trim', [x, 0.62, sz * 0.906], [0.012, 0.56, 0.01], lin('#5e5a52'), [0, 0.5]);
      kit.box('trim', [-0.06, 0.34, sz * 0.9], [2.2, 0.05, 0.02], lin('#141516'), [0.2, 0.5]);
      kit.bar('trim', [1.25, 0.98, sz * 0.84], [1.32, 1.0, sz * 0.97], 0.03, 0.04, graphite);
      kit.box('trim', [1.3, 0.98, sz * 0.99], [0.12, 0.07, 0.06], graphite, [0.2, 0.4]);
    }
  }
  // The roof light and the sensor puck ahead of it.
  kit.box('lamp', [0.1, 1.585, 0], [0.5, 0.07, 0.2], [1.3, 0.62, 0.12], [0, 1], 'always');
  kit.box('trim', [0.1, 1.53, 0], [0.56, 0.04, 0.24], graphite, [0.2, 0.5]);
  if (!kit.lo) kit.rod('trim', [0.45, 1.5, 0], [0.45, 1.6, 0], 0.065, lin('#151618'), [0.3, 0.3], 12);
  // Light bars: a white strip across the nose, a red one across the tail.
  for (const e of [-1, 1]) {
    const r = { ...CAB_RINGS[2], front: e > 0 ? CAB_RINGS[2].front : CAB_RINGS[2].rear, rf: e > 0 ? CAB_RINGS[2].rf : CAB_RINGS[2].rr };
    for (const sz of [-1, 0, 1]) {
      const z = sz * 0.5;
      const at = noseAt(r, z);
      kit.box('lamp', [e * (at.x + 0.004), 0.74, z], [0.03, 0.045, sz === 0 ? 0.52 : 0.5], [1, 1, 1], [0, 1], e > 0 ? 'white' : 'red', e > 0 ? at.yaw : Math.PI - at.yaw);
    }
  }
}

const CAB_INTERIOR: Interior = {
  min: [-1.45, 0.42, -0.8],
  max: [1.1, 1.42, 0.8],
  light: scale(WARM, 0.32),
  lines: false,
  seat: lin('#3b3632'),
  sill: 0.9,
  head: 1.45,
  pitch: 9,
  pillar: 0,
  pillarAt: 0,
  doors: [],
  doorW: 0,
  seats: true,
  crowd: 0,
};

const MODELS: Record<ModelName, { build(kit: Kit): void; interior: Interior; glow: RGB }> = {
  tram: { build: tramModel, interior: TRAM_INTERIOR, glow: scale(WARM, 0.55) },
  railEnd: { build: (k) => railModel(k, true), interior: RAIL_INTERIOR(true), glow: scale(COOL, 0.6) },
  railMid: { build: (k) => railModel(k, false), interior: RAIL_INTERIOR(false), glow: scale(COOL, 0.6) },
  pod: { build: podModel, interior: POD_INTERIOR, glow: scale(COOL, 0.55) },
  ferry: { build: ferryModel, interior: FERRY_INTERIOR, glow: scale(WARM, 0.45) },
  cab: { build: cabModel, interior: CAB_INTERIOR, glow: scale(WARM, 0.12) },
};
const MODEL_KIND: Record<ModelName, VehicleKind> = { tram: 'tram', railEnd: 'rail', railMid: 'rail', pod: 'pod', ferry: 'ferry', cab: 'cab' };

// ---------------------------------------------------------------- materials

/** The near level dissolves into the far one across this band, in metres from the eye. */
export const VEHICLE_LOD = { near: 380, far: 460 } as const;

/**
 * Each instance measures its own distance from the eye (lod-shader.ts's
 * LOD_EYE), and the near and far levels keep the complementary halves of a
 * screen-door pattern across the band, so the switch never pops.
 */
function dither(sh: THREE.WebGLProgramParametersWithUniforms, level: 'near' | 'far'): void {
  sh.uniforms.uLodEye = LOD_EYE;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uLodEye;\nvarying float vLodFade;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      {
        #ifdef USE_INSTANCING
          vec4 lodAt = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #else
          vec4 lodAt = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #endif
        vLodFade = smoothstep(${VEHICLE_LOD.near.toFixed(1)}, ${VEHICLE_LOD.far.toFixed(1)}, distance(lodAt.xyz, uLodEye));
        if (${level === 'near' ? 'vLodFade >= 1.0' : 'vLodFade <= 0.0'}) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    );
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vLodFade;')
    .replace(
      'void main() {',
      `void main() {
      float lodN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (${level === 'near' ? 'lodN < vLodFade' : 'lodN >= vLodFade'}) discard;`,
    );
}

/** Metalness and roughness per vertex (the `surf` attribute): paint, stainless steel and rubber in one material. */
function surfaced(sh: THREE.WebGLProgramParametersWithUniforms): void {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurf.y;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurf.x;');
}

// ---------------------------------------------------------------- the destination board

/** The destinations the trains' boards spell: the elevated loop's gates. The board shows the first. */
export const LED_DESTINATIONS = ['NORTHGATE', 'SOUTHGATE', 'WESTGATE'] as const;

/** A 5 by 7 dot-matrix face, top row first, # lit. */
const LED_FONT: Record<string, string> = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '####. #...# #...# #...# #...# #...# ####.',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# ##..# #.#.# #..## #...# #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  ' ': '..... ..... ..... ..... ..... ..... .....',
};

/** A letter's seven rows of five dots. */
export function ledGlyph(ch: string): string[] {
  return (LED_FONT[ch] ?? LED_FONT[' ']).split(' ');
}

/** The board's width in dot columns (1.24 m at a 22.5 mm pitch). */
const LED_COLS = 55;

/** A destination laid out on the board: a seven-bit mask per column (bit 0 the top row), centred, a dark column between letters. */
export function ledColumns(text: string): { columns: number[]; start: number; width: number } {
  const width = text.length * 6 - 1;
  const start = Math.floor((LED_COLS - width) / 2);
  const columns = new Array<number>(LED_COLS).fill(0);
  [...text].forEach((ch, i) => {
    const rows = ledGlyph(ch);
    for (let col = 0; col < 5; col++) {
      let mask = 0;
      for (let row = 0; row < 7; row++) if (rows[row][col] === '#') mask |= 1 << row;
      columns[start + i * 6 + col] = mask;
    }
  });
  return { columns, start, width };
}

/**
 * The board in the lamp shader: the first destination's column masks
 * written out as constants (no array indexing in the shader), dots on a
 * 22.5 mm pitch read the right way round from in front of the nose (the
 * car faces +x, so the viewer's right is -z).
 */
const LED_GLSL = (() => {
  const { columns } = ledColumns(LED_DESTINATIONS[0]);
  const lines = columns.map((m, c) => (m ? `  if (c == ${c}) return ${m};` : '')).filter(Boolean);
  return `
  varying vec3 vLampP;
  int ledColumn(int c) {
${lines.join('\n')}
    return 0;
  }
  float ledBoard(float top) {
    float pitch = 0.0225;
    vec2 q = vec2(-vLampP.z + ${(LED_COLS * 0.0225 / 2).toFixed(5)}, top - vLampP.y) / pitch;
    vec2 cell = floor(q);
    float dot = 1.0 - smoothstep(0.24, 0.4, length(fract(q) - 0.5));
    int c = int(cell.x);
    int row = int(cell.y);
    float on = 0.0;
    if (c >= 0 && c < ${LED_COLS} && row >= 0 && row < 7) on = float((ledColumn(c) >> row) & 1);
    return 0.04 + dot * (0.05 + 1.15 * on);
  }`;
})();

/** What a lamp shows: white or red by whether its car's nose leads (aLead), brighter red braking (aBrake), or its own colour. */
const LAMP_GLSL = /* glsl */ `
${LED_GLSL}
  vec3 lampShow(vec3 kind, vec3 own, float lead, float brake) {
    float code = lead > 0.5 ? kind.x : kind.y;
    vec3 c = vec3(0.0);
    // The trains' board sits with its top at 3.1355 m; the tram's display over its windscreen at 2.61 m.
    if (kind.z > 1.5) return own * ledBoard(kind.z > 2.5 ? 2.61 : 3.1355);
    if (code > 1.5) c = vec3(3.2, 0.16, 0.06) * (1.0 + 1.6 * brake);
    else if (code > 0.5) c = vec3(4.6, 4.3, 3.9);
    else if (kind.x + kind.y > 0.5) c = (kind.x > 1.5 || kind.y > 1.5) ? vec3(0.06, 0.008, 0.006) : vec3(0.05, 0.05, 0.052);
    return c + own * kind.z;
  }`;

function lampMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  m.name = 'vehicle-lamp';
  m.onBeforeCompile = (sh) => {
    dither(sh, 'near');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 lampKind;\nattribute vec3 color;\nattribute float aLead;\nattribute float aBrake;\nvarying vec3 vKind;\nvarying vec3 vOwn;\nvarying float vLead;\nvarying float vBrake;\nvarying vec3 vLampP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKind = lampKind;\nvOwn = color;\nvLead = aLead;\nvBrake = aBrake;\nvLampP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vKind;\nvarying vec3 vOwn;\nvarying float vLead;\nvarying float vBrake;\n${LAMP_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = lampShow(vKind, vOwn, vLead, vBrake);');
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-lamp';
  return m;
}

function bodyMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.14, envMapIntensity: 1.0 });
  m.name = 'vehicle-body';
  m.onBeforeCompile = (sh) => {
    dither(sh, 'near');
    surfaced(sh);
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-body';
  return m;
}

function trimMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
  m.name = 'vehicle-trim';
  m.onBeforeCompile = (sh) => {
    dither(sh, 'near');
    surfaced(sh);
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-trim';
  return m;
}

/**
 * Glazing over a lit saloon. The ray from the eye through each fragment is
 * followed into a box the size of the saloon (in the car's own frame, so
 * every instance has its own room): it meets the ceiling and its two light
 * lines, the floor, the far side's windows (the dusk beyond) and the panels
 * round them, or an end wall; on the way it may meet a row of seat backs or
 * cushions, or a standing passenger down the aisle (a dark figure against
 * the light, a different crowd in every car). The near side's own glazing
 * carries its pillars and door frames, glossy black, and a glancing view
 * reflects the sky instead of the room.
 */
function glassMaterial(i: Interior): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x07090b, roughness: 0.05, metalness: 0, envMapIntensity: 0.4 });
  m.name = 'vehicle-glass';
  const doors = [...i.doors, -99, -99, -99, -99].slice(0, 4);
  const uniforms = {
    uBoxMin: { value: new THREE.Vector3(...i.min) },
    uBoxMax: { value: new THREE.Vector3(...i.max) },
    uLight: { value: new THREE.Vector3(...i.light) },
    uSeatCol: { value: new THREE.Vector3(...i.seat) },
    uOutside: { value: new THREE.Vector3(0.012, 0.016, 0.024) },
    uWin: { value: new THREE.Vector4(i.sill, i.head, i.pitch, i.pillar) },
    uPillarAt: { value: i.pillarAt },
    uDoors: { value: new THREE.Vector4(...doors) },
    uDoorW: { value: i.doorW },
    uSeats: { value: i.seats ? 1 : 0 },
    uCrowd: { value: i.crowd },
    uDriver: { value: i.driver ? 1 : 0 },
    uLines: { value: i.lines === false ? 0 : 1 },
  };
  m.userData.interior = uniforms;
  m.onBeforeCompile = (sh) => {
    dither(sh, 'near');
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLP;\nvarying vec3 vLN;\nvarying vec3 vLE;\nvarying float vInst;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLP = transformed;
        vLN = objectNormal;
        #ifdef USE_INSTANCING
          mat4 vToWorld = modelMatrix * instanceMatrix;
          vInst = float(gl_InstanceID);
        #else
          mat4 vToWorld = modelMatrix;
          vInst = 0.0;
        #endif
        vLE = (inverse(vToWorld) * vec4(cameraPosition, 1.0)).xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLP;
        varying vec3 vLN;
        varying vec3 vLE;
        varying float vInst;
        uniform vec3 uBoxMin;
        uniform vec3 uBoxMax;
        uniform vec3 uLight;
        uniform vec3 uSeatCol;
        uniform vec3 uOutside;
        uniform vec4 uWin;
        uniform float uPillarAt;
        uniform vec4 uDoors;
        uniform float uDoorW;
        uniform float uSeats;
        uniform float uCrowd;
        uniform float uDriver;
        uniform float uLines;
        float vgHash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
        float pillarAt(float x) {
          if (uWin.w <= 0.0) return 0.0;
          float f = fract((x - uPillarAt) / uWin.z);
          float e = min(f, 1.0 - f) * uWin.z;
          return 1.0 - smoothstep(uWin.w * 0.5, uWin.w * 0.5 + 0.015, e);
        }
        float doorAt(float x) {
          float d = 0.0;
          for (int i = 0; i < 4; i++) if (abs(x - uDoors[i]) < uDoorW * 0.5) d = 1.0;
          return d;
        }
        vec3 room(vec3 p0, vec3 d0) {
          vec3 bmin = uBoxMin;
          vec3 bmax = uBoxMax;
          vec3 p = clamp(p0, bmin + 0.003, bmax - 0.003);
          vec3 d = vec3(abs(d0.x) < 1e-4 ? 1e-4 : d0.x, abs(d0.y) < 1e-4 ? 1e-4 : d0.y, abs(d0.z) < 1e-4 ? 1e-4 : d0.z);
          vec3 far = mix(bmin, bmax, step(0.0, d));
          vec3 tf = (far - p) / d;
          float t = min(tf.x, min(tf.y, tf.z));
          vec3 h = p + d * t;
          float hw = bmax.z;
          float fl = bmin.y;
          float span = bmax.y - bmin.y;
          vec3 L = uLight;
          vec3 c;
          if (tf.y <= t + 1e-5 && d.y > 0.0) {
            // The ceiling: two light lines along it, the panels between lit by them.
            float line = 1.0 - smoothstep(0.05, 0.1, abs(abs(h.z) - hw * 0.45));
            float joint = 0.82 + 0.18 * step(0.03, fract(h.x / 1.25));
            c = L * (0.5 * joint + 3.4 * line * uLines + 0.4 * (1.0 - uLines));
          } else if (tf.y <= t + 1e-5) {
            // The floor: dark, brighter down the aisle under the lights.
            c = L * 0.09 * (0.55 + 0.45 * (1.0 - smoothstep(0.1, hw, abs(h.z))));
          } else if (tf.z <= t + 1e-5) {
            // The far side: its windows onto the dusk, their pillars, and the panels under and over them.
            if (h.y > uWin.x && h.y < uWin.y) {
              c = mix(uOutside, L * 0.1, max(pillarAt(h.x), 0.0));
              if (doorAt(h.x) > 0.5) c = uOutside * 1.2;
            } else {
              float g = (h.y - fl) / span;
              c = L * (h.y < uWin.x ? 0.16 + 0.12 * g : 0.42);
              if (doorAt(h.x) > 0.5 && h.y < uWin.x) c = uOutside * 1.3 + L * 0.02;
            }
          } else {
            // An end wall: the bulkhead, a little darker toward the floor.
            c = L * (0.18 + 0.2 * (h.y - fl) / span);
          }
          if (uSeats > 0.5) {
            // Seat backs across the car either side of the aisle, every 0.9 m.
            float pitch = 0.9;
            float xs = (d.x > 0.0 ? ceil(p.x / pitch) : floor(p.x / pitch)) * pitch;
            float ts = (xs - p.x) / d.x;
            vec3 hs = p + d * ts;
            if (ts > 0.0 && ts < t && abs(hs.z) > 0.3 && hs.y > fl + 0.4 && hs.y < fl + 1.1) {
              float top = smoothstep(fl + 0.96, fl + 1.08, hs.y);
              c = uSeatCol * L * (0.28 + 0.5 * top);
              t = ts;
            }
            // The cushions, seen from above.
            float tc = (fl + 0.46 - p.y) / d.y;
            if (d.y < 0.0 && tc > 0.0 && tc < t) {
              vec3 hc = p + d * tc;
              if (abs(hc.z) > 0.3) {
                c = uSeatCol * L * 0.42;
                t = tc;
              }
            }
          }
          {
            // Grab poles down the aisle by each doorway, catching the ceiling's light.
            float tz0 = -p.z / d.z;
            if (tz0 > 0.0 && tz0 < t) {
              vec3 hp = p + d * tz0;
              for (int i = 0; i < 4; i++) {
                if (uDoors[i] < -90.0) continue;
                for (int e = -1; e <= 1; e += 2) {
                  float px = uDoors[i] + float(e) * (uDoorW * 0.5 + 0.25);
                  float dx = abs(hp.x - px);
                  if (dx < 0.022 && hp.y > fl && hp.y < bmax.y) {
                    c = mix(vec3(0.9, 0.62, 0.12) * 0.55, vec3(0.95), 0.25) * L * (0.35 + 0.65 * (1.0 - dx / 0.022));
                    t = tz0;
                  }
                }
              }
            }
          }
          if (uCrowd > 0.0) {
            // Passengers standing down the aisle, lit from the ceiling: coats in a few muted colours, faces warm.
            float tz = -p.z / d.z;
            if (tz > 0.0 && tz < t) {
              vec3 hz = p + d * tz;
              float slot = floor(hz.x / 0.95);
              if (vgHash(slot * 1.31 + vInst * 7.17) < uCrowd) {
                float xc = (slot + 0.5) * 0.95 + (vgHash(slot + vInst * 3.7) - 0.5) * 0.35;
                float top = fl + 1.56 + 0.22 * vgHash(slot * 5.3 + vInst);
                float dx = abs(hz.x - xc);
                float y = hz.y;
                float shoulders = smoothstep(top - 0.5, top - 0.3, y);
                float torso = step(dx, 0.21 - 0.07 * shoulders) * step(y, top - 0.24) * step(fl, y);
                float head = step(length(vec2(dx, (y - (top - 0.12)) * 0.82)), 0.105);
                if (torso + head > 0.5) {
                  float hh = vgHash(slot * 2.7 + vInst * 1.3);
                  vec3 coat = hh < 0.25 ? vec3(0.05, 0.06, 0.09) : hh < 0.5 ? vec3(0.09, 0.08, 0.07) : hh < 0.75 ? vec3(0.16, 0.11, 0.07) : vec3(0.12, 0.04, 0.05);
                  float lit = 0.35 + 0.9 * smoothstep(fl + 0.6, top, y);
                  float edge = smoothstep(0.0, 0.06, 0.21 - dx);
                  c = head > 0.5 ? vec3(0.42, 0.28, 0.2) * L * (0.35 + 0.4 * smoothstep(top - 0.2, top, y)) : coat * L * lit * (0.55 + 0.45 * edge);
                  t = tz;
                }
              }
            }
          }
          return c;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 nL = normalize(vLN);
          float sideFace = (1.0 - step(0.6, abs(nL.y))) * step(0.45, abs(nL.z));
          float mask = 1.0;
          float inDoor = doorAt(vLP.x) * sideFace;
          if (sideFace > 0.5) {
            if (inDoor > 0.5) {
              // Door leaves: a frame round each and the seam where they meet.
              float e = 1.0;
              for (int i = 0; i < 4; i++) {
                float u = abs(vLP.x - uDoors[i]);
                if (u < uDoorW * 0.5) e = min(e, min(uDoorW * 0.5 - u, u));
              }
              mask *= smoothstep(0.04, 0.06, e);
              mask *= smoothstep(0.03, 0.05, uWin.y - vLP.y);
              mask *= smoothstep(0.08, 0.1, vLP.y - uBoxMin.y);
            } else {
              mask *= 1.0 - pillarAt(vLP.x);
              mask *= smoothstep(0.015, 0.03, min(vLP.y - uWin.x, uWin.y - vLP.y));
            }
          }
          vec3 d = normalize(vLP - vLE);
          vec3 inside = room(vLP, d);
          // In front of the saloon (a windscreen): the driver's cab, dark, its bulkhead a pace behind the glass with
          // the saloon's light through the door's window.
          if (uDriver > 0.5 && vLP.x > uBoxMax.x + 0.05 && d.x < 0.0) {
            float tb = (uBoxMax.x - vLP.x) / d.x;
            vec3 hb = vLP + d * tb;
            float desk = uBoxMin.y + 0.62;
            float td = (desk - vLP.y) / min(d.y, -1e-4);
            // The driver's seat, its high back a dark shape against the bulkhead, to one side of the door.
            float tsb = (uBoxMax.x + 0.75 - vLP.x) / d.x;
            vec3 hsb = vLP + d * tsb;
            float seat = step(abs(hsb.z - 0.55), 0.26) * step(uBoxMin.y + 0.5, hsb.y) * step(hsb.y, uBoxMin.y + 1.5);
            if (d.y < 0.0 && td < tb) {
              // The desk: dark, its screens and lamps small cool and amber points.
              vec3 hd = vLP + d * td;
              float scr = step(abs(hd.z - 0.35), 0.16) * step(abs(hd.x - (uBoxMax.x + 0.45)), 0.12);
              float pip = step(0.82, vgHash(floor(hd.z * 18.0) + floor(hd.x * 18.0) * 7.0)) * step(abs(hd.z), 0.9);
              inside = vec3(0.006, 0.006, 0.007) + uLight * 0.012 + vec3(0.1, 0.22, 0.3) * scr + vec3(0.5, 0.25, 0.05) * pip * 0.3;
            }
            else {
                // The door's window into the saloon: dimmed through two panes, its edges soft in a dark surround.
              float wedge = smoothstep(0.22, 0.12, abs(hb.z)) * smoothstep(uBoxMin.y + 1.05, uBoxMin.y + 1.2, hb.y) * smoothstep(uBoxMin.y + 1.75, uBoxMin.y + 1.6, hb.y);
              inside = mix(uLight * 0.006 * (0.6 + 0.4 * smoothstep(uBoxMin.y, uBoxMax.y, hb.y)), room(vec3(uBoxMax.x - 0.01, hb.y, hb.z), d) * 0.3, wedge);
              // A faint lit panel over the door: the cab's own instruments light.
              inside += vec3(0.25, 0.4, 0.5) * 0.05 * step(abs(hb.z + 0.6), 0.25) * step(abs(hb.y - (uBoxMin.y + 1.9)), 0.08);
            }
            if (tsb > 0.0 && tsb < tb && seat > 0.5) inside = uLight * 0.012 + vec3(0.004);
          }
          vec3 V = normalize(vViewPosition);
          float NdV = clamp(abs(dot(normal, V)), 0.0, 1.0);
          float F = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
          totalEmissiveRadiance += inside * mask * (1.0 - F);
          // The dusk sky in the glass: a band from the warm horizon up to the violet zenith, the street dark below,
          // strongest at a glancing view, so the glass reads as glass and its curve shows.
          vec3 Rw = inverseTransformDirection(reflect(-V, normalize(normal)), viewMatrix);
          vec3 sky = mix(vec3(0.95, 0.56, 0.42), vec3(0.24, 0.2, 0.38), smoothstep(0.02, 0.55, Rw.y));
          vec3 refl = mix(vec3(0.02, 0.018, 0.02), sky * 0.55, smoothstep(-0.06, 0.05, Rw.y));
          // On a windscreen the sky lies across its upper third as a warm-to-violet band.
          float front = smoothstep(0.5, 0.8, abs(nL.x));
          float upper = smoothstep(uWin.x + 0.55 * (uWin.y - uWin.x), uWin.y - 0.05, vLP.y);
          vec3 band = mix(vec3(1.0, 0.58, 0.4), vec3(0.42, 0.32, 0.62), smoothstep(uWin.y - 0.45, uWin.y - 0.05, vLP.y));
          totalEmissiveRadiance += refl * (0.05 + 0.9 * F) * mask + band * 0.22 * front * upper * mask * uDriver;
          diffuseColor.rgb = mix(vec3(0.012), diffuseColor.rgb, mask);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-glass';
  return m;
}

/** The far level: painted faces as painted, the glazing as its lit room's colour, the lamps by kind; one call per model. */
function farMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0 });
  m.name = 'vehicle-far';
  m.onBeforeCompile = (sh) => {
    dither(sh, 'far');
    surfaced(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 glow;\nattribute vec3 lampKind;\nattribute float aLead;\nattribute float aBrake;\nvarying vec3 vGlow;\nvarying vec3 vKind;\nvarying float vLead;\nvarying float vBrake;\nvarying vec3 vLampP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;\nvKind = lampKind;\nvLead = aLead;\nvBrake = aBrake;\nvLampP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGlow;\nvarying vec3 vKind;\nvarying float vLead;\nvarying float vBrake;\n${LAMP_GLSL}`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vKind.x + vKind.y + vKind.z > 0.0) {
          vec3 own = vColor.rgb;
          totalEmissiveRadiance += lampShow(vKind, own, vLead, vBrake);
          diffuseColor.rgb = vec3(0.0);
        }
        totalEmissiveRadiance += vGlow;`,
      )
      // Lit glazing and lamps are small bright sources: the haze dims them far less than a painted side, so the
      // tram's lit cars on the viaduct and the ferry's lamps read from home.
      .replace(
        '#include <fog_fragment>',
        `vec3 preFog = gl_FragColor.rgb;
        #include <fog_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, preFog, 0.6 * step(0.01, vKind.x + vKind.y + vKind.z + vGlow.r + vGlow.g + vGlow.b));`,
      );
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-far';
  return m;
}

/** A contact shadow: a soft-edged dark rectangle under a car, darkest at its middle. */
function shadeMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  m.name = 'vehicle-shade';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vShade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = position.xz * 2.0;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vShade;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 q = abs(vShade);
        float a = (1.0 - smoothstep(0.72, 1.0, q.x)) * (1.0 - smoothstep(0.55, 1.0, q.y));
        diffuseColor.a = 0.62 * a;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-shade';
  return m;
}

/** A pool of headlamp light on the road ahead: an additive ellipse, brightest near the lamps. */
function poolMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true });
  m.name = 'vehicle-pool';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPool;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPool = position.xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vPool;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        // x runs 0 (at the lamps) to 1 (the far edge), z across -0.5 to 0.5.
        float along = vPool.x;
        float across = abs(vPool.y) * 2.0 / (0.55 + 0.45 * along);
        float a = pow(1.0 - smoothstep(0.2, 1.0, across), 2.0) * smoothstep(0.0, 0.25, along) * pow(1.0 - smoothstep(0.1, 1.0, along), 1.5);
        diffuseColor.rgb *= a;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'palimpsest-vehicle-pool';
  return m;
}

// ---------------------------------------------------------------- the vehicles in the city

export interface VehiclesView {
  /** Vehicles running and standing, by kind (a train counts once, however many cars). */
  trams: number;
  trains: number;
  pods: number;
  ferries: number;
  cabs: number;
  /** Cars drawn at the near level and the far level now (one in the dissolve band counts in both). */
  near: number;
  far: number;
  /** Draw calls of the main pass and the triangles they draw. */
  meshes: number;
  triangles: number;
  /** Seconds on the vehicles' clock. */
  time: number;
}

export interface Vehicles {
  group: THREE.Group;
  /**
   * Advances the clock by dt seconds, moves every vehicle, and draws each
   * car at its level from the eye. The cars cast no sun shadow (a moving
   * caster would redraw the city's shadow map every frame).
   */
  update(dt: number, eye?: THREE.Vector3): void;
  /** The next vehicle on a trip's leg (tram, rail, pod or ferry) that calls at its start going its way, or null. */
  board(trip: Trip, leg: number): Ride | null;
  /**
   * A cab from the nearest rank with one free, sent to carry a trip's cab
   * leg: it pulls in at the kerb nearest the leg's start (kerbOf), drives
   * the streets round the plazas, and sets down at the kerb nearest its
   * end. A second summons for the same leg brings the same cab. Throws for
   * a leg that is not a cab leg.
   */
  summonCab(trip: Trip, leg: number): VehicleRef;
  /**
   * Lays the fleet on a network laid again, keeping the clock: on the same
   * network nothing moves; on a new one each vehicle runs its new timetable
   * from the same moment. Refs resolve by id (a vehicle the new network has
   * no place for is retired) and rides timetabled on another network are
   * retired, so their riders board again.
   */
  relay(net: Network): void;
  /** The quality the city draws at (the governor's step down reaches the vehicles: no headlamp pools at medium). */
  setQuality(q: 'high' | 'medium'): void;
  /** Every vehicle of a kind. */
  vehicles(kind: VehicleKind): VehicleRef[];
  /** The ferries' wakes: where each is, which way it moves, and how fast against its service speed (river.ts draws them). */
  wakes(eye?: { x: number; z: number }): ReadonlyArray<{ x: number; z: number; heading: number; speed: number }>;
  view(camera: THREE.Camera): VehiclesView;
  /** Holds the clock (captures): vehicles stand where they are until released. */
  hold(on: boolean): void;
  /** Moves the clock on by `seconds` at once, held or not (tests and captures). */
  skip(seconds: number): void;
  /**
   * Moves the clock on until a vehicle of the kind (other than a cab) has
   * just come to a stand at a stop, the one nearest `near` if given, and
   * returns it (tests and captures).
   */
  stage(kind: Exclude<VehicleKind, 'cab'>, near?: V2): VehicleRef | null;
  /**
   * Moves the clock on to the soonest second (within `horizon`) at which
   * every condition holds: a vehicle of its kind within `radius` of `near`,
   * moving at least `moving` m/s when given. False, and the clock unmoved,
   * when there is none (captures).
   */
  seek(conds: ReadonlyArray<{ kind: Exclude<VehicleKind, 'cab'>; near: V2; radius: number; moving?: number }>, horizon?: number): boolean;
  /** A stand-in rider (until the figures of Task 34) standing at a point facing a heading, or none (captures). */
  rider(at: V3 | null, heading?: number): void;
  dispose(): void;
}

/** How many cars of each model the fleet's instance buffers hold: twice what it runs, so a network grown a ring still fits. */
function capacity(fleet: { services: Service[]; cabs: unknown[] }, name: ModelName): number {
  let n = 0;
  for (const s of fleet.services) for (const m of CONSIST[s.kind].models) if (m.model === name) n += s.units.length;
  if (name === 'cab') n = fleet.cabs.length * 2;
  return Math.max(n * 2, 8);
}

interface Drawn {
  name: ModelName;
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh;
  lead: THREE.InstancedBufferAttribute[];
  brake: THREE.InstancedBufferAttribute[];
  nearCount: number;
  farCount: number;
  tris: { near: number; far: number };
}

/** A network's identity for its timetables: its lines' tracks and stops. */
function netKey(net: Network): string {
  return JSON.stringify([net.tram.path, net.rail.path, net.pods.map((l) => l.path), net.tram.stops.length, net.rail.stops.length, net.ranks.map((r) => [r.x, r.z])]);
}

/** The most cabs a rank keeps: one in each bay. */
const RANK_CABS = 3;

export function createVehicles(net: Network, quality: 'high' | 'medium'): Vehicles {
  let fleet = makeFleet(net);
  let key = netKey(net);
  let plazas = plazasOf(net);
  const byId = new Map<string, Unit>();
  const index = (): void => {
    byId.clear();
    for (const u of fleet.units) byId.set(u.id, u);
  };
  index();
  let disposed = false;
  const group = new THREE.Group();
  group.name = 'vehicles';
  const body = bodyMaterial();
  const trim = trimMaterial();
  const lamp = lampMaterial();
  const far = farMaterial();
  const pool = poolMaterial();
  const glass = new Map<ModelName, THREE.MeshStandardMaterial>();
  const owned: THREE.BufferGeometry[] = [];

  const drawn = new Map<ModelName, Drawn>();
  const drawnGeos: THREE.BufferGeometry[] = [];
  /** Each model's near and far instances, sized for the fleet; laid again only when a relaid fleet outgrows them. */
  function buildDrawn(): void {
  for (const d of drawn.values()) {
    for (const m of [...d.near, d.far]) {
      group.remove(m);
      m.dispose();
    }
  }
  for (const g of drawnGeos.splice(0)) g.dispose();
  drawn.clear();
  for (const name of Object.keys(MODELS) as ModelName[]) {
    const spec = MODELS[name];
    const cap = capacity(fleet, name);
    const nearKit = new Kit(false);
    spec.build(nearKit);
    const farKit = new Kit(true);
    spec.build(farKit);
    const gm = glass.get(name) ?? glassMaterial(spec.interior);
    glass.set(name, gm);
    const mats: Record<Part, THREE.Material> = { body, trim, glass: gm, lamp };
    const near: THREE.InstancedMesh[] = [];
    const lead: THREE.InstancedBufferAttribute[] = [];
    const brake: THREE.InstancedBufferAttribute[] = [];
    let nearTris = 0;
    for (const p of PARTS) {
      const g = nearKit.part(p);
      if (!g) continue;
      drawnGeos.push(g);
      if (p === 'lamp') {
        const la = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
        const ba = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
        la.setUsage(THREE.DynamicDrawUsage);
        ba.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aLead', la);
        g.setAttribute('aBrake', ba);
        lead.push(la);
        brake.push(ba);
      }
      const mesh = new THREE.InstancedMesh(g, mats[p], cap);
      mesh.name = `vehicles:${name}:${p}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      // The sun's shadow map is drawn only when something changes (scene.ts): a moving caster would redraw it every
      // frame, over the whole city. The cars take its shadows and lay soft contact shadows of their own instead.
      mesh.castShadow = false;
      mesh.receiveShadow = p !== 'lamp';
      // Lamps draw in the view only: they neither cast nor take the AO.
      if (p === 'lamp') setLayers(mesh, LAYER.view);
      nearTris += g.attributes.position.count / 3;
      near.push(mesh);
      group.add(mesh);
    }
    const fg = farKit.merged(spec.glow);
    drawnGeos.push(fg);
    const fl = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    const fb = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    fl.setUsage(THREE.DynamicDrawUsage);
    fb.setUsage(THREE.DynamicDrawUsage);
    fg.setAttribute('aLead', fl);
    fg.setAttribute('aBrake', fb);
    lead.push(fl);
    brake.push(fb);
    const farMesh = new THREE.InstancedMesh(fg, far, cap);
    farMesh.name = `vehicles:${name}:far`;
    farMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    farMesh.frustumCulled = false;
    farMesh.count = 0;
    farMesh.visible = false;
    farMesh.receiveShadow = true;
    // Far off a car neither casts nor joins the AO: the view draws it alone.
    setLayers(farMesh, LAYER.view);
    group.add(farMesh);
    drawn.set(name, { name, near, far: farMesh, lead, brake, nearCount: 0, farCount: 0, tris: { near: nearTris, far: fg.attributes.position.count / 3 } });
  }
  }
  buildDrawn();

  // Headlamp pools on the road ahead of the trams and cabs near the eye.
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
  owned.push(poolGeo);
  const poolCap = 96;
  const pools = new THREE.InstancedMesh(poolGeo, pool, poolCap);
  pools.name = 'vehicles:pools';
  pools.frustumCulled = false;
  pools.count = 0;
  pools.visible = false;
  pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(poolCap * 3), 3);
  setLayers(pools, LAYER.view);
  group.add(pools);

  let held = false;
  const eyeAt = new THREE.Vector3(0, 1e5, 0);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YZX');
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const size = new THREE.Vector3();

  /** Lays one car into its model's near and far instances by its distance from the eye. */
  function place(name: ModelName, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, lead: number, brake: number): void {
    const d = drawn.get(name)!;
    pos.set(x, y, z);
    e.set(roll, -yaw, pitch, 'YZX');
    q.setFromEuler(e);
    m4.compose(pos, q, one);
    const dist = pos.distanceTo(eyeAt);
    const ld = lead > 0 ? 1 : 0;
    if (dist < VEHICLE_LOD.far && d.nearCount < d.near[0].instanceMatrix.count) {
      const i = d.nearCount++;
      for (const mesh of d.near) mesh.setMatrixAt(i, m4);
      for (let k = 0; k < d.lead.length - 1; k++) {
        d.lead[k].setX(i, ld);
        d.brake[k].setX(i, brake);
      }
    }
    if (dist > VEHICLE_LOD.near && d.farCount < d.far.instanceMatrix.count) {
      const i = d.farCount++;
      d.far.setMatrixAt(i, m4);
      d.lead[d.lead.length - 1].setX(i, ld);
      d.brake[d.brake.length - 1].setX(i, brake);
    }
  }

  let poolCount = 0;
  const poolColour = new THREE.Color();
  function addPool(x: number, y: number, z: number, yaw: number, length: number, width: number, strength: number): void {
    if (poolCount >= poolCap || quality === 'medium') return;
    pos.set(x, y + 0.03, z);
    if (pos.distanceTo(eyeAt) > 320) return;
    e.set(0, -yaw, 0, 'YZX');
    q.setFromEuler(e);
    m4.compose(pos, q, size.set(length, 1, width));
    pools.setMatrixAt(poolCount, m4);
    pools.setColorAt(poolCount, poolColour.setRGB(1.0 * strength, 0.9 * strength, 0.74 * strength));
    poolCount++;
  }

  // Contact shadows: the soft dark under a tram or cab on the street, where the sky's light cannot reach.
  const shadeCap = 96;
  const shades = new THREE.InstancedMesh(poolGeo.clone().translate(-0.5, 0, 0), shadeMaterial(), shadeCap);
  owned.push(shades.geometry);
  shades.name = 'vehicles:shades';
  shades.frustumCulled = false;
  shades.count = 0;
  shades.visible = false;
  setLayers(shades, LAYER.view);
  group.add(shades);
  let shadeCount = 0;
  function addShade(x: number, y: number, z: number, yaw: number, length: number, width: number): void {
    if (shadeCount >= shadeCap) return;
    pos.set(x, y + 0.02, z);
    if (pos.distanceTo(eyeAt) > VEHICLE_LOD.far) return;
    e.set(0, -yaw, 0, 'YZX');
    q.setFromEuler(e);
    m4.compose(pos, q, size.set(length, 1, width));
    shades.setMatrixAt(shadeCount++, m4);
  }

  function draw(): void {
    for (const d of drawn.values()) {
      d.nearCount = 0;
      d.farCount = 0;
    }
    poolCount = 0;
    shadeCount = 0;
    const t = fleet.time;
    for (const u of fleet.units) {
      const { cars, v } = unitCars(u, t);
      const kind = u.service.kind;
      const braking = v > 0.05 && u.service.plan.at(t + u.offset + 0.3).v < v - 0.02 ? 1 : 0;
      // A ferry rides the river: a slow heave and roll, a touch more under way.
      let heave = 0;
      let roll = 0;
      if (kind === 'ferry') {
        const ph = u.offset * 0.7;
        heave = 0.05 * Math.sin(t * 0.9 + ph) + 0.02 * Math.sin(t * 2.3 + ph * 2);
        roll = 0.008 * Math.sin(t * 0.7 + ph) * (1 + v / SPEED.ferry);
      }
      cars.forEach((c, k) => {
        place(c.model, c.x, c.y + RAIL_HEAD[kind] + heave, c.z, c.yaw, c.pitch + (kind === 'ferry' ? 0.004 * Math.sin(t * 0.5 + u.offset) : 0), roll, c.lead, c.lead < 0 || kind !== 'tram' ? braking : 0);
        if (kind === 'tram') addShade(c.x, c.y, c.z, c.yaw, 14.6, 3.1);
        // The leading car lays its headlamps' light on the road (trams only: the rail and pods run high).
        if (kind === 'tram' && c.lead > 0 && k === 0) addPool(c.x + Math.cos(c.yaw) * 7.3, c.y + RAIL_HEAD.tram, c.z + Math.sin(c.yaw) * 7.3, c.yaw, 18, 5.2, 0.12);
      });
    }
    for (const cab of fleet.cabs) {
      const p = cabPose(cab, t);
      place('cab', p.x, p.y, p.z, p.yaw, 0, 0, 1, p.braking ? 1 : 0);
      addShade(p.x, p.y, p.z, p.yaw, 4.5, 2.3);
      if (cab.phase !== 'parked') addPool(p.x + Math.cos(p.yaw) * 1.95, p.y, p.z + Math.sin(p.yaw) * 1.95, p.yaw, 12, 3.8, 0.1);
    }
    for (const d of drawn.values()) {
      for (const mesh of d.near) {
        mesh.count = d.nearCount;
        mesh.visible = d.nearCount > 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
      d.far.count = d.farCount;
      d.far.visible = d.farCount > 0;
      d.far.instanceMatrix.needsUpdate = true;
      for (const a of [...d.lead, ...d.brake]) a.needsUpdate = true;
    }
    pools.count = poolCount;
    pools.visible = poolCount > 0;
    pools.instanceMatrix.needsUpdate = true;
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;
    shades.count = shadeCount;
    shades.visible = shadeCount > 0;
    shades.instanceMatrix.needsUpdate = true;
  }

  const refs = new Map<string, VehicleRef>();
  /** Where each ref was last seen, so a retired one stands still rather than vanishing. */
  const lastSeen = new Map<string, { p: V3; h: number }>();
  function unitRef(id: string): VehicleRef {
    let r = refs.get(id);
    if (r) return r;
    const kind = byId.get(id)!.service.kind;
    // Resolved through the fleet as laid now: a relay keeps the ref, its vehicle runs on.
    const unit = (): Unit | undefined => byId.get(id);
    const seen = (): { p: V3; h: number } => {
      const u = unit();
      if (!u) return lastSeen.get(id) ?? { p: [0, 0, 0], h: 0 };
      const st = u.service.plan.at(fleet.time + u.offset);
      const pt = u.service.track.point(st.s);
      const t = u.service.track.tangent(st.s);
      const out = { p: [pt.x, pt.y, pt.z] as V3, h: Math.atan2(t.z, t.x) };
      lastSeen.set(id, out);
      return out;
    };
    r = {
      id,
      vehicle: id,
      kind,
      track: byId.get(id)!.service.id,
      position: () => seen().p,
      heading: () => seen().h,
      speed() {
        const u = unit();
        return u ? u.service.plan.at(fleet.time + u.offset).v : 0;
      },
      floorY: () => seen().p[1] + RAIL_HEAD[kind] + CONSIST[kind].floor,
      arrivesIn(p) {
        const u = unit();
        if (!u) return Infinity;
        let best = Infinity;
        for (const c of u.service.calls) if (dist(c, p) < 6) best = Math.min(best, waitFor(u, c, fleet.time));
        return best;
      },
      phase: () => 'running',
      retired: () => !unit(),
    };
    refs.set(id, r);
    return r;
  }
  function cabRef(cab: Cab): VehicleRef {
    let r = refs.get(cab.id);
    if (r) return r;
    const id = cab.id;
    const now = (): Cab | undefined => fleet.cabs.find((c) => c.id === id);
    const pose = (): { x: number; y: number; z: number; yaw: number; v: number } => {
      const c = now();
      if (!c) {
        const l = lastSeen.get(id) ?? { p: [0, 0, 0] as V3, h: 0 };
        return { x: l.p[0], y: l.p[1], z: l.p[2], yaw: l.h, v: 0 };
      }
      const p = cabPose(c, fleet.time);
      lastSeen.set(id, { p: [p.x, p.y, p.z], h: p.yaw });
      return p;
    };
    r = {
      id,
      vehicle: id,
      kind: 'cab',
      track: `rank:${cab.rank.x},${cab.rank.z}`,
      position() {
        const p = pose();
        return [p.x, p.y, p.z];
      },
      heading: () => pose().yaw,
      speed: () => pose().v,
      floorY: () => pose().y + CAB_FLOOR,
      arrivesIn(p) {
        // The kerb it is heading for: the pickup on the way there, the set-down while carrying.
        const c = now();
        const legs = c?.legs;
        if (!c || !legs) return Infinity;
        const t = fleet.time - c.since;
        const end = (run: { track: Track }): V2 => run.track.point(run.track.length);
        if (c.phase === 'to-pickup' && dist(end(legs.pickup), p) < 6) return Math.max(0, legs.pickup.plan.period - t);
        if ((c.phase === 'pickup' && dist(end(legs.pickup), p) < 6) || (c.phase === 'setdown' && dist(end(legs.carry), p) < 6)) return 0;
        if (c.phase === 'pickup' && dist(end(legs.carry), p) < 6) return CAB_BOARD_S - t + legs.carry.plan.period;
        if (c.phase === 'carrying' && dist(end(legs.carry), p) < 6) return Math.max(0, legs.carry.plan.period - t);
        return Infinity;
      },
      phase: () => now()?.phase ?? 'parked',
      retired: () => !now(),
    };
    refs.set(id, r);
    return r;
  }

  const kindOf = (m: TripMode): Service['kind'] | null => (m === 'tram' || m === 'rail' || m === 'pod' || m === 'ferry' ? m : null);

  function board(trip: Trip, k: number): Ride | null {
    const leg = trip.legs[k];
    const kind = leg ? kindOf(leg.mode) : null;
    if (!leg || !kind || leg.path.length < 2) return null;
    const p0 = xz(leg.path[0]);
    const pEnd = xz(leg.path[leg.path.length - 1]);
    const p1 = xz(leg.path[1]);
    let best: { u: Unit; c: Call; wait: number } | null = null;
    for (const svc of fleet.services) {
      if (svc.kind !== kind) continue;
      for (const c of svc.calls) {
        if (dist(c, p0) > 1) continue;
        // Which way it leaves the stop: it must head the leg's way.
        const a = svc.track.point(c.s);
        const b = svc.track.point(c.s + 30);
        const go = kind === 'ferry' ? Math.sign(b.z - a.z) === Math.sign(pEnd.z - p0.z) : (b.x - a.x) * (p1.x - p0.x) + (b.z - a.z) * (p1.z - p0.z) > 0;
        if (!go) continue;
        // And it must reach the leg's end before it comes back past the start.
        if (!svc.calls.some((e) => dist(e, pEnd) <= 1)) continue;
        for (const u of svc.units) {
          const w = waitFor(u, c, fleet.time);
          if (!best || w < best.wait) best = { u, c, wait: w };
        }
      }
    }
    if (!best) return null;
    const { u, c } = best;
    const ref = unitRef(u.id);
    const laidOn = key;
    const P = u.service.plan.period;
    const boardAt = fleet.time + best.wait;
    // The first call at the leg's end after boarding.
    let ride = Infinity;
    for (const e of u.service.calls) {
      if (dist(e, pEnd) > 1) continue;
      const dt = (((e.t - c.t) % P) + P) % P;
      if (dt > 1e-6) ride = Math.min(ride, dt);
    }
    const alightAt = boardAt + ride;
    return { ...ref, boardsIn: () => Math.max(0, boardAt - fleet.time), alightsIn: () => Math.max(0, alightAt - fleet.time), retired: () => key !== laidOn || ref.retired() };
  }

  function summonCab(trip: Trip, k: number): VehicleRef {
    const leg = trip.legs[k];
    if (!leg || leg.mode !== 'cab' || leg.path.length < 2) throw new Error(`summonCab: leg ${k} of trip ${trip.id} is not a cab leg`);
    const token = `${trip.id}#${k}`;
    const known = bookings.get(token);
    if (known && known.phase() !== 'parked') return known;
    const way = leg.path.map(xz);
    const a = way[0];
    const b = way[way.length - 1];
    const start = kerbPlan(a, net);
    const bayOf = (cab: Cab): V2 => bayPose(cab.rank, cab.bay);
    let cab: Cab | undefined;
    let bestLen = Infinity;
    for (const c of fleet.cabs) {
      if (c.phase !== 'parked' || c.queue) continue;
      const len = pathLength(streetWay(bayOf(c), start.kerb));
      if (len < bestLen) {
        bestLen = len;
        cab = c;
      }
    }
    if (!cab) {
      // Every cab is out: the nearest rank with a bay to spare sends another from it.
      const ranks = [...net.ranks].sort((p, q) => pathLength(streetWay(p, start.kerb)) - pathLength(streetWay(q, start.kerb)));
      for (const rank of ranks) {
        const taken = new Set(fleet.cabs.filter((c) => c.rank === rank).map((c) => c.bay));
        if (taken.size >= RANK_CABS) continue;
        const bay = [0, 1, 2].find((n) => !taken.has(n))!;
        cab = { id: `cab:extra:${fleet.cabs.length}`, rank, bay, phase: 'parked', run: null, since: 0, legs: null };
        fleet.cabs.push(cab);
        break;
      }
    }
    if (!cab) {
      // Every bay in the city is out: the cab whose errand ends soonest (and has none waiting) takes this one next.
      // Its rider's booking says 'queued' and counts the real wait: that errand's end, then the drive from the bay.
      cab = [...fleet.cabs].sort((p, q) => cabFreeIn(p, fleet.time) + (p.queue ? 1e6 : 0) - (cabFreeIn(q, fleet.time) + (q.queue ? 1e6 : 0)))[0];
      const plan = errandLegs(cab, a, b);
      cab.queue = { token, a, b, est: { pickup: plan.pickup.plan.period, carry: plan.carry.plan.period } };
      return booking(cab, token);
    }
    sendCab(cab, a, b, token);
    return booking(cab, token);
  }

  /** The three drives of an errand for a cab from its bay: to the kerb by a, on to the kerb by b, and back. */
  function errandLegs(cab: Cab, a: V2, b: V2): NonNullable<Cab['legs']> {
    const start = kerbPlan(a, net);
    const end = kerbPlan(b, net);
    const bay = bayPose(cab.rank, cab.bay);
    return {
      pickup: drive([...streetWay(bay, start.via), start.kerb], plazas),
      carry: drive([start.kerb, ...streetWay(start.via, end.via), end.kerb], plazas),
      back: drive([end.kerb, ...streetWay(end.via, bay)], plazas),
    };
  }

  function sendCab(cab: Cab, a: V2, b: V2, token: string): void {
    cab.legs = errandLegs(cab, a, b);
    cab.errand = token;
    cab.ends = { a, b };
    cab.phase = 'to-pickup';
    cab.since = fleet.time;
    cab.run = cab.legs.pickup;
  }

  /**
   * A rider's booking: the cab, seen only through this rider's errand. While
   * the cab is out on someone else's it is 'queued', and its waits count
   * that errand's end and the drive back; once it is on this one it is the
   * cab itself.
   */
  const bookings = new Map<string, VehicleRef>();
  function booking(cab: Cab, token: string): VehicleRef {
    const id = cab.id;
    const now = (): Cab | undefined => fleet.cabs.find((c) => c.id === id);
    const mine = (): boolean => now()?.errand === token;
    const queued = (): boolean => now()?.queue?.token === token;
    const base = cabRef(cab);
    const ref: VehicleRef = {
      ...base,
      id: queued() ? `${id}~${token}` : id,
      phase() {
        if (mine()) return base.phase();
        return queued() ? 'queued' : 'parked';
      },
      // Queued, the cab is still someone else's: this booking reports the kerb where it will pull in for this rider,
      // never the other errand's whereabouts.
      position() {
        const c = now();
        if (!c || mine() || !queued() || !c.queue) return base.position();
        const k = kerbOf(c.queue.a, net);
        return [k.x, roadY(k), k.z];
      },
      heading() {
        return mine() ? base.heading() : 0;
      },
      speed: () => (mine() ? base.speed() : 0),
      arrivesIn(p) {
        const c = now();
        if (!c) return Infinity;
        if (mine()) return base.arrivesIn(p);
        const q = c.queue;
        if (!q || q.token !== token) return Infinity;
        const free = cabFreeIn(c, fleet.time);
        if (dist(kerbOf(q.a, net), p) < 6) return free + q.est.pickup;
        if (dist(kerbOf(q.b, net), p) < 6) return free + q.est.pickup + CAB_BOARD_S + q.est.carry;
        return Infinity;
      },
    };
    bookings.set(token, ref);
    return ref;
  }

  /** Each cab moves on through its errand; one back at its bay with another queued sets off again. */
  function advanceCabs(): void {
    for (const c of fleet.cabs) {
      advanceCab(c, fleet.time);
      if (c.phase === 'parked' && c.queue) {
        const q = c.queue;
        c.queue = null;
        sendCab(c, q.a, q.b, q.token);
      }
    }
  }

  /**
   * A cab caught mid-errand by a relay: the rest of its errand planned again
   * on the new network, from where it stands now (the kerbs re-snapped to
   * the new plazas), so it neither jumps nor drives the old streets.
   */
  function replan(c: Cab, time: number): void {
    if (!c.legs || !c.ends || c.phase === 'parked') return;
    const here = cabPose(c, time);
    const pos = { x: here.x, z: here.z };
    const start = kerbPlan(c.ends.a, net);
    const end = kerbPlan(c.ends.b, net);
    const bay = bayPose(c.rank, c.bay);
    const toEnd = (from: V2): { track: Track; plan: Plan } => drive([from, ...streetWay(from, end.via), end.kerb], plazas);
    const back = drive([end.kerb, ...streetWay(end.via, bay)], plazas);
    if (c.phase === 'to-pickup') {
      c.legs = { pickup: drive([pos, ...streetWay(pos, start.via), start.kerb], plazas), carry: drive([start.kerb, ...streetWay(start.via, end.via), end.kerb], plazas), back };
      c.run = c.legs.pickup;
      c.since = time;
    } else if (c.phase === 'pickup') {
      c.legs = { ...c.legs, carry: toEnd(pos), back };
    } else if (c.phase === 'carrying') {
      c.legs = { ...c.legs, carry: toEnd(pos), back };
      c.run = c.legs.carry;
      c.since = time;
    } else if (c.phase === 'setdown') {
      c.legs = { ...c.legs, back: drive([pos, ...streetWay(pos, bay)], plazas) };
    } else if (c.phase === 'returning') {
      c.legs = { ...c.legs, back: drive([pos, ...streetWay(pos, bay)], plazas) };
      c.run = c.legs.back;
      c.since = time;
    }
  }

  /** Lays the fleet on a network laid again, keeping the clock and every cab's errand at a rank that still stands. */
  function relay(next: Network): void {
    const time = fleet.time;
    const old = fleet;
    fleet = makeFleet(next);
    fleet.time = time;
    net = next;
    key = netKey(next);
    plazas = plazasOf(next);
    const rankAt = (r: Rank): Rank | undefined => next.ranks.find((n) => n.x === r.x && n.z === r.z);
    const cabs: Cab[] = [];
    for (const c of old.cabs) {
      const rank = rankAt(c.rank);
      if (!rank) continue;
      const kept = { ...c, rank };
      replan(kept, time);
      cabs.push(kept);
    }
    for (const c of fleet.cabs) if (!cabs.some((o) => o.id === c.id)) cabs.push(c);
    fleet.cabs = cabs;
    index();
    const outgrown = (Object.keys(MODELS) as ModelName[]).some((m) => {
      const d = drawn.get(m);
      const need = m === 'cab' ? fleet.cabs.length : capacity(fleet, m) / 2;
      return !d || need > d.far.instanceMatrix.count;
    });
    if (outgrown) buildDrawn();
    draw();
  }

  draw();

  // The stand-in rider: hidden until a capture places it.
  const riderKit = new Kit(false);
  standIn(riderKit);
  const riderGeo = riderKit.part('trim')!;
  owned.push(riderGeo);
  const riderMesh = new THREE.Mesh(riderGeo, trim);
  riderMesh.name = 'vehicles:rider';
  riderMesh.castShadow = false;
  riderMesh.receiveShadow = true;
  riderMesh.visible = false;
  group.add(riderMesh);

  const frustumCount = (mesh: THREE.InstancedMesh): number => (mesh.visible ? mesh.count : 0);
  const wakeSlots: Array<{ x: number; z: number; heading: number; speed: number; d: number }> = [];
  const wakeOut: Array<{ x: number; z: number; heading: number; speed: number }> = [];

  return {
    group,
    update(dt, eye) {
      if (disposed) return;
      if (!held) fleet.time += dt;
      advanceCabs();
      if (eye) eyeAt.copy(eye);
      draw();
    },
    board,
    summonCab,
    relay,
    setQuality(q) {
      quality = q;
    },
    vehicles(kind) {
      if (kind === 'cab') return fleet.cabs.map(cabRef);
      return fleet.units.filter((u) => u.service.kind === kind).map((u) => unitRef(u.id));
    },
    wakes(eye) {
      // The boats nearest the eye, in slots kept from frame to frame.
      let n = 0;
      for (const u of fleet.units) {
        if (u.service.kind !== 'ferry') continue;
        const { s, v } = u.service.plan.at(fleet.time + u.offset);
        const p = u.service.track.point(s);
        const t = u.service.track.tangent(s);
        const w = wakeSlots[n] ?? (wakeSlots[n] = { x: 0, z: 0, heading: 0, speed: 0, d: 0 });
        w.x = p.x;
        w.z = p.z;
        w.heading = Math.atan2(t.z, t.x);
        w.speed = v / SPEED.ferry;
        w.d = eye ? Math.hypot(p.x - eye.x, p.z - eye.z) : 0;
        n++;
      }
      wakeSlots.length = n;
      wakeSlots.sort((a, b) => a.d - b.d);
      wakeOut.length = 0;
      for (let i = 0; i < Math.min(n, 4); i++) wakeOut.push(wakeSlots[i]);
      return wakeOut;
    },
    view() {
      let meshes = 0;
      let triangles = 0;
      let nearN = 0;
      let farN = 0;
      for (const d of drawn.values()) {
        for (const mesh of d.near) {
          const n = frustumCount(mesh);
          if (n) meshes++;
          triangles += n * (mesh.geometry.attributes.position.count / 3);
        }
        nearN += d.nearCount;
        farN += d.farCount;
        if (frustumCount(d.far)) {
          meshes++;
          triangles += d.farCount * d.tris.far;
        }
      }
      for (const m of [pools, shades]) {
        if (!m.visible) continue;
        meshes++;
        triangles += m.count * 2;
      }
      const count = (k: VehicleKind): number => fleet.units.filter((u) => u.service.kind === k).length;
      return { trams: count('tram'), trains: count('rail'), pods: count('pod'), ferries: count('ferry'), cabs: fleet.cabs.length, near: nearN, far: farN, meshes, triangles, time: fleet.time };
    },
    hold(on) {
      held = on;
    },
    skip(seconds) {
      fleet.time += seconds;
      advanceCabs();
      draw();
    },
    stage(kind, near) {
      let best: { u: Unit; w: number } | null = null;
      for (const u of fleet.units) {
        if (u.service.kind !== kind) continue;
        const calls = near ? [...u.service.calls].sort((a, b) => dist(a, near) - dist(b, near)).slice(0, 1) : u.service.calls;
        for (const c of calls) {
          const w = waitFor(u, c, fleet.time);
          if (w > 0 && (!best || w < best.w)) best = { u, w };
        }
      }
      if (!best) return null;
      // A few seconds into its dwell: stood, doors open, not yet pulling away.
      fleet.time += best.w + 4;
      advanceCabs();
      draw();
      return unitRef(best.u.id);
    },
    seek(conds, horizon = 4000) {
      const holds = (t: number): boolean =>
        conds.every((c) =>
          fleet.units.some((u) => {
            if (u.service.kind !== c.kind) return false;
            const { s, v } = u.service.plan.at(t + u.offset);
            if (c.moving !== undefined && v < c.moving) return false;
            return dist(u.service.track.point(s), c.near) <= c.radius;
          }),
        );
      for (let dt = 0; dt <= horizon; dt += 0.5) {
        if (!holds(fleet.time + dt)) continue;
        fleet.time += dt;
        advanceCabs();
        draw();
        return true;
      }
      return false;
    },
    rider(at, heading = 0) {
      if (!at) {
        riderMesh.visible = false;
        return;
      }
      riderMesh.position.set(...at);
      riderMesh.rotation.set(0, -heading, 0);
      riderMesh.visible = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const g of [...owned, ...drawnGeos]) g.dispose();
      for (const d of drawn.values()) {
        for (const m of d.near) m.dispose();
        d.far.dispose();
      }
      pools.dispose();
      shades.dispose();
      for (const m of [body, trim, lamp, far, pool, shades.material as THREE.Material, ...glass.values()]) m.dispose();
    },
  };
}

/**
 * A stand-in rider (the persona figures are Task 34's): a person of 1.74 m
 * in a dark wool coat over charcoal trousers, a leather bag on the shoulder,
 * facing +x, feet on the ground.
 */
function standIn(kit: Kit): void {
  const coat = lin('#3b3430');
  const trousers = lin('#1f2124');
  const skin = lin('#b08a6e');
  const hair = lin('#1c1714');
  const shoe = lin('#0e0d0d');
  const cloth: Surf = [0, 0.85];
  for (const sz of [-1, 1]) {
    kit.box('trim', [0.05, 0.04, sz * 0.1], [0.27, 0.08, 0.1], shoe, [0, 0.4]);
    kit.rod('trim', [0, 0.08, sz * 0.1], [0, 0.82, sz * 0.095], 0.07, trousers, cloth, 10);
  }
  kit.loft(
    [
      { y: 0.7, front: 0.15, rear: 0.15, w: 0.24, rf: 0.14, rr: 0.14 },
      { y: 1.0, front: 0.13, rear: 0.13, w: 0.2, rf: 0.12, rr: 0.12 },
      { y: 1.28, front: 0.13, rear: 0.13, w: 0.21, rf: 0.12, rr: 0.12 },
      { y: 1.42, front: 0.12, rear: 0.12, w: 0.22, rf: 0.1, rr: 0.1 },
      { y: 1.47, front: 0.08, rear: 0.08, w: 0.11, rf: 0.07, rr: 0.07 },
      { y: 1.53, front: 0.06, rear: 0.06, w: 0.06, rf: 0.055, rr: 0.055 },
    ],
    [0],
    (_x, y) => ({ part: 'trim', colour: y > 1.47 ? skin : coat, surf: cloth }),
    6,
    { top: null, bottom: { part: 'trim', colour: coat, surf: cloth } },
  );
  kit.loft(
    [
      { y: 1.52, front: 0.07, rear: 0.08, w: 0.07, rf: 0.065, rr: 0.07 },
      { y: 1.58, front: 0.1, rear: 0.1, w: 0.085, rf: 0.08, rr: 0.08 },
      { y: 1.66, front: 0.105, rear: 0.105, w: 0.088, rf: 0.085, rr: 0.085 },
      { y: 1.71, front: 0.09, rear: 0.1, w: 0.08, rf: 0.075, rr: 0.08 },
      { y: 1.74, front: 0.05, rear: 0.07, w: 0.05, rf: 0.045, rr: 0.05 },
    ],
    [0],
    (x, y) => ({ part: 'trim', colour: y > 1.67 || (x < -0.02 && y > 1.6) ? hair : skin, surf: [0, 0.6] }),
    6,
    { top: { part: 'trim', colour: hair, surf: [0, 0.7] }, bottom: null },
  );
  for (const sz of [-1, 1]) {
    kit.rod('trim', [0, 1.4, sz * 0.24], [0.04, 0.86, sz * 0.27], 0.055, coat, cloth, 8);
    kit.box('trim', [0.05, 0.81, sz * 0.27], [0.07, 0.09, 0.04], skin, [0, 0.6]);
  }
  // The bag on its strap.
  kit.box('trim', [-0.02, 0.95, -0.3], [0.32, 0.25, 0.09], lin('#4a2f1e'), [0, 0.5]);
  kit.bar('trim', [-0.02, 1.07, -0.3], [0, 1.43, 0.18], 0.035, 0.008, lin('#2b1d14'));
}

/** Whether a model's kind is one the fleet runs (keeps the table above honest for the type checker). */
void MODEL_KIND;
void BANKS;
