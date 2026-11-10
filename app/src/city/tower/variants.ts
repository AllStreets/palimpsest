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

/** The scanned sets a masonry finish can start from (app/public/textures, see CREDITS.md). */
export type Scan = 'brick' | 'ironspot' | 'sand' | 'rust';

/**
 * A surface. Colours are sRGB hex. `seen` is roughly how the surface reads
 * in daylight, for the palette and contrast checks; it defaults to `body`
 * or `color`.
 */
export type Finish =
  | {
      /**
       * A scanned masonry or patina set. With `keep` the scan's own colour
       * shows under a `body` tint; otherwise the scan's light and dark parts
       * (mortar and brick, say) are recoloured to `joint` and `body`, keeping
       * its texture and its brick-to-brick variation.
       */
      kind: 'scan';
      tex: Scan;
      body: number;
      joint?: number;
      keep?: boolean;
      rough: number;
      normal?: number;
      seen?: number;
    }
  /** Cast or rolled metal under the scanned plate's normal and roughness. */
  | { kind: 'metal'; color: number; rough: number; seen?: number }
  /** Brushed metal with anisotropic highlights (the aniso-patch path). */
  | { kind: 'brushed'; color: number; rough: number; aniso: number; env: number; seen?: number }
  /** A smooth made surface: glazed faience, ceramic, carbon, pearl. */
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

