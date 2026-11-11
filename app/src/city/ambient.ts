import * as THREE from 'three';

import { inChannel, railHalf, STREET_PITCH, streetLine, tramHalf, type Network } from '../../../shared/commute.js';
import { CIVIC_LAMPS, FOUNTAIN, onExchange } from './exchange.js';
import { LAYER, setLayers } from './lod.js';
import { LOD_EYE } from './lod-shader.js';
import { LAMP_EDGE, LAMP_OFFSETS, PITCH } from './lots.js';
import { HEADLAMP } from './post.js';

/**
 * The city's ambient life (Task 32): unlabelled traffic on the street grid
 * and an unlabelled crowd on its pavements, plazas and tram platforms. It is
 * atmosphere only: nothing here stands for a persona, carries a plate, or
 * reads a trip, and its cabs (an ochre saloon) carry no roof light, so none
 * can be mistaken for a persona's cab (vehicles.ts builds those).
 *
 * Traffic. Cars drive on the right in the two lanes of the street grid out
 * past the elevated rail's loop, round the plazas and courts and off the
 * river, never along the tram's or the rail's streets (they cross them at
 * junctions, giving way to a tram coming through). Each follows the car
 * ahead by the intelligent driver model (a safe time headway, a minimum gap,
 * comfortable braking), so traffic bunches, queues and pulls away. Every
 * junction where two streets cross runs signals in turn (one axis green,
 * amber, all red, the other axis): a car stops at the line on red, goes on
 * amber only if it cannot stop, never enters a box whose exit is full, and a
 * left turn yields to oncoming traffic, and none goes in that cannot clear
 * the box before the other way's green. Turning cars blink and yield to
 * people on the crossing they cut. A driver whose exit stays full takes
 * another way, and every driver leans away from streets already full, so the
 * grid flows in platoons rather than locking. Opposing left turns go in
 * turn, a car follows whoever left its lane ahead of it through the box,
 * brakes for anyone moving in the road, and treats a persona's cab (setCabs)
 * as a car: one ahead in its lane is followed, one in a box keeps it out.
 *
 * Parked cars, dark, their lamps off, line the kerbs of the streets no
 * ambient car drives and no persona cab pulls in at: the dead ends by the
 * plazas (not within 30 m of a plaza's edge or 25 m of a rank) and the
 * streets in a ring past the traffic's reach.
 *
 * A plaza laid or the network relaid keeps everyone whose lane, pavement,
 * plaza or platform still stands exactly where they are; the rest go and
 * the streets refill out of sight.
 *
 * Crowd. People walk the pavements near the plazas and the stops: each picks
 * a way at every corner, waits at the kerb for its signal and crosses with
 * the traffic beside it, pauses now and then, gives way to the people round
 * it, and some go in twos and threes. Others stand: in talk on a plaza or a
 * pavement, alone with a phone, or waiting on a tram platform. Everyone has
 * their own height, build, coat, pace, cadence and stride, and their own
 * place in the stride, so no two walk in step.
 *
 * Density follows the quality (the governor's step down to medium takes it
 * to about two fifths) and the time of day (ambientDensity); scene.ts lets
 * the hour's changes drift in out of sight.
 *
 * Drawing. Everything is instanced and drawn in the view only: a call per car
 * model near the eye and one far off (where each lamp keeps at least a
 * pixel or two and faces the way the car goes), a call for the figures near
 * and one far off, a call for the headlamps' pools and one for the contact
 * shadows. The levels dissolve into each other by a screen-door dither. Each
 * car and figure near the eye is lit by its nearest street lamp.
 */

type V2 = { x: number; z: number };

// ---------------------------------------------------------------- numbers

/** A lane's centre, this far right of the street's centre line (two 4 m lanes on an 8 m carriageway). */
const LANE = 2.0;
/** The stop line, this far from the junction's centre (the cross street's half width and a crossing). */
const BOX = 6.5;
/** The paved plazas' radius (grid.ts PLAZA_RADIUS); no car's lane comes within PLAZA_KEEP of a plaza's centre. */
const PLAZA_R = 72;
const PLAZA_KEEP = PLAZA_R + 5;
/** Pavements: from the kerb (4 m off the street's centre line) to the building line (8 m). People keep this band. */
const PAVE = { lo: 4.4, hi: 7.6, lamp: 6.0 } as const;
/** People walk the pavements within this of a plaza's centre, and of a tram stop or a pod station. */
const ZONE = { plaza: 210, stop: 130 } as const;
/** A district plaza's walkable ring: outside its plinth and bollards, inside its lanterns. */
const RING = { lo: 46, hi: 69 } as const;

/** The most cars and people each quality keeps at full density. */
export const AMBIENT_CAP = {
  high: { cars: 1600, people: 1800 },
  medium: { cars: 640, people: 720 },
} as const;

/** The near and far levels' dissolve bands, in metres from the eye, and where the far crowd fades out. */
export const LIFE_LOD = { car: { near: 190, far: 240 }, person: { near: 70, far: 95 }, crowdEnd: { near: 430, far: 520 } } as const;

/**
 * How busy the streets are at a local hour (0 to 24): quiet in the small
 * hours, full in the morning and evening rushes. Smooth through the day.
 */
export function ambientDensity(hour: number): number {
  const keys: Array<[number, number]> = [
    [0, 0.34],
    [3.5, 0.14],
    [6, 0.32],
    [8.5, 0.96],
    [10.5, 0.74],
    [13, 0.84],
    [15.5, 0.76],
    [18, 1.0],
    [20.5, 0.74],
    [23, 0.48],
    [24, 0.34],
  ];
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < keys.length; i++) {
    const [h1, v1] = keys[i];
    const [h0, v0] = keys[i - 1];
    if (h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return keys[0][1];
}

// ---------------------------------------------------------------- randomness

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A normal deviate by Box-Muller, clamped to three deviations. */
const gauss = (r: () => number): number => Math.max(-3, Math.min(3, Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())));

const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- the plazas

/** A paved place the streets give way to: a district, the civic plaza, a job site, or a quarter's court (`court`, its half side). */
export interface AmbientPlaza {
  x: number;
  z: number;
  kind: 'civic' | 'district' | 'site' | 'court';
  court?: number;
}

/** The plazas a network was laid for: the civic plaza and each district's (found from its rank, commute.ts cabRanks). */
function plazasOfNet(net: Network): AmbientPlaza[] {
  return net.ranks.map((r) => ({ x: r.x - 42, z: r.z - 84, kind: r.exchange ? ('civic' as const) : ('district' as const) }));
}

/** How far a point lies inside a plaza's keep (positive inside), with `pad` metres more round it. */
function inPlaza(p: AmbientPlaza, x: number, z: number, pad: number): boolean {
  if (p.court !== undefined) return Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) < p.court + pad;
  return Math.hypot(x - p.x, z - p.z) < PLAZA_R + pad;
}

/** The nearest distance from a point to a segment. */
function segDist(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

// ---------------------------------------------------------------- the roads

type Axis = 'x' | 'z';
type Turn = 'straight' | 'left' | 'right';

interface Signal {
  /** Seconds of green for traffic along x, then along z. */
  gx: number;
  gz: number;
  offset: number;
}
const AMBER = 3;
const ALL_RED = 2;

interface Junction {
  key: string;
  x: number;
  z: number;
  /** Lanes coming in and going out, by the way they run. */
  into: Lane[];
  out: Lane[];
  signal: Signal | null;
  /** People on each crossing now: walking along x (across the street along z), walking along z. */
  walkers: { x: number; z: number };
  /** Whether any car's lane runs along each axis here. */
  axes: { x: boolean; z: boolean };
  /** A crossing of the tram's line: cars give way to a tram coming through. */
  tram: boolean;
}

interface Lane {
  id: number;
  key: string;
  from: Junction;
  to: Junction;
  axis: Axis;
  dir: V2;
  /** The lane's start (just past the box it leaves) and its length to the stop line. */
  start: V2;
  len: number;
  moves: Move[];
  cars: Car[];
}

/** A way through a junction's box from one lane into another: a quadratic curve, measured by arc length. */
interface Move {
  from: Lane;
  to: Lane;
  turn: Turn;
  p0: V2;
  q: V2;
  p1: V2;
  len: number;
  /** Arc length at 16 even steps of the curve's parameter. */
  lut: number[];
}

interface Roads {
  junctions: Map<string, Junction>;
  lanes: Lane[];
  length: number;
}

const jkey = (x: number, z: number): string => `${x},${z}`;

function moveOf(from: Lane, to: Lane): Move {
  const p0 = { x: from.start.x + from.dir.x * from.len, z: from.start.z + from.dir.z * from.len };
  const p1 = { ...to.start };
  const cross = from.dir.x * to.dir.z - from.dir.z * to.dir.x;
  const turn: Turn = Math.abs(cross) < 1e-6 ? 'straight' : cross > 0 ? 'right' : 'left';
  const q = turn === 'straight' ? { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 } : from.axis === 'x' ? { x: p1.x, z: p0.z } : { x: p0.x, z: p1.z };
  const lut = [0];
  let prev = p0;
  for (let k = 1; k <= 16; k++) {
    const p = bez(p0, q, p1, k / 16);
    lut.push(lut[k - 1] + dist(prev, p));
    prev = p;
  }
  return { from, to, turn, p0, q, p1, len: lut[16], lut };
}

function bez(a: V2, q: V2, b: V2, t: number, out: V2 = { x: 0, z: 0 }): V2 {
  const u = 1 - t;
  out.x = u * u * a.x + 2 * u * t * q.x + t * t * b.x;
  out.z = u * u * a.z + 2 * u * t * q.z + t * t * b.z;
  return out;
}

/** The point at arc length `s` along a move. */
function movePoint(m: Move, s: number, out: V2 = { x: 0, z: 0 }): V2 {
  const L = m.lut;
  const v = clamp(s, 0, m.len);
  let k = 1;
  while (k < 16 && L[k] < v) k++;
  const t = (k - 1 + (L[k] > L[k - 1] ? (v - L[k - 1]) / (L[k] - L[k - 1]) : 0)) / 16;
  return bez(m.p0, m.q, m.p1, t, out);
}

/**
 * The street grid's lanes inside the tram's loop: every street between two
 * junctions in both directions, less the runs a plaza, a court, a site or the
 * river takes, pruned until every junction has a way on that is not back.
 */
function layRoads(net: Network, plazas: readonly AmbientPlaza[], r: () => number): Roads {
  // Out past the elevated rail's loop: the city's streets go on beyond the lines.
  const reach = railHalf(net.blocks) + 2 * STREET_PITCH;
  const lines: number[] = [];
  for (let v = -reach; v <= reach + 1e-6; v += STREET_PITCH) lines.push(v);
  // The tram's and the rail's streets: no car runs along them (the tram's reservation, the viaduct's bents);
  // cars cross them only at the junctions, and never through a loop's corner, where the lines turn.
  const loops = [net.tram.path, net.rail.path].map((pts) => {
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  });
  const onLoopLine = (a: V2, b: V2): boolean =>
    loops.some((l) => {
      if (a.x === b.x && (a.x === l.x0 || a.x === l.x1)) return Math.max(a.z, b.z) > l.z0 && Math.min(a.z, b.z) < l.z1;
      if (a.z === b.z && (a.z === l.z0 || a.z === l.z1)) return Math.max(a.x, b.x) > l.x0 && Math.min(a.x, b.x) < l.x1;
      return false;
    });
  const corner = (p: V2): boolean => loops.some((l) => (p.x === l.x0 || p.x === l.x1) && (p.z === l.z0 || p.z === l.z1));
  const edgeOk = (a: V2, b: V2): boolean => {
    if (onLoopLine(a, b) || corner(a) || corner(b)) return false;
    for (let t = 0; t <= 1; t += 0.05) if (inChannel(a.x + (b.x - a.x) * t, 6)) return false;
    for (const p of plazas) {
      if (p.court !== undefined) {
        const cx = clamp(p.x, Math.min(a.x, b.x), Math.max(a.x, b.x));
        const cz = clamp(p.z, Math.min(a.z, b.z), Math.max(a.z, b.z));
        if (Math.max(Math.abs(cx - p.x), Math.abs(cz - p.z)) < p.court + 9) return false;
      } else if (segDist(p, a, b) < PLAZA_KEEP) return false;
    }
    return true;
  };
  // Undirected edges between neighbouring junctions.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const x of lines) {
    for (const z of lines) {
      if (x + STREET_PITCH <= reach + 1e-6 && edgeOk({ x, z }, { x: x + STREET_PITCH, z })) link(jkey(x, z), jkey(x + STREET_PITCH, z));
      if (z + STREET_PITCH <= reach + 1e-6 && edgeOk({ x, z }, { x, z: z + STREET_PITCH })) link(jkey(x, z), jkey(x, z + STREET_PITCH));
    }
  }
  // The 2-core: a dead end would leave a car nowhere to go but back.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [k, s] of adj) {
      if (s.size >= 2) continue;
      for (const o of s) adj.get(o)?.delete(k);
      adj.delete(k);
      changed = true;
    }
  }
  const junctions = new Map<string, Junction>();
  for (const k of adj.keys()) {
    const [x, z] = k.split(',').map(Number);
    const tram = loops[0];
    const onTram = ((x === tram.x0 || x === tram.x1) && z > tram.z0 && z < tram.z1) || ((z === tram.z0 || z === tram.z1) && x > tram.x0 && x < tram.x1);
    junctions.set(k, { key: k, x, z, into: [], out: [], signal: null, walkers: { x: 0, z: 0 }, axes: { x: false, z: false }, tram: onTram });
  }
  const lanes: Lane[] = [];
  for (const [k, s] of adj) {
    const a = junctions.get(k)!;
    for (const o of s) {
      const b = junctions.get(o)!;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const dir = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
      const right = { x: -dir.z, z: dir.x };
      const axis: Axis = Math.abs(dir.x) > 0.5 ? 'x' : 'z';
      const lane: Lane = {
        id: lanes.length,
        key: `${k}>${o}`,
        from: a,
        to: b,
        axis,
        dir,
        start: { x: a.x + dir.x * BOX + right.x * LANE, z: a.z + dir.z * BOX + right.z * LANE },
        len: L - 2 * BOX,
        moves: [],
        cars: [],
      };
      lanes.push(lane);
      a.out.push(lane);
      b.into.push(lane);
      a.axes[axis] = true;
      b.axes[axis] = true;
    }
  }
  for (const lane of lanes) {
    for (const o of lane.to.out) if (o.to !== lane.from) lane.moves.push(moveOf(lane, o));
  }
  // Signals where two streets cross, with greens of their own and a place in the cycle.
  for (const j of junctions.values()) {
    if (!(j.axes.x && j.axes.z)) continue;
    // One cycle across the grid, its greens timed as a wave along x (80 m a block at 10 m/s) so eastbound
    // traffic moves in platoons, and a little play per junction so no two corners change at once.
    const gx = 22;
    const gz = 20;
    j.signal = { gx, gz, offset: -j.x / 10 - j.z / 25 + (r() - 0.5) * 3 };
  }
  return { junctions, lanes, length: lanes.reduce((s, l) => s + l.len, 0) };
}

/** A junction's signals at time t: which axis may go, whether its amber shows, and seconds left in that state. */
function signalAt(j: Junction, t: number, out: { green: Axis | null; amber: boolean; left: number } = { green: null, amber: false, left: 0 }): { green: Axis | null; amber: boolean; left: number } {
  const set = (green: Axis | null, amber: boolean, left: number): typeof out => {
    out.green = green;
    out.amber = amber;
    out.left = left;
    return out;
  };
  const s = j.signal;
  if (!s) return set(null, false, Infinity);
  const cycle = s.gx + s.gz + 2 * (AMBER + ALL_RED);
  let u = (((t + s.offset) % cycle) + cycle) % cycle;
  if (u < s.gx) return set('x', false, s.gx - u);
  u -= s.gx;
  if (u < AMBER) return set('x', true, AMBER - u);
  u -= AMBER;
  if (u < ALL_RED) return set(null, false, ALL_RED - u);
  u -= ALL_RED;
  if (u < s.gz) return set('z', false, s.gz - u);
  u -= s.gz;
  if (u < AMBER) return set('z', true, AMBER - u);
  return set(null, false, Math.max(0, ALL_RED - (u - AMBER)));
}

// ---------------------------------------------------------------- the cars

/** The ambient cars' kinds: three bodies of private car, a delivery van, and the city's ochre cab (a saloon, no roof light). */
export type AmbientModel = 'saloon' | 'hatch' | 'estate' | 'van' | 'cab';
const MODEL_NAMES: AmbientModel[] = ['saloon', 'hatch', 'estate', 'van', 'cab'];
/** Each model's length, width and height. */
const DIMS: Record<AmbientModel, { len: number; width: number; height: number }> = {
  saloon: { len: 4.72, width: 1.84, height: 1.46 },
  hatch: { len: 4.12, width: 1.78, height: 1.47 },
  estate: { len: 4.68, width: 1.9, height: 1.66 },
  van: { len: 5.3, width: 2.0, height: 2.28 },
  cab: { len: 4.72, width: 1.84, height: 1.46 },
};
/** How often each model runs. */
const MIX: Array<[AmbientModel, number]> = [
  ['saloon', 0.3],
  ['hatch', 0.27],
  ['estate', 0.2],
  ['van', 0.08],
  ['cab', 0.15],
];
/** Car paints in linear RGB, with a metallic flake amount: mostly greys, blacks, whites and dark blues, a few colours. */
const PAINTS: Array<[string, number, number]> = [
  ['#121315', 0.35, 12],
  ['#24262a', 0.55, 9],
  ['#4a4e53', 0.7, 9],
  ['#80848a', 0.75, 7],
  ['#a9aaa7', 0.1, 7],
  ['#b9b7b0', 0.0, 3],
  ['#18212f', 0.55, 6],
  ['#2b3c55', 0.5, 3],
  ['#4a161a', 0.45, 3],
  ['#6e201c', 0.2, 1.5],
  ['#22332a', 0.45, 2],
  ['#40382d', 0.5, 2],
  ['#6b5d46', 0.4, 1.5],
  ['#8a3519', 0.25, 0.8],
  ['#2a5060', 0.4, 1],
]
/** The ambient cab's ochre (the persona cab is cream with a graphite foot and an amber roof light). */
const CAB_PAINT = '#b9862a';

interface Car {
  id: number;
  model: AmbientModel;
  len: number;
  width: number;
  lane: Lane;
  /** The front bumper's distance along its lane; negative while it is in the box on `via`. */
  s: number;
  v: number;
  /** Its cruising speed. */
  v0: number;
  via: Move | null;
  next: Move | null;
  /** Once it may not stop for the line, it goes. */
  commit: boolean;
  brake: boolean;
  paint: [number, number, number];
  metal: number;
  /** A flicker phase of its own for the blinkers. */
  blink: number;
  /** Seconds it has stood at its line with its exit full. */
  stuck: number;
  /** Whether the eye could see it at the last frame drawn. */
  seen: boolean;
}

