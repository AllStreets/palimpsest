/**
 * The ambient city's lots: every block's buildings, seeded by the block
 * alone, and which of them stand once the occupied plots are cut out and the
 * collar has capped them. Pure (three's Color only), so it is tested in Node.
 * Because a block's lots depend on nothing but its coordinates (and the
 * plazas standing), a plot given back to the city fills with exactly the
 * blocks that stood there before.
 *
 * The city is built of building types an American city mixes, each with its
 * own massing, storey heights and roof, and neighbourhoods that drift in
 * character across the grid: an older masonry core, a glassier commercial
 * spine, mid-century midtown, walk-up residential streets and an industrial
 * edge. Colours are tones per type, measured as the scene renders them
 * (ambient-rendered.ts), so a tone is chosen knowing how it will read.
 */
import * as THREE from 'three';

import { AMBIENT_RENDERED } from './ambient-rendered.js';
import { ambientCap, cappedHeight, RESERVE_RADIUS, reserves, type CollarPlaza } from './collar.js';
import { RENDERED } from './tower/rendered.js';
import { onRiverGround } from '../../../shared/commute.js';
import type { Look } from './tower/variants.js';

/** One city block's buildable square, in metres. */
export const BLOCK = 64;
/** Street corridor between blocks: pavement, kerb, two lanes, kerb, pavement. */
export const STREET = 16;
/** Block centre to block centre. DISTRICT_PITCH (240) is three of these, so districts sit on block centres. */
export const PITCH = BLOCK + STREET;
/** Street lamp heads sit this far from a block's centre along its south (+z) and east (+x) edges (grid.ts lays them; the ambient crowd and traffic are lit by them). */
export const LAMP_EDGE = BLOCK / 2 + 2;
/** Lamp positions along a block edge, from the block centre. */
export const LAMP_OFFSETS = [-24, -8, 8, 24];

/** A small deterministic generator, seeded per block so adding a district never reshuffles the rest of the city. */
export function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function blockSeed(i: number, j: number): number {
  return Math.abs((i * 73856093) ^ (j * 19349663)) + 1;
}

/** A hash of integers to [0, 1), for lattice noise and per-lot choices that must not disturb a block's sequence. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** True when the rectangle centred at (x, z) of size w by d comes within `r` of (px, pz). */
export function rectNear(x: number, z: number, w: number, d: number, px: number, pz: number, r: number): boolean {
  const dx = Math.max(Math.abs(px - x) - w / 2, 0);
  const dz = Math.max(Math.abs(pz - z) - d / 2, 0);
  return dx * dx + dz * dz < r * r;
}

// ---------------------------------------------------------------- neighbourhoods

/** Smooth value noise over the block grid, `cell` blocks to a lattice step. */
function vnoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const tx = s(fx - ix);
  const tz = s(fz - iz);
  const a = hash(ix, iz, salt);
  const b = hash(ix + 1, iz, salt);
  const c = hash(ix, iz + 1, salt);
  const d = hash(ix + 1, iz + 1, salt);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/**
 * A block's neighbourhood. The older masonry core rings the civic plaza; a
 * commercial spine of glass and mid-century offices runs through it along a
 * gently wandering avenue; past the core, mid-century midtown and walk-up
 * residential streets drift into each other; and toward the edge the city
 * turns industrial in broad patches, as rail yards and waterfronts do.
 */
export type Hood = 'core' | 'spine' | 'midtown' | 'residential' | 'industrial';

const SPINE_ANGLE = 0.38;

export function neighbourhood(i: number, j: number): Hood {
  const d = Math.hypot(i, j);
  const n1 = vnoise(i, j, 6, 11);
  const n2 = vnoise(i, j, 5, 23);
  const along = i * Math.cos(SPINE_ANGLE) + j * Math.sin(SPINE_ANGLE);
  const across = -i * Math.sin(SPINE_ANGLE) + j * Math.cos(SPINE_ANGLE) + (vnoise(along, 0, 7, 31) - 0.5) * 4;
  if (Math.abs(across) < 1.2 + n2 * 0.9 && d < 24) return 'spine';
  if (d < 5.5 + n1 * 3) return 'core';
  if (d > 11 + n1 * 4 && vnoise(i, j, 6, 47) > 0.66) return 'industrial';
  return n2 > 0.52 ? 'midtown' : 'residential';
}

// ---------------------------------------------------------------- building types

/**
 * The building types:
 * - walkup: pre-war masonry walk-ups, narrow lots, cornices, fire escapes, tanks;
 * - commercial: limestone and terracotta commercial blocks, tall ground floors, cornices, setbacks when tall;
 * - midcentury: office slabs in ribbon windows and coloured spandrels, a mechanical penthouse on top;
 * - glass: modern glass and metal, podium and setbacks, mullion patterns, screened plant, roof terraces;
 * - brutalist: board-formed concrete offices with deep-set windows and a heavy cap;
 * - parking: open-deck parking structures;
 * - industrial: warehouse and factory lofts, steel windows, sawtooth or stepped roofs.
 */
export type Archetype = 'walkup' | 'commercial' | 'midcentury' | 'glass' | 'brutalist' | 'parking' | 'industrial';
export const ARCHETYPES: Archetype[] = ['walkup', 'commercial', 'midcentury', 'glass', 'brutalist', 'parking', 'industrial'];

/** Each type's section: ground storey, upper storeys and parapet (metres), and how many storeys it runs to. */
export interface Section {
  ground: number;
  floor: number;
  parapet: number;
  storeys: [number, number];
  /** As a tall building (a corner tower, or the tower on a podium). */
  tall?: [number, number];
  frontage: [number, number];
}

export const SECTIONS: Record<Archetype, Section> = {
  walkup: { ground: 4.4, floor: 3.2, parapet: 1.1, storeys: [3, 7], frontage: [7.5, 13] },
  commercial: { ground: 5.6, floor: 3.9, parapet: 1.6, storeys: [4, 14], tall: [14, 34], frontage: [15, 30] },
  midcentury: { ground: 4.8, floor: 3.7, parapet: 0.9, storeys: [5, 16], tall: [14, 36], frontage: [22, 40] },
  glass: { ground: 5.6, floor: 4.0, parapet: 1.3, storeys: [5, 14], tall: [18, 54], frontage: [20, 38] },
  brutalist: { ground: 4.8, floor: 3.8, parapet: 2.4, storeys: [3, 11], tall: [12, 22], frontage: [22, 40] },
  parking: { ground: 3.4, floor: 3.0, parapet: 1.1, storeys: [3, 7], frontage: [28, 46] },
  industrial: { ground: 5.2, floor: 4.6, parapet: 1.0, storeys: [1, 5], frontage: [22, 56] },
};