export interface Variant {
  id: string;
  era: Era;
  name: string;
  /** The main surface: masonry wall, curtain-wall spandrel, titanium fins, sci-fi exoskeleton. */
  wall: Finish;
  /** The second surface: sills, lintels and quoins; mullions; slab edges; sci-fi slab fascias. */
  trim: Finish;
  /** The accent the variant picks up: belt courses, cornices, caps and the crown. */
  band: Finish;
  glass: Glazing;
  /** Masonry eras only. */
  masonry?: Partial<MasonryRhythm>;
  /** Glass and titanium eras: the mullion or fin pitch, metres. */
  pitch?: number;
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

const LIMESTONE = scan('sand', 0xbfb8a8, 1, { normal: 0.8, joint: 0xaaa392 });
const SANDSTONE = scan('sand', 0xc2ad84, 1, { normal: 0.9, joint: 0xab9872 });
const MARBLE = scan('sand', 0xdad8d2, 0.3, { normal: 0.3, joint: 0xc8c6c0 });
const DARK_GRANITE = scan('sand', 0x46484a, 0.42, { normal: 0.55, joint: 0x353739 });
const BRONZE: Finish = { kind: 'metal', color: 0x6b4a2e, rough: 0.42 };
const DARK_BRONZE: Finish = { kind: 'metal', color: 0x4a3324, rough: 0.5 };
const GRAPHITE: Finish = { kind: 'brushed', color: 0x2e3136, rough: 0.42, aniso: 0.4, env: 1.4 };
const TITANIUM: Finish = { kind: 'brushed', color: 0xa9afb7, rough: 0.13, aniso: 0.6, env: 2.2 };
const ALUMINIUM: Finish = { kind: 'metal', color: 0xaab0b5, rough: 0.36 };
const BLACK_STEEL: Finish = { kind: 'metal', color: 0x17181a, rough: 0.34 };
const VERDIGRIS = scan('rust', 0x6f8a7c, 0.78, { joint: 0x51665a, normal: 0.6 });
const TERRACOTTA = scan('brick', 0xd2cdc2, 0.34, { joint: 0x9c968c, normal: 0.55 });
const FAIENCE: Finish = { kind: 'solid', color: 0x5c7466, rough: 0.28, env: 1.3 };

/** Punched windows in masonry: dark glass, rooms seen as they are. */
const CLEAR: Glazing = { body: 0x000000, tint: 0xffffff, env: 1.15 };

// ---------------------------------------------------------------- the table

export const VARIANTS: Record<Era, Variant[]> = {
  stone: [
    { id: 'stone:limestone', era: 'stone', name: 'Indiana limestone', wall: LIMESTONE, trim: LIMESTONE, band: LIMESTONE, glass: CLEAR },
    { id: 'stone:sandstone', era: 'stone', name: 'Pale sandstone', wall: SANDSTONE, trim: SANDSTONE, band: SANDSTONE, glass: CLEAR },
    {
      id: 'stone:pink-granite',
      era: 'stone',
      name: 'Pink granite',
      wall: scan('sand', 0x968884, 0.3, { normal: 0.45, joint: 0x7d706c }),
      trim: scan('sand', 0xa49692, 0.28, { normal: 0.4, joint: 0x8c7f7b }),
      band: DARK_GRANITE,
      glass: { body: 0x050302, tint: 0xfff0e2, env: 1.2 },
      masonry: { bay: 3.0, winW: 1.3 },
    },
    {
      id: 'stone:dark-granite',
      era: 'stone',
      name: 'Dark grey granite',
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
      wall: scan('sand', 0xd2cfc8, 0.32, { normal: 0.35, joint: 0xbebbb4 }),
      trim: MARBLE,
      band: MARBLE,
      glass: { body: 0x020406, tint: 0xeef4ff, env: 1.2 },
      masonry: { winH: 0.62, winW: 1.4 },
    },
    {
      id: 'stone:travertine',
      era: 'stone',
      name: 'Rusticated travertine',
      wall: scan('sand', 0x9a8f7b, 0.92, { normal: 1.4, joint: 0x837a68 }),
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
      wall: scan('brick', 0xd8c4b8, 1, { keep: true, seen: 0x5a4036 }),
      trim: LIMESTONE,
      band: LIMESTONE,
      glass: CLEAR,
    },
    {
      id: 'brick:cream',
      era: 'brick',
      name: 'Cream city brick',
      wall: scan('brick', 0xc6bea6, 1, { joint: 0xa9a496 }),
      trim: SANDSTONE,
      band: VERDIGRIS,
      glass: { body: 0x020406, tint: 0xf4f6ff, env: 1.15 },
      masonry: { bay: 3.2 },
    },
    {
      id: 'brick:ironspot',
      era: 'brick',
      name: 'Dark ironspot manganese',
      wall: scan('ironspot', 0xd6cec8, 1, { keep: true, seen: 0x453929 }),
      trim: DARK_GRANITE,
      band: BRONZE,
      glass: { body: 0x060403, tint: 0xffe8cc, env: 1.2 },
      masonry: { bay: 2.3, winW: 1.0, winH: 0.66 },
    },
    {
      id: 'brick:terracotta',
      era: 'brick',
      name: 'Glazed white terracotta',
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
      wall: scan('brick', 0x34463c, 0.32, { joint: 0x4c5a52, normal: 0.6 }),
      trim: FAIENCE,
      band: BRONZE,
      glass: { body: 0x040605, tint: 0xfff0dc, env: 1.2 },
      masonry: { bay: 2.6, winW: 1.15, winH: 0.64 },
    },
    {
      id: 'brick:salmon',
      era: 'brick',
      name: 'Salmon brick',
      wall: scan('brick', 0xa47e6c, 1, { joint: 0xbdb3a3 }),
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
      wall: { kind: 'solid', color: 0x2f3d38, rough: 0.45, metal: 0.4 },
      trim: { kind: 'metal', color: 0x8d9590, rough: 0.4 },
      band: { kind: 'metal', color: 0x8d9590, rough: 0.4 },
      glass: { body: 0x0e1f19, tint: 0xd4e6dc, env: 1.25 },
    },
    {
      id: 'glass:bronze',
      era: 'glass',
      name: 'Bronze-tinted curtain wall',
      wall: { kind: 'metal', color: 0x3b2c22, rough: 0.45 },
      trim: BRONZE,
      band: BRONZE,
      glass: { body: 0x1a120a, tint: 0xffdcb8, env: 1.35 },
    },
    {
      id: 'glass:blue',
      era: 'glass',
      name: 'Cool blue curtain wall',
      wall: { kind: 'solid', color: 0x2c3644, rough: 0.4, metal: 0.4 },
      trim: ALUMINIUM,
      band: ALUMINIUM,
      glass: { body: 0x0a1220, tint: 0xd2ddff, env: 1.3 },
      pitch: 1.8,
    },
    {
      id: 'glass:black',
      era: 'glass',
      name: 'Clear glass, black mullions',
      wall: BLACK_STEEL,
      trim: BLACK_STEEL,
      band: BLACK_STEEL,
      glass: { body: 0x000000, tint: 0xffffff, env: 1.0 },
      pitch: 1.4,
    },
    {
      id: 'glass:channel',
      era: 'glass',
      name: 'Ribbed channel glass',
      wall: { kind: 'metal', color: 0x9a9fa3, rough: 0.5 },
      trim: ALUMINIUM,
      band: ALUMINIUM,
      glass: { body: 0x6f7477, tint: 0xfff2e2, env: 0.7, channel: true },
      pitch: 2.4,
    },
  ],
  titanium: [
    { id: 'titanium:titanium', era: 'titanium', name: 'Brushed titanium', wall: TITANIUM, trim: GRAPHITE, band: GRAPHITE, glass: { body: 0x050608, tint: 0xe6eeff, env: 1.15 } },
    {
      id: 'titanium:zinc',
      era: 'titanium',
      name: 'Pre-weathered zinc',
      // Pre-weathered zinc wears a matte carbonate patina, a mineral layer rather than bare metal.
      wall: { kind: 'solid', color: 0x7a838a, rough: 0.58, metal: 0.25 },
      trim: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      band: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      glass: { body: 0x04070a, tint: 0xeef2ff, env: 1.15 },
      pitch: 1.6,
    },
    {
      id: 'titanium:copper',
      era: 'titanium',
      name: 'Weathered copper',
      wall: VERDIGRIS,
      trim: DARK_BRONZE,
      band: DARK_BRONZE,
      glass: { body: 0x070504, tint: 0xfff0dc, env: 1.15 },
      pitch: 2.4,
    },
    {
      id: 'titanium:bronze',
      era: 'titanium',
      name: 'Bronze cladding',
      wall: { kind: 'brushed', color: 0x58402e, rough: 0.34, aniso: 0.5, env: 1.4 },
      trim: GRAPHITE,
      band: GRAPHITE,
      glass: { body: 0x0a0604, tint: 0xffe2c4, env: 1.2 },
    },
    {
      id: 'titanium:black',
      era: 'titanium',
      name: 'Black anodised aluminium',
      wall: { kind: 'brushed', color: 0x1f2023, rough: 0.28, aniso: 0.4, env: 1.6 },
      trim: BRONZE,
      band: BRONZE,
      glass: { body: 0x020202, tint: 0xfff4e8, env: 1.15 },
      pitch: 1.7,
    },
  ],
  scifi: [
    { id: 'scifi:graphite', era: 'scifi', name: 'Graphite and titanium', wall: GRAPHITE, trim: TITANIUM, band: TITANIUM, glass: CLEAR },
    {
      id: 'scifi:ceramic',
      era: 'scifi',
      name: 'White ceramic',
      wall: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      trim: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      band: { kind: 'solid', color: 0xd8d4ca, rough: 0.36, clearcoat: 0.3 },
      glass: { body: 0x020304, tint: 0xf4f6fa, env: 1.2 },
    },
    {
      id: 'scifi:carbon',
      era: 'scifi',
      name: 'Dark carbon with light seams',
      wall: { kind: 'solid', color: 0x1b1d20, rough: 0.3, metal: 0.3, clearcoat: 0.6 },
      trim: GRAPHITE,
      band: { kind: 'solid', color: 0x1b1d20, rough: 0.3, metal: 0.3, clearcoat: 0.6 },
      glass: { body: 0x020203, tint: 0xe8eeff, env: 1.2 },
      seams: true,
    },
    {
      id: 'scifi:pearl',
      era: 'scifi',
      name: 'Pearlescent panels',
      wall: { kind: 'solid', color: 0xbabdc1, rough: 0.24, metal: 0.15, clearcoat: 0.5, iridescence: 0.45 },
      trim: TITANIUM,
      band: { kind: 'solid', color: 0xbabdc1, rough: 0.24, metal: 0.15, clearcoat: 0.5, iridescence: 0.45 },
      glass: { body: 0x060403, tint: 0xfff0e0, env: 1.2 },
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
function preference(repo: string, era: Era): Variant[] {
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
 * its own name and its earlier neighbours', and a repo that joins later never
 * changes an older tower. In each era a district takes the first variant in
 * its own preference that no adjacent block (the eight round it) has taken;
 * failing that, the one fewest adjacent blocks share, then fewest two blocks
 * out. Pass every repo that holds a slot, connected or not, so a tower keeps
 * its look while a neighbour is switched off.
 */
export function pickLooks(sites: LookSite[]): Map<string, Look> {
  const order = [...sites].sort((a, b) => a.slot - b.slot || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const placed: Array<{ at: { x: number; z: number }; look: Look }> = [];
  const out = new Map<string, Look>();
  for (const s of order) {
    if (out.has(s.repo)) continue;
    const at = block(s.slot);
    const ring = (n: number): Look[] => placed.filter((p) => Math.max(Math.abs(p.at.x - at.x), Math.abs(p.at.z - at.z)) === n).map((p) => p.look);
    const near = ring(1);
    const far = ring(2);
    const look = {} as Look;
    for (const era of ERAS) {
      let best: Variant | null = null;
      let bestScore = Infinity;
      for (const v of preference(s.repo, era)) {
        const score = near.filter((l) => l[era].id === v.id).length * 100 + far.filter((l) => l[era].id === v.id).length;
        if (score < bestScore) {
          best = v;
          bestScore = score;
        }
      }
      look[era] = best!;
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
