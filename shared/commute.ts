/**
 * The commute's fixed geography and its network. Pure, shared by the engine
 * (persona trips, Task 33) and the city (river.ts and transit.ts draw exactly
 * what the engine routes on).
 *
 * The river (ruling 14): a straight river 56 m wide running north and south
 * on the street line at x = -360, between district block columns -1 and -2.
 * The district spiral is unchanged: districts stand on multiples of 240 m, so
 * the nearest origins are 120 m from the river's centre and a district's 90 m
 * reserve clears each bank by 2 m.
 *
 * The transit network (Task 30, ruling 26): a tram loop on the streets round
 * the districts, an elevated rail loop on a viaduct outside it, two maglev
 * pod lines crossing at the civic block, cab ranks at each plaza, and the
 * ferry piers; `route()` chooses a trip's modes and lays its legs.
 */
import type { Trip, TripMode } from './types.js';

/** The river's centre line (world x) and its width bank to bank, in metres. */
export const RIVER = { x: -360, width: 56 } as const;

/** The two banks' world x: the faces of the quay walls. */
export const BANKS = { west: RIVER.x - RIVER.width / 2, east: RIVER.x + RIVER.width / 2 } as const;

/** The z of each bridge's centre line: the steel through-arch, the three-span stone arch and the cable-stayed deck. */
export const BRIDGES = [-480, 0, 480] as const;

/** Each bridge's deck, parapet to parapet, in metres: two lanes and a footway each side. */
export const BRIDGE_DECK = 20;

/**
 * The quay: the paved strip along each bank between the quay wall's coping
 * and the first buildings. Ambient lots the river or this strip would cross
 * are given to the quay (no buildings stand there).
 */
export const QUAY = 12;

/**
 * Each bridge carries its road this far inland past the quay on both sides,
 * to the next street: no ambient lot stands across its approach.
 */
export const BRIDGE_APPROACH = 44;

/** Half the length of a ferry pier's landing stage along the bank. */
export const PIER_HALF = 14;

export interface Pier {
  /** The bank's face at the pier: where a passenger steps off the quay. */
  x: number;
  z: number;
  bank: 'west' | 'east';
  /** True for the pier at the civic end, beside the stone bridge on the city's side. */
  civic: boolean;
}

/** A listed pier that would fall on a bridge stands this far upstream (north, -z) of it, clear of its deck and lamps. */
export const PIER_BRIDGE_SHIFT = 72;

/**
 * The ferry piers: one every 480 m along the river from z = -1440 to 1440,
 * alternating banks (as a river bus zigzags), and one more at the civic end:
 * on the city's bank just south of the stone bridge, at the foot of the civic
 * axis. Three of the listed places fall on a bridge; those piers stand
 * PIER_BRIDGE_SHIFT upstream of it.
 */
export const PIERS: readonly Pier[] = (() => {
  const out: Pier[] = [];
  for (let k = -3; k <= 3; k++) {
    const listed = k * 480;
    const z = (BRIDGES as readonly number[]).includes(listed) ? listed - PIER_BRIDGE_SHIFT : listed;
    const bank = k % 2 === 0 ? 'west' : 'east';
    out.push({ x: BANKS[bank], z, bank, civic: false });
  }
  out.push({ x: BANKS.east, z: PIER_BRIDGE_SHIFT, bank: 'east', civic: true });
  return out;
})();

/** True when the straight line from a to b crosses the river (its two ends lie on opposite sides of the centre line). */
export function crossesRiver(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  return a.x < RIVER.x !== b.x < RIVER.x;
}

/**
 * True when a rectangle w by d centred at (x, z) stands on the river, on a
 * quay, or across a bridge's approach: ground no building may take.
 */
export function onRiverGround(x: number, z: number, w: number, d: number): boolean {
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  if (x1 > BANKS.west - QUAY && x0 < BANKS.east + QUAY) return true;
  if (x1 <= BANKS.west - QUAY - BRIDGE_APPROACH || x0 >= BANKS.east + QUAY + BRIDGE_APPROACH) return false;
  const half = BRIDGE_DECK / 2 + 2;
  return BRIDGES.some((bz) => z + d / 2 > bz - half && z - d / 2 < bz + half);
}

