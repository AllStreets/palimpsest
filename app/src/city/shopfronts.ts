import type { Archetype, Face, Hood } from './lots.js';

/**
 * The ground storey of every ambient building, planned as shopfronts: how
 * wide its bays are, what each bay is (a lit shop, a cafe, an office lobby,
 * or shut for the night behind a shutter or dark glass), which bays hang an
 * awning over the pavement, and the joinery and sign scheme the whole front
 * is painted in. The plan is decided here, in one place, by the building's
 * type and its district, and goes to the facade shader packed in one
 * instance attribute (packShopfront; the shader decodes the same bits), so
 * what the awnings are hung on in geometry and what the glass shows are the
 * same bays.
 *
 * Only a face that meets a street is a shopping front; a back face is
 * mostly shut. The district shows: residential streets carry cafes and
 * grocers under awnings, the core and the spine open as lobbies and the odd
 * shop in metal frames, the industrial edge is mostly shuttered.
 */

export type ShopKind = 'shop' | 'cafe' | 'lobby' | 'shut';

/** The kinds in the order their two-bit codes name them. */
export const SHOP_KINDS: readonly ShopKind[] = ['shop', 'cafe', 'lobby', 'shut'];

/** Bays per face the pack holds (two bits each in a 24-bit channel); the kinds repeat past it on a very long face. */
export const SHOP_SLOTS = 12;

export interface ShopfrontPlan {
  /** The bay width in metres, to the centimetre. */
  bay: number;
  /** The district (HOODS index), which picks the signs' names. */
  hood: number;
  /** The joinery and sign scheme (PALETTES). */
  palette: number;
  /** 0: shops; 1: one tenant's lobby across the front. */
  frontage: 0 | 1;
  /** One kind per bay along the faces that look along x (as wide as the lot is deep), and along z (as wide as the lot). */
  x: ShopKind[];
  z: ShopKind[];
  awningsX: boolean[];
  awningsZ: boolean[];
}

/** The districts in the order the pack and the sign atlas number them. */
export const HOODS: readonly Hood[] = ['core', 'spine', 'midtown', 'residential', 'industrial'];

/** The kinds that carry a name, in the atlas's order. */
export const NAMED_KINDS: readonly ShopKind[] = ['shop', 'cafe', 'lobby'];

/** Names per sign set in the atlas. */
export const NAMES_PER_SET = 6;

/**
 * The shop names, by district, kind and age: the older set is for the brick
 * and stone fronts (walk-ups, offices), the modern set for the mid-century,
 * glass and concrete ones. Streets and firms of the city's own (the tram's
 * stops, the sample repos) rather than stock trade names.
 */
