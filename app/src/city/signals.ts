/**
 * The street grid's traffic signals (Phase 5 Task 4): one cycle per
 * junction, read by everything that uses the streets, so the ambient cars
 * (ambient.ts), the persona cabs (vehicles.ts), the crowd and the persona
 * walkers (people.ts) all see the same lights at the same moment.
 *
 * A junction runs x green, x amber, all red, z green, z amber, all red, on
 * a cycle of SIGNAL's lengths. Its place in the cycle is a pure function of
 * where it stands: a green wave along x (80 m a block at 10 m/s), so traffic
 * moves in platoons, and a little play per junction from a hash of its
 * position, so no two corners change at once. Which junctions carry signals
 * is the ambient roads' to say (where two streets with traffic cross);
 * Signals is that list with the clock the lights run on.
 *
 * Pure, so it is tested in Node.
 */

export type Axis = 'x' | 'z';
/** What a junction's light says to traffic moving along an axis: go on green or amber, stop on red. */
export type Light = 'go' | 'stop';

/** Seconds of green along x and along z, of amber after each, and of all red between. */
export const SIGNAL = { gx: 22, gz: 20, amber: 3, allRed: 2 } as const;
/** One whole cycle. */
export const SIGNAL_CYCLE = SIGNAL.gx + SIGNAL.gz + 2 * (SIGNAL.amber + SIGNAL.allRed);

export interface SignalJunction {
  readonly x: number;
  readonly z: number;
  /** Seconds this junction's cycle runs ahead of the clock. */
  readonly offset: number;
}

/** A hash of a junction's position to 0..1, the same on every load. */
function play(x: number, z: number): number {
  let h = Math.imul(Math.round(x * 4) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 4) ^ 0xc2b2ae35, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** The junction at (x, z) as the signals run it: the green wave along x and its own play. */
export function signalJunction(x: number, z: number): SignalJunction {
  return { x, z, offset: -x / 10 - z / 25 + (play(x, z) - 0.5) * 3 };
}

export interface SignalPhase {
  /** The axis whose green or amber shows, or null in the all red. */
  green: Axis | null;
  amber: boolean;
  /** Seconds left in this state. */
  left: number;
}

/** A junction's state at time t (into `out` when given, so a step allocates nothing). */
export function signalPhase(j: SignalJunction, t: number, out: SignalPhase = { green: null, amber: false, left: 0 }): SignalPhase {
  const set = (green: Axis | null, amber: boolean, left: number): SignalPhase => {
    out.green = green;
    out.amber = amber;
    out.left = left;
    return out;
  };
  const C = SIGNAL_CYCLE;
  let u = (((t + j.offset) % C) + C) % C;
  if (u < SIGNAL.gx) return set('x', false, SIGNAL.gx - u);
  u -= SIGNAL.gx;
  if (u < SIGNAL.amber) return set('x', true, SIGNAL.amber - u);
  u -= SIGNAL.amber;
  if (u < SIGNAL.allRed) return set(null, false, SIGNAL.allRed - u);
  u -= SIGNAL.allRed;
  if (u < SIGNAL.gz) return set('z', false, SIGNAL.gz - u);
  u -= SIGNAL.gz;
  if (u < SIGNAL.amber) return set('z', true, SIGNAL.amber - u);
  return set(null, false, Math.max(0, SIGNAL.allRed - (u - SIGNAL.amber)));
}

const SCRATCH: SignalPhase = { green: null, amber: false, left: 0 };

/** What the light says at time t to traffic moving along `axis`: go on its green or amber, stop otherwise. */
export function signalAt(j: SignalJunction, t: number, axis: Axis): Light {
  return signalPhase(j, t, SCRATCH).green === axis ? 'go' : 'stop';
}

/** Seconds from t until `axis` next shows green (0 while it shows green now, not amber). */
export function greenIn(j: SignalJunction, t: number, axis: Axis): number {
  const C = SIGNAL_CYCLE;
  const u = (((t + j.offset) % C) + C) % C;
  const start = axis === 'x' ? 0 : SIGNAL.gx + SIGNAL.amber + SIGNAL.allRed;
  const len = axis === 'x' ? SIGNAL.gx : SIGNAL.gz;
  const into = (((u - start) % C) + C) % C;
  return into < len ? 0 : C - into;
}

/** Seconds of green (not amber) left for `axis` at t: 0 when it is not green. */
export function greenLeft(j: SignalJunction, t: number, axis: Axis): number {
  const s = signalPhase(j, t, SCRATCH);
  return s.green === axis && !s.amber ? s.left : 0;
}

/** The junctions that carry signals, found by position, and the clock their lights run on. */
export interface Signals {
  at(x: number, z: number): SignalJunction | null;
  list(): readonly SignalJunction[];
  /** The time the lights read now. */
  now(): number;
}

const key = (x: number, z: number): string => `${Math.round(x * 100)},${Math.round(z * 100)}`;

/** Signals over a list of junctions, with the clock they run on. */
export function signalsOf(junctions: readonly SignalJunction[], now: () => number): Signals {
  const by = new Map(junctions.map((j) => [key(j.x, j.z), j]));
  return {
    at: (x, z) => by.get(key(x, z)) ?? null,
    list: () => junctions,
    now,
  };
}
