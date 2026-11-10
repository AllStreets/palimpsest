/**
 * The commute's fixed geography. Pure, shared by the engine (routing, Task
 * 30) and the city (river.ts draws exactly what the engine routes on).
 *
 * This task lands the river only (ruling 14): a straight river 56 m wide
 * running north and south on the street line at x = -360, between district
 * block columns -1 and -2. The district spiral is unchanged: districts stand
 * on multiples of 240 m, so the nearest origins are 120 m from the river's
 * centre and a district's 90 m reserve clears each bank by 2 m.
 */

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