/** True when x lies in the river's channel, or within `margin` of either bank. */
export function inChannel(x: number, margin = 0): boolean {
  return x > BANKS.west - margin && x < BANKS.east + margin;
}

// ---------------------------------------------------------------- the transit network (Task 30, ruling 26)


/**
 * Streets run on the lines x = 40 + 80k and z = 40 + 80k (lots.ts: 64 m
 * blocks, 16 m streets, 80 m pitch); districts stand on block centres every
 * 240 m, so every district has a street 120 m out on each side.
 */
export const STREET_PITCH = 80;
export const STREET_AT = 40;
/** The district grid (district-layout.ts DISTRICT_PITCH), repeated here so this file stays free of imports beyond types. */
const DISTRICT = 240;

/** Cruising speeds by mode, in metres per second. */
export const SPEED: Readonly<Record<TripMode, number>> = { walk: 1.4, tram: 12, rail: 20, pod: 25, ferry: 6, cab: 11 };
/** The wait at every boarding, in seconds: a tram, train, pod or ferry. */
export const BOARD_WAIT_S = 20;
/** A cab is summoned and comes to the door: a longer wait, no walk. */
export const CAB_WAIT_S = 30;

/** Top of rail on the elevated line's viaduct, and the pod guideway's running surface, in metres. */
export const RAIL_Y = 12;
export const POD_Y = 18;
/** A ferry's deck, a metre above the water (river.ts WATER_Y is -6.2). */
export const FERRY_Y = -5.2;

/** Under this straight distance a trip walks; under TRAM_MAX it rides the tram; up to CAB_MAX a cab. */
export const WALK_MAX = 150;
export const TRAM_MAX = 700;
export const CAB_MAX = 1500;
/** A pier serves an end within this; a pod line serves an end that lies within POD_REACH of it. */
export const PIER_REACH = 200;
export const POD_REACH = 300;

/** The pod lines run on the street lines that bound the civic block: z = 120 (along x) and x = 120 (along z). */
export const POD_STREET = 120;

/** The street either side of the river where each bridge's road meets the grid: east (city) and west. */
export const BRIDGE_ENDS = { east: RIVER.x + STREET_PITCH, west: RIVER.x - STREET_PITCH } as const;

type P = { x: number; z: number };
export type Leg = Trip['legs'][number];

/** The street line nearest v. */
export function streetLine(v: number): number {
  return Math.round((v - STREET_AT) / STREET_PITCH) * STREET_PITCH + STREET_AT;
}

/** The smallest street line at or past v (away from zero). */
function streetOut(v: number): number {
  return Math.ceil((v - STREET_AT) / STREET_PITCH) * STREET_PITCH + STREET_AT;
}

/**
 * How many district rings out the city reaches (Chebyshev, in 240 m
 * blocks): the farthest standing district or quarter. At least 1, so a city
 * of one district still has its loops.
 */
export function extentBlocks(origins: ReadonlyArray<P>): number {
  let e = 1;
  for (const o of origins) e = Math.max(e, Math.round(Math.max(Math.abs(o.x), Math.abs(o.z)) / DISTRICT));
  return e;
}

/**
 * Half the side of the tram loop's square: the street 200 m out from the
 * outermost ring of districts. That street lies 80 m past the ring's own
 * edge street, so no part of the loop touches a plaza or a court, and where
 * it meets the river (at 20 m past a multiple of 30) it keeps 10 m off the
 * quay lamps and clear of the road bridges and the piers.
 */
export function tramHalf(extentBlocks: number): number {
  return DISTRICT * extentBlocks + 200;
}

/**
 * The tram: a square loop on the streets 200 m outside the outermost ring
 * of districts, growing with the spiral. Its north and south sides cross the
 * river on the tram's own low bridges, the deck riding over the quay
 * parapets (tramHeight). Corners as [x, z], clockwise from the north-east
 * seen from above.
 */