/** A section's height for n storeys. */
export function sectionHeight(a: Archetype, n: number): number {
  const s = SECTIONS[a];
  return s.ground + (Math.max(1, n) - 1) * s.floor + s.parapet;
}

/** Whole storeys of type `a` under `cap` (at least one), or the lot's own height when it already fits. */
function cutTo(a: Archetype, h: number, cap: number): number {
  if (h <= cap) return h;
  const s = SECTIONS[a];
  const n = Math.floor((cap - s.ground - s.parapet) / s.floor) + 1;
  if (n >= 1) return sectionHeight(a, n);
  return Math.min(cappedHeight(h, cap), cap);
}

/** The mix of types in each neighbourhood. */
const MIX: Record<Hood, Record<Archetype, number>> = {
  core: { walkup: 0.36, commercial: 0.36, midcentury: 0.09, glass: 0.05, brutalist: 0.06, parking: 0.04, industrial: 0.04 },
  spine: { walkup: 0.03, commercial: 0.16, midcentury: 0.25, glass: 0.4, brutalist: 0.07, parking: 0.07, industrial: 0.02 },
  midtown: { walkup: 0.16, commercial: 0.14, midcentury: 0.28, glass: 0.12, brutalist: 0.14, parking: 0.1, industrial: 0.06 },
  residential: { walkup: 0.56, commercial: 0.1, midcentury: 0.1, glass: 0.04, brutalist: 0.06, parking: 0.04, industrial: 0.1 },
  industrial: { walkup: 0.08, commercial: 0.03, midcentury: 0.04, glass: 0.02, brutalist: 0.1, parking: 0.1, industrial: 0.63 },
};

/** What a lot is for on its block, which narrows the types that can stand there. */
type Role = 'row' | 'corner' | 'tower' | 'podium' | 'free' | 'yard';
const ROLE: Record<Role, Partial<Record<Archetype, number>>> = {
  row: { glass: 0.6, parking: 0.7 },
  corner: { parking: 0.5 },
  tower: { walkup: 0, industrial: 0, parking: 0, brutalist: 0.3 },
  podium: { walkup: 0, glass: 0.3, industrial: 0 },
  free: {},
  yard: { walkup: 0.2, commercial: 0.2, glass: 0.1, midcentury: 0.3 },
};

function pickType(r: () => number, hood: Hood, role: Role): Archetype {
  const w = ARCHETYPES.map((a) => MIX[hood][a] * (ROLE[role][a] ?? 1));
  let x = r() * w.reduce((s, v) => s + v, 0);
  for (let k = 0; k < ARCHETYPES.length; k++) {
    x -= w[k];
    if (x <= 0) return ARCHETYPES[k];
  }
  return ARCHETYPES[ARCHETYPES.length - 1];
}

// ---------------------------------------------------------------- tones

/**
 * A colour a type is built in: the wall (brick, stone, concrete, mullion
 * metal) and its accent (sills and cornices, spandrels, glass, window
 * frames), as sRGB hex. `paint` drives the scanned brick and stone: -1
 * keeps the scan's own colour variation, 0 recolours it keeping the full
 * grain, 1 is a coat of paint over it. `reflect` is how mirrored the glass is.
 * `siding` clads an industrial building in corrugated metal instead of brick.
 */
export interface Tone {
  id: string;
  wall: number;
  accent: number;
  paint: number;
  reflect?: number;
  siding?: boolean;
  /** How often the tone is chosen, relative to its type's others (default 1). */
  weight?: number;
}

const tone = (id: string, wall: number, accent: number, paint: number, more: Partial<Tone> = {}): Tone => ({ id, wall, accent, paint, ...more });

export const TONES: Record<Archetype, Tone[]> = {
  walkup: [
    tone('walkup:red', 0x8a4a3c, 0xc9c2b4, -1, { weight: 1.3 }),
    tone('walkup:buff', 0xc2a57a, 0x5d4d3e, 0, { weight: 0.8 }),
    tone('walkup:ironspot', 0x4c3933, 0xbdb5a5, 0, { weight: 0.6 }),
    tone('walkup:white', 0xe6e3dc, 0x2b2e31, 0.85, { weight: 1.5 }),
    tone('walkup:black', 0x29292b, 0xcfcbc2, 0.7, { weight: 1.2 }),
    tone('walkup:sage', 0x68736a, 0xe0ddd5, 0.75),
    tone('walkup:grey', 0x8a8884, 0x34373a, 0.15, { weight: 0.6 }),
    tone('walkup:navy', 0x222a37, 0xd8d4cc, 0.8, { weight: 0.7 }),
    tone('walkup:cream', 0xf1e8d2, 0x3a3c3a, 0.85, { weight: 0.9 }),
  ],
  commercial: [
    tone('commercial:limestone', 0xcbc6b8, 0x3e3226, 0.3, { weight: 1.0 }),
    tone('commercial:white-terracotta', 0xeeebe4, 0x2c3838, 0.5, { weight: 1.5 }),
    tone('commercial:buff', 0xc6ab80, 0x40594f, 0.3, { weight: 0.6 }),
    tone('commercial:granite', 0x7c7e81, 0x1d1e21, 0.2, { weight: 0.5 }),
    tone('commercial:black', 0x2b2c2f, 0xb29966, 0.4, { weight: 1.2 }),
    tone('commercial:green-terracotta', 0x3f5a52, 0xd6d2c8, 0.5, { weight: 0.6 }),
    tone('commercial:brownstone', 0x5d4236, 0xcfc8b8, 0.1, { weight: 0.6 }),
    tone('commercial:blue', 0x6e7986, 0xdad6ce, 0.45, { weight: 0.6 }),
  ],
  midcentury: [
    tone('midcentury:teal', 0xafb4b7, 0x3d6462, 0),
    tone('midcentury:enamel', 0xe0e0db, 0x23272b, 0),
    tone('midcentury:white', 0xf0f0ec, 0xd2d6d9, 0, { weight: 1.4 }),
    tone('midcentury:slate', 0x7c8085, 0x34455b, 0),
    tone('midcentury:mies', 0x1d1e20, 0x2a2b2d, 0, { weight: 0.7 }),
    tone('midcentury:olive', 0xb5aa8f, 0x50593e, 0, { weight: 0.7 }),
    tone('midcentury:sky', 0xc8ccd0, 0x6e89a2, 0),
  ],
  glass: [
    tone('glass:silver', 0xa1a7ad, 0x5c6973, 0, { reflect: 0.9 }),
    tone('glass:teal', 0x4e575c, 0x1d3d3c, 0, { reflect: 0.6 }),
    tone('glass:blue', 0x3a3f47, 0x18273d, 0, { reflect: 0.65 }),
    tone('glass:charcoal', 0x1c1e21, 0x141619, 0, { reflect: 0.5 }),
    tone('glass:smoked', 0x101113, 0x0a0b0d, 0, { reflect: 0.75 }),
    tone('glass:bronze', 0x4a3d30, 0x292017, 0, { reflect: 0.6, weight: 0.6 }),
    tone('glass:white', 0xdfe1e2, 0x55626a, 0, { reflect: 0.55 }),
  ],
  brutalist: [
    tone('brutalist:grey', 0x97958f, 0x1e2022, 0),
    tone('brutalist:cool', 0x898d90, 0x2a2420, 0),
    tone('brutalist:pale', 0xc9c5ba, 0x3a3029, 0, { weight: 1.4 }),
    tone('brutalist:dark', 0x4b4c4b, 0x1a1b1c, 0),
    tone('brutalist:buff', 0xa7987e, 0x262626, 0, { weight: 0.5 }),
  ],
  parking: [
    tone('parking:grey', 0x999791, 0x5d6a72, 0),
    tone('parking:pale', 0xc8c4ba, 0x3b5977, 0, { weight: 1.3 }),
    tone('parking:dark', 0x575755, 0x6a6f74, 0, { weight: 0.6 }),
    tone('parking:mesh', 0x7e858b, 0x8a9096, 0, { siding: true }),
  ],
  industrial: [
    tone('industrial:red', 0x8a4a3c, 0x2c3a35, -1, { weight: 1.4 }),
    tone('industrial:white', 0xe8e4dc, 0x1f2224, 0.85, { weight: 1.3 }),
    tone('industrial:limewash', 0xf4f1ea, 0x3d4a52, 1, { weight: 0.8 }),
    tone('industrial:green', 0x3e4b43, 0xcfc9bb, 0.8),
    tone('industrial:buff', 0xb49971, 0x3a3c3e, 0.2, { weight: 0.6 }),
    tone('industrial:steel', 0x7c868f, 0x2a2c2e, 1, { siding: true }),
    tone('industrial:blue', 0x4e6373, 0xd6d3cc, 1, { siding: true, weight: 0.7 }),
  ],
};