/** A persona's cab as the traffic sees it (scene.ts reads them off vehicles.ts): where it is, which way it faces, how fast. */
export interface CabPose {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

/** What the traffic reads of the world each step: the clock, people on the crossings, the trams and the persona cabs. */
interface Env {
  t: number;
  ped(j: Junction, axis: Axis): number;
  trams: ReadonlyArray<V2>;
  cabs: ReadonlyArray<CabPose>;
}

/** A persona cab's half length, and how near the middle of a car's lane one must stand to be in it. */
const CAB_HALF = 2.1;
const CAB_IN_LANE = 1.5;
const other = (a: Axis): Axis => (a === 'x' ? 'z' : 'x');
/** The speed a move through a box is taken at: a right turn tight, a left wider, straight on at the car's own pace. */
const turnCap = (m: Move, v0: number): number => (m.turn === 'right' ? 4.3 : m.turn === 'left' ? 5.6 : v0);

/** Scratch results, so a step allocates nothing: the gap ahead and its speed; a signal's state; a pose. */
const AHEAD = { gap: 0, vl: 0 };
const SIG: { green: Axis | null; amber: boolean; left: number } = { green: null, amber: false, left: 0 };

/** A car's view of the street ahead (into AHEAD): the gap to what it must not run into, and that thing's speed. */
function aheadOf(car: Car, idx: number, env: Env): typeof AHEAD {
  const lane = car.lane;
  AHEAD.gap = Infinity;
  AHEAD.vl = 0;
  const lead = lane.cars[idx - 1];
  if (lead) {
    AHEAD.gap = lead.s - lead.len - car.s;
    AHEAD.vl = lead.v;
  } else if (car.s >= 0) {
    const m = car.next;
    if (!m) {
      AHEAD.gap = lane.len - car.s;
    } else {
      // Past the junction: the last car in the lane it turns into, measured through the box.
      const tail = m.to.cars[m.to.cars.length - 1];
      if (tail) {
        AHEAD.gap = tail.s - tail.len - (car.s - lane.len - m.len);
        AHEAD.vl = tail.v;
      }
      if ((!car.commit && !mayEnter(car, env)) || cabHolds(car, env)) {
        const line = lane.len - car.s;
        if (line < AHEAD.gap) {
          AHEAD.gap = line;
          AHEAD.vl = 0;
        }
      }
    }
  }
  // Whoever left the same lane ahead of it and is still in the box is followed too, whatever way each turns.
  const from = car.s >= 0 ? lane : car.via ? car.via.from : null;
  if (from && (car.s < 0 || lane.len - car.s < 30)) {
    const mine = car.s >= 0 ? car.s - lane.len : car.via!.len + car.s;
    for (const o of from.to.out) {
      for (const c of o.cars) {
        if (c === car || !c.via || c.via.from !== from || c.s - c.len > 1) continue;
        const theirs = c.via.len + c.s;
        if (theirs <= mine) continue;
        const gap = theirs - c.len - mine;
        if (gap < AHEAD.gap) {
          AHEAD.gap = gap;
          AHEAD.vl = c.v;
        }
      }
    }
  }
  // A persona's cab in the lane ahead is followed like any car.
  for (const cab of env.cabs) {
    const dx = cab.x - lane.start.x;
    const dz = cab.z - lane.start.z;
    const u = dx * lane.dir.x + dz * lane.dir.z;
    if (u < car.s - car.len * 0.5 || u > lane.len + 2) continue;
    const lat = -dx * lane.dir.z + dz * lane.dir.x;
    if (Math.abs(lat) > CAB_IN_LANE) continue;
    const gap = u - CAB_HALF - car.s;
    if (gap < AHEAD.gap) {
      AHEAD.gap = gap;
      AHEAD.vl = Math.max(0, cab.speed * (Math.cos(cab.heading) * lane.dir.x + Math.sin(cab.heading) * lane.dir.z));
    }
  }
  return AHEAD;
}

/** Whether a persona's cab stands in the box ahead of a car that can still stop for it (committed or not). */
function cabHolds(car: Car, env: Env): boolean {
  if (car.s < 0 || !env.cabs.length) return false;
  const j = car.lane.to;
  const line = car.lane.len - car.s;
  if ((car.v * car.v) / (2 * 6) > line - 0.2) return false;
  for (const cab of env.cabs) if (Math.abs(cab.x - j.x) < BOX + 1.5 && Math.abs(cab.z - j.z) < BOX + 1.5) return true;
  return false;
}

/**
 * Whether a car at its lane's end may go into the box now. Commits it when
 * it may and is close enough to have to.
 */
function mayEnter(car: Car, env: Env): boolean {
  const lane = car.lane;
  const m = car.next;
  if (!m) return false;
  const j = lane.to;
  if (j.tram) for (const tr of env.trams) if (Math.abs(tr.x - j.x) < 38 && Math.abs(tr.z - j.z) < 38) return false;
  // A persona's cab in the box: nobody goes in until it has gone.
  for (const cab of env.cabs) if (Math.abs(cab.x - j.x) < BOX + 1.5 && Math.abs(cab.z - j.z) < BOX + 1.5) return false;
  const line = lane.len - car.s;
  if (j.signal) {
    const sig = signalAt(j, env.t, SIG);
    if (sig.green !== lane.axis) return false;
    // Only a car that clears the box before the other way's green goes in, unless it cannot stop at all; on
    // amber, only one that cannot stop comfortably.
    const hardStop = (car.v * car.v) / (2 * 6) > line - 0.2;
    // The time to clear it, pulling away at the cars' comfortable acceleration.
    const D = Math.max(line, 0) + m.len + car.len * 0.6;
    const clear = Math.max((-car.v + Math.sqrt(car.v * car.v + 2 * IDM.accel * D)) / IDM.accel, D / turnCap(m, car.v0));
    if (!hardStop && clear > sig.left + (sig.amber ? 0 : AMBER) + ALL_RED - 0.6) return false;
    if (sig.amber && !hardStop && (car.v * car.v) / (2 * 3.5) < line - 0.3) return false;
  }
  // People on a crossing the car would cut go first: the crossings of the street it leaves and the one it takes.
  if (env.ped(j, other(lane.axis)) > 0 || env.ped(j, other(m.to.axis)) > 0) return false;
  // Never into a box whose exit is full.
  const tail = m.to.cars[m.to.cars.length - 1];
  if (tail && tail.s - tail.len < car.len + 3 + (tail.v < 0.5 ? 2 : 0)) return false;
  // Whatever its way, a car waits for an opposing left turn already in the box or committed to it.
  const opp = j.into.find((l) => l.dir.x === -lane.dir.x && l.dir.z === -lane.dir.z);
  if (opp) {
    for (const c of opp.cars) if (c.s >= 0 && c.commit && c.next !== null && c.next.turn === 'left' && !(m.turn === 'left' && c.id > car.id && !c.commit)) return false;
    for (const o of j.out) for (const c of o.cars) if (c.s < 0 && c.via && c.via.from === opp && c.via.turn === 'left' && c.s > -c.via.len - c.len) return false;
  }
  if (m.turn === 'left') {
    // A left turn gives way to oncoming traffic: anything coming on, or in the box from the other side. Two
    // opposing left turns go in turn: the one in the box first, else the one that has waited (the lower id).
    const on = j.into.find((l) => l.dir.x === -lane.dir.x && l.dir.z === -lane.dir.z);
    if (on) {
      for (const c of on.cars) {
        if (c.s < 0) continue;
        const d = on.len - c.s;
        const turnsLeft = c.next !== null && c.next.turn === 'left';
        if (d < 45 && c.v > 0.8 && !turnsLeft) return false;
        if (d < 4 && !turnsLeft) return false;
        if (turnsLeft && (c.commit || (d < 25 && c.id < car.id))) return false;
      }
      for (const o of j.out) for (const c of o.cars) if (c.s < 0 && c.via && c.via.from === on && c.s > -c.via.len - c.len) return false;
    }
  }
  if (line < (car.v * car.v) / (2 * 2.2) + 3) car.commit = true;
  return true;
}

/** Why a car stands at its line, if it does (tests and tuning): the signal, a full exit, people crossing, oncoming traffic. */
function holdOf(car: Car, t: number): string | null {
  const lane = car.lane;
  if (car.s < 0 || lane.len - car.s > 4 || car.v > 0.3) return null;
  const m = car.next;
  if (!m) return 'no way on';
  const j = lane.to;
  if (j.signal) {
    const sig = signalAt(j, t);
    if (sig.green !== lane.axis || sig.amber) return 'signal';
  }
  if (j.walkers[other(lane.axis)] > 0 || j.walkers[other(m.to.axis)] > 0) return 'people';
  const tail = m.to.cars[m.to.cars.length - 1];
  if (tail && tail.s - tail.len < car.len + 3 + (tail.v < 0.5 ? 2 : 0)) return 'exit full';
  if (m.turn === 'left') return 'oncoming';
  return 'other';
}

/** Where a car's point `back` metres behind its front stands (into `out`): along its lane, through the box, or in the lane it came from. */
function carPoint(car: Car, back: number, out: V2): V2 {
  const s = car.s - back;
  const lane = car.lane;
  if (s >= 0 || !car.via) {
    out.x = lane.start.x + lane.dir.x * s;
    out.z = lane.start.z + lane.dir.z * s;
    return out;
  }
  const m = car.via;
  if (s >= -m.len) return movePoint(m, m.len + s, out);
  const f = m.from;
  const u = f.len + (s + m.len);
  out.x = f.start.x + f.dir.x * u;
  out.z = f.start.z + f.dir.z * u;
  return out;
}

const PF = { x: 0, z: 0 };
const PB = { x: 0, z: 0 };
const POSE: { x: number; z: number; yaw: number; junction: Junction | null; axis: Axis } = { x: 0, z: 0, yaw: 0, junction: null, axis: 'x' };

/** A car's pose (into a shared scratch: copy what you keep): its middle, heading, and the junction whose box it stands in. */
function carPose(car: Car): typeof POSE {
  carPoint(car, car.len * 0.18, PF);
  carPoint(car, car.len * 0.82, PB);
  carPoint(car, car.len / 2, POSE);
  POSE.yaw = Math.atan2(PF.z - PB.z, PF.x - PB.x);
  const mid = car.s - car.len / 2;
  const inBox = car.via !== null && mid < 0 && mid > -car.via.len;
  POSE.junction = inBox ? car.lane.from : null;
  POSE.axis = inBox ? car.via!.from.axis : car.lane.axis;
  return POSE;
}

/** Which blinker a car shows: right (+1) or left (-1) for the last 40 m before a turn and through it, else none. */
function blinkerOf(car: Car): number {
  if (car.s >= 0 && car.next && car.next.turn !== 'straight' && car.lane.len - car.s < 40) return car.next.turn === 'right' ? 1 : -1;
  if (car.via && car.s < 2 && car.via.turn !== 'straight') return car.via.turn === 'right' ? 1 : -1;
  return 0;
}

/** How full a lane is: the length its cars take over its own. */
function fullness(l: Lane): number {
  let used = 0;
  for (const c of l.cars) used += c.len + 4;
  return used / l.len;
}

/**
 * A car's choice of way on at the end of its lane: on mostly, turning
 * sometimes, and away from a street that is already full (as a driver with
 * nowhere in particular to be would). `not`, when given, is a way it will
 * not take (its exit stayed full).
 */
function chooseMove(lane: Lane, r: () => number, not: Move | null = null): Move | null {
  if (!lane.moves.length) return null;
  const w = lane.moves.map((m) => (m === not ? 0 : (m.turn === 'straight' ? 0.56 : m.turn === 'right' ? 0.24 : 0.2) * Math.max(0.03, 1 - fullness(m.to)) ** 2));
  if (w.every((x) => x === 0)) return not ?? lane.moves[0];
  let u = r() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) if ((u -= w[i]) <= 0) return lane.moves[i];
  return lane.moves[lane.moves.length - 1];
}

/** Metres of lane per car at full density: a busy evening that still flows. */
const LANE_SHARE = 34;
/** Metres of pavement per person at full density: an evening crowd near the plazas, room to pass. */
const PAVE_SHARE = 8;

/** Parked cars along the kerbs at each quality. */
export const PARKED_CAP = { high: 2400, medium: 900 } as const;

/** A car parked at a kerb: where, which way, its body and paint. */
interface Parked {
  x: number;
  z: number;
  yaw: number;
  model: Exclude<AmbientModel, 'cab'>;
  paint: [number, number, number];
  metal: number;
  seen: boolean;
}

const IDM = { accel: 1.5, decel: 2.2, gap: 2.2, headway: 1.25 } as const;

// ---------------------------------------------------------------- the crowd

/** What a person is doing: walking a pavement or a plaza, crossing a street, waiting (at a kerb or a stop), standing (in talk, alone), pausing. */
export type PersonState = 'walking' | 'crossing' | 'waiting' | 'standing' | 'paused';

/** A corner of the pavement network: a junction and the quadrant of it. */
interface Corner {
  key: string;
  j: V2;
  qx: number;
  qz: number;
}

/** A pavement edge: along a street's side from one corner to the next, walkable or not. */
interface Pave {
  key: string;
  a: string;
  b: string;
  /** Whether lamp posts stand along it (grid.ts lights the north side of streets along x and the west of streets along z). */
  lamps: boolean;
  /** How strongly people walk it: more near plazas and stops. */
  weight: number;
}

interface Walkway {
  corners: Map<string, Corner>;
  /** Corner key to the walkable pavement edges leaving it. */
  paves: Map<string, Pave[]>;
  all: Pave[];
  /** Junctions by key, for crossings and their signals (null where no car lane meets). */
  junction: (x: number, z: number) => Junction | null;
}

const ckey = (x: number, z: number, qx: number, qz: number): string => `${x},${z},${qx},${qz}`;

interface Stop {
  x: number;
  z: number;
  dir: Axis;
}

/**
 * The pavements people walk: each street's two sides between neighbouring
 * corners inside the tram's loop, near a plaza or a stop, off the river,
 * outside the plinths, courts and sites, and clear of the pod stations' lifts.
 */
function layWalkway(net: Network, plazas: readonly AmbientPlaza[], roads: Roads): Walkway {
  const reach = tramHalf(net.blocks) - STREET_PITCH;
  const stops: Stop[] = [...net.tram.stops, ...net.pods.flatMap((l) => l.stops)].map((s) => ({ x: s.x, z: s.z, dir: s.dir }));
  const lifts: V2[] = net.pods.flatMap((l) =>
    l.stops.map((s) => {
      const lu = s.interchange ? 8.6 : -12;
      const ll = s.interchange ? 8.6 : 6.2;
      return s.dir === 'x' ? { x: s.x + lu, z: s.z + ll } : { x: s.x + ll, z: s.z + lu };
    }),
  );
  const centres = plazas.filter((p) => p.kind === 'district' || p.kind === 'civic');
  const corners = new Map<string, Corner>();
  const paves = new Map<string, Pave[]>();
  const all: Pave[] = [];
  const clear = (x: number, z: number): boolean => {
    if (inChannel(x, 16)) return false;
    for (const p of plazas) {
      if (p.kind === 'court' || p.kind === 'site') {
        if (inPlaza(p, x, z, 3)) return false;
      } else if (p.kind === 'district') {
        if (Math.hypot(x - p.x, z - p.z) < 44) return false;
      } else if (onExchange(x - p.x, z - p.z, 2.5) || Math.hypot(x - p.x - FOUNTAIN.x, z - p.z - FOUNTAIN.z) < FOUNTAIN.radius + 2.5) return false;
    }
    for (const l of lifts) if (Math.abs(l.x - x) < 3 && Math.abs(l.z - z) < 3) return false;
    return true;
  };
  const corner = (x: number, z: number, qx: number, qz: number): string => {
    const k = ckey(x, z, qx, qz);
    if (!corners.has(k)) corners.set(k, { key: k, j: { x, z }, qx, qz });
    return k;
  };
  const add = (a: string, b: string, lamps: boolean, pts: V2[], mid: V2): void => {
    for (const p of pts) if (!clear(p.x, p.z)) return;
    let w = 0;
    for (const p of centres) w = Math.max(w, 1 - dist(mid, p) / ZONE.plaza);
    for (const s of stops) w = Math.max(w, 0.8 * (1 - dist(mid, s) / ZONE.stop));
    if (w <= 0) return;
    const e: Pave = { key: `${a}|${b}`, a, b, lamps, weight: 0.25 + w };
    all.push(e);
    (paves.get(a) ?? paves.set(a, []).get(a)!).push(e);
    (paves.get(b) ?? paves.set(b, []).get(b)!).push(e);
  };
  for (let x = -reach; x <= reach + 1e-6; x += STREET_PITCH) {
    for (let z = -reach; z <= reach + 1e-6; z += STREET_PITCH) {
      for (const q of [-1, 1]) {
        // Along x, from this junction to the next, on side q of the street.
        if (x + STREET_PITCH <= reach + 1e-6) {
          const pts: V2[] = [];
          for (let u = 4; u <= STREET_PITCH - 4; u += 2) pts.push({ x: x + u, z: z + q * 6 });
          add(corner(x, z, 1, q), corner(x + STREET_PITCH, z, -1, q), q < 0, pts, { x: x + 40, z: z + q * 6 });
        }
        if (z + STREET_PITCH <= reach + 1e-6) {
          const pts: V2[] = [];
          for (let u = 4; u <= STREET_PITCH - 4; u += 2) pts.push({ x: x + q * 6, z: z + u });
          add(corner(x, z, q, 1), corner(x, z + STREET_PITCH, q, -1), q < 0, pts, { x: x + q * 6, z: z + 40 });
        }
      }
    }
  }
  return { corners, paves, all, junction: (x, z) => roads.junctions.get(jkey(x, z)) ?? null };
}

/** A point kept off the carriageways: outside a junction's box, onto the pavement's kerb edge if it strayed. */
function offRoad(x: number, z: number): V2 {
  const sx = streetLine(x);
  const sz = streetLine(z);
  const dx = x - sx;
  const dz = z - sz;
  if (Math.abs(dz) < PAVE.lo && Math.abs(dx) > PAVE.hi) return { x, z: sz + (dz < 0 ? -1 : 1) * PAVE.lo };
  if (Math.abs(dx) < PAVE.lo && Math.abs(dz) > PAVE.hi) return { x: sx + (dx < 0 ? -1 : 1) * PAVE.lo, z };
  return { x, z };
}

/** A straight piece of a person's way: from a to b, with the pavement band it must keep (lateral, from its line). */
interface Seg {
  a: V2;
  b: V2;
  len: number;
  dir: V2;
  kind: 'pave' | 'cross' | 'plaza' | 'approach' | 'pace';
  /** How far the walker may stray right (+) and left (-) of the line to give way. */
  lo: number;
  hi: number;
  /** For a crossing: the junction and the axis walked along. */
  junction?: Junction | null;
  axis?: Axis;
  /** The edge it walks, for giving way to the people on it. */
  bucket: string;
}

function seg(a: V2, b: V2, kind: Seg['kind'], bucket: string, lo = -0.6, hi = 0.6): Seg {
  const len = Math.max(dist(a, b), 1e-6);
  return { a, b, len, dir: { x: (b.x - a.x) / len, z: (b.z - a.z) / len }, kind, lo, hi, bucket };
}

interface Person {
  id: number;
  state: PersonState;
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Facing, for one who stands. */
  face: number;
  height: number;
  build: number;
  /** Walking: cruising pace (m/s), steps per second, metres per step. */
  pace: number;
  cadence: number;
  step: number;
  v: number;
  phase: number;
  /** 0 normal, 1 hands in pockets, 2 a phone, 3 a bag, 4 talking. */
  style: number;
  coat: [number, number, number];
  legs: [number, number, number];
  skin: number;
  hair: number;
  coatLen: number;
  hat: number;
  group: number;
  /** Followers keep beside their group's leader. */
  leader: Person | null;
  slot: V2;
  /** Lateral pavement offset it keeps, its corner, the way it came, and the piece it walks now. */
  o: number;
  at: string | null;
  came: string | null;
  seg: Seg | null;
  u: number;
  sh: number;
  /** After this piece: a crossing to wait for (its junction, axis, and the corner on the far side). */
  plan: { kind: 'cross'; j: Junction | null; axis: Axis; to: string; from: string } | { kind: 'pave'; e: Pave; to: string } | null;
  timer: number;
  /** The next pause, in seconds. */
  pauseIn: number;
  /** A plaza walker's plaza. */
  plaza: AmbientPlaza | null;
  /** Lamp light on it: direction to the lamp and irradiance. */
  lamp: [number, number, number, number];
  /** Whether the eye could see it at the last frame drawn. */
  seen: boolean;
  /** What it last decided in giving way: how it steers, and the pace it allows itself. */
  gave: [number, number];
  /** How far a follower turns from its leader's facing when they stand. */
  jit: number;
}

const srgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
/** Coats: mostly dark and muted (charcoal, black, navy, camel, olive, grey, a trench's stone), now and then a colour. */
const COATS: Array<[string, number]> = [
  ['#232427', 10],
  ['#141517', 9],
  ['#1d2638', 7],
  ['#2b3446', 4],
  ['#7d5f3e', 4],
  ['#9a8462', 3],
  ['#45452f', 3],
  ['#4f5155', 5],
  ['#6b6d70', 3],
  ['#552126', 2],
  ['#283a2f', 2],
  ['#6e3420', 1.5],
  ['#3a475f', 2.5],
  ['#b6ae9d', 1.5],
  ['#8a6f2a', 0.8],
  ['#7e1c1c', 0.8],
  ['#1f474b', 1],
  ['#5d4a6a', 0.6],
  ['#c7c2b6', 0.6],
];
const LEGS: Array<[string, number]> = [
  ['#1e2534', 8],
  ['#121315', 8],
  ['#2a2b2e', 6],
  ['#5d5443', 2],
  ['#47484b', 3],
  ['#31415a', 4],
  ['#4a3a2c', 1.5],
  ['#8b8578', 0.8],
];
const weighted = <T>(r: () => number, a: Array<[T, number]>): T => {
  let u = r() * a.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of a) if ((u -= w) <= 0) return v;
  return a[a.length - 1][0];
};
/** A colour nudged a little in lightness and hue, so two coats of one colour are never quite one. */
function vary(c: [number, number, number], r: () => number, k = 0.12): [number, number, number] {
  const l = 1 + (r() - 0.5) * 2 * k;
  return [c[0] * l * (1 + (r() - 0.5) * k * 0.5), c[1] * l, c[2] * l * (1 + (r() - 0.5) * k * 0.5)];
}