export function tramLoop(extentBlocks: number): Array<[number, number]> {
  const h = tramHalf(extentBlocks);
  let west = -h;
  while (Math.abs(west - RIVER.x) < 60) west -= STREET_PITCH;
  return [
    [h, -h],
    [h, h],
    [west, h],
    [west, -h],
  ];
}

/** The tram's deck over the river: its height over the water and quays, and how far inland its ramp runs. */
export const TRAM_DECK = { height: 1.1, flat: 2.5, ramp: 20 } as const;

/**
 * The tram's rail height at a point of its loop: street level, except where
 * its street crosses the river, where the deck rises over the quay's
 * parapet (flat over the water and the coping) and ramps back down to the
 * street 20 m inland of the quay wall.
 */
export function tramHeight(x: number, z: number): number {
  const off = Math.abs(((((z - STREET_AT) % STREET_PITCH) + STREET_PITCH) % STREET_PITCH + STREET_PITCH / 2) % STREET_PITCH - STREET_PITCH / 2);
  if (off > 9) return 0;
  const dq = x < RIVER.x ? BANKS.west - x : x - BANKS.east;
  if (dq <= TRAM_DECK.flat) return TRAM_DECK.height;
  if (dq >= TRAM_DECK.ramp) return 0;
  const t = (dq - TRAM_DECK.flat) / (TRAM_DECK.ramp - TRAM_DECK.flat);
  return TRAM_DECK.height * (1 - t * t * (3 - 2 * t));
}

/** A stop or station on a line: where it stands, how far along the line from its first point, and which way the line runs there. */
export interface Stop {
  x: number;
  z: number;
  at: number;
  /** The axis the line runs along at the stop. */
  dir: 'x' | 'z';
  /** The pod interchange where the two lines cross. */
  interchange?: boolean;
}

/** A closed or open polyline's segments, each with its start's distance along. */
function segments(pts: ReadonlyArray<readonly number[]>, closed: boolean): Array<{ a: P; b: P; at: number; len: number }> {
  const out: Array<{ a: P; b: P; at: number; len: number }> = [];
  let at = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const a = { x: p[0], z: p[p.length - 1] };
    const b = { x: q[0], z: q[q.length - 1] };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    out.push({ a, b, at, len });
    at += len;
  }
  return out;
}

/**
 * Stops on a loop or line: on every straight run, at each block centre on the
 * district grid (multiples of `every` along the run) that lies at least
 * `clear` from both ends of the run (so never in a corner or on a bridge's
 * approach) and off the river.
 */
function stopsOn(pts: ReadonlyArray<readonly number[]>, closed: boolean, every: number, clear: number, river: number, keep: (s: Stop, maxAlong: number) => boolean = () => true): Stop[] {
  const out: Stop[] = [];
  for (const s of segments(pts, closed)) {
    const dir: 'x' | 'z' = s.a.z === s.b.z ? 'x' : 'z';
    const u0 = dir === 'x' ? s.a.x : s.a.z;
    const u1 = dir === 'x' ? s.b.x : s.b.z;
    const lo = Math.min(u0, u1);
    const hi = Math.max(u0, u1);
    for (let u = Math.ceil((lo + clear) / every) * every; u <= hi - clear + 1e-9; u += every) {
      const stop: Stop = dir === 'x' ? { x: u, z: s.a.z, at: s.at + Math.abs(u - u0), dir } : { x: s.a.x, z: u, at: s.at + Math.abs(u - u0), dir };
      if (inChannel(stop.x, river)) continue;
      if (keep(stop, Math.max(Math.abs(lo), Math.abs(hi)))) out.push(stop);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The tram's stops: every 240 m on its straight runs, mid-block, 100 m clear of its corners and off the river. */
export function tramStops(loop: ReadonlyArray<readonly [number, number]>): Stop[] {
  return stopsOn(loop, true, DISTRICT, 100, 60);
}

/** Half the side of the rail loop's square: a street out past the tram (280 m past the outer ring), never on the river. */
export function railHalf(extentBlocks: number): number {
  const reach = Math.max(...tramLoop(extentBlocks).map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))));
  let h = streetOut(Math.max(DISTRICT * extentBlocks + 280, reach + 80));
  while (Math.abs(-h - RIVER.x) < 100) h += STREET_PITCH;
  return h;
}