export const SHOP_NAMES: Record<Hood, Record<'shop' | 'cafe' | 'lobby', [string[], string[]]>> = {
  residential: {
    shop: [
      ['Corrigan & Sons Grocers', "Hale's Hardware", 'The Launderette', 'Pennywell Florist', 'Marchbank Pharmacy', 'Ivy Lane Fishmonger'],
      ['Wick Street Market', 'Orbit Launderette', 'Fairlie Pharmacy', "Pell's Greengrocer", 'Tallow Pet Supplies', 'Saddlers Newsagent'],
    ],
    cafe: [
      ['The Copper Kettle', "Dunmore's Bakery", 'Cafe Lisboa', 'The Malt House', "Rosa's Kitchen", 'Hatters Tea Rooms'],
      ['Bellfounders Coffee', 'Noon & Night', 'Kiln Lane Bakery', 'Cafe Furnace', 'The Pewter Cup', 'Limekiln Diner'],
    ],
    lobby: [
      ['Weavers Hill Surgery', 'Glovers Walk Library', 'Tanners Bank Credit Union', 'Saddlers Gate Hall', 'Rope Street Baths', 'Malt House Institute'],
      ['Cordwainers Dental', 'Slate Street Clinic', 'Barrow Lane Nursery', 'Kiln Lane Housing', 'Pewter Row Pharmacy', 'Ink Street Studios'],
    ],
  },
  midtown: {
    shop: [
      ['Ink Street Books', 'J. Pell Tailor', 'Chandlery Records', 'Hatters & Co', 'Paper Mill Stationers', 'Rope Street Outfitters'],
      ['Vane Optics', 'Meridian Records', 'Saddlers Gate Cycles', 'Tinsmiths Kitchenware', 'Wharf Road Frames', 'Hop Garden Wines'],
    ],
    cafe: [
      ['The Printers Arms', 'Cafe Marchetti', 'Coopers Row Bar', "Fenwick's Chophouse", 'The Tallow Candle', 'Oyster Rooms'],
      ['Ramen Kiln', 'Bar Lantern', 'Tidewater Oyster Bar', 'Kestrel Coffee', 'Furnace Yard Pizza', 'Saddlers Bistro'],
    ],
    lobby: [
      ['Chandlery Chambers', 'Ink Street Assurance', 'Wharf Road Exchange', 'Hatters Hall', 'Paper Mill Court', 'Cordwainers House'],
      ['Meridian House', 'Vane Pods Ticket Hall', 'Lantern Studios', 'Kestrel Media', 'Harbor Ledger Press', 'Fieldnotes'],
    ],
  },
  spine: {
    shop: [
      ['Barrow & Vale Jewellers', 'Pewter Row Pharmacy', 'Slate Street Books', 'Ferro Ironmongers', 'Alder Prints', 'Quarry Opticians'],
      ['Hoshi Electronics', 'Kumo Design Store', 'Tidewater Travel', 'Alder Camera', 'Lodestar Phones', 'Blank Slate Supply'],
    ],
    cafe: [
      ['Cafe Lantern', 'The Assay Office', 'Bellfounders Grill', 'Hotel Meridian Bar', 'Cafe Quarry', 'The Spine Tavern'],
      ['Espresso Hoshi', 'Pod Line Coffee', 'Kumo Noodle Bar', 'Lodestar Lounge', 'Alder Juice', 'Fieldnotes Cafe'],
    ],
    lobby: [
      ['Assay Kit Chambers', 'Meridian Assurance', 'Tidewater Trust', 'Ferro & Quarry', 'Lantern Building', 'Alder Exchange'],
      ['Harbor Ledger', 'Kumo Tower', 'Fieldnotes', 'Blank Slate', 'Lodestar Capital', 'Vane Systems'],
    ],
  },
  core: {
    shop: [
      ['Meridian Bank', 'Tidewater Savings', 'Assay Jewellers', 'Lantern Bookshop', 'Quarry & Co', 'Ferro Tobacconist'],
      ['Hoshi Flagship', 'Kumo Store', 'Alder Apothecary', 'Lodestar Travel', 'Exchange Newsstand', 'Pod Line Store'],
    ],
    cafe: [
      ['The Exchange Grill', 'Cafe Meridian', 'Assay Oyster Bar', 'Lantern Tea Rooms', 'Ferro Brasserie', 'Quarry Wine Bar'],
      ['Kumo Espresso', 'Fieldnotes Coffee', 'Tidewater Bar', 'Alder Kitchen', 'Lodestar Sushi', 'Vane Cafe'],
    ],
    lobby: [
      ['Meridian Assurance', 'Tidewater Trust Building', 'Exchange Chambers', 'Lantern House', 'Assay House', 'Quarry Court'],
      ['Harbor Ledger', 'Kumo', 'Fieldnotes', 'Blank Slate', 'Lodestar', 'Vane'],
    ],
  },
  industrial: {
    shop: [
      ['Hale Tool & Die', 'Wick Street Motors', 'Furnace Yard Salvage', 'Tanners Bank Timber', 'Kiln Lane Plumbing', 'Barrow Lane Tyres'],
      ['Limekiln Hire', 'Paper Mill Packaging', 'Rope Street Auto Parts', 'Tinsmiths Fabrication', 'Wharf Road Storage', 'Malt House Scaffold'],
    ],
    cafe: [
      ['Dockers Cafe', 'The Furnace Arms', 'Mill Canteen', 'Wharf Cafe', 'The Tanners Rest', 'Kiln Cafe'],
      ['Yard Coffee', 'Depot Diner', 'Limekiln Grill', 'Rope St Snacks', 'Tinsmiths Cafe', 'Night Shift Cafe'],
    ],
    lobby: [
      ['Wick Street Works', 'Furnace Yard Depot', 'Tanners Bank Freight', 'Limekiln Goods Office', 'Malt House Bonded Store', 'Paper Mill Gate'],
      ['Harbor Ledger Logistics', 'Kiln Lane Data Hall', 'Wharf Road Studios', 'Barrow Lane Depot', 'Tinsmiths Workshop', 'Rope Street Yard'],
    ],
  },
};