function newPerson(id: number, r: () => number): Person {
  const height = clamp(1.71 + gauss(r) * 0.085, 1.5, 1.96);
  const pace = clamp(1.32 + gauss(r) * 0.17, 0.85, 1.85);
  const step = 0.413 * height * (0.86 + 0.14 * (pace / 1.34)) * (0.93 + r() * 0.14);
  return {
    id,
    state: 'walking',
    x: 0,
    z: 0,
    y: 0,
    yaw: 0,
    face: 0,
    height,
    build: clamp(1 + gauss(r) * 0.075, 0.82, 1.22),
    pace,
    cadence: pace / step,
    step,
    v: pace,
    phase: r() * Math.PI * 2,
    style: r() < 0.62 ? 0 : r() < 0.5 ? 1 : r() < 0.5 ? 3 : 2,
    coat: vary(srgb(weighted(r, COATS)), r),
    legs: vary(srgb(weighted(r, LEGS)), r, 0.08),
    skin: Math.pow(r(), 1.3),
    hair: r(),
    coatLen: r() < 0.45 ? 0.05 + r() * 0.15 : 0.3 + r() * 0.32,
    hat: r() < 0.14 ? 1 : 0,
    group: -1,
    leader: null,
    slot: { x: 0, z: 0 },
    o: 6,
    at: null,
    came: null,
    seg: null,
    u: 0,
    sh: 0,
    plan: null,
    timer: 0,
    pauseIn: 20 + r() * 160,
    plaza: null,
    lamp: [0, 1, 0, 0],
    seen: false,
    gave: [0, pace],
    jit: (r() - 0.5) * 0.6,
  };
}

// ---------------------------------------------------------------- street lamps

/** Street lamps by block: each a lamp head's position and its strength (lampLight reads the 3 by 3 blocks round a point). */
type Lamps = Map<number, number[]>;
const blockOf = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);

/**
 * The street lamps as grid.ts lays them, once per lay: on the south and east
 * edges of every block, a head 8 m up reaching 1.3 m over the road, none on
 * a plaza or in the river; each plaza's ring of 24 lanterns at 66 m (off the
 * exchange's steps); the civic lamp standards.
 */
function layLampsFor(plazas: readonly AmbientPlaza[], reach: number): Lamps {
  const out: Lamps = new Map();
  const put = (x: number, y: number, z: number, k: number): void => {
    const key = blockOf(Math.round(x / PITCH), Math.round(z / PITCH));
    (out.get(key) ?? out.set(key, []).get(key)!).push(x, y, z, k);
  };
  const paved = (lx: number, lz: number): boolean => plazas.some((p) => inPlaza(p, lx, lz, 0));
  const n = Math.ceil(reach / PITCH) + 2;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      for (const off of LAMP_OFFSETS) {
        const sx = i * PITCH + off;
        const sz = j * PITCH + LAMP_EDGE;
        if (!paved(sx, sz) && !inChannel(sx, 2)) put(sx, 7.9, sz + 1.3, 1);
        const ex = i * PITCH + LAMP_EDGE;
        const ez = j * PITCH + off;
        if (!paved(ex, ez) && !inChannel(ex, 2)) put(ex + 1.3, 7.9, ez, 1);
      }
    }
  }
  for (const p of plazas) {
    if (p.court !== undefined) continue;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const lx = p.x + Math.cos(a) * 66;
      const lz = p.z + Math.sin(a) * 66;
      if (p.kind === 'civic' && onExchange(lx - p.x, lz - p.z, 3)) continue;
      put(lx, 7.9, lz, 0.9);
    }
    if (p.kind === 'civic') for (const l of CIVIC_LAMPS) put(p.x + l.x, 6.5, p.z + l.z, 1.1);
  }
  return out;
}

/** The lamp that lights a point most (into `out`): the direction from the point to its head, and the irradiance it lays. */
function lampLight(lamps: Lamps, x: number, y: number, z: number, out: [number, number, number, number]): void {
  let best = 0;
  let bx = 0;
  let by = 1;
  let bz = 0;
  const ci = Math.round(x / PITCH);
  const cj = Math.round(z / PITCH);
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      const l = lamps.get(blockOf(i, j));
      if (!l) continue;
      for (let k = 0; k < l.length; k += 4) {
        const dx = l[k] - x;
        const dy = l[k + 1] - y;
        const dz = l[k + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const e = (l[k + 3] * 26) / (d2 + 6);
        if (e > best) {
          const d = Math.sqrt(d2);
          best = e;
          bx = dx / d;
          by = dy / d;
          bz = dz / d;
        }
      }
    }
  }
  out[0] = bx;
  out[1] = by;
  out[2] = bz;
  out[3] = best;
}

// ---------------------------------------------------------------- the models

/** Each model's height to its roof and its highest lamp, and its triangles near and far (tests: no cab carries a roof light). */
export interface ModelStats {
  roof: number;
  lampTop: number;
  /** Lamps showing a light of their own colour (a roof sign): none. */
  ownLights: number;
  triangles: number;
}

/**
 * Surface codes, per vertex: 0 the paint (each car's own), 1 black plastic,
 * 2 glass, 3 bright metal, 4 tyre, 5 wheel, 6 headlamp, 7 tail lamp, 8 the
 * right blinker, 9 the left blinker, 10 the high brake lamp, 11 the grille.
 */
const C = { paint: 0, plastic: 1, glass: 2, metal: 3, tyre: 4, wheel: 5, head: 6, tail: 7, blinkR: 8, blinkL: 9, brake: 10, grille: 11 } as const;

/** Geometry gathered with a code per vertex; for figures, a bone, its weight and a coat-tail measure too. */
class Builder {
  pos: number[] = [];
  nor: number[] = [];
  rig: number[] = [];
  extra: number[] = [];
  tri(a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[], rig: number[], ex: number[] = [0, 0]): void {
    this.pos.push(...a, ...b, ...c);
    this.nor.push(...na, ...nb, ...nc);
    for (let k = 0; k < 3; k++) {
      this.rig.push(...rig);
      this.extra.push(...ex);
    }
  }
  /** A box by its centre and size, turned ry about y and rz about z. */
  box(c: number[], s: number[], rig: number[], ry = 0, rz = 0, ex: number[] = [0, 0]): void {
    const g = new THREE.BoxGeometry(s[0], s[1], s[2]).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YZX')), new THREE.Vector3(1, 1, 1)));
    this.take(g, rig, ex);
  }
  take(g: THREE.BufferGeometry, rig: number[], ex: number[] = [0, 0]): void {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    for (let i = 0; i < p.count; i += 3) {
      const v = [0, 1, 2].map((k) => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]);
      const m = [0, 1, 2].map((k) => [n.getX(i + k), n.getY(i + k), n.getZ(i + k)]);
      this.tri(v[0], v[1], v[2], m[0], m[1], m[2], rig, ex);
    }
    g.dispose();
  }
  /** A tube from a to b, radius ra to rb, `seg` sides, its ends closed. */
  tube(a: number[], b: number[], ra: number, rb: number, seg: number, rig: number[], ends = true, sx = 1): void {
    const A = new THREE.Vector3(a[0], a[1], a[2]);
    const B = new THREE.Vector3(b[0], b[1], b[2]);
    const ax = B.clone().sub(A).normalize();
    const u = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(ax).normalize() : new THREE.Vector3(1, 0, 0).cross(ax).normalize();
    const w = ax.clone().cross(u).normalize();
    const ring = (c: THREE.Vector3, r: number): THREE.Vector3[] =>
      Array.from({ length: seg }, (_, k) => {
        const t = (k / seg) * Math.PI * 2;
        return c.clone().addScaledVector(u, Math.cos(t) * r * sx).addScaledVector(w, Math.sin(t) * r);
      });
    const ra_ = ring(A, ra);
    const rb_ = ring(B, rb);
    const nrm = (k: number): number[] => {
      const t = (k / seg) * Math.PI * 2;
      const n = u.clone().multiplyScalar(Math.cos(t) / sx).addScaledVector(w, Math.sin(t)).normalize();
      return [n.x, n.y, n.z];
    };
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      const p = (v: THREE.Vector3): number[] => [v.x, v.y, v.z];
      this.tri(p(ra_[k]), p(rb_[k1]), p(rb_[k]), nrm(k), nrm(k1), nrm(k), rig);
      this.tri(p(ra_[k]), p(ra_[k1]), p(rb_[k1]), nrm(k), nrm(k1), nrm(k1), rig);
    }
    if (!ends) return;
    for (const [c, r, out] of [
      [A, ra_, -1],
      [B, rb_, 1],
    ] as Array<[THREE.Vector3, THREE.Vector3[], number]>) {
      const n = [ax.x * out, ax.y * out, ax.z * out];
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        const v = (q: THREE.Vector3): number[] => [q.x, q.y, q.z];
        if (out > 0) this.tri(v(c), v(r[k]), v(r[k1]), n, n, n, rig);
        else this.tri(v(c), v(r[k1]), v(r[k]), n, n, n, rig);
      }
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, this.rig.length / (this.pos.length / 3)));
    g.setAttribute('aExtra', new THREE.Float32BufferAttribute(this.extra, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** A car's body section at one height: how far it reaches forward and back, its half width, its corner radii. */
interface Section {
  y: number;
  front: number;
  rear: number;
  w: number;
  rf: number;
  rr: number;
}

/** The outline of a section, anticlockwise from above, `arc` points to a corner. */
function outline(r: Section, arc: number): V2[] {
  const pts: V2[] = [];
  const rf = Math.min(r.rf, r.w * 0.99, (r.front + r.rear) * 0.45);
  const rr = Math.min(r.rr, r.w * 0.99, (r.front + r.rear) * 0.45);
  const corner = (cx: number, cz: number, rad: number, a0: number): void => {
    for (let k = 0; k <= arc; k++) {
      const t = a0 + (k / arc) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(t) * rad, z: cz + Math.sin(t) * rad });
    }
  };
  corner(r.front - rf, r.w - rf, rf, 0);
  corner(-r.rear + rr, r.w - rr, rr, Math.PI / 2);
  corner(-r.rear + rr, -r.w + rr, rr, Math.PI);
  corner(r.front - rf, -r.w + rf, rf, (3 * Math.PI) / 2);
  return pts;
}

/** A body lofted through sections, each face coded by `code` at its middle and normal; flat top. */
function loft(b: Builder, secs: Section[], code: (x: number, y: number, z: number, n: number[]) => number, arc: number): void {
  const O = secs.map((s) => outline(s, arc));
  const K = O[0].length;
  const P = (j: number, k: number): number[] => [O[j][k].x, secs[j].y, O[j][k].z];
  const N: number[][][] = O.map((o) => o.map(() => [0, 0, 0]));
  const fn = (a: number[], c: number[], d: number[]): number[] => {
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  };
  for (let j = 0; j + 1 < secs.length; j++) {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const n = fn(P(j, k), P(j + 1, k), P(j, k1));
      for (const [jj, kk] of [
        [j, k],
        [j, k1],
        [j + 1, k],
        [j + 1, k1],
      ])
        for (let c = 0; c < 3; c++) N[jj][kk][c] += n[c];
    }
  }
  const nrm = (j: number, k: number): number[] => {
    const v = N[j][k];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  for (let j = 0; j + 1 < secs.length; j++) {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const a = P(j, k);
      const c = P(j, k1);
      const d = P(j + 1, k1);
      const e = P(j + 1, k);
      const mid = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2, (a[2] + d[2]) / 2];
      const fnn = fn(a, e, c);
      const l = Math.hypot(fnn[0], fnn[1], fnn[2]);
      if (l < 1e-9) continue;
      const cd = code(mid[0], mid[1], mid[2], [fnn[0] / l, fnn[1] / l, fnn[2] / l]);
      b.tri(a, e, d, nrm(j, k), nrm(j + 1, k), nrm(j + 1, k1), [cd]);
      b.tri(a, d, c, nrm(j, k), nrm(j + 1, k1), nrm(j, k1), [cd]);
    }
  }
  // The roof: closed flat.
  const j = secs.length - 1;
  const top = secs[j];
  const cx = (top.front - top.rear) / 2;
  for (let k = 0; k < K; k++) {
    const k1 = (k + 1) % K;
    const cd = code(cx, top.y, 0, [0, 1, 0]);
    b.tri([cx, top.y, 0], P(j, k1), P(j, k), [0, 1, 0], [0, 1, 0], [0, 1, 0], [cd]);
  }
}

/** Where a section's outline reaches forward at lateral z (for seating lamps on a rounded nose). */
function noseX(s: Section, z: number, front: boolean): number {
  const r = front ? s.rf : s.rr;
  const reach = front ? s.front : s.rear;
  const fz = s.w - r;
  const az = Math.abs(z);
  if (az <= fz) return reach;
  const dz = Math.min(az - fz, r * 0.999);
  return reach - r + Math.sqrt(r * r - dz * dz);
}

interface CarSpec {
  secs: Section[];
  /** The glazed band: sill and head heights, and the pillars' x positions on the sides. */
  sill: number;
  head: number;
  pillars: number[];
  wheelbase: number;
  track: number;
  wheel: number;
  /** The lamps' height and the lamp clusters' lateral reach. */
  lampY: number;
  tailY: number;
  lampZ: number;
}

/** The ambient models' shapes (original): a three-box saloon, a hatchback, a tall estate and a delivery van. */
function specOf(m: AmbientModel): CarSpec {
  const S = (y: number, front: number, rear: number, w: number, rf: number, rr: number): Section => ({ y, front, rear, w, rf, rr });
  switch (m) {
    case 'hatch':
      return {
        secs: [S(0.22, 1.98, 1.98, 0.85, 0.34, 0.26), S(0.36, 2.05, 2.05, 0.885, 0.36, 0.26), S(0.62, 2.06, 2.06, 0.89, 0.36, 0.26), S(0.84, 1.99, 2.05, 0.885, 0.36, 0.26), S(0.92, 1.8, 2.03, 0.87, 0.36, 0.26), S(0.97, 0.9, 1.99, 0.84, 0.34, 0.26), S(1.0, 0.85, 1.95, 0.79, 0.3, 0.24), S(1.3, 0.1, 1.84, 0.71, 0.26, 0.22), S(1.42, -0.26, 1.72, 0.64, 0.24, 0.2), S(1.47, -0.38, 1.6, 0.6, 0.22, 0.2)],
        sill: 1.0,
        head: 1.4,
        pillars: [0.82, -0.25, -1.55],
        wheelbase: 2.6,
        track: 0.77,
        wheel: 0.31,
        lampY: 0.74,
        tailY: 0.86,
        lampZ: 0.6,
      };
    case 'estate':
      return {
        secs: [S(0.28, 2.26, 2.24, 0.91, 0.36, 0.28), S(0.44, 2.33, 2.31, 0.945, 0.38, 0.28), S(0.72, 2.34, 2.33, 0.95, 0.38, 0.28), S(0.96, 2.27, 2.32, 0.945, 0.38, 0.28), S(1.04, 2.02, 2.3, 0.925, 0.38, 0.28), S(1.1, 0.98, 2.27, 0.89, 0.34, 0.27), S(1.14, 0.92, 2.25, 0.84, 0.3, 0.26), S(1.46, 0.12, 2.17, 0.76, 0.27, 0.24), S(1.6, -0.22, 2.08, 0.69, 0.24, 0.22), S(1.66, -0.36, 1.98, 0.64, 0.22, 0.2)],
        sill: 1.14,
        head: 1.58,
        pillars: [0.9, -0.3, -1.7],
        wheelbase: 2.8,
        track: 0.82,
        wheel: 0.36,
        lampY: 0.86,
        tailY: 1.0,
        lampZ: 0.64,
      };
    case 'van':
      return {
        secs: [S(0.28, 2.6, 2.62, 0.96, 0.4, 0.14), S(0.45, 2.66, 2.66, 1.0, 0.44, 0.14), S(0.78, 2.66, 2.66, 1.0, 0.46, 0.14), S(1.0, 2.48, 2.66, 0.99, 0.46, 0.14), S(1.1, 1.85, 2.66, 0.97, 0.44, 0.14), S(1.18, 1.72, 2.66, 0.96, 0.4, 0.14), S(1.8, 1.25, 2.66, 0.96, 0.32, 0.14), S(2.18, 1.0, 2.64, 0.95, 0.24, 0.13), S(2.28, 0.86, 2.6, 0.92, 0.2, 0.12)],
        sill: 1.18,
        head: 1.86,
        pillars: [1.3],
        wheelbase: 3.3,
        track: 0.86,
        wheel: 0.36,
        lampY: 0.95,
        tailY: 1.0,
        lampZ: 0.72,
      };
    default:
      return {
        secs: [S(0.22, 2.26, 2.25, 0.87, 0.34, 0.3), S(0.36, 2.34, 2.33, 0.91, 0.36, 0.3), S(0.62, 2.36, 2.35, 0.92, 0.36, 0.3), S(0.84, 2.31, 2.34, 0.912, 0.36, 0.3), S(0.92, 2.12, 2.24, 0.895, 0.36, 0.3), S(0.97, 1.0, 1.62, 0.86, 0.34, 0.3), S(1.0, 0.95, 1.52, 0.8, 0.3, 0.28), S(1.3, 0.2, 0.95, 0.71, 0.26, 0.24), S(1.42, -0.12, 0.62, 0.64, 0.24, 0.22), S(1.46, -0.25, 0.46, 0.6, 0.22, 0.2)],
        sill: 1.02,
        head: 1.4,
        pillars: [0.9, 0.05, -0.75],
        wheelbase: 2.82,
        track: 0.8,
        wheel: 0.33,
        lampY: 0.74,
        tailY: 0.84,
        lampZ: 0.62,
      };
  }
}

/** The near model of a car: a lofted body, glazing, wheels, lamps, blinkers, grille and mirrors. */
function carModel(m: AmbientModel): { geo: THREE.BufferGeometry; stats: ModelStats } {
  const sp = specOf(m);
  const b = new Builder();
  const roof = sp.secs[sp.secs.length - 1].y;
  const wx = sp.wheelbase / 2;
  loft(
    b,
    sp.secs,
    (x, y, z, n) => {
      if (y < 0.36) return C.plastic;
      // Wheel arches: dark round the wheels.
      if (Math.abs(n[2]) > 0.5 && y < sp.wheel * 2 + 0.12 && (Math.abs(x - wx) < sp.wheel + 0.14 || Math.abs(x + wx) < sp.wheel + 0.14)) return C.plastic;
      if (y > sp.sill && y < sp.head) {
        // Pillars on the sides.
        if (Math.abs(n[2]) > 0.6 && sp.pillars.some((p) => Math.abs(x - p) < 0.07)) return C.plastic;
        return C.glass;
      }
      return C.paint;
    },
    4,
  );
  // Wheels: tyre and a dished disc, toward the body's sides.
  for (const x of [-wx, wx]) {
    for (const s of [-1, 1]) {
      b.tube([x, sp.wheel, s * (sp.track - 0.11)], [x, sp.wheel, s * (sp.track + 0.11)], sp.wheel, sp.wheel, 14, [C.tyre]);
      b.tube([x, sp.wheel, s * (sp.track + 0.105)], [x, sp.wheel, s * (sp.track + 0.12)], sp.wheel * 0.66, sp.wheel * 0.6, 12, [C.wheel]);
    }
  }
  const front = sp.secs.reduce((a, s) => (Math.abs(s.y - sp.lampY) < Math.abs(a.y - sp.lampY) ? s : a), sp.secs[0]);
  const rear = sp.secs.reduce((a, s) => (Math.abs(s.y - sp.tailY) < Math.abs(a.y - sp.tailY) ? s : a), sp.secs[0]);
  let lampTop = 0;
  const lamp = (c: number[], s: number[], code: number, ry = 0): void => {
    b.box(c, s, [code], ry);
    lampTop = Math.max(lampTop, c[1] + s[1] / 2);
  };
  for (const z of [-1, 1]) {
    // Headlamps: a long lens wrapping the nose's corner.
    for (const [zz, w] of [
      [sp.lampZ - 0.08, 0.24],
      [sp.lampZ + 0.08, 0.16],
    ]) {
      const fx = noseX(front, zz, true);
      lamp([fx - 0.02, sp.lampY, z * zz], [0.07, 0.11, w], C.head, -z * Math.atan2(Math.max(0, zz - (front.w - front.rf)), front.rf) * 0.8);
    }
    const bx = noseX(front, sp.lampZ + 0.24, true);
    lamp([bx - 0.05, sp.lampY - 0.02, z * (sp.lampZ + 0.22)], [0.06, 0.06, 0.07], z > 0 ? C.blinkR : C.blinkL);
    // Tail lamps: a red cluster each side with its blinker.
    const tx = noseX(rear, sp.lampZ, false);
    lamp([-tx + 0.02, sp.tailY, z * sp.lampZ], [0.06, 0.09, 0.3], C.tail);
    const tb = noseX(rear, sp.lampZ + 0.22, false);
    lamp([-tb + 0.03, sp.tailY - 0.1, z * (sp.lampZ + 0.16)], [0.05, 0.05, 0.12], z > 0 ? C.blinkR : C.blinkL);
    // Mirrors.
    b.box([sp.secs[5].front - 0.15, sp.sill + 0.05, z * (sp.secs[3].w + 0.1)], [0.14, 0.11, 0.18], [C.paint]);
    b.box([sp.secs[5].front - 0.12, sp.sill + 0.0, z * (sp.secs[3].w + 0.02)], [0.06, 0.04, 0.14], [C.plastic]);
  }
  const side = sp.secs[2];
  // Lamp units: each headlamp in a dark housing with a bright bezel, each tail lamp in a dark red housing.
  for (const z of [-1, 1]) {
    const hx = noseX(front, sp.lampZ, true);
    b.box([hx - 0.045, sp.lampY, z * sp.lampZ], [0.05, 0.15, 0.46], [C.plastic]);
    b.box([hx - 0.03, sp.lampY + 0.08, z * sp.lampZ], [0.04, 0.012, 0.47], [C.metal]);
    b.box([hx - 0.03, sp.lampY - 0.08, z * sp.lampZ], [0.04, 0.012, 0.47], [C.metal]);
    const tx = noseX(rear, sp.lampZ, false);
    b.box([-tx + 0.045, sp.tailY, z * sp.lampZ], [0.05, 0.14, 0.4], [C.plastic]);
  }
  // The grille: a bright frame round dark slats.
  {
    const gx0 = noseX(front, 0, true) - 0.02;
    const gw = front.w * 0.9;
    const gy = sp.lampY - 0.18;
    for (const dy of [-0.09, 0.09]) b.box([gx0 + 0.005, gy + dy, 0], [0.03, 0.018, gw], [C.metal]);
    for (const dz of [-1, 1]) b.box([gx0 + 0.005, gy, (dz * gw) / 2], [0.03, 0.19, 0.018], [C.metal]);
    for (const dy of [-0.045, 0, 0.045]) b.box([gx0 + 0.012, gy + dy, 0], [0.02, 0.012, gw - 0.04], [C.plastic]);
  }
  // Window frames: a black rubber line round the side glass's head and down each door's edge.
  for (const z of [-1, 1]) {
    const head = sp.secs.reduce((a2, q) => (Math.abs(q.y - sp.head) < Math.abs(a2.y - sp.head) ? q : a2), sp.secs[0]);
    b.box([(head.front - head.rear) / 2, sp.head - 0.01, z * (head.w + 0.004)], [head.front + head.rear - 0.25, 0.03, 0.012], [C.plastic]);
  }
  // Wheel arches: a dark lip round each arch on the flank, and the well's shadow behind the wheel.
  for (const x of [-wx, wx]) {
    for (const z of [-1, 1]) {
      const r = sp.wheel + 0.1;
      for (let k = 0; k < 7; k++) {
        const a0 = (k / 7) * Math.PI;
        const a1 = ((k + 1) / 7) * Math.PI;
        const am = (a0 + a1) / 2;
        b.box([x + Math.cos(am) * r, sp.wheel + Math.sin(am) * r, z * (side.w + 0.006)], [0.05, r * (a1 - a0) + 0.01, 0.014], [C.plastic], 0, am);
      }
      b.tube([x, sp.wheel, z * (sp.track - 0.16)], [x, sp.wheel, z * (sp.track - 0.13)], sp.wheel + 0.05, sp.wheel + 0.05, 10, [C.tyre]);
    }
  }
  // Door seams and handles, and a bright line along the glass's sill.
  const doors = m === 'van' ? [1.05, -0.2] : m === 'hatch' ? [0.75, -0.42] : [0.86, -0.2, -1.12];
  for (const z of [-1, 1]) {
    for (const x of doors) b.box([x, (0.4 + sp.sill) / 2, z * (side.w + 0.004)], [0.012, sp.sill - 0.42, 0.006], [C.plastic]);
    for (const x of doors.slice(0, -1)) b.box([x - 0.32, sp.sill - 0.17, z * (side.w + 0.012)], [0.16, 0.03, 0.02], [C.metal]);
    const belt = sp.secs.find((q) => q.y >= sp.sill - 0.001) ?? side;
    b.box([(belt.front - belt.rear) / 2, sp.sill + 0.005, z * (belt.w + 0.006)], [belt.front + belt.rear - 0.5, 0.018, 0.012], [C.metal]);
  }
  // The grille, the high brake lamp, and a bright sill line.
  const gx = noseX(front, 0, true);
  b.box([gx - 0.03, sp.lampY - 0.18, 0], [0.06, 0.16, front.w * 0.9], [C.grille]);
  if (m !== 'van') {
    const hb = sp.secs[sp.secs.length - 2];
    lamp([-hb.rear + 0.08, hb.y - 0.03, 0], [0.04, 0.035, 0.4], C.brake);
  }
  const geo = b.geometry();
  // Every lamp's top, and no lamp carries a colour of its own (the shader colours them by code).
  return { geo, stats: { roof, lampTop, ownLights: 0, triangles: geo.attributes.position.count / 3 } };
}