/**
 * The elevated rail: a square loop on a viaduct, top of rail at 12 m, over
 * the street a block outside the tram (and outside any bridge the tram
 * turns to). It crosses the river on its own spans. Corners as [x, y, z].
 */
export function railLoop(extentBlocks: number): Array<[number, number, number]> {
  const h = railHalf(extentBlocks);
  return [
    [h, RAIL_Y, -h],
    [h, RAIL_Y, h],
    [-h, RAIL_Y, h],
    [-h, RAIL_Y, -h],
  ];
}

/** The rail's stations: every 480 m along each side, 160 m clear of the corners, never within 100 m of the river. */
export function railStations(loop: ReadonlyArray<readonly [number, number, number]>): Stop[] {
  return stopsOn(loop, true, 2 * DISTRICT, 160, 100 - RIVER.width / 2);
}

/** The pod lines' ends: a block centre past the rail. */
export function podHalf(extentBlocks: number): number {
  return DISTRICT * (extentBlocks + 1);
}

/**
 * The maglev pod lines: two straight guideways at 18 m crossing at the civic
 * block's corner, one along x on the street z = 120, one along z on the
 * street x = 120, each reaching a block centre past the rail at both ends.
 */
export function podRail(extentBlocks: number): Array<Array<[number, number, number]>> {
  const L = podHalf(extentBlocks);
  return [
    [
      [-L, POD_Y, POD_STREET],
      [L, POD_Y, POD_STREET],
    ],
    [
      [POD_STREET, POD_Y, -L],
      [POD_STREET, POD_Y, L],
    ],
  ];
}

/** A pod line's stations: every 240 m at the block centres, plus the interchange where the two lines cross. */
export function podStations(line: ReadonlyArray<readonly [number, number, number]>): Stop[] {
  const out = stopsOn(line, false, DISTRICT, 0, 60);
  const s = segments(line, false)[0];
  const dir: 'x' | 'z' = s.a.z === s.b.z ? 'x' : 'z';
  const u0 = dir === 'x' ? s.a.x : s.a.z;
  out.push(dir === 'x' ? { x: POD_STREET, z: s.a.z, at: POD_STREET - u0, dir, interchange: true } : { x: s.a.x, z: POD_STREET, at: POD_STREET - u0, dir, interchange: true });
  return out.sort((a, b) => a.at - b.at);
}

/** A cab rank: three marked bays in the kerb lane with a lit sign, the bays running along `dir`. */
export interface Rank {
  x: number;
  z: number;
  dir: 'x' | 'z';
  exchange: boolean;
}

/** The ranks: one on the street east of each district's plaza, just past the paving, and one the same way off the exchange. */
export function cabRanks(extent: NetworkExtent): Rank[] {
  const at = (o: P, exchange: boolean): Rank => ({ x: o.x + STREET_AT + 2, z: o.z + 84, dir: 'z', exchange });
  return [at({ x: 0, z: 0 }, true), ...extent.districts.map((d) => at(d, false))];
}

/** What the network is laid for: how far the city reaches and where its districts' plazas are. */
export interface NetworkExtent {
  blocks: number;
  districts: ReadonlyArray<P>;
}

export interface Line {
  mode: 'tram' | 'rail' | 'pod';
  /** The running height: 0 for the tram, 12 for the rail, 18 for the pods. */
  y: number;
  path: Array<[number, number, number]>;
  /** A loop closes from its last point back to its first. */
  loop: boolean;
  stops: Stop[];
}

export interface Network {
  blocks: number;
  tram: Line;
  rail: Line;
  pods: Line[];
  ranks: Rank[];
  piers: readonly Pier[];
}