const TONE_BY_ID = new Map(ARCHETYPES.flatMap((a) => TONES[a].map((t) => [t.id, t] as const)));
const COLOURS = new Map<number, THREE.Color>();
function colour(hex: number): THREE.Color {
  let c = COLOURS.get(hex);
  if (!c) COLOURS.set(hex, (c = new THREE.Color(hex)));
  return c;
}

/** CIE Lab, as measured off a screenshot. */
export type Lab = [number, number, number];

// ---------------------------------------------------------------- lots

/** Which faces of a lot meet a street. */
export type Face = 'px' | 'nx' | 'pz' | 'nz';

/** How a building ends against the sky. */
export type Roof = 'bulkhead' | 'tank' | 'garden' | 'penthouse' | 'screen' | 'terrace' | 'cores' | 'deck' | 'sawtooth' | 'stepped' | 'flat';

/** One ambient building footprint and height, before plazas are cut out. */
export interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  archetype: Archetype;
  hood: Hood;
  tone: string;
  colour: THREE.Color;
  accent: THREE.Color;
  /** paint (see Tone), rhythm seed, lit share of windows, and a per-type variant (plus 2 for corrugated siding). */
  style: [number, number, number, number];
  roof: Roof;
  /** The faces that meet a street: cornices and fire escapes go there, sawtooth glazing faces away from the low sun. */
  front: Face[];
  /** A factory stack's height over the roof, if it has one (only where nothing caps it). */
  stack: number;
  /** Where the lot stands on its block, for the touching check and the tone pass. */
  index: number;
}

const FLOOR = 3.6;
/** Heights land on whole floors plus a parapet, like real buildings. */
export function floorsTo(h: number): number {
  return Math.max(2, Math.round(h / FLOOR)) * FLOOR + 1.2;
}

/** How many storeys a type gets in this role and at this intensity. */
function storeys(a: Archetype, tall: boolean, intensity: number, r: () => number): number {
  const s = SECTIONS[a];
  const [lo, hi] = tall && s.tall ? s.tall : s.storeys;
  // Walk-ups and lofts keep their few storeys anywhere; offices climb with the block's intensity.
  const k = a === 'walkup' || a === 'industrial' || a === 'parking' ? r() : Math.min(1, intensity * (0.35 + 0.9 * r()));
  return lo + Math.round((hi - lo) * Math.pow(k, tall ? 1.6 : 1.2));
}

function roofFor(a: Archetype, h: number, w: number, d: number, r: () => number): Roof {
  const x = r();
  switch (a) {
    case 'walkup':
      return x < 0.4 ? 'tank' : x < 0.5 ? 'garden' : 'bulkhead';
    case 'commercial':
      return h < 70 && x < 0.3 ? 'tank' : x < 0.4 ? 'garden' : 'penthouse';
    case 'midcentury':
      return x < 0.85 ? 'penthouse' : 'screen';
    case 'glass':
      return x < 0.5 ? 'screen' : x < 0.8 ? 'terrace' : 'garden';
    case 'brutalist':
      return 'cores';
    case 'parking':
      return 'deck';
    case 'industrial':
      return Math.min(w, d) >= 18 && x < 0.5 ? 'sawtooth' : x < 0.8 ? 'stepped' : 'flat';
  }
}

/** Lit share of windows by neighbourhood: offices on the spine burn late, the industrial edge is mostly dark. */
const LIT: Record<Hood, number> = { core: 0.36, spine: 0.42, midtown: 0.34, residential: 0.4, industrial: 0.16 };

/**
 * The buildings on block (i, j), seeded by the block alone. Block types as
 * real grids have them: perimeter blocks (lots lining the streets round a
 * courtyard, each a building of its own type and frontage), a podium with a
 * tower, a few freestanding buildings, and industrial yards of big sheds.
 * Intensity falls off from the centre, with block-to-block variation so the
 * skyline has clusters, and the neighbourhood sets the mix of types.
 */
export function blockLots(i: number, j: number): readonly Lot[] {
  // A block's lots depend on nothing but its coordinates, so each is worked out once and kept (read only).
  const key = `${i},${j}`;
  let hit = BLOCKS.get(key);
  if (!hit) BLOCKS.set(key, (hit = Object.freeze(makeBlock(i, j))));
  return hit;
}
const BLOCKS = new Map<string, readonly Lot[]>();