/**
 * The far level: a body and a glasshouse as two boxes, and four lamps as
 * quads the shader turns to face the eye and keeps at least a pixel or two
 * across (aExtra: the corner of the quad).
 */
function farCarModel(): THREE.BufferGeometry {
  const b = new Builder();
  b.box([0, 0.55, 0], [4.6, 0.62, 1.82], [C.paint]);
  b.box([-0.25, 1.12, 0], [2.4, 0.54, 1.5], [C.glass]);
  b.box([0, 0.2, 0], [4.4, 0.18, 1.7], [C.plastic]);
  for (const [x, y, code] of [
    [2.31, 0.72, C.head],
    [-2.31, 0.84, C.tail],
  ]) {
    for (const z of [-0.62, 0.62]) {
      const n = [x > 0 ? 1 : -1, 0, 0];
      const c = [x, y, z];
      const q = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      b.tri(c, c, c, n, n, n, [code], q[0]);
      b.extra.splice(-6, 6, ...q[0], ...q[1], ...q[2]);
      b.tri(c, c, c, n, n, n, [code], q[0]);
      b.extra.splice(-6, 6, ...q[0], ...q[2], ...q[3]);
    }
  }
  return b.geometry();
}

/** The figure's joints, at 1.75 m (each figure is scaled to its own height and build). */
const JOINT = {
  hip: [0, 0.92, 0.095],
  knee: [0.01, 0.5, 0.095],
  ankle: [0, 0.085, 0.095],
  shoulder: [0, 1.43, 0.195],
  elbow: [-0.01, 1.15, 0.215],
  wrist: [0.01, 0.89, 0.215],
  neck: [0, 1.52, 0],
} as const;

/** Figure codes: 0 skin, 1 hair, 2 coat, 3 legs, 4 shoes. */
const F = { skin: 0, hair: 1, coat: 2, legs: 3, shoes: 4 } as const;
/** Bones: 0 body, 1 head, 2 and 3 the left thigh and shin, 4 and 5 the right, 6 and 7 the left upper arm and forearm, 8 and 9 the right. */
const B = { body: 0, head: 1, thighL: 2, shinL: 3, thighR: 4, shinR: 5, armL: 6, foreL: 7, armR: 8, foreR: 9 } as const;

/**
 * A figure (original), as a rig: every vertex carries its bone, how much it
 * follows that bone, its surface and (for the coat's tails) how far down the
 * tail it lies. Near: tapered limbs, a torso with a chest and a waist, an
 * ellipsoid head with its hair, hands and shoes. Far: boxes on the same rig.
 */
function figureModel(lo: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const rig = (bone: number, code: number, w = 1): number[] => [bone, w, code];
  if (lo) {
    for (const side of [-1, 1]) {
      const z = side * JOINT.hip[2];
      b.box([0, 0.71, z], [0.15, 0.42, 0.14], rig(side < 0 ? B.thighL : B.thighR, F.legs));
      b.box([0, 0.3, z], [0.12, 0.44, 0.11], rig(side < 0 ? B.shinL : B.shinR, F.legs));
      b.box([0.05, 0.04, z], [0.25, 0.08, 0.1], rig(side < 0 ? B.shinL : B.shinR, F.shoes));
      b.box([0, 1.28, side * 0.215], [0.09, 0.32, 0.09], rig(side < 0 ? B.armL : B.armR, F.coat));
      b.box([0.01, 0.98, side * 0.22], [0.08, 0.3, 0.08], rig(side < 0 ? B.foreL : B.foreR, F.coat));
    }
    b.box([0, 1.16, 0], [0.22, 0.6, 0.38], rig(B.body, F.coat));
    b.box([0.01, 1.64, 0], [0.19, 0.23, 0.16], rig(B.head, F.skin));
    b.box([-0.01, 1.74, 0], [0.2, 0.06, 0.17], rig(B.head, F.hair));
    return b.geometry();
  }
  /**
   * A loft of elliptical rings: each ring a centre, its half depth (x) and
   * half width (z); `seg` points round; smooth normals; each vertex rigged by
   * `rigOf` and carrying `ex` (the coat's tail measure).
   */
  const rings = (R: Array<{ c: number[]; rx: number; rz: number; ex?: number }>, seg: number, rigOf: (p: number[]) => number[], caps = false): void => {
    const P = R.map((r) => Array.from({ length: seg }, (_, k) => {
      const a = (k / seg) * Math.PI * 2;
      return [r.c[0] + Math.cos(a) * r.rx, r.c[1], r.c[2] + Math.sin(a) * r.rz];
    }));
    const N = R.map((r, j) => Array.from({ length: seg }, (_, k) => {
      const a = (k / seg) * Math.PI * 2;
      // Outward in the ring, tilted by how the radius changes along the loft.
      const up = R[Math.min(j + 1, R.length - 1)];
      const dn = R[Math.max(j - 1, 0)];
      const dy = up.c[1] - dn.c[1] || 1;
      const dr = ((up.rx + up.rz) - (dn.rx + dn.rz)) / 2;
      const n = [Math.cos(a) / r.rx, -dr / dy / ((r.rx + r.rz) / 2) * 0.5, Math.sin(a) / r.rz];
      const l = Math.hypot(n[0], n[1], n[2]);
      return [n[0] / l, n[1] / l, n[2] / l];
    }));
    for (let j = 0; j + 1 < R.length; j++) {
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        const quad: Array<[number, number]> = [
          [j, k],
          [j + 1, k],
          [j + 1, k1],
          [j, k1],
        ];
        for (const tri of [
          [0, 1, 2],
          [0, 2, 3],
        ]) {
          const v = tri.map((i) => quad[i]);
          const mid = [(P[v[0][0]][v[0][1]][0] + P[v[1][0]][v[1][1]][0] + P[v[2][0]][v[2][1]][0]) / 3, 0, (P[v[0][0]][v[0][1]][2] + P[v[1][0]][v[1][1]][2] + P[v[2][0]][v[2][1]][2]) / 3];
          b.tri(P[v[0][0]][v[0][1]], P[v[1][0]][v[1][1]], P[v[2][0]][v[2][1]], N[v[0][0]][v[0][1]], N[v[1][0]][v[1][1]], N[v[2][0]][v[2][1]], rigOf(mid));
          b.extra.splice(-6, 6, ...v.flatMap(([jj]) => [R[jj].ex ?? 0, 0]));
        }
      }
    }
    if (!caps) return;
    for (const [j, dir] of [
      [0, -1],
      [R.length - 1, 1],
    ]) {
      const c = R[j].c;
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        const n = [0, dir, 0];
        if (dir > 0) b.tri(c, P[j][k1], P[j][k], n, n, n, rigOf(c));
        else b.tri(c, P[j][k], P[j][k1], n, n, n, rigOf(c));
      }
    }
  };
  const one = (r: number[]) => () => r;
  for (const side of [-1, 1]) {
    const z = side * JOINT.hip[2];
    const thigh = side < 0 ? B.thighL : B.thighR;
    const shin = side < 0 ? B.shinL : B.shinR;
    const arm = side < 0 ? B.armL : B.armR;
    const fore = side < 0 ? B.foreL : B.foreR;
    // The leg: a full thigh tapering to the knee, the calf, a slim ankle.
    rings(
      [
        { c: [0.012, 0.47, z], rx: 0.05, rz: 0.048 },
        { c: [0.005, 0.62, z], rx: 0.064, rz: 0.06 },
        { c: [0.0, 0.8, z * 1.02], rx: 0.078, rz: 0.074 },
        { c: [-0.005, 0.93, z * 1.05], rx: 0.09, rz: 0.084 },
      ],
      9,
      one(rig(thigh, F.legs)),
    );
    rings(
      [
        { c: [0.0, 0.07, z], rx: 0.036, rz: 0.034 },
        { c: [-0.006, 0.16, z], rx: 0.04, rz: 0.038 },
        { c: [-0.014, 0.33, z], rx: 0.056, rz: 0.05 },
        { c: [0.006, 0.48, z], rx: 0.05, rz: 0.047 },
      ],
      9,
      one(rig(shin, F.legs)),
    );
    // The shoe: a heel and a rounded toe on the ground.
    rings(
      [
        { c: [-0.04, 0.0, z], rx: 0.045, rz: 0.042 },
        { c: [0.02, 0.0, z], rx: 0.09, rz: 0.048 },
      ],
      8,
      one(rig(shin, F.shoes)),
    );
    rings(
      [
        { c: [0.04, 0.0, z], rx: 0.13, rz: 0.048 },
        { c: [0.03, 0.075, z], rx: 0.1, rz: 0.044 },
        { c: [0.0, 0.1, z], rx: 0.05, rz: 0.04 },
      ],
      8,
      one(rig(shin, F.shoes)),
    );
    // The arm in its sleeve: a rounded shoulder, the upper arm, the forearm; the hand.
    const sz = side * JOINT.shoulder[2];
    rings(
      [
        { c: [0, 1.15, side * JOINT.elbow[2]], rx: 0.044, rz: 0.042 },
        { c: [0, 1.29, side * 0.207], rx: 0.05, rz: 0.048 },
        { c: [0, 1.4, sz], rx: 0.058, rz: 0.056 },
        { c: [0, 1.455, sz * 0.93], rx: 0.045, rz: 0.04 },
      ],
      8,
      one(rig(arm, F.coat)),
      true,
    );
    rings(
      [
        { c: [0.012, 0.9, side * JOINT.wrist[2]], rx: 0.034, rz: 0.03 },
        { c: [0.005, 1.02, side * 0.218], rx: 0.04, rz: 0.038 },
        { c: [-0.005, 1.16, side * JOINT.elbow[2]], rx: 0.045, rz: 0.043 },
      ],
      8,
      one(rig(fore, F.coat)),
    );
    rings(
      [
        { c: [0.02, 0.8, side * 0.212], rx: 0.016, rz: 0.012 },
        { c: [0.018, 0.84, side * 0.214], rx: 0.04, rz: 0.018 },
        { c: [0.012, 0.9, side * JOINT.wrist[2]], rx: 0.03, rz: 0.022 },
      ],
      6,
      one(rig(fore, F.skin)),
    );
  }
  // The coat over the body: a loft from its hem to the collar, the tail (below the waist) as long as this
  // figure's coat (aExtra.x: 0 at the waist, 1 at the hem), each half following its thigh a little.
  const tail = (p: number[], t: number): number[] => (t > 0 ? rig(p[2] < 0 ? B.thighL : B.thighR, F.coat, 0.5) : rig(B.body, F.coat));
  rings(
    [
      { c: [-0.004, 0.88, 0], rx: 0.125, rz: 0.19, ex: 1 },
      { c: [-0.004, 0.88, 0], rx: 0.122, rz: 0.186, ex: 0.66 },
      { c: [-0.004, 0.88, 0], rx: 0.119, rz: 0.182, ex: 0.33 },
      { c: [-0.004, 0.88, 0], rx: 0.115, rz: 0.178, ex: 0 },
    ],
    14,
    (p) => tail(p, 1),
  );
  rings(
    [
      { c: [-0.004, 0.88, 0], rx: 0.115, rz: 0.178 },
      { c: [0.0, 1.0, 0], rx: 0.108, rz: 0.165 },
      { c: [0.008, 1.14, 0], rx: 0.118, rz: 0.172 },
      { c: [0.012, 1.28, 0], rx: 0.128, rz: 0.19 },
      { c: [0.006, 1.38, 0], rx: 0.12, rz: 0.205 },
      { c: [-0.004, 1.44, 0], rx: 0.1, rz: 0.19 },
      { c: [-0.01, 1.48, 0], rx: 0.07, rz: 0.11 },
      { c: [-0.01, 1.505, 0], rx: 0.058, rz: 0.062 },
    ],
    14,
    one(rig(B.body, F.coat)),
  );
  // The neck, and the head: a skull, the face narrowing to the jaw.
  rings(
    [
      { c: [0.0, 1.49, 0], rx: 0.048, rz: 0.05 },
      { c: [0.01, 1.58, 0], rx: 0.046, rz: 0.048 },
    ],
    8,
    one(rig(B.head, F.skin)),
  );
  const hc = [0.012, 1.66, 0];
  const lat = 9;
  const lon = 12;
  const head = (i: number, k: number, grow: number): number[] => {
    const th = (i / lat) * Math.PI;
    const ph = (k / lon) * Math.PI * 2;
    const y = Math.cos(th);
    // The jaw: narrower and further forward below the cheekbones.
    const jaw = y < -0.2 ? 0.86 + 0.14 * (1 + y) : 1;
    const rx = (0.1 + (Math.cos(ph) > 0 ? 0.005 : 0.01)) * grow;
    return [hc[0] + Math.sin(th) * Math.cos(ph) * rx * jaw + (y < -0.3 ? 0.012 : 0), hc[1] + y * 0.118 * grow, hc[2] + Math.sin(th) * Math.sin(ph) * 0.083 * grow * jaw];
  };
  const hn = (p: number[]): number[] => {
    const x = (p[0] - hc[0]) / 0.0105;
    const y = (p[1] - hc[1]) / 0.0139;
    const z = (p[2] - hc[2]) / 0.0069;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  for (let i = 0; i < lat; i++) {
    for (let k = 0; k < lon; k++) {
      const a = head(i, k, 1);
      const c = head(i, k + 1, 1);
      const d = head(i + 1, k + 1, 1);
      const e = head(i + 1, k, 1);
      b.tri(a, d, e, hn(a), hn(d), hn(e), rig(B.head, F.skin));
      b.tri(a, c, d, hn(a), hn(c), hn(d), rig(B.head, F.skin));
    }
  }
  // Hair (or a hat): a shell over the crown and down the back to the nape, standing a little proud of the skull.
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < lon; k++) {
      const ph0 = (k / lon) * Math.PI * 2;
      const ph1 = ((k + 1) / lon) * Math.PI * 2;
      // Over the forehead the hairline is high; at the back it comes down to the nape.
      const reach = (ph: number): number => (Math.cos(ph) > 0.35 ? 3 : Math.cos(ph) > -0.2 ? 4 : 6);
      if (i >= Math.max(reach(ph0), reach(ph1))) continue;
      const a = head(i, k, 1.07);
      const c = head(i, k + 1, 1.07);
      const d = head(i + 1, k + 1, 1.07);
      const e = head(i + 1, k, 1.07);
      b.tri(a, d, e, hn(a), hn(d), hn(e), rig(B.head, F.hair));
      b.tri(a, c, d, hn(a), hn(c), hn(d), rig(B.head, F.hair));
    }
  }
  // The nose, a shadow of a brow: enough for a face to read at a few metres.
  b.box([hc[0] + 0.1, hc[1] - 0.012, 0], [0.026, 0.05, 0.022], rig(B.head, F.skin), 0, -0.25);
  return b.geometry();
}

// ---------------------------------------------------------------- materials

/**
 * The screen-door dissolve between a near and a far level (as lod-shader.ts
 * does for the roof kit): each instance measures its distance from the eye,
 * and the two levels keep complementary halves of a dither across the band.
 * `out`, when given, dissolves the far level out to nothing past it.
 */
function dissolve(sh: THREE.WebGLProgramParametersWithUniforms, band: { near: number; far: number }, level: 'near' | 'far', out?: { near: number; far: number }): void {
  sh.uniforms.uLodEye = LOD_EYE;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uLodEye;\nvarying float vLodFade;\nvarying float vLodOut;').replace(
    '#include <project_vertex>',
    `#include <project_vertex>
    {
      vec4 lodAt = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float lodD = distance(lodAt.xyz, uLodEye);
      vLodFade = smoothstep(${band.near.toFixed(1)}, ${band.far.toFixed(1)}, lodD);
      vLodOut = ${out ? `smoothstep(${out.near.toFixed(1)}, ${out.far.toFixed(1)}, lodD)` : '0.0'};
      if (${level === 'near' ? 'vLodFade >= 1.0' : 'vLodFade <= 0.0 || vLodOut >= 1.0'}) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    }`,
  );
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLodFade;\nvarying float vLodOut;').replace(
    'void main() {',
    `void main() {
    float lodN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (${level === 'near' ? 'lodN < vLodFade' : 'lodN >= vLodFade || lodN < vLodOut'}) discard;`,
  );
}

/** The street lamps' sodium light on whatever is near one (lampLight), added as a direct diffuse term. */
const LAMP_VERT = `
  attribute vec4 aLampL;
  varying vec3 vLampDir;
  varying vec3 vLampCol;`;
const LAMP_VERT_MAIN = `
  vLampDir = normalize((viewMatrix * vec4(aLampL.xyz, 0.0)).xyz);
  vLampCol = vec3(1.0, 0.56, 0.22) * aLampL.w;`;
const LAMP_FRAG = `
  varying vec3 vLampDir;
  varying vec3 vLampCol;`;
const LAMP_FRAG_MAIN = `
  {
    float wrap = max(dot(normal, vLampDir), 0.0) * 0.85 + 0.15 * (0.5 + 0.5 * dot(normal, vLampDir));
    reflectedLight.directDiffuse += vLampCol * wrap * BRDF_Lambert(material.diffuseColor);
  }`;

