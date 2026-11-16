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
 * twenty metres up a tower, seen from the ride's own camera. The haze views
 * (Task 6: sun-low, ride-dossier-view, overview-clear, and sun-glow in
 * views(), the sun's band low in the frame) hold the week tour at
 * its poster moment, the ride at its first dossier stop, and thin the haze
 * to CLEAR_HAZE of the home value through the debug handle's haze(k); the six
 * look-<repo> views frame each sample tower whole for Decision 6's sheet.
 * The lens views (Task 11: ride-top, tour-stop, inspector-close, under
 * PERF_ONLY) hold the ride at its roof, the tour into a stop's dwell and the
 * inspector's close tower view, each with the depth of field on as its mode
 * holds it; people-follow holds the lens as following would.
 * Phase two (unless PERF_STATIC) turns the economy's
 * job sites live (four sites) on high and measures the city from home, the
 * overview and the quarters with them, with the quality governor running.
 * Writes <out>/<view>.png (high) and <out>/<view>-medium.png, <out>/perf.json
 * ({ viewport, tiers: { high: { home, views }, medium } }), <out>/live.json
 * for phase two, and prints a table. PERF_CULL_AB=1 also shoots each view
 * with the batches' cluster culling off and on (Task 12) into cull-off/ and
 * cull-on/ (cull-on-again/ the floor; -bare/ without the trees); `npm run
 * perf compare <a> <b>` prints the SSIM of every still
 * two folders share (ffmpeg). PERF_BARE=1 also shoots each still with the
 * traffic held and the trees hidden into <out>/bare (ruling 7's compare).
 * PERF_FIRST_FRAME=5 last times five cold loads, navigation to the first
 * city frame with its towers (Task 14), into <out>/first-frame.json;
 * PERF_ONLY=first-frame stops there.
 */
import './seeded-uuid.js';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { QUARTER_OFFSETS } from '../shared/district-layout.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { District, Era, Quarter, Repo, SiteState, TowerSpec } from '../shared/types.js';
import { frameStats } from '../app/src/city/governor.js';
import { podVariant } from '../app/src/city/vehicles.js';
import { around, apart, callDebug, followView, person, runUntil, sendPerson, tramFromHome } from './people-stage.js';
import { decodePng } from './png.js';
import { seedSample, sampleGh } from './sample.js';
import { firstFrameMs, homeBudget, textureViews } from './ui-test.js';

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

/**
 * Why the page does not stand on the city for a still, or null when it
 * does: a route drawn over it, or a sheet's scrim open. The day's first
 * open goes to the brief (main.ts), and its scrim darkens the whole frame
 * from 0.7 at the left to 0.18 at the right even with the sheet itself
 * hidden: every high still before the brightness debug was shot through it.
 */
export function cityStands(o: { hash: string; openScrims: number }): string | null {
  if (o.hash !== '' && o.hash !== '#' && o.hash !== '#/') return `the page stands on ${o.hash}, not the city`;
  if (o.openScrims > 0) return `${o.openScrims} scrim${o.openScrims === 1 ? '' : 's'} open over the city`;
  return null;
}

/**
 * Opens today's brief on perf's engine before its first page, as the UI
 * test does: the day's first open is then spent, so every page, the first
 * included, opens on the city and not on the brief over it.
 */
export async function openTodaysBrief(port: number, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/api/brief/open`, { method: 'POST', headers: { 'x-palimpsest': '1' } });
  if (!res.ok) throw new Error(`perf: opening today's brief answered ${res.status}`);
}

/** The first page opened on the engine and a second are the same light: their mean luma within 3%. */
export const SAME_LIGHT = 0.03;
export function sameLight(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_LIGHT * Math.max(a, b);
}

/** Mean Rec. 709 luma of a screenshot, 0 to 255. */
function meanLuma(png: Buffer): number {
  const { data } = decodePng(png);
  let s = 0;
  for (let i = 0; i < data.length; i += 4) s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return s / (data.length / 4);
}
/**
 * The sample's fixed date: every run seeds the same history, so the same windows are lit. PERF_SEED_AT=now seeds
 * it at the run's start instead, for the stills of what lasts only days after it happens (Task 8: the revival's
 * lights, the ribbon, a dark tower before its sale).
 */
const SEED_AT = process.env.PERF_SEED_AT === 'now' ? Date.now() : Date.parse('2026-11-10T17:30:00Z');
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

/** The stretch of a tower's floors laid in one era: its lowest and highest y, or null. */
function eraSpan(t: TowerSpec, era: Era): { y0: number; y1: number; n: number } | null {
  const fl = layoutTower(t).floors.filter((f) => f.floor.era === era);
  if (!fl.length) return null;
  return { y0: fl[0].y0, y1: fl[fl.length - 1].y0 + fl[fl.length - 1].h, n: fl.length };
}

/** The Task 7 stills (see views()). */
function task7Views(city: District[]): Array<[string, V3, V3]> {
  const out: Array<[string, V3, V3]> = [];
  const at = (o: { x: number; z: number }, dist: number, y: number, ty: number, dir = BEARING): [V3, V3] => [
    [o.x + dir.x * dist, y, o.z + dir.z * dist],
    [o.x, ty, o.z],
  ];
  const stone = city.map((d) => ({ d, s: eraSpan(d.tower, 'stone') })).filter((x) => x.s).sort((a, b) => b.s!.n - a.s!.n)[0];
  if (stone) {
    const y = (stone.s!.y0 + stone.s!.y1) / 2;
    // The eye rises a fifth of its distance over the run, so the roofs between never cover the run's foot.
    out.push(['coursing-700', ...at(stone.d.origin, 700, y + 140, y)]);
    out.push(['coursing-1100', ...at(stone.d.origin, 1100, y + 220, y)]);
  }
  const crowned = city.filter((d) => eraSpan(d.tower, 'scifi')).sort((a, b) => layoutTower(b.tower).top - layoutTower(a.tower).top)[0];
  if (crowned) out.push(['scifi-crown-hero', [700, 70, 700], [crowned.origin.x, layoutTower(crowned.tower).top - 6, crowned.origin.z]]);
  const byRoot = (root: string): District | undefined => city.find((d) => d.tower.root === root);
  const gothic = byRoot('gothic');
  // The root's top (the Gothic pinnacles at 27 to 34 m, the pagoda's eaves at 12 to 26 m) from 600 m and 150 m up, so
  // the roofs between pass under the line of sight and the linework stands against the lit plaza round the root.
  if (gothic) out.push(['gothic-far', ...at(gothic.origin, 600, 150, 29)]);
  const pagoda = byRoot('pagoda');
  if (pagoda) out.push(['pagoda-far', ...at(pagoda.origin, 600, 150, 20)]);
  // The market overview's distance: about 600 m off the exchange (at the civic plaza's centre), high over the roofs.
  out.push(['exchange-600', [BEARING.x * 560, 210, BEARING.z * 560], [0, 10, 0]]);
  const beaux = byRoot('beauxarts');
  if (beaux) {
    // The giant order's capitals (roots.ts beauxarts): volutes at 21.8 m on the colonnade ring 15.75 m out, the fifth
    // column of the south front at x = -1.75; the eye 9 m off, a little below and to one side.
    const o = beaux.origin;
    out.push(['ionic-close', [o.x + 2.5, 21.0, o.z + 24.5], [o.x - 1.75, 21.9, o.z + 16.3]]);
  }
  return out;
}

/**
 * The street trees' still (Task 9): the longest unbroken run of street trees
 * within 640 m of the centre (no gap over 50 m: one junction), from the far
 * lane 24 m short of its first tree at 1.7 m, looking 120 m down the run. A city with
 * no street trees (the base) falls back to the README street's west pavement.
 */
async function streetTreesView(page: Page): Promise<[V3, V3]> {
  type Spot = { x: number; z: number };
  const spots = await dbg<Spot[]>(page, '(d) => (d.treeSpots ? d.treeSpots() : [])');
  const lines = new Map<string, number[]>();
  for (const t of spots) {
    if (Math.max(Math.abs(t.x), Math.abs(t.z)) > 640) continue;
    const onX = Math.abs(Math.abs(t.x - Math.round(t.x / 80) * 80) - 34) < 0.01;
    const onZ = Math.abs(Math.abs(t.z - Math.round(t.z / 80) * 80) - 34) < 0.01;
    if (onX) lines.set(`x ${t.x}`, [...(lines.get(`x ${t.x}`) ?? []), t.z]);
    else if (onZ) lines.set(`z ${t.z}`, [...(lines.get(`z ${t.z}`) ?? []), t.x]);
  }
  let best: { key: string; from: number; to: number; n: number } | null = null;
  for (const [key, along] of [...lines].sort((a, b) => a[0].localeCompare(b[0]))) {
    along.sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= along.length; i++) {
      if (i === along.length || along[i] - along[i - 1] > 50) {
        const n = i - start;
        if (!best || n > best.n) best = { key, from: along[start], to: along[i - 1], n };
        start = i;
      }
    }
  }
  if (!best || best.n < 4) return [[195.6, 1.7, -136], [196.3, 5.0, -20]];
  const [axis, at] = best.key.split(' ');
  const line = Number(at);
  // The kerb side of the tree line: toward the street's centre (the line stands 34 m off a block's centre, the street 40).
  const out = line - Math.round(line / 80) * 80 > 0 ? 8 : -8;
  console.log(`trees-street: ${best.n} trees along ${axis} = ${line} from ${best.from} to ${best.to}`);
  // Looking 120 m down the run: the camera rig keeps its eye within reach of its target, so a far target lifts the eye.
  const to = Math.min(best.to, best.from + 120);
  return axis === 'x'
    ? [[line + out, 1.7, best.from - 24], [line + out * 0.25, 4.5, to]]
    : [[best.from - 24, 1.7, line + out], [to, 4.5, line + out * 0.25]];
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
  const street = await streetTreesView(page);
  return [
    ['home', home.eye, home.target],
    ['overview', [cx + BEARING.x * 900, 300, cz + BEARING.z * 900], [cx, 70, cz]],
    ['close-tower', [d0.origin.x + BEARING.x * 120, top * 0.45, d0.origin.z + BEARING.z * 120], [d0.origin.x, top * 0.5, d0.origin.z]],
    ['tower-root', [d0.origin.x + BEARING.x * 75, 6, d0.origin.z + BEARING.z * 75], [d0.origin.x, lay.rootHeight * 0.5, d0.origin.z]],
    // The texture views (Task 14), each the nearest named view of its scans: the Beaux-Arts root's sandstone from 34 m
    // (as tools/ui-test.ts frames root-close), the brick era's floors of the tower with the longest brick run from 50 m,
    // and the paving and kerbs of that tower's plaza from a walker's eye 40 m off.
    ...textureViews(city),
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
    // The sun's glow low in the frame (Task 6): from the city's east side, 40 m up, looking along the sun's bearing
    // (sky.ts SUN_DIRECTION, toward -x and +z) over the roofs, the glow's band in the upper right of the frame.
    ['sun-glow', [520, 40, -120], [-380, 150, 300]],
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
    // Far architecture (Task 7). The longest stone run in the sample (the coursed kit blocks) from 700 and 1100 m on the
    // home bearing, over the run's middle by a fifth of the distance; the organic family's ceramic shell with the low sun behind the eye; the
    // hero's own eye turned onto the tallest sci-fi crown (so a crown's height in pixels is the hero's); the Gothic and
    // the pagoda roots from 600 m, 70 m up (over the roofs between); the exchange from the market overview's distance; and one Ionic capital of the Beaux-Arts root from 9 m.
    ...task7Views(city),
    // The trees (Task 9): down the longest run of street trees (streetTreesView), the lamp side where they stand
    // between the posts; the quick quarter's garth from 80 m up on the sun's side (sky.ts SUN_DIRECTION, toward -x
    // and +z), its crowns lit; and the quarter's court from the pavement (tools/capture.ts quarter-court).
    ['trees-street', ...street],
    ['trees-from-above', [quick.origin.x - 64, 80, quick.origin.z + 30], [quick.origin.x, 2, quick.origin.z]],
    ['quarter-court', [quick.origin.x + 30, 1.7, quick.origin.z + 100], [quick.origin.x - 30, 14, quick.origin.z - 40]],
    // The six pinned looks (Decision 6's sheet, Task 6 round 0; Task 15 completes it): each sample tower's lower
    // floors (the root, the stone and the brick eras and the first glass, where the pinned materials read) from 190 m
    // on the home bearing; a 115 floor needle framed whole was only its haze.
    ...city.map((d): [string, V3, V3] => {
      const t = Math.min(layoutTower(d.tower).top, 120);
      return [`look-${d.repo.split('/').pop()}`, [d.origin.x + BEARING.x * 190, t * 0.5 + 22, d.origin.z + BEARING.z * 190], [d.origin.x, t * 0.5, d.origin.z]];
    }),
  ];
}

/** The family views (Task 7), staged: the longest sci-fi run in the city restyled for the shot, then put back. */
const FAMILY = ['ceramic-sun', 'cluster-pods', 'arcology-pavilion'];

/**
 * The organic family's ceramic in the low sun, the cluster family's
 * cantilevered pods and the arcology's roof pavilion, close. No sample tower
 * tops out in a sci-fi run (their top floors are earned in their agents'
 * eras), so a fixture district is stood for them, as tools/ui-test.ts stands
 * its site fixture: twelve founding floors all laid in the sci-fi era on a
 * Chicago root, on the next slot, restyled to each family for its shot.
 * It joins the city for the rest of the run, so these views run only when
 * PERF_ONLY names them.
 */
async function* familyViews(page: Page): AsyncGenerator<[string, V3, V3]> {
  const { openDb } = await import('../engine/db.js');
  const { emit } = await import('../engine/events.js');
  const { foundingFloors } = await import('../engine/history.js');
  const { nextSlot } = await import('../engine/repos.js');
  const { repoMarketDefaults } = await import('../shared/market-rules.js');
  const before = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const fullName = 'fixture/sci-fi-run';
  const slot = nextSlot('repo', fullName);
  const now = new Date(SEED_AT).toISOString();
  const repo: Repo = { fullName, private: false, defaultBranch: 'main', language: 'TypeScript', description: 'fixture', connected: true, pushMode: false, root: 'chicago', slot, status: 'ready', error: null, connectedAt: now, analyzedAt: now, ...repoMarketDefaults() };
  const commits = Array.from({ length: 12 }, (_, i) => ({
    sha: `${slot}${i.toString(16).padStart(6, '0')}`.padEnd(40, 'b'),
    at: new Date(Date.parse('2025-06-01T09:00:00Z') + i * 30 * 3600_000).toISOString(),
    author: 'Ada',
    subject: `Change ${i + 1}`,
    body: '',
    lines: 60 + i * 13,
  }));
  const floors = foundingFloors(fullName, commits, []).map((f) => ({ ...f, era: 'scifi' as const }));
  const tower: TowerSpec = { id: `${fullName}#founding`, repo: fullName, kind: 'founding', root: 'chicago', floors, datumIndex: floors.length };
  const db = openDb();
  // On the second tier the fixture already stands (the page reopened on the same home): written again, it is the same.
  const stood = before.some((x) => x.repo === fullName);
  db.prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(fullName, JSON.stringify(repo));
  db.prepare('INSERT OR REPLACE INTO towers (repo, json) VALUES (?, ?)').run(fullName, JSON.stringify(tower));
  if (!stood) emit('repo.analyzed', { repo });
  await page.waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, before.length + (stood ? 0 : 1), { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const d = ((await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[]).find((x) => x.repo === fullName);
  if (!d) {
    console.log('family views: the fixture did not stand; skipped');
    return;
  }
  const lay = layoutTower(d.tower);
  const o = d.origin;
  const top = lay.top;
  const y0 = lay.floors[0].y0;
  console.log(`family views on the fixture at slot ${slot} (${o.x}, ${o.z}): ${floors.length} sci-fi floors from ${y0.toFixed(0)} to ${top.toFixed(0)} m`);
  // The sun stands toward -x and +z (sky.ts SUN_DIRECTION): an eye on that side has the sun at its back.
  const SUN = { x: -0.908, z: 0.419 };
  for (const [name, family] of [['ceramic-sun', 'organic'], ['cluster-pods', 'cluster'], ['arcology-pavilion', 'arcology']] as const) {
    await callDebug(page, `d.restyle(${JSON.stringify(fullName)}, ['scifi:${family}'])`);
    // The rebuild is spread over frames: wait well past it before the still.
    await page.waitForTimeout(5000);
    if (name === 'ceramic-sun') {
      // The glazed shell square to the low sun, from 110 m with the sun at the eye's back, the run's middle in frame.
      const y = (y0 + top) / 2;
      yield [name, [o.x + SUN.x * 110, y + 8, o.z + SUN.z * 110], [o.x, y, o.z]];
    } else if (name === 'cluster-pods') {
      // The pods in the run's upper half from 70 m, a little above them, on the home bearing.
      const y = y0 + (top - y0) * 0.6;
      yield [name, [o.x + BEARING.x * 70, y + 6, o.z + BEARING.z * 70], [o.x, y, o.z]];
    } else {
      // The roof pavilion from 120 m, 18 m over the roof, so its structure stands against the sky.
      yield [name, [o.x + BEARING.x * 120, top + 18, o.z + BEARING.z * 120], [o.x, top - 6, o.z]];
    }
  }
}

/** The campus's quad (Task 9), staged: the perf city stands no campus unless asked for. */
const TREES = ['campus-quad'];

/**
 * The university's front quad (Task 9, tools/ui-test.ts campus-quad): the
 * perf city has no campus (the engine's own start ensures one; perf seeds
 * the sample alone), so one is ensured and the page opened again, only
 * under PERF_ONLY, and it stands for the rest of the run. Framed in the
 * campus's own frame, across the front quad from over the gate.
 */
async function* treeViews(page: Page, reopen: () => Promise<void>): AsyncGenerator<[string, V3, V3]> {
  (await import('../engine/school/campus.js')).ensureCampus();
  await reopen();
  type C = { anchors: Record<'library' | 'gate', number[]> } | null;
  const c = await dbg<C>(page, '(d) => d.campus()');
  if (!c) {
    console.log('trees: no campus stands; campus-quad is skipped');
    return;
  }
  const g = c.anchors.gate;
  const l = c.anchors.library;
  const n = Math.hypot(l[0] - g[0], l[2] - g[2]);
  const ax = [(l[0] - g[0]) / n, (l[2] - g[2]) / n];
  const at = (x: number, y: number, z: number): V3 => [g[0] + ax[0] * x - ax[1] * z, y, g[2] + ax[1] * x + ax[0] * z];
  yield ['campus-quad', at(-30, 30, 10), at(60, 10, -4)];
}

/** The campus, finished (Task 10), staged: the perf city stands no campus unless asked for. */
const CAMPUS = ['campus-home', 'campus-bays', 'campus-lamps', 'observatory-open', 'campus-turf-dusk', 'library-louvres-60m', 'campus-above'];

/**
 * The campus's stills (Task 10), on a campus ensured as treeViews ensures it,
 * in the campus's own frame (x from the gate toward the library along the
 * axis, z across it; the library at x 185, the clock tower at (97, -56.5),
 * the dome at (183, 90)): the city from home, its ID pass logged
 * (visibleShare); the library's lit bays close with their readers; the lamps
 * down the axis from the gate; the observatory open with its lining lit; the
 * front quad's lawn at a low angle in the dusk; and the clock tower's belfry
 * from 60 m with the library beyond. The voyage's light and the training are
 * told to the city through the debug handle for their stills, and the
 * ledger's given back after.
 */
async function* campusViews(page: Page, reopen: () => Promise<void>, only: string[] | undefined): AsyncGenerator<[string, V3, V3]> {
  const want = (n: string): boolean => !only || only.includes(n);
  (await import('../engine/school/campus.js')).ensureCampus();
  await reopen();
  type C = { anchors: Record<'library' | 'gate' | 'clock', number[]> } | null;
  const c = await dbg<C>(page, '(d) => d.campus()');
  if (!c) {
    console.log('campus: no campus stands; its views are skipped');
    return;
  }
  const g = c.anchors.gate;
  const l = c.anchors.library;
  const n = Math.hypot(l[0] - g[0], l[2] - g[2]);
  const ax = [(l[0] - g[0]) / n, (l[2] - g[2]) / n];
  const at = (x: number, y: number, z: number): V3 => [g[0] + ax[0] * x - ax[1] * z, y, g[2] + ax[1] * x + ax[0] * z];
  if (want('campus-home')) {
    const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
    await settle(page, home.eye, home.target);
    const share = await dbg<number>(page, "(d) => d.visibleShare('campus')");
    console.log(`campus-home: visibleShare('campus') ${share.toFixed(4)}`);
    yield ['campus-home', home.eye, home.target];
  }
  // The reading room lit as a voyage lights it: eight bays, as the sample economy's voyage does.
  type L = { lit: number; voyage: unknown } | null;
  const life = await dbg<L>(page, '(d) => d.campusLife()');
  if (!life || life.lit < 6) {
    const voyage = { id: 'perf-voyage', arena: 'harbor-ledger', repo: null, status: 'sailing', generation: 1, of: 6, runs: { done: 3, of: 48 }, racing: 8, commissionedBy: null, startedAt: '2026-11-12T18:00:00.000Z' };
    await page.evaluate((v) => (window as unknown as { __palimpsest: { life(s: unknown): void } }).__palimpsest.life({ voyage: v, nets: [], graduates: [] }), voyage);
  }
  await page.waitForTimeout(7000);
  console.log(`campus: ${(await dbg<L>(page, '(d) => d.campusLife()'))?.lit ?? 0} bays lit`);
  if (want('campus-bays')) yield ['campus-bays', at(147, 9.5, 19), at(178, 10, -1)];
  if (want('campus-lamps')) yield ['campus-lamps', at(-1, 8.6, 3.2), at(40, 8.4, -2)];
  if (want('campus-turf-dusk')) yield ['campus-turf-dusk', at(20, 7.7, 34), at(58, 4.4, 16)];
  // The lawn from above (Task 15a review; tools/capture.ts campus-above): its stripes, its walks and their kerbs.
  if (want('campus-above')) yield ['campus-above', at(40, 110, 30), at(62, 6, -6)];
  if (want('library-louvres-60m')) {
    const k = c.anchors.clock;
    const from = at(49.3, 0, -92.9);
    const d = Math.hypot(from[0] - k[0], from[2] - k[2]);
    yield ['library-louvres-60m', [k[0] + ((from[0] - k[0]) / d) * 60, k[1] + 36, k[2] + ((from[2] - k[2]) / d) * 60], [k[0], k[1] + 38, k[2]]];
  }
  if (want('observatory-open')) {
    await dbg(page, '(d) => d.school({ training: true, masterTrusted: true, version: 1 })');
    await page.waitForTimeout(7500);
    yield ['observatory-open', at(131, 11, 84), at(183, 14, 90)];
    await dbg(page, '(d) => d.school(null)');
  }
  await dbg(page, '(d) => d.life(null)');
}

/** The market's and the milestones' views (Task 8), staged one by one; an eye of null leaves the camera where the tour holds it. */
const MARKET = ['dark-tower-home', 'spire-lenses', 'revival-close', 'ribbon-shade', 'tour-stop-roof', 'construction-home', 'beams-near', 'glint-tall', 'glazed-beam-close'];

/**
 * The market and the milestones from home (Task 8), yielded one by one: the
 * bankrupt firm's dark tower from the home eye (dark-tower-home), the lit
 * spire's lenses from 700 m (spire-lenses), the revival's festoon from 26 m
 * (revival-close), the ribbon's band on its shaded side, the sun at the
 * tower's back (ribbon-shade), the week tour held at its first tower stop
 * (tour-stop-roof); then the sample economy's job sites turned live, as
 * phase two turns them: the city from home with its lit sites
 * (construction-home), a framing site's steel from 24 m (beams-near), and an
 * inspection on the tallest glass tower from the home eye (glint-tall) and
 * from 60 m (glazed-beam-close). No sample run inspects the tallest tower at
 * the seed, so an inspection is stood there for the two glint stills (a
 * site the live view lists, not a run in the ledger), only under PERF_ONLY;
 * the sites are taken down again after.
 */
async function* marketViews(page: Page, reopen: () => Promise<void>, only: string[] | undefined): AsyncGenerator<[string, V3 | null, V3]> {
  const want = (n: string): boolean => !only || only.includes(n);
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
  type Show = { id: string; kind: string; towerId: string; lit: boolean; y: number; height: number; tip: number[] };
  const shows = await callDebug<Show[]>(page, 'd.milestones()');
  if (want('dark-tower-home')) {
    const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
    const lode = qs.find((q) => q.dark && q.towers.some((t) => t.dark));
    const t = lode?.towers.find((x) => x.dark);
    if (lode && t) {
      const off = QUARTER_OFFSETS[t.towerIndex ?? 0];
      yield ['dark-tower-home', home.eye, [lode.origin.x + off.x, 28, lode.origin.z + off.z]];
    } else console.log('market: no dark tower in the economy; dark-tower-home is skipped');
  }
  if (want('spire-lenses')) {
    const spire = shows.find((m) => m.kind === 'skyline' && m.lit) ?? shows.find((m) => m.kind === 'skyline' || m.kind === 'founding-skyline');
    if (spire) {
      const [x, y, z] = spire.tip;
      // From 700 m on the home bearing, level with the lenses' galleries: their sizes at a distance the city is seen from.
      yield ['spire-lenses', [x + BEARING.x * 700, y - 20, z + BEARING.z * 700], [x, y - spire.height * 0.4, z]];
    } else console.log('market: no spire stands; spire-lenses is skipped');
  }
  const towerOf = (id: string): District | undefined => city.find((d) => d.tower.id === id);
  if (want('revival-close')) {
    const r = shows.find((m) => m.kind === 'revival');
    const d = r ? towerOf(r.towerId) : undefined;
    if (r && d) {
      const mid = r.y + r.height * 0.5;
      yield ['revival-close', [d.origin.x - 17, mid + 3, d.origin.z + 20], [d.origin.x, mid - 0.5, d.origin.z]];
    } else console.log('market: no revival stands; revival-close is skipped');
  }
  if (want('ribbon-shade')) {
    const r = shows.find((m) => m.kind === 'ribbon');
    const d = r ? towerOf(r.towerId) : undefined;
    if (r && d) {
      // The sun stands toward -x and +z (sky.ts SUN_DIRECTION): the faces toward +x and -z are the ribbon's shaded side.
      yield ['ribbon-shade', [d.origin.x + 30, r.y + 4, d.origin.z - 22], [d.origin.x, r.y, d.origin.z]];
    } else console.log('market: no ribbon flies; ribbon-shade is skipped');
  }
  if (want('tour-stop-roof')) {
    type Tour = { t: number; length: number; index: number; dwelling: boolean };
    if (await callDebug<boolean>(page, 'd.tourStart()')) {
      await callDebug(page, 'd.tourHold(true)');
      // The first stop past the exchange: on to its dwell.
      await page.keyboard.press('Space');
      await callDebug(page, 'd.tourHold(false)');
      await page.waitForTimeout(400);
      await callDebug(page, 'd.tourHold(true)');
      const tour = await callDebug<Tour>(page, 'd.tour()');
      await callDebug(page, `d.tourSeek(${(tour.t + 1.2).toFixed(2)})`);
      await page.waitForTimeout(1600);
      console.log(`market: tour-stop-roof at stop ${tour.index} (${tour.t.toFixed(1)} s)`);
      yield ['tour-stop-roof', null, [0, 0, 0]];
      await callDebug(page, 'd.tourHold(false)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2500);
    } else console.log('market: the week has no tour to walk; tour-stop-roof is skipped');
  }
  const SITES = ['construction-home', 'beams-near', 'glint-tall', 'glazed-beam-close'];
  if (!SITES.some(want)) return;
  const { setMarketExtras } = await import('../engine/market/api.js');
  const { economySites } = await import('../engine/market/sample-economy.js');
  const tallest = [...city].sort((a, b) => layoutTower(b.tower).top - layoutTower(a.tower).top)[0];
  const glint = want('glint-tall') || want('glazed-beam-close');
  let stand = false;
  const stood: SiteState = { repo: tallest.repo, runId: 'perf-glint', jobId: 'perf-glint', agentId: 'perf', firmId: 'perf', stage: 'inspecting', progress: 0.8, size: 'medium', since: new Date(SEED_AT).toISOString() };
  // For the glint stills the tallest tower's own site (if it has one) stands aside for the inspection.
  setMarketExtras({ sites: () => (stand ? [...economySites().filter((s) => s.repo !== tallest.repo), stood] : economySites()) });
  type SV = { stage: string; top: number; floorHeight: number; centre: number[]; crane: number[] };
  try {
    await reopen();
    await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().length >= 3, null, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const sites = await callDebug<Array<{ repo: string; stage: string }>>(page, 'd.liveSites()');
    console.log(`market: ${sites.length} live sites (${sites.map((s) => `${s.repo} ${s.stage}`).join(', ')})`);
    if (want('construction-home')) yield ['construction-home', home.eye, home.target];
    const framing = sites.find((s) => s.stage === 'framing' || s.stage === 'crane');
    if (want('beams-near') && framing) {
      const s = await callDebug<SV>(page, `d.site(${JSON.stringify(framing.repo)})`);
      const [cx, cz] = s.centre;
      console.log(`market: beams-near on ${framing.repo}, its deck at ${s.top.toFixed(1)} m round (${cx.toFixed(0)}, ${cz.toFixed(0)})`);
      yield ['beams-near', [cx + BEARING.x * 20 + 6, s.top + 7, cz + BEARING.z * 20 - 4], [cx, s.top + 2.5, cz]];
    } else if (want('beams-near')) console.log('market: no site frames; beams-near is skipped');
    if (glint) {
      stand = true;
      await reopen();
      await page.waitForTimeout(3000);
      const s = await callDebug<SV | null>(page, `d.site(${JSON.stringify(tallest.repo)})`);
      if (s && s.stage === 'inspecting') {
        console.log(`market: an inspection stood on ${tallest.repo} for the glint, its top at ${s.top.toFixed(0)} m`);
        if (want('glint-tall')) yield ['glint-tall', home.eye, [s.centre[0], s.top - 10, s.centre[1]]];
        if (want('glazed-beam-close')) yield ['glazed-beam-close', [s.centre[0] + BEARING.x * 60 + 10, s.top - 12, s.centre[1] + BEARING.z * 60 - 8], [s.centre[0], s.top - 6, s.centre[1]]];
      } else console.log(`market: ${tallest.repo} is not under inspection (${s?.stage ?? 'no site'}); the glint stills are skipped`);
    }
  } finally {
    setMarketExtras({});
  }
}

/** The views of Task 6 that need the tour, the ride or the haze handle; an eye of null leaves the camera where a script holds it. */
const HAZE = ['sun-low', 'ride-dossier-view', 'overview-clear'];
/** The clear-air dusk still's haze, as a share of the home value (Decision 5; tools/capture.ts shoots overview-clear with the same). */
const CLEAR_HAZE = 0.4;

/**
 * The haze views (Task 6), yielded one by one: the week tour held at its
 * poster moment (sun-low, the framing toward the low sun that tools/capture.ts
 * keeps as the week's poster), the ride held at its first dossier stop on the
 * tallest tower without a crew (ride-dossier-view, as the capture's
 * ride-dossier), and the overview with the haze at CLEAR_HAZE of the home value
 * through the debug handle's haze(k) (overview-clear), the default restored
 * after. A stage that cannot be reached is skipped and said.
 */
async function* hazeViews(page: Page, overview: [V3, V3]): AsyncGenerator<[string, V3 | null, V3]> {
  type Tour = { t: number; length: number };
  // sun-low is the brief's name for the week's poster moment; the tour looks over the city toward the afterglow's side,
  // and the sun's own band is not in its frame (sun-glow in views() holds the band for judging the cap).
  if (await callDebug<boolean>(page, 'd.tourStart()')) {
    await callDebug(page, 'd.tourHold(true)');
    await page.waitForTimeout(400);
    const tour = await callDebug<Tour>(page, 'd.tour()');
    await callDebug(page, `d.tourSeek(${(tour.length * 0.45).toFixed(2)})`);
    await page.waitForTimeout(1600);
    await callDebug(page, `d.tourSeek(${(tour.length * 0.45).toFixed(2)})`);
    console.log(`haze: sun-low at ${(tour.length * 0.45).toFixed(1)} s of the ${tour.length.toFixed(0)} s tour`);
    yield ['sun-low', null, [0, 0, 0]];
    await callDebug(page, 'd.tourHold(false)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2500);
  } else console.log('haze: the week has no tour to walk; sun-low is skipped');
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const busy = new Set((await callDebug<Array<{ repo: string }>>(page, 'd.liveSites()')).map((x) => x.repo));
  const repo = [...city].filter((x) => !busy.has(x.repo) && x.tower.floors.some((f) => f.earned)).sort((a, b) => b.tower.floors.length - a.tower.floors.length)[0]?.repo;
  type Riding = { stops: Array<{ t: number; dossier: boolean }> };
  if (repo) {
    const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
    await settle(page, home.eye, home.target);
    if (await callDebug<boolean>(page, `d.ride(${JSON.stringify(repo)})`)) {
      await callDebug(page, 'd.rideHold(true)');
      await page.waitForTimeout(600);
      const stop = (await callDebug<Riding>(page, 'd.riding()')).stops.find((s) => s.dossier);
      if (stop) {
        await callDebug(page, `d.rideSeek(${(stop.t + 0.8).toFixed(2)})`);
        await page.waitForTimeout(1600);
        await callDebug(page, `d.rideSeek(${(stop.t + 0.8).toFixed(2)})`);
        console.log(`haze: ride-dossier-view on ${repo} at its first dossier stop`);
        yield ['ride-dossier-view', null, [0, 0, 0]];
      } else console.log(`haze: the ride up ${repo} has no dossier stop; ride-dossier-view is skipped`);
      await callDebug(page, 'd.ride(null)');
      await page.waitForTimeout(1500);
    } else console.log(`haze: no ride up ${repo}; ride-dossier-view is skipped`);
  } else console.log('haze: no tower without a crew to ride; ride-dossier-view is skipped');
  if (await callDebug<boolean>(page, "typeof d.haze === 'function'")) {
    await callDebug(page, `d.haze(${CLEAR_HAZE})`);
    try {
      yield ['overview-clear', overview[0], overview[1]];
    } finally {
      await callDebug(page, 'd.haze(null)');
    }
  } else console.log('haze: this build has no haze handle; overview-clear is skipped');
}

/** The close views of Task 11, with the lens on: the ride at its roof, a tour stop and the inspector's close tower view (people-follow is staged with the people). */
const LENS = ['ride-top', 'tour-stop', 'inspector-close'];

/** Holds the lens in a close mode for a still staged without one (the follow's figure held); undefined gives the city's own back. A build without the lens skips it. */
async function lensAs(page: Page, mode: string | null | undefined): Promise<void> {
  await callDebug(page, `typeof d.lensAs === 'function' && d.lensAs(${mode === undefined ? 'undefined' : JSON.stringify(mode)})`);
}

/** Says what the lens holds after a still (mode, focus, blur), when the build has one. */
async function lensLog(page: Page, name: string): Promise<void> {
  const l = await callDebug<{ mode: string | null; on: boolean; amount: number; distance: number; focus: number; blur: number } | null>(page, "typeof d.lens === 'function' ? d.lens() : null");
  if (l) console.log(`lens: ${name} ${l.mode ?? 'no mode'}, ${l.on ? 'on' : 'off'} at ${l.amount.toFixed(2)}, subject ${l.distance.toFixed(1)} m, focus ${l.focus.toFixed(1)} m, background blur ${(l.blur * 100).toFixed(3)}% of the height`);
}

/**
 * The close views with the lens (Task 11), yielded one by one: the ride up
 * the tallest tower without a crew held at its roof as tools/capture.ts
 * shoots ride-top, the week tour held into its first stop's dwell
 * (tour-stop), and the inspector open on the tallest tower with the eye
 * 90 m off a floor two thirds up, as the inspector's own fly to a floor
 * stands (inspector-close). A stage that cannot be reached is skipped and said.
 */
async function* lensViews(page: Page, only: string[] | undefined): AsyncGenerator<[string, V3 | null, V3]> {
  const want = (n: string): boolean => !only || only.includes(n);
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
  if (want('ride-top')) {
    const busy = new Set((await callDebug<Array<{ repo: string }>>(page, 'd.liveSites()')).map((x) => x.repo));
    const repo = [...city].filter((d) => !busy.has(d.repo)).sort((a, b) => b.tower.floors.length - a.tower.floors.length)[0]?.repo;
    type Riding = { stops: Array<{ t: number; dwell: number }> };
    await settle(page, home.eye, home.target);
    if (repo && (await callDebug<boolean>(page, `d.ride(${JSON.stringify(repo)})`))) {
      await callDebug(page, 'd.rideHold(true)');
      await page.waitForTimeout(600);
      const r = await callDebug<Riding>(page, 'd.riding()');
      const roof = r.stops[r.stops.length - 1];
      const t = roof.t + roof.dwell * 0.6;
      await callDebug(page, `d.rideSeek(${t.toFixed(2)})`);
      await page.waitForTimeout(1600);
      await callDebug(page, `d.rideSeek(${t.toFixed(2)})`);
      console.log(`lens: ride-top on ${repo} at ${t.toFixed(1)} s`);
      yield ['ride-top', null, [0, 0, 0]];
      await lensLog(page, 'ride-top');
      await callDebug(page, 'd.ride(null)');
      await page.waitForTimeout(1500);
    } else console.log('lens: no ride to take; ride-top is skipped');
  }
  if (want('tour-stop')) {
    type Tour = { t: number; index: number };
    if (await callDebug<boolean>(page, 'd.tourStart()')) {
      await callDebug(page, 'd.tourHold(true)');
      await page.keyboard.press('Space');
      await callDebug(page, 'd.tourHold(false)');
      await page.waitForTimeout(400);
      await callDebug(page, 'd.tourHold(true)');
      const tour = await callDebug<Tour>(page, 'd.tour()');
      await callDebug(page, `d.tourSeek(${(tour.t + 1.2).toFixed(2)})`);
      await page.waitForTimeout(1600);
      console.log(`lens: tour-stop at stop ${tour.index} (${tour.t.toFixed(1)} s)`);
      yield ['tour-stop', null, [0, 0, 0]];
      await lensLog(page, 'tour-stop');
      await callDebug(page, 'd.tourHold(false)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2500);
    } else console.log('lens: the week has no tour to walk; tour-stop is skipped');
  }
  if (want('inspector-close')) {
    const tall = [...city].sort((a, b) => layoutTower(b.tower).top - layoutTower(a.tower).top)[0];
    const y = layoutTower(tall.tower).top * 0.66;
    await callDebug(page, `d.inspect(${JSON.stringify(tall.repo)})`);
    await page.waitForTimeout(800);
    const o = tall.origin;
    console.log(`lens: inspector-close on ${tall.repo}, a floor at ${y.toFixed(0)} m`);
    yield ['inspector-close', [o.x + BEARING.x * 84, y + 30, o.z + BEARING.z * 84], [o.x, y, o.z]];
    await lensLog(page, 'inspector-close');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }
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
      // The follow camera's framing with the lens as following holds it (Task 11): the figure held, the focus on her.
      await lensAs(page, 'follow');
      yield ['people-follow', ...followView(f)];
      await lensLog(page, 'people-follow');
      await lensAs(page, undefined);
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
  // PERF_HOLD_SALE=1 holds the bankrupt firm's tower back from the daily tick, so it still stands dark (dark-tower-home).
  await seedEconomy(SEED_AT, { holdSale: !!process.env.PERF_HOLD_SALE });
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  // The day's first open goes to the brief, drawn over a scrim that darkens the whole frame: spent here, as the UI
  // test does, so the first page opens on the city like every later one (the brightness debug: every high still
  // before it was the first page's, shot through that scrim).
  await openTodaysBrief(PORT);
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const result: { viewport: typeof PERF_VIEWPORT; tiers: Partial<Record<Tier, { home: Budget; views: Record<string, ViewRow> }>> } = { viewport: PERF_VIEWPORT, tiers: {} };
  const live: Record<string, { stats: Tally; breakdown: Breakdown; fps: number }> = {};
  const only = process.env.PERF_ONLY?.split(',');
  let lightFailed = false;
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
      // The stills are of the city: no running head, no plates, and no brief sheet (today's is opened before the first page).
      await page.addStyleTag({ content: '.runhead, .plates, .sheet.brief, .ride { display: none !important; }' });
      await page.waitForTimeout(2500);
      // Never a still with a route or a scrim over the city.
      const why = cityStands(await page.evaluate(() => ({ hash: location.hash, openScrims: document.querySelectorAll('.scrim.open:not([hidden])').length })));
      if (why) throw new Error(`perf: ${why}`);
    };
    for (const tier of only?.includes('first-frame') ? [] : tiers) {
      // The tier is Settings' quality, read as the page opens; the governor held still (PERF_GOVERNOR=1 leaves it running).
      await setQuality(tier);
      await open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug');
      // PERF_NO_CULL=1: the batches' and the blocks' culling off (Task 12), as the city drew before it, for a before.
      if (process.env.PERF_NO_CULL) await callDebug(page, 'd.cull(false)');
      const stands = await dbg<string>(page, '(d) => d.quality()');
      if (stands !== tier) throw new Error(`perf: the city opened at ${stands}, not ${tier}`);
      if (tier === tiers[0]) {
        // The first page opened on the engine and a second, from home: the same light within 3% (the brightness debug).
        const home = await dbg<{ eye: V3; target: V3 }>(page, '(d) => d.limits().home');
        const luma: number[] = [];
        for (const second of [false, true]) {
          if (second) await open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug');
          await settle(page, home.eye, home.target);
          luma.push(meanLuma(await page.screenshot()));
        }
        const same = sameLight(luma[0], luma[1]);
        console.log(`${same ? 'ok  ' : 'FAIL'}  ${tier} home on the engine's first page and a second are the same light within ${SAME_LIGHT * 100}% (mean luma ${luma[0].toFixed(2)} and ${luma[1].toFixed(2)})`);
        if (!same) lightFailed = true;
      }
      const home = await homeBudget(page, tier);
      const top = Object.entries(home.parts).sort((x, y) => y[1].triangles - x[1].triangles).slice(0, 4);
      console.log(`${tier} home budget, the shadow map redrawn: ${home.calls} calls, ${(home.triangles / 1e6).toFixed(2)}M triangles (${top.map(([k, t]) => `${k} ${(t.triangles / 1e6).toFixed(2)}M/${t.calls}`).join(', ')})`);
      const rows: Record<string, ViewRow> = {};
      const measure = async (name: string, eye: V3 | null, target: V3): Promise<void> => {
        await settle(page, eye, target);
        await page.screenshot({ path: join(out, tier === 'high' ? `${name}.png` : `${name}-${tier}.png`) });
        if (process.env.PERF_BARE) {
          // The same frame with the traffic held and the trees hidden (ruling 7's compare): <out>/bare.
          mkdirSync(join(out, 'bare'), { recursive: true });
          await callDebug(page, 'd.ambientHold(true)');
          await callDebug(page, 'd.trees(false)');
          await page.waitForTimeout(250);
          await page.screenshot({ path: join(out, 'bare', tier === 'high' ? `${name}.png` : `${name}-${tier}.png`) });
          await callDebug(page, 'd.trees(true)');
          await callDebug(page, 'd.ambientHold(false)');
          await page.waitForTimeout(500);
        }
        if (process.env.PERF_CULL_AB) {
          // The same frame with the batches' cluster culling off (as before Task 12) and on, a moment apart, the
          // traffic held: <out>/cull-off and <out>/cull-on, for `compare` to read with no run-to-run drift between.
          // cull-on-again is the floor: the same frame shot twice with nothing changed but the wind in the trees and
          // the clock; the -bare folders take the trees out of the frame (their sway is most of what moves).
          const file = tier === 'high' ? `${name}.png` : `${name}-${tier}.png`;
          const shoot = async (dir: string, on: boolean): Promise<void> => {
            mkdirSync(join(out, dir), { recursive: true });
            await callDebug(page, `d.cull(${on})`);
            await page.waitForTimeout(250);
            await page.screenshot({ path: join(out, dir, file) });
          };
          await callDebug(page, 'd.ambientHold(true)');
          await shoot('cull-off', false);
          await shoot('cull-on', true);
          await shoot('cull-on-again', true);
          await callDebug(page, 'd.trees(false)');
          await shoot('cull-off-bare', false);
          await shoot('cull-on-bare', true);
          await callDebug(page, 'd.trees(true)');
          await callDebug(page, 'd.ambientHold(false)');
          await page.waitForTimeout(500);
        }
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
        if (name === 'exchange-600') {
          // The tote board as it stands once the jobs have loaded: its lit cards and lamps are what the still is for.
          await page.waitForFunction(() => ((window as unknown as { __palimpsest: { exchange(): { slots: Array<{ state: string; lamps: number }> } | null } }).__palimpsest.exchange()?.slots ?? []).some((x) => x.state === 'bidding'), null, { timeout: 15_000 }).catch(() => {});
          const board = await dbg<Array<{ state: string; lamps: number }>>(page, '(d) => d.exchange()?.slots ?? []');
          console.log(`exchange-600: ${board.filter((x) => x.state === 'bidding').length} cards lit, ${board.reduce((a, x) => a + x.lamps, 0)} lamps`);
          // The bidders on their way to the exchange (Task 15a): the people's clock held and moved on until every figure
          // on a live bid trip stands in the queue at the hall's stair (people.ts queueSpot), at most ten minutes on. Only
          // figures on a bid trip count; a bidder that never arrives stops the run.
          type Fig = { stage: string; position: V3; tripId: string | null; reason: string | null };
          const atDoors = (fs: Fig[]): number => fs.filter((f) => f.tripId !== null && f.reason === 'bid' && f.stage === 'idle' && f.position[0] > -2 && f.position[0] < 30 && f.position[2] > 20 && f.position[2] < 32).length;
          const live = (await page.evaluate(() => fetch('/api/live').then((r) => (r.ok ? r.json() : { trips: [] })).catch(() => ({ trips: [] })))) as { trips?: Array<{ reason: string; endedAt: string | null }> };
          const bidding = (live.trips ?? []).filter((t) => t.reason === 'bid' && !t.endedAt).length;
          await callDebug(page, 'd.peopleHold(true)');
          let queued = atDoors(await callDebug<Fig[]>(page, 'd.persons()'));
          for (let t = 0; t < 600 && queued < bidding; t += 20) {
            await callDebug(page, 'd.peopleSkip(20)');
            queued = atDoors(await callDebug<Fig[]>(page, 'd.persons()'));
          }
          console.log(`exchange-600: ${queued} of ${bidding} bidders in the queue at the doors`);
          if (queued < bidding) throw new Error(`exchange-600: only ${queued} of ${bidding} bidders reached the exchange's queue in ten minutes of the people's clock`);
        }
        await measure(name, eye, target);
        if (name === 'exchange-600') await callDebug(page, 'd.peopleHold(false)');
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
      if (!only || only.includes('people-follow')) {
        // A follow held (Task 12): what the governor reads each frame (all passes, the shadow map redrawn as the eye
        // moves), sampled over twelve seconds of a live follow, against its triangle budget.
        await callDebug(page, `d.follow(${JSON.stringify('dagny-hollis')})`);
        await page.waitForTimeout(2000);
        const seen: Tally[] = [];
        for (let i = 0; i < 48; i++) {
          seen.push(await dbg<Tally>(page, '(d) => d.stats()'));
          await page.waitForTimeout(250);
        }
        // And how its frames run while the view and the AO refill as she turns corners (Task 12): six seconds more.
        await dbg(page, '(d) => d.trace?.(true)');
        const held = frameStats(await frameTimes(page, 6000));
        // What each of those frames cost the loop itself (Task 13): the update, the passes submitted, and whether the
        // shadow map was redrawn; a slow frame with a cheap loop is the GPU's.
        const tr = ((await dbg(page, '(d) => d.trace?.(false) ?? []')) as Array<{ update: number; render: number; shadow: boolean }>) ?? [];
        if (tr.length) {
          const mean = (xs: number[]): string => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
          console.log(`${tier} follow-held loop: ${tr.length} frames, shadow redrawn in ${tr.filter((x) => x.shadow).length}, update mean ${mean(tr.map((x) => x.update))} ms, passes mean ${mean(tr.map((x) => x.render))} ms`);
        }
        const lensNow = await dbg<unknown>(page, "(d) => typeof d.lens === 'function' ? d.lens() : null");
        const eye = await dbg<number[]>(page, '(d) => d.camera()');
        console.log(`${tier} follow-held lens ${JSON.stringify(lensNow)}, eye ${eye.map((v) => v.toFixed(0)).join(',')}`);
        await callDebug(page, 'd.follow(null)');
        const tri = seen.map((s) => s.triangles);
        const row = { fps: 0, calls: Math.round(seen.reduce((a, s) => a + s.calls, 0) / seen.length), triangles: Math.round(tri.reduce((a, b) => a + b, 0) / tri.length) };
        rows['follow-held'] = row;
        console.log(`${tier} follow-held over 12 s: mean ${row.calls} calls ${(row.triangles / 1e6).toFixed(2)}M triangles a frame, most ${(Math.max(...tri) / 1e6).toFixed(2)}M; frames over 6 s: slowest ${held.max.toFixed(1)} ms, p99 ${held.p99.toFixed(1)} ms, ${held.over33} over 33 ms`);
      }
      if (only && LENS.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of lensViews(page, only)) {
          if (!only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (!only || CLOSE.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of closeViews(page, out)) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (only && FAMILY.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of familyViews(page)) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (!only || HAZE.some((n) => only.includes(n))) {
        const ov = (await views(page)).find(([n]) => n === 'overview')!;
        for await (const [name, eye, target] of hazeViews(page, [ov[1], ov[2]])) {
          if (only && !only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (only && MARKET.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of marketViews(page, () => open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug'), only)) {
          if (!only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (only && CAMPUS.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of campusViews(page, () => open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug'), only)) {
          if (!only.includes(name)) continue;
          await measure(name, eye, target);
        }
      }
      if (only && TREES.some((n) => only.includes(n))) {
        for await (const [name, eye, target] of treeViews(page, () => open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug'))) {
          if (!only.includes(name)) continue;
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
    // PERF_FIRST_FRAME=5: that many cold loads last (Task 14), each in a browser of its own, on high. (Task 14 put them
    // last because a load before the tiers spent the day's first open, the brief over its scrim, and so brightened the
    // stills; today's brief is now opened before any page, so every load and still opens on the city.)
    const loads = Number(process.env.PERF_FIRST_FRAME ?? 0);
    if (loads > 0) {
      // The run's own page draws nothing while the loads are timed.
      await page.goto('about:blank');
      await setQuality('high');
      const times: number[] = [];
      for (let i = 0; i < loads; i++) {
        const ms = await firstFrameMs(`http://127.0.0.1:${PORT}/?fixed-quality&debug`);
        times.push(ms);
        console.log(`first frame, cold load ${i + 1}: ${ms.toFixed(0)} ms`);
      }
      console.log(`first frame over ${loads} cold loads: median ${median(times).toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`);
      writeFileSync(join(out, 'first-frame.json'), JSON.stringify({ times, median: median(times) }, null, 1));
    }
    writeFileSync(join(out, 'perf.json'), JSON.stringify(result, null, 1));
    if (errors.length) console.log(`console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(lightFailed ? 1 : 0);
}

/**
 * The look before and after (`npm run perf compare <before dir> <after dir>`): the SSIM of every still the two
 * runs share, through ffmpeg's ssim filter, printed one a line with the lowest last; exits 1 when any is under
 * PERF_SSIM_MIN (0.99 by default).
 */
async function compare(before: string, after: string): Promise<void> {
  const { readdirSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const min = Number(process.env.PERF_SSIM_MIN ?? 0.99);
  const rows: Array<[string, number]> = [];
  for (const f of readdirSync(before).filter((x) => x.endsWith('.png')).sort()) {
    if (!existsSync(join(after, f))) continue;
    // ffmpeg writes its ssim line to stderr: folded into stdout to be read.
    const said = execFileSync('sh', ['-c', 'ffmpeg -hide_banner -nostats -i "$0" -i "$1" -lavfi ssim -f null - 2>&1', join(before, f), join(after, f)], { encoding: 'utf8' });
    const m = /All:([0-9.]+)/.exec(said);
    rows.push([f, m ? Number(m[1]) : NaN]);
  }
  for (const [f, s] of rows) console.log(`${s.toFixed(4)}  ${f}${s < min || !Number.isFinite(s) ? '  under' : ''}`);
  const low = rows.reduce((a, r) => Math.min(a, r[1]), Infinity);
  console.log(`${rows.length} stills, lowest SSIM ${low.toFixed(4)} (at least ${min} wanted)`);
  process.exit(rows.length > 0 && low >= min ? 0 : 1);
}

// Run as a script only: the tests import the port, the tiers and the viewport without starting a run.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === 'compare') {
  compare(resolve(process.argv[3]), resolve(process.argv[4])).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