/** A block's lots worked out afresh, bypassing the cache (tests). */
export function makeBlock(i: number, j: number): Lot[] {
  const r = rng(blockSeed(i, j));
  const hood = neighbourhood(i, j);
  const cx = i * PITCH;
  const cz = j * PITCH;
  const dist = Math.hypot(cx, cz);
  const lift = hood === 'spine' ? 1.25 : hood === 'industrial' ? 0.6 : hood === 'residential' ? 0.8 : 1;
  const intensity = Math.max(0.16, 1 - dist / 1400) * (0.6 + 0.8 * r()) * lift;
  const kind = r();
  const lots: Lot[] = [];
  const half = BLOCK / 2;
  const add = (x: number, z: number, w: number, d: number, a: Archetype, tall: boolean, front: Face[], n?: number): Lot => {
    const h = sectionHeight(a, n ?? storeys(a, tall, intensity, r));
    const lot: Lot = {
      x: cx + x,
      z: cz + z,
      w,
      d,
      h,
      archetype: a,
      hood,
      tone: '',
      colour: colour(0xffffff),
      accent: colour(0xffffff),
      style: [0, r(), LIT[hood] * (0.5 + r()), r()],
      roof: roofFor(a, h, w, d, r),
      front,
      stack: a === 'industrial' && r() < 0.14 ? 16 + r() * 18 : 0,
      index: lots.length,
    };
    lots.push(lot);
    return lot;
  };

  const yard = hood === 'industrial' ? 0.62 : hood === 'residential' ? 0.08 : 0;
  const podium = hood === 'spine' ? 0.36 : hood === 'midtown' ? 0.2 : hood === 'core' ? 0.1 : 0.04;
  if (kind < yard) {
    // An industrial yard: two or three long sheds across the block, yards and loading aprons between them.
    const alongX = r() < 0.5;
    const count = 2 + Math.floor(r() * 2);
    const span = BLOCK / count;
    for (let k = 0; k < count; k++) {
      const depth = BLOCK - 4 - r() * 14;
      const breadth = span - 3 - r() * 5;
      const off = -half + span * (k + 0.5);
      const shift = (r() - 0.5) * (BLOCK - depth);
      const a = pickType(r, hood, 'yard');
      const front: Face[] = alongX ? ['nz', 'pz'] : ['nx', 'px'];
      if (alongX) add(off, shift, breadth, depth, a, false, front);
      else add(shift, off, depth, breadth, a, false, front);
    }
  } else if (kind < yard + podium) {
    const base = pickType(r, hood, 'podium');
    add(0, 0, BLOCK - 2, BLOCK - 2, base, false, ['nx', 'px', 'nz', 'pz'], 2 + Math.floor(r() * 3));
    const tw = 22 + r() * 14;
    const td = 22 + r() * 14;
    add((r() - 0.5) * (BLOCK - tw - 6), (r() - 0.5) * (BLOCK - td - 6), tw, td, pickType(r, hood, 'tower'), true, ['nx', 'px', 'nz', 'pz']);
  } else if (kind < 0.82 || hood === 'core' || hood === 'residential') {
    // A perimeter block: corner buildings, and lots of each type's own frontage along each side.
    const c0 = 13 + r() * 9;
    const c1 = 13 + r() * 9;
    const towerCorner = r() < 0.2 * intensity ? Math.floor(r() * 4) : -1;
    const corners: Array<[number, number, Face[]]> = [
      [-1, -1, ['nx', 'nz']],
      [1, -1, ['px', 'nz']],
      [-1, 1, ['nx', 'pz']],
      [1, 1, ['px', 'pz']],
    ];
    corners.forEach(([sx, sz, front], k) => {
      const w = sx < 0 ? c0 : c1;
      const d = sz < 0 ? c0 : c1;
      const tall = k === towerCorner;
      add(sx * (half - w / 2), sz * (half - d / 2), w, d, pickType(r, hood, tall ? 'tower' : 'corner'), tall, front);
    });
    // Sides: between the corners, a run of lots each as wide as its type builds.
    const sides: Array<{ alongX: boolean; at: number; from: number; to: number; depth: number; front: Face }> = [
      { alongX: true, at: -1, from: -half + c0, to: half - c1, depth: c0, front: 'nz' },
      { alongX: true, at: 1, from: -half + c0, to: half - c1, depth: c1, front: 'pz' },
      { alongX: false, at: -1, from: -half + c0, to: half - c1, depth: c0, front: 'nx' },
      { alongX: false, at: 1, from: -half + c0, to: half - c1, depth: c1, front: 'px' },
    ];
    for (const s of sides) {
      let pos = s.from;
      while (s.to - pos > 0.5) {
        const a = pickType(r, hood, 'row');
        const [f0, f1] = SECTIONS[a].frontage;
        let f = f0 + r() * (f1 - f0);
        if (s.to - pos - f < 6) f = s.to - pos;
        const mid = pos + f / 2;
        const off = s.at * (half - s.depth / 2);
        if (s.alongX) add(mid, off, f, s.depth, a, false, [s.front]);
        else add(off, mid, s.depth, f, a, false, [s.front]);
        pos += f;
      }
    }
  } else {
    const count = 1 + Math.floor(r() * 3);
    for (let b = 0; b < count; b++) {
      const bw = 16 + r() * 22;
      const bd = 16 + r() * 22;
      add((r() - 0.5) * (BLOCK - bw), (r() - 0.5) * (BLOCK - bd), bw, bd, pickType(r, hood, 'free'), false, ['nx', 'px', 'nz', 'pz']);
    }
    // Freestanding buildings may overlap; drop any that does, keeping the first.
    for (let a = lots.length - 1; a > 0; a--) {
      for (let b = 0; b < a; b++) {
        if (Math.abs(lots[a].x - lots[b].x) < (lots[a].w + lots[b].w) / 2 && Math.abs(lots[a].z - lots[b].z) < (lots[a].d + lots[b].d) / 2) {
          lots.splice(a, 1);
          break;
        }
      }
    }
    lots.forEach((l, k) => (l.index = k));
  }
  assignTones(i, j, lots, []);
  return lots;
}

/**
 * How far a lot's parts (bays, cornices, fire escapes) may reach past its
 * walls: the river's test widens each lot by this much, so nothing hangs
 * over a quay.
 */
const LOT_REACH = 1.5;

/** True when the far ring's lot for this block stands: not on the river, a quay or a bridge's approach. */
export function farLotStands(i: number, j: number): boolean {
  const l = farLot(i, j);
  return !onRiverGround(l.x, l.z, l.w + 2 * LOT_REACH, l.d);
}

