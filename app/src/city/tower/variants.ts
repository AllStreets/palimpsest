import { districtOrigin, DISTRICT_PITCH } from '../../../../shared/district-layout.js';
import type { Era } from '../../../../shared/types.js';

/**
 * Per-repo materials inside each era. The era of a floor is the agent's
 * ability when it was laid (spec 6.2) and never changes; what changes from
 * tower to tower is the material that era is built in: Indiana limestone or
 * dark granite, common red or cream city brick, bronze or blue curtain wall,
 * and so on. Each repo's choice comes from a hash of its full name, so a
 * tower keeps its look for good, and the picker steers neighbouring
 * districts apart. Pure data: look.ts turns finishes into materials, and
 * Node tests read the table directly.
 */

/**
 * The scanned sets a masonry finish can start from (app/public/textures, see
 * CREDITS.md): red brick, ironspot brick, sandstone blocks, rusted plate
 * (for patina), polished granite tiles, cut ashlar slabs.
 */
export type Scan = 'brick' | 'ironspot' | 'sand' | 'rust' | 'granite' | 'ashlar';

/**
 * A surface. Colours are sRGB hex. `seen` is roughly how the surface reads
 * in daylight, for the palette and contrast checks; it defaults to `body`
 * or `color`.
 */
export type Finish =
  | {
      /**
       * A scanned masonry or patina set. With `keep` the scan's own colour
       * shows under a `body` tint; otherwise the scan's body and joints
       * (brick and mortar, stone and its joints) are recoloured to `body`
       * and `joint`, keeping the scan's own grain and unit-to-unit variation.
       * `rough` is the surface's mean roughness (the scan's own map varies
       * round it); `scale` enlarges (above 1) or shrinks the scan's units.
       */
      kind: 'scan';
      tex: Scan;
      body: number;
      joint?: number;
      keep?: boolean;
      rough: number;
      normal?: number;
      scale?: number;
      seen?: number;
    }
  /** Cast or rolled metal under the scanned plate's normal and roughness. */
  | { kind: 'metal'; color: number; rough: number; seen?: number }
  /** Brushed metal with anisotropic highlights (the aniso-patch path). */
  | { kind: 'brushed'; color: number; rough: number; aniso: number; env: number; seen?: number }
  /** A smooth made surface: glazed faience, ceramic, carbon, pearl, mineral patina. */
  | { kind: 'solid'; color: number; rough: number; metal?: number; clearcoat?: number; iridescence?: number; env?: number; seen?: number };

/** The glass of a variant's windows: the pane's own body colour and the tint it gives the rooms behind. */
export interface Glazing {
  body: number;
  tint: number;
  env: number;
  /** Ribbed channel glass: translucent U-profiles, the rooms read only as light. */
  channel?: boolean;
}

/** The rhythm of a masonry wall: bay pitch, window width and height (a fraction of the floor), reveal depth, and windows in pairs. */
export interface MasonryRhythm {
  bay: number;
  winW: number;
  winH: number;
  reveal: number;
  paired: boolean;
}

/**
 * How a variant reads from across the city, in light and hue together:
 * neighbours avoid sharing a family as well as a variant, so a pale cool
 * stone never stands beside another pale cool stone when there is a choice.
 */
export type Family = 'pale-cool' | 'pale-warm' | 'mid-warm' | 'mid-cool' | 'dark' | 'green' | 'bronze';

export interface Variant {
  id: string;
  era: Era;
  name: string;
  family: Family;
  /** The main surface: masonry wall, curtain-wall spandrel, titanium fins, sci-fi exoskeleton. */
  wall: Finish;
  /** The second surface: sills, lintels and quoins; mullions; slab edges; sci-fi slab fascias. */
  trim: Finish;
  /** The accent the variant picks up: belt courses, cornices, caps and the crown. */
  band: Finish;
  glass: Glazing;
  /**
   * The tenants behind the glass: the share of windows lit and how many of
   * the lit floors burn warm lamps rather than cool office light. From
   * across the city a curtain wall reads mostly by its lit floors, so this
   * is much of an upper era's identity.
   */
  lights?: { lit: number; warm: number };
  /** Masonry eras only. */
  masonry?: Partial<MasonryRhythm>;
  /** Glass and titanium eras: the mullion or fin pitch, metres. */
  pitch?: number;
  /** Glass and titanium eras: how far mullions or fins stand out, as a multiple of the era's own. */
  depth?: number;
  /** Glass era: the spandrel band's height at each slab, metres (ribbon windows run tall bands). */
  spandrel?: number;
  /** Sci-fi: light seams set into the corner masts. */
  seams?: boolean;
}