/** The near cars' material: the paint each car's own, every other surface by its code, the lamps lit by the car's state. */
function carMaterial(far: boolean): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.55 });
  m.name = far ? 'ambient-car-far' : 'ambient-car';
  const uniforms = { uTime: { value: 0 }, uPixel: { value: 0.0012 } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    dissolve(sh, LIFE_LOD.car, far ? 'far' : 'near');
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aRig;
        attribute vec2 aExtra;
        attribute vec4 aPaint;
        attribute vec4 aState;
        ${LAMP_VERT}
        uniform float uTime;
        uniform float uPixel;
        varying vec3 vAlb;
        varying vec3 vEmit;
        varying vec3 vSurf;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          int code = int(aRig + 0.5);
          vec3 alb = vec3(0.02);
          vec3 surf = vec3(0.0, 0.55, 0.0);
          vec3 emit = vec3(0.0);
          float brake = aState.x;
          float sig = aState.y;
          float blink = step(0.5, fract(uTime * 1.45 + aState.z));
          if (code == 0) { alb = aPaint.rgb; surf = vec3(aPaint.w, 0.32 - 0.12 * aPaint.w, 1.0); }
          else if (code == 1) { alb = vec3(0.018, 0.019, 0.021); surf = vec3(0.0, 0.62, 0.0); }
          else if (code == 2) { alb = vec3(0.006, 0.007, 0.008); surf = vec3(0.0, 0.05, 1.0); }
          else if (code == 3) { alb = vec3(0.5); surf = vec3(1.0, 0.28, 0.0); }
          else if (code == 4) { alb = vec3(0.012); surf = vec3(0.0, 0.88, 0.0); }
          else if (code == 5) { alb = vec3(0.24, 0.245, 0.25); surf = vec3(0.85, 0.36, 0.0); }
          else if (code == 6) { alb = vec3(0.4); surf = vec3(0.0, 0.1, 1.0); emit = vec3(5.2, 4.9, 4.3); }
          else if (code == 7) { alb = vec3(0.12, 0.0, 0.0); surf = vec3(0.0, 0.2, 1.0); emit = vec3(0.6, 0.006, 0.003) * (1.0 + 3.2 * brake); }
          else if (code == 8) { alb = vec3(0.2, 0.1, 0.0); surf = vec3(0.0, 0.2, 1.0); emit = vec3(3.4, 1.3, 0.05) * blink * step(0.5, sig) + vec3(0.04, 0.015, 0.0); }
          else if (code == 9) { alb = vec3(0.2, 0.1, 0.0); surf = vec3(0.0, 0.2, 1.0); emit = vec3(3.4, 1.3, 0.05) * blink * step(0.5, -sig) + vec3(0.04, 0.015, 0.0); }
          else if (code == 10) { alb = vec3(0.05, 0.0, 0.0); surf = vec3(0.0, 0.2, 1.0); emit = vec3(3.6, 0.1, 0.05) * brake; }
          else if (code == 11) { alb = vec3(0.012); surf = vec3(0.4, 0.4, 0.0); }
          vAlb = alb;
          vSurf = surf;
          // A parked car's lamps are off.
          vEmit = emit * (1.0 - aState.w);
          ${LAMP_VERT_MAIN}
          ${
            far
              ? `vLampQuad = vec2(0.0);
          vLampR = 0.0;
          if (code >= 6 && code <= 7) {
            // A lamp far off: a quad turned to the eye, at least a pixel or two across, its light spread over it,
            // and shown only to the side it faces (headlamps ahead, tail lamps behind).
            vec4 cw = modelMatrix * instanceMatrix * vec4(position, 1.0);
            vec3 fwd = normalize((modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
            vec3 toEye = normalize(cameraPosition - cw.xyz);
            float facing = dot(fwd, toEye) * (code == 6 ? 1.0 : -1.0);
            float show = smoothstep(-0.25, 0.45, facing);
            float d = distance(cameraPosition, cw.xyz);
            float r0 = code == 6 ? 0.11 : 0.09;
            // Parked, the lamp is out: its quad shrinks to nothing.
            float r = aState.w > 0.5 ? 0.0 : max(r0, d * uPixel * 2.0);
            vEmit = (code == 6 ? vec3(5.2, 4.9, 4.3) : vec3(2.2, 0.07, 0.035) * (1.0 + 1.8 * brake)) * show * clamp(pow(r0 / max(r, 1e-4), 0.75), 0.32, 1.0) * (1.0 - aState.w);
            transformed = position;
            vLampQuad = aExtra;
            vLampR = r;
          }`
              : ''
          }
        }`,
      )
      .replace(
        '#include <project_vertex>',
        far
          ? `#include <project_vertex>
        {
          int codeP = int(aRig + 0.5);
          if (codeP >= 6 && codeP <= 7) {
            vec4 cw = modelMatrix * instanceMatrix * vec4(position, 1.0);
            vec4 cv = viewMatrix * cw;
            cv.xy += aExtra * vLampR;
            cv.z += vLampR;
            mvPosition = cv;
            gl_Position = projectionMatrix * cv;
          }
        }`
          : '#include <project_vertex>',
      );
    if (far) sh.vertexShader = sh.vertexShader.replace('varying vec3 vSurf;', 'varying vec3 vSurf;\nvarying vec2 vLampQuad;\nvarying float vLampR;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAlb;\nvarying vec3 vEmit;\nvarying vec3 vSurf;\n${far ? 'varying vec2 vLampQuad;\nvarying float vLampR;' : ''}\n${LAMP_FRAG}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vAlb;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurf.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurf.x;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= vSurf.z;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vEmit${far ? ' * (1.0 - smoothstep(0.35, 1.0, length(vLampQuad)))' : ''};`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        ${LAMP_FRAG_MAIN}
        {
          // The sky is above: a flank reflects the dark street, a roof or a bonnet the dusk. Below the waist the
          // body takes less of the sky's light too.
          vec3 nW = inverseTransformDirection(normal, viewMatrix);
          vec3 rW = inverseTransformDirection(reflect(-normalize(vViewPosition), normal), viewMatrix);
          float skyward = smoothstep(-0.15, 0.35, rW.y);
          reflectedLight.indirectSpecular *= mix(0.1, 1.0, skyward);
          reflectedLight.indirectDiffuse *= mix(0.3, 1.0, smoothstep(-0.7, 0.7, nW.y));
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect *= mix(0.1, 1.0, skyward);
          #endif
        }`,
      );
    if (far)
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vLampR > 0.0 && length(vLampQuad) > 1.0) discard;`,
      );
  };
  m.customProgramCacheKey = () => (far ? 'palimpsest-ambient-car-far' : 'palimpsest-ambient-car');
  return m;
}

/** Skin tones from light to dark, hair from black to fair and grey, and a few hats (linear RGB). */
const FIGURE_GLSL = /* glsl */ `
  vec3 skinTone(float t) {
    vec3 a = vec3(0.72, 0.47, 0.37);
    vec3 b = vec3(0.47, 0.27, 0.17);
    vec3 c = vec3(0.13, 0.072, 0.045);
    return t < 0.55 ? mix(a, b, t / 0.55) : mix(b, c, (t - 0.55) / 0.45);
  }
  vec3 hairTone(float t) {
    if (t < 0.38) return vec3(0.012, 0.010, 0.009);
    if (t < 0.66) return vec3(0.045, 0.027, 0.016);
    if (t < 0.8) return vec3(0.11, 0.065, 0.035);
    if (t < 0.88) return vec3(0.36, 0.26, 0.13);
    if (t < 0.94) return vec3(0.16, 0.05, 0.025);
    return vec3(0.3, 0.29, 0.28);
  }
  mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  void turnAbout(inout vec3 p, inout vec3 n, vec3 at, mat3 R) { p = R * (p - at) + at; n = R * n; }
  /**
   * The figure's pose: a walk cycle blended with standing, each limb turned about its joint, child before parent.
   * aAnim: phase, walking (0 to 1), stride, style. Left is -z.
   */
  void posed(inout vec3 p, inout vec3 n) {
    int bone = int(aRig.x + 0.5);
    float w = aAnim.y;
    float ph = aAnim.x;
    float A = aAnim.z;
    int style = int(aAnim.w + 0.5);
    float s = sin(ph);
    float c = cos(ph);
    // The coat's tail: as long as this figure's coat, flaring a little toward the hem.
    float tailT = aExtra.x;
    if (tailT > 0.0) { p.y -= tailT * aLook.z; p.xz *= 1.0 + 0.16 * tailT * aLook.z; }
    // Walking: the hips swing the legs, the knee folds through the swing, the arms swing against the legs.
    float hipL = A * s;
    float hipR = -A * s;
    // The knee folds in proportion to the stride: a stroll lifts the foot only so far (a deep fold reads as a jog).
    float fold = 0.8 * clamp(A / 0.48, 0.35, 1.0);
    float kneeL = 0.07 + fold * pow(max(0.0, cos(ph + 0.45)), 1.6) + 0.1 * max(0.0, -sin(ph + 0.3));
    float kneeR = 0.07 + fold * pow(max(0.0, -cos(ph + 0.45)), 1.6) + 0.1 * max(0.0, sin(ph + 0.3));
    float swing = style == 1 ? 0.12 : style == 3 ? 0.45 : 0.8;
    float armL = -A * swing * s - 0.04;
    float armR = A * swing * s - 0.04;
    float elbL = 0.22 + 0.32 * max(0.0, -s) * swing;
    float elbR = 0.22 + 0.32 * max(0.0, s) * swing;
    // Standing: weight on one leg, the other knee easy; arms hanging, a breath, a look round.
    float idle = 1.0 - w;
    float slow = sin(ph * 0.5);
    float sHipL = 0.035 * slow;
    float sHipR = -0.02 - 0.03 * slow;
    float sKneeL = 0.04;
    float sKneeR = 0.12 + 0.06 * max(0.0, slow);
    float sArmL = 0.05;
    float sArmR = 0.05;
    float sElbL = 0.12;
    float sElbR = 0.12;
    if (style == 1) { swing = 0.1; sArmL = -0.14; sArmR = -0.14; sElbL = 0.55; sElbR = 0.55; elbL = 0.5; elbR = 0.5; armL = -0.14; armR = -0.14; }
    if (style == 2) { sArmR = 0.32; sElbR = 1.45; armR = 0.3; elbR = 1.4; sArmL = 0.12; sElbL = 0.9 + 0.05 * slow; }
    if (style == 4) { sArmR = 0.18 + 0.14 * sin(ph * 2.3); sElbR = 0.75 + 0.45 * max(0.0, sin(ph * 1.7)); }
    hipL = mix(sHipL, hipL, w);
    hipR = mix(sHipR, hipR, w);
    kneeL = mix(sKneeL, kneeL, w);
    kneeR = mix(sKneeR, kneeR, w);
    armL = mix(sArmL, armL, w);
    armR = mix(sArmR, armR, w);
    elbL = mix(sElbL, elbL, w);
    elbR = mix(sElbR, elbR, w);
    vec3 hip = vec3(${JOINT.hip[0]}, ${JOINT.hip[1]}, ${JOINT.hip[2]});
    vec3 knee = vec3(${JOINT.knee[0]}, ${JOINT.knee[1]}, ${JOINT.knee[2]});
    vec3 sho = vec3(${JOINT.shoulder[0]}, ${JOINT.shoulder[1]}, ${JOINT.shoulder[2]});
    vec3 elb = vec3(${JOINT.elbow[0]}, ${JOINT.elbow[1]}, ${JOINT.elbow[2]});
    vec3 L = vec3(1.0, 1.0, -1.0);
    if (bone == 3) turnAbout(p, n, knee * L, rotZ(-kneeL));
    if (bone == 5) turnAbout(p, n, knee, rotZ(-kneeR));
    if (bone == 2 || bone == 3) turnAbout(p, n, hip * L, rotZ(hipL * (bone == 2 ? aRig.y : 1.0)));
    if (bone == 4 || bone == 5) turnAbout(p, n, hip, rotZ(hipR * (bone == 4 ? aRig.y : 1.0)));
    if (bone == 7) turnAbout(p, n, elb * L, rotZ(elbL));
    if (bone == 9) turnAbout(p, n, elb, rotZ(elbR));
    // The arms hang a little out from the body, more so with a broad coat.
    if (bone == 6 || bone == 7) turnAbout(p, n, sho * L, rotZ(armL) * rotX(0.06 + 0.04 * w));
    if (bone == 8 || bone == 9) turnAbout(p, n, sho, rotZ(armR) * rotX(-0.06 - 0.04 * w));
    // The head: a slow look round when standing; down at the phone.
    if (bone == 1) {
      vec3 neck = vec3(0.0, ${JOINT.neck[1]}, 0.0);
      float look = idle * 0.38 * sin(ph * 0.31 + aLook.y * 6.0);
      float nod = style == 2 ? -0.38 : -0.04 * w;
      turnAbout(p, n, neck, rotY(look - 0.06 * s * w) * rotZ(nod));
    }
    // The upper body leans into the walk and turns a little against the hips.
    if (bone == 0 || bone == 1 || bone >= 6) turnAbout(p, n, vec3(0.0, 0.95, 0.0), rotY(0.07 * s * w) * rotZ(-0.055 * w));
    // The whole body drops as the legs spread (so the planted foot stays down), and sways over the standing foot.
    p.y -= w * 0.86 * (1.0 - cos(A * s)) + idle * 0.006 * (1.0 + slow);
    p.z += w * 0.022 * s + idle * 0.012 * slow;
  }`;

/** The figures' material: the rig posed in the vertex shader, each surface coloured from the instance's own colours. */
function figureMaterial(far: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
  m.name = far ? 'ambient-figure-far' : 'ambient-figure';
  m.onBeforeCompile = (sh) => {
    dissolve(sh, LIFE_LOD.person, far ? 'far' : 'near', far ? LIFE_LOD.crowdEnd : undefined);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aRig;
        attribute vec2 aExtra;
        attribute vec4 aAnim;
        attribute vec4 aLook;
        attribute vec3 aCoat;
        attribute vec3 aLegs;
        ${LAMP_VERT}
        varying vec3 vAlb;
        varying float vRough;
        ${FIGURE_GLSL}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3(normal);
        vec3 posedP = vec3(position);
        posed(posedP, objectNormal);
        {
          int code = int(aRig.z + 0.5);
          vec3 alb = aCoat;
          float rough = 0.86;
          if (code == 0) { alb = skinTone(aLook.x); rough = 0.55; }
          else if (code == 1) { alb = aLook.w > 0.5 ? aCoat * 0.55 + vec3(0.01) : hairTone(aLook.y); rough = aLook.w > 0.5 ? 0.9 : 0.5; }
          else if (code == 3) { alb = aLegs; rough = 0.8; }
          else if (code == 4) { alb = aLook.y > 0.9 ? vec3(0.55, 0.54, 0.52) : vec3(0.014, 0.013, 0.012); rough = 0.45; }
          // The folds and the ground's shade: a little darker low down and under each limb.
          alb *= (0.72 + 0.28 * smoothstep(0.0, 1.5, position.y)) * (0.85 + 0.15 * clamp(normal.y + 1.0, 0.0, 1.0));
          vAlb = alb;
          vRough = rough;
          ${LAMP_VERT_MAIN}
        }`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = posedP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAlb;\nvarying float vRough;\n${LAMP_FRAG}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vAlb;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LAMP_FRAG_MAIN}`);
  };
  m.customProgramCacheKey = () => (far ? 'palimpsest-ambient-figure-far' : 'palimpsest-ambient-figure');
  return m;
}

/** A pool of headlamp light on the road ahead (or a tail lamp's red behind): an additive fan, brightest near the lamps. */
function poolMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true });
  m.name = 'ambient-pool';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPool;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPool = position.xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vPool;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        float along = vPool.x;
        float across = abs(vPool.y) * 2.0 / (0.45 + 0.55 * along);
        float a = pow(1.0 - smoothstep(0.15, 1.0, across), 2.0) * smoothstep(0.0, 0.18, along) * pow(1.0 - smoothstep(0.05, 1.0, along), 1.6);
        diffuseColor.rgb *= a;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'palimpsest-ambient-pool';
  return m;
}

/** A contact shadow: a soft dark ellipse-cornered patch under a car or a person. */
function shadeMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  m.name = 'ambient-shade';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vShade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = position.xz * 2.0;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vShade;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 q = abs(vShade);
        float a = (1.0 - smoothstep(0.6, 1.0, q.x)) * (1.0 - smoothstep(0.45, 1.0, q.y)) * (1.0 - smoothstep(0.8, 1.2, length(q)));
        diffuseColor.a = 0.6 * a;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'palimpsest-ambient-shade';
  return m;
}

// ---------------------------------------------------------------- the ambient city

export interface AmbientCar {
  id: number;
  model: AmbientModel;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** Its lane, and its front's distance along it (negative in the box it is crossing into it). */
  lane: string;
  s: number;
  length: number;
  /** The junction whose box its middle stands in, the axis it came in on, and how it turns there. */
  junction: string | null;
  axis: Axis;
  turn: Turn;
  braking: boolean;
  blinking: number;
  /** Why it stands at its line, when it does. */
  hold: string | null;
  width: number;
}

export interface AmbientPerson {
  id: number;
  state: PersonState;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  phase: number;
  cadence: number;
  height: number;
  build: number;
  coat: [number, number, number];
  group: number;
}

export interface AmbientView {
  cars: number;
  people: number;
  walking: number;
  waiting: number;
  nearCars: number;
  farCars: number;
  nearPeople: number;
  farPeople: number;
  /** Draw calls of the main pass and the triangles they draw. */
  meshes: number;
  triangles: number;
  density: number;
  time: number;
}

export interface Ambient {
  group: THREE.Group;
  /**
   * Advances the clock by dt seconds and moves everyone; with a camera, lays
   * each car and figure into its level from the eye (and culls what it cannot
   * see), `viewHeight` the drawing buffer's height in pixels.
   */
  update(dt: number, camera?: THREE.PerspectiveCamera, viewHeight?: number): void;
  /**
   * How full the streets are, 0 to 1 of the quality's cap (scene.ts sets it
   * by the hour, ambientDensity). At once, or `gradual`: a car and a person at
   * a time, only where the eye cannot see.
   */
  setDensity(n: number, gradual?: boolean): void;
  density(): number;
  /** The governor's step down: fewer cars and people, no headlamp pools. */
  setQuality(q: 'high' | 'medium'): void;
  /** The plazas, courts and sites standing now: no car's lane crosses one and no pavement walker enters a court or a site. */
  setPlazas(plazas: readonly AmbientPlaza[]): void;
  /** The network laid again (its extent grown): the streets inside its loop. */
  relay(net: Network): void;
  /** Where the trams are now (scene.ts reads them off the transit vehicles): cars wait for one at its crossings. */
  setTrams(at: ReadonlyArray<V2>): void;
  /**
   * Where the persona cabs are now (scene.ts reads them off vehicles.ts):
   * a car follows one ahead in its lane and keeps out of a box one is in.
   */
  setCabs(at: ReadonlyArray<CabPose>): void;
  cars(): AmbientCar[];
  people(): AmbientPerson[];
  view(camera: THREE.Camera): AmbientView;
  /** Holds the clock (captures). */
  hold(on: boolean): void;
  /** Moves the clock on by `seconds` in steps (tests and captures). */
  skip(seconds: number): void;
  dispose(): void;
}

/** The near figure's triangles by surface (tests): skin, hair, coat, legs, shoes. */
export function ambientFigure(): Record<'skin' | 'hair' | 'coat' | 'legs' | 'shoes', number> {
  const g = figureModel(false);
  const rig = g.attributes.aRig;
  const out = { skin: 0, hair: 0, coat: 0, legs: 0, shoes: 0 };
  const names = ['skin', 'hair', 'coat', 'legs', 'shoes'] as const;
  for (let i = 0; i < rig.count; i += 3) out[names[Math.round(rig.getZ(i))]]++;
  g.dispose();
  return out;
}

/** Each model's lamp and roof heights and its triangles, near (tests). */
export function ambientModels(): Record<AmbientModel, ModelStats> {
  const out = {} as Record<AmbientModel, ModelStats>;
  for (const m of MODEL_NAMES) {
    const { geo, stats } = carModel(m);
    geo.dispose();
    out[m] = stats;
  }
  return out;
}

