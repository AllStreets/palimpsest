/**
 * The city's frame budget, view by view: where the triangles and draw calls
 * go (by subsystem and by pass, through the debug handle's breakdown()), the
 * frame rate, and a still of each view for comparing looks before and after
 * a performance change (SSIM, with ffmpeg).
 *
 * Starts its own engine in-process on PERF_PORT (4791 by default; the real
 * engine's 4770 and the dev server's 4771 are refused) with a temp data home
 * (never the real data home), seeds the sample city and the sample economy
 * at a fixed date so two runs build the same city, and opens the built UI in
 * Chromium on the GPU at PERF_VIEWPORT, his main display's visible frame.
 *
 *   npm run build
 *   PERF_TIERS=high,medium npm run perf <out dir>
 *
 * Phase one, on each tier PERF_TIERS names (high alone by default), measures
 * the city from home (homeBudget, tools/ui-test.ts) and shoots and measures
 * each named view on the settled economy: its frame rate (viewFps) and its
 * calls and triangles with the shadow map redrawn. PERF_ONLY=home,street
 * keeps to those views. The people views (people-follow, people-close,
 * face-close, people-platform, people-seated) are staged first, as
 * tools/capture.ts stages them: the people's and the vehicles' clocks held
 * while the figure is put where the shot wants it, and held through the
 * still and its frame rate (the pose frozen costs the same to draw).
 * The transit views (junction-signal, tram-home, viaduct-corner) are staged
 * the same way: a persona cab waited for at a red light, a tram moved on to
 * where home sees its line, a train sought on the viaduct's curve. The close
 * views (Task 5: ferry-wake, train-windscreen, lod-400, ride-car) stage a
 * ferry under way, a train standing at its station, a tram crossing 400 m
 * (three frames half a second apart, lod-400-a/b/c.png) and the lift car
 * twenty metres up a tower, seen from the ride's own camera.
 * Phase two (unless PERF_STATIC) turns the economy's
 * job sites live (four sites) on high and measures the city from home, the
 * overview and the quarters with them, with the quality governor running.
 * Writes <out>/<view>.png (high) and <out>/<view>-medium.png, <out>/perf.json
 * ({ viewport, tiers: { high: { home, views }, medium } }), <out>/live.json
 * for phase two, and prints a table.
 */
import './seeded-uuid.js';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';
import { frameStats } from '../app/src/city/governor.js';
import { podVariant } from '../app/src/city/vehicles.js';
import { around, apart, callDebug, followView, person, runUntil, sendPerson, tramFromHome } from './people-stage.js';
import { decodePng } from './png.js';
import { seedSample, sampleGh } from './sample.js';
import { homeBudget } from './ui-test.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** The perf tool's port when PERF_PORT is unset: the city track's. */
export const PERF_PORT_DEFAULT = 4791;
const RESERVED = new Set([4770, 4771]);

/** PERF_PORT when set (the screens track's own perf run takes another), 4791 otherwise; never 4770 or 4771. */
export function perfPort(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return PERF_PORT_DEFAULT;
  if (!/^\d+$/.test(text)) throw new Error(`PERF_PORT must be a port number, not ${JSON.stringify(raw)}`);
  const port = Number(text);
  if (port < 1024 || port > 65535) throw new Error(`PERF_PORT must be between 1024 and 65535, not ${port}`);
  if (RESERVED.has(port)) throw new Error(`PERF_PORT ${port} is the real engine's or the dev server's port; pick another`);
  return port;
}

export type Tier = 'high' | 'medium';