export function network(extent: NetworkExtent): Network {
  const loop = tramLoop(extent.blocks);
  const rail = railLoop(extent.blocks);
  return {
    blocks: extent.blocks,
    tram: { mode: 'tram', y: 0, path: loop.map(([x, z]) => [x, 0, z] as [number, number, number]), loop: true, stops: tramStops(loop) },
    rail: { mode: 'rail', y: RAIL_Y, path: rail, loop: true, stops: railStations(rail) },
    pods: podRail(extent.blocks).map((path) => ({ mode: 'pod' as const, y: POD_Y, path, loop: false, stops: podStations(path) })),
    ranks: cabRanks(extent),
    piers: PIERS,
  };
}

// ---------------------------------------------------------------- routing

const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);
const westOf = (p: P): boolean => p.x < RIVER.x;

/** The street line in [lo, hi] nearest v, else the street line nearest v; never the river's own line. */
function streetBetween(v: number, lo: number, hi: number, west: boolean | null): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const ok = (s: number): boolean => west === null || (s !== RIVER.x && s < RIVER.x === west);
  let best = NaN;
  for (let s = streetOut(a - STREET_PITCH); s <= b; s += STREET_PITCH) if (s >= a && ok(s) && (Number.isNaN(best) || Math.abs(s - v) < Math.abs(best - v))) best = s;
  if (!Number.isNaN(best)) return best;
  best = streetLine(v);
  for (let k = 1; !ok(best); k++) best = streetLine(v) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * STREET_PITCH;
  return best;
}

/** On one bank: out to a street running along z, along it to a street running along x, along that, and in. */
function streetPath(a: P, b: P): P[] {
  const west = westOf(a);
  const sx = streetBetween(a.x, a.x, b.x, west);
  const sz = streetBetween(b.z, a.z, b.z, null);
  return [a, { x: sx, z: a.z }, { x: sx, z: sz }, { x: b.x, z: sz }, b];
}

/** Drops zero-length steps and points in the middle of a straight run. */
function tidy(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) {
    if (out.length && dist(out[out.length - 1], p) < 1e-9) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const cross = (b.x - a.x) * (p.z - b.z) - (b.z - a.z) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.z - a.z) * (p.z - b.z);
      if (Math.abs(cross) < 1e-9 && dot >= 0) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * The way on foot or by road between two points: on the street grid
 * (Manhattan), and across the river only over a bridge, the one that adds
 * the least.
 */
export function streetWay(a: P, b: P): P[] {
  if (!crossesRiver(a, b)) return tidy(streetPath(a, b));
  const bz = [...BRIDGES].sort((p, q) => Math.abs(a.z - p) + Math.abs(b.z - p) - (Math.abs(a.z - q) + Math.abs(b.z - q)))[0];
  const endA = { x: westOf(a) ? BRIDGE_ENDS.west : BRIDGE_ENDS.east, z: bz };
  const endB = { x: westOf(b) ? BRIDGE_ENDS.west : BRIDGE_ENDS.east, z: bz };
  return tidy([...streetPath(a, endA), ...streetPath(endB, b)]);
}

const lengthOf = (pts: P[]): number => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

function leg(mode: TripMode, pts: P[], y: number): Leg {
  const wait = mode === 'walk' ? 0 : mode === 'cab' ? CAB_WAIT_S : BOARD_WAIT_S;
  const path = pts.map((p) => [round(p.x), y, round(p.z)] as [number, number, number]);
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]);
  return { mode, path, ms: Math.round((wait + len / SPEED[mode]) * 1000) };
}
const round = (v: number): number => Math.round(v * 100) / 100;

