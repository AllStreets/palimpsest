/**
 * The city's trees (Phase 5 Task 9): one shared system for the street trees,
 * the roof gardens, the quarters' garths and the campus's quads.
 *
 * Three species, modelled in Blender by tools/kits/trees.py and read from
 * app/public/kits/trees.glb: a London plane (`plane`), a common lime
 * (`linden`) and a columnar hornbeam (`hornbeam`), each a bole and branches
 * as tapered tubes and a crown of leaf cards hung round the twig tips and over
 * the crown's shell, at two levels (`near`: every branch and small cards;
 * `far`: the bole and a fifth as many cards at twice the size).
 *
 * Every tree of a species and level is one instance of one draw: three
 * species, two levels, so six draws in the view and six in the shadow map,
 * however many trees stand. No two look alike: each tree's turn, height,
 * width, the lean and lobing of its crown, its green and its wind phase come
 * from a hash of where it stands (`treeLook`), so the same spot always grows
 * the same tree. The near level draws within TREE_NEAR of the eye, the far
 * level past it, dissolving into each other across TREE_FADE by a
 * screen-door pattern; each instance is filed under its level on the CPU as
 * the eye moves, so a far tree never costs the near level's triangles.
 *
 * The leaves are cut out of a leaf atlas drawn here (`leafAtlas`: four
 * clusters of each species' own leaf on a twig), lit with their normals bent
 * to the crown's round (so a crown shades as one volume, from above too), let
 * the low sun through when it stands behind them (translucency), and take
 * the sun through a cap: the sun's whole term off a leaf (its diffuse, its
 * translucency and its sheen) is held to LEAF_SUN_MAX times the leaf's own
 * colour, so a sun-facing crown seen from above stays green instead of going
 * to a grey sheen, and stays under the bloom threshold. The wind moves each
 * crown a few centimetres (under TREE_SWAY_MAX) with the twigs' flutter on
 * top, never the bole.
 */
import * as THREE from 'three';

import { inChannel, type Network } from '../../../shared/commute.js';
import type { CollarPlaza } from './collar.js';
import { parseGlb } from './kits.js';
import { LAMP_EDGE, PITCH, PLAZA_RADIUS } from './lots.js';
import { LAYER, setLayers } from './lod.js';
import { LOD_EYE } from './lod-shader.js';
import { BLOOM_THRESHOLD, EXPOSURE } from './post.js';
import { streetFloor } from './street.js';

export type Species = 'plane' | 'linden' | 'hornbeam';
export const SPECIES: readonly Species[] = ['plane', 'linden', 'hornbeam'];
export type TreeLevel = 'near' | 'far';
export const TREE_LEVELS: readonly TreeLevel[] = ['near', 'far'];

/** Where a tree stands: its foot (on the pavement, the planter's soil, the lawn), its species and its size (1 is the kit's full-grown tree). */
export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  species: Species;
  size: number;
}

/** Each species' full-grown height in the kit (tools/kits/trees.py SPECIES), so a spot can be sized to a height. */
export const TREE_HEIGHT: Readonly<Record<Species, number>> = { plane: 16, linden: 15.3, hornbeam: 10.2 };

/** The near level draws within this of the eye on each tier, the far level past it. */
export const TREE_NEAR = { high: 150, medium: 95 } as const;
/** The band, inside TREE_NEAR, where the two levels dissolve into each other. */
export const TREE_FADE = 24;
/** The eye moves this far before the trees are filed under their levels again. */
const REFILE_STEP = 12;

/** The wind's sway at a crown's rim, metres; the twigs' flutter rides on it (LEAF_FLUTTER). Together under 5 cm. */
export const TREE_SWAY_MAX = 0.032;
export const LEAF_FLUTTER = 0.008;
/** The wind's direction over the city: from the west-south-west, the way the low sun stands. */
const WIND = new THREE.Vector3(0.82, 0, -0.57).normalize();

/**
 * The sun's whole term off a leaf (diffuse, translucency and sheen), held to
 * this times the leaf's own colour: the sun brightens a leaf and never
 * whitens it. A leaf's colour stays under LEAF_ALBEDO_MAX (the atlas's
 * brightest leaf, the vertex shade and the tree's own green at their
 * highest), so the brightest sunlit leaf sits well under the bloom
 * threshold after the exposure.
 */
export const LEAF_SUN_MAX = 1.1;
/** The sky's sheen off a leaf, held the same way: the haze-blue sky in a waxy leaf greyed a crown seen from above. */
export const LEAF_SKY_MAX = 0.18;
/** The brightest leaf colour, linear: the atlas's palest leaf (an underside) times the highest tint (test/trees.test.ts measures it). */
export const LEAF_ALBEDO_MAX = 0.55;
/** How much of the sun comes through a leaf seen against it (its translucency), before the cap. */
export const LEAF_TRANSLUCENCY = 0.55;
/**
 * Leaf cards up close (Task 15a). A card seen edge on is a streak and its straight edge a line, so within
 * LEAF_EDGE_NEAR metres a card turned past LEAF_EDGE_ON (the cosine between its face and the line of sight) is not
 * drawn, the leaves round it filling in; and within LEAF_EYE_CLEAR metres of the eye the leaves part, so an eye at
 * a tree's foot looks out under and through the crown, not from inside it. Both are cut, not dithered: a dither
 * this close left a scatter of single dark pixels over the sky (round 1).
 */
