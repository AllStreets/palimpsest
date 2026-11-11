import { districtOrigin, DISTRICT_PITCH } from '../../../../shared/district-layout.js';
import type { Era } from '../../../../shared/types.js';
import { RENDERED } from './rendered.js';

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
      /** A clear polished skin over the stone (0 to 1) that mirrors the sky: granite, marble. */
      polish?: number;
      /** How much of the scan's own grain shows (0 to 1; 0.8 by default, 1 for granite). */
      detail?: number;
      /**
       * Laid in courses: bed joints every `h` metres and staggered head joints
       * every `l`, each block a little lighter or darker than the next
       * (`vary`), joints darkened by `joint` and `gap` metres wide (12 mm
       * by default; wider for recessed panel seams). Drawn in world space, so the
       * coursing reads on any face and fades evenly into its average with
       * distance instead of shimmering.
       */
      courses?: { h: number; l: number; joint: number; vary: number; gap?: number };
      /**
       * How hard the stone weathers (0 to 1): tonal patches across beds and
       * batches of blocks, rain streaks, and soiling toward the street. The
       * scan's default is 0.22 for cut stone and none for brick or patina.
       */
      weather?: number;
      /**
       * Map the scan by world position at this tile size (metres) in the
       * shader: the coursed kit blocks are instanced, so their own UVs carry
       * nothing. Set only on the `Face` slot's copy of a wall finish.
       */
      worldTile?: number;
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
  /** Sci-fi: light seams set into the core's corners. */
  seams?: boolean;
  /** Sci-fi only: the architectural language its floors are built in (see FAMILIES). */
  family?: Family;
}

/**
 * The sci-fi era's six families: the architectural languages the old masters
 * of screen sci-fi gave their vertical cities, each an original design in
 * that language, never a copy of any film's building. A sci-fi variant is
 * one family with its own materials, so a repo's sci-fi floors are picked,
 * steered from neighbours and kept for good like any other variant.
 * - deco: monumental art deco megatower: a pale cast-stone shaft in dark
 *   bronze fins, stepping back toward an illuminated crown, sky bridges
 *   over the setback terraces.
 * - ziggurat: a megastructure pyramid: sloped basalt faces in a lattice of
 *   lit floors, warm light vents at the terraces.
 * - needle: a slender tapering tower in fine titanium lines, with
 *   observation pods and warning lights, at the floors' own height.
 * - arcology: a brutalist megablock of raw stained concrete, deep recesses,
 *   planted ledges and cantilevered habitation pods.
 * - organic: a biomorphic tower: a smooth swelling ceramic shell under a
 *   swept, ribbed exoskeleton, on a round plan.
 * - cluster: stacked cantilevers: offset carbon boxes climbing a lit core,
 *   their undersides lit.
 */
export const FAMILIES = ['deco', 'ziggurat', 'needle', 'arcology', 'organic', 'cluster'] as const;
export type Family = (typeof FAMILIES)[number];

export type Look = Record<Era, Variant>;

/** The colour a finish reads as, for the palette and contrast checks. */
export function swatch(f: Finish): number {
  return f.seen ?? (f.kind === 'scan' ? f.body : f.color);
}

// ---------------------------------------------------------------- finishes

const scan = (tex: Scan, body: number, rough: number, more: Partial<Extract<Finish, { kind: 'scan' }>> = {}): Finish => ({ kind: 'scan', tex, body, rough, ...more });

