/**
 * Staging the personas (people.ts) through the debug handle, for the UI
 * test and the captures: send a figure on a trip, run the people's and the
 * vehicles' clocks on together until the figure is where a shot wants it,
 * and frame it as the follow camera would.
 */
import type { Page } from 'playwright';

export type V3 = [number, number, number];

export interface FigureProbe {
  agentId: string;
  name: string;
  tripId: string | null;
  live: boolean;
  leg: number;
  mode: string | null;
  stage: 'walk' | 'wait' | 'board' | 'ride' | 'alight' | 'idle';
  position: V3;
  heading: number;
  walking: number;
  sit: number;
  lit: number;
  ride: { mode: string; id: string; phase: string } | null;
}

export interface VehicleProbe {
  id: string;
  kind: string;
  position: number[];
  heading: number;
  speed: number;
  floorY: number;
  phase: string;
}

export const callDebug = <T>(page: Page, js: string): Promise<T> => page.evaluate(`(function (d) { return ${js}; })(window.__palimpsest)`) as Promise<T>;

/** A point `fwd` ahead and `right` to the right of p facing h, at height y. */
export const around = (p: ArrayLike<number>, h: number, fwd: number, right: number, y: number): V3 => [p[0] + Math.cos(h) * fwd - Math.sin(h) * right, y, p[2] + Math.sin(h) * fwd + Math.cos(h) * right];

/** Sends an agent's figure on a trip (the synthetic kind: routed over the network, ridden like a real one). */
export const sendPerson = (page: Page, agentId: string, from: [number, number], to: [number, number]): Promise<string | null> =>
  callDebug<string | null>(page, `d.peopleTrip(${JSON.stringify(agentId)}, ${JSON.stringify(from)}, ${JSON.stringify(to)})`);

export const person = (page: Page, agentId: string): Promise<FigureProbe | null> => callDebug<FigureProbe | null>(page, `d.person(${JSON.stringify(agentId)})`);

export const vehicle = (page: Page, id: string): Promise<VehicleProbe | null> => callDebug<VehicleProbe | null>(page, `d.vehicle(${JSON.stringify(id)})`);

/**
 * Moves the held clocks on `step` seconds at a time until `until` holds for
 * the figure (or `maxSeconds` have passed): the figure as it then stands.
 */
export async function runUntil(page: Page, agentId: string, until: (f: FigureProbe, v: VehicleProbe | null) => boolean, maxSeconds = 900, step = 1): Promise<FigureProbe | null> {
  for (let t = 0; t <= maxSeconds; t += step) {
    const f = await person(page, agentId);
    if (!f) return null;
    const v = f.ride ? await vehicle(page, f.ride.id) : null;
    if (until(f, v)) return f;
    await callDebug(page, `d.peopleSkip(${step})`);
  }
  return person(page, agentId);
}

/** The follow camera's framing of a figure: 12 m behind and above, looking a little ahead of it. */
export function followView(f: FigureProbe): [V3, V3] {
  return [around(f.position, f.heading, -10.4, 0, f.position[1] + 6), around(f.position, f.heading, 2.5, 0, f.position[1] + 1.4)];
}

/** How far a figure stands from a vehicle, in plan. */
export const apart = (f: FigureProbe, v: VehicleProbe | null): number => (v ? Math.hypot(f.position[0] - v.position[0], f.position[2] - v.position[2]) : Infinity);