export const LEAF_EDGE_NEAR = 14;
export const LEAF_EDGE_ON = 0.22;
export const LEAF_EYE_CLEAR = 4.5;

/** The sun's term off a leaf of colour `albedo` (one channel, linear), as the shader works it out: Lambert, translucency and sheen, then the cap. */
export function leafSunTerm(o: { sun: number; ndl: number; back: number; sheen: number; albedo: number }): number {
  const diffuse = (o.sun * Math.max(0, o.ndl) * o.albedo) / Math.PI;
  const through = o.sun * Math.pow(Math.max(0, o.back), 4) * LEAF_TRANSLUCENCY * o.albedo;
  return Math.min(diffuse + through + Math.max(0, o.sheen), o.albedo * LEAF_SUN_MAX);
}

/** The brightest a sunlit leaf can be after the exposure: under the bloom threshold, with room for the sky's light on top. */
export const LEAF_PEAK = LEAF_ALBEDO_MAX * (LEAF_SUN_MAX + LEAF_SKY_MAX + 0.6) * EXPOSURE;
/** Whether the brightest sunlit leaf stays under the bloom threshold (test/trees.test.ts). */
export const LEAF_UNDER_BLOOM = LEAF_PEAK < BLOOM_THRESHOLD;

// ---------------------------------------------------------------- a tree's look

/** A 32-bit integer hash to [0, 1). */
export function treeHash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface TreeLook {
  /** The turn about its own axis, radians. */
  yaw: number;
  /** Its scale up and across (1 is the kit's tree). */
  height: number;
  width: number;
  /** Its crown's lean (kit metres at the top, in its own frame) and the phase of the crown's lobing. */
  lean: [number, number];
  lobe: number;
  /** Its green: a multiplier on the leaves' colour (a little yellower or bluer, lighter or darker). */
  tint: [number, number, number];
  /** Its wind phase, 0..1. */
  phase: number;
}

/** A tree's look, from where it stands alone (to the centimetre): the same spot always grows the same tree. */
export function treeLook(spot: TreeSpot): TreeLook {
  const x = Math.round(spot.x * 100);
  const z = Math.round(spot.z * 100);
  const s = SPECIES.indexOf(spot.species) + 1;
  const h = (k: number): number => treeHash(x + k * 7919, z - k * 104729, s * 31 + k);
  const height = spot.size * (0.9 + 0.2 * h(1));
  const width = height * (0.86 + 0.28 * h(2));
  const la = h(3) * Math.PI * 2;
  const lean = 0.2 + 0.7 * h(4);
  // Hue: a yellower or a bluer green; value: lighter or darker; never far from the species' own.
  const hue = h(5) - 0.5;
  const value = 0.84 + 0.3 * h(6);
  return {
    yaw: h(0) * Math.PI * 2,
    height,
    width,
    lean: [Math.cos(la) * lean, Math.sin(la) * lean],
    lobe: h(7),
    tint: [value * (1 + 0.22 * hue), value * (1 + 0.03 * hue), value * (1 - 0.3 * hue)],
    phase: h(8),
  };
}

/**
 * The wind's offset of a point of a tree (world metres) at time t: the crown's
 * sway (two slow waves, by the branch's own phase and the tree's) and, on a
 * leaf, the flutter. `sway` is the point's weight (0 at the root, 1 at the rim).
 */
export function swayOffset(sway: number, branchPhase: number, treePhase: number, t: number, leaf: boolean, y = 0): [number, number, number] {
  const ph = (branchPhase + treePhase) * Math.PI * 2;
  const s = (Math.sin(t * 1.1 + ph) * 0.7 + Math.sin(t * 2.3 + ph * 1.7) * 0.3) * sway * TREE_SWAY_MAX;
  const f = leaf ? sway * LEAF_FLUTTER : 0;
  const q = t * 7.0 + ph * 5.0 + y * 3.0;
  return [WIND.x * s + f * Math.sin(q), f * Math.cos(q * 1.3) * 0.6, WIND.z * s + f * Math.sin(q * 0.8 + 1.0)];
}

// ---------------------------------------------------------------- where the city plants them

/** Inside a plaza, a court or a site (grid.ts paved: the same test the lamps keep off). */
function onPlaza(x: number, z: number, plazas: CollarPlaza[]): boolean {
  return plazas.some((p) => (p.court !== undefined ? Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) < p.court : (p.x - x) ** 2 + (p.z - z) ** 2 < PLAZA_RADIUS * PLAZA_RADIUS));
}

/** How far out, in blocks, the streets are planted on each tier: the nearer city, where a tree is more than a speck. */
export const STREET_TREE_RADIUS = { high: 10, medium: 7 } as const;
/** The roof gardens' trees are planted this far out, in blocks: past it a 4 m tree on a roof is under a pixel from anywhere the eye goes. */
export const ROOF_TREE_RADIUS = { high: 14, medium: 10 } as const;
/** Where the street trees stand along a block's lamp edge, from its centre: between the lamp posts (LAMP_OFFSETS), 8 m from each. */
const STREET_TREE_OFFSETS = [-16, 0, 16];
/** Each street species' size (of the kit's tree): a street tree is pollarded under 10 m, under the viaduct's deck and the lamps' own reach. */
const STREET_SIZE: Record<Species, number> = { plane: 0.58, linden: 0.62, hornbeam: 0.85 };