/** The far ring: one building per block, low, carrying each neighbourhood's character into the haze. */
export function farLot(i: number, j: number): Lot {
  const r = rng(blockSeed(i, j));
  const hood = neighbourhood(i, j);
  const a = pickType(r, hood, 'free');
  const w = 24 + r() * 30;
  const d = 24 + r() * 30;
  const n = Math.min(SECTIONS[a].storeys[1], 2 + Math.floor(Math.pow(r(), 2.2) * 9));
  const lot: Lot = {
    x: i * PITCH + (r() - 0.5) * (BLOCK - w),
    z: j * PITCH + (r() - 0.5) * (BLOCK - d),
    w,
    d,
    h: sectionHeight(a, n),
    archetype: a,
    hood,
    tone: '',
    colour: colour(0xffffff),
    accent: colour(0xffffff),
    style: [0, r(), LIT[hood] * 0.8, r()],
    roof: 'flat',
    front: ['nx', 'px', 'nz', 'pz'],
    stack: 0,
    index: 0,
  };
  assignTones(i, j, [lot], []);
  return lot;
}

function touching(a: Lot, b: Lot): boolean {
  return Math.abs(a.x - b.x) - (a.w + b.w) / 2 < 0.6 && Math.abs(a.z - b.z) - (a.d + b.d) / 2 < 0.6;
}

/** Ambient lots whose centre lies within this distance of a district's origin keep clear of its tower's colours. */
export const RING_REACH = RESERVE_RADIUS + 64;
/** And stand at least this far in CIE L* from its stone floors, so the root and the name plate read against them. */
export const RING_VALUE = 6;
/** The tower colour distance below which a ring lot would read as the same family (the towers' own SEPARATION, variants.ts). */
const RING_SEPARATION = 6;

const dE = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** True when a tone keeps clear of every district's tower whose ring holds the lot. */
function clearOf(t: Tone, lot: Lot, rings: CollarPlaza[]): boolean {
  const lab = AMBIENT_RENDERED[t.id]?.sun;
  if (!lab) return rings.length === 0;
  for (const p of rings) {
    if (p.tones?.some((x) => dE(lab, x) < RING_SEPARATION)) return false;
    if (p.value !== undefined && Math.abs(lab[0] - p.value) < RING_VALUE) return false;
  }
  return true;
}

/**
 * Chooses every lot's tone, in lot order: each lot ranks its type's tones
 * by a hash of the block and its own index (weighted), and takes the first
 * that no touching lot of the same type already wears and that keeps clear
 * of the towers whose ring it stands in. When nothing of its own type can
 * keep clear of a tower, the lot is built as the type that can.
 */
function assignTones(i: number, j: number, lots: Lot[], plazas: CollarPlaza[]): void {
  const districts = plazas.filter((p) => p.tones?.length || p.value !== undefined);
  for (const lot of lots) {
    const rings = districts.filter((p) => Math.hypot(lot.x - p.x, lot.z - p.z) <= RING_REACH);
    const taken = new Set(lots.filter((o) => o.index < lot.index && o.tone && touching(o, lot)).map((o) => o.tone));
    const ranked = (a: Archetype): Tone[] =>
      TONES[a]
        .map((t, k) => ({ t, key: Math.pow(hash(blockSeed(i, j), lot.index * 31 + k, 7), 1 / (t.weight ?? 1)) }))
        .sort((x, y) => y.key - x.key)
        .map((x) => x.t);
    let choice = ranked(lot.archetype).find((t) => !taken.has(t.id) && clearOf(t, lot, rings));
    if (!choice && rings.length) {
      // Nothing of its own type keeps clear: build this lot as the nearest type that can (offices before glass).
      for (const a of FALLBACK[lot.archetype]) {
        choice = ranked(a).find((t) => !taken.has(t.id) && clearOf(t, lot, rings));
        if (choice) {
          lot.archetype = a;
          lot.h = sectionHeight(a, Math.max(1, Math.round((lot.h - SECTIONS[a].ground) / SECTIONS[a].floor)));
          lot.roof = a === 'industrial' ? 'flat' : roofFor(a, lot.h, lot.w, lot.d, () => lot.style[3]);
          break;
        }
      }
    }
    choice ??= ranked(lot.archetype).find((t) => !taken.has(t.id)) ?? TONES[lot.archetype][0];
    lot.tone = choice.id;
    lot.colour = colour(choice.wall);
    lot.accent = colour(choice.accent);
    lot.style = [choice.reflect ?? choice.paint, lot.style[1], lot.style[2], (choice.siding ? 2 : 0) + (lot.style[3] % 1)];
  }
}

/** The types a lot may be rebuilt as at a plaza edge, nearest in scale and era first. */
const FALLBACK: Record<Archetype, Archetype[]> = {
  walkup: ['commercial', 'industrial', 'midcentury', 'brutalist', 'glass', 'parking'],
  commercial: ['walkup', 'midcentury', 'brutalist', 'glass', 'industrial', 'parking'],
  midcentury: ['glass', 'commercial', 'brutalist', 'walkup', 'parking', 'industrial'],
  glass: ['midcentury', 'commercial', 'brutalist', 'walkup', 'parking', 'industrial'],
  brutalist: ['midcentury', 'parking', 'glass', 'commercial', 'walkup', 'industrial'],
  parking: ['brutalist', 'midcentury', 'glass', 'commercial', 'walkup', 'industrial'],
  industrial: ['walkup', 'brutalist', 'commercial', 'midcentury', 'glass', 'parking'],
};

/**
 * The lots that stand on block (i, j) round these plazas (the civic plaza
 * included): none within RESERVE_RADIUS of a plaza (or a quarter's court apron), each one cut to whole
 * storeys of its type under the collar, and those at a district's edge
 * re-toned clear of its tower.
 */
export function standingLots(i: number, j: number, plazas: CollarPlaza[]): Lot[] {
  const out: Lot[] = [];
  for (const lot of blockLots(i, j)) {
    // The river, its quays and its bridges' approaches take the lots they cross (shared/commute.ts).
    if (onRiverGround(lot.x, lot.z, lot.w + 2 * LOT_REACH, lot.d)) continue;
    if (plazas.some((p) => reserves(p, lot.x, lot.z, lot.w, lot.d))) continue;
    const cap = ambientCap(lot.x, lot.z, plazas);
    // A factory stack stands only where nothing caps the skyline.
    out.push({ ...lot, h: cutTo(lot.archetype, lot.h, cap), stack: cap === Infinity ? lot.stack : 0 });
  }
  if (plazas.some((p) => (p.tones?.length || p.value !== undefined) && out.some((l) => Math.hypot(l.x - p.x, l.z - p.z) <= RING_REACH))) {
    // Each lot keeps its index on the block, so lots out of the ring keep their tones unless a neighbour's change forces one.
    for (const l of out) l.tone = '';
    assignTones(i, j, out, plazas);
    for (const l of out) {
      const cap = ambientCap(l.x, l.z, plazas);
      l.h = cutTo(l.archetype, l.h, cap);
    }
  }
  return out;
}

