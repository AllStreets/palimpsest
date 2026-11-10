/**
 * How tall the ambient city may build near a plaza. Pure, so it is tested
 * in Node.
 *
 * Around a district the ambient blocks stay under its root, roofs and all,
 * out to ROOT_RING: from any street or any wide shot the root's architecture
 * is the tallest thing on its block and reads. Past the ring the skyline
 * rises again with distance. The civic plaza at the origin, and an analyzing
 * site that has no root yet, keep the gentler collar: low at the plaza's
 * edge and rising out to COLLAR_REACH. A firm's quarter keeps the blocks
 * just outside its court under its agents' roots, rising past COURT_RING.
 */

/** Ambient buildings keep this far from a district origin or the civic plaza. */
export const RESERVE_RADIUS = 90;
/** At the civic plaza's edge buildings top out at COLLAR_BASE metres, gaining COLLAR_RISE metres per metre out to COLLAR_REACH. */
export const COLLAR_BASE = 26;
export const COLLAR_RISE = 0.45;
export const COLLAR_REACH = 320;
/** Out to this distance from a district's origin, ambient buildings stay below its root. */
export const ROOT_RING = 200;
/** Round a quarter's court the ambient blocks stay below its agents' roots this far past the court's edge. */
export const COURT_RING = 40;
/**
 * Ambient buildings keep this far outside a quarter's court: the blocks round
 * it stand close, so the court reads as a room in the city, not a clearing.
 */
export const COURT_APRON = 4;
/** The most a roof carries above its parapet line: a water tank on its stand, or a rooftop plant room. */
export const ROOF_CLUTTER = 7.6;
/** Storey height of the ambient city, and the ground-floor extra over it. */
const FLOOR = 3.6;
const PLINTH = 1.2;

export interface CollarPlaza {
  x: number;
  z: number;
  /** A district's root height. Absent for the civic plaza and for an analyzing site. */
  rootHeight?: number;
  /**
   * A district's tower colours as the scene renders them (CIE Lab of its
   * stone and brick floors): ambient lots at its edge keep clear of them.
   */
  tones?: Array<[number, number, number]>;
  /** The L* of the tower's stone floors over the root: ambient lots at its edge stand a value step from it. */
  value?: number;
  /**
   * A firm's quarter: a square paved court this many metres from its centre
   * to its edge, in place of a district's round plaza. `rootHeight` is then
   * its agents' lowest root.
   */
  court?: number;
  /** A quarter's standing plots, a bit per tower index (bit i is QUARTER_OFFSETS[i]). */
  towers?: number;
  /** A bankrupt firm's quarter: its court's floodlights are off. */
  dark?: boolean;
}

/**
 * True when a lot `w` by `d` centred at (x, z) stands on ground the plaza
 * keeps clear: within RESERVE_RADIUS of a round plaza's centre, or within
 * COURT_APRON of a quarter's court.
 */
export function reserves(p: CollarPlaza, x: number, z: number, w: number, d: number): boolean {
  const dx = Math.max(Math.abs(p.x - x) - w / 2, 0);
  const dz = Math.max(Math.abs(p.z - z) - d / 2, 0);
  if (p.court !== undefined) return Math.max(dx, dz) < p.court + COURT_APRON;
  return dx * dx + dz * dz < RESERVE_RADIUS * RESERVE_RADIUS;
}

/** The tallest an ambient building at (x, z) may stand, before rooftop clutter. Infinity when nothing limits it. */
export function ambientCap(x: number, z: number, plazas: CollarPlaza[]): number {
  let cap = Infinity;
  for (const p of plazas) {
    const gap = Math.hypot(x - p.x, z - p.z);
    let c: number;
    if (p.rootHeight !== undefined) {
      const low = p.rootHeight - ROOF_CLUTTER - 0.2;
      const ring = p.court !== undefined ? p.court + COURT_RING : ROOT_RING;
      c = gap < ring ? low : low + (gap - ring) * COLLAR_RISE;
    } else {
      c = gap < COLLAR_REACH ? COLLAR_BASE + Math.max(0, gap - RESERVE_RADIUS) * COLLAR_RISE : Infinity;
    }
    cap = Math.min(cap, c);
  }
  return cap;
}

/** A lot's height cut to whole storeys under `cap` (never fewer than two), or left as it is when it already fits. */
export function cappedHeight(h: number, cap: number): number {
  if (h <= cap) return h;
  return Math.max(2, Math.floor((cap - PLINTH) / FLOOR)) * FLOOR + PLINTH;
}