/**
 * The street trees: on the lamp side of each street (the line of the lamp
 * posts, LAMP_EDGE from a block's centre), between the posts. A street is
 * planted or not along its whole line, and in one species (planes on most,
 * limes on some, the columnar hornbeam on a few); along a planted street a
 * block's run is now and then left bare, a tree is missing here and there
 * and a young one stands where an old one was lost. None stands in a plaza,
 * a court or a site, nor near the river (its channel, quays and bridge
 * approaches). Seeded by the street, so the city plants the same trees
 * every time.
 */
export function streetTreeSpots(quality: 'high' | 'medium', plazas: CollarPlaza[]): TreeSpot[] {
  const out: TreeSpot[] = [];
  const R = STREET_TREE_RADIUS[quality];
  const all = [{ x: 0, z: 0 }, ...plazas];
  /** A street line: axis 0 runs along x (its trees at z = cz + LAMP_EDGE), axis 1 along z. */
  const lineSpecies = (axis: number, k: number): Species | null => {
    if (treeHash(axis, k, 11) >= 0.75) return null;
    const h = treeHash(axis, k, 12);
    return h < 0.55 ? 'plane' : h < 0.88 ? 'linden' : 'hornbeam';
  };
  const run = (axis: number, line: number, block: number, at: (off: number) => [number, number]): void => {
    const species = lineSpecies(axis, line);
    if (!species || treeHash(axis * 977 + line, block, 13) < 0.1) return;
    for (const off of STREET_TREE_OFFSETS) {
      const [x, z] = at(off);
      if (onPlaza(x, z, all) || inChannel(x, 64)) continue;
      const xi = Math.round(x * 10);
      const zi = Math.round(z * 10);
      if (treeHash(xi, zi, 14) < 0.07) continue;
      const young = treeHash(xi, zi, 15) < 0.1;
      out.push({ x, y: streetFloor(x, z), z, species, size: STREET_SIZE[species] * (young ? 0.62 : 1) });
    }
  };
  for (let i = -R; i <= R; i++) {
    for (let j = -R; j <= R; j++) {
      const cx = i * PITCH;
      const cz = j * PITCH;
      run(0, j, i, (off) => [cx + off, cz + LAMP_EDGE]);
      run(1, i, j, (off) => [cx + LAMP_EDGE, cz + off]);
    }
  }
  return out;
}

/** A roof garden's tree as lotParts gives it (an ellipsoid crown on its planter, lots.ts garden) as a tree standing in the planter. */
export function roofTree(p: { x: number; y: number; z: number; sx: number; sy: number }): TreeSpot {
  // The part's crown: radius sx, centred 0.9 of it over the planter's soil; a roof tree stands about 2.6 radii tall.
  const foot = p.y - p.sx * 0.9;
  const species: Species = Math.round(p.x * 7 + p.z * 13) % 3 === 0 ? 'hornbeam' : 'linden';
  return { x: p.x, y: foot, z: p.z, species, size: (p.sx * 2.6) / TREE_HEIGHT[species] };
}

// ---------------------------------------------------------------- the kit

const pieces = new Map<string, THREE.BufferGeometry>();

/** Registers the trees' GLB (node tests read app/public/kits/trees.glb from disk). */
export function registerTrees(buf: ArrayBuffer): void {
  for (const [name, geo] of parseGlb(buf)) pieces.set(name, geo);
}

export function hasTrees(): boolean {
  return SPECIES.every((s) => pieces.has(`${s}.near`) && pieces.has(`${s}.far`));
}

let loading: Promise<void> | null = null;
/** Fetches and registers the trees once; without them each species stands as a plain crown of cards (fallbackTree). */
export function loadTrees(): Promise<void> {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  loading ??= fetch(`${base}kits/trees.glb`)
    .then((r) => {
      if (!r.ok) throw new Error(`trees: ${r.status}`);
      return r.arrayBuffer();
    })
    .then(registerTrees);
  return loading;
}

/**
 * A plain stand-in for a species when trees.glb did not load: a bole and
 * forty cards over an ellipsoid crown of the species' own proportions, with
 * the kit's attributes, so the same shader draws it.
 */