export type Look = Record<Era, Variant>;

/** The colour a finish reads as, for the palette and contrast checks. */
export function swatch(f: Finish): number {
  return f.seen ?? (f.kind === 'scan' ? f.body : f.color);
}

// ---------------------------------------------------------------- finishes

const scan = (tex: Scan, body: number, rough: number, more: Partial<Extract<Finish, { kind: 'scan' }>> = {}): Finish => ({ kind: 'scan', tex, body, rough, ...more });

// Stone bases sit cool of what they read as, because the low dusk sun warms every sunlit face.
const LIMESTONE = scan('ashlar', 0xacb0af, 0.5, { normal: 0.8, joint: 0x8a8e8d });
const SANDSTONE = scan('sand', 0xaea78d, 0.55, { normal: 0.9, joint: 0x8b846c });
const MARBLE = scan('ashlar', 0xcdd1d3, 0.18, { normal: 0.3, joint: 0xa7abad, scale: 1.4 });
const DARK_GRANITE = scan('granite', 0x3b3d41, 0.2, { normal: 0.5, joint: 0x26272a });
const ROSE_GRANITE = scan('granite', 0x857d88, 0.22, { normal: 0.5, joint: 0x57515a });
const BRONZE: Finish = { kind: 'metal', color: 0x6b4a2e, rough: 0.42 };
const DARK_BRONZE: Finish = { kind: 'metal', color: 0x4a3324, rough: 0.5 };
const GRAPHITE: Finish = { kind: 'brushed', color: 0x2e3136, rough: 0.42, aniso: 0.4, env: 1.4 };
const TITANIUM: Finish = { kind: 'brushed', color: 0xa9afb7, rough: 0.13, aniso: 0.6, env: 2.2 };
const ALUMINIUM: Finish = { kind: 'metal', color: 0xaab0b5, rough: 0.36 };
const BLACK_STEEL: Finish = { kind: 'metal', color: 0x17181a, rough: 0.34 };
const VERDIGRIS = scan('rust', 0x6f8a7c, 0.5, { joint: 0x51665a, normal: 0.6 });
/** Verdigris as a smooth mineral skin, for curved fins where a scan would wrap into blotches. */
const PATINA: Finish = { kind: 'solid', color: 0x628a86, rough: 0.6, metal: 0.15 };
const TERRACOTTA = scan('brick', 0xd2cdc2, 0.2, { joint: 0x9c968c, normal: 0.55 });
const FAIENCE: Finish = { kind: 'solid', color: 0x5c7466, rough: 0.28, env: 1.3 };

/** Punched windows in masonry: dark glass, rooms seen as they are. */
const CLEAR: Glazing = { body: 0x000000, tint: 0xffffff, env: 1.15 };

// ---------------------------------------------------------------- the table