/** The part of a line between two distances along it: the shorter way round a loop. */
function ridePath(line: Line, from: number, to: number): P[] {
  const segs = segments(line.path, line.loop);
  const total = segs.reduce((s, g) => s + g.len, 0);
  const pointAt = (u: number): P => {
    const w = line.loop ? ((u % total) + total) % total : Math.min(Math.max(u, 0), total);
    for (const g of segs) if (w <= g.at + g.len + 1e-9) {
      const t = g.len ? (w - g.at) / g.len : 0;
      return { x: g.a.x + (g.b.x - g.a.x) * t, z: g.a.z + (g.b.z - g.a.z) * t };
    }
    return segs[segs.length - 1].b;
  };
  let d = to - from;
  if (line.loop) {
    d = ((d % total) + total) % total;
    if (d > total / 2) d -= total;
  }
  const out = [pointAt(from)];
  // Every corner passed on the way, in order.
  const corners = segs.map((g) => g.at);
  const steps: number[] = [];
  for (const c of corners) for (const k of line.loop ? [-1, 0, 1] : [0]) {
    const u = c + k * total;
    if (d > 0 ? u > from + 1e-9 && u < from + d - 1e-9 : u < from - 1e-9 && u > from + d + 1e-9) steps.push(u);
  }
  steps.sort((p, q) => (d > 0 ? p - q : q - p));
  for (const u of steps) out.push(pointAt(u));
  out.push(pointAt(from + d));
  return tidy(out);
}

/** Rides a line: walk to the stop that is nearest on foot, ride, walk from the one nearest the far end. Null when both are the same stop. */
/** The stop on a line nearest a point on foot. */
function nearestStop(line: Line, p: P, toStop: boolean): Stop {
  let best = line.stops[0];
  let bestLen = Infinity;
  for (const s of line.stops) {
    const len = lengthOf(toStop ? streetWay(p, s) : streetWay(s, p));
    if (len < bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return best;
}

function ride(line: Line, from: P, to: P): Leg[] | null {
  if (!line.stops.length) return null;
  const on = nearestStop(line, from, true);
  const off = nearestStop(line, to, false);
  if (on === off) return null;
  return [leg('walk', streetWay(from, on), 0), leg(line.mode, ridePath(line, on.at, off.at), line.y), leg('walk', streetWay(off, to), 0)];
}

/** The pier on p's own bank nearest it, if one is within PIER_REACH. */
function pierFor(p: P, piers: readonly Pier[]): Pier | null {
  let best: Pier | null = null;
  for (const q of piers) {
    if (q.bank === 'west' !== westOf(p)) continue;
    if (dist(p, q) <= PIER_REACH && (!best || dist(p, q) < dist(p, best))) best = q;
  }
  return best;
}

/** How far p lies from a polyline. */
function fromLine(p: P, pts: ReadonlyArray<readonly number[]>): number {
  let best = Infinity;
  for (const s of segments(pts, false)) {
    const dx = s.b.x - s.a.x;
    const dz = s.b.z - s.a.z;
    const t = s.len ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / (s.len * s.len))) : 0;
    best = Math.min(best, Math.hypot(p.x - (s.a.x + dx * t), p.z - (s.a.z + dz * t)));
  }
  return best;
}

/**
 * A persona's trip from one point to another (ruling 26): under 150 m on
 * foot; across the river with a pier within 200 m of both ends by ferry;
 * under 700 m by tram; 700 to 1,500 m by cab; past that by pod when a pod
 * line passes within 300 m of both ends, else by the elevated rail. Walking
 * keeps to the street grid and crosses the river only on a bridge; a cab
 * drives the same streets. A ride whose nearest stops at both ends are the
 * same stop is no ride, and a ride is taken only when it beats walking:
 * otherwise the trip walks, or takes a cab when the walk is long (over 700
 * m). Pod riders whose ends lie by different lines change at the
 * interchange. Each boarding waits 20 s (a cab 30 s, and it comes to the
 * door).
 */