function fallbackTree(species: Species): THREE.BufferGeometry {
  const H = TREE_HEIGHT[species];
  const rx = species === 'hornbeam' ? H * 0.2 : species === 'linden' ? H * 0.31 : H * 0.41;
  const cy = H * 0.62;
  const ry = H * 0.37;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const tree: number[] = [];
  const idx: number[] = [];
  const v = (p: THREE.Vector3, n: THREE.Vector3, c: number, u: number, w: number, kind: number, sway: number): number => {
    pos.push(p.x, p.y, p.z);
    nrm.push(n.x, n.y, n.z);
    col.push(c, c, c);
    uv.push(u, w);
    tree.push(kind, sway * 255, 0, (p.y / H) * 255);
    return pos.length / 3 - 1;
  };
  const bole = new THREE.CylinderGeometry(0.15, 0.3, cy, 6, 1, true).translate(0, cy / 2, 0);
  const bp = bole.attributes.position;
  const bn = bole.attributes.normal;
  const base = pos.length / 3;
  for (let i = 0; i < bp.count; i++) v(new THREE.Vector3().fromBufferAttribute(bp, i), new THREE.Vector3().fromBufferAttribute(bn, i), 0.32, 0, 0, 0, 0);
  for (let i = 0; i < bole.index!.count; i++) idx.push(base + bole.index!.getX(i));
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 40; i++) {
    const y = 1 - (2 * (i + 0.5)) / 40;
    const r = Math.sqrt(1 - y * y);
    const d = new THREE.Vector3(Math.cos(i * golden) * r, y, Math.sin(i * golden) * r);
    const c = new THREE.Vector3(d.x * rx * 0.85, cy + d.y * ry * 0.85, d.z * rx * 0.85);
    const t = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0.3, 1, 0.2)).normalize();
    const b = new THREE.Vector3().crossVectors(d, t);
    const s = species === 'hornbeam' ? 1.6 : 2.4;
    const cu = (i % 2) * 0.5;
    const cv = (Math.floor(i / 2) % 2) * 0.5;
    const q = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([su, sv]) => v(c.clone().addScaledVector(t, (su * s) / 2).addScaledVector(b, (sv * s) / 2), d, 0.85, cu + (su * 0.5 + 0.5) * 0.5, cv + (sv * 0.5 + 0.5) * 0.5, 1, 0.8));
    idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  }
  bole.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aTree', new THREE.Float32BufferAttribute(tree, 4));
  g.setIndex(idx);
  g.computeBoundingBox();
  return g;
}

/** The kit's geometry for a species at a level (shared; its owner never disposes it), or the plain stand-in. */
export function treeGeometry(species: Species, level: TreeLevel): THREE.BufferGeometry {
  const key = `${species}.${level}`;
  let g = pieces.get(key);
  if (!g) {
    g = fallbackTree(species);
    pieces.set(key, g);
  }
  return g;
}

// ---------------------------------------------------------------- the leaf atlas

/** The palest a leaf's pixel may be in the atlas (sRGB, a channel). */
const LEAF_PALE = 0.66;
/** The atlas's side in pixels: 2 by 2 cells of leaf clusters. */
export const ATLAS = 512;

/** Each species' leaf: its outline in polar form about the leaf's middle (1 at the tip, along +x), its size in the cell, how many on a twig, and its green (sRGB). */
const LEAF: Record<Species, { outline: (a: number) => number; size: number; count: number; green: [number, number, number]; long: number }> = {
  // The plane's leaf: five-lobed like a maple's, broad and shallowly toothed.
  plane: {
    outline: (a) => {
      const lobes = [0, 1.0, -1.0, 1.95, -1.95];
      const len = [1, 0.9, 0.9, 0.62, 0.62];
      let f = 0.55;
      for (let k = 0; k < 5; k++) f = Math.max(f, len[k] * Math.exp(-(((a - lobes[k]) / 0.5) ** 2)));
      return f * (1 + 0.03 * Math.sin(a * 22));
    },
    size: 36,
    count: 56,
    green: [0.44, 0.55, 0.26],
    long: 0.95,
  },
  // The lime's: heart-shaped, the base notched, the tip drawn to a short point, finely toothed.
  linden: {
    outline: (a) => {
      const ell = 1 / Math.sqrt(Math.cos(a) ** 2 + (Math.sin(a) / 0.86) ** 2);
      const notch = 1 - 0.42 * Math.exp(-(((Math.abs(a) - Math.PI) / 0.32) ** 2));
      const tip = 1 + 0.22 * Math.exp(-((a / 0.22) ** 2));
      return ell * notch * tip * (1 + 0.025 * Math.sin(a * 34));
    },
    size: 28,
    count: 80,
    green: [0.43, 0.57, 0.24],
    long: 0.9,
  },
  // The hornbeam's: an oval with a pointed tip, doubly toothed, pleated along its veins.
  hornbeam: {
    outline: (a) => {
      const ell = 1 / Math.sqrt(Math.cos(a) ** 2 + (Math.sin(a) / 0.52) ** 2);
      const tip = 1 + 0.18 * Math.exp(-((a / 0.25) ** 2));
      return ell * tip * (1 + 0.04 * Math.sin(a * 28) + 0.02 * Math.sin(a * 56));
    },
    size: 22,
    count: 160,
    green: [0.37, 0.5, 0.22],
    long: 1,
  },
};

/** A seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let t = seed >>> 0 || 1;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A species' leaf atlas, as RGBA bytes (ATLAS square, sRGB, alpha 0 or 255
 * with a pixel of soft edge): four cells, each a twig with its leaves spread
 * round it, every leaf its own size, turn and green, its midrib and veins a
 * little darker, one half of the blade a little lighter where it folds, some
 * turned to show their paler undersides. The cluster fills about two thirds
 * of its cell, ragged at the edge.
 */