// ---------------------------------------------------------------- parts

/** What a part is drawn with (grid.ts keeps one instanced batch per kind). */
export type PartKind =
  | `wall:${Archetype}`
  | 'trim'
  | 'roofbox'
  | 'tank'
  | 'tankCap'
  | 'stand'
  | 'chimney'
  | 'sawtooth'
  | 'glazeLit'
  | 'glazeDark'
  | 'planter'
  | 'tree'
  | 'deckLight'
  | 'pole'
  | 'bulkhead'
  | 'penthouse'
  | 'screen'
  | 'unit'
  | 'car'
  | 'bay'
  | 'bayGlass'
  | 'bayLit';

/** One box (or cylinder, prism, canopy) of a building: centre, size, a turn about y, and its colour. */
export interface Part {
  kind: PartKind;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rot?: number;
  colour?: THREE.Color;
  /** A wall with its street corners cut (kits.py chamfer_box; rounded, round_box, on mid-century slabs) instead of a plain box. */
  chamfer?: boolean;
}

/** Copings and cornices: stone on masonry, metal on offices and glass, concrete on concrete. */
const TRIM: Record<Archetype, number> = {
  walkup: 0xa9a294,
  commercial: 0xb8b1a2,
  midcentury: 0x7d8186,
  glass: 0x3a3d42,
  brutalist: 0x8f8d88,
  parking: 0x8f8d88,
  industrial: 0x6d6a66,
};
const ROOFBOX: Record<Archetype, number> = {
  walkup: 0x5e5550,
  commercial: 0x8d877c,
  midcentury: 0x6a6e72,
  glass: 0x7b8086,
  brutalist: 0x7e7c77,
  parking: 0x7e7c77,
  industrial: 0x5c5a57,
};

const unit = (s: number): number => s - Math.floor(s);

/**
 * The parts of a standing lot: its walls (stepped back when tall), its
 * copings and cornices, and the roof its type carries. Pure, so the collar
 * test can check every part of every type stays under the cap; nothing on a
 * roof rises more than ROOF_CLUTTER over it, save a factory stack where
 * nothing caps the skyline.
 */