export function route(from: P, to: P, net: Network): Leg[] {
  const d = dist(from, to);
  const walk = (): Leg[] => [leg('walk', streetWay(from, to), 0)];
  const cab = (): Leg[] => [leg('cab', streetWay(from, to), 0)];
  if (d < WALK_MAX) return walk();
  if (crossesRiver(from, to)) {
    const a = pierFor(from, net.piers);
    const b = pierFor(to, net.piers);
    if (a && b) {
      const sa = a.bank === 'west' ? -1 : 1;
      const sb = b.bank === 'west' ? -1 : 1;
      const water = [
        { x: a.x, z: a.z },
        { x: RIVER.x + sa * 12, z: a.z },
        { x: RIVER.x + sb * 12, z: b.z },
        { x: b.x, z: b.z },
      ];
      return [leg('walk', streetWay(from, a), 0), leg('ferry', tidy(water), FERRY_Y), leg('walk', streetWay(b, to), 0)];
    }
  }
  const way = streetWay(from, to);
  const walkMs = (lengthOf(way) / SPEED.walk) * 1000;
  // A ride is taken only when it beats walking; otherwise walk, or take a cab when the walk is long.
  const beats = (legs: Leg[] | null): Leg[] | null => (legs && total(legs) < walkMs ? legs : null);
  const fallback = (): Leg[] => (lengthOf(way) > TRAM_MAX ? cab() : walk());
  if (d < TRAM_MAX) return beats(ride(net.tram, from, to)) ?? fallback();
  if (d <= CAB_MAX) return cab();
  const near = (p: P, l: Line): boolean => fromLine(p, l.path) <= POD_REACH;
  const pods = net.pods.filter((l) => near(from, l) && near(to, l));
  for (const l of pods.sort((p, q) => fromLine(from, p.path) + fromLine(to, p.path) - (fromLine(from, q.path) + fromLine(to, q.path)))) {
    const legs = beats(ride(l, from, to));
    if (legs) return legs;
  }
  // Each end by a different pod line: ride one to the interchange and change.
  const a = net.pods.find((l) => near(from, l) && !near(to, l));
  const b = net.pods.find((l) => l !== a && near(to, l) && !near(from, l));
  if (a && b) {
    const legs = beats(transfer(a, b, from, to));
    if (legs) return legs;
  }
  return beats(ride(net.rail, from, to)) ?? fallback();
}

const total = (legs: Leg[]): number => legs.reduce((s, l) => s + l.ms, 0);

/** Two pod lines with a change at the interchange: walk to line a's nearest station, ride to the interchange, change, ride line b, walk. */
function transfer(a: Line, b: Line, from: P, to: P): Leg[] | null {
  const ia = a.stops.find((s) => s.interchange);
  const ib = b.stops.find((s) => s.interchange);
  if (!ia || !ib) return null;
  const on = nearestStop(a, from, true);
  const off = nearestStop(b, to, false);
  if (on === ia || off === ib) return null;
  return [
    leg('walk', streetWay(from, on), 0),
    leg('pod', ridePath(a, on.at, ia.at), a.y),
    leg('pod', ridePath(b, ib.at, off.at), b.y),
    leg('walk', streetWay(off, to), 0),
  ];
}

// ---------------------------------------------------------------- where the structures stand

/**
 * Supports along a straight run on a street (viaduct bents, pod pylons,
 * catenary poles): on the 80 m block rhythm at the block's centre and a
 * third of the way either side (26.7 m spans), so none stands in a street
 * crossing, and none in the river's channel or on its quays. Positions
 * along the run's axis, in order from a to b, ends excluded.
 */
export function spanSupports(a: P, b: P, offsets: readonly number[] = SPAN_OFFSETS): number[] {
  const dir = a.z === b.z ? 'x' : 'z';
  const u0 = dir === 'x' ? a.x : a.z;
  const u1 = dir === 'x' ? b.x : b.z;
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  const out: number[] = [];
  for (let k = Math.floor((lo - STREET_AT) / STREET_PITCH) - 1; k * STREET_PITCH <= hi + STREET_PITCH; k++) {
    for (const o of offsets) {
      const u = k * STREET_PITCH + o;
      if (u <= lo + 1e-6 || u >= hi - 1e-6) continue;
      const x = dir === 'x' ? u : a.x;
      if (inChannel(x, QUAY - 0.5)) continue;
      out.push(u);
    }
  }
  out.sort((p, q) => p - q);
  return u1 < u0 ? out.reverse() : out;
}

/** The block-centre rhythm: centre and a third of the pitch either side. */
export const SPAN_OFFSETS = [0, STREET_PITCH / 3, (2 * STREET_PITCH) / 3] as const;