/** The atlas row of a name: by district, kind, age set and index, as facade.ts's shader computes it. */
export function signRow(hood: number, kind: ShopKind, old: boolean, n: number): number {
  const k = Math.max(0, NAMED_KINDS.indexOf(kind));
  return ((hood * NAMED_KINDS.length + k) * 2 + (old ? 0 : 1)) * NAMES_PER_SET + (n % NAMES_PER_SET);
}

/** Every name in atlas row order (signRow), for the atlas to draw. */
export function signRows(): string[] {
  const rows: string[] = [];
  for (const h of HOODS) for (const k of NAMED_KINDS) for (const set of [0, 1] as const) rows.push(...SHOP_NAMES[h][k as 'shop' | 'cafe' | 'lobby'][set]);
  return rows;
}

/** The awning: how far it reaches over the pavement, its drop over that reach, and the valance hanging from its edge. */
export const AWNING = { reach: 1.35, drop: 0.42, valance: 0.22 } as const;
/** A striped cloth carries this added to its red, which the awning material reads as the flag (grid.ts). */
export const STRIPED = 2;

/** Whole bays, as near the type's own width as the face allows. */
export function shopBays(faceW: number, bay: number): number {
  return Math.max(1, Math.floor(faceW / bay + 0.5));
}

/**
 * Joinery and sign schemes, as linear colours: the painted or metal frame
 * and fascia, the lit sign box, and the awning cloth. Warm painted timber
 * for the residential streets, dark metals for the core.
 */
export const PALETTES: ReadonlyArray<{ name: string; joinery: [number, number, number]; sign: [number, number, number]; cloth: [number, number, number]; striped?: boolean }> = [
  { name: 'bottle green', joinery: [0.02, 0.07, 0.05], sign: [1.0, 0.93, 0.78], cloth: [0.05, 0.14, 0.09], striped: true },
  { name: 'burgundy', joinery: [0.14, 0.03, 0.03], sign: [1.0, 0.9, 0.72], cloth: [0.22, 0.05, 0.05], striped: true },
  { name: 'navy', joinery: [0.02, 0.04, 0.1], sign: [0.95, 0.95, 0.92], cloth: [0.05, 0.08, 0.18] },
  { name: 'cream', joinery: [0.55, 0.47, 0.34], sign: [0.75, 0.9, 1.0], cloth: [0.5, 0.42, 0.3] },
  { name: 'black', joinery: [0.015, 0.015, 0.016], sign: [1.0, 0.96, 0.9], cloth: [0.07, 0.07, 0.075] },
  { name: 'ochre', joinery: [0.42, 0.26, 0.07], sign: [1.0, 0.88, 0.62], cloth: [0.45, 0.28, 0.08] },
  { name: 'bronze', joinery: [0.16, 0.1, 0.05], sign: [1.0, 0.95, 0.85], cloth: [0.12, 0.08, 0.05] },
  { name: 'teal', joinery: [0.02, 0.12, 0.13], sign: [1.0, 0.92, 0.75], cloth: [0.05, 0.17, 0.18], striped: true },
  { name: 'oxblood', joinery: [0.2, 0.05, 0.04], sign: [0.98, 0.98, 0.95], cloth: [0.24, 0.06, 0.05] },
  { name: 'slate', joinery: [0.06, 0.07, 0.08], sign: [0.8, 0.9, 1.0], cloth: [0.11, 0.12, 0.14] },
  { name: 'rust', joinery: [0.3, 0.1, 0.04], sign: [1.0, 0.9, 0.7], cloth: [0.34, 0.12, 0.05] },
  { name: 'white', joinery: [0.6, 0.6, 0.57], sign: [1.0, 0.94, 0.82], cloth: [0.62, 0.6, 0.55] },
  { name: 'graphite', joinery: [0.025, 0.027, 0.03], sign: [0.85, 0.93, 1.0], cloth: [0.08, 0.085, 0.09] },
  { name: 'olive', joinery: [0.12, 0.13, 0.05], sign: [1.0, 0.92, 0.74], cloth: [0.16, 0.17, 0.07], striped: true },
  { name: 'plum', joinery: [0.09, 0.03, 0.08], sign: [1.0, 0.95, 0.88], cloth: [0.14, 0.05, 0.12] },
  { name: 'brick red', joinery: [0.3, 0.08, 0.05], sign: [1.0, 0.9, 0.72], cloth: [0.36, 0.1, 0.06] },
];