export function leafAtlas(species: Species): Uint8Array {
  const L = LEAF[species];
  const out = new Uint8Array(ATLAS * ATLAS * 4);
  const cell = ATLAS / 2;
  const r = rng(1013 + SPECIES.indexOf(species) * 7);
  // Each cell's leaves are painted back to front, so the nearer leaves lie over the farther.
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * cell;
    const oy = Math.floor(c / 2) * cell;
    const mid = cell / 2;
    // The twig: from near one edge of the cell across its middle, curving.
    const ta = r() * Math.PI * 2;
    const twig = (t: number): [number, number] => {
      const bend = Math.sin(t * Math.PI) * 14;
      return [mid + Math.cos(ta) * (t - 0.5) * cell * 0.84 - Math.sin(ta) * bend, mid + Math.sin(ta) * (t - 0.5) * cell * 0.84 + Math.cos(ta) * bend];
    };
    const paint = (px: number, py: number, rgb: [number, number, number], a: number): void => {
      if (px < 0 || py < 0 || px >= cell || py >= cell) return;
      const i = ((oy + py) * ATLAS + ox + px) * 4;
      // Over bare atlas the colour goes down whole (its edge is in the alpha), so a leaf's rim never darkens to black.
      const k = out[i + 3] === 0 ? 1 : a;
      // No leaf paler than LEAF_PALE (sRGB): the sunlit crown's brightest leaf stays a leaf, under the bloom.
      out[i] = Math.round(out[i] * (1 - k) + Math.min(rgb[0], LEAF_PALE) * 255 * k);
      out[i + 1] = Math.round(out[i + 1] * (1 - k) + Math.min(rgb[1], LEAF_PALE) * 255 * k);
      out[i + 2] = Math.round(out[i + 2] * (1 - k) + Math.min(rgb[2], LEAF_PALE) * 255 * k);
      out[i + 3] = Math.max(out[i + 3], Math.round(255 * Math.min(1, k * 2)));
    };
    // The twig itself, a brown line two pixels wide.
    for (let s = 0; s <= 200; s++) {
      const [x, y] = twig(s / 200);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) paint(Math.round(x + dx), Math.round(y + dy), [0.24, 0.19, 0.14], 1);
    }
    for (let k = 0; k < L.count; k++) {
      const t = 0.04 + 0.92 * r();
      const [bx, by] = twig(t);
      // Leaves alternate either side of the twig, angled forward along it, on a short stalk.
      const side = k % 2 ? 1 : -1;
      const ang = ta + side * (0.7 + r() * 0.9) + (r() - 0.5) * 0.4;
      const size = L.size * (0.7 + r() * 0.55) * (1 - Math.abs(t - 0.5) * 0.4);
      // Some leaves on short side shoots, so the cluster has depth across the twig, not a fishbone.
      const shoot = r() < 0.45 ? size * (0.4 + r() * (species === 'hornbeam' ? 1.6 : 0.8)) : 0;
      const stalk = size * 0.2 + shoot;
      const cx = bx + Math.cos(ang) * (stalk + size * 0.5 * L.long);
      const cy = by + Math.sin(ang) * (stalk + size * 0.5 * L.long);
      const under = r() < 0.18;
      const v = 0.78 + r() * 0.4;
      const hue = (r() - 0.5) * 0.16;
      const base: [number, number, number] = under
        ? [(L.green[0] + 0.12) * v, (L.green[1] + 0.1) * v, (L.green[2] + 0.1) * v]
        : [L.green[0] * v * (1 + hue), L.green[1] * v, L.green[2] * v * (1 - hue)];
      // The stalk.
      for (let s = 0; s <= 12; s++) paint(Math.round(bx + Math.cos(ang) * stalk * (s / 12)), Math.round(by + Math.sin(ang) * stalk * (s / 12)), [base[0] * 0.8, base[1] * 0.8, base[2] * 0.7], 1);
      const R = size;
      const x0 = Math.floor(cx - R * 1.3);
      const x1 = Math.ceil(cx + R * 1.3);
      const y0 = Math.floor(cy - R * 1.3);
      const y1 = Math.ceil(cy + R * 1.3);
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          // In the leaf's frame: +u toward its tip, v across.
          const u = dx * Math.cos(ang) + dy * Math.sin(ang);
          const w = -dx * Math.sin(ang) + dy * Math.cos(ang);
          const d = Math.hypot(u, w);
          const a = Math.atan2(w, u);
          const edge = R * L.outline(a) - d;
          if (edge < -0.5) continue;
          const cover = Math.min(1, edge + 0.5);
          // The midrib, the veins (every few pixels along it, sweeping toward the tip), the fold.
          const rib = Math.exp(-((w / 0.9) ** 2)) * (u > -R * 0.6 ? 1 : 0);
          const veins = species === 'plane' ? Math.exp(-(((a % 1.05) / 0.05) ** 2)) * 0.5 : Math.max(0, Math.cos((u - Math.abs(w) * 0.8) * (6 / R) * Math.PI)) ** 8 * 0.35;
          const fold = w > 0 ? 1.08 : 0.94;
          const shade = (1 - 0.28 * rib - 0.12 * veins) * fold * (0.9 + 0.1 * (d / R));
          paint(px, py, [base[0] * shade, base[1] * shade, base[2] * shade], cover);
        }
      }
    }
  }
  // Cleared pixels take the cluster's mean green, so the mipmaps' edges never fringe to black.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 128) continue;
    sr += out[i];
    sg += out[i + 1];
    sb += out[i + 2];
    n++;
  }
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] > 0) continue;
    out[i] = Math.round(sr / n);
    out[i + 1] = Math.round(sg / n);
    out[i + 2] = Math.round(sb / n);
  }
  return out;
}