// Stone bases sit cool of what they read as, because the low dusk sun warms every sunlit face.
const LIMESTONE = scan('ashlar', 0xadb3b8, 0.5, { normal: 0.8, joint: 0x8b9196 });
const SANDSTONE = scan('sand', 0xaba184, 0.55, { normal: 1.1, joint: 0x786a4d, weather: 0.42, courses: { h: 0.62, l: 1.35, joint: 0.6, vary: 0.3 } });
const MARBLE = scan('ashlar', 0xc8d2de, 0.18, { normal: 0.3, joint: 0x9fa7b3, scale: 1.4, polish: 0.6 });
const DARK_GRANITE = scan('granite', 0x202328, 0.3, { normal: 0.5, joint: 0x141619, scale: 3, polish: 0.2 });
const ROSE_GRANITE = scan('granite', 0x8e6a76, 0.3, { normal: 0.5, joint: 0x5e4450, scale: 3, polish: 0.6 });
// Architectural bronze, brushed and kept polished: a lighter warm metal that takes the sky in its grain.
const BRONZE: Finish = { kind: 'brushed', color: 0x8f6c4a, rough: 0.24, aniso: 0.45, env: 1.9 };
const DARK_BRONZE: Finish = { kind: 'metal', color: 0x4a3324, rough: 0.5 };
const GRAPHITE: Finish = { kind: 'brushed', color: 0x2e3136, rough: 0.42, aniso: 0.4, env: 1.4 };
const TITANIUM: Finish = { kind: 'brushed', color: 0xa9afb7, rough: 0.2, aniso: 0.6, env: 1.5 };
const ALUMINIUM: Finish = { kind: 'metal', color: 0xaab0b5, rough: 0.36 };
const BLACK_STEEL: Finish = { kind: 'metal', color: 0x17181a, rough: 0.34 };
const VERDIGRIS = scan('rust', 0x6f8a7c, 0.5, { joint: 0x51665a, normal: 0.6 });
/** Verdigris as a smooth mineral skin, for curved fins where a scan would wrap into blotches. */
const PATINA: Finish = { kind: 'solid', color: 0x628a86, rough: 0.6, metal: 0.15 };
const TERRACOTTA = scan('brick', 0xd0d8e2, 0.2, { joint: 0x969ca3, normal: 0.55 });
/**
 * Glazed ceramic cladding: a celadon-blue glaze over a grey body, panels
 * 1.2 by 1.8 m with dark recessed seams, under a clear coat that mirrors the
 * sky. The glaze is a blue of real stoneware rather than a white: under the
 * orange dusk key a white surface goes peach, and only a body this far to
 * the blue side lands on a cool grey-blue in the sun and a clear blue in
 * shade, with the dusk sky's violet in its reflections.
 */