export function createAmbient(net0: Network, quality0: 'high' | 'medium', opts: { seed?: number; plazas?: readonly AmbientPlaza[]; hour?: number } = {}): Ambient {
  let net = net0;
  let quality = quality0;
  let plazas: readonly AmbientPlaza[] = opts.plazas ?? plazasOfNet(net);
  const seed = opts.seed ?? 1;
  let density = clamp(ambientDensity(opts.hour ?? new Date().getHours() + new Date().getMinutes() / 60), 0, 1);
  let time = 0;
  let held = false;
  /** Whether the population moves toward its density out of sight (scene.ts, by the hour) rather than at once. */
  let drifting = false;
  /** After a relay, until the streets are back to their numbers. */
  let refill = false;
  let roads: Roads;
  let walk: Walkway;
  let cars: Car[] = [];
  let people: Person[] = [];
  /** Plaza walkers' lanterns and lamp posts, which they walk round. */
  let posts: V2[] = [];
  /** The street lamps, by block, as they stand now. */
  let lamps: Lamps = new Map();
  /** Cars parked along kerbs no traffic or persona cab uses, the most of them each quality keeps. */
  let parkedAll: Parked[] = [];
  let parked: Parked[] = [];

  function layLamps(): void {
    lamps = layLampsFor(plazas, railHalf(net.blocks) + 6 * STREET_PITCH);
  }

  /**
   * Parked cars along the kerbs of streets no ambient car drives and no
   * persona cab comes to: the dead ends the plazas leave and the streets past
   * the traffic's reach (out a ring of blocks); never on the tram's or the
   * rail's streets, in a junction, in a plaza or a court, within 30 m of a
   * plaza's edge (where kerbOf brings a persona's cab in) or 25 m of a rank.
   * Shuffled once, so the quality keeps the first of them.
   */
  function layParked(): void {
    const r = mulberry(seed * 4241 + 29);
    const inner = railHalf(net.blocks) + 2 * STREET_PITCH;
    const reach = inner + 3 * STREET_PITCH;
    const driven = new Set<string>();
    for (const l of roads.lanes) {
      const a = jkey(l.from.x, l.from.z);
      const b = jkey(l.to.x, l.to.z);
      driven.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    const loops = [net.tram.path, net.rail.path].map((pts) => ({ x: pts.map((p) => p[0]), z: pts.map((p) => p[2]) }));
    const onLoop = (along: Axis, line: number): boolean => loops.some((l) => (along === 'z' ? l.x : l.z).some((v) => Math.abs(v - line) < 1));
    const centres = plazas.filter((p) => p.court === undefined);
    const ok = (x: number, z: number): boolean => {
      if (inChannel(x, 8)) return false;
      for (const p of plazas) if (inPlaza(p, x, z, 3)) return false;
      for (const p of centres) if (Math.hypot(x - p.x, z - p.z) < PLAZA_R + 30) return false;
      for (const k of net.ranks) if (Math.hypot(x - k.x, z - k.z) < 25) return false;
      return true;
    };
    const out: Parked[] = [];
    for (let a = -reach; a <= reach + 1e-6; a += STREET_PITCH) {
      for (let b = -reach; b + STREET_PITCH <= reach + 1e-6; b += STREET_PITCH) {
        for (const along of ['x', 'z'] as Axis[]) {
          // The run from b to b + 80 along `along`, on the street at `a`.
          if (onLoop(along, a)) continue;
          const p0 = along === 'x' ? { x: b, z: a } : { x: a, z: b };
          const p1 = along === 'x' ? { x: b + STREET_PITCH, z: a } : { x: a, z: b + STREET_PITCH };
          const k0 = jkey(p0.x, p0.z);
          const k1 = jkey(p1.x, p1.z);
          if (driven.has(k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`)) continue;
          for (const side of [-1, 1]) {
            // Nose the way that side's traffic would go (on the right).
            const dir = along === 'x' ? side : -side;
            const yaw = along === 'x' ? (dir > 0 ? 0 : Math.PI) : dir > 0 ? Math.PI / 2 : -Math.PI / 2;
            let u = BOX + 3 + r() * 4;
            while (u < STREET_PITCH - BOX - 3) {
              const model = weighted(r, MIX.filter(([m]) => m !== 'cab')) as Exclude<AmbientModel, 'cab'>;
              const len = DIMS[model].len;
              const c = u + len / 2;
              if (c + len / 2 > STREET_PITCH - BOX - 3) break;
              const x = along === 'x' ? b + c : a + side * 3.05;
              const z = along === 'x' ? a + side * 3.05 : b + c;
              if (r() < 0.68 && ok(x, z)) {
                const hex = weighted(r, PAINTS.map(([h, , w]) => [h, w] as [string, number]));
                out.push({ x, z, yaw: yaw + (r() - 0.5) * 0.04, model, paint: vary(srgb(hex), r, 0.06), metal: PAINTS.find(([h]) => h === hex)?.[1] ?? 0.3, seen: false });
              }
              u += len + 0.7 + r() * 1.6;
            }
          }
        }
      }
    }
    // Shuffled once, the same for every quality: medium keeps a subset of high's.
    for (let i = out.length - 1; i > 0; i--) {
      const k = Math.floor(r() * (i + 1));
      [out[i], out[k]] = [out[k], out[i]];
    }
    parkedAll = out;
    parked = out.slice(0, PARKED_CAP[quality]);
  }

  // ---- population

  function capacity(): { cars: number; people: number } {
    const cap = AMBIENT_CAP[quality];
    // People by the pavement they have (a person to every PAVE_SHARE metres of it), and the plazas and platforms.
    const squares = plazas.filter((p) => p.kind === 'district' || p.kind === 'civic').length;
    const room = (walk.all.length * STREET_PITCH) / PAVE_SHARE + squares * 34 + net.tram.stops.length * 10;
    return { cars: Math.min(cap.cars, Math.floor(roads.length / LANE_SHARE)), people: Math.min(cap.people, Math.round(room * (cap.people / AMBIENT_CAP.high.people))) };
  }

  /**
   * Lays the streets and pavements for the network and plazas as they are
   * now. Laid afresh, it populates them; laid again (`keep`), everyone whose
   * lane, pavement, plaza or stop still stands stays exactly where they are,
   * the rest go, and the streets refill out of sight (drift).
   */
  function lay(keep = false): void {
    const oldCars = keep ? cars : [];
    const oldPeople = keep ? people : [];
    const r = mulberry(seed * 7919 + 17);
    roads = layRoads(net, plazas, r);
    walk = layWalkway(net, plazas, roads);
    posts = [];
    for (const p of plazas) {
      if (p.kind !== 'district' && p.kind !== 'civic') continue;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        posts.push({ x: p.x + Math.cos(a) * 66, z: p.z + Math.sin(a) * 66 });
      }
      if (p.kind === 'civic') for (const l of CIVIC_LAMPS) posts.push({ x: p.x + l.x, z: p.z + l.z });
    }
    layLamps();
    layParked();
    if (!keep) {
      populate();
      return;
    }
    keepCars(oldCars);
    keepPeople(oldPeople);
    trim();
    refill = true;
  }

  /** The cars whose lane (and, in a box, whose way through it) still stands, as they were. */
  function keepCars(old: Car[]): void {
    const byKey = new Map(roads.lanes.map((l) => [l.key, l]));
    cars = [];
    for (const c of old) {
      const lane = byKey.get(c.lane.key);
      if (!lane) continue;
      if (c.via) {
        const from = byKey.get(c.via.from.key);
        const via = from?.moves.find((m) => m.to === lane) ?? null;
        if (!via && c.s - c.len < 0) continue;
        c.via = via;
      }
      c.lane = lane;
      const next = c.next ? lane.moves.find((m) => m.to.key === c.next!.to.key) : undefined;
      c.next = next ?? chooseMove(lane, rCar);
      lane.cars.push(c);
      cars.push(c);
    }
    for (const l of roads.lanes) l.cars.sort(bySDesc);
  }

  /** The people whose pavement, crossing, plaza or platform still stands, as they were; none in a new court or site. */
  function keepPeople(old: Person[]): void {
    const edges = new Map(walk.all.map((e) => [e.key, e]));
    const squares = plazas.filter((p) => p.kind === 'district' || p.kind === 'civic');
    const shut = plazas.filter((p) => p.kind === 'court' || p.kind === 'site');
    const kept = new Set<Person>();
    for (const p of old) {
      if (p.leader) continue;
      if (shut.some((q) => inPlaza(q, p.x, p.z, 3))) continue;
      if (p.plaza) {
        const pl = squares.find((q) => q.x === p.plaza!.x && q.z === p.plaza!.z);
        if (!pl) continue;
        p.plaza = pl;
      } else if (p.seg && p.seg.kind === 'cross') {
        if (!p.at || !walk.corners.has(p.at)) continue;
        if (p.seg.junction) p.seg.junction = roads.junctions.get(p.seg.junction.key) ?? null;
      } else if (p.seg) {
        const e = edges.get(p.seg.bucket);
        const at = p.at ? walk.corners.get(p.at) : undefined;
        if (!e || !at) continue;
        // Its plan at the far corner, made again on the pavements as they stand now.
        if (p.state === 'waiting' && p.plan && p.plan.kind === 'cross') p.plan.j = walk.junction(at.j.x, at.j.z);
        else p.plan = planAt(p, at, e, rStep);
      } else if (p.state === 'waiting') {
        if (!net.tram.stops.some((st) => Math.abs(st.x - p.x) < 16 && Math.abs(st.z - p.z) < 16)) continue;
      }
      kept.add(p);
    }
    people = old.filter((p) => (p.leader ? kept.has(p.leader) : kept.has(p)));
  }

  /** Down to the quality's numbers at once, out of sight first: lone walkers, then followers, then anyone. */
  function trim(): void {
    const want = targets();
    if (cars.length > want.cars) {
      const order = [...cars].sort((a, b) => Number(a.seen) - Number(b.seen));
      const drop = new Set(order.slice(0, cars.length - want.cars));
      for (const c of drop) c.lane.cars.splice(c.lane.cars.indexOf(c), 1);
      cars = cars.filter((c) => !drop.has(c));
    }
    if (people.length > want.people) {
      const rank = (p: Person): number => (p.seen ? 4 : 0) + (p.group < 0 ? 0 : p.leader ? 1 : 2);
      const order = [...people].sort((a, b) => rank(a) - rank(b));
      const drop = new Set<Person>();
      for (const p of order) {
        if (people.length - drop.size <= want.people) break;
        if (drop.has(p)) continue;
        // A leader goes with its group (counted as they go).
        const group = p.leader === null && p.group >= 0 ? people.filter((q) => q.leader === p) : [];
        if (people.length - drop.size - 1 - group.length < want.people && group.length) continue;
        drop.add(p);
        for (const q of group) drop.add(q);
      }
      people = people.filter((p) => !drop.has(p));
    }
  }

  let nextCar = 0;
  let nextPerson = 0;
  /** A car on a random lane at a free spot (and, when `hidden` is given, one the eye cannot see), or null. */
  function newCar(r: () => number, hidden?: (x: number, z: number) => boolean): Car | null {
    const lanes = roads.lanes;
    if (!lanes.length) return null;
    let u = r() * roads.length;
    let lane = lanes[0];
    for (const l of lanes) {
      if ((u -= l.len) <= 0) {
        lane = l;
        break;
      }
    }
    const model = weighted(r, MIX);
    const dim = DIMS[model];
    const s = dim.len + r() * (lane.len - dim.len - 1);
    if (lane.cars.some((c) => Math.abs(c.s - s) < dim.len + 6)) return null;
    if (hidden && !hidden(lane.start.x + lane.dir.x * s, lane.start.z + lane.dir.z * s)) return null;
    const paintHex = model === 'cab' ? CAB_PAINT : weighted(r, PAINTS.map(([h, , w]) => [h, w] as [string, number]));
    const metal = model === 'cab' ? 0.05 : (PAINTS.find(([h]) => h === paintHex)?.[1] ?? 0.3);
    const v0 = 8.5 + r() * 4;
    const car: Car = { id: nextCar++, model, len: dim.len, width: dim.width, lane, s, v: v0 * (0.4 + 0.5 * r()), v0, via: null, next: null, commit: false, brake: false, paint: vary(srgb(paintHex), r, 0.05), metal, blink: r(), stuck: 0, seen: false };
    car.next = chooseMove(lane, r);
    lane.cars.push(car);
    lane.cars.sort((a, b) => b.s - a.s);
    cars.push(car);
    return car;
  }

  function targets(): { cars: number; people: number } {
    const cap = capacity();
    return { cars: Math.round(cap.cars * density), people: Math.round(cap.people * density) };
  }

  function populate(): void {
    for (const l of roads.lanes) l.cars = [];
    const r = mulberry(seed * 104729 + 3);
    cars = [];
    nextCar = 0;
    const want = targets();
    for (let tries = 0; cars.length < want.cars && tries < want.cars * 30; tries++) newCar(r);
    spawnPeople(want.people, r);
  }

  /**
   * Toward the density asked for, a car and a person at a time, and only out
   * of sight: one the eye cannot see leaves, or one comes where it cannot.
   */
  const rDrift = mulberry(seed * 977 + 1);
  function drift(): void {
    const want = targets();
    if (refill && cars.length >= want.cars && people.length >= want.people) refill = false;
    const hidden = (x: number, z: number): boolean => !frustum.containsPoint(pos.set(x, 1, z)) || Math.hypot(x - lastEye.x, z - lastEye.z) > 600;
    if (cars.length > want.cars) {
      const i = cars.findIndex((c) => !c.seen && c.s >= 0);
      if (i >= 0) {
        const c = cars[i];
        c.lane.cars.splice(c.lane.cars.indexOf(c), 1);
        cars.splice(i, 1);
      }
    } else if (cars.length < want.cars) newCar(rDrift, hidden);
    if (people.length > want.people) {
      const i = people.findIndex((p) => !p.seen && p.group < 0 && !p.plaza && p.state !== 'waiting' && p.state !== 'standing');
      if (i >= 0) people.splice(i, 1);
    } else if (people.length < want.people && walk.all.length) {
      const p = newPerson(nextPerson++, rDrift);
      const e = walk.all[Math.floor(rDrift() * walk.all.length)];
      p.at = rDrift() < 0.5 ? e.a : e.b;
      p.o = laneFor(e, rDrift);
      startPave(p, e, rDrift);
      p.u = rDrift() * (p.seg ? p.seg.len : 0);
      if (p.seg) {
        p.x = p.seg.a.x + p.seg.dir.x * p.u;
        p.z = p.seg.a.z + p.seg.dir.z * p.u;
      }
      if (hidden(p.x, p.z)) people.push(p);
    }
  }

  /** The crowd: on tram platforms, in plazas, standing in talk on pavements, and the rest walking, some in twos and threes. */
  function spawnPeople(n: number, r: () => number): void {
    people = [];
    nextPerson = 0;
    let group = 0;
    const room = (): boolean => people.length < n;
    const add = (p: Person): Person | null => {
      if (!room()) return null;
      people.push(p);
      return p;
    };
    // Waiting on the tram platforms, facing the track or watching for the tram.
    for (const st of net.tram.stops) {
      if (!room()) break;
      for (const lat of [-1, 1]) {
        const k = 3 + Math.floor(r() * 10 * Math.min(1, density + 0.2));
        const t = st.dir === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
        const nrm = st.dir === 'x' ? { x: 0, z: 1 } : { x: 1, z: 0 };
        const toTrack = Math.atan2(-nrm.z * lat, -nrm.x * lat);
        const along = Math.atan2(-t.z * lat, -t.x * lat);
        const placed: Array<[number, number]> = [];
        for (let i = 0; i < k; i++) {
          // Most wait by the shelter, under its canopy or at the edge before it; a few down the platform.
          let u = 0;
          let l = 0;
          for (let tries = 0; tries < 8; tries++) {
            const near = r() < 0.65;
            u = near ? clamp(gauss(r) * 3.2, -9, 9) : (r() - 0.5) * 24;
            l = near && r() < 0.5 ? 5.3 + r() * 1.1 : 3.95 + r() * 1.5;
            if (placed.every(([pu, pl]) => Math.hypot(pu - u, pl - l) > 1.25)) break;
          }
          placed.push([u, l]);
          const pair = r() < 0.22 && k - i >= 2;
          for (let q = 0; q < (pair ? 2 : 1); q++) {
            const p = add(newPerson(nextPerson++, r));
            if (!p) break;
            const du = pair ? (q ? 0.36 : -0.36) : 0;
            p.x = st.x + t.x * (u + du) + nrm.x * lat * l;
            p.z = st.z + t.z * (u + du) + nrm.z * lat * l;
            p.y = l < 6.05 ? 0.25 : 0;
            p.state = 'waiting';
            // Facing the track, or up the line for the tram, or (in a pair) each other.
            p.face = pair ? Math.atan2(t.z * (q ? -1 : 1), t.x * (q ? -1 : 1)) + gauss(r) * 0.25 : (r() < 0.55 ? toTrack : along) + gauss(r) * 0.4;
            p.yaw = p.face;
            p.v = 0;
            p.style = pair ? (q ? 4 : 0) : r() < 0.35 ? 2 : r() < 0.4 ? 1 : 0;
            p.timer = 1e9;
            if (pair) p.group = 100000 + p.id;
          }
          if (pair) i++;
        }
      }
    }
    // Plazas: walkers crossing them, and people standing about, in talk or alone.
    const squares = plazas.filter((p) => p.kind === 'district' || p.kind === 'civic');
    for (const pl of squares) {
      const walkers = Math.round((pl.kind === 'civic' ? 34 : 20) * Math.max(0.3, density));
      for (let i = 0; i < walkers && room(); i++) {
        const p = add(newPerson(nextPerson++, r))!;
        const at = plazaPoint(pl, r);
        p.x = at.x;
        p.z = at.z;
        p.plaza = pl;
        p.seg = plazaSeg(p, r);
        p.u = r() * (p.seg?.len ?? 0);
        if (r() < 0.3) group = joinGroup(p, r, group, (q) => add(q), () => nextPerson++);
      }
      const talks = Math.round((pl.kind === 'civic' ? 5 : 3) * Math.max(0.3, density));
      for (let i = 0; i < talks && room(); i++) {
        const at = plazaPoint(pl, r);
        circle(at, 2 + Math.floor(r() * 3), r, group++, () => add(newPerson(nextPerson++, r)));
      }
      for (let i = 0; i < 3 && room(); i++) {
        const p = add(newPerson(nextPerson++, r))!;
        const at = plazaPoint(pl, r);
        p.x = at.x;
        p.z = at.z;
        p.state = 'standing';
        p.style = r() < 0.6 ? 2 : 1;
        p.face = r() * Math.PI * 2;
        p.yaw = p.face;
        p.v = 0;
        p.timer = 1e9;
        p.plaza = pl;
      }
    }
    // Pavements: a few in talk by the building line; the rest walk, chosen by how busy each pavement is.
    const edges = walk.all;
    if (!edges.length) return;
    const wsum = edges.reduce((s, e) => s + e.weight, 0);
    const pickEdge = (): Pave => {
      let u = r() * wsum;
      for (const e of edges) if ((u -= e.weight) <= 0) return e;
      return edges[edges.length - 1];
    };
    const talks = Math.round(edges.length / 9);
    for (let i = 0; i < talks && room(); i++) {
      const e = pickEdge();
      const a = walk.corners.get(e.a)!;
      const b = walk.corners.get(e.b)!;
      const t = 0.2 + r() * 0.6;
      const o = e.lamps ? 7.0 : 6.6;
      const pa = cornerAt(a, o);
      const pb = cornerAt(b, o);
      circle({ x: pa.x + (pb.x - pa.x) * t, z: pa.z + (pb.z - pa.z) * t }, 2 + Math.floor(r() * 2), r, group++, () => add(newPerson(nextPerson++, r)), 0.42);
    }
    while (room()) {
      const p = add(newPerson(nextPerson++, r))!;
      const e = pickEdge();
      const fwd = r() < 0.5;
      p.at = fwd ? e.a : e.b;
      p.o = laneFor(e, r);
      startPave(p, e, r);
      p.u = r() * (p.seg ? p.seg.len : 0);
      if (p.seg) {
        p.x = p.seg.a.x + p.seg.dir.x * p.u;
        p.z = p.seg.a.z + p.seg.dir.z * p.u;
      }
      if (r() < 0.26) group = joinGroup(p, r, group, (q) => add(q), () => nextPerson++);
    }
  }

  /** Followers for a walker: one or two beside it at its pace, the group's own id. */
  function joinGroup(lead: Person, r: () => number, group: number, add: (p: Person) => Person | null, next: () => number): number {
    const n = r() < 0.75 ? 1 : 2;
    lead.group = group;
    // The group walks at the slowest member's pace: a little under the leader's own.
    lead.pace *= 0.93;
    lead.cadence = lead.pace / lead.step;
    for (let k = 0; k < n; k++) {
      const f = add(newPerson(next(), r));
      if (!f) break;
      f.group = group;
      f.leader = lead;
      f.slot = { x: -0.15 - r() * 0.35, z: (k === 0 ? 1 : -1) * (0.55 + r() * 0.12) };
      f.x = lead.x;
      f.z = lead.z;
      f.state = lead.state;
      f.pace = lead.pace;
      f.cadence = lead.pace / f.step;
      // Dressed apart from the leader: a coat of another colour, not a twin.
      for (let k = 0; k < 6 && Math.hypot(f.coat[0] - lead.coat[0], f.coat[1] - lead.coat[1], f.coat[2] - lead.coat[2]) < 0.06; k++) f.coat = vary(srgb(weighted(r, COATS)), r);
    }
    return group + 1;
  }

  /** People standing in talk round a point, each facing the middle. */
  function circle(at: V2, n: number, r: () => number, group: number, add: () => Person | null, rad = 0.5): void {
    const a0 = r() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const p = add();
      if (!p) return;
      const a = a0 + (k / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const rr = rad + r() * 0.15;
      p.x = at.x + Math.cos(a) * rr;
      p.z = at.z + Math.sin(a) * rr;
      p.face = a + Math.PI + gauss(r) * 0.2;
      p.yaw = p.face;
      p.state = 'standing';
      p.v = 0;
      p.style = r() < 0.4 ? 4 : r() < 0.4 ? 1 : 0;
      p.group = group;
      p.timer = 1e9;
    }
  }

  // ---- walking the pavements

  /** A corner's point for a walker keeping `o` off both streets. */
  function cornerAt(c: Corner, o: number): V2 {
    return { x: c.j.x + c.qx * o, z: c.j.z + c.qz * o };
  }

  /** A walker's offset on a pavement: either side of the lamp posts' line where they stand. */
  function laneFor(e: Pave, r: () => number): number {
    if (!e.lamps) return PAVE.lo + 0.2 + r() * (PAVE.hi - PAVE.lo - 0.4);
    return r() < 0.5 ? 4.6 + r() * 0.75 : 6.65 + r() * 0.75;
  }

  /** The band a walker may move in on a pavement, as offsets from the street's centre. */
  function bandOf(e: Pave, o: number): [number, number] {
    if (!e.lamps) return [PAVE.lo, PAVE.hi];
    return o < PAVE.lamp ? [PAVE.lo, PAVE.lamp - 0.5] : [PAVE.lamp + 0.5, PAVE.hi];
  }

  /** Starts a walker down a pavement edge from its corner, and plans what it does at the far end. */
  function startPave(p: Person, e: Pave, r: () => number): void {
    const from = p.at === e.a ? e.a : e.b;
    const to = from === e.a ? e.b : e.a;
    const A = walk.corners.get(from)!;
    const Bc = walk.corners.get(to)!;
    const a = p.seg ? { x: p.x, z: p.z } : cornerAt(A, p.o);
    let b = cornerAt(Bc, p.o);
    const plan = planAt(p, Bc, e, r);
    p.plan = plan;
    if (plan && plan.kind === 'cross') {
      // Wait at the kerb, a little back from it and along it, as people do.
      const dc = crossDir(Bc, plan.axis);
      const lateral = plan.axis === 'x' ? { x: 0, z: 1 } : { x: 1, z: 0 };
      const back = 0.25 + r() * 0.9;
      const side = (r() - 0.5) * 1.4;
      b = { x: b.x - dc.x * back + lateral.x * side, z: b.z - dc.z * back + lateral.z * side };
      // Keep it on the pavement.
      b = { x: clamp(b.x, Bc.j.x - 7.5, Bc.j.x + 7.5), z: clamp(b.z, Bc.j.z - 7.5, Bc.j.z + 7.5) };
      const ox = Math.abs(b.x - Bc.j.x);
      const oz = Math.abs(b.z - Bc.j.z);
      if (ox < PAVE.lo) b.x = Bc.j.x + Bc.qx * PAVE.lo;
      if (oz < PAVE.lo) b.z = Bc.j.z + Bc.qz * PAVE.lo;
    }
    const along = Math.abs(b.x - a.x) > Math.abs(b.z - a.z) ? 'x' : 'z';
    const sideSign = along === 'x' ? Math.sign(b.x - a.x) * A.qz : -Math.sign(b.z - a.z) * A.qx;
    const [lo, hi] = bandOf(e, p.o);
    // The right of travel points away from the street when sideSign > 0.
    const s = seg(a, b, 'pave', e.key, sideSign > 0 ? -(p.o - lo) : -(hi - p.o), sideSign > 0 ? hi - p.o : p.o - lo);
    p.seg = s;
    p.u = 0;
    p.sh = 0;
    p.came = e.key;
    p.at = to;
    p.state = 'walking';
  }

  /** Which way a crossing at a corner goes, walking along an axis: toward the junction's other side. */
  function crossDir(c: Corner, axis: Axis): V2 {
    return axis === 'x' ? { x: -c.qx, z: 0 } : { x: 0, z: -c.qz };
  }

  /** At a corner: on along a pavement from it, or across one of its two streets (not straight back the way it came). */
  function planAt(p: Person, c: Corner, came: Pave | null, r: () => number): Person['plan'] {
    const opts: Array<{ w: number; plan: NonNullable<Person['plan']> }> = [];
    for (const e of walk.paves.get(c.key) ?? []) {
      if (came && e.key === came.key) continue;
      opts.push({ w: 1, plan: { kind: 'pave', e, to: e.a === c.key ? e.b : e.a } });
    }
    for (const axis of ['x', 'z'] as Axis[]) {
      const other = axis === 'x' ? ckey(c.j.x, c.j.z, -c.qx, c.qz) : ckey(c.j.x, c.j.z, c.qx, -c.qz);
      if (!walk.paves.get(other)?.length) continue;
      if (inChannel(c.j.x, 16)) continue;
      opts.push({ w: 0.9, plan: { kind: 'cross', j: walk.junction(c.j.x, c.j.z), axis, to: other, from: c.key } });
    }
    if (!opts.length) {
      if (came) return { kind: 'pave', e: came, to: came.a === c.key ? came.b : came.a };
      return null;
    }
    // Straight on is likeliest: along the same street's side, or across the street ahead.
    for (const o of opts) {
      if (!came) continue;
      const ca = walk.corners.get(came.a)!;
      const cb = walk.corners.get(came.b)!;
      const alongX = ca.j.z === cb.j.z;
      if (o.plan.kind === 'cross' && (o.plan.axis === 'x') === alongX) o.w = 1.6;
      if (o.plan.kind === 'pave') {
        const oa = walk.corners.get(o.plan.e.a)!;
        const ob = walk.corners.get(o.plan.e.b)!;
        if ((oa.j.z === ob.j.z) === alongX) o.w = 1.4;
        o.w *= 0.6 + o.plan.e.weight;
      }
    }
    let u = r() * opts.reduce((s, o) => s + o.w, 0);
    for (const o of opts) if ((u -= o.w) <= 0) return o.plan;
    return opts[0].plan;
  }

  /**
   * Whether a walker may start across a street now, `need` seconds to cross
   * it at its pace: its signal green the way it walks with the time to get
   * over before the other way's green, and no car in the box cutting its
   * crossing; or, without signals, no traffic near.
   */
  const XSIG = { green: null as Axis | null, amber: false, left: 0 };
  function mayCross(j: Junction | null, axis: Axis, need: number): boolean {
    if (!j) return true;
    const crossed = other(axis);
    // A car in the box going along the street it would cross.
    // (Its rear still over the crossing, which reaches a metre and a half past the box.)
    for (const o of j.out) for (const c of o.cars) if (c.via && c.s - c.len < 2 && c.s > -c.via.len - c.len && (c.via.from.axis === crossed || c.via.to.axis === crossed)) return false;
    // A car committed to the box whose way runs along that street, or one still rolling up to it.
    for (const l of j.into) {
      for (const c of l.cars) {
        if (c.s < 0 || !c.next || (l.axis !== crossed && c.next.to.axis !== crossed)) continue;
        if (c.commit || (c.v > 1 && l.len - c.s < 8 + 2.2 * c.v)) return false;
      }
    }
    // A car moving off along that street, its rear not yet clear of the crossing.
    for (const o of j.out) if (o.axis === crossed) for (const c of o.cars) if (c.v > 1 && c.s - c.len < 4 && c.s >= 0) return false;
    if (j.signal) {
      const s = signalAt(j, time, XSIG);
      return s.green === axis && !s.amber && s.left > need + ALL_RED;
    }
    // No signals: across a street with traffic only when nothing comes within 30 m.
    if (!j.axes[crossed]) return true;
    for (const l of j.into) {
      if (l.axis !== crossed) continue;
      for (const c of l.cars) if (c.s >= 0 && l.len - c.s < 30) return false;
    }
    return true;
  }
  /** The seconds a walker needs to get across a street from its corner, at its pace. */
  const crossTime = (p: Person): number => (2 * p.o + 1) / Math.max(0.6, (p.leader ?? p).pace * 0.9);

  // ---- the plazas

  function plazaOk(pl: AmbientPlaza, x: number, z: number): boolean {
    const d = Math.hypot(x - pl.x, z - pl.z);
    if (pl.kind === 'district') return d > RING.lo && d < RING.hi;
    if (d > RING.hi) return false;
    if (onExchange(x - pl.x, z - pl.z, 3)) return false;
    if (Math.hypot(x - pl.x - FOUNTAIN.x, z - pl.z - FOUNTAIN.z) < FOUNTAIN.radius + 2) return false;
    return true;
  }
  function plazaPoint(pl: AmbientPlaza, r: () => number): V2 {
    for (let i = 0; i < 200; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * RING.hi;
      const p = { x: pl.x + Math.cos(a) * d, z: pl.z + Math.sin(a) * d };
      if (plazaOk(pl, p.x, p.z)) return p;
    }
    return { x: pl.x + RING.lo + 10, z: pl.z };
  }
  const clearPath = (pl: AmbientPlaza, a: V2, b: V2): boolean => {
    const n = Math.ceil(dist(a, b) / 1.5);
    for (let i = 1; i < n; i++) if (!plazaOk(pl, a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n)) return false;
    return true;
  };
  /** A plaza walker's next leg: to a point in the plaza, straight if it can, else by a point between. */
  function plazaSeg(p: Person, r: () => number): Seg | null {
    const pl = p.plaza!;
    const at = { x: p.x, z: p.z };
    for (let i = 0; i < 30; i++) {
      const to = plazaPoint(pl, r);
      if (dist(at, to) < 12) continue;
      if (clearPath(pl, at, to)) return seg(at, to, 'plaza', `plaza:${pl.x},${pl.z}`);
      const via = plazaPoint(pl, r);
      if (clearPath(pl, at, via) && dist(at, via) > 6) return seg(at, via, 'plaza', `plaza:${pl.x},${pl.z}`);
    }
    return null;
  }

  // ---- stepping the crowd

  const rStep = mulberry(seed * 31 + 9);
  const buckets = new Map<string, Person[]>();

  /** What a walker decides as it looks round (giveWay): which way it steers and the pace it allows itself. */
  const GW = { steer: 0, want: 0 };
  /** One person or post near a walker on its piece of way: step aside for it within the band, or fall in behind it. */
  function giveWay(p: Person, s: Seg, ox: number, oz: number, ovx: number, ovz: number, still: boolean): void {
    const rx = ox - p.x;
    const rz = oz - p.z;
    const along = rx * s.dir.x + rz * s.dir.z;
    const lat = -rx * s.dir.z + rz * s.dir.x;
    if (along <= 0.05 || along > 2.4 || Math.abs(lat) > 0.62) return;
    const closing = ovx * s.dir.x + ovz * s.dir.z;
    const oncoming = closing < -0.3;
    // Oncoming: both keep right. Ahead and slower: round it on the side with room, else fall in behind.
    let dirSide = oncoming ? 1 : lat > 0 ? -1 : 1;
    if (!oncoming && ((dirSide > 0 && p.sh > s.hi - 0.3) || (dirSide < 0 && p.sh < s.lo + 0.3))) dirSide = -dirSide;
    const blocked = (dirSide > 0 && p.sh > s.hi - 0.1) || (dirSide < 0 && p.sh < s.lo + 0.1);
    GW.steer += dirSide * (1 - along / 2.4);
    if (!oncoming && (blocked || still) && along < 1.4) GW.want = Math.min(GW.want, Math.max(0, closing) * 0.95);
  }

  let tick = 0;
  function stepPeople(dt: number): void {
    tick++;
    for (const j of roads.junctions.values()) {
      j.walkers.x = 0;
      j.walkers.z = 0;
    }
    // Who walks where, by the edge they walk, for giving way.
    for (const b of buckets.values()) b.length = 0;
    for (const p of people) {
      if (p.leader || !p.seg) continue;
      if (p.state === 'crossing' && p.seg.junction) p.seg.junction.walkers[p.seg.axis!]++;
      const k = p.seg.bucket;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p);
    }
    for (const p of people) {
      if (p.leader) continue;
      if (p.state === 'standing' || (p.state === 'waiting' && !p.seg)) {
        p.v = 0;
        continue;
      }
      if (p.state === 'paused') {
        p.timer -= dt;
        p.v = 0;
        if (p.timer <= 0) p.state = 'walking';
        continue;
      }
      if (p.state === 'waiting') {
        // At the kerb: across when its way goes green (or the street is clear).
        const plan = p.plan;
        if (plan && plan.kind === 'cross' && mayCross(plan.j, plan.axis, crossTime(p))) startCross(p);
        else {
          p.v = 0;
          continue;
        }
      }
      const s = p.seg;
      if (!s) continue;
      // Give way: to anyone close ahead, by stepping aside within the pavement, else by slowing. Each person
      // looks round every other step (half the crowd each step); between, it keeps what it decided.
      let want = p.pace;
      let steer = 0;
      const look = (p.id + tick) % 2 === 0;
      const others = buckets.get(s.bucket) ?? [];
      if (look) {
        GW.steer = 0;
        GW.want = p.pace;
        for (const o of others) {
          if (o === p || (o.group >= 0 && o.group === p.group)) continue;
          if (Math.abs(o.x - p.x) > 2.5 || Math.abs(o.z - p.z) > 2.5) continue;
          const moving = o.seg !== null && (o.state === 'walking' || o.state === 'crossing');
          giveWay(p, s, o.x, o.z, moving ? o.seg!.dir.x * o.v : 0, moving ? o.seg!.dir.z * o.v : 0, o.v < 0.05);
        }
        if (s.kind === 'plaza') for (const q of posts) if (Math.abs(q.x - p.x) < 3 && Math.abs(q.z - p.z) < 3) giveWay(p, s, q.x, q.z, 0, 0, false);
        steer = GW.steer;
        want = GW.want;
        p.gave[0] = steer;
        p.gave[1] = want;
      } else {
        steer = p.gave[0];
        want = Math.min(p.pace, p.gave[1]);
      }
      const shV = steer !== 0 ? clamp(steer, -1, 1) * 0.7 : -Math.sign(p.sh) * Math.min(Math.abs(p.sh) / Math.max(dt, 1e-3), 0.18);
      p.sh = clamp(p.sh + shV * dt, s.lo, s.hi);
      // Ease to the wanted pace.
      p.v += clamp(want - p.v, -2.5 * dt, 1.2 * dt);
      p.u += p.v * dt;
      if (p.u >= s.len) {
        arrive(p);
      } else if (s.kind === 'pave' && (p.pauseIn -= dt) <= 0 && p.u < s.len - 3 && p.group < 0) {
        // Now and then someone stops: a look at a phone, a window, a step aside.
        p.state = 'paused';
        p.timer = 2 + rStep() * 7;
        p.pauseIn = 40 + rStep() * 200;
        p.v = 0;
      }
      const seg_ = p.seg;
      if (!seg_) continue;
      p.x = seg_.a.x + seg_.dir.x * Math.min(p.u, seg_.len) - seg_.dir.z * p.sh;
      p.z = seg_.a.z + seg_.dir.z * Math.min(p.u, seg_.len) + seg_.dir.x * p.sh;
    }
    // Followers keep their places beside their leader, turning with it.
    for (const p of people) {
      const l = p.leader;
      if (!l) continue;
      const d = l.seg ? l.seg.dir : { x: Math.cos(l.yaw), z: Math.sin(l.yaw) };
      const tx = l.x + d.x * p.slot.x - d.z * p.slot.z;
      const tz = l.z + d.z * p.slot.x + d.x * p.slot.z;
      const t = l.seg && l.seg.kind !== 'plaza' ? offRoad(tx, tz) : { x: tx, z: tz };
      const dx = t.x - p.x;
      const dz = t.z - p.z;
      const gap = Math.hypot(dx, dz);
      const v = Math.min(gap * 2.2, l.pace * 1.35 + 0.3);
      if (gap > 1e-4) {
        p.x += (dx / gap) * Math.min(gap, v * dt);
        p.z += (dz / gap) * Math.min(gap, v * dt);
      }
      if (l.seg && l.seg.kind !== 'plaza') {
        const k = offRoad(p.x, p.z);
        p.x = k.x;
        p.z = k.z;
        // At a corner and not crossing, on the corner's paving, never in either road.
        if (l.state !== 'crossing') {
          const sx = streetLine(p.x);
          const sz = streetLine(p.z);
          const dx = p.x - sx;
          const dz = p.z - sz;
          if (Math.abs(dx) < PAVE.hi && Math.abs(dz) < PAVE.hi && Math.min(Math.abs(dx), Math.abs(dz)) < PAVE.lo) {
            if (Math.abs(dx) < PAVE.lo) p.x = sx + (dx < 0 ? -1 : 1) * PAVE.lo;
            if (Math.abs(dz) < PAVE.lo) p.z = sz + (dz < 0 ? -1 : 1) * PAVE.lo;
          }
        }
        // On a crossing, beside the leader but never off the crossing's side into the street it runs along.
        if (l.state === 'crossing' && l.seg.axis) {
          if (l.seg.axis === 'x') {
            const sz = streetLine(p.z);
            if (Math.abs(p.z - sz) < PAVE.lo) p.z = sz + (p.z < sz ? -1 : 1) * PAVE.lo;
          } else {
            const sx = streetLine(p.x);
            if (Math.abs(p.x - sx) < PAVE.lo) p.x = sx + (p.x < sx ? -1 : 1) * PAVE.lo;
          }
        }
      }
      // Its pace for its stride follows its leader's.
      p.v += clamp((l.state === 'walking' || l.state === 'crossing' ? l.v : 0) - p.v, -2.5 * dt, 1.5 * dt);
      p.state = l.state === 'paused' ? 'walking' : l.state;
      if (l.state === 'paused') p.state = 'paused';
      // Standing with the leader, each faces a little its own way (toward the others, at the kerb).
      if (l.state === 'waiting' || l.state === 'paused' || l.state === 'standing') p.face = Math.atan2(d.z, d.x) + p.jit;
    }
  }

  function startCross(p: Person): void {
    const plan = p.plan;
    if (!plan || plan.kind !== 'cross') return;
    const to = walk.corners.get(plan.to)!;
    const a = { x: p.x, z: p.z };
    // Straight across, keeping the same distance off the street it walks beside.
    const b = plan.axis === 'x' ? { x: to.j.x + to.qx * p.o, z: a.z } : { x: a.x, z: to.j.z + to.qz * p.o };
    const s = seg(a, b, 'cross', `cross:${plan.from}>${plan.to}`, -0.5, 0.5);
    s.junction = plan.j;
    s.axis = plan.axis;
    // Counted at once, so a car deciding in this same step sees them on the crossing.
    if (plan.j) plan.j.walkers[plan.axis]++;
    p.seg = s;
    p.u = 0;
    p.sh = 0;
    p.state = 'crossing';
    p.at = plan.to;
    p.came = null;
    p.plan = null;
  }

  /** At the end of a piece of the way: wait at the kerb, cross, or go on down the next pavement. */
  function arrive(p: Person): void {
    const s = p.seg!;
    p.x = s.b.x;
    p.z = s.b.z;
    if (s.kind === 'plaza') {
      p.seg = plazaSeg(p, rStep);
      p.u = 0;
      p.sh = 0;
      if (rStep() < 0.25) {
        p.state = 'paused';
        p.timer = 3 + rStep() * 12;
      }
      return;
    }
    const at = walk.corners.get(p.at!);
    if (!at) return;
    if (s.kind === 'cross') {
      // Over: on along a pavement from this corner (not straight back across).
      const opts = (walk.paves.get(at.key) ?? []).filter((e) => e.weight > 0);
      if (!opts.length) {
        p.seg = null;
        p.state = 'standing';
        return;
      }
      const e = opts[Math.floor(rStep() * opts.length)];
      if (e.lamps) p.o = p.o < PAVE.lamp ? Math.min(p.o, 5.35) : Math.max(p.o, 6.65);
      startPave(p, e, rStep);
      return;
    }
    const plan = p.plan;
    if (plan && plan.kind === 'cross') {
      p.state = 'waiting';
      p.v = 0;
      p.face = Math.atan2(crossDir(at, plan.axis).z, crossDir(at, plan.axis).x);
      if (mayCross(plan.j, plan.axis, crossTime(p))) startCross(p);
      return;
    }
    if (plan && plan.kind === 'pave') {
      if (plan.e.lamps) p.o = p.o < PAVE.lamp ? Math.min(p.o, 5.35) : Math.max(p.o, 6.65);
      startPave(p, plan.e, rStep);
      return;
    }
    p.seg = null;
    p.state = 'standing';
  }

  // ---- stepping the traffic

  const rCar = mulberry(seed * 131 + 5);
  const env: Env = { t: 0, ped: (j, axis) => j.walkers[axis], trams: [], cabs: [] };
  const movedCars: Car[] = [];
  const movedLanes: Lane[] = [];
  const bySDesc = (a: Car, b: Car): number => b.s - a.s;

  /** People on the carriageway near each junction (on a crossing, or strayed into the road): every car brakes for them. */
  const inRoad = new Map<Junction, Person[]>();
  function gatherInRoad(): void {
    for (const l of inRoad.values()) l.length = 0;
    for (const p of people) {
      if (p.y > 0.1 || p.v < 0.05) continue;
      const sx = streetLine(p.x);
      const sz = streetLine(p.z);
      const dx = Math.abs(p.x - sx);
      const dz = Math.abs(p.z - sz);
      if (Math.min(dx, dz) > 4.2 || Math.max(dx, dz) > 16) continue;
      const j = roads.junctions.get(jkey(sx, sz));
      if (!j) continue;
      (inRoad.get(j) ?? inRoad.set(j, []).get(j)!).push(p);
    }
  }
  const FRONT = { x: 0, z: 0 };
  /** The gap to the nearest person on the road ahead of a car near a junction, or Infinity. */
  function personAhead(car: Car): number {
    const j = car.s < 0 || car.s < 6 ? (car.via ? car.lane.from : null) : car.lane.len - car.s < 16 ? car.lane.to : null;
    const near = j ? inRoad.get(j) : undefined;
    if (!near || !near.length) return Infinity;
    const pose = carPose(car);
    const hx = Math.cos(pose.yaw);
    const hz = Math.sin(pose.yaw);
    carPoint(car, 0, FRONT);
    let best = Infinity;
    for (const p of near) {
      const rx = p.x - FRONT.x;
      const rz = p.z - FRONT.z;
      const along = rx * hx + rz * hz;
      if (along < -0.6 || along > 14) continue;
      const lat = -rx * hz + rz * hx;
      if (Math.abs(lat) > car.width / 2 + 0.7) continue;
      best = Math.min(best, Math.max(0, along - 0.7));
    }
    return best;
  }

  function stepCars(dt: number): void {
    env.t = time;
    gatherInRoad();
    for (const lane of roads.lanes) if (lane.cars.length > 1) lane.cars.sort(bySDesc);
    movedCars.length = 0;
    movedLanes.length = 0;
    for (const lane of roads.lanes) {
      for (let i = 0; i < lane.cars.length; i++) {
        const car = lane.cars[i];
        const ahead = aheadOf(car, i, env);
        let gap = ahead.gap;
        let vl = ahead.vl;
        const person = personAhead(car);
        if (person < gap) {
          gap = person;
          vl = 0;
        }
        let v0 = car.v0;
        // Slow for the turn ahead, and through it.
        const m = car.s < 0 ? car.via : car.next;
        if (m && m.turn !== 'straight') {
          const cap = turnCap(m, v0);
          const toTurn = car.s < 0 ? 0 : lane.len - car.s;
          v0 = Math.min(v0, cap + toTurn * 0.22);
        }
        const sStar = IDM.gap + Math.max(0, car.v * IDM.headway + (car.v * (car.v - vl)) / (2 * Math.sqrt(IDM.accel * IDM.decel)));
        let a = IDM.accel * (1 - Math.pow(car.v / v0, 4) - (gap > 0 ? (sStar / gap) ** 2 : 1e3));
        a = clamp(a, -8, IDM.accel);
        const v = Math.max(0, car.v + a * dt);
        let ds = (car.v + v) * 0.5 * dt;
        // Never into the car ahead, nor over a line it may not cross.
        if (Number.isFinite(gap)) ds = Math.min(ds, Math.max(0, gap - 0.4));
        car.brake = a < -0.6 || (v < 0.05 && car.v < 0.05);
        car.v = ds <= 0 && v > 0 && gap < 0.5 ? 0 : v;
        car.s += ds;
        // Held at the line by a full exit: after a while it takes another way on.
        if (car.s >= 0 && car.v < 0.1 && lane.len - car.s < 4 && car.next && !car.commit) {
          const tail = car.next.to.cars[car.next.to.cars.length - 1];
          if (tail && tail.s - tail.len < car.len + 5) {
            car.stuck += dt;
            if (car.stuck > 4) {
              car.next = chooseMove(lane, rCar, car.next);
              car.stuck = 0;
            }
          } else car.stuck = 0;
        }
        if (car.s >= lane.len && car.next && car.s >= 0) {
          const blocked = (!car.commit && !mayEnter(car, env)) || cabHolds(car, env);
          if (blocked) {
            car.s = lane.len - 0.01;
            car.v = 0;
          } else {
            movedCars.push(car);
            movedLanes.push(lane);
          }
        }
      }
    }
    for (let k = 0; k < movedCars.length; k++) {
      const car = movedCars[k];
      const lane = movedLanes[k];
      const m = car.next!;
      lane.cars.splice(lane.cars.indexOf(car), 1);
      car.s = car.s - lane.len - m.len;
      car.lane = m.to;
      car.via = m;
      car.commit = false;
      car.next = chooseMove(m.to, rCar);
      m.to.cars.push(car);
    }
  }

  // ---- drawing

  const group = new THREE.Group();
  group.name = 'ambient-life';
  const owned: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  /** An instanced mesh drawn in the view only, with per-instance attributes of these sizes. */
  function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, attrs: Record<string, number>, name: string): { mesh: THREE.InstancedMesh; a: Record<string, THREE.InstancedBufferAttribute> } {
    const a: Record<string, THREE.InstancedBufferAttribute> = {};
    for (const [k, n] of Object.entries(attrs)) {
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
    owned.push(geo);
    return { mesh, a };
  }

  const carCap = AMBIENT_CAP.high.cars + PARKED_CAP.high;
  const personCap = AMBIENT_CAP.high.people;
  const nearCar = carMaterial(false);
  const farCar = carMaterial(true);
  const nearFig = figureMaterial(false);
  const farFig = figureMaterial(true);
  const pool = poolMaterial();
  const shade = shadeMaterial();
  mats.push(nearCar, farCar, nearFig, farFig, pool, shade);
  const CAR_ATTRS = { aPaint: 4, aState: 4, aLampL: 4 };
  const BODY_MODELS: Array<Exclude<AmbientModel, 'cab'>> = ['saloon', 'hatch', 'estate', 'van'];
  const carMeshes = new Map<string, { mesh: THREE.InstancedMesh; a: Record<string, THREE.InstancedBufferAttribute>; tris: number; n: number }>();
  for (const m of BODY_MODELS) {
    const { geo } = carModel(m);
    const inst = instanced(geo, nearCar, carCap, CAR_ATTRS, `ambient:car:${m}`);
    carMeshes.set(m, { ...inst, tris: geo.attributes.position.count / 3, n: 0 });
  }
  const farGeo = farCarModel();
  const farCars = { ...instanced(farGeo, farCar, carCap, CAR_ATTRS, 'ambient:car:far'), tris: farGeo.attributes.position.count / 3, n: 0 };
  const FIG_ATTRS = { aAnim: 4, aLook: 4, aCoat: 3, aLegs: 3, aLampL: 4 };
  const figGeo = figureModel(false);
  const figFarGeo = figureModel(true);
  const nearPeople = { ...instanced(figGeo, nearFig, personCap, FIG_ATTRS, 'ambient:people'), tris: figGeo.attributes.position.count / 3, n: 0 };
  const farPeople = { ...instanced(figFarGeo, farFig, personCap, FIG_ATTRS, 'ambient:people:far'), tris: figFarGeo.attributes.position.count / 3, n: 0 };
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
  const pools = new THREE.InstancedMesh(poolGeo, pool, HEADLAMP.pools);
  pools.name = 'ambient:pools';
  pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(HEADLAMP.pools * 3), 3);
  const shadeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadeCap = carCap + personCap;
  const shades = new THREE.InstancedMesh(shadeGeo, shade, shadeCap);
  shades.name = 'ambient:shades';
  owned.push(poolGeo, shadeGeo);
  for (const m of [pools, shades]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    setLayers(m, LAYER.view);
    group.add(m);
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const frustum = new THREE.Frustum();
  const MID = { x: 0, z: 0 };
  const lastEye = new THREE.Vector3(0, 1e5, 0);
  const sphere = new THREE.Sphere();
  const projView = new THREE.Matrix4();
  const lampTmp: [number, number, number, number] = [0, 1, 0, 0];
  let poolN = 0;
  let shadeN = 0;

  function addPool(x: number, z: number, yaw: number, length: number, width: number, r: number, g: number, bl: number): void {
    if (poolN >= HEADLAMP.pools) return;
    pos.set(x, 0.03, z);
    q.setFromAxisAngle(up, -yaw);
    m4.compose(pos, q, scl.set(length, 1, width));
    pools.setMatrixAt(poolN, m4);
    pools.instanceColor!.setXYZ(poolN, r, g, bl);
    poolN++;
  }
  function addShade(x: number, y: number, z: number, yaw: number, length: number, width: number): void {
    if (shadeN >= shadeCap) return;
    pos.set(x, y + 0.02, z);
    q.setFromAxisAngle(up, -yaw);
    m4.compose(pos, q, scl.set(length, 1, width));
    shades.setMatrixAt(shadeN++, m4);
  }

  type Drawn = { mesh: THREE.InstancedMesh; a: Record<string, THREE.InstancedBufferAttribute>; n: number };
  /** One car into a level's instances, at the pose in pos and q: its paint, brake, blinker, blink phase, and whether it is parked (lamps off). */
  function writeCar(d0: Drawn, sx: number, sy: number, sz: number, paint: [number, number, number], metal: number, brake: number, sig: number, blink: number, parkedCar: number): void {
    if (d0.n >= d0.mesh.instanceMatrix.count) return;
    const i = d0.n++;
    m4.compose(pos, q, scl.set(sx, sy, sz));
    d0.mesh.setMatrixAt(i, m4);
    d0.a.aPaint.setXYZW(i, paint[0], paint[1], paint[2], metal);
    d0.a.aState.setXYZW(i, brake, sig, blink, parkedCar);
    d0.a.aLampL.setXYZW(i, lampTmp[0], lampTmp[1], lampTmp[2], lampTmp[3]);
  }

  /** One figure into a level's instances, at the matrix in m4: its stride's phase, walk, stride and style, and its looks. */
  function writePerson(d0: Drawn, p: Person, wv: number, stride: number): void {
    if (d0.n >= d0.mesh.instanceMatrix.count) return;
    const i = d0.n++;
    d0.mesh.setMatrixAt(i, m4);
    d0.a.aAnim.setXYZW(i, p.phase, wv, stride, p.style);
    d0.a.aLook.setXYZW(i, p.skin, p.hair, p.coatLen, p.hat);
    d0.a.aCoat.setXYZ(i, p.coat[0], p.coat[1], p.coat[2]);
    d0.a.aLegs.setXYZ(i, p.legs[0], p.legs[1], p.legs[2]);
    d0.a.aLampL.setXYZW(i, p.lamp[0], p.lamp[1], p.lamp[2], p.lamp[3]);
  }

  function draw(camera: THREE.PerspectiveCamera, viewHeight: number): void {
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    const eye = camera.position;
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewHeight);
    (nearCar.userData.uniforms as { uTime: { value: number } }).uTime.value = time;
    (farCar.userData.uniforms as { uTime: { value: number }; uPixel: { value: number } }).uTime.value = time;
    (farCar.userData.uniforms as { uPixel: { value: number } }).uPixel.value = pixel;
    for (const d of carMeshes.values()) d.n = 0;
    farCars.n = 0;
    nearPeople.n = 0;
    farPeople.n = 0;
    poolN = 0;
    shadeN = 0;
    const poolsOn = quality === 'high';
    const pc = HEADLAMP.colour;
    lastEye.copy(eye);
    for (const car of cars) {
      // Culled by its middle first; the full pose only for a car the eye can see.
      const mid = carPoint(car, car.len / 2, MID);
      car.seen = frustum.intersectsSphere(sphere.set(pos.set(mid.x, 1, mid.z), 3.4));
      if (!car.seen) continue;
      const p = carPose(car);
      const d = Math.hypot(p.x - eye.x, eye.y, p.z - eye.z);
      const dim = DIMS[car.model];
      const sig = blinkerOf(car);
      pos.set(p.x, 0, p.z);
      q.setFromAxisAngle(up, -p.yaw);
      if (d < LIFE_LOD.car.far) {
        lampLight(lamps, p.x, 1.0, p.z, lampTmp);
        writeCar(carMeshes.get(car.model === 'cab' ? 'saloon' : car.model)!, 1, 1, 1, car.paint, car.metal, car.brake ? 1 : 0, sig, car.blink, 0);
        addShade(p.x, 0, p.z, p.yaw, dim.len + 0.3, dim.width + 0.35);
      } else lampTmp[3] = 0;
      if (d > LIFE_LOD.car.near) writeCar(farCars, dim.len / 4.6, dim.height / 1.46, dim.width / 1.84, car.paint, car.metal, car.brake ? 1 : 0, sig, car.blink, 0);
      if (poolsOn && d < HEADLAMP.reach) {
        const k = HEADLAMP.peak * 0.26;
        addPool(p.x + Math.cos(p.yaw) * (dim.len / 2 - 0.1), p.z + Math.sin(p.yaw) * (dim.len / 2 - 0.1), p.yaw, 11, 3.4, pc[0] * k, pc[1] * k, pc[2] * k);
        const tk = HEADLAMP.peak * (car.brake ? 0.16 : 0.07);
        addPool(p.x - Math.cos(p.yaw) * (dim.len / 2 - 0.1), p.z - Math.sin(p.yaw) * (dim.len / 2 - 0.1), p.yaw + Math.PI, 2.6, 2.2, tk, tk * 0.04, tk * 0.02);
      }
    }
    // The parked cars: dark, their lamps off.
    for (const c of parked) {
      c.seen = frustum.intersectsSphere(sphere.set(pos.set(c.x, 1, c.z), 3.4));
      if (!c.seen) continue;
      const d = Math.hypot(c.x - eye.x, eye.y, c.z - eye.z);
      const dim = DIMS[c.model];
      pos.set(c.x, 0, c.z);
      q.setFromAxisAngle(up, -c.yaw);
      if (d < LIFE_LOD.car.far) {
        lampLight(lamps, c.x, 1.0, c.z, lampTmp);
        writeCar(carMeshes.get(c.model)!, 1, 1, 1, c.paint, c.metal, 0, 0, 0, 1);
        addShade(c.x, 0, c.z, c.yaw, dim.len + 0.3, dim.width + 0.35);
      } else lampTmp[3] = 0;
      if (d > LIFE_LOD.car.near) writeCar(farCars, dim.len / 4.6, dim.height / 1.46, dim.width / 1.84, c.paint, c.metal, 0, 0, 0, 1);
    }
    const end = LIFE_LOD.crowdEnd.far;
    for (const p of people) {
      const d = Math.hypot(p.x - eye.x, p.y + 1 - eye.y, p.z - eye.z);
      p.seen = d < end + 80 && frustum.intersectsSphere(sphere.set(pos.set(p.x, p.y + 0.9, p.z), 1.2));
      if (d > end || !p.seen) continue;
      const walking = p.state === 'walking' || p.state === 'crossing';
      const wv = walking ? clamp(p.v / Math.max(0.3, p.pace * 0.5), 0, 1) : 0;
      const k = p.height / 1.75;
      pos.set(p.x, p.y, p.z);
      q.setFromAxisAngle(up, -p.yaw);
      m4.compose(pos, q, scl.set(k * (0.94 + 0.06 * p.build), k, k * p.build));
      const stride = Math.asin(clamp((p.step * Math.max(0.55, wv)) / (2 * 0.86 * k), 0, 0.62));
      if (d < LIFE_LOD.person.far) {
        lampLight(lamps, p.x, p.y + 1.3, p.z, p.lamp);
        writePerson(nearPeople, p, wv, stride);
        addShade(p.x, p.y, p.z, p.yaw, 0.62 * k, 0.5 * k * p.build);
      } else p.lamp[3] = 0;
      if (d > LIFE_LOD.person.near) writePerson(farPeople, p, wv, stride);
    }
    // Only what is drawn goes up to the GPU: each buffer's first n instances, and nothing for an empty level.
    const upload = (a: THREE.BufferAttribute, n: number): void => {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    };
    const finish = (m: THREE.InstancedMesh, n: number, attrs?: Record<string, THREE.InstancedBufferAttribute>): void => {
      m.count = n;
      m.visible = n > 0;
      if (n === 0) return;
      upload(m.instanceMatrix, n);
      if (attrs) for (const a of Object.values(attrs)) upload(a, n);
    };
    for (const d of carMeshes.values()) finish(d.mesh, d.n, d.a);
    finish(farCars.mesh, farCars.n, farCars.a);
    finish(nearPeople.mesh, nearPeople.n, nearPeople.a);
    finish(farPeople.mesh, farPeople.n, farPeople.a);
    finish(pools, poolN);
    if (pools.instanceColor && poolN) upload(pools.instanceColor, poolN);
    finish(shades, shadeN);
  }

  /** Moves everyone on by dt, and turns each figure toward the way it goes and its stride on. */
  function step(dt: number): void {
    time += dt;
    if (drifting || refill) drift();
    stepPeople(dt);
    stepCars(dt);
    for (const p of people) {
      const walking = p.state === 'walking' || p.state === 'crossing';
      let want = p.face;
      if (walking && p.v > 0.05) {
        const d = p.leader ? (p.leader.seg ? p.leader.seg.dir : { x: Math.cos(p.leader.yaw), z: Math.sin(p.leader.yaw) }) : p.seg ? p.seg.dir : null;
        if (d) want = Math.atan2(d.z, d.x);
      }
      let dy = want - p.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      p.yaw += clamp(dy, -4 * dt, 4 * dt);
      // The stride's phase runs with the ground covered; standing, a slow breath of its own.
      const rate = walking && p.v > 0.02 ? (Math.PI * p.v) / p.step : 0.55 + 0.25 * Math.sin(p.id);
      p.phase = (p.phase + rate * dt) % (Math.PI * 200);
    }
  }

  lay();

  const api: Ambient = {
    group,
    update(dt, camera, viewHeight) {
      if (!held) {
        let left = Math.min(dt, 1);
        while (left > 1e-6) {
          const h = Math.min(left, 0.1);
          step(h);
          left -= h;
        }
      }
      if (camera) draw(camera, viewHeight ?? 1000);
    },
    setDensity(n, gradual = false) {
      const d = clamp(n, 0, 1);
      drifting = gradual;
      if (d === density) return;
      density = d;
      if (!gradual) populate();
    },
    density: () => density,
    setQuality(qv) {
      if (qv === quality) return;
      quality = qv;
      parked = parkedAll.slice(0, PARKED_CAP[quality]);
      trim();
      refill = true;
    },
    setPlazas(p) {
      const next = [...p];
      if (!next.some((x) => x.kind === 'civic')) next.unshift({ x: 0, z: 0, kind: 'civic' });
      if (JSON.stringify(next) === JSON.stringify(plazas)) return;
      plazas = next;
      lay(true);
    },
    setTrams(at) {
      env.trams = at;
    },
    setCabs(at) {
      env.cabs = at;
    },
    relay(n) {
      if (n.blocks === net.blocks && JSON.stringify(n.ranks) === JSON.stringify(net.ranks)) return;
      net = n;
      lay(true);
    },
    cars: () =>
      cars.map((c) => {
        const p = carPose(c);
        const m = c.s < 0 ? c.via : c.next;
        return { id: c.id, model: c.model, x: p.x, z: p.z, yaw: p.yaw, speed: c.v, lane: c.lane.key, s: c.s, length: c.len, junction: p.junction?.key ?? null, axis: p.axis, turn: m?.turn ?? 'straight', braking: c.brake, blinking: blinkerOf(c), hold: holdOf(c, time), width: c.width };
      }),
    people: () => people.map((p) => ({ id: p.id, state: p.state, x: p.x, z: p.z, yaw: p.yaw, speed: p.v, phase: p.phase % (Math.PI * 2), cadence: p.cadence, height: p.height, build: p.build, coat: [...p.coat] as [number, number, number], group: p.group })),
    view(camera) {
      void camera;
      let meshes = 0;
      let triangles = 0;
      let nc = 0;
      for (const d of carMeshes.values()) {
        if (d.mesh.visible) {
          meshes++;
          triangles += d.tris * d.n;
        }
        nc += d.n;
      }
      for (const d of [farCars, nearPeople, farPeople]) {
        if (!d.mesh.visible) continue;
        meshes++;
        triangles += d.tris * d.n;
      }
      for (const m of [pools, shades]) {
        if (!m.visible) continue;
        meshes++;
        triangles += 2 * m.count;
      }
      return {
        cars: cars.length,
        people: people.length,
        walking: people.filter((p) => p.state === 'walking' || p.state === 'crossing').length,
        waiting: people.filter((p) => p.state === 'waiting').length,
        nearCars: nc,
        farCars: farCars.n,
        nearPeople: nearPeople.n,
        farPeople: farPeople.n,
        meshes,
        triangles,
        density,
        time,
      };
    },
    hold(on) {
      held = on;
    },
    skip(seconds) {
      for (let t = 0; t < seconds; t += 0.1) step(0.1);
    },
    dispose() {
      for (const g of owned) g.dispose();
      for (const m of mats) m.dispose();
      for (const m of [...carMeshes.values()].map((d) => d.mesh).concat([farCars.mesh, nearPeople.mesh, farPeople.mesh, pools, shades])) {
        group.remove(m);
        m.dispose();
      }
      cars = [];
      people = [];
    },
  };
  return api;
}