/** The share of an atlas's pixels a leaf covers (tests: a cluster fills its cards without being a solid square). */
export function atlasCover(rgba: Uint8Array): number {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= 128) n++;
  return n / (rgba.length / 4);
}

const atlases = new Map<Species, THREE.DataTexture>();
function atlasTexture(species: Species): THREE.DataTexture {
  let t = atlases.get(species);
  if (!t) {
    t = new THREE.DataTexture(leafAtlas(species), ATLAS, ATLAS, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.flipY = false;
    t.needsUpdate = true;
    atlases.set(species, t);
  }
  return t;
}

// ---------------------------------------------------------------- the shaders

/** The uniforms every tree material shares: the clock, and the near band's edges for the level's dissolve. */
const SHARED = { uTreeTime: { value: 0 } };

const VERTEX_PARS = /* glsl */ `
attribute vec4 aTree;
attribute vec4 aLook;
attribute vec3 aTint;
uniform float uTreeTime;
uniform vec3 uLodEye;
uniform vec2 uTreeBand;
uniform float uTreeHeight;
varying float vLeaf;
varying float vTreeFade;
varying vec3 vTint;
`;

/** The crown's lean and lobing in the tree's own frame (kit metres), before the instance places it. */
const WARP = /* glsl */ `
  vLeaf = aTree.x;
  vTint = aTint;
  {
    float hgt = aTree.w / 255.0;
    float crown = smoothstep(0.22, 0.6, hgt);
    transformed.xz += aLook.xy * hgt * hgt;
    float ang = atan(transformed.z, transformed.x);
    float lobe = 1.0 + crown * (0.1 * sin(2.0 * ang + aLook.z * 6.2832) + 0.06 * sin(3.0 * ang + aLook.z * 11.0));
    transformed.xz *= lobe;
  }
`;

/** The wind's sway in world metres (swayOffset in this file), and the level's dissolve, after the instance places the point. */
const PROJECT = (fold: string): string => /* glsl */ `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  {
    float sway = aTree.y / 255.0;
    float ph = (aTree.z / 255.0 + aLook.w) * 6.2832;
    float s = (sin(uTreeTime * 1.1 + ph) * 0.7 + sin(uTreeTime * 2.3 + ph * 1.7) * 0.3) * sway * ${TREE_SWAY_MAX.toFixed(4)};
    float f = aTree.x * sway * ${LEAF_FLUTTER.toFixed(4)};
    float q = uTreeTime * 7.0 + ph * 5.0 + position.y * 3.0;
    mvPosition.xyz += vec3(${WIND.x.toFixed(4)} * s + f * sin(q), f * cos(q * 1.3) * 0.6, ${WIND.z.toFixed(4)} * s + f * sin(q * 0.8 + 1.0));
  }
  {
    #ifdef USE_INSTANCING
      vec3 treeAt = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #else
      vec3 treeAt = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    vTreeFade = smoothstep(uTreeBand.x, uTreeBand.y, distance(treeAt, uLodEye));
  }
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
  if (${fold}) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
`;

const DITHER = 'float treeN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));';

/** The leaf's cut: lowered as the mipmaps average the leaves away, so a far crown keeps its fill. */
const CUT = /* glsl */ `
  float treeCut(vec2 uv) {
    vec2 dx = dFdx(uv * ${ATLAS.toFixed(1)});
    vec2 dy = dFdy(uv * ${ATLAS.toFixed(1)});
    float mip = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-6));
    return mix(0.5, 0.28, clamp(mip / 4.0, 0.0, 1.0));
  }
`;

const LEAF_LIGHT = /* glsl */ `
#include <lights_fragment_end>
if (vLeaf > 0.5) {
  vec3 through = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
    // The low sun through the leaves when the crown stands between it and the eye: a yellow-green glow.
    float back = saturate(dot(-geometryViewDir, directionalLights[0].direction));
    through = directionalLights[0].color * pow(back, 4.0) * ${LEAF_TRANSLUCENCY.toFixed(3)} * diffuseColor.rgb * vec3(1.0, 1.08, 0.7) * vTreeShade;
  #endif
  // The sun's whole term held to LEAF_SUN_MAX times the leaf's colour: brighter, never whiter.
  reflectedLight.directDiffuse = min(reflectedLight.directDiffuse + reflectedLight.directSpecular + through, diffuseColor.rgb * ${LEAF_SUN_MAX.toFixed(3)});
  reflectedLight.directSpecular = vec3(0.0);
  reflectedLight.indirectSpecular = min(reflectedLight.indirectSpecular, diffuseColor.rgb * ${LEAF_SKY_MAX.toFixed(3)});
}
`;

/** A tree material for a species at a level: the kit's standard lighting, cut-out leaves, the crown's round normals and the leaf cap. */
function treeMaterial(species: Species, level: TreeLevel, band: THREE.Vector2): { view: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const map = atlasTexture(species);
  const keep = level === 'near' ? 'treeN < vTreeFade' : 'treeN >= vTreeFade';
  const fold = level === 'near' ? 'vTreeFade >= 1.0' : 'vTreeFade <= 0.0';
  const uniforms = { uLodEye: LOD_EYE, uTreeBand: { value: band }, uTreeHeight: { value: TREE_HEIGHT[species] } };
  const view = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, map });
  view.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, SHARED, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}\nvarying float vTreeShade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WARP}\nvTreeShade = color.r;`)
      .replace('#include <project_vertex>', PROJECT(fold));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vLeaf;\nvarying float vTreeFade;\nvarying vec3 vTint;\nvarying float vTreeShade;\n${CUT}`)
      // The card's own face from the view position's derivatives, taken in uniform flow before any discard (Task 15a).
      .replace('void main() {', `void main() {\n  ${DITHER}\n  vec3 cardN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));\n  if (${keep}) discard;`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        if (vLeaf > 0.5) {
          vec4 leafTex = texture2D(map, vMapUv);
          if (leafTex.a < treeCut(vMapUv)) discard;
          // Up close (LEAF_EDGE_NEAR, LEAF_EDGE_ON, LEAF_EYE_CLEAR): no edge-on card, and the leaves part round the eye.
          float leafD = length(vViewPosition);
          bool edgeOn = leafD < ${LEAF_EDGE_NEAR.toFixed(1)} && abs(dot(cardN, vViewPosition / max(leafD, 1e-4))) < ${LEAF_EDGE_ON.toFixed(3)};
          if (edgeOn || leafD < ${LEAF_EYE_CLEAR.toFixed(1)}) discard;
          diffuseColor.rgb *= leafTex.rgb * vTint;
        } else {
          // Bark: its own tone (the vertex colour), mottled along and round the branch.
          float m = fract(sin(dot(floor(vMapUv * vec2(9.0, 23.0)), vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb *= 0.86 + 0.24 * m;
        }`,
      )
      .replace('normal *= faceDirection;', 'normal *= vLeaf > 0.5 ? 1.0 : faceDirection;')
      .replace('#include <lights_fragment_end>', LEAF_LIGHT);
  };
  view.customProgramCacheKey = () => `palimpsest-tree-${level}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, side: THREE.DoubleSide });
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, SHARED, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WARP}`)
      .replace('#include <project_vertex>', PROJECT(fold));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vLeaf;\nvarying float vTreeFade;\nvarying vec3 vTint;\n${CUT}`)
      .replace('#include <map_fragment>', 'if (vLeaf > 0.5 && texture2D(map, vMapUv).a < treeCut(vMapUv)) discard;')
      .replace('#include <alphatest_fragment>', '');
  };
  depth.customProgramCacheKey = () => `palimpsest-tree-depth-${level}`;
  return { view, depth };
}