/** The schemes a district draws from, by weight: the index into PALETTES. */
const SCHEMES: Record<Hood, number[]> = {
  residential: [0, 1, 3, 5, 7, 8, 10, 11, 13, 15],
  midtown: [0, 1, 2, 4, 6, 7, 8, 9, 14],
  spine: [2, 4, 6, 9, 12],
  core: [4, 6, 9, 12],
  industrial: [4, 9, 10, 12, 15],
};

/** Each type's bay: the frame between the glass, in metres, and its spread. */
const BAY: Record<Archetype, [number, number]> = {
  walkup: [3.6, 1.6],
  commercial: [5.0, 1.4],
  midcentury: [4.4, 1.6],
  glass: [6.2, 1.3],
  brutalist: [4.6, 1.0],
  parking: [8.2, 0],
  industrial: [5.4, 0],
};

/** How a street front's bays fall by district: the chance of a shop, a cafe, a lobby and a shut front. */
const MIX: Record<Hood, Record<ShopKind, number>> = {
  residential: { shop: 0.38, cafe: 0.32, lobby: 0.06, shut: 0.24 },
  midtown: { shop: 0.46, cafe: 0.24, lobby: 0.14, shut: 0.16 },
  spine: { shop: 0.36, cafe: 0.18, lobby: 0.32, shut: 0.14 },
  core: { shop: 0.3, cafe: 0.16, lobby: 0.4, shut: 0.14 },
  industrial: { shop: 0.26, cafe: 0.14, lobby: 0.04, shut: 0.56 },
};

/** How often a shop or cafe bay hangs an awning, by type; a cafe adds to it. */
const AWNINGS: Record<Archetype, number> = { walkup: 0.5, commercial: 0.3, midcentury: 0.16, glass: 0, brutalist: 0.08, parking: 0, industrial: 0 };

function mulberry(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r: () => number, mix: Record<ShopKind, number>): ShopKind {
  let x = r();
  for (const k of SHOP_KINDS) {
    x -= mix[k];
    if (x < 0) return k;
  }
  return 'shut';
}

export interface ShopfrontSite {
  archetype: Archetype;
  hood: Hood;
  w: number;
  d: number;
  /** The faces that meet a street. */
  front: Face[];
  /** Per building; the same seed gives the same front. */
  seed: number;
}