export function lotParts(lot: Lot): Part[] {
  const parts: Part[] = [];
  const a = lot.archetype;
  const s = SECTIONS[a];
  const h = lot.h;
  const p = (kind: PartKind, x: number, y: number, z: number, sx: number, sy: number, sz: number, c?: number | THREE.Color, rot?: number): void => {
    parts.push({ kind, x, y, z, sx, sy, sz, ...(c === undefined ? {} : { colour: typeof c === 'number' ? colour(c) : c }), ...(rot ? { rot } : {}) });
  };
  const wall = `wall:${a}` as PartKind;
  const v = unit(lot.style[3]);
  const trim = a === 'walkup' || a === 'commercial' ? lot.accent : colour(TRIM[a]);

  // Massing: tiers stepped back from the street on tall offices, a podium under glass, a nave over lower aisles in a stepped shed.
  const tiers: Array<{ x: number; z: number; w: number; d: number; y0: number; y1: number }> = [];
  if (a === 'industrial' && lot.roof === 'stepped' && h > 8) {
    const alongX = lot.w >= lot.d;
    const low = Math.max(s.ground + s.parapet, h - s.floor - 0.4);
    tiers.push({ x: lot.x, z: lot.z, w: lot.w, d: lot.d, y0: 0, y1: low });
    tiers.push({ x: lot.x, z: lot.z, w: alongX ? lot.w : lot.w * 0.5, d: alongX ? lot.d * 0.5 : lot.d, y0: low, y1: h });
  } else {
    const steps = (a === 'commercial' && h > 60) || (a === 'glass' && h > 70) ? (h > 130 ? 3 : 2) : a === 'glass' && h > 30 && lot.w > 24 && lot.d > 24 ? 2 : 1;
    let y0 = 0;
    let w = lot.w;
    let d = lot.d;
    const floorsAll = Math.round((h - s.ground - s.parapet) / s.floor);
    for (let t = 0; t < steps; t++) {
      let y1 = h;
      if (t < steps - 1) {
        // A glass podium of three storeys; masonry setbacks at about 60% and 85% of the height, on a floor line.
        const at = a === 'glass' && t === 0 ? 3 : Math.round(floorsAll * (t === 0 ? 0.6 : 0.85));
        y1 = s.ground + (at - 1) * s.floor;
      }
      tiers.push({ x: lot.x, z: lot.z, w, d, y0, y1 });
      y0 = y1;
      const inset = a === 'glass' && t === 0 ? 0.72 : 0.8;
      w *= inset;
      d *= inset;
    }
  }
  // Corner lots of offices and slabs cut their street corners where two street fronts meet: a chamfer on offices
  // and glass, a streamline curve on mid-century slabs.
  const cut = (a === 'commercial' || a === 'midcentury' || a === 'glass') && lot.front.length > 1 && v > 0.45;
  for (const t of tiers) {
    const top = t === tiers[tiers.length - 1];
    const hh = t.y1 - t.y0 - (top ? 0.35 : 0);
    p(wall, t.x, t.y0 + hh / 2, t.z, t.w, hh, t.d, lot.colour);
    if (cut) parts[parts.length - 1].chamfer = true;
    // A coping caps every tier.
    const cap = a === 'brutalist' ? 0 : 0.35;
    if (cap) p('trim', t.x, t.y1 - (top ? 0.35 : 0) + cap / 2, t.z, t.w + 0.14, cap, t.d + 0.14, trim);
    // Cornices on the street faces of masonry, a projecting band at each tier's top.
    if (a === 'walkup' || a === 'commercial') {
      const depth = a === 'commercial' ? 1.1 : 0.7;
      const tall = a === 'commercial' ? 1.0 : 0.6;
      const y = t.y1 - (top ? 0.35 : 0) - 0.9 - tall / 2;
      for (const f of lot.front) {
        if (f === 'px' || f === 'nx') p('trim', t.x + (f === 'px' ? 1 : -1) * (t.w / 2 + depth / 2 - 0.05), y, t.z, depth, tall, t.d, trim);
        else p('trim', t.x, y, t.z + (f === 'pz' ? 1 : -1) * (t.d / 2 + depth / 2 - 0.05), t.w, tall, depth, trim);
      }
    }
    // Walk-ups throw a three-sided bay out over the street, storey by storey, from the first floor to the parapet.
    if (a === 'walkup' && t === tiers[0] && v < 0.7) {
      const storeys = Math.floor((t.y1 - s.ground - s.parapet - 0.35) / s.floor);
      for (const f of lot.front) {
        const along = f === 'px' || f === 'nx' ? t.d : t.w;
        const n = along > 11 ? 2 : 1;
        for (let b = 0; b < n; b++) {
          const o = n === 1 ? (v - 0.35) * along * 0.3 : (b - 0.5) * along * 0.5;
          const bw = 3.0;
          const bd = 0.85;
          for (let k = 0; k < storeys; k++) {
            const y = s.ground + k * s.floor + s.floor / 2;
            const lit = hash(Math.round(lot.x * 3 + b), Math.round(lot.z), k + 7) < 0.45;
            const at = (dx: number, dz: number, rot: number, glass: boolean): void => {
              if (glass) p(lit ? 'bayLit' : 'bayGlass', t.x + dx, y, t.z + dz, bw, s.floor, bd, lit ? colour(0xffffff) : undefined, rot);
              else p('bay', t.x + dx, y, t.z + dz, bw, s.floor, bd, trim, rot);
            };
            for (const glass of [false, true]) {
              if (f === 'pz') at(o, t.d / 2 + bd / 2, 0, glass);
              else if (f === 'nz') at(-o, -t.d / 2 - bd / 2, Math.PI, glass);
              else if (f === 'px') at(t.w / 2 + bd / 2, -o, Math.PI / 2, glass);
              else at(-t.w / 2 - bd / 2, o, -Math.PI / 2, glass);
            }
          }
        }
      }
    }
    // Brutalist: a deep cast cap over the top floor.
    if (a === 'brutalist' && top) p('trim', t.x, h - 1.2, t.z, t.w + 1.4, 2.4, t.d + 1.4, lot.colour);
  }

  const top = tiers[tiers.length - 1];
  const tw = top.w;
  const td = top.d;
  const tx = top.x;
  const tz = top.z;
  const yr = h;
  const box = (kind: PartKind, fx: number, fz: number, w: number, d: number, hh: number, c?: number | THREE.Color): void => p(kind, tx + fx * tw, yr + hh / 2, tz + fz * td, w, hh, d, c);

  switch (lot.roof) {
    case 'bulkhead':
    case 'tank':
    case 'garden': {
      // A stair bulkhead, two chimney stacks on the party wall, and a tank or a planted roof.
      box('bulkhead', 0.18 - v * 0.2, -0.2, Math.min(3.0, tw * 0.28), Math.min(4.0, td * 0.28), 2.6, ROOFBOX[a]);
      // A chimney stack on the party wall.
      if (a === 'walkup') box('roofbox', v < 0.5 ? -0.42 : 0.42, 0.38, 0.7, 1.3, 1.4, lot.colour);
      if (lot.roof === 'tank' && tw > 7 && td > 7) {
        const rad = Math.min(1.6 + v * 0.9, tw * 0.2);
        const fx = -0.2;
        const fz = 0.18;
        p('stand', tx + fx * tw, yr + 1.1, tz + fz * td, rad * 1.7, 2.2, rad * 1.7);
        p('tank', tx + fx * tw, yr + 2.2 + 2.1, tz + fz * td, rad, 4.2, rad);
        p('tankCap', tx + fx * tw, yr + 6.3 + 0.6, tz + fz * td, rad * 1.04, 1.2, rad * 1.04);
      }
      if (lot.roof === 'garden') garden(p, tx, yr, tz, tw * 0.7, td * 0.6, v);
      break;
    }
    case 'penthouse': {
      // A mechanical penthouse set back from the parapet, louvred, with a lift overrun beside it.
      const pw = Math.min(16, tw * (0.28 + v * 0.14));
      const pd = Math.min(12, td * (0.28 + v * 0.12));
      box('penthouse', -0.08, 0.04, pw, pd, 3.8, ROOFBOX[a]);
      box('bulkhead', 0.12, -0.1, Math.min(4.5, tw * 0.15), Math.min(4.5, td * 0.15), 5.6, ROOFBOX[a]);
      break;
    }
    case 'screen': {
      // Plant behind a louvred screen: four thin panels round a square, and the plant showing through the top.
      const sw = tw * 0.55;
      const sd = td * 0.55;
      box('roofbox', 0, 0, sw * 0.8, sd * 0.8, 3.0, ROOFBOX[a]);
      p('screen', tx, yr + 2.1, tz - sd / 2, sw, 4.2, 0.25, lot.accent);
      p('screen', tx, yr + 2.1, tz + sd / 2, sw, 4.2, 0.25, lot.accent);
      p('screen', tx - sw / 2, yr + 2.1, tz, sd, 4.2, 0.25, lot.accent, Math.PI / 2);
      p('screen', tx + sw / 2, yr + 2.1, tz, sd, 4.2, 0.25, lot.accent, Math.PI / 2);
      break;
    }
    case 'terrace': {
      // A terrace on the podium and the top: planters and small trees by the edge, a glass rail.
      box('bulkhead', 0.2, 0.2, tw * 0.3, td * 0.3, 3.6, ROOFBOX[a]);
      garden(p, tx - tw * 0.15, yr, tz - td * 0.1, tw * 0.5, td * 0.5, v);
      if (tiers.length > 1) {
        const pod = tiers[0];
        garden(p, pod.x + (pod.w / 2 - (pod.w - tiers[1].w) / 4) * (v < 0.5 ? 1 : -1), pod.y1, pod.z, (pod.w - tiers[1].w) / 2 - 1.5, pod.d * 0.7, v);
      }
      break;
    }
    case 'cores': {
      // Two stair and lift cores breaking through the cap.
      box('roofbox', -0.25, -0.15, Math.min(6, tw * 0.22), Math.min(6, td * 0.22), 5.2, lot.colour);
      box('roofbox', 0.27, 0.2, Math.min(5, tw * 0.18), Math.min(7, td * 0.25), 4.0, lot.colour);
      break;
    }
    case 'deck': {
      // The top deck: a stair tower, lamp standards on a grid, and cars left out overnight.
      box('roofbox', 0.38, -0.36, 5, 5, 4.4, lot.colour);
      for (let gx = -1; gx <= 1; gx += 2) {
        for (let gz = -1; gz <= 1; gz += 2) {
          p('pole', tx + gx * tw * 0.22, yr + 3.2, tz + gz * td * 0.22, 0.22, 6.4, 0.22);
          p('deckLight', tx + gx * tw * 0.22, yr + 6.45, tz + gz * td * 0.22, 0.9, 0.12, 0.5, colour(0xffffff));
        }
      }
      const cars = 3 + Math.floor(v * 7);
      for (let k = 0; k < cars; k++) {
        const u = hash(Math.round(lot.x), Math.round(lot.z), k);
        const row = k % 2 === 0 ? -0.12 : 0.12;
        p('car', tx + (u - 0.5) * tw * 0.8, yr + 0.75, tz + row * td, 1.9, 1.5, 4.4, colour(CARS[Math.floor(hash(k, Math.round(lot.x), 3) * CARS.length)]));
      }
      break;
    }
    case 'sawtooth': {
      // North-light sawtooth: prisms across the roof, each glazed on its steep face; most dark, a few lit late.
      const alongX = lot.w >= lot.d;
      const span = alongX ? lot.w : lot.d;
      const across = alongX ? lot.d : lot.w;
      const n = Math.max(2, Math.round(span / 7));
      const pitch = span / n;
      const th = 3.2;
      for (let k = 0; k < n; k++) {
        const o = -span / 2 + pitch * (k + 0.5);
        const x = alongX ? lot.x + o : lot.x;
        const z = alongX ? lot.z : lot.z + o;
        // The prism's steep face is at its local -z; turned so it faces away from the low sun.
        p('sawtooth', x, yr + th / 2, z, alongX ? across - 1 : across - 1, th, pitch, colour(0x4b4e52), alongX ? Math.PI / 2 : 0);
        const lit = hash(Math.round(lot.x), Math.round(lot.z), k) < 0.25;
        const gx = alongX ? x - pitch / 2 + 0.06 : x;
        const gz = alongX ? z : z - pitch / 2 + 0.06;
        p(lit ? 'glazeLit' : 'glazeDark', gx, yr + th * 0.5, gz, alongX ? 0.1 : across - 1.6, th * 0.72, alongX ? across - 1.6 : 0.1, lit ? colour(0xffffff) : undefined);
      }
      break;
    }
    case 'stepped': {
      if (tiers.length < 2) break;
      // Clerestory glazing along the raised nave.
      const nave = tiers[tiers.length - 1];
      const low = tiers[0].y1;
      const alongX = lot.w >= lot.d;
      const gh = Math.min(2.4, (nave.y1 - low) * 0.6);
      for (const sgn of [-1, 1]) {
        const lit = hash(Math.round(lot.x), Math.round(lot.z), sgn + 5) < 0.3;
        if (alongX) p(lit ? 'glazeLit' : 'glazeDark', nave.x, low + 0.4 + gh / 2, nave.z + sgn * (nave.d / 2 + 0.03), nave.w - 2, gh, 0.08, lit ? colour(0xffffff) : undefined);
        else p(lit ? 'glazeLit' : 'glazeDark', nave.x + sgn * (nave.w / 2 + 0.03), low + 0.4 + gh / 2, nave.z, 0.08, gh, nave.d - 2, lit ? colour(0xffffff) : undefined);
      }
      box('penthouse', 0.3, 0.1, Math.min(4, tw * 0.2), Math.min(3, td * 0.2), 2.2, 0x55585c);
      break;
    }
    case 'flat':
      if (a === 'industrial' && tw > 10) box('penthouse', -0.2, 0.15, Math.min(4, tw * 0.2), Math.min(3, td * 0.2), 2.0, 0x55585c);
      break;
  }
  if (a !== 'walkup' && a !== 'parking' && lot.roof !== 'garden' && tw > 12 && td > 12) {
    const units = 2 + Math.floor(v * 4);
    for (let k = 0; k < units; k++) {
      const ux = (hash(Math.round(lot.x), k, 41) - 0.5) * (tw - 5);
      const uz = (hash(Math.round(lot.z), k, 43) - 0.5) * (td - 5);
      p('unit', tx + ux, yr + 0.7, tz + uz, 1.4 + v, 1.4, 2.2, colour(0x8a8d90));
    }
  }
  if (lot.stack > 0) {
    // A brick factory stack, only where nothing caps the skyline (standingLots drops it otherwise).
    const r0 = 1.1 + v * 0.5;
    p('chimney', lot.x + lot.w * 0.32, (h + lot.stack) / 2, lot.z - lot.d * 0.3, r0, h + lot.stack, r0, colour(TONES.industrial[0].wall));
  }
  return parts;
}