const CERAMIC = scan('ashlar', 0x4a78ae, 0.16, { joint: 0x34414f, normal: 0.12, polish: 1.0, detail: 0.15, weather: 0, courses: { h: 1.2, l: 1.8, joint: 0.7, vary: 0.06, gap: 0.045 }, seen: 0x9fb4c8 });
/** Pale cast stone for the deco shaft: cool grey-buff panels in wide courses, lightly weathered. */
const CAST_STONE = scan('ashlar', 0xc3c1b9, 0.6, { joint: 0x8f8d86, normal: 0.6, weather: 0.12, courses: { h: 1.2, l: 2.6, joint: 0.5, vary: 0.05 } });
/** Dark basalt-grey concrete for the ziggurat's sloped faces: board-marked, streaked by rain. */
const BASALT = scan('ashlar', 0x45474a, 0.8, { joint: 0x2e3032, normal: 0.9, weather: 0.3, courses: { h: 2.4, l: 3.6, joint: 0.45, vary: 0.08 } });
/** Raw board-marked concrete for the arcology: pale grey, heavily stained. */
const CONCRETE = scan('ashlar', 0x9c9b95, 0.9, { joint: 0x75746f, normal: 0.9, weather: 0.42, courses: { h: 1.25, l: 3.0, joint: 0.3, vary: 0.06 } });
const DARK_CONCRETE = scan('ashlar', 0x6f6e69, 0.9, { joint: 0x53524e, normal: 0.9, weather: 0.35, courses: { h: 1.25, l: 3.0, joint: 0.3, vary: 0.05 } });
/** Planted ledges: dark foliage, matte. */
const PLANTING: Finish = { kind: 'solid', color: 0x4a5e36, rough: 0.95 };
const CARBON: Finish = { kind: 'solid', color: 0x34383d, rough: 0.26, metal: 0.3, clearcoat: 0.8 };
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
      wall: DARK_GRANITE,
      trim: DARK_GRANITE,
      band: BRONZE,
      glass: { body: 0x080604, tint: 0xffe6c8, env: 1.3 },
      // Small deep openings in a heavy dark wall, a quiet bank or court building with few lights burning late:
      // from afar the stone, not the windows, sets its tone.
      masonry: { winH: 0.42, winW: 1.15 },
      lights: { lit: 0.28, warm: 0.9 },
    },
    {
      id: 'stone:marble',
      era: 'stone',
      name: 'White marble',
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
      wall: scan('sand', 0xa58457, 0.7, { normal: 1.4, joint: 0x7a5f3c, scale: 0.8, courses: { h: 0.9, l: 1.8, joint: 0.6, vary: 0.1 } }),
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
      wall: scan('brick', 0xd8c4b8, 0.55, { keep: true, seen: 0x5a4036 }),
      trim: LIMESTONE,
      band: LIMESTONE,
      glass: CLEAR,
    },
    {
      id: 'brick:cream',
      era: 'brick',
      name: 'Cream city brick',
      // Pale cream, the mortar close to the brick: the low sun already pushes it to gold, so the body stays off yellow.
      wall: scan('brick', 0xd8d2bc, 0.6, { joint: 0xb3ad9a, weather: 0.16 }),
      trim: SANDSTONE,
      band: VERDIGRIS,
      glass: { body: 0x020406, tint: 0xf4f6ff, env: 1.15 },
      masonry: { bay: 3.2 },
    },
    {
      id: 'brick:ironspot',
      era: 'brick',
      name: 'Dark ironspot manganese',
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
      wall: scan('brick', 0xa8735e, 0.6, { joint: 0xbdb3a3 }),
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
      // Ribbon windows: a deep spandrel band at every slab, so the shaft reads in horizontal stripes.
      spandrel: 1.5,
      depth: 0.6,
      lights: { lit: 0.7, warm: 0.35 },
    },
    {
      id: 'glass:bronze',
      era: 'glass',
      name: 'Bronze-tinted curtain wall',
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
      // Pre-weathered zinc: a soft blue-grey metal with a fine mill grain. Drawn as metal so it takes the cool
      // sky rather than only the orange sun, which turned a matte patina into tan slats.
      // Its environment weight is kept low: at this env a fin took the whole orange dusk and read as a lit copper
      // strip from across the city, over glass it hid. The rooms behind the glass carry the floor's light instead.
      wall: { kind: 'brushed', color: 0x7e8a96, rough: 0.52, aniso: 0.2, env: 0.8 },
      trim: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      band: { kind: 'metal', color: 0x4c5257, rough: 0.5 },
      glass: { body: 0x04070a, tint: 0xeef2ff, env: 1.15 },
      // Flat standing-seam panels: close, shallow fins.
      pitch: 1.2,
      depth: 0.45,
      lights: { lit: 0.8, warm: 0.35 },
    },
    {
      id: 'titanium:copper',
      era: 'titanium',
      name: 'Weathered copper',
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
      // Darker and duller than the first cut: at 0xad8762 and env 2.5 the fins took the dusk and read as lit copper
      // strips from across the city; the floor's light now comes from the rooms behind its glass.
      wall: { kind: 'brushed', color: 0x6b5238, rough: 0.4, aniso: 0.5, env: 1.0 },
      trim: GRAPHITE,
      band: GRAPHITE,
      glass: { body: 0x0a0604, tint: 0xffe2c4, env: 1.2 },
      depth: 1.0,
      lights: { lit: 0.7, warm: 0.75 },
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
      lights: { lit: 0.4, warm: 0.5 },
    },
  ],
  scifi: [
    {
      id: 'scifi:deco',
      era: 'scifi',
      name: 'Deco megatower',
      family: 'deco',
      wall: CAST_STONE,
      trim: DARK_BRONZE,
      band: BRONZE,
      glass: { body: 0x060402, tint: 0xffe6c8, env: 1.2 },
      pitch: 1.9,
      lights: { lit: 0.78, warm: 0.8 },
    },
    {
      id: 'scifi:ziggurat',
      era: 'scifi',
      name: 'Megastructure ziggurat',
      family: 'ziggurat',
      wall: BASALT,
      trim: BLACK_STEEL,
      band: DARK_BRONZE,
      glass: { body: 0x050302, tint: 0xffdcae, env: 1.15 },
      pitch: 1.6,
      lights: { lit: 0.9, warm: 0.95 },
    },
    {
      id: 'scifi:needle',
      era: 'scifi',
      name: 'Tapering needle',
      family: 'needle',
      wall: TITANIUM,
      trim: GRAPHITE,
      band: GRAPHITE,
      glass: { body: 0x040608, tint: 0xe4ecff, env: 1.2 },
      pitch: 0.8,
      lights: { lit: 0.6, warm: 0.15 },
    },
    {
      id: 'scifi:arcology',
      era: 'scifi',
      name: 'Brutalist arcology',
      family: 'arcology',
      wall: CONCRETE,
      trim: DARK_CONCRETE,
      band: PLANTING,
      glass: { body: 0x060403, tint: 0xffe2bc, env: 1.1 },
      pitch: 4.6,
      lights: { lit: 0.7, warm: 0.9 },
    },
    {
      id: 'scifi:organic',
      era: 'scifi',
      name: 'Biomorphic ceramic',
      family: 'organic',
      wall: CERAMIC,
      trim: CERAMIC,
      band: TITANIUM,
      glass: { body: 0x020304, tint: 0xe6edfa, env: 1.3 },
      pitch: 1.8,
      lights: { lit: 0.85, warm: 0.3 },
    },
    {
      id: 'scifi:cluster',
      era: 'scifi',
      name: 'Cantilever cluster',
      family: 'cluster',
      wall: CARBON,
      trim: GRAPHITE,
      band: CARBON,
      glass: { body: 0x020203, tint: 0xe8eeff, env: 1.2 },
      pitch: 1.7,
      seams: true,
      lights: { lit: 0.95, warm: 0.3 },
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

/** CIE76 distance between two Lab colours. */
function dE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * How far apart two variants read from across the city: the mean CIE Lab
 * distance of their sunlit and their shaded faces as the scene actually
 * renders them at the overview's distance (rendered.ts, measured through
 * the real light, haze and tone mapping), not as their albedos are
 * declared. The haze compresses every difference about threefold there.
 */
export function renderedDistance(a: Variant, b: Variant): number {
  const ra = RENDERED[a.id];
  const rb = RENDERED[b.id];
  if (!ra || !rb) return a.id === b.id ? 0 : Infinity;
  const high = (dE(ra.sun, rb.sun) + dE(ra.shade, rb.shade)) / 2;
  // Measured again where short towers stand, low over the street, where the street-level darkening and the
  // thicker haze close the gap: the nearer of the two is what counts.
  const low = ra.sunLow && rb.sunLow && ra.shadeLow && rb.shadeLow ? (dE(ra.sunLow, rb.sunLow) + dE(ra.shadeLow, rb.shadeLow)) / 2 : high;
  return Math.min(high, low);
}

/** Neighbours count as reading apart from across the city at this rendered distance or more. */
export const SEPARATION = 6;

/**
 * The distance the picker prefers when it can have it: SEPARATION with a
 * margin, so the next measurement (another GPU, a light change) moving a
 * colour a couple of units does not drop neighbours under SEPARATION.
 */
export const PREFERRED = 9;

/**
 * Every district's look. Districts choose in slot order (a slot is a repo's
 * for good, and new repos take new slots), so a tower's look depends only on
 * its own name and the towers placed before it, and a repo that joins later
 * never changes an older tower. Neighbours are the eight blocks round a
 * district. Eras are chosen bottom to top, and in each a district ranks the
 * variants by, in turn:
 * 1. how many neighbours have taken that variant;
 * 2. how far short of SEPARATION it renders from its neighbours, summed;
 * 3. whether it renders within SEPARATION of its own tower's era below, so
 *    the floors still read as laid in different times;
 * 4. how far short of PREFERRED it renders from them (the margin);
 * 5. how many towers anywhere in the city already use it;
 * 6. its own order of preference, from its name.
 * The sci-fi era is the exception: its variants are architectural families
 * (FAMILIES), told apart by their massing before their colour, so it ranks
 * by 1, then how many towers anywhere already use the family, then 6, so a
 * city of six towers shows six families. Pass every repo that holds a slot,
 * connected or not, so a tower keeps its look while a neighbour is off.
 * The colours come from rendered.ts, which is versioned data: see there.
 */
export function pickLooks(sites: LookSite[]): Map<string, Look> {
  const order = [...sites].sort((a, b) => a.slot - b.slot || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const placed: Array<{ at: { x: number; z: number }; look: Look }> = [];
  const out = new Map<string, Look>();
  const byRank = (a: number[], b: number[]): number => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
    return 0;
  };
  for (const s of order) {
    if (out.has(s.repo)) continue;
    const at = block(s.slot);
    const near = placed.filter((p) => Math.max(Math.abs(p.at.x - at.x), Math.abs(p.at.z - at.z)) === 1).map((p) => p.look);
    const look = {} as Look;
    let below: Variant | null = null;
    for (const era of ERAS) {
      // How far short of `d` a variant falls against each neighbour, summed: zero when it clears them all, and
      // otherwise smaller for the variant that is least alike, so a crowded corner still takes the best it has.
      const short = (v: Variant, d: number): number => near.reduce((sum, l) => sum + Math.max(0, d - renderedDistance(l[era], v)), 0);
      const rank = (v: Variant, i: number): number[] => [
        near.filter((l) => l[era].id === v.id).length,
        Math.round(short(v, SEPARATION) * 10),
        below && renderedDistance(below, v) < SEPARATION ? 1 : 0,
        Math.round(short(v, PREFERRED) * 10),
        placed.filter((p) => p.look[era].id === v.id).length,
        i,
      ];
      const familyRank = (v: Variant, i: number): number[] => [near.filter((l) => l[era].id === v.id).length, placed.filter((p) => p.look[era].id === v.id).length, i];
      const ranked = preference(s.repo, era).map((v, i) => ({ v, r: era === 'scifi' ? familyRank(v, i) : rank(v, i) }));
      ranked.sort((a, b) => byRank(a.r, b.r));
      look[era] = ranked[0].v;
      below = look[era];
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