export const VARIANTS: Record<Era, Variant[]> = {
  stone: [
    { id: 'stone:limestone', era: 'stone', name: 'Indiana limestone', family: 'pale-cool', wall: LIMESTONE, trim: LIMESTONE, band: LIMESTONE, glass: CLEAR },
    { id: 'stone:sandstone', era: 'stone', name: 'Pale sandstone', family: 'pale-warm', wall: SANDSTONE, trim: SANDSTONE, band: SANDSTONE, glass: CLEAR },
    {
      id: 'stone:pink-granite',
      era: 'stone',
      name: 'Pink granite',
      family: 'mid-warm',
      wall: ROSE_GRANITE,
      trim: ROSE_GRANITE,
      band: DARK_GRANITE,
      glass: { body: 0x050302, tint: 0xfff0e2, env: 1.2 },
      masonry: { bay: 3.0, winW: 1.3 },
    },
    {
      id: 'stone:dark-granite',
      era: 'stone',
      name: 'Dark grey granite',
      family: 'dark',
      wall: DARK_GRANITE,
      trim: DARK_GRANITE,
      band: BRONZE,
      glass: { body: 0x080604, tint: 0xffe6c8, env: 1.3 },
      masonry: { winH: 0.6 },
    },
    {
      id: 'stone:marble',
      era: 'stone',
      name: 'White marble',
      family: 'pale-cool',
      wall: MARBLE,
      trim: MARBLE,
      band: MARBLE,
      glass: { body: 0x020406, tint: 0xeef4ff, env: 1.2 },
      masonry: { winH: 0.62, winW: 1.4 },
    },
    {
      id: 'stone:travertine',
      era: 'stone',
      name: 'Rusticated travertine',
      family: 'mid-warm',
      wall: scan('sand', 0x9a8f7b, 0.7, { normal: 1.4, joint: 0x6f6758, scale: 0.8 }),
      trim: MARBLE,
      band: MARBLE,
      glass: CLEAR,
      masonry: { bay: 4.3, winW: 1.7, reveal: 0.7 },
    },
  ],
  brick: [
    {
      id: 'brick:red',
      era: 'brick',
      name: 'Common red brick',
      family: 'mid-warm',
      wall: scan('brick', 0xd8c4b8, 0.55, { keep: true, seen: 0x5a4036 }),
      trim: LIMESTONE,
      band: LIMESTONE,
      glass: CLEAR,
    },
    {
      id: 'brick:cream',
      era: 'brick',
      name: 'Cream city brick',
      family: 'pale-warm',
      wall: scan('brick', 0xc6bea6, 0.6, { joint: 0xa9a496 }),
      trim: SANDSTONE,
      band: VERDIGRIS,
      glass: { body: 0x020406, tint: 0xf4f6ff, env: 1.15 },
      masonry: { bay: 3.2 },
    },
    {
      id: 'brick:ironspot',
      era: 'brick',
      name: 'Dark ironspot manganese',
      family: 'dark',
      wall: scan('ironspot', 0xd6cec8, 0.8, { keep: true, seen: 0x453929 }),
      trim: DARK_GRANITE,
      band: BRONZE,
      glass: { body: 0x060403, tint: 0xffe8cc, env: 1.2 },
      masonry: { bay: 2.3, winW: 1.0, winH: 0.66 },
    },
    {
      id: 'brick:terracotta',
      era: 'brick',
      name: 'Glazed white terracotta',
      family: 'pale-cool',
      wall: TERRACOTTA,
      trim: TERRACOTTA,
      band: TERRACOTTA,
      glass: { body: 0x020304, tint: 0xf2f4f8, env: 1.2 },
      masonry: { bay: 4.4, winW: 0.95, winH: 0.62, paired: true },
    },
    {
      id: 'brick:green-terracotta',
      era: 'brick',
      name: 'Dark green glazed terracotta',
      family: 'green',
      wall: scan('brick', 0x34463c, 0.2, { joint: 0x4c5a52, normal: 0.6 }),
      trim: FAIENCE,
      band: BRONZE,
      glass: { body: 0x040605, tint: 0xfff0dc, env: 1.2 },
      masonry: { bay: 2.6, winW: 1.15, winH: 0.64 },
    },
    {
      id: 'brick:salmon',
      era: 'brick',
      name: 'Salmon brick',
      family: 'mid-warm',
      wall: scan('brick', 0xa47e6c, 0.6, { joint: 0xbdb3a3 }),
      trim: SANDSTONE,
      band: SANDSTONE,
      glass: CLEAR,
      masonry: { bay: 3.4, winW: 1.7 },
    },
  ],
  glass: [
    {
      id: 'glass:green',
      era: 'glass',
      name: 'Green-tinted curtain wall',
      family: 'green',
      wall: { kind: 'solid', color: 0x2f3d38, rough: 0.45, metal: 0.4 },
      trim: { kind: 'metal', color: 0x8d9590, rough: 0.4 },
      band: { kind: 'metal', color: 0x8d9590, rough: 0.4 },
      glass: { body: 0x0e1f19, tint: 0xd4e6dc, env: 1.25 },
      // Ribbon windows: a deep spandrel band at every slab, so the shaft reads in horizontal stripes.
      spandrel: 1.5,
      depth: 0.6,
      lights: { lit: 0.7, warm: 0.35 },
    },
    {
      id: 'glass:bronze',
      era: 'glass',
      name: 'Bronze-tinted curtain wall',
      family: 'bronze',
      wall: { kind: 'metal', color: 0x3b2c22, rough: 0.45 },
      trim: BRONZE,
      band: BRONZE,
      glass: { body: 0x1a120a, tint: 0xffdcb8, env: 1.35 },
      // Deep bronze I-beam mullions, close together: the shaft reads in vertical lines.
      pitch: 1.4,
      depth: 2.0,
      lights: { lit: 0.6, warm: 0.92 },
    },
    {
      id: 'glass:blue',
      era: 'glass',
      name: 'Cool blue curtain wall',
      family: 'mid-cool',
      wall: { kind: 'solid', color: 0x2c3644, rough: 0.4, metal: 0.4 },
      trim: ALUMINIUM,
      band: ALUMINIUM,
      glass: { body: 0x0a1220, tint: 0xd2ddff, env: 1.3 },
      pitch: 1.8,
      spandrel: 0.35,
      lights: { lit: 0.85, warm: 0.12 },
    },
    {
      id: 'glass:black',
      era: 'glass',
      name: 'Clear glass, black mullions',
      family: 'dark',
      wall: BLACK_STEEL,
      trim: BLACK_STEEL,
      band: BLACK_STEEL,
      glass: { body: 0x000000, tint: 0xffffff, env: 1.0 },
      pitch: 1.4,
      depth: 1.5,
      spandrel: 0.9,
      lights: { lit: 0.45, warm: 0.6 },
    },
    {
      id: 'glass:channel',
      era: 'glass',
      name: 'Ribbed channel glass',
      family: 'pale-warm',
      wall: { kind: 'metal', color: 0x9a9fa3, rough: 0.5 },
      trim: ALUMINIUM,
      band: ALUMINIUM,
      glass: { body: 0x6f7477, tint: 0xfff2e2, env: 0.7, channel: true },
      pitch: 2.4,
      spandrel: 0.5,
      lights: { lit: 0.85, warm: 0.8 },
    },
  ],
  titanium: [
    {
      id: 'titanium:titanium',
      era: 'titanium',
      name: 'Brushed titanium',
      family: 'pale-cool',
      wall: TITANIUM,
      trim: GRAPHITE,
      band: GRAPHITE,
      glass: { body: 0x050608, tint: 0xe6eeff, env: 1.15 },
      lights: { lit: 0.55, warm: 0.12 },
    },
    {
      id: 'titanium:zinc',
      era: 'titanium',
      name: 'Pre-weathered zinc',
      family: 'mid-cool',
      // Pre-weathered zinc wears a matte carbonate patina, a mineral layer rather than bare metal.
      wall: { kind: 'solid', color: 0x7a838a, rough: 0.58, metal: 0.25 },
      trim: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      band: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      glass: { body: 0x04070a, tint: 0xeef2ff, env: 1.15 },
      // Flat standing-seam panels: close, shallow fins.
      pitch: 1.2,
      depth: 0.45,
      lights: { lit: 0.7, warm: 0.3 },
    },
    {
      id: 'titanium:copper',
      era: 'titanium',
      name: 'Weathered copper',
      family: 'green',
      wall: PATINA,
      trim: DARK_BRONZE,
      band: DARK_BRONZE,
      glass: { body: 0x070504, tint: 0xfff0dc, env: 1.15 },
      pitch: 2.6,
      depth: 1.6,
      lights: { lit: 0.5, warm: 0.85 },
    },
    {
      id: 'titanium:bronze',
      era: 'titanium',
      name: 'Bronze cladding',
      family: 'bronze',
      wall: { kind: 'brushed', color: 0x7a5a40, rough: 0.2, aniso: 0.65, env: 2.0 },
      trim: GRAPHITE,
      band: GRAPHITE,
      glass: { body: 0x0a0604, tint: 0xffe2c4, env: 1.2 },
      depth: 1.25,
      lights: { lit: 0.6, warm: 0.75 },
    },
    {
      id: 'titanium:black',
      era: 'titanium',
      name: 'Black anodised aluminium',
      family: 'dark',
      wall: { kind: 'brushed', color: 0x1f2023, rough: 0.28, aniso: 0.4, env: 1.6 },
      trim: BRONZE,
      band: BRONZE,
      glass: { body: 0x020202, tint: 0xfff4e8, env: 1.15 },
      pitch: 1.7,
      lights: { lit: 0.4, warm: 0.5 },
    },
  ],
  scifi: [
    { id: 'scifi:graphite', era: 'scifi', name: 'Graphite and titanium', family: 'dark', wall: GRAPHITE, trim: TITANIUM, band: TITANIUM, glass: CLEAR, lights: { lit: 0.92, warm: 0.5 } },
    {
      id: 'scifi:ceramic',
      era: 'scifi',
      name: 'White ceramic',
      family: 'pale-warm',
      wall: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      trim: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      band: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      glass: { body: 0x020304, tint: 0xf4f6fa, env: 1.2 },
      lights: { lit: 0.85, warm: 0.85 },
    },
    {
      id: 'scifi:carbon',
      era: 'scifi',
      name: 'Dark carbon with light seams',
      family: 'dark',
      wall: { kind: 'solid', color: 0x1b1d20, rough: 0.3, metal: 0.3, clearcoat: 0.6 },
      trim: GRAPHITE,
      band: { kind: 'solid', color: 0x1b1d20, rough: 0.3, metal: 0.3, clearcoat: 0.6 },
      glass: { body: 0x020203, tint: 0xe8eeff, env: 1.2 },
      seams: true,
      lights: { lit: 0.95, warm: 0.12 },
    },
    {
      id: 'scifi:pearl',
      era: 'scifi',
      name: 'Pearlescent panels',
      family: 'pale-cool',
      wall: { kind: 'solid', color: 0xbabdc1, rough: 0.24, metal: 0.15, clearcoat: 0.5, iridescence: 0.45 },
      trim: TITANIUM,
      band: { kind: 'solid', color: 0xbabdc1, rough: 0.24, metal: 0.15, clearcoat: 0.5, iridescence: 0.45 },
      glass: { body: 0x060403, tint: 0xfff0e0, env: 1.2 },
      lights: { lit: 0.8, warm: 0.4 },
    },
  ],
};