/** The tiers PERF_TIERS names, high before medium, each once; high alone when unset. */
export function perfTiers(raw: string | undefined): Tier[] {
  const names = (raw ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (names.length === 0) return ['high'];
  for (const n of names) if (n !== 'high' && n !== 'medium') throw new Error(`PERF_TIERS names high and medium, not ${JSON.stringify(n)}`);
  return (['high', 'medium'] as const).filter((t) => names.includes(t));
}

/**
 * The window every view is measured at (Phase 5 ruling 4): his main display's
 * visible frame below the menu bar and above the Dock, as a maximized window
 * fills it, read once with NSScreen.mainScreen.visibleFrame (1512 by 890 on
 * the 1512 by 982 built-in display, "UI looks like"), at its backing scale 2.
 */
export const PERF_VIEWPORT = { width: 1512, height: 890, dpr: 2 } as const;
/** The sample's fixed date: every run seeds the same history, so the same windows are lit. */
const SEED_AT = Date.parse('2026-11-10T17:30:00Z');
const BEARING = { x: 0.63, z: 0.78 };

type V3 = [number, number, number];
type Tally = { calls: number; triangles: number };
type Breakdown = Record<string, Partial<Record<'main' | 'shadow' | 'ao' | 'post', Tally>>>;
interface Dbg {
  ready: boolean;
  view(e: number[], t: number[]): void;
  precompile(): Promise<void>;
  stats(): Tally;
  breakdown(): Promise<Breakdown>;
  limits(): { home: { eye: number[]; target: number[] } };
  liveSites(): unknown[];
  quality(): string;
  frameLog?: { start(): void; stop(): number[] };
}
const dbg = <T>(page: Page, fn: string): Promise<T> => page.evaluate(`(${fn})(window.__palimpsest)`) as Promise<T>;
/** The breakdown, or an empty one on a build that has none (a baseline built from an older commit). */
const breakdownOf = (page: Page, detail: boolean): Promise<Breakdown> => dbg<Breakdown>(page, `(d) => d.breakdown ? d.breakdown(${detail}) : {}`);

/** Frame times in ms over `ms`, through the debug handle's frameLog (or the page's own frames on a build without it). */
async function frameTimes(page: Page, ms: number): Promise<number[]> {
  const logged = await dbg<boolean>(page, '(d) => { if (!d.frameLog) return false; d.frameLog.start(); return true; }');
  if (logged) {
    await page.waitForTimeout(ms);
    return dbg<number[]>(page, '(d) => d.frameLog.stop()');
  }
  return page.evaluate(`new Promise((resolve) => {
    const t = [];
    let last = -1;
    let t0 = -1;
    function tick(now) {
      if (last >= 0) t.push(now - last);
      else t0 = now;
      last = now;
      if (now - t0 < ${ms}) requestAnimationFrame(tick);
      else resolve(t);
    }
    requestAnimationFrame(tick);
  })`) as Promise<number[]>;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The view's frame rate (Phase 5 ruling 3): the median of the frame rates of
 * every frame over 3 s, after a 1 s settle, with the city clock running.
 */
export async function viewFps(page: Page): Promise<number> {
  await page.waitForTimeout(1000);
  return median((await frameTimes(page, 3000)).filter((t) => t > 0).map((t) => 1000 / t));
}

async function views(page: Page): Promise<Array<[string, V3, V3]>> {
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const qs = ((await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[]).filter((q) => q.towers.length > 0);
  const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
  const cx = city.reduce((a, d) => a + d.origin.x, 0) / city.length;
  const cz = city.reduce((a, d) => a + d.origin.z, 0) / city.length;
  const d0 = city.find((d) => d.tower.floors.length > 0) ?? city[0];
  const top = layoutTower(d0.tower).top;
  const quick = qs.find((q) => q.firmId === 'quickset') ?? qs[0];
  const other = qs.find((q) => q !== quick && q.towers.length > 1) ?? qs.find((q) => q !== quick) ?? quick;
  const qx = (quick.origin.x + other.origin.x + city[0].origin.x) / 3;
  const qz = (quick.origin.z + other.origin.z + city[0].origin.z) / 3;
  const lay = layoutTower(d0.tower);
  return [
    ['home', home.eye, home.target],
    ['overview', [cx + BEARING.x * 900, 300, cz + BEARING.z * 900], [cx, 70, cz]],
    ['close-tower', [d0.origin.x + BEARING.x * 120, top * 0.45, d0.origin.z + BEARING.z * 120], [d0.origin.x, top * 0.5, d0.origin.z]],
    ['tower-root', [d0.origin.x + BEARING.x * 75, 6, d0.origin.z + BEARING.z * 75], [d0.origin.x, lay.rootHeight * 0.5, d0.origin.z]],
    ['quarters', [qx + 360, 150, qz + 430], [qx - 10, 30, qz - 30]],
    ['quarter-close', [quick.origin.x + 60, 18, quick.origin.z + 70], [quick.origin.x, 14, quick.origin.z]],
    ['exchange', [30, 12, 82], [0, 24, -6]],
    ['river', [-353, 2.6, 11.5], [-368, -3, 320]],
    // The README's street still (tools/capture.ts, the life views): an eye on the pavement looking up the street.
    ['street', [195.4, 1.62, -145], [207, 1.45, -30]],
    ['skyline-mid', [560, 140, 620], [80, 40, 40]],
    ['horizon', [-120, 60, 520], [-600, 40, -600]],
    // The hero (tools/capture.ts HERO on the sample): low and looking up at the skyline at dusk (ruling 7).
    ['hero', [700, 70, 700], [0, 170, 80]],
    // The street floor (Task 1) on the README street (along z at x = 200, its kerbs at 196 and 204) between the junctions
    // at z = -200 and -120, clear of every plaza, the elevated line and its station: an eye at 1.6 m on the kerb looking up the
    // street, 0.9 m over the gutter, a crossing from its corner, and 60 m over the junction.
    ['street-kerb', [196.3, 1.6, -150], [197.5, 0.9, -74]],
    ['street-gutter-close', [197.3, 0.9, -140], [196.1, 0, -137.2]],
    ['street-junction', [193.5, 1.8, -127], [204, 0.2, -116]],
    ['street-above', [230, 60, -90], [200, 0, -120]],
    // The facades at street level (Task 2). The sample's collar caps and retypes the blocks round its plots, so the
    // lots are read from the standing city (the debug handle's ambientLots): the walk-up on the README street's west
    // side at x 176.45 to 191.95, z -112 to -98.2 (its front at x = 191.95, two oriel bays up it over three storeys):
    // its windows from the ground to the top floor from across the street, its northern oriel close, a ground bay's glass from the
    // pavement; then the cut corners, each from about 30 m: the chamfered office at (112.05, -112.05) and the
    // mid-century slab's quarter round at (351.95, 128).
    ['street-windows', [207.0, 4.5, -108.0], [191.95, 7.2, -104.0]],
    ['oriel-close', [207.5, 4.0, -92.0], [192.4, 9.3, -101.65]],
    ['shop-close', [198.0, 1.6, -108.5], [191.95, 1.9, -110.5]],
    ['corner-chamfer', [140.0, 8.0, -120.0], [112.05, 9.0, -112.05]],
    ['corner-round', [366.0, 5.0, 106.0], [351.95, 8.0, 128.0]],
    // Where the stone bridge's eastern river pier meets the water (Task 4): from a boat's eye a few metres off the
    // east quay, downstream of the bridge, looking at the pier's downstream cutwater at the waterline.
    ['pier-foot', [-338.0, -2.6, 30.0], [-349.5, -5.6, 11.0]],
  ];
}

/** The views of Task 5 that stage a vehicle or the ride; an eye of null leaves the camera where the ride holds it. */
const CLOSE = ['ferry-wake', 'pod-interior', 'train-windscreen', 'lod-400', 'ride-car', 'ride-car-dusk'];

/**
 * The close views (Task 5), yielded one by one with the vehicles' clock
 * held: a ferry under way in mid-river from the stone bridge's parapet
 * behind it (ferry-wake, framed as tools/capture.ts frames it), a train
 * standing at its station from in front of its nose (train-windscreen), a
 * tram 400 m from the eye with the clock running for three frames half a
 * second apart (lod-400, the stills a/b/c beside the measured one), and the
 * lift car twenty metres up the first tower from the ride's own camera
 * (ride-car). A stage that cannot be reached is skipped and said.
 */
async function* closeViews(page: Page, out: string): AsyncGenerator<[string, V3 | null, V3]> {
  type Probe = { id: string; position: number[]; heading: number; speed: number };
  const near = (ps: Probe[], x: number, z: number): Probe => [...ps].sort((a, b) => Math.hypot(a.position[0] - x, a.position[2] - z) - Math.hypot(b.position[0] - x, b.position[2] - z))[0];
  await callDebug(page, 'd.vehicleHold(true)');
  try {
    if (await callDebug<boolean>(page, "d.vehicleSeek([{ kind: 'ferry', near: [-360, 210], radius: 50, moving: 5.5 }], 4000)")) {
      const f = near(await callDebug<Probe[]>(page, "d.vehicleKinds('ferry')"), -360, 210);
      yield ['ferry-wake', around(f.position, f.heading, -70, 8, 9), around(f.position, f.heading, 6, 0, -5)];
    } else console.log('close: no ferry under way in mid-river; ferry-wake is skipped');
    // A pod standing at the station tools/capture.ts shoots its pod-interior from (the platform at (227, 20, 124)
    // looking along to (252, 20, 123)): from the platform's side of the pod, 3.4 m off its door, at a standing eye.
    // The pod in the rust colourway if one can be stood there (the stage picks whichever pod comes next; up to four
    // tries), so the still shows the second colourway against the strip.
    let pod: Probe | null = null;
    for (let k = 0; k < 4; k++) {
      pod = await callDebug<Probe | null>(page, "d.vehicleStage('pod', [252, 122])");
      if (!pod || podVariant(pod.id).seat === 1) break;
      await callDebug(page, 'd.vehicleSkip(40)');
    }
    if (pod) {
      console.log(`close: pod-interior on ${pod.id} (seat colourway ${podVariant(pod.id).seat}, strip ${podVariant(pod.id).strip})`);
      const side = Math.sign(-(227 - pod.position[0]) * Math.sin(pod.heading) + (123.6 - pod.position[2]) * Math.cos(pod.heading)) || 1;
      // Along the platform past its screen frame (which cut the left of the still at 3 m), looking back into the saloon.
      yield ['pod-interior', around(pod.position, pod.heading, 5.0, side * 4.6, pod.position[1] + 1.7), around(pod.position, pod.heading, -0.6, 0, pod.position[1] + 1.1)];
    } else console.log('close: no pod stands at its station; pod-interior is skipped');
    // A train standing at a station: its nose (the lead cab car's front, 16 m and a car's half length ahead of the
    // middle car) from 7 m ahead and a little to its right, at the driver's eye.
    const train = await callDebug<Probe | null>(page, "d.vehicleStage('rail')");
    if (train) {
      const nose = 16 + 7.6;
      yield ['train-windscreen', around(train.position, train.heading, nose + 7.5, 2.6, train.position[1] + 2.4), around(train.position, train.heading, nose - 0.3, 0, train.position[1] + 2.1)];
    } else console.log('close: no train stands at a station; train-windscreen is skipped');
    // A tram under way, the eye 400 m from it (VEHICLE_LOD's middle) and 30 m up, looking along its way; the clock runs
    // for three frames half a second apart while the tram crosses the band, then holds for the measure.
    if (await callDebug<boolean>(page, "d.vehicleSeek([{ kind: 'tram', near: [0, 0], radius: 1500, moving: 3 }], 4000)")) {
      // The moving tram heading furthest from the low sun (sky.ts SUN_DIRECTION, toward -x and +z): the eye looks
      // along its heading, and a tram heading into the sun put the sun's bloom across the frame.
      const trams = (await callDebug<Probe[]>(page, "d.vehicleKinds('tram')")).filter((v) => v.speed > 2);
      const sunward = (v: Probe): number => Math.cos(v.heading) * -0.908 + Math.sin(v.heading) * 0.419;
      const t = trams.sort((a, b) => sunward(a) - sunward(b))[0] ?? near(await callDebug<Probe[]>(page, "d.vehicleKinds('tram')"), 0, 0);
      // Behind the tram along its heading and off its line, 45 m up (a following tram's lamps under the eye flared
      // the whole frame from 30 m), so it runs away from the eye through 400 m.
      const eye = around(t.position, t.heading, -399, 14, t.position[1] + 45);
      const target: V3 = [t.position[0], t.position[1] + 2, t.position[2]];
      await settle(page, eye, target);
      await callDebug(page, 'd.vehicleHold(false)');
      for (const k of ['a', 'b', 'c']) {
        await page.screenshot({ path: join(out, `lod-400-${k}.png`) });
        await page.waitForTimeout(500);
      }
      await callDebug(page, 'd.vehicleHold(true)');
      yield ['lod-400', eye, target];
    } else console.log('close: no tram under way; lod-400 is skipped');
  } finally {
    await callDebug(page, 'd.vehicleHold(false)');
  }
  // The ride: the first district's tower, the car sought to 20 m over the street and held there, the camera the ride's.
  // Twice: from wherever the eye stands (ride-car, the +x face in the sample, the low sun behind the tower), and from
  // off the -z face (ride-car-dusk: the ride takes the face nearest the eye), a face at right angles to the sun with
  // the dusk sky behind the eye, where the car's lamps are the brightest thing in its glass.
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const d0 = city.find((d) => d.tower.floors.length > 3) ?? city[0];
  type Riding = { t: number; length: number; car: number; stops: Array<{ t: number }> };
  for (const [name, from] of [
    ['ride-car', null],
    ['ride-car-dusk', d0 ? ([d0.origin.x + 30, 24, d0.origin.z - 90] as V3) : null],
  ] as Array<[string, V3 | null]>) {
    if (from && d0) await settle(page, from, [d0.origin.x, 20, d0.origin.z]);
    if (d0 && (await callDebug<boolean>(page, `d.ride(${JSON.stringify(d0.repo)})`))) {
      await callDebug(page, 'd.rideHold(true)');
      await page.waitForTimeout(600);
      let r = await callDebug<Riding>(page, 'd.riding()');
      // The car climbs with t: bisect for the moment it stands at 20 m.
      let lo = 0;
      let hi = r.length;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        await callDebug(page, `d.rideSeek(${mid})`);
        await page.waitForTimeout(120);
        r = await callDebug<Riding>(page, 'd.riding()');
        if (r.car < 20) lo = mid;
        else hi = mid;
      }
      console.log(`close: ${name} up ${d0.repo}, the car at ${r.car.toFixed(1)} m (t ${r.t.toFixed(1)} of ${r.length.toFixed(0)} s)`);
      yield [name, null, [0, 0, 0]];
      await callDebug(page, 'd.ride(null)');
      await page.waitForTimeout(1500);
    } else console.log(`close: no tower to ride; ${name} is skipped`);
  }
}

/**
 * The transit views that need a vehicle staged (Task 4), yielded one by one
 * with the clocks held at the moment of each: a persona cab standing at a
 * red light with the traffic queued behind it (junction-signal), a tram
 * running where home sees the tram's line (tram-home, the home framing),
 * and a train on the viaduct's curve (viaduct-corner). A stage that cannot
 * be reached is skipped and said.
 */
async function* transitViews(page: Page, home: { eye: V3; target: V3 }): AsyncGenerator<[string, V3, V3]> {
  type Red = { id: string; position: number[]; heading: number; junction: number[]; behind: number };
  // A persona cab sent on a long drive across the grid; the city runs as it does (nothing held) until it stands at
  // a red with cars behind it, then the cars and the cabs are held for the shot.
  // The evening's full traffic for this one shot, so a queue forms behind the cab (the hour's density again after).
  await callDebug(page, 'd.ambientDensity(1)');
  const sent = [await callDebug<unknown>(page, 'd.vehicleTrip([520, -360], [-440, 280])'), await callDebug<unknown>(page, 'd.vehicleTrip([-200, 520], [600, -440])'), await callDebug<unknown>(page, 'd.vehicleTrip([280, 300], [-520, -200])')];
  console.log(`transit: sent ${JSON.stringify(sent)}`);
  let red: Red | null = null;
  let stood = 0;
  const canWait = await callDebug<boolean>(page, '!!d.cabsAtRed');
  for (let k = 0; k < (canWait ? 720 : 0) && !red; k++) {
    await page.waitForTimeout(500);
    const reds = await callDebug<Red[]>(page, 'd.cabsAtRed ? d.cabsAtRed() : []');
    if (reds.length) stood++;
    red = reds.find((r) => r.behind >= 2) ?? (k > 120 ? (reds.find((r) => r.behind >= 1) ?? null) : null);
  }
  console.log(`transit: ${stood} looks found a persona cab at a red`);
  if (red) {
    await callDebug(page, 'd.vehicleHold(true)');
    await callDebug(page, 'd.ambientHold(true)');
    const p = red.position;
    const h = red.heading;
    // Back along the lane behind the queue and to its kerb side, at a walker's eye, looking up the queue to the cab
    // and the junction beyond it.
    yield ['junction-signal', around(p, h, -15, 5.4, 1.65), around(p, h, 8, 1.2, 1.5)];
    await callDebug(page, 'd.vehicleHold(false)');
    await callDebug(page, 'd.ambientHold(false)');
  } else console.log('transit: no persona cab stood at a red with cars behind; junction-signal is skipped');
  await callDebug(page, 'd.ambientDensity(null)');

  // The tram line from home: a tram moved on to where home's framing sees the line nearest and in frame.
  await callDebug(page, 'd.vehicleHold(true)');
  try {
    await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.view(e, t), [home.eye, home.target]);
    await page.waitForTimeout(300);
    await page.waitForTimeout(1500);
    // The moment home sees a tram best: its lit windows the most pixels they light (tools/people-stage.ts).
    const best = await tramFromHome(page, decodePng, { steps: 60, step: 6, gain: 0.08, floor: 0.42 });
    if (best) {
      console.log(`transit: tram-home ${best.d.toFixed(0)} m off, ${best.lit} pixels lit in its box ${best.box.join(', ')}`);
      yield ['tram-home', home.eye, home.target];
    } else console.log('transit: no tram in the home framing; tram-home is skipped');
  } finally {
    await callDebug(page, 'd.vehicleHold(false)');
  }

  // A train on the viaduct's curve at (760, 760), from over the corner's outside, above the roofs there.
  await callDebug(page, 'd.vehicleHold(true)');
  try {
    const ok = await callDebug<boolean>(page, "d.vehicleSeek([{ kind: 'rail', near: [754, 754], radius: 9, moving: 0.5 }], 4000)");
    if (ok) yield ['viaduct-corner', [805, 50, 805], [751, 11, 751]];
    else console.log('transit: no train on the curve; viaduct-corner is skipped');
  } finally {
    await callDebug(page, 'd.vehicleHold(false)');
  }
}

/**
 * The views that need a figure staged (Task 3), yielded one by one with the
 * clocks held at the moment of each: Dagny twenty seconds into her walk to
 * the tram (the follow camera's framing, a close pass, and her face from
 * 1.8 m), on the platform as the tram comes in, and Bruno seated in the
 * train. A stage that cannot be reached (no figure, no vehicle) is skipped
 * and said.
 */
async function* stagedViews(page: Page): AsyncGenerator<[string, V3, V3]> {
  await callDebug(page, 'd.peopleHold(true)');
  try {
    await sendPerson(page, 'dagny-hollis', [560, -300], [600, 200]);
    await callDebug(page, 'd.peopleSkip(22)');
    const f = await person(page, 'dagny-hollis');
    if (f) {
      yield ['people-follow', ...followView(f)];
      yield ['people-close', around(f.position, f.heading, 2.6, -3.0, f.position[1] + 1.5), around(f.position, f.heading, -5.5, 6.2, f.position[1] + 0.5)];
      // Her face from 1.8 m: a three-quarter view from her front, on the side the low sun comes from (sky.ts
      // SUN_DIRECTION, toward -x and +z), so the sun lights the face and never blooms behind her; the lantern in her
      // right hand is put out for this one (its glass would flare from so close), and lit again after.
      const sunward = Math.sign(-Math.sin(f.heading) * -260 + Math.cos(f.heading) * 120) || 1;
      await callDebug(page, 'd.peopleLantern(false)');
      yield ['face-close', around(f.position, f.heading, 0.95, sunward * 1.5, f.position[1] + 1.68), around(f.position, f.heading, 0.06, 0, f.position[1] + 1.6)];
      await callDebug(page, 'd.peopleLantern(null)');
    } else console.log('people: no figure for Dagny; the follow, close and face views are skipped');
    const w = await runUntil(page, 'dagny-hollis', (x) => x.mode === 'tram' && x.stage === 'wait');
    const t = w ? await runUntil(page, 'dagny-hollis', (x, v) => x.stage !== 'wait' || (!!v && apart(x, v) < 34 && v.speed > 0.5), 1200) : null;
    if (t) yield ['people-platform', around(t.position, t.heading, 11, 2.4, t.position[1] + 2.4), around(t.position, t.heading, -1.5, 0.3, t.position[1] + 1.2)];
    else console.log('people: no figure on the platform; people-platform is skipped');
    await sendPerson(page, 'bruno-kiln', [600, -600], [-600, 600]);
    const r = await runUntil(page, 'bruno-kiln', (x) => x.mode === 'rail' && x.stage === 'ride', 1800, 2);
    if (r) {
      await callDebug(page, 'd.peopleSkip(3)');
      const b = (await person(page, 'bruno-kiln'))!;
      yield ['people-seated', around(b.position, b.heading, 2.4, -1.3, b.position[1] + 1.15), around(b.position, b.heading, -0.1, 0.1, b.position[1] + 0.55)];
    } else console.log('people: no figure seated on the train; people-seated is skipped');
  } finally {
    await callDebug(page, 'd.peopleHold(false)');
  }
}

const sum = (b: Breakdown): Tally => {
  const t = { calls: 0, triangles: 0 };
  for (const p of Object.values(b)) for (const v of Object.values(p)) {
    t.calls += v!.calls;
    t.triangles += v!.triangles;
  }
  return t;
};

function table(name: string, b: Breakdown): string {
  const lines = [`${name}`];
  const passes = ['main', 'shadow', 'ao', 'post'] as const;
  lines.push(`  ${'subsystem'.padEnd(13)}${passes.map((p) => p.padStart(17)).join('')}${'total'.padStart(17)}`);
  const rows = Object.entries(b).sort((x, y) => sum({ a: y[1] }).triangles - sum({ a: x[1] }).triangles);
  const cell = (t?: Tally): string => (t ? `${(t.triangles / 1e6).toFixed(2)}M/${t.calls}` : '-').padStart(17);
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(13)}${passes.map((p) => cell(v[p])).join('')}${cell(sum({ a: v }))}`);
  const per = (p: (typeof passes)[number]): Tally => Object.values(b).reduce((a, v) => ({ calls: a.calls + (v[p]?.calls ?? 0), triangles: a.triangles + (v[p]?.triangles ?? 0) }), { calls: 0, triangles: 0 });
  lines.push(`  ${'all'.padEnd(13)}${passes.map((p) => cell(per(p))).join('')}${cell(sum(b))}`);
  return lines.join('\n');
}

async function settle(page: Page, eye: V3 | null, target: V3): Promise<void> {
  // A null eye leaves the camera where a script holds it (the ride's).
  if (eye) await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.view(e, t), [eye, target]);
  await page.waitForTimeout(600);
  await dbg(page, '(d) => d.precompile()');
  await page.waitForTimeout(1800);
}

type Budget = Awaited<ReturnType<typeof homeBudget>>;
type ViewRow = { fps: number; calls: number; triangles: number };

async function main(): Promise<void> {
  const PORT = perfPort(process.env.PERF_PORT);
  const tiers = perfTiers(process.env.PERF_TIERS);
  const out = resolve(process.argv[2] ?? join(ROOT, 'shots', 'perf'));
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-perf-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  await seedSample(SEED_AT);
  // The treasury and the brief read a transcripts folder. As in the UI test and the capture tool, the run says it is a
  // test so the guard lets it read the sample's own empty folder, pinned inside the temp home before anything reads
  // it, so ~/.claude/projects is never read.
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  const { useSampleFolders } = await import('../engine/sample.js');
  useSampleFolders();
  const projects = process.env.PALIMPSEST_CLAUDE_PROJECTS;
  const inside = projects ? relative(resolve(tmp), resolve(projects)) : '..';
  if (!projects || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`perf: the transcripts folder ${projects ?? '(unset)'} is not inside the temp home ${tmp}; refusing to run`);
  }
  const { seedEconomy } = await import('../engine/market/sample-economy.js');
  await seedEconomy(SEED_AT);
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const result: { viewport: typeof PERF_VIEWPORT; tiers: Partial<Record<Tier, { home: Budget; views: Record<string, ViewRow> }>> } = { viewport: PERF_VIEWPORT, tiers: {} };
  const live: Record<string, { stats: Tally; breakdown: Breakdown; fps: number }> = {};
  const only = process.env.PERF_ONLY?.split(',');
  const setQuality = (quality: Tier): Promise<Response> =>
    fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ quality }),
    });
  try {
    const page = await browser.newPage({ viewport: { width: PERF_VIEWPORT.width, height: PERF_VIEWPORT.height }, deviceScaleFactor: PERF_VIEWPORT.dpr });
    console.log(`viewport ${PERF_VIEWPORT.width}x${PERF_VIEWPORT.height} at DPR ${PERF_VIEWPORT.dpr}, port ${PORT}, tiers ${tiers.join(', ')}`);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const open = async (q: string): Promise<void> => {
      await page.goto(`http://127.0.0.1:${PORT}/?${q}`);
      await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 60_000 });
      // The stills are of the city: no running head, no plates, and not the morning's brief sheet over the left half.
      await page.addStyleTag({ content: '.runhead, .plates, .sheet.brief { display: none !important; }' });
      await page.waitForTimeout(2500);
    };
    for (const tier of tiers) {
      // The tier is Settings' quality, read as the page opens; the governor held still (PERF_GOVERNOR=1 leaves it running).
      await setQuality(tier);
      await open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug');
      const stands = await dbg<string>(page, '(d) => d.quality()');
      if (stands !== tier) throw new Error(`perf: the city opened at ${stands}, not ${tier}`);
      const home = await homeBudget(page, tier);
      const top = Object.entries(home.parts).sort((x, y) => y[1].triangles - x[1].triangles).slice(0, 4);
      console.log(`${tier} home budget, the shadow map redrawn: ${home.calls} calls, ${(home.triangles / 1e6).toFixed(2)}M triangles (${top.map(([k, t]) => `${k} ${(t.triangles / 1e6).toFixed(2)}M/${t.calls}`).join(', ')})`);
      const rows: Record<string, ViewRow> = {};
      const measure = async (name: string, eye: V3 | null, target: V3): Promise<void> => {
        await settle(page, eye, target);
        await page.screenshot({ path: join(out, tier === 'high' ? `${name}.png` : `${name}-${tier}.png`) });
        const breakdown = await breakdownOf(page, !!process.env.PERF_DETAIL);
        const f = await viewFps(page);
        const stats = await dbg<Tally>(page, '(d) => d.stats()');
        const drawn = sum(breakdown);
        rows[name] = { fps: f, calls: drawn.calls, triangles: drawn.triangles };
        console.log(`${tier} ${name}: ${f.toFixed(1)} fps, steady ${stats.calls} calls ${(stats.triangles / 1e6).toFixed(2)}M; with the shadow redrawn ${drawn.calls} calls ${(drawn.triangles / 1e6).toFixed(2)}M`);
        console.log(table(`${tier} ${name}`, breakdown));
      };
      for (const [name, eye, target] of await views(page)) {
        if (only && !only.includes(name)) continue;
        await measure(name, eye, target);
      }
      const TRANSIT = ['junction-signal', 'tram-home', 'viaduct-corner'];
      if (!only || TRANSIT.some((n) => only.includes(n))) {
        const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
        for await (const [name, eye, target] of transitViews(page, home)) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      const PEOPLE = ['people-follow', 'people-close', 'face-close', 'people-platform', 'people-seated'];
      if (!only || PEOPLE.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of stagedViews(page)) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (!only || CLOSE.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of closeViews(page, out)) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      result.tiers[tier] = { home, views: rows };
    }
    if (!process.env.PERF_STATIC) {
      await setQuality('high');
      // Phase two: four live job sites, the governor running.
      const { setMarketExtras } = await import('../engine/market/api.js');
      const { economySites } = await import('../engine/market/sample-economy.js');
      setMarketExtras({ sites: economySites });
      await open('debug');
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().length >= 4, null, { timeout: 15_000 }).catch(() => {});
      const nSites = await dbg<number>(page, '(d) => d.liveSites().length');
      const vs = await views(page);
      for (const [name, eye, target] of vs.filter(([n]) => n === 'home' || n === 'overview' || n === 'quarters')) {
        await settle(page, eye, target);
        await page.screenshot({ path: join(out, `live-${name}.png`) });
        const breakdown = await breakdownOf(page, false);
        const f = await viewFps(page);
        const stats = await dbg<Tally>(page, '(d) => d.stats()');
        live[`live-${name}`] = { stats, breakdown, fps: f };
        console.log(`live ${name} (${nSites} sites): ${f.toFixed(0)} fps, steady ${stats.calls} calls ${(stats.triangles / 1e6).toFixed(2)}M; with the shadow redrawn ${sum(breakdown).calls} calls ${(sum(breakdown).triangles / 1e6).toFixed(2)}M`);
        console.log(table(`live ${name}`, breakdown));
      }
      console.log(`quality after the live views: ${await dbg<string>(page, '(d) => d.quality()')}`);
      // How the frames ran over the live views: the slowest and the mean over a further ten seconds at home.
      await settle(page, vs[0][1], vs[0][2]);
      const frames = await frameTimes(page, 10_000);
      const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
      const slow = frames.filter((f) => f > 1000 / 48).length;
      const hitches = frameStats(frames);
      console.log(`live home frames over 10 s: mean ${mean.toFixed(2)} ms, slowest ${hitches.max.toFixed(1)} ms, p99 ${hitches.p99.toFixed(1)} ms, ${slow} of ${frames.length} over 20.8 ms, ${hitches.over33} over 33 ms`);
      setMarketExtras({});
      writeFileSync(join(out, 'live.json'), JSON.stringify(live, null, 1));
    }
    writeFileSync(join(out, 'perf.json'), JSON.stringify(result, null, 1));
    if (errors.length) console.log(`console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

// Run as a script only: the tests import the port, the tiers and the viewport without starting a run.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