/** Car paints seen from above at dusk: mostly greys, white, black and silver, a few colours. */
const CARS = [0x1a1b1d, 0xb9bbbd, 0x6f7275, 0xd9d9d6, 0x2a3442, 0x5c1d1a, 0x8a8d90, 0x3d4a3c];

function garden(p: (kind: PartKind, x: number, y: number, z: number, sx: number, sy: number, sz: number, c?: number | THREE.Color) => void, x: number, y: number, z: number, w: number, d: number, v: number): void {
  if (w < 3 || d < 3) return;
  // Raised planting beds along the edge and a few small trees in them.
  p('planter', x, y + 0.35, z - d / 2 + 0.8, w, 0.7, 1.4);
  p('planter', x - w / 2 + 0.8, y + 0.35, z + 0.6, 1.4, 0.7, d - 1.6);
  const trees = 2 + Math.floor(v * 3);
  for (let k = 0; k < trees; k++) {
    const t = (k + 0.5) / trees;
    const r0 = 1.3 + hash(k, Math.round(x), Math.round(z)) * 0.9;
    p('tree', x - w / 2 + 0.8, y + 0.7 + r0 * 0.9, z - d / 2 + 1.6 + t * (d - 3.2), r0, r0 * 1.15, r0, colour(TREES[k % TREES.length]));
  }
}
const TREES = [0x2f3b26, 0x3a4529, 0x283322];

/** A lot's tone, by id (for the board and tests). */
export function toneOf(id: string): Tone | undefined {
  return TONE_BY_ID.get(id);
}

/**
 * A tower's colours for the ambient city round it: the rendered Lab of its
 * stone and brick floors (sunlit, high and low), and the L* of its stone,
 * read from the towers' own measurements (tower/rendered.ts).
 */
export function towerTones(look: Pick<Look, 'stone' | 'brick'>): { tones: Lab[]; value?: number } {
  const tones: Lab[] = [];
  for (const v of [look.stone, look.brick]) {
    const r = RENDERED[v.id];
    if (!r) continue;
    tones.push(r.sun);
    if (r.sunLow) tones.push(r.sunLow);
  }
  return { tones, value: RENDERED[look.stone.id]?.sun[0] };
}