export function shopfrontPlan(s: ShopfrontSite): ShopfrontPlan {
  const r = mulberry(Math.floor(s.seed * 1e6) ^ 0x51f0);
  const [b0, spread] = BAY[s.archetype];
  const bay = Math.round((b0 + spread * r()) * 100) / 100;
  const schemes = SCHEMES[s.hood];
  const palette = schemes[Math.floor(r() * schemes.length)];
  // One tenant across the front: every curtain wall, and about half the offices and slabs in the core and on the spine.
  const office = s.archetype === 'commercial' || s.archetype === 'midcentury' || s.archetype === 'brutalist';
  const frontage: 0 | 1 = s.archetype === 'glass' || (office && (s.hood === 'core' || s.hood === 'spine') && r() < 0.5) ? 1 : 0;
  const mix = MIX[s.hood];
  const awn = AWNINGS[s.archetype];
  const face = (faceW: number, street: boolean): { kinds: ShopKind[]; awnings: boolean[] } => {
    const n = Math.min(SHOP_SLOTS, shopBays(faceW, bay));
    const kinds: ShopKind[] = [];
    const awnings: boolean[] = [];
    // A shop often takes two bays: the second bay follows the first's kind.
    let last: ShopKind | null = null;
    for (let i = 0; i < n; i++) {
      let k: ShopKind;
      if (frontage === 1) k = street && n >= 4 && (i === 0 || i === n - 1) && r() < 0.35 ? 'shop' : 'lobby';
      else if (!street) k = r() < 0.75 ? 'shut' : pick(r, mix);
      else k = last && last !== 'lobby' && r() < 0.4 ? last : pick(r, mix);
      kinds.push(k);
      last = k;
      const open = k === 'shop' || k === 'cafe';
      awnings.push(street && open && r() < awn + (k === 'cafe' ? 0.25 : 0));
    }
    return { kinds, awnings };
  };
  const fx = face(s.d, s.front.includes('px') || s.front.includes('nx'));
  const fz = face(s.w, s.front.includes('pz') || s.front.includes('nz'));
  return { bay, hood: HOODS.indexOf(s.hood), palette, frontage, x: fx.kinds, z: fz.kinds, awningsX: fx.awnings, awningsZ: fz.awnings };
}

/**
 * The plan as four whole numbers under 2^24 (exact in a float32 attribute):
 * the x faces' kinds (two bits a bay), the z faces' kinds, the awnings (one
 * bit a bay, the z faces' from bit 12), and the bay width in centimetres
 * plus the palette times 1000 plus the frontage times 16000 plus the
 * district times 32000. facade.ts decodes them the same way.
 */
export function packShopfront(p: ShopfrontPlan): [number, number, number, number] {
  const kinds = (ks: ShopKind[]): number => ks.reduce((acc, k, i) => acc + SHOP_KINDS.indexOf(k) * 4 ** i, 0);
  const bits = (bs: boolean[], from: number): number => bs.reduce((acc, b, i) => acc + (b ? 2 ** (from + i) : 0), 0);
  return [kinds(p.x), kinds(p.z), bits(p.awningsX, 0) + bits(p.awningsZ, SHOP_SLOTS), Math.round(p.bay * 100) + p.palette * 1000 + p.frontage * 16000 + p.hood * 32000];
}

/** The shader's reading of a pack, for the tests: the first nx and nz bays of each face. */
export function unpackShopfront(v: [number, number, number, number], nx: number, nz: number): Omit<ShopfrontPlan, never> {
  const kinds = (c: number, n: number): ShopKind[] => Array.from({ length: n }, (_, i) => SHOP_KINDS[Math.floor(c / 4 ** i) % 4]);
  const bits = (c: number, from: number, n: number): boolean[] => Array.from({ length: n }, (_, i) => Math.floor(c / 2 ** (from + i)) % 2 === 1);
  const w = v[3];
  return {
    hood: Math.floor(w / 32000),
    frontage: Math.floor((w % 32000) / 16000) as 0 | 1,
    palette: Math.floor((w % 16000) / 1000),
    bay: (w % 1000) / 100,
    x: kinds(v[0], nx),
    z: kinds(v[1], nz),
    awningsX: bits(v[2], 0, nx),
    awningsZ: bits(v[2], SHOP_SLOTS, nz),
  };
}