// ---------------------------------------------------------------- the system

export interface TreeClock {
  /** Seconds, for the wind. */
  time: number;
  /** The view's eye, for each tree's level. */
  eye: THREE.Vector3;
}

export interface Trees {
  object: THREE.Group;
  /** Plants these trees in place of every tree before. */
  place(spots: TreeSpot[]): void;
  /** The wind's clock, and each tree filed under its level for the eye. True when what casts a shadow changed. */
  update(clock: TreeClock): boolean;
  /** The trees standing, and how many draw at each level now. */
  counts(): { trees: number; near: number; far: number };
  /** Each tree's instance data, by spot (tests): its matrix, look and tint as placed. */
  instanceOf(spot: TreeSpot): { matrix: number[]; look: number[]; tint: number[] } | null;
  setQuality(q: 'high' | 'medium'): void;
  dispose(): void;
}

interface Planted {
  spot: TreeSpot;
  matrix: Float32Array;
  look: [number, number, number, number];
  tint: [number, number, number];
  x: number;
  y: number;
  z: number;
}

/** The trees: one instanced draw per species and level (TREE_LEVELS), filled from the spots placed. */
export function createTrees(quality: 'high' | 'medium'): Trees {
  const object = new THREE.Group();
  object.name = 'trees';
  let near: number = TREE_NEAR[quality];
  const band = new THREE.Vector2(near - TREE_FADE, near);
  type Level = { mesh: THREE.InstancedMesh; look: THREE.InstancedBufferAttribute; tint: THREE.InstancedBufferAttribute; cap: number; depth: THREE.MeshDepthMaterial };
  const levels = new Map<string, Level>();
  const mats: THREE.Material[] = [];
  const make = (species: Species, level: TreeLevel, cap: number): Level => {
    const geo = treeGeometry(species, level).clone();
    const look = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    look.setUsage(THREE.DynamicDrawUsage);
    tint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aLook', look);
    geo.setAttribute('aTint', tint);
    const m = treeMaterial(species, level, band);
    mats.push(m.view, m.depth);
    const mesh = new THREE.InstancedMesh(geo, m.view, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = m.depth;
    mesh.name = `trees:${species}.${level}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    // The view and the sun's shadow map; never the AO's normal pass, which knows nothing of cut-out leaves.
    setLayers(mesh, LAYER.view, LAYER.shadow);
    object.add(mesh);
    return { mesh, look, tint, cap, depth: m.depth };
  };
  let planted: Planted[] = [];
  const bySpecies = new Map<Species, Planted[]>();
  const eyeAt = new THREE.Vector3(Infinity, 0, 0);
  let nearNow = 0;
  let farNow = 0;

  function ensure(species: Species, cap: number): void {
    for (const level of TREE_LEVELS) {
      const key = `${species}.${level}`;
      const have = levels.get(key);
      if (have && have.cap >= cap) continue;
      if (have) {
        object.remove(have.mesh);
        have.mesh.geometry.dispose();
        have.mesh.dispose();
      }
      levels.set(key, make(species, level, Math.max(cap, have ? have.cap * 2 : 16)));
    }
  }

  function fill(l: Level, trees: Planted[]): void {
    const m = l.mesh.instanceMatrix.array as Float32Array;
    const look = l.look.array as Float32Array;
    const tint = l.tint.array as Float32Array;
    trees.forEach((t, i) => {
      m.set(t.matrix, i * 16);
      look.set(t.look, i * 4);
      tint.set(t.tint, i * 3);
    });
    l.mesh.count = trees.length;
    l.mesh.visible = trees.length > 0;
    l.mesh.instanceMatrix.needsUpdate = true;
    l.look.needsUpdate = true;
    l.tint.needsUpdate = true;
  }

  /** Files each tree under its level for the eye: near within the near radius (and a step past it), far past the band's start (and a step short of it). */
  function refile(eye: THREE.Vector3): void {
    eyeAt.copy(eye);
    nearNow = 0;
    farNow = 0;
    for (const species of SPECIES) {
      const all = bySpecies.get(species) ?? [];
      const n: Planted[] = [];
      const f: Planted[] = [];
      for (const t of all) {
        const d = Math.hypot(t.x - eye.x, t.y - eye.y, t.z - eye.z);
        if (d < near + REFILE_STEP) n.push(t);
        if (d > near - TREE_FADE - REFILE_STEP) f.push(t);
      }
      const ln = levels.get(`${species}.near`);
      const lf = levels.get(`${species}.far`);
      if (ln) fill(ln, n);
      if (lf) fill(lf, f);
      nearNow += n.length;
      farNow += f.length;
    }
  }

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.Matrix4();
  return {
    object,
    place(spots) {
      planted = spots.map((spot) => {
        const look = treeLook(spot);
        mat.compose(new THREE.Vector3(spot.x, spot.y, spot.z), q.setFromAxisAngle(up, look.yaw), new THREE.Vector3(look.width, look.height, look.width));
        return { spot, matrix: Float32Array.from(mat.elements), look: [look.lean[0], look.lean[1], look.lobe, look.phase], tint: look.tint, x: spot.x, y: spot.y + TREE_HEIGHT[spot.species] * look.height * 0.5, z: spot.z };
      });
      bySpecies.clear();
      for (const t of planted) {
        const list = bySpecies.get(t.spot.species) ?? [];
        list.push(t);
        bySpecies.set(t.spot.species, list);
      }
      for (const species of SPECIES) ensure(species, (bySpecies.get(species) ?? []).length);
      if (Number.isFinite(eyeAt.x)) refile(eyeAt.clone());
    },
    update(clock) {
      SHARED.uTreeTime.value = clock.time % 3600;
      if (eyeAt.distanceTo(clock.eye) < REFILE_STEP) return false;
      refile(clock.eye);
      return true;
    },
    counts: () => ({ trees: planted.length, near: nearNow, far: farNow }),
    instanceOf(spot) {
      const t = planted.find((p) => p.spot.x === spot.x && p.spot.z === spot.z && p.spot.species === spot.species);
      return t ? { matrix: [...t.matrix], look: [...t.look], tint: [...t.tint] } : null;
    },
    setQuality(qual) {
      near = TREE_NEAR[qual];
      band.set(near - TREE_FADE, near);
      if (Number.isFinite(eyeAt.x)) refile(eyeAt.clone());
    },
    dispose() {
      for (const l of levels.values()) {
        l.mesh.geometry.dispose();
        l.mesh.dispose();
      }
      levels.clear();
      for (const m of mats) m.dispose();
    },
  };
}

/** The pavements the transit stands on: no street tree within this of a station, a stop or a cab rank (their platforms, stairs, halls and signs). */
const TRANSIT_CLEAR = { rail: 30, pod: 26, tram: 16, rank: 16 } as const;

/** The spots clear of the network's stations, stops and ranks (scene.ts plants the rest). */
export function clearOfTransit(spots: TreeSpot[], net: Network | null): TreeSpot[] {
  if (!net) return spots;
  const keep: Array<[number, number, number]> = [
    ...net.rail.stops.map((s): [number, number, number] => [s.x, s.z, TRANSIT_CLEAR.rail]),
    ...net.pods.flatMap((p) => p.stops.map((s): [number, number, number] => [s.x, s.z, TRANSIT_CLEAR.pod])),
    ...net.tram.stops.map((s): [number, number, number] => [s.x, s.z, TRANSIT_CLEAR.tram]),
    ...net.ranks.map((r): [number, number, number] => [r.x, r.z, TRANSIT_CLEAR.rank]),
  ];
  return spots.filter((t) => keep.every(([x, z, r]) => Math.hypot(t.x - x, t.z - z) >= r));
}
