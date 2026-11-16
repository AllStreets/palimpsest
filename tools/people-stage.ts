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

/**
 * The tram from home (Phase 5 Task 4): the vehicles' clock held, moved on
 * `step` seconds at a time over `steps` looks, and at each the frame shot
 * with the vehicles and without them; within each tram's projected box
 * the pixels the tram lights (brighter by `gain`, over `floor`, short of a flare's white). The
 * clock is left at the look where a tram lit the most, and that look's
 * count, distance and box are returned (null when no tram stood in frame).
 */
export async function tramFromHome(page: Page, decode: (png: Buffer) => { width: number; height: number; data: Uint8Array }, o: { steps: number; step: number; gain: number; floor: number }): Promise<{ lit: number; d: number; box: [number, number, number, number]; at: number } | null> {
  const lum = (im: { width: number; data: Uint8Array }, x: number, y: number): number => {
    const i = (y * im.width + x) * 4;
    return (0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2]) / 255;
  };
  const eye = await callDebug<number[]>(page, 'd.camera()');
  let best: { lit: number; d: number; box: [number, number, number, number]; at: number } | null = null;
  for (let k = 0; k < o.steps; k++) {
    await callDebug(page, `d.vehicleSkip(${o.step})`);
    await page.waitForTimeout(250);
    const trams = await callDebug<Array<{ position: number[]; heading: number }>>(page, "d.vehicleKinds('tram')");
    const boxes: Array<{ box: [number, number, number, number]; d: number }> = [];
    const img = decode(await page.screenshot());
    for (const t of trams) {
      const ends: number[][] = [];
      for (const s of [-15, 15]) {
        const p = [t.position[0] + Math.cos(t.heading) * s, t.position[1] + 1.6, t.position[2] + Math.sin(t.heading) * s];
        const q = await callDebug<number[]>(page, `d.project([${p.join(', ')}])`);
        if (q[2] > 1) continue;
        ends.push([((q[0] + 1) / 2) * img.width, ((1 - q[1]) / 2) * img.height]);
      }
      if (ends.length < 2) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ends[0][0], ends[1][0])) - 4);
      const x1 = Math.min(img.width - 1, Math.ceil(Math.max(ends[0][0], ends[1][0])) + 4);
      const y0 = Math.max(0, Math.floor(Math.min(ends[0][1], ends[1][1])) - 6);
      const y1 = Math.min(img.height - 1, Math.ceil(Math.max(ends[0][1], ends[1][1])) + 6);
      if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 40000) continue;
      boxes.push({ box: [x0, y0, x1, y1], d: Math.hypot(t.position[0] - eye[0], t.position[2] - eye[2]) });
    }
    if (!boxes.length) continue;
    await callDebug(page, 'd.vehicleShow(false)');
    await page.waitForTimeout(250);
    const bare = decode(await page.screenshot());
    await callDebug(page, 'd.vehicleShow(true)');
    for (const b of boxes) {
      let lit = 0;
      // The tram's own light and paint: brighter for the tram by `gain` and over `floor`, short of white (a bloom's
      // core or a lamp flare clips; a lit window under the threshold does not).
      for (let y = b.box[1]; y <= b.box[3]; y++) {
        for (let x = b.box[0]; x <= b.box[2]; x++) {
          const l = lum(img, x, y);
          if (l - lum(bare, x, y) > o.gain && l > o.floor && l < 0.93) lit++;
        }
      }
      if (!best || lit > best.lit) best = { lit, d: b.d, box: b.box, at: k };
    }
  }
  if (best) await callDebug(page, `d.vehicleSkip(${-o.step * (o.steps - 1 - best.at)})`);
  return best;
}
