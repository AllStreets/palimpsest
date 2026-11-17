/**
 * The river's floor and what stands on it (Phase 5 Task 4), pure so it is
 * tested in Node and read by people.ts without the river's drawing: the
 * water's surface, the riverbed under it, which bridge stands where, the
 * stone bridge's piers, each ferry pier's pontoon and its guide piles, and
 * every foot that stands in the river. river.ts builds from these.
 */
import { BANKS, BRIDGE_DECK, BRIDGES, PIER_HALF, PIERS, RIVER, type Pier } from '../../../shared/commute.js';

/** The water's surface, metres below the quays. */
export const WATER_Y = -6.2;
/**
 * The riverbed, under the water: the quay walls' footings, the bridges'
 * piers and abutments and the ferry piers' guide piles all stand on it.
 */
export const RIVER_BED = -9;

export type BridgeKind = 'arch' | 'stone' | 'stayed';
/** Which bridge stands where (z): the steel tied arch upstream, the stone arch on the civic axis, the cable-stayed deck downstream. */
export const BRIDGE_KINDS: Record<number, BridgeKind> = { [BRIDGES[0]]: 'arch', [BRIDGES[1]]: 'stone', [BRIDGES[2]]: 'stayed' };

/** The stone bridge's two river piers: their centres across the river and their width. */
export const STONE_PIERS = { x: [RIVER.x - 10.5, RIVER.x + 10.5], width: 3 } as const;

/** A ferry pier's pontoon (ferryPier): its centre, its deck's height, its half extents, and the guide piles at its outer edge. */
export function pontoonOf(p: Pier): { x: number; z: number; deck: number; half: { x: number; z: number }; piles: Array<{ x: number; z: number }>; out: number } {
  const s = p.bank === 'west' ? 1 : -1;
  const sw = 2.0;
  const landZ = p.z + 1.2 + 34 * 0.3 + 1.5;
  const gx0 = p.x + s * (sw + 0.4);
  const pw = 7;
  const x = gx0 + s * (3.2 + pw / 2);
  const z = landZ - 3;
  const pile = x + s * (pw / 2 + 0.55);
  return { x, z, deck: WATER_Y + 0.85 + 0.08, half: { x: pw / 2, z: PIER_HALF }, piles: [-PIER_HALF + 3, PIER_HALF - 3].map((dz) => ({ x: pile, z: z + dz })), out: s };
}

/**
 * Every foot that stands in the river: the stone bridge's piers and
 * cutwaters, the abutments' shelves under the steel arch and the stayed
 * deck, and each ferry pier's guide piles, with the height each stands on.
 */
export function riverFeet(): Array<{ what: string; x: number; z: number; y: number }> {
  const out: Array<{ what: string; x: number; z: number; y: number }> = [];
  for (const bz of BRIDGES) {
    const kind = BRIDGE_KINDS[bz];
    if (kind === 'stone') for (const x of STONE_PIERS.x) for (const face of [-1, 1]) out.push({ what: 'stone pier', x, z: bz + face * (BRIDGE_DECK / 2), y: RIVER_BED });
    if (kind === 'arch') for (const s of [-1, 1]) out.push({ what: 'arch abutment', x: (s < 0 ? BANKS.west : BANKS.east) - s * 1.4, z: bz, y: RIVER_BED });
    if (kind === 'stayed') out.push({ what: 'stayed shelf', x: BANKS.west - 1.2, z: bz, y: RIVER_BED });
  }
  for (const p of PIERS) for (const q of pontoonOf(p).piles) out.push({ what: 'guide pile', x: q.x, z: q.z, y: RIVER_BED });
  return out;
}