const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];

// ---------------------------------------------------------------- the picker

/** A small deterministic RNG seeded from a string (FNV-1a into mulberry32). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The repo's own order of preference for an era's variants: a shuffle seeded by its full name. */
export function preference(repo: string, era: Era): Variant[] {
  const list = [...VARIANTS[era]];
  const r = rng(`${repo}|${era}`);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** A repo's look on its own, with no neighbours to steer clear of: its first choice in every era. */
export function lookFor(repo: string): Look {
  return Object.fromEntries(ERAS.map((era) => [era, preference(repo, era)[0]])) as Look;
}

export interface LookSite {
  repo: string;
  slot: number;
}

function block(slot: number): { x: number; z: number } {
  const o = districtOrigin(slot);
  return { x: Math.round(o.x / DISTRICT_PITCH), z: Math.round(o.z / DISTRICT_PITCH) };
}

/**
 * Every district's look. Districts choose in slot order (a slot is a repo's
 * for good, and new repos take new slots), so a tower's look depends only on
 * its own name and the towers placed before it, and a repo that joins later
 * never changes an older tower. Neighbours are the eight blocks round a
 * district. In each era a district ranks the variants by, in turn:
 * 1. how many neighbours have taken that variant (fewest first);
 * 2. how many neighbours have taken its family, light and hue together;
 * 3. how many towers anywhere in the city already use it, so a variant is
 *    not repeated across the city while another stands unused;
 * 4. its own order of preference, from its name.
 * Pass every repo that holds a slot, connected or not, so a tower keeps its
 * look while a neighbour is switched off.
 */
export function pickLooks(sites: LookSite[]): Map<string, Look> {
  const order = [...sites].sort((a, b) => a.slot - b.slot || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const placed: Array<{ at: { x: number; z: number }; look: Look }> = [];
  const out = new Map<string, Look>();
  for (const s of order) {
    if (out.has(s.repo)) continue;
    const at = block(s.slot);
    const near = placed.filter((p) => Math.max(Math.abs(p.at.x - at.x), Math.abs(p.at.z - at.z)) === 1).map((p) => p.look);
    const look = {} as Look;
    for (const era of ERAS) {
      const rank = (v: Variant, i: number): number[] => [
        near.filter((l) => l[era].id === v.id).length,
        near.filter((l) => l[era].family === v.family).length,
        placed.filter((p) => p.look[era].id === v.id).length,
        i,
      ];
      const ranked = preference(s.repo, era).map((v, i) => ({ v, r: rank(v, i) }));
      ranked.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3]);
      look[era] = ranked[0].v;
    }
    placed.push({ at, look });
    out.set(s.repo, look);
  }
  return out;
}

/** A short stable key for a look, for cache keys. */
export function lookKey(look: Look): string {
  return ERAS.map((e) => look[e].id).join(',');
}
