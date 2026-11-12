/**
 * End-to-end UI check. Starts its own engine in-process on port UI_PORT
 * (default 4779; tools/ui-port.ts refuses 4770 and 4771) with a
 * temp data home (never the real engine on 4770), seeds the sample city
 * (tools/sample.ts), opens the built UI in Chromium and checks that the
 * city renders without console errors. Saves screenshots to shots/.
 *
 * The Repos and Settings checks fake every gh/git call in-process (setRunner),
 * and the usage hook buttons write only to a temp claude settings file. The
 * API key field goes to the sample keychain, held in this process's memory:
 * `security` never runs, and the engine is named a keychain file in the temp
 * dir besides, so no keychain on this Mac is ever touched.
 *
 * Run after `npm run build`: `npm run ui-test`. Optional: UI_DPR=2 renders
 * at retina density, UI_QUALITY=medium switches the quality setting first,
 * UI_TOWER_SHOTS=all adds close shots of every root and era for the quality
 * rounds. UI_FORCE_DROP=1 runs the notice stack's checks alone and then
 * drops the quality from home, checking that the notice names what it saw. UI_ONLY=spire (or revival) seeds the economy and
 * runs the skyline's checks and shots alone; UI_ONLY=budget seeds it and compares the tiers' calls from home
 * (UI_BUDGET=detail names each drawn mesh). Both partial modes end "PARTIAL run (...): not a full pass" and
 * exit 3 when every check they ran held (tools/ui-verdict.ts), never as a full pass. UI_PORT=4811 runs it on another port, so two worktrees can each
 * run one at once.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { repoMarketDefaults } from '../shared/market-rules.js';
import { crownFor } from '../shared/silhouette.js';
import { layoutTower } from '../shared/tower-layout.js';
import { QUARTER_OFFSETS } from '../shared/district-layout.js';
import type { District, Era, FirmView, Quarter, Repo, TowerSpec } from '../shared/types.js';
import { BOARD_ORDER, boardFrame, boardTowers, boardViews } from './agent-board.js';
import { detailChecks } from './ui-test-detail.js';
import { firmChecks } from './ui-test-firms.js';
import { installKeychainStandIn, marketChecks } from './ui-test-market.js';
import { treasuryChecks } from './ui-test-treasury.js';
import { jobBoardChecks } from './ui-test-jobs.js';
import { auditChecks } from './ui-test-audit.js';
import { briefChecks, emptyMorningChecks } from './ui-test-brief.js';
import { dropNoticeChecks, noticeChecks } from './ui-test-notices.js';
import { apart, around as aroundPerson, callDebug, followView, person, runUntil, sendPerson } from './people-stage.js';
import { SAMPLE, SAMPLE_OTHERS, SAMPLE_UNREADABLE, sampleGh, seedSample } from './sample.js';
import { decodePng } from './png.js';
import { uiPort } from './ui-port.js';
import { partialMode, verdict } from './ui-verdict.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, 'shots');
const PORT = uiPort(process.env.UI_PORT);
const VIEWPORT = { width: 1600, height: 940 };

const failures: string[] = [];
/** True while a check aborts requests on purpose: the browser's own "Failed to load resource" line is then expected. */
let abortingRequests = false;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

// ---------------------------------------------------------------- pixels

/** RGB of a 1x1 PNG. Every PNG filter type reduces to the raw bytes for a single pixel with no prior row. */
function rgbOf1x1(png: Buffer): [number, number, number] {
  let off = 8;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return rgbOf1x1(await page.screenshot({ clip: { x, y, width: 1, height: 1 } }));
}

// ---------------------------------------------------------------- views

type View = [string, [number, number, number], [number, number, number]];

// Named camera views for the quality rounds: [file, eye, target].
const VIEWS: View[] = [
  ['city-horizon', [-120, 60, 520], [-600, 40, -600]],
  ['city-street', [118, 2.2, 52], [118, 14, -260]],
  ['city-skyline-mid', [560, 140, 620], [80, 40, 40]],
];

// Tower views, relative to a district origin: a bearing that turns the sunlit faces toward the eye.
const BEARING = { x: 0.63, z: 0.78 };

function towerViews(d: District, all: boolean): View[] {
  const root = d.tower.root;
  const lay = layoutTower(d.tower);
  const { x, z } = d.origin;
  const at = (dist: number, eyeY: number, ty: number, turn = 0): [[number, number, number], [number, number, number]] => {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const bx = BEARING.x * c - BEARING.z * s;
    const bz = BEARING.x * s + BEARING.z * c;
    return [[x + bx * dist, eyeY, z + bz * dist], [x, ty, z]];
  };
  const views: View[] = [[`tower-${root}`, ...at(Math.max(140, lay.top * 1.9), 22, lay.top * 0.47)]];
  if (!all) return views;
  views.push([`tower-${root}-root`, ...at(75, 6, lay.rootHeight * 0.5)]);
  views.push([`tower-${root}-root-close`, ...at(34, 3, lay.rootHeight * 0.38, 0.35)]);
  // Close on each era's run of floors.
  const runs = new Map<Era, { y0: number; y1: number }>();
  for (const l of lay.floors) {
    const r = runs.get(l.floor.era);
    if (r) r.y1 = l.y0 + l.h;
    else runs.set(l.floor.era, { y0: l.y0, y1: l.y0 + l.h });
  }
  for (const [era, r] of runs) {
    const mid = (r.y0 + r.y1) / 2;
    views.push([`tower-${root}-era-${era}`, ...at(70, mid + 6, mid)]);
  }
  return views;
}

async function setView(page: Page, eye: number[], target: number[]): Promise<void> {
  await page.evaluate(([e, t]) => {
    (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
  }, [eye, target]);
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------- debug handle

interface Debug {
  ready: boolean;
  districts: number;
  sites: number;
  builds: number;
  highlight: { repo: string; floorId: string } | null;
  camera(): number[];
  limits(): Limits;
  precompile(): Promise<void>;
  stats(): { calls: number; triangles: number };
  plots(): { plazas: number; buildings: number };
  quality(): 'high' | 'medium';
  notice(): string;
  inspect(repo: string): void;
  quarters: number;
  opened: string;
  lastPick: { kind: string; agentId?: string; firmId?: string; repo?: string } | null;
}

/** Holds the ambient traffic and crowd at full density (once the network is laid), so every budget sees its worst. */
async function fullDensity(page: Page): Promise<void> {
  await page
    .waitForFunction('window.__palimpsest.ambient() !== null', null, { timeout: 30_000 })
    .then(() => page.evaluate('window.__palimpsest.ambientDensity(1)'))
    .catch(() => {});
}

function debug<T>(page: Page, read: (d: Debug) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__palimpsest)`) as Promise<T>;
}

const cityOf = (page: Page): Promise<District[]> =>
  page.evaluate(() => fetch('/api/city').then((r) => r.json())) as Promise<District[]>;

// ---------------------------------------------------------------- fps

/** The steady overview's frame rate, which every other view is held to. */
let overviewFps = 0;

/** Frames per second over three seconds, as the page draws them. */
function pageFps(page: Page): Promise<number> {
  return page.evaluate(`new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    function tick() {
      frames++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (performance.now() - t0));
    }
    requestAnimationFrame(tick);
  })`) as Promise<number>;
}

/**
 * Steady-state frame rate: every shader is compiled first (renderer.compile
 * through the debug handle) and the view settles, so a first-sight compile
 * never counts against the steady state.
 */
async function measureFps(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  // A string, so tsx's name-keeping helpers never reach the page.
  const fps = (): Promise<number> =>
    page.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
        else resolve((frames * 1000) / (performance.now() - t0));
      }
      requestAnimationFrame(tick);
    })`) as Promise<number>;
  const settled = async (eye: number[], target: number[]): Promise<number> => {
    await setView(page, eye, target);
    await debug(page, (d) => d.precompile());
    await page.waitForTimeout(1500);
    return fps();
  };
  const gpu = (await page.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  })()`)) as string;
  const ratio = (await page.evaluate('Math.min(devicePixelRatio, 1.75)')) as number;

  const ds = await cityOf(page);
  const cx = ds.reduce((a, d) => a + d.origin.x, 0) / ds.length;
  const cz = ds.reduce((a, d) => a + d.origin.z, 0) / ds.length;
  const overview = await settled([cx + BEARING.x * 900, 300, cz + BEARING.z * 900], [cx, 70, cz]);
  await page.screenshot({ path: join(SHOTS, 'towers-all.png') });
  const stats = await debug(page, (d) => d.stats());
  const d0 = ds.find((d) => d.tower.floors.length > 0) ?? ds[0];
  const top = layoutTower(d0.tower).top;
  const close = await settled(
    [d0.origin.x + BEARING.x * 120, top * 0.45, d0.origin.z + BEARING.z * 120],
    [d0.origin.x, top * 0.5, d0.origin.z],
  );
  const closeStats = await debug(page, (d) => d.stats());
  console.log(`info  ${gpu}, ${VIEWPORT.width}x${VIEWPORT.height} at pixel ratio ${ratio}`);
  overviewFps = overview;
  console.log(`info  steady overview: ${overview.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  console.log(`info  steady close tower: ${close.toFixed(0)} fps, ${closeStats.calls} draw calls, ${(closeStats.triangles / 1e6).toFixed(2)}M triangles`);
}

// ---------------------------------------------------------------- the kits missing

/** With kits.glb unreachable the city still stands, on plain blocks, and says why, instead of going blank. */
async function kitFailureChecks(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(String(e)));
  await page.route('**/kits/kits.glb', (r) => r.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.from('not a glb at all') }));
  await page.goto(`http://127.0.0.1:${PORT}/?debug`);
  const ready = await page
    .waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check(ready && thrown.length === 0, `a corrupt kits.glb still opens the city (${thrown.join(' | ') || 'no errors'})`);
  const districts = (await page.evaluate(() => (window as unknown as { __palimpsest?: { districts: number } }).__palimpsest?.districts ?? 0)) as number;
  check(districts === SAMPLE.length, `and stands every district on plain blocks (${districts})`);
  const notice = (await page.locator('.city-notice-line p').allTextContents()).join(' ');
  check(/kits did not load/.test(notice), `and says so (${notice.slice(0, 60)})`);
  // Past the veil's fade, so the shot shows the plain city under the notice.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, 'kits-missing.png') });
  await page.close();
}

// ---------------------------------------------------------------- earned floors (Task 22)

/**
 * The sample economy laid over the sample city (engine/market/sample-economy.ts):
 * a tower with lit, waiting and scar floors over its bronze band, shot as
 * tower-earned.png, and the inspector listing them under "Built in the market".
 */
async function earnedChecks(page: Page): Promise<void> {
  const { seedEconomy } = await import('../engine/market/sample-economy.js');
  // Lodestar's dark tower is held back from the daily tick's sale, so darkTowerChecks sees it dark and then sold live.
  await seedEconomy(Date.now(), { holdSale: true });
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
  await fullDensity(page);
  await page.waitForTimeout(2500);
  const ds = await cityOf(page);
  const states = (d: District): Set<string> => new Set(d.tower.floors.map((f) => f.earned?.state ?? '').filter(Boolean));
  const d = ds.find((x) => ['lit', 'waiting', 'scar'].every((st) => states(x).has(st)));
  check(!!d, `a tower carries lit, waiting and scar floors (${d?.repo ?? 'none'})`);
  if (!d) return;
  const lay = layoutTower(d.tower);
  check(lay.top > lay.datumY + 20, `its earned floors rise above the datum (${(lay.top - lay.datumY).toFixed(0)} m)`);
  const span = lay.top - lay.datumY;
  const mid = lay.datumY + span * 0.5;
  await setView(page, [d.origin.x - 70 - span * 0.6, mid - 6, d.origin.z + 55 + span * 0.5], [d.origin.x, mid, d.origin.z]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, 'tower-earned.png') });
  const stats = await debug(page, (x) => x.stats());
  const fps = (await page.evaluate(`new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    function tick() {
      frames++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (performance.now() - t0));
    }
    requestAnimationFrame(tick);
  })`)) as number;
  console.log(`info  earned tower: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  await debug(page, (x) => (x as unknown as { home(): void }).home());
  await page.waitForTimeout(2500);
  const home = await debug(page, (x) => x.stats());
  console.log(`info  economy city from home: ${home.calls} draw calls, ${(home.triangles / 1e6).toFixed(2)}M triangles`);
  check((await debug(page, (x) => x.quality())) === 'high', 'the economy city holds high quality too');

  await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), d.repo);
  await page.waitForSelector('.inspector.open', { timeout: 5000 });
  // The names arrive from /api/firms after the list draws.
  const named = await page
    .waitForFunction(() => [...document.querySelectorAll('.insp-who')].some((e) => /Quickset|Ashlar|Meridian|Kiln|Sparrow|Lodestar/.test(e.textContent ?? '')), null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(named, 'earned rows name the agent and the firm');
  const heads = await page.locator('.insp-era-name').allTextContents();
  check(heads[0] === 'Built in the market', `the market's floors head the list (${heads[0]})`);
  const order = await page.evaluate(() => [...document.querySelectorAll('.insp-floors > li')].map((li) => (li.classList.contains('insp-datum') ? 'datum' : li.classList.contains('insp-earned') ? 'earned' : li.classList.contains('insp-floor') ? 'founding' : 'head')));
  const lastEarned = order.lastIndexOf('earned');
  const datumAt = order.indexOf('datum');
  check(lastEarned >= 0 && datumAt > lastEarned && order.indexOf('founding') > datumAt, 'earned floors list above the datum entry, founding floors below it');
  const scarRow = page.locator('.insp-earned.scar').first();
  check((await scarRow.locator('.insp-failed').textContent()) === 'Failed inspection', 'a scar says Failed inspection');
  const report = await scarRow.locator('.insp-ref a').getAttribute('href');
  check(!!report && /^#\/(inspections|runs)\//.test(report), `a scar links to its inspection report (${report})`);
  const pr = await page.locator('.insp-earned:not(.scar) .insp-ref a').first().getAttribute('href');
  check(!!pr && pr.startsWith(`https://github.com/${d.repo}/pull/`), `an earned floor links to its PR (${pr})`);
  check((await page.locator('.insp-earned.waiting .insp-state').first().textContent()) === 'Waiting on your review', 'a waiting floor says it waits on his review');
  // Clicking an earned floor still flies to it.
  const before = await debug(page, (x) => x.camera());
  await scarRow.click();
  await page.waitForTimeout(2500);
  const after = await debug(page, (x) => x.camera());
  const hl = await debug(page, (x) => x.highlight);
  check(hl?.floorId?.includes('#scar-') === true && Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 1, 'clicking a scar marks it and flies to it');
  await page.screenshot({ path: join(SHOTS, 'tower-earned-inspector.png') });
  await page.keyboard.press('Escape');
  check((await debug(page, (x) => x.notice())) === '', 'no notice shows when the kits load and the frame rate holds');
}

// ---------------------------------------------------------------- the spire and the finial (Phase 3 Task 14)

/**
 * The milestones' draw calls from home, every pass counted, on the economy as
 * the full run leaves it (spires, finial, a revival, a ribbon): measured 35
 * on high and 22 on medium (Task 16), each ceiling a call or two above, so a
 * new ornament has to be paid for here, knowingly.
 */
const MILESTONE_CALLS = { high: 36, medium: 24 } as const;

type SpireShow = { id: string; kind: string; towerId: string; lit: boolean; y: number; height: number; tip: number[] };

/**
 * The skyline on the sample economy (engine/market/sample-economy.ts):
 * the harbour tower holds the lit spire and the founding skyline both, so
 * its mast is lit and wears the bronze sleeve; assay-kit held the spire
 * first and keeps its mast dark. Each stands on its tower's true top. Shots:
 * spire.png close at dusk, finial.png (the finial staged on assay-kit's
 * mast, as a tower holding the founding skyline alone would wear it) and
 * spire-home.png from home, where the lit tip must read; the city's budget
 * from home holds with them. Runs with the economy seeded.
 */
async function spireChecks(page: Page): Promise<void> {
  const shows = async (): Promise<SpireShow[]> => (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
  const A = 'lantern/assay-kit#founding';
  await page.waitForFunction(`window.__palimpsest.milestones().some((m) => m.kind === 'skyline' && m.lit)`, null, { timeout: 10_000 }).catch(() => {});
  const ms = await shows();
  const lit = ms.filter((m) => m.kind === 'skyline' && m.lit);
  const passed = ms.filter((m) => m.kind === 'skyline' && !m.lit);
  const founding = ms.filter((m) => m.kind === 'founding-skyline');
  check(passed.some((m) => m.towerId === A), `assay-kit, the previous holder, keeps an unlit spire (${passed.map((m) => m.towerId).join(', ') || 'none'})`);
  const ds = await cityOf(page);
  const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const specs = [...ds.map((d) => d.tower), ...qs.flatMap((q) => q.towers)];
  // The founding skyline is the tallest tower by total height: the harbour tower on the seeded economy alone (its sleeve on the lit mast),
  // or whichever tower earlier checks raised past it in the full run.
  const tallest = specs.reduce((a, b) => (layoutTower(b).top > layoutTower(a).top ? b : a));
  // The lit spire: the greatest earned height above its datum among towers with a lit earned floor (ruling 11; a holder keeps a tie).
  const earnedHeight = (t: TowerSpec): number => layoutTower(t).top - layoutTower(t).datumY;
  const contenders = specs.filter((t) => t.floors.some((f) => f.earned?.state === 'lit'));
  const most = Math.max(...contenders.map(earnedHeight));
  const holder = specs.find((t) => t.id === lit[0]?.towerId);
  check(lit.length === 1 && !!holder && Math.abs(earnedHeight(holder) - most) < 1e-6, `the lit spire stands on the tower with the greatest earned height (${lit.map((m) => m.towerId).join(', ') || 'none'}, ${holder ? earnedHeight(holder).toFixed(1) : '?'} of ${most.toFixed(1)} m)`);
  check(founding.length === 1 && founding[0].towerId === tallest.id, `the founding skyline stands on the tallest tower (${founding.map((m) => m.towerId).join(', ') || 'none'} against ${tallest.id})`);
  for (const m of [...lit, ...passed]) {
    const t = specs.find((x) => x.id === m.towerId);
    // An agent tower's lens or needle crown stands between its roof and the spire (crownFor).
    const earned = t ? t.floors.filter((f, i) => i >= t.datumIndex && !f.founding).length : 0;
    const crown = t && t.kind === 'agent' && earned > 0 ? crownFor(t.silhouette ?? 'plain', earned).height : 0;
    const top = t ? layoutTower(t).top + crown : NaN;
    check(Math.abs(m.y - top) < 0.05, `the spire on ${m.towerId} stands on its true top (${m.y.toFixed(2)} against ${top.toFixed(2)} m)`);
  }
  if (!lit[0]) return;
  const harbour = ds.find((x) => x.tower.id === lit[0].towerId);
  if (!harbour) {
    check(false, `the lit spire's tower is a district tower for the close shot (${lit[0].towerId})`);
    return;
  }
  const s = lit[0];
  const foot = [harbour.origin.x, s.y, harbour.origin.z];

  // Close, at dusk: the mast from a little below its lamp, the roof and its stays in frame, the city beyond.
  await setView(page, [foot[0] - s.height * 1.15, s.y + s.height * 0.55, foot[2] + s.height * 1.55], [foot[0], s.y + s.height * 0.5, foot[2]]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(SHOTS, 'spire.png') });
  await page.screenshot({ path: join(SHOTS, 'spire-crop.png'), clip: { x: VIEWPORT.width / 2 - 260, y: 60, width: 520, height: 520 } });
  const close = await debug(page, (x) => x.stats());
  const closeFps = await pageFps(page);
  console.log(`info  the spire close: ${closeFps.toFixed(0)} fps, ${close.calls} draw calls`);
  check(closeFps >= overviewFps - 5, `the spire's close view holds the frame rate (${closeFps.toFixed(0)} against ${overviewFps.toFixed(0)})`);

  // The finial: the founding skyline alone on a mast, staged on assay-kit's.
  const a = passed.find((m) => m.towerId === A);
  const ad = ds.find((x) => x.tower.id === A);
  if (a && ad) {
    const row = (kind: string, towerId: string, l: boolean) => ({ id: `${kind}:${towerId}`, kind, towerId, repo: null, firmId: null, agentId: null, floorId: null, at: new Date().toISOString(), until: null, lit: l, title: '', detail: '' });
    await page.evaluate((rows) => (window as unknown as { __palimpsest: { stageMilestones(r: unknown): void } }).__palimpsest.stageMilestones(rows), [row('skyline', lit[0].towerId, true), row('skyline', A, false), row('founding-skyline', A, false)]);
    await setView(page, [ad.origin.x + a.height * 1.0, a.y + a.height * 0.8, ad.origin.z + a.height * 1.3], [ad.origin.x, a.y + a.height * 0.72, ad.origin.z]);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(SHOTS, 'finial.png') });
    await page.screenshot({ path: join(SHOTS, 'finial-crop.png'), clip: { x: VIEWPORT.width / 2 - 260, y: 60, width: 520, height: 520 } });
    await page.evaluate(() => (window as unknown as { __palimpsest: { stageMilestones(r: null): void } }).__palimpsest.stageMilestones(null));
    await page.waitForTimeout(300);
    const again = (await shows()).filter((m) => m.kind === 'founding-skyline').map((m) => m.towerId);
    check(again.join() === founding.map((m) => m.towerId).join(), `the engine's milestones stand again after the staged finial (${again.join(', ')})`);
  }

  // An agent's tower holding the spire: staged, it stands above the agent's own crown.
  const q = qs.find((x) => x.towers.length > 0);
  const at = q?.towers.find((t) => t.floors.some((f) => f.earned?.state === 'lit')) ?? q?.towers[0];
  if (q && at) {
    const row = { id: `skyline:${at.id}`, kind: 'skyline', towerId: at.id, repo: null, firmId: q.firmId, agentId: at.agentId ?? null, floorId: null, at: new Date().toISOString(), until: null, lit: true, title: 'The skyline', detail: '' };
    await page.evaluate((rows) => (window as unknown as { __palimpsest: { stageMilestones(r: unknown): void } }).__palimpsest.stageMilestones(rows), [row]);
    await page.waitForTimeout(300);
    const staged = (await shows()).find((m) => m.towerId === at.id);
    const earned = at.floors.filter((f, i) => i >= at.datumIndex && !f.founding).length;
    const crown = earned > 0 ? crownFor(at.silhouette ?? 'plain', earned).height : 0;
    const want = layoutTower(at).top + crown;
    check(!!staged && staged.lit && Math.abs(staged.y - want) < 0.05, `an agent's tower carries the lit spire on its true top, above its ${at.silhouette ?? 'plain'} crown (${staged?.y.toFixed(2) ?? 'none'} against ${want.toFixed(2)} m)`);
    if (staged) {
      const off = QUARTER_OFFSETS[at.towerIndex ?? 0] ?? { x: 0, z: 0 };
      const [x, z] = [q.origin.x + off.x, q.origin.z + off.z];
      await setView(page, [x - staged.height * 1.4, staged.y + staged.height * 0.5, z + staged.height * 1.8], [x, staged.y + staged.height * 0.45, z]);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SHOTS, 'spire-agent.png') });
    }
    await page.evaluate(() => (window as unknown as { __palimpsest: { stageMilestones(r: null): void } }).__palimpsest.stageMilestones(null));
    await page.waitForTimeout(300);
  }

  // From home: the lit tip reads as a warm point against what stands behind it.
  const budget = await homeBudget(page);
  await page.waitForTimeout(1500);
  const shot = await page.screenshot({ path: join(SHOTS, 'spire-home.png') });
  const ndc = (await page.evaluate((p) => (window as unknown as { __palimpsest: { project(p: number[]): number[] } }).__palimpsest.project(p), s.tip)) as number[];
  const px = Math.round(((ndc[0] + 1) / 2) * VIEWPORT.width);
  const py = Math.round(((1 - ndc[1]) / 2) * VIEWPORT.height);
  const onScreen = ndc[2] < 1 && px >= 0 && py >= 0 && px < VIEWPORT.width && py < VIEWPORT.height;
  check(onScreen, `the lit tip stands in the home view (${px}, ${py})`);
  if (onScreen) {
    const img = decodePng(shot);
    const lum = (x: number, y: number): number => {
      const i = (Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4;
      return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    };
    let peak = 0;
    let warm = false;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const l = lum(px + dx, py + dy);
        if (l > peak) {
          peak = l;
          const i = ((py + dy) * img.width + px + dx) * 4;
          warm = img.data[i] > img.data[i + 2] + 20;
        }
      }
    const ring: number[] = [];
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * Math.PI * 2;
      ring.push(lum(px + Math.round(Math.cos(t) * 9), py + Math.round(Math.sin(t) * 9)));
    }
    ring.sort((x, y) => x - y);
    const behind = ring[12];
    console.log(`info  the lit tip from home at (${px}, ${py}): ${peak.toFixed(0)} against ${behind.toFixed(0)} behind it, ${warm ? 'warm' : 'not warm'}`);
    check(peak > behind + 30 && warm, `the lamp reads from home as a warm point (${peak.toFixed(0)} against ${behind.toFixed(0)})`);
  }
  type T = { calls: number; triangles: number };
  const b = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, Record<string, T>>;
  const own = Object.values(b.milestones ?? {}).reduce((acc, t) => ({ calls: acc.calls + t.calls, triangles: acc.triangles + t.triangles }), { calls: 0, triangles: 0 });
  console.log(`info  the skyline from home: ${own.calls} draw calls, ${(own.triangles / 1000).toFixed(1)}k triangles; the city ${budget.calls} calls, ${(budget.triangles / 1e6).toFixed(2)}M triangles`);
  check(own.calls > 0 && own.calls <= MILESTONE_CALLS.high, `the milestones (spires, finial, revival, ribbons) draw in at most ${MILESTONE_CALLS.high} calls from home, every pass counted (${own.calls})`);
  check(budget.triangles <= HOME_TRIANGLES && budget.calls < HOME_CALLS, `the city from home stays within ${HOME_CALLS} calls and ${HOME_TRIANGLES / 1e6}M triangles with the spires (${budget.calls}, ${(budget.triangles / 1e6).toFixed(2)}M)`);
}

/**
 * Scaffolding lights on a revived repo (Phase 3 Task 15): every revival the
 * engine holds active stands as a lit scaffold round its floor and the one
 * below, its festoon's bulbs drawn in one instanced emitter. Shots:
 * revival.png close at dusk and revival-home.png from home; the city keeps
 * its budget with them. Runs with the economy seeded.
 */
async function revivalChecks(page: Page): Promise<void> {
  type M = { id: string; kind: string; towerId: string; floorId: string | null; until: string | null };
  const active = (await page.evaluate(() => fetch('/api/milestones?active=1').then((r) => r.json()))) as M[];
  const revived = active.filter((m) => m.kind === 'revival');
  check(revived.length > 0, `the economy holds a revival (${revived.map((m) => m.towerId).join(', ') || 'none'})`);
  await page.waitForFunction(`window.__palimpsest.milestones().some((m) => m.kind === 'revival')`, null, { timeout: 10_000 }).catch(() => {});
  const shows = (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
  const ds = await cityOf(page);
  for (const r of revived) {
    const show = shows.find((m) => m.id === r.id);
    const d = ds.find((x) => x.tower.id === r.towerId);
    const lay = d ? layoutTower(d.tower) : null;
    const i = lay ? lay.floors.findIndex((f) => f.floor.id === r.floorId) : -1;
    const want = lay && i >= 0 ? lay.floors[Math.max(0, i - 1)].y0 : NaN;
    const top = lay && i >= 0 ? lay.floors[i].y0 + lay.floors[i].h : NaN;
    check(!!show && Math.abs(show.y - want) < 0.05 && show.y + show.height >= top, `${d?.repo ?? r.towerId} carries scaffolding lights round its revived floor and the one below (${show ? `${show.y.toFixed(1)} to ${(show.y + show.height).toFixed(1)} m` : 'none'})`);
  }
  const r = revived[0];
  const d = r ? ds.find((x) => x.tower.id === r.towerId) : undefined;
  const show = r ? shows.find((m) => m.id === r.id) : undefined;
  if (!r || !d || !show) return;
  const mid = show.y + show.height * 0.5;
  await setView(page, [d.origin.x - 38, mid + 4, d.origin.z + 46], [d.origin.x, mid - 1, d.origin.z]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SHOTS, 'revival.png') });
  await page.screenshot({ path: join(SHOTS, 'revival-crop.png'), clip: { x: VIEWPORT.width / 2 - 300, y: VIEWPORT.height / 2 - 260, width: 600, height: 520 } });
  const fps = await pageFps(page);
  check(fps >= overviewFps - 5, `the revival's close view holds the frame rate (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  const budget = await homeBudget(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, 'revival-home.png') });
  type T = { calls: number; triangles: number };
  const b = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, Record<string, T>>;
  const own = Object.values(b.milestones ?? {}).reduce((acc, t) => acc + t.calls, 0);
  console.log(`info  the milestones from home with the revival: ${own} calls; the city ${budget.calls} calls, ${(budget.triangles / 1e6).toFixed(2)}M triangles`);
  check(own <= MILESTONE_CALLS.high && budget.calls < HOME_CALLS && budget.triangles <= HOME_TRIANGLES, `the milestones draw in at most ${MILESTONE_CALLS.high} calls and the city keeps its budget from home (${own}, ${budget.calls}, ${(budget.triangles / 1e6).toFixed(2)}M)`);
}

/**
 * The ribbon on a new firm's first PR floor (Phase 3 Task 16): every ribbon
 * the engine holds active is tied round its floor across the face, a little
 * above mid-floor, and the inspector's row names the firm. Shots: ribbon.png close at dusk,
 * ribbon-crop.png, ribbon-home.png. Runs with the economy seeded.
 */
async function ribbonChecks(page: Page): Promise<void> {
  type M = { id: string; kind: string; towerId: string; floorId: string | null; firmId: string | null; title: string };
  const active = (await page.evaluate(() => fetch('/api/milestones?active=1').then((r) => r.json()))) as M[];
  const ribbons = active.filter((m) => m.kind === 'ribbon');
  check(ribbons.length > 0, `the economy flies a ribbon (${ribbons.map((m) => `${m.firmId} on ${m.towerId}`).join(', ') || 'none'})`);
  await page.waitForFunction(`window.__palimpsest.milestones().some((m) => m.kind === 'ribbon')`, null, { timeout: 10_000 }).catch(() => {});
  const shows = (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
  const ds = await cityOf(page);
  for (const r of ribbons) {
    const show = shows.find((m) => m.id === r.id);
    const d = ds.find((x) => x.tower.id === r.towerId);
    const f = d ? layoutTower(d.tower).floors.find((x) => x.floor.id === r.floorId) : undefined;
    check(!!show && !!f && show.y > f.y0 && show.y < f.y0 + f.h, `${r.title.replace(/^The /, '')}: its floor on ${d?.repo ?? r.towerId} carries the ribbon (${show?.y.toFixed(1) ?? 'none'} in ${f ? `${f.y0.toFixed(1)} to ${(f.y0 + f.h).toFixed(1)}` : '?'} m)`);
  }
  const r = ribbons[0];
  const d = r ? ds.find((x) => x.tower.id === r.towerId) : undefined;
  const show = r ? shows.find((m) => m.id === r.id) : undefined;
  if (!r || !d || !show) return;
  // The inspector's row for the floor says whose first PR it is.
  await page.evaluate((repo) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(repo), d.repo);
  await page.waitForSelector('.inspector.open', { timeout: 5000 }).catch(() => {});
  const mark = await page.locator(`.insp-floor[data-floor="${encodeURIComponent(r.floorId ?? '')}"] .insp-mark`).textContent({ timeout: 3000 }).catch(() => null);
  check(mark === r.title.replace(/^The /, ''), `the inspector's row reads "${mark}"`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // Close, from the street corner the bow faces, a little below the band.
  await setView(page, [d.origin.x + 30, show.y - 3, d.origin.z + 34], [d.origin.x + 4, show.y - 0.5, d.origin.z + 4]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SHOTS, 'ribbon.png') });
  await page.screenshot({ path: join(SHOTS, 'ribbon-crop.png'), clip: { x: VIEWPORT.width / 2 - 300, y: VIEWPORT.height / 2 - 260, width: 600, height: 520 } });
  const budget = await homeBudget(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, 'ribbon-home.png') });
  console.log(`info  the city from home with the ribbons: ${budget.calls} calls, ${(budget.triangles / 1e6).toFixed(2)}M triangles`);
  check(budget.calls < HOME_CALLS && budget.triangles <= HOME_TRIANGLES, `the city keeps its budget from home with the ribbons (${budget.calls}, ${(budget.triangles / 1e6).toFixed(2)}M)`);
}

/**
 * The week tour (Phase 3 Task 17): T walks the camera from the exchange
 * through the week's stops and back, a caption at each; Space goes on, a
 * stop at a time; Escape ends it and the view returns home. With
 * prefers-reduced-motion the walk cuts from stop to stop. Shots:
 * tour-open.png (the exchange, the walk's first caption) and tour-stop.png
 * (a stop mid-tour with its caption). Runs with the economy seeded.
 */
async function tourChecks(page: Page): Promise<void> {
  type TS = { t: number; length: number; index: number; caption: string | null; dwelling: boolean };
  const tourOf = (): Promise<TS | null> => page.evaluate('window.__palimpsest.tour()') as Promise<TS | null>;
  const planned = (await page.evaluate(() => fetch('/api/tour').then((r) => r.json()))) as { stops: Array<{ kind: string; title: string; glide: number; dwell: number }>; seconds: number } | null;
  check(!!planned && planned.stops.length >= 4, `the economy's week has a tour (${planned ? planned.stops.length - 2 : 0} stops, ${planned?.seconds ?? 0} s)`);
  if (!planned) return;
  await setView(page, (await debug(page, (d) => d.limits().home)).eye, (await debug(page, (d) => d.limits().home)).target);
  const home = await debug(page, (d) => d.camera());
  await page.locator('#city canvas').focus();
  await page.keyboard.press('t');
  const walking = await page.waitForFunction('window.__palimpsest.tour() !== null', null, { timeout: 8000 }).then(() => true).catch(() => false);
  check(walking, 'T walks the week');
  if (!walking) return;
  await page.evaluate('window.__palimpsest.tourHold(true)');
  // The opening: the exchange, settled, its caption showing.
  await page.evaluate('window.__palimpsest.tourSeek(1.5)');
  await page.waitForTimeout(1600);
  const open = (await tourOf())!;
  check(open.index === 0 && open.caption === 'The exchange', `it opens at the exchange (${open.caption})`);
  await page.screenshot({ path: join(SHOTS, 'tour-open.png') });
  // Each stop: dwelt at, its caption its own, the camera moved from the last.
  const length = open.length;
  let t = 0;
  const captions: string[] = [];
  let moved = 0;
  let last = await debug(page, (d) => d.camera());
  const mid = Math.floor(planned.stops.length / 2);
  for (let i = 0; i < planned.stops.length; i++) {
    const s = planned.stops[i];
    const at = t + s.glide + s.dwell / 2;
    t += s.glide + s.dwell;
    if (at >= length) break;
    await page.evaluate((x) => (window as unknown as { __palimpsest: { tourSeek(t: number): void } }).__palimpsest.tourSeek(x), at);
    await page.waitForTimeout(500);
    const st = (await tourOf())!;
    captions.push(st.caption ?? '');
    const cam = await debug(page, (d) => d.camera());
    if (Math.hypot(cam[0] - last[0], cam[1] - last[1], cam[2] - last[2]) > 5) moved++;
    last = cam;
    if (i === mid) {
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(SHOTS, 'tour-stop.png') });
      await page.screenshot({ path: join(SHOTS, 'tour-stop-caption.png'), clip: { x: 0, y: VIEWPORT.height - 260, width: 760, height: 260 } });
    }
  }
  const inner = captions.slice(1, -1);
  check(inner.length === planned.stops.length - 2 && inner.every((c, i) => c === planned.stops[i + 1].title), `the caption changes at each of the ${planned.stops.length - 2} stops (${inner.join(' | ').slice(0, 160)})`);
  check(moved >= planned.stops.length - 2, `and the camera moves from stop to stop (${moved})`);
  // Space: on to the next stop.
  await page.evaluate('window.__palimpsest.tourSeek(1)');
  await page.waitForTimeout(200);
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  check(((await tourOf())?.index ?? 0) >= 1, 'Space goes on to the next stop');
  // Escape: the walk ends and the view glides home.
  await page.evaluate('window.__palimpsest.tourHold(false)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2600);
  check((await tourOf()) === null, 'Escape ends the tour');
  const back = await debug(page, (d) => d.camera());
  check(Math.hypot(back[0] - home[0], back[1] - home[1], back[2] - home[2]) < 5, `and the view returns home (${Math.hypot(back[0] - home[0], back[1] - home[1], back[2] - home[2]).toFixed(1)} m off)`);
  // A sheet opened mid-tour ends the tour; Escape then closes the sheet alone.
  const notice = (): Promise<string> => page.evaluate('window.__palimpsest.notice()') as Promise<string>;
  await page.locator('#city canvas').focus();
  // Two quick presses of T start one walk, not two.
  await page.keyboard.press('t');
  await page.keyboard.press('t');
  await page.waitForFunction('window.__palimpsest.tour() !== null', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  check((await page.locator('.ride.tour').count()) === 1, `two quick presses of T start one walk (${await page.locator('.ride.tour').count()} caption sets)`);
  await page.evaluate(() => {
    location.hash = '#/jobs';
  });
  check(await page.waitForFunction('window.__palimpsest.tour() === null', null, { timeout: 3000 }).then(() => true).catch(() => false), 'a sheet opened mid-tour ends the tour');
  await page.waitForSelector('.sheet.jobs, .sheet .sec-bidding', { state: 'attached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  check((await page.evaluate(() => document.body.dataset.route)) === 'city' && (await tourOf()) === null, 'Escape on the sheet closes the sheet, the tour already over');
  // Walking the week again while a walk is under way starts it afresh, never saying there is nothing to walk.
  await page.locator('#city canvas').focus();
  await page.keyboard.press('t');
  await page.waitForFunction('window.__palimpsest.tour() !== null', null, { timeout: 8000 }).catch(() => {});
  await page.evaluate('window.__palimpsest.tourSeek(30)');
  const again = (await page.evaluate('window.__palimpsest.tourStart()')) as boolean;
  await page.waitForTimeout(400);
  const restarted = await tourOf();
  check(again && !!restarted && restarted.t < 10 && !/Not enough happened/.test(await notice()), `walking the week during a walk starts it afresh (${again}, t ${restarted?.t.toFixed(1) ?? 'none'})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2600);

  // Reduced motion: the walk cuts, so the eye stands still through what would be a glide.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate('window.__palimpsest.tourStart()');
  await page.waitForFunction('window.__palimpsest.tour() !== null', null, { timeout: 8000 }).catch(() => {});
  await page.evaluate('window.__palimpsest.tourHold(true)');
  const s1 = planned.stops[0].glide + planned.stops[0].dwell;
  await page.evaluate((x) => (window as unknown as { __palimpsest: { tourSeek(t: number): void } }).__palimpsest.tourSeek(x), s1 + 0.2);
  await page.waitForTimeout(400);
  const a = await debug(page, (d) => d.camera());
  await page.evaluate((x) => (window as unknown as { __palimpsest: { tourSeek(t: number): void } }).__palimpsest.tourSeek(x), s1 + planned.stops[1].glide - 0.2);
  await page.waitForTimeout(400);
  const b = await debug(page, (d) => d.camera());
  check(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.01, 'with reduced motion the tour cuts from stop to stop, never gliding');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const budget = await homeBudget(page);
  console.log(`info  the city from home after the tour: ${budget.calls} calls`);
}

/**
 * The floor dossier on the ride (Phase 3 Task 18): riding the harbour tower,
 * an earned floor's stop carries its dossier under the caption (the change
 * in numbers, the plan, the verdict) and a founding floor's stop none; a
 * floor a README proposal built quotes the claim. Shots: ride-dossier.png,
 * ride-dossier-crop.png and ride-dossier-claim.png. Runs with the economy.
 */
async function dossierChecks(page: Page): Promise<void> {
  type Riding = { length: number; stops: Array<{ t: number; dwell: number; mark: string | null; title: string | null; floorId: string | null; dossier: boolean }> };
  const ride = async (repo: string): Promise<Riding | null> => {
    // The inspector opens first, as he would before pressing R: the dossiers are read in the background.
    await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), repo);
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const ok = await page.evaluate((r) => (window as unknown as { __palimpsest: { ride(k: string): boolean } }).__palimpsest.ride(r), repo);
    if (!ok) return null;
    await page.evaluate('window.__palimpsest.rideHold(true)');
    return (await page.evaluate('window.__palimpsest.riding()')) as Riding;
  };
  const seek = async (t: number): Promise<void> => {
    await page.evaluate((x) => (window as unknown as { __palimpsest: { rideSeek(t: number): void } }).__palimpsest.rideSeek(x), t);
    await page.waitForTimeout(1300);
  };
  const off = async (): Promise<void> => {
    await page.evaluate('window.__palimpsest.ride(null)');
    await page.waitForTimeout(3000);
  };
  const r = await ride('tidewater/harbor-ledger');
  check(!!r, 'the harbour tower\'s lift runs');
  if (!r) return;
  const withDossier = r.stops.filter((s) => s.dossier);
  check(withDossier.length >= 1 && withDossier.every((s) => Math.abs(s.dwell - 2.4) < 1e-6), `the ride waits 2.4 s at each floor with a dossier (${withDossier.length} of them)`);
  console.log(`info  the harbour ride: ${r.length.toFixed(1)} s, ${withDossier.length} dossier stops`);
  check(r.length <= 60, `the dossiers never make the ride a crawl (${r.length.toFixed(1)} s)`);
  const d = withDossier[withDossier.length - 1];
  if (d) {
    await seek(d.t + 0.8);
    const text = ((await page.locator('.ride .ride-dossier-body').getAttribute('aria-label').catch(() => null)) ?? '').trim();
    check(/\d+ lines?\./.test(text) && /Plan: /.test(text) && /(Passed|Failed|Inconclusive)/.test(text), `an earned floor's stop shows its dossier ("${text.slice(0, 140)}")`);
    const fits = await page.evaluate(() => {
      const b = document.querySelector('.ride .ride-dossier')!.getBoundingClientRect();
      const c = document.querySelector('.ride .ride-caption')!.getBoundingClientRect();
      return b.right <= c.right + 1 && b.width <= 441;
    });
    check(fits, 'the dossier never runs wider than the caption\'s column');
    check((await page.locator('.ride .ride-caption[role="status"] .ride-dossier-body[aria-label]').count()) === 1, 'it is read out with the caption (role status), whole');
    await page.screenshot({ path: join(SHOTS, 'ride-dossier.png') });
    await page.screenshot({ path: join(SHOTS, 'ride-dossier-crop.png'), clip: { x: 0, y: VIEWPORT.height - 380, width: 760, height: 380 } });
  }
  const founding = r.stops.find((s) => !s.dossier && (s.mark === 'claude' || s.mark === 'datum' || s.floorId === null) && s.t > 0);
  if (founding) {
    await seek(founding.t + 0.8);
    check((await page.locator('.ride .ride-dossier-body').count()) === 0, `a founding floor's stop carries no dossier (${founding.title})`);
  }
  await off();
  // A floor a README proposal built: the claim, quoted. The economy merges no proposal, so when none stands one is
  // staged: the claim set into the newest dossier floor, as a proposal floor carries it (stageClaim).
  const jobs = (await page.evaluate(() => fetch('/api/jobs').then((x) => x.json()))) as Array<{ id: string; source: string; status: string; repo: string }>;
  const ds = await cityOf(page);
  const built = jobs.find((j) => j.source === 'proposal' && ds.some((x) => x.repo === j.repo && x.tower.floors.some((f) => f.earned?.jobId === j.id)));
  const repo = built?.repo ?? 'tidewater/harbor-ledger';
  const floorId = built ? ds.find((x) => x.repo === built.repo)!.tower.floors.find((f) => f.earned?.jobId === built.id)!.id : (d?.floorId ?? null);
  console.log(`info  the README claim: ${built ? `a proposal floor on ${repo}` : 'staged on the harbour tower'}`);
  if (!floorId) return;
  if (!built) await page.evaluate(([f, c]) => (window as unknown as { __palimpsest: { stageClaim(f: string, c: string): boolean } }).__palimpsest.stageClaim(f, c), [floorId, 'Tide tables are cached per port and refreshed at local midnight'] as [string, string]);
  const pr = await ride(repo);
  const stop = pr?.stops.find((s) => s.floorId === floorId);
  check(!!stop && stop.dossier, "the claim's floor is a dossier stop");
  if (stop) {
    await seek(stop.t + 0.8);
    const claim = ((await page.locator('.ride .ride-dossier-claim').textContent().catch(() => null)) ?? '').trim();
    check(/^From the README: \u2018.+\u2019$/.test(claim), `it quotes the README's claim ("${claim}")`);
    await page.screenshot({ path: join(SHOTS, 'ride-dossier-claim.png') });
    await page.screenshot({ path: join(SHOTS, 'ride-dossier-claim-crop.png'), clip: { x: 0, y: VIEWPORT.height - 420, width: 760, height: 420 } });
  }
  await off();
}

type Tally = { calls: number; triangles: number };
type Breakdown = Record<string, Record<string, Tally>>;
/** The home view's draws by subsystem (or by drawn mesh, with `detail`) and pass, the shadow map redrawn. */
async function homeBreakdown(page: Page, detail = false): Promise<Breakdown> {
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(1500);
  return (await page.evaluate(`window.__palimpsest.breakdown(${detail})`)) as Breakdown;
}
const callsOf = (b: Breakdown): number => Object.values(b).reduce((n, v) => n + Object.values(v).reduce((m, t) => m + t.calls, 0), 0);

/**
 * The medium tier's draws against the high tier's from home (Phase 4 Task 0,
 * pulled forward): stepping down takes detail away, so it must never cost
 * more calls than high, give or take a few for the shadow map's own cut. The
 * difference is printed by subsystem and pass, and with UI_BUDGET=detail by
 * drawn mesh, so a regression names itself.
 */
async function tierBudgetChecks(page: Page, high: Breakdown): Promise<void> {
  const medium = await homeBreakdown(page, process.env.UI_BUDGET === 'detail');
  const hc = callsOf(high);
  const mc = callsOf(medium);
  const keys = [...new Set([...Object.keys(high), ...Object.keys(medium)])];
  const rows = keys
    .flatMap((k) => ['main', 'shadow', 'ao', 'post'].map((p) => [k, p, high[k]?.[p]?.calls ?? 0, medium[k]?.[p]?.calls ?? 0] as const))
    .filter(([, , a, b]) => a !== b)
    .sort((x, y) => Math.abs(y[3] - y[2]) - Math.abs(x[3] - x[2]));
  for (const [k, p, a, b] of rows.slice(0, 40)) console.log(`info  tier ${k} ${p}: high ${a}, medium ${b}`);
  console.log(`info  from home: high ${hc} calls, medium ${mc} calls`);
  check(mc <= hc + 5, `on medium the city from home draws no more than high plus 5 calls (${mc} against ${hc})`);
}

/**
 * After the step down to medium: the skyline's ornaments are rebuilt at
 * medium and stand where they stood, and the city from home keeps within
 * its budget with them.
 */
async function spireAfterDropChecks(page: Page, before: SpireShow[]): Promise<void> {
  check((await debug(page, (x) => x.quality())) === 'medium', 'the city stands at medium for the skyline after the drop');
  const after = (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
  const key = (ms: SpireShow[]): string => ms.map((m) => `${m.id}:${m.lit}:${m.y.toFixed(2)}`).sort().join('|');
  check(after.length > 0 && key(after) === key(before), `the spires stand as they stood after the step down (${after.length} of ${before.length})`);
  const budget = await homeBudget(page);
  type T = { calls: number; triangles: number };
  const b = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, Record<string, T>>;
  const own = Object.values(b.milestones ?? {}).reduce((acc, t) => acc + t.calls, 0);
  console.log(`info  at medium from home: ${budget.calls} calls, ${(budget.triangles / 1e6).toFixed(2)}M triangles, the skyline ${own} calls`);
  check(own > 0 && own <= MILESTONE_CALLS.medium && budget.calls < HOME_CALLS && budget.triangles <= HOME_TRIANGLES, `at medium the milestones draw in at most ${MILESTONE_CALLS.medium} calls and the city stays within its budget from home (${own}, ${budget.calls}, ${(budget.triangles / 1e6).toFixed(2)}M)`);
}

// ---------------------------------------------------------------- silhouettes (Task 23)

/**
 * One agent tower of each silhouette from the sample economy, grown to
 * twenty floors and stood in a row off the city (tools/agent-board.ts):
 * silhouettes.png against the dusk sky, then crops of the lens crown, the
 * cantilever's brackets and the needle's spire. Runs after earnedChecks,
 * with the economy seeded.
 */
async function silhouetteChecks(page: Page): Promise<void> {
  const quarters = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const towers = boardTowers(quarters);
  check(
    BOARD_ORDER.every((s) => towers.some((t) => t.silhouette === s)),
    `the economy has an agent of each silhouette (${towers.map((t) => `${t.agentId}: ${t.silhouette}`).join(', ')})`,
  );
  const fr = boardFrame(await cityOf(page), towers.length);
  await page.evaluate(
    ([t, s]) => (window as unknown as { __palimpsest: { agentBoard(t: unknown, s: unknown): Promise<void> } }).__palimpsest.agentBoard(t, s),
    [towers, fr.spots] as const,
  );
  await page.waitForTimeout(1500);
  const tops = towers.map((t) => layoutTower(t).top);
  const shots = new Map<string, string>([
    ['silhouettes', 'silhouettes.png'],
    ['silhouettes-crown', 'silhouettes-crown.png'],
    ['silhouettes-brackets', 'silhouettes-brackets.png'],
    ['silhouettes-spire', 'silhouettes-spire.png'],
  ]);
  for (const [name, eye, target] of boardViews(fr, towers, tops)) {
    const file = shots.get(name);
    if (!file) continue;
    await setView(page, eye, target);
    if (name === 'silhouettes') {
      await debug(page, (x) => x.precompile());
      await page.waitForTimeout(1200);
      const stats = await debug(page, (x) => x.stats());
      const fps = (await page.evaluate(`new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        function tick() {
          frames++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - t0));
        }
        requestAnimationFrame(tick);
      })`)) as number;
      console.log(`info  silhouette board: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
      // The whole row is in frame, the needle's spire included.
      const spire = towers.findIndex((t) => t.silhouette === 'needle');
      const at = (await page.evaluate(
        ([p]) => (window as unknown as { __palimpsest: { project(p: number[]): number[] } }).__palimpsest.project(p),
        [[fr.spots[spire].x, tops[spire] + 12, fr.spots[spire].z]] as [number[]],
      )) as number[];
      check(Math.abs(at[0]) < 1 && Math.abs(at[1]) < 1, `the needle's spire is in frame (${at.map((v) => v.toFixed(2)).join(', ')})`);
    }
    await page.screenshot({ path: join(SHOTS, file) });
  }
  check((await debug(page, (x) => x.quality())) === 'high', 'the silhouette board holds high quality');
  // The board comes down: every later budget sees the city alone.
  await page.evaluate('window.__palimpsest.clearAgentBoard()');
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------- quarters (Task 24)

/**
 * Each firm's quarter in the city (the economy is seeded): quarters.png from
 * a bearing that holds two quarters and a district, their plates readable,
 * a click on an agent's tower picking that agent, and a firm's plate opening
 * the firm. Runs after earnedChecks.
 */
async function quarterChecks(page: Page): Promise<void> {
  const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const firms = (await page.evaluate(() => fetch('/api/firms').then((r) => r.json()))) as FirmView[];
  const standing = qs.filter((q) => q.towers.length > 0);
  check(standing.length >= 2, `the economy has quarters standing (${standing.length})`);
  check((await debug(page, (x) => x.quarters)) === standing.length, `every quarter with a tower stands in the city (${standing.length})`);
  const city = await cityOf(page);
  const quick = standing.find((q) => q.firmId === 'quickset') ?? standing[0];
  const other = standing.find((q) => q !== quick && q.towers.length > 1) ?? standing.find((q) => q !== quick)!;
  const d = city[0];
  const cx = (quick.origin.x + other.origin.x + d.origin.x) / 3;
  const cz = (quick.origin.z + other.origin.z + d.origin.z) / 3;
  await setView(page, [cx + 360, 150, cz + 430], [cx - 10, 30, cz - 30]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(1500);
  const project = (p: number[]): Promise<number[]> =>
    page.evaluate(([q]) => (window as unknown as { __palimpsest: { project(p: number[]): number[] } }).__palimpsest.project(q), [p] as [number[]]) as Promise<number[]>;
  for (const [what, o] of [
    [quick.firmId, quick.origin],
    [other.firmId, other.origin],
    [d.repo, d.origin],
  ] as const) {
    const at = await project([o.x, 10, o.z]);
    check(Math.abs(at[0]) < 1 && Math.abs(at[1]) < 1, `${what} is in the quarters frame (${at.map((v) => v.toFixed(2)).join(', ')})`);
  }
  await page.screenshot({ path: join(SHOTS, 'quarters.png') });
  // Measured once the view has settled: the first seconds after a jump redraw the shadow map and the haze eases.
  await page.waitForTimeout(2500);
  const stats = await debug(page, (x) => x.stats());
  const fps = (await page.evaluate(`new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    function tick() {
      frames++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (performance.now() - t0));
    }
    requestAnimationFrame(tick);
  })`)) as number;
  console.log(`info  quarters: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);

  // The plates: the firm's name, then its agents and books (or bankrupt), and they show.
  const plates = (await page.$$eval('.plate', (els) =>
    els.map((e) => ({
      name: e.querySelector('.plate-name')?.textContent ?? '',
      sub: e.querySelector('.plate-sub')?.textContent ?? '',
      shown: (e as HTMLElement).style.visibility === 'visible' && Number((e as HTMLElement).style.opacity) > 0.5,
    })),
  )) as Array<{ name: string; sub: string; shown: boolean }>;
  for (const q of [quick, other]) {
    const f = firms.find((x) => x.id === q.firmId);
    const p = plates.find((x) => x.name === f?.name);
    check(!!p && p.shown, `${f?.name ?? q.firmId}'s plate reads in the quarters view`);
    if (p) check(/^(\d+ agents?(, \d+ bought)?, -?\d+ credits|bankrupt)$/.test(p.sub), `its plate says "${p.sub}"`);
  }
  const bankrupt = firms.find((f) => f.status === 'bankrupt' && standing.some((q) => q.firmId === f.id));
  if (bankrupt) check(plates.some((p) => p.name === bankrupt.name && p.sub === 'bankrupt'), `${bankrupt.name}'s plate says bankrupt`);

  // Picking an agent's tower: look at its root and click the middle of the screen.
  const t = quick.towers[0];
  const off = QUARTER_OFFSETS[t.towerIndex ?? 0];
  const x0 = quick.origin.x + off.x;
  const z0 = quick.origin.z + off.z;
  await setView(page, [x0 + 40, 14, z0 + 40], [x0, 8, z0]);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(300);
  const pick = await debug(page, (x) => x.lastPick);
  check(pick?.kind === 'agent' && pick.agentId === t.agentId, `clicking an agent's tower picks kind 'agent' (got ${JSON.stringify(pick)})`);
  check((await debug(page, (x) => x.opened)) === `#/agents/${t.agentId}`, 'and opens its agent page');
  // A firm's plate opens the firm.
  await setView(page, [cx + 360, 150, cz + 430], [cx - 10, 30, cz - 30]);
  const name = firms.find((f) => f.id === quick.firmId)?.name ?? '';
  await page.waitForTimeout(1200);
  // The plate may sit behind a tower from here; its button is what is tested.
  await page.locator('.plate', { hasText: name }).first().dispatchEvent('click');
  check((await debug(page, (x) => x.opened)) === `#/firms/${quick.firmId}`, `${name}'s plate opens the firm`);
  await page.evaluate(() => {
    location.hash = '#/';
  });
  check((await debug(page, (x) => x.quality())) === 'high', 'the quarters hold high quality');
}

// ---------------------------------------------------------------- dark towers and the re-clad (Task 28)

type QShow = { plate: string; court: number; settled: boolean; towers: Array<{ agentId: string; lit: number; scaffold: number; phase: string; root: string; firmId: string }> };
const quarterShowOf = (page: Page, firmId: string): Promise<QShow | null> =>
  page.evaluate((f) => (window as unknown as { __palimpsest: { quarterShow(f: string): QShow | null } }).__palimpsest.quarterShow(f), firmId);

/**
 * The sample economy's Lodestar, bankrupt with its tower not yet sold
 * (seeded with holdSale): every pane out, its court's lamps out, its plate
 * bankrupt, shot as dark-tower.png. Then the treasury sells the tower live
 * (the same tower.sold a daily tick sends): the scaffold rises, the floors
 * rebuild in the buyer's root, the scaffold comes down and the windows
 * relight, shot as reclad.png; the buyer's plate counts the tower bought.
 */
async function darkTowerChecks(page: Page): Promise<void> {
  const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const lode = qs.find((q) => q.firmId === 'lodestar');
  check(!!lode && lode.dark && lode.towers.length === 1 && lode.towers[0].dark === true, 'the economy holds Lodestar bankrupt with its tower dark');
  if (!lode) return;
  const t = lode.towers[0];
  const off = QUARTER_OFFSETS[t.towerIndex ?? 0];
  const x = lode.origin.x + off.x;
  const z = lode.origin.z + off.z;
  const dark = await quarterShowOf(page, 'lodestar');
  check(!!dark && dark.plate === 'bankrupt' && dark.court === 0 && dark.towers.every((x) => x.lit === 0), `its windows and court lamps are out (${JSON.stringify(dark)})`);
  const plates = (await page.$$eval('.plate', (els) => els.map((e) => ({ name: e.querySelector('.plate-name')?.textContent ?? '', sub: e.querySelector('.plate-sub')?.textContent ?? '' })))) as Array<{ name: string; sub: string }>;
  check(plates.some((p) => p.name === 'Lodestar' && p.sub === 'bankrupt'), 'its plate reads bankrupt');
  await setView(page, [x + 95, 26, z + 120], [x - 2, 24, z]);
  await debug(page, (d) => d.precompile());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, 'dark-tower.png') });
  const builds = await debug(page, (d) => d.builds);

  const { sellDarkTowers } = await import('../engine/market/treasury.js');
  sellDarkTowers(Date.now());
  const sold = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const buyer = sold.find((q) => q.firmId === 'lodestar')?.towers[0];
  check(!!buyer && buyer.firmId !== 'lodestar' && buyer.dark === false, `the tower is sold and stays on its plot (${buyer?.firmId})`);
  const rose = await page
    .waitForFunction(() => {
      const s = (window as unknown as { __palimpsest: { quarterShow(f: string): { towers: Array<{ scaffold: number; phase: string }> } | null } }).__palimpsest.quarterShow('lodestar');
      return !!s && s.towers.some((x) => x.phase === 'rising' && x.scaffold > 0.2);
    }, null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(rose, 'a scaffold rises up the dark tower');
  const done = await page
    .waitForFunction(() => (window as unknown as { __palimpsest: { quarterShow(f: string): { settled: boolean } | null } }).__palimpsest.quarterShow('lodestar')?.settled === true, null, { timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  const end = await quarterShowOf(page, 'lodestar');
  const tw = end?.towers[0];
  const buyerQ = sold.find((q) => q.firmId === buyer?.firmId);
  check(done && !!tw && tw.lit === 1 && tw.scaffold === 0 && tw.firmId === buyer?.firmId && tw.root === buyerQ?.root, `the re-clad ends in the buyer's root with its windows relit (${JSON.stringify(tw)})`);
  check((await debug(page, (d) => d.builds)) - builds <= 2, 'the quarter rebuilt once, behind the scaffold');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, 'reclad.png') });
  const fps = await pageFps(page);
  const stats = await debug(page, (d) => d.stats());
  console.log(`info  re-clad: ${fps.toFixed(0)} fps, ${stats.calls} draw calls`);
  await page.waitForTimeout(1200);
  const after = (await page.$$eval('.plate', (els) => els.map((e) => ({ name: e.querySelector('.plate-name')?.textContent ?? '', sub: e.querySelector('.plate-sub')?.textContent ?? '' })))) as Array<{ name: string; sub: string }>;
  check(after.some((p) => / 1 bought,/.test(p.sub)), `the buyer's plate lists the tower it bought (${after.map((p) => p.sub).join(' | ')})`);
}

// ---------------------------------------------------------------- live construction (Task 26)

/**
 * The sample economy's live mode, ticked on demand at speed 20 (test safety
 * rule 8): its working run frames a floor on its repo's tower. The crane
 * stands on the roof and the frame at the new floor's height; each tick of
 * real progress adds beams, and with no tick nothing on the site advances.
 * construction.png close on the crane mid-weld, a four-frame strip of real
 * progress steps, and the frame rate held within 5 of the overview.
 */
/**
 * The city's frame budget from home (task PERF, tightened in Task 30 once
 * the transit network stood): vehicles and crowds add to it, and this check
 * fails if the city outgrows it silently. The governor's own budget is 24M
 * (governor.ts).
 */
const HOME_TRIANGLES = 12_000_000;
const HOME_CALLS = 850;

/** A frame from the home framing with the shadow map redrawn: its draw calls and triangles, and the biggest subsystems. */
async function homeBudget(page: Page): Promise<{ calls: number; triangles: number; parts: string }> {
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(1200);
  type T = { calls: number; triangles: number };
  const b = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, Record<string, T>>;
  const sum = (p: Record<string, T>): T => Object.values(p).reduce((a, t) => ({ calls: a.calls + t.calls, triangles: a.triangles + t.triangles }), { calls: 0, triangles: 0 });
  const total = sum(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, sum(v)])));
  const parts = Object.entries(b)
    .map(([k, v]) => [k, sum(v)] as const)
    .sort((x, y) => y[1].triangles - x[1].triangles)
    .slice(0, 4)
    .map(([k, t]) => `${k} ${(t.triangles / 1e6).toFixed(2)}M/${t.calls}`)
    .join(', ');
  return { ...total, parts };
}

async function constructionChecks(page: Page): Promise<void> {
  type SV = { stage: string; progress: number; beams: number; beamsTotal: number; columns: number; crane: number[]; weld: number[] | null; arc: number; top: number; floorHeight: number; centre: number[] };
  type Dbg = { liveSites(): Array<{ repo: string; stage: string }>; site(r: string): SV | null };
  const { setMarketExtras } = await import('../engine/market/api.js');
  const { economyClock, economySites } = await import('../engine/market/sample-economy.js');
  setMarketExtras({ sites: economySites });
  const clock = economyClock({ now: () => Date.now(), speed: 20 });
  try {
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    await fullDensity(page);
    const found = await page
      .waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().some((s) => s.stage === 'framing'), null, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check(found, 'the economy has a site framing a floor');
    if (!found) return;
    const repo = (await page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().find((s) => s.stage === 'framing')!.repo)) as string;
    const view = (): Promise<SV | null> => page.evaluate((r) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r), repo);
    const tick = async (ms: number): Promise<void> => {
      clock.tick(ms);
      await clock.idle();
      await page.waitForTimeout(500);
    };
    await tick(1000);
    let s = await view();
    check(!!s && s.stage === 'framing', `the site frames (${s?.stage})`);
    if (!s) return;
    const city = await cityOf(page);
    const d = city.find((x) => x.repo === repo)!;
    check(Math.abs(s.top - layoutTower(d.tower).top) < 0.05, `the site stands on the tower's roof (${s.top.toFixed(1)} m)`);
    check(Math.abs(s.crane[1] - s.top) < 0.05, 'the crane stands on the roof');
    check(s.beams === Math.round(s.beamsTotal * s.progress), `the frame shows its progress (${s.beams} of ${s.beamsTotal} beams at ${s.progress})`);
    // No event, no progress: the frame holds.
    await page.waitForTimeout(2000);
    const held = await view();
    check(held?.beams === s.beams && held?.progress === s.progress, 'between events the frame holds still');

    // The ride up a framing tower takes the crew's hoist and ends at the work (Task 35).
    check(await page.evaluate(`window.__palimpsest.ride(${JSON.stringify(repo)})`) === true, 'a framing tower can be ridden');
    await page.evaluate('window.__palimpsest.rideHold(true)');
    const hr = await ridingNow(page);
    check(hr?.hoist === true, 'the ride up a framing tower takes the crew’s hoist');
    if (hr) {
      const work = hr.stops[hr.stops.length - 1];
      await page.evaluate(`window.__palimpsest.rideSeek(${work.t + 2})`);
      await page.waitForTimeout(600);
      const at = await ridingNow(page);
      check(/is framing floor \d+$/.test(at?.caption ?? ''), `and ends with the framing caption (${at?.caption})`);
      check(!!at && Math.abs(at.car - s.top) < 0.6, `the hoist car ends at the work on its mast (${at?.car.toFixed(1)} m against the roof at ${s.top.toFixed(1)} m)`);
      await page.screenshot({ path: join(SHOTS, 'ride-hoist.png') });
    }
    await page.evaluate('window.__palimpsest.ride(null)');
    await page.waitForTimeout(2000);

    const [cx, , cz] = s.crane;
    const eye: [number, number, number] = [cx - 70, s.top + 22, cz + 62];
    const target: [number, number, number] = [cx + 4, s.top + 12, cz - 2];
    await setView(page, eye, target);
    await debug(page, (x) => x.precompile());
    await page.waitForTimeout(1500);
    const midWeld = async (): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        await page.waitForFunction((r) => ((window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r)?.arc ?? 0) > 0.3, repo, { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(300);
        if (((await view())?.arc ?? 0) > 0.3) return;
      }
    };
    await midWeld();
    await page.screenshot({ path: join(SHOTS, 'construction.png') });
    await page.waitForTimeout(1500);
    const stats = await debug(page, (x) => x.stats());
    const fps = await pageFps(page);
    console.log(`info  construction: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
    check(fps >= overviewFps - 5, `the site holds the frame rate within 5 of the overview (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);

    // The strip: four real progress steps from the same eye; each adds steel.
    let last = s.beams;
    for (let i = 0; i < 4; i++) {
      await tick(2200);
      s = await view();
      if (!s) break;
      await page.waitForTimeout(2500);
      await midWeld();
      await page.screenshot({ path: join(SHOTS, `construction-strip-${i}.png`) });
      console.log(`info  strip ${i}: ${s.stage} at ${s.progress}, ${s.beams} of ${s.beamsTotal} beams`);
      check(s.beams >= last, `step ${i} never takes steel away (${last} to ${s.beams})`);
      last = s.beams;
    }
    check(last > (held?.beams ?? 0), 'the frame rose over the strip');
    await debug(page, (x) => (x as unknown as { home(): void }).home());
    await page.waitForTimeout(2500);
    const home = await debug(page, (x) => x.stats());
    const homeFps = await pageFps(page);
    console.log(`info  city from home with live sites: ${homeFps.toFixed(0)} fps, ${home.calls} draw calls, ${(home.triangles / 1e6).toFixed(2)}M triangles`);
    check(homeFps >= overviewFps - 5, `the city from home holds its frame rate with live sites (${homeFps.toFixed(0)} fps)`);
    // What the sites cost from home: every site is drawn in a few batches, so all of them together add under 60 calls.
    // Both sides are measured the same way (homeBudget: the shadow map redrawn, every pass counted), so a shadow
    // redraw or a level-of-detail step in one single frame and not the other can never read as the sites' cost.
    const nSites = (await page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().length)) as number;
    const withSites = await homeBudget(page);
    await page.evaluate(() => (window as unknown as { __palimpsest: { showSites(on: boolean): void } }).__palimpsest.showSites(false));
    await page.waitForTimeout(800);
    const bare = await homeBudget(page);
    await page.evaluate(() => (window as unknown as { __palimpsest: { showSites(on: boolean): void } }).__palimpsest.showSites(true));
    const added = withSites.calls - bare.calls;
    console.log(`info  the ${nSites} live sites add ${added} draw calls from home`);
    check(nSites >= 3 && added < 60, `${nSites} live sites add fewer than 60 draw calls from home (${added})`);
    // The city's budget from home (task PERF): a frame with the shadow map redrawn, every pass counted.
    let full = await homeBudget(page);
    console.log(`info  city from home with live sites, shadow map redrawn: ${full.calls} draw calls, ${(full.triangles / 1e6).toFixed(2)}M triangles (${full.parts})`);
    // The governor judges frame time as well as triangles: on a GPU another test or capture shares, it can step
    // down on a slow stretch the city did not cause. Once, the page is opened afresh and the budget measured again.
    if ((await debug(page, (x) => x.quality())) !== 'high') {
      console.log(`info  the governor stepped down at ${(full.triangles / 1e6).toFixed(2)}M triangles; reopening once (a shared GPU)`);
      await page.reload();
      await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
      await fullDensity(page);
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().length >= 3, null, { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(6000);
      full = await homeBudget(page);
      console.log(`info  again: ${full.calls} draw calls, ${(full.triangles / 1e6).toFixed(2)}M triangles (${full.parts})`);
    }
    check(full.triangles <= HOME_TRIANGLES, `the city from home draws at most ${HOME_TRIANGLES / 1e6}M triangles with live sites and the shadow map redrawn (${(full.triangles / 1e6).toFixed(2)}M)`);
    check(full.calls < HOME_CALLS, `the city from home draws in under ${HOME_CALLS} calls with live sites and the shadow map redrawn (${full.calls})`);
    check((await debug(page, (x) => x.quality())) === 'high', 'the quality governor has not stepped the city down');
  } finally {
    clock.stop();
    setMarketExtras({});
  }
}

// ---------------------------------------------------------------- inspection, the cure and the scar (Task 27)

/**
 * The rest of a run's life on its site, every step a real event from the
 * economy's clock: a run under inspection is swept by two searchlights from
 * the plaza edge (inspection.png); a PR that merges lights its floor's
 * windows row by row and its crane comes down (cured.png); an inspection the
 * clock is told to fail strikes the site onto its scar floor and leaves one
 * work lamp burning (scar.png). Runs after constructionChecks.
 */
async function lifecycleChecks(page: Page): Promise<void> {
  type SV = {
    stage: string;
    progress: number;
    runId: string;
    crane: number[];
    top: number;
    floorHeight: number;
    centre: number[];
    searchlights: Array<{ at: number[]; end: number[] }>;
    frameFade: number;
    strike: number;
    dismantle: number;
    floor: string | null;
    era: string | null;
    windows: number | null;
    workLamp: number[] | null;
    busy: boolean;
    panes: number;
  };
  type Dbg = { liveSites(): Array<{ repo: string; stage: string; progress: number; runId: string }>; site(r: string): SV | null; home(): void };
  const { setMarketExtras } = await import('../engine/market/api.js');
  const { economyClock, economySites } = await import('../engine/market/sample-economy.js');
  setMarketExtras({ sites: economySites });
  const sites = (): Promise<Array<{ repo: string; stage: string; progress: number; runId: string }>> => page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites());
  const view = (repo: string): Promise<SV | null> => page.evaluate((r) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r), repo);
  // The repo whose inspection the clock fails: the one still working (the other passed during the construction checks).
  const working = (await sites()).find((s) => s.stage === 'framing')?.repo ?? 'tidewater/harbor-ledger';
  const clock = economyClock({ now: () => Date.now(), speed: 20, fail: [working] });
  const B = [0.63, 0.78];
  const tick = async (ms: number): Promise<void> => {
    clock.tick(ms);
    await clock.idle();
    await page.waitForTimeout(350);
  };
  /** Ticks the clock a second at a time until a site shows `stage` (and the test's own condition), or gives up. */
  const until = async (want: (s: { repo: string; stage: string; progress: number }) => boolean, ms = 1000, tries = 40): Promise<string | null> => {
    for (let i = 0; i < tries; i++) {
      const hit = (await sites()).find(want);
      if (hit) return hit.repo;
      await tick(ms);
    }
    return null;
  };
  try {
    // inspection.png: the guild's two searchlights sweep the finished frame from the plaza's edge.
    const insp = await until((s) => s.stage === 'inspecting');
    check(!!insp, 'a site comes under inspection on the clock');
    if (insp) {
      const s = (await view(insp))!;
      check(s.searchlights.length === 2, `two searchlights sweep the inspected floor (${s.searchlights.length})`);
      const [cx, cz] = s.centre;
      for (const l of s.searchlights) {
        const r = Math.hypot(l.at[0] - cx, l.at[2] - cz);
        check(r > 56 && r < 70 && l.at[1] < 3, `a searchlight stands on a tripod at the plaza edge (${r.toFixed(1)} m out, ${l.at[1].toFixed(1)} m up)`);
        check(l.end[1] > s.top - 0.5 && l.end[1] < s.top + s.floorHeight + 1.4 && Math.hypot(l.end[0] - cx, l.end[2] - cz) < 22, `its beam ends on the new floor (${l.end.map((v) => v.toFixed(0)).join(', ')})`);
      }
      const a0 = s.searchlights[0].end;
      await page.waitForTimeout(3000);
      const a1 = (await view(insp))!.searchlights[0]?.end ?? a0;
      check(Math.hypot(a1[0] - a0[0], a1[2] - a0[2]) > 0.5, 'the beams sweep between events');
      await setView(page, [cx + B[0] * 70 + 25, s.top - 70, cz + B[1] * 70 - 20], [cx, s.top + 1, cz]);
      await debug(page, (x) => x.precompile());
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SHOTS, 'inspection.png') });
      await page.waitForTimeout(1000);
      const stats = await debug(page, (x) => x.stats());
      const fps = await pageFps(page);
      console.log(`info  inspection: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
      check(fps >= overviewFps - 5, `the searchlights hold the frame rate (${fps.toFixed(0)} fps)`);
      await debug(page, (x) => (x as unknown as { home(): void }).home());
      await page.waitForTimeout(2500);
      const home = await debug(page, (x) => x.stats());
      const homeFps = await pageFps(page);
      console.log(`info  city from home under inspection: ${homeFps.toFixed(0)} fps, ${home.calls} draw calls`);
      check(homeFps >= overviewFps - 5, `the city from home holds its frame rate under inspection (${homeFps.toFixed(0)} fps)`);
    }

    // cured.png: a PR merges: its floor's windows light row by row and its crane climbs down; nothing of the site is left.
    const lit = await until((s) => s.stage === 'curing' && s.progress >= 1, 1000, 30);
    check(!!lit, 'a merged site cures on the clock');
    if (lit) {
      await page.waitForTimeout(1200);
      const mid = (await view(lit))!;
      check(mid.windows !== null && mid.windows > 0, `the merged floor's windows light (${mid.windows})`);
      await page.waitForTimeout(12_000);
      const s = (await view(lit))!;
      // A floor whose era draws its glazing as panes lights them row by row; one that draws none (a sci-fi skin) has none to light.
      console.log(`info  merged floor: ${s.era}, ${s.panes} panes lit row by row`);
      check(s.windows === 1, `every row of the floor is lit (${s.panes} panes)`);
      check(s.crane.length === 0 && s.dismantle === 1, 'the crane has climbed down and is gone');
      check(s.floor === 'era' && s.frameFade === 0, `the frame has cured into the floor's ${s.era} finish`);
      const [cx, cz] = s.centre;
      await setView(page, [cx + B[0] * 42 + 6, s.top + 12, cz + B[1] * 42 - 6], [cx, s.top + s.floorHeight * 0.5, cz]);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SHOTS, 'cured.png') });
    }

    // scar.png: the failed inspection strikes the site onto its primer floor, one work lamp left burning.
    const scar = await until((s) => s.stage === 'scar', 1000, 40);
    check(scar === working, `the failed inspection leaves a scar on ${working} (${scar})`);
    if (scar) {
      const s0 = (await view(scar))!;
      await page.waitForTimeout(7500);
      const s = (await view(scar))!;
      check(s.strike === 1 && s.crane.length === 0, 'the skeleton is struck and the crane taken down');
      check(s.floor === 'primer' && !!s.workLamp, 'the site ends on its primer floor with a work lamp burning');
      const city = await cityOf(page);
      const floors = city.find((d) => d.repo === scar)?.tower.floors ?? [];
      check(floors.some((f) => f.id === `${scar}#scar-${s0.runId}` && f.earned?.state === 'scar'), 'the tower carries the scar floor');
      const lamp = s.workLamp!;
      check(lamp[1] > s.top && lamp[1] < s.top + s.floorHeight, `the lamp burns on the scar floor (${lamp[1].toFixed(1)} m, floor ${s.top.toFixed(1)} to ${(s.top + s.floorHeight).toFixed(1)})`);
      const [cx, cz] = s.centre;
      await setView(page, [cx + B[0] * 40 + 8, s.top + 9, cz + B[1] * 40 - 4], [cx + 2, s.top + s.floorHeight * 0.45, cz + 2]);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SHOTS, 'scar.png') });
      // For the rest of the evening: no event moves it, and the lamp still burns.
      await page.waitForTimeout(3000);
      check(!!(await view(scar))?.workLamp, 'the work lamp is still burning with no event since');
    }
  } finally {
    clock.stop();
    setMarketExtras({});
  }
}

// ---------------------------------------------------------------- the exchange (Task 25)

/**
 * The civic exchange on the plaza at the origin (the economy is seeded): its
 * tote board lights one slot per bidding job with a lamp per real bid, dark
 * for the open one; exchange.png close on the hall at dusk; clicking the hall
 * opens #/jobs; the fountain stills while the engine is stopped and runs again
 * when it resumes. Runs after earnedChecks.
 */
async function exchangeChecks(page: Page): Promise<void> {
  type Ex = { exchange(): { slots: Array<{ state: string; lamps: number; label?: string }>; running: boolean } | null };
  const jobs = (await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()))) as Array<{ id: string; status: string; repo: string; issue: number | null }>;
  const posted = jobs.filter((j) => j.status === 'open' || j.status === 'bidding');
  const bids = await Promise.all(
    posted.map((j) => page.evaluate((id) => fetch(`/api/jobs/${id}`).then((r) => r.json()).then((d: { bids: unknown[] }) => d.bids.length), j.id) as Promise<number>),
  );
  const bidding = posted.filter((j) => j.status === 'bidding');
  check(bidding.length === 3, `the economy has three jobs taking bids, two issues and the proposal he accepted (${bidding.length})`);
  const want = posted.map((j, i) => ({ state: j.status, lamps: j.status === 'bidding' ? Math.min(6, bids[i]) : 0 }));
  const shows = await page
    .waitForFunction(
      (w) => {
        const ex = (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange();
        return !!ex && JSON.stringify(ex.slots.filter((s) => s.state !== 'empty').map((s) => ({ state: s.state, lamps: s.lamps }))) === JSON.stringify(w);
      },
      want,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  const ex = await page.evaluate(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange());
  check(shows, `the tote board shows each posted job with a lamp per real bid (want ${JSON.stringify(want)}, got ${JSON.stringify(ex?.slots.filter((s) => s.state !== 'empty'))})`);
  check(ex?.slots.filter((s) => s.state === 'bidding').length === 3, 'three slots are lit');
  check(ex?.slots.filter((s) => s.state === 'empty').length === 24 - posted.length, 'every other slot stands dark');
  check(!!ex?.slots.filter((s) => s.state !== 'empty').every((s) => !!s.label && !/[/~]|ghp_|sk-/.test(s.label)), `cards carry only a repo's short name and an issue number (${ex?.slots.filter((s) => s.label).map((s) => s.label).join(', ')})`);
  // The exchange's plate on its forecourt, in counts.
  const plate = await page.$$eval('.plate', (els) => els.map((e) => `${e.querySelector('.plate-name')?.textContent}|${e.querySelector('.plate-sub')?.textContent}`).find((t) => t.startsWith('The exchange|')) ?? '');
  check(plate === `The exchange|${posted.length} jobs posted, 3 taking bids`, `the exchange's plate reads (${plate})`);

  // exchange.png: close on the hall at dusk, the three bidding slots lit under the clock.
  await setView(page, [30, 12, 82], [0, 24, -6]);
  await debug(page, (x) => x.precompile());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, 'exchange.png') });
  await page.waitForTimeout(1500);
  const stats = await debug(page, (x) => x.stats());
  const fps = (await page.evaluate(`new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    function tick() {
      frames++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (performance.now() - t0));
    }
    requestAnimationFrame(tick);
  })`)) as number;
  console.log(`info  exchange: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);

  // Clicking the hall opens the job board.
  await setView(page, [0, 12, 70], [0, 18, 0]);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(300);
  const pick = await debug(page, (x) => x.lastPick);
  check(pick?.kind === 'exchange', `clicking the hall picks the exchange (got ${JSON.stringify(pick)})`);
  check((await page.evaluate(() => location.hash)) === '#/jobs', 'and opens #/jobs');
  await page.evaluate(() => {
    location.hash = '#/';
  });

  // The kill switch stills the fountain; clearing it runs the water again.
  const stop = (on: boolean): Promise<unknown> =>
    page.evaluate((v) => fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-palimpsest': '1' }, body: JSON.stringify({ on: v }) }).then((r) => r.json()), on);
  const running = (): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange()?.running);
  check((await running()) === true, 'the fountain runs while the engine runs');
  await stop(true);
  const stilled = await page
    .waitForFunction(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange()?.running === false, null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(stilled, 'the fountain stops when the engine is stopped');
  await stop(false);
  const again = await page
    .waitForFunction(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange()?.running === true, null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(again, 'and runs again when it resumes');
  check((await debug(page, (x) => x.quality())) === 'high', 'the exchange holds high quality');
}

// ---------------------------------------------------------------- inspector

async function inspectorChecks(page: Page): Promise<void> {
  const ds = await cityOf(page);
  const d = ds.find((x) => x.tower.floors.length > 0);
  if (!d) {
    check(false, 'a district with floors exists for the inspector');
    return;
  }
  // Look square at the middle of the first tower and click it.
  const lay = layoutTower(d.tower);
  const target: [number, number, number] = [d.origin.x, lay.top * 0.55, d.origin.z];
  const dist = lay.top * 2.4;
  await setView(page, [d.origin.x + BEARING.x * dist, lay.top * 0.5, d.origin.z + BEARING.z * dist], target);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  const opened = await page
    .waitForSelector('.inspector.open', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(opened, 'clicking a tower opens the inspector');
  if (!opened) return;
  await page.waitForTimeout(1200);
  const rows = await page.locator('.insp-floor').count();
  check(rows === d.tower.floors.length, `the inspector lists every floor (${rows} of ${d.tower.floors.length})`);
  const name = await page.locator('.insp-name').textContent();
  check(name === d.repo.split('/')[1], `the inspector names the repo (got ${name})`);
  await page.screenshot({ path: join(SHOTS, 'inspector-open.png') });

  // Click a row a third of the way down: the camera flies to it and the floor is marked.
  const before = await debug(page, (x) => x.camera());
  const pick = Math.floor(rows / 3);
  await page.locator('.insp-floor').nth(pick).click();
  await page.waitForTimeout(2200);
  const after = await debug(page, (x) => x.camera());
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  check(moved > 1, `clicking a floor row moves the camera (${moved.toFixed(1)} m)`);
  const floorId = d.tower.floors[d.tower.floors.length - 1 - pick].id;
  const hl = await debug(page, (x) => x.highlight);
  check(hl?.floorId === floorId, `the clicked floor is highlighted (got ${hl?.floorId ?? 'nothing'})`);
  await page.screenshot({ path: join(SHOTS, 'inspector-floor.png') });

  // Keyboard: arrows move the selection down the list, Enter flies, Escape closes.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const next = await debug(page, (x) => x.highlight);
  const want = d.tower.floors[d.tower.floors.length - 3 - pick].id;
  check(next?.floorId === want, `arrow keys move between floors (got ${next?.floorId ?? 'nothing'})`);
  const pre = await debug(page, (x) => x.camera());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const post = await debug(page, (x) => x.camera());
  check(Math.hypot(post[0] - pre[0], post[1] - pre[1], post[2] - pre[2]) > 0.5, 'Enter flies to the selected floor');
  await page.screenshot({ path: join(SHOTS, 'inspector-keyboard.png') });

  // A refresh for another repo must leave keyboard focus in the list: arrows still move the selection.
  const { emit } = await import('../engine/events.js');
  const focusedBefore = await debug(page, (x) => x.highlight);
  emit('repo.analyzed', { repo: { fullName: SAMPLE[1].fullName } });
  await page.waitForTimeout(1200);
  const inPanel = await page.evaluate(() => !!document.activeElement?.closest('.inspector'));
  check(inPanel, 'focus stays in the inspector across a refresh for another repo');
  await page.keyboard.press('ArrowDown');
  const afterRefresh = await debug(page, (x) => x.highlight);
  check(
    afterRefresh !== null && afterRefresh.floorId !== focusedBefore?.floorId,
    `arrow keys still move the selection after a refresh (got ${afterRefresh?.floorId ?? 'nothing'})`,
  );

  // The highlight from further out, to judge whether it reads at distance.
  await setView(page, [d.origin.x + BEARING.x * 420, 90, d.origin.z + BEARING.z * 420], [d.origin.x, lay.top * 0.5, d.origin.z]);
  await page.screenshot({ path: join(SHOTS, 'inspector-far.png') });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, 'inspector-1280.png') });
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(!(await page.locator('.inspector').isVisible()), 'Escape closes the inspector');
  check((await debug(page, (x) => x.highlight)) === null, 'closing clears the floor highlight');
}

// ---------------------------------------------------------------- the ride up a tower (Task 35)

type RideProbe = { key: string; t: number; length: number; car: number; eye: number; floorId: string | null; caption: string | null; held: boolean; hoist: boolean; stops: Array<{ t: number; dwell: number; mark: string | null; title: string | null }> };
const ridingNow = (page: Page): Promise<RideProbe | null> => page.evaluate('window.__palimpsest.riding()') as Promise<RideProbe | null>;

/**
 * The ride: the inspector's Ride up starts it at street level, the camera climbs with the car over the first
 * seconds and a floor's caption shows; Escape steps off and the view returns. R rides from the keyboard, and the
 * agent page's Ride up rides the agent's own tower.
 */
async function rideChecks(page: Page): Promise<void> {
  const ds = await cityOf(page);
  const d = [...ds].sort((a, b) => b.tower.floors.length - a.tower.floors.length)[0];
  const lay = layoutTower(d.tower);
  await setView(page, [d.origin.x + BEARING.x * lay.top * 2.2, lay.top * 0.45, d.origin.z + BEARING.z * lay.top * 2.2], [d.origin.x, lay.top * 0.5, d.origin.z]);
  await page.waitForTimeout(400);
  await page.evaluate((repo) => (window as unknown as { __palimpsest: Debug }).__palimpsest.inspect(repo), d.repo);
  await page.waitForSelector('.inspector.open', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const button = page.locator('.inspector .insp-ride');
  check((await button.count()) === 1 && /Ride up/.test((await button.textContent()) ?? ''), 'the inspector offers Ride up');
  const before = await debug(page, (x) => x.camera());
  await button.click();
  // The camera comes to the car at street level, then climbs with it.
  const started = await page.waitForFunction('(window.__palimpsest.riding()?.t ?? -1) >= 0', null, { timeout: 6000 }).then(() => true, () => false);
  check(started, 'Ride up starts a ride');
  const r0 = await ridingNow(page);
  check(r0 !== null && r0.car < 1 && r0.eye < 3, `the ride starts at street level (car ${r0?.car.toFixed(1)} m)`);
  check(await page.evaluate(() => document.querySelector('.inspector')?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) === false && document.querySelector('.ride.on') !== null), 'the panel steps aside and the captions show');
  const y0 = (await debug(page, (x) => x.camera()))[1];
  await page.waitForTimeout(3000);
  const y1 = (await debug(page, (x) => x.camera()))[1];
  check(y1 > y0 + 4, `starting a ride moves the camera up over 3 s (${y0.toFixed(1)} to ${y1.toFixed(1)} m)`);
  const titles = new Set(d.tower.floors.map((f) => f.title.replace(/^Failed inspection:\s*/, '')));
  const captioned = await page
    .waitForFunction((t) => t.includes(document.querySelector('.ride .ride-title')?.textContent ?? ''), [...titles], { timeout: 30_000 })
    .then(() => true, () => false);
  const shown = await page.locator('.ride .ride-title').textContent();
  check(captioned, `the caption shows a floor title (${shown})`);
  await page.screenshot({ path: join(SHOTS, 'ride-mid.png') });
  const rideFps = await pageFps(page);
  console.log(`info  riding: ${rideFps.toFixed(0)} fps`);
  check(rideFps >= overviewFps - 5, `a ride holds the overview's frame rate (${rideFps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  // Space goes on to the next stop at once.
  const beforeSkip = await ridingNow(page);
  const nextStop = beforeSkip?.stops.find((x) => x.t > beforeSkip.t + 1e-3);
  await page.keyboard.press(' ');
  await page.waitForTimeout(150);
  const afterSkip = await ridingNow(page);
  check(!!nextStop && !!afterSkip && afterSkip.t >= nextStop.t && afterSkip.t < nextStop.t + 0.6, `Space skips to the next stop (${beforeSkip?.t.toFixed(1)} to ${afterSkip?.t.toFixed(1)} s, the stop at ${nextStop?.t.toFixed(1)})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await ridingNow(page)) === null, 'Escape ends the ride');
  check(await page.locator('.inspector').isVisible(), 'and leaves the inspector open');
  await page.waitForTimeout(2200);
  const back = await debug(page, (x) => x.camera());
  const off = Math.hypot(back[0] - before[0], back[1] - before[1], back[2] - before[2]);
  check(off < 1.5, `Escape restores the view (${off.toFixed(2)} m from where it stood)`);
  check((await page.locator('.ride').count()) === 0, 'and the captions go');

  // With reduced motion the ride cuts from stop to stop: the car stands still at each, then is at the next.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const stillFrom = await debug(page, (x) => x.camera());
  await page.evaluate(`window.__palimpsest.ride(${JSON.stringify(d.repo)})`);
  await page.waitForTimeout(900);
  const s0 = await ridingNow(page);
  await page.waitForTimeout(700);
  const s1 = await ridingNow(page);
  await page.waitForTimeout(2200);
  const s2 = await ridingNow(page);
  check(s0 !== null && s1 !== null && s0.car === s1.car && s2 !== null && s2.car > s1.car + 2, `with reduced motion the ride cuts from stop to stop (${s0?.car.toFixed(1)}, ${s1?.car.toFixed(1)}, ${s2?.car.toFixed(1)} m)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const stillBack = await debug(page, (x) => x.camera());
  const cut = Math.hypot(stillBack[0] - stillFrom[0], stillBack[1] - stillFrom[1], stillBack[2] - stillFrom[2]);
  check(cut < 0.5, `with reduced motion Escape cuts straight back (${cut.toFixed(2)} m off after 0.15 s)`);
  await page.emulateMedia({ reducedMotion: null });
  await page.waitForTimeout(500);

  // R rides the open tower from the keyboard.
  await page.locator('.inspector .insp-ride').focus();
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  check((await ridingNow(page))?.key === d.repo, 'R rides the tower open in the inspector');
  // A drag takes the camera back where it stands.
  await page.waitForTimeout(2600);
  const mid = await debug(page, (x) => x.camera());
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.mouse.down();
  await page.mouse.move(VIEWPORT.width / 2 + 30, VIEWPORT.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragged = await debug(page, (x) => x.camera());
  check((await ridingNow(page)) === null && Math.hypot(dragged[0] - mid[0], dragged[1] - mid[1], dragged[2] - mid[2]) < 25, 'a drag ends the ride where it stands');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** The agent page's Ride up rides the agent's own tower (once the firms' quarters stand). */
async function rideAgentChecks(page: Page): Promise<void> {
  const firms = (await page.evaluate(() => fetch('/api/firms').then((r) => r.json()))) as Array<{ agents: Array<{ id: string; retired: boolean }> }>;
  const quarters = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
  const standing = new Set(quarters.flatMap((q) => q.towers.filter((t) => !t.dark).map((t) => t.agentId)));
  const agent = firms.flatMap((f) => f.agents).find((a) => !a.retired && standing.has(a.id));
  if (!agent) {
    check(false, 'an agent with a standing tower to ride');
    return;
  }
  await page.evaluate((id) => {
    location.hash = `#/agents/${id}`;
  }, agent.id);
  await page.waitForSelector('.agentpage .agent-ride', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.locator('.agentpage .agent-ride').click();
  await page.waitForTimeout(1200);
  const route = await page.evaluate(() => document.body.dataset.route);
  const a = await ridingNow(page);
  check(route === 'city' && a?.key === `agent:${agent.id}`, `the agent page's Ride up rides its tower (${route}, ${a?.key ?? 'no ride'})`);
  // Step off is a tap too: a touch screen has no Escape.
  await page.locator('.ride .ride-off').click();
  await page.waitForTimeout(300);
  check((await ridingNow(page)) === null, 'and tapping Step off steps off it');
  await page.waitForTimeout(1800);
}

// ---------------------------------------------------------------- an analyzing site

async function siteChecks(page: Page): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { emit } = await import('../engine/events.js');
  const { foundingFloors } = await import('../engine/history.js');
  const { districtOrigin } = await import('../shared/district-layout.js');
  const db = openDb();
  const fullName = 'wren/new-site';
  const slot = SAMPLE.length;
  const now = new Date().toISOString();
  const repo: Repo = {
    fullName,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: 'fixture',
    connected: true,
    pushMode: false,
    root: 'chicago',
    slot,
    status: 'analyzing',
    error: null,
    connectedAt: now,
    analyzedAt: null,
    ...repoMarketDefaults(),
  };
  db.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(fullName, JSON.stringify(repo));
  emit('repo.analyzing', { repo, step: 'log' });
  const shown = await page
    .waitForFunction(() => (window as unknown as { __palimpsest: { sites: number } }).__palimpsest.sites === 1, null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(shown, 'an analyzing repo shows a scaffold at its site');
  const o = districtOrigin(slot);
  await setView(page, [o.x + BEARING.x * 95, 16, o.z + BEARING.z * 95], [o.x, 9, o.z]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'site-analyzing.png') });
  await setView(page, [o.x + BEARING.x * 380, 120, o.z + BEARING.z * 380], [o.x, 10, o.z]);
  await page.screenshot({ path: join(SHOTS, 'site-analyzing-far.png') });

  // The analysis finishes: that district alone is built and the scaffold comes down.
  const buildsBefore = await debug(page, (x) => x.builds);
  const commits = Array.from({ length: 22 }, (_, i) => ({
    sha: `${slot}${i.toString(16).padStart(6, '0')}`.padEnd(40, 'a'),
    at: new Date(Date.parse('2025-06-01T09:00:00Z') + i * 30 * 3600_000).toISOString(),
    author: 'Ada',
    subject: `Site change ${i + 1}`,
    body: '',
    lines: 40 + i * 11,
  }));
  const floors = foundingFloors(fullName, commits, []);
  const tower: TowerSpec = { id: `${fullName}#founding`, repo: fullName, kind: 'founding', root: 'chicago', floors, datumIndex: floors.length };
  db.prepare('INSERT INTO towers (repo, json) VALUES (?, ?)').run(fullName, JSON.stringify(tower));
  const ready: Repo = { ...repo, status: 'ready', analyzedAt: new Date().toISOString() };
  db.prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify(ready), fullName);
  emit('repo.analyzed', { repo: ready });
  const done = await page
    .waitForFunction(
      (n) => {
        const d = (window as unknown as { __palimpsest: { districts: number; sites: number } }).__palimpsest;
        return d.districts === n && d.sites === 0;
      },
      SAMPLE.length + 1,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check(done, 'repo.analyzed replaces the scaffold with the tower');
  const buildsAfter = await debug(page, (x) => x.builds);
  check(buildsAfter - buildsBefore === 1, `repo.analyzed rebuilds only that district (built ${buildsAfter - buildsBefore})`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'site-built.png') });
}


// ---------------------------------------------------------------- a fake GitHub

/** Repos the fake gh can see: the sample districts plus a few that are not in the city yet. All fictional. */
const AVAILABLE = [...SAMPLE.map((s) => ({ fullName: s.fullName })), ...SAMPLE_OTHERS];
const UNREADABLE = SAMPLE_UNREADABLE;

// ---------------------------------------------------------------- repos

const rowSel = (fullName: string): string => `.repo-row[data-repo="${fullName}"]`;

async function waitStatus(page: Page, fullName: string, want: string, seen: Set<string>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await page.locator(rowSel(fullName)).getAttribute('data-status').catch(() => null);
    if (st) seen.add(st);
    if (st === want) return true;
    await page.waitForTimeout(60);
  }
  return false;
}

async function reposChecks(page: Page): Promise<void> {
  await page.locator('.runhead a[data-route="repos"]').click();
  const shown = await page
    .waitForSelector(`${rowSel('marlow/tidepool-notes')}`, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(shown, 'the Repos screen lists every repo gh can see');
  if (!shown) return;
  let listed = 0;
  for (const a of AVAILABLE) listed += await page.locator(rowSel(a.fullName)).count();
  check(listed === AVAILABLE.length, `every available repo has one row (${listed} of ${AVAILABLE.length})`);
  // A connected repo gh no longer lists (the site from the scaffold check) still stands under "In the city".
  check((await page.locator(rowSel('wren/new-site')).count()) === 1, 'a connected repo outside the gh list is still listed');
  check(
    (await page.locator(`${rowSel('orrery/brass-gears')} .repo-private`).textContent())?.trim() === 'private',
    'a private repo carries the word private',
  );
  check((await page.locator(`${rowSel('quill/marginalia')} .repo-private`).count()) === 0, 'a public repo carries no private marker');
  check(
    (await page.locator(`${rowSel('quill/marginalia')} [role="switch"].connect`).getAttribute('aria-checked')) === 'false',
    'an unconnected repo is off by default',
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'repos.png') });

  // Search: "/" focuses the field, typing narrows the list.
  await page.keyboard.press('/');
  check(await page.locator('.repos-search').evaluate((e) => e === document.activeElement), '"/" focuses the search');
  await page.keyboard.type('orrery');
  await page.waitForTimeout(150);
  const visible = await page.locator('.repo-row:visible').count();
  check(visible === 2, `search narrows the list (${visible} rows for "orrery")`);
  await page.screenshot({ path: join(SHOTS, 'repos-search.png') });
  await page.keyboard.press('Escape');
  check((await page.locator('.repos-search').inputValue()) === '', 'Escape clears the search first');
  check((await page.locator('.sheet.repos').isVisible()), 'and leaves the screen open');

  // Connect: off to analyzing to ready, by SSE.
  const before = await debug(page, (d) => d.districts);
  const seen = new Set<string>();
  await page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].connect`).click();
  const analyzing = await waitStatus(page, 'marlow/tidepool-notes', 'analyzing', seen, 4000);
  check(analyzing, 'connecting shows the analysis under way');
  await page.waitForTimeout(500);
  const step = (await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-status`).textContent()) ?? '';
  check(/Cloning|Reading|Laying|Surveying/.test(step), `the analyzing row names its step (${step.trim()})`);
  await page.screenshot({ path: join(SHOTS, 'repos-analyzing.png') });
  const ready = await waitStatus(page, 'marlow/tidepool-notes', 'ready', seen);
  check(ready && seen.has('analyzing'), `the status passes through analyzing to ready (${[...seen].join(' > ')})`);
  const readyText = (await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-status`).textContent()) ?? '';
  check(/18 floors/.test(readyText), `ready shows the floor count (${readyText.trim()})`);
  const grew = await page
    .waitForFunction((n) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === n, before + 1, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(grew, 'the new district stands in the city');

  // An unreadable repo: a readable error and a Retry.
  const errSeen = new Set<string>();
  await page.locator(`${rowSel(UNREADABLE)} [role="switch"].connect`).click();
  const failed = await waitStatus(page, UNREADABLE, 'error', errSeen);
  check(failed, 'an unreadable repo ends in an error, not a hang');
  const msg = (await page.locator(`${rowSel(UNREADABLE)} .repo-error`).textContent()) ?? '';
  check(/could not find this repo/i.test(msg), `the error reads plainly (${msg.trim().slice(0, 60)})`);
  check(await page.locator(`${rowSel(UNREADABLE)} .repo-retry`).isVisible(), 'the error offers Retry');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'repos-states.png') });

  // Rapid on, off, on while the first connect is in flight: the last choice wins.
  const quick = 'quill/marginalia';
  const sw = page.locator(`${rowSel(quick)} [role="switch"].connect`);
  await sw.click();
  await sw.click();
  await sw.click();
  const quickSeen = new Set<string>();
  const quickReady = await waitStatus(page, quick, 'ready', quickSeen);
  const quickRepo = ((await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[]).find((r) => r.fullName === quick);
  check(quickReady && quickRepo?.connected === true, `a rapid on, off, on ends connected and ready (${[...quickSeen].join(' > ')})`);
  check((await sw.getAttribute('aria-checked')) === 'true', 'and the switch shows on');

  // The running head and the facts line count the same thing.
  const head = (await page.locator('.runhead-count').textContent())?.trim();
  const facts = (await page.locator('.sheet.repos .sheet-facts').textContent()) ?? '';
  check(facts.startsWith(`${head} of`), `the running head count matches the facts line (${head}; ${facts.split('.')[0]})`);

  // Push mode by keyboard: focus the switch, Space flips it, and it persists.
  const push = page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].push`);
  await push.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const repos = (await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[];
  check(repos.find((r) => r.fullName === 'marlow/tidepool-notes')?.pushMode === true, 'Space on the push mode switch stores push mode');
  await page.screenshot({ path: join(SHOTS, 'repos-focus.png') });

  // Push mode on a repo without a test and a build command (ruling 23): refused quietly beside the switch, which stays off.
  const refusedPush = page.locator(`${rowSel('kestrel/fieldnotes')} [role="switch"].push`);
  await refusedPush.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const why = ((await page.locator(`${rowSel('kestrel/fieldnotes')} .repo-push-why`).textContent()) ?? '').trim();
  const afterRefusal = (await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[];
  check(
    (await refusedPush.getAttribute('aria-checked')) === 'false' && afterRefusal.find((r) => r.fullName === 'kestrel/fieldnotes')?.pushMode === false && /test command and a build command/.test(why),
    `push mode without a test and a build stays off and says why (${why.slice(0, 60)})`,
  );

  // Root style: pick another root, the tower is restyled.
  const target = SAMPLE[0].fullName;
  await page.locator(`${rowSel(target)} [role="radio"][data-root="pagoda"]`).click();
  const restyled = await page
    .waitForFunction(
      (t) => fetch('/api/city').then((r) => r.json()).then((ds: Array<{ repo: string; tower: { root: string } }>) => ds.find((d) => d.repo === t)?.tower.root === 'pagoda'),
      target,
      { timeout: 4000 },
    )
    .then(() => true)
    .catch(() => false);
  check(restyled, 'picking a root restyles the tower');
  await page.locator(`${rowSel(target)} [role="radio"][data-root="beauxarts"]`).click();

  // Disconnect from the screen: the district leaves the city.
  const n = await debug(page, (d) => d.districts);
  await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-disconnect`).click();
  const left = await page
    .waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, n - 1, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(left, 'disconnecting removes the district from the city');
  check(
    (await page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].connect`).getAttribute('aria-checked')) === 'false',
    'the disconnected repo shows as off',
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, 'repos-1280.png') });
  await page.setViewportSize(VIEWPORT);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.locator('.sheet.repos').isVisible()), 'Escape returns to the city');
}

/** Disconnecting a repo while the inspector is open on it closes the inspector and removes the district. */
async function disconnectWhileInspecting(page: Page): Promise<void> {
  const target = SAMPLE[2].fullName;
  await page.evaluate((t) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(t), target);
  const open = await page.waitForSelector('.inspector.open', { timeout: 3000 }).then(() => true).catch(() => false);
  check(open, 'the inspector opens on the repo about to be disconnected');
  const n = await debug(page, (d) => d.districts);
  await page.evaluate(
    (t) => fetch(`/api/repos/${t}/disconnect`, { method: 'POST', headers: { 'x-palimpsest': '1' } }),
    target,
  );
  const gone = await page
    .waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, n - 1, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(gone, 'repo.disconnected removes its district');
  await page.waitForTimeout(300);
  check(!(await page.locator('.inspector').isVisible()), 'and closes the inspector open on it');
  await page.evaluate((t) => fetch(`/api/repos/${t}/connect`, { method: 'POST', headers: { 'x-palimpsest': '1' } }), target);
}

// ---------------------------------------------------------------- plots given back to the city

const post = (page: Page, path: string): Promise<unknown> =>
  page.evaluate((p) => fetch(p, { method: 'POST', headers: { 'x-palimpsest': '1' } }).then((r) => r.json()), path);

const plotsNow = (page: Page): Promise<{ plazas: number; buildings: number; sites: number; districts: number }> =>
  debug(page, (d) => ({ ...d.plots(), sites: d.sites, districts: d.districts }));

/** Waits until the page's plots match `want`, or gives up after `timeoutMs`. */
async function waitPlots(page: Page, want: (p: { plazas: number; buildings: number; sites: number; districts: number }) => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (want(await plotsNow(page))) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

/** A high oblique view of a slot's plot and the blocks round it. */
async function plotView(page: Page, slot: number): Promise<void> {
  const { districtOrigin } = await import('../shared/district-layout.js');
  const o = districtOrigin(slot);
  await setView(page, [o.x + BEARING.x * 300, 150, o.z + BEARING.z * 300], [o.x, 0, o.z]);
}

const repoRow = async (page: Page, fullName: string): Promise<Repo | undefined> =>
  ((await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[]).find((r) => r.fullName === fullName);

/**
 * A repo that is not connected leaves no plaza: a connect stopped before any
 * tower, and a district disconnected, both give the plot back to the same
 * ambient blocks, live; reconnecting clears the plot again.
 */
async function freedPlotChecks(page: Page): Promise<void> {
  const base = await plotsNow(page);

  // A connect stopped while it analyzes: the scaffold comes down and stays down while the analysis runs on.
  const stopped = 'orrery/star-catalogue';
  const { slot } = (await post(page, `/api/repos/${stopped}/connect`)) as Repo;
  const raised = await waitPlots(page, (p) => p.sites === base.sites + 1 && p.plazas === base.plazas + 1, 5000);
  check(raised, 'connecting raises a scaffold on a paved plot');
  await plotView(page, slot);
  await page.screenshot({ path: join(SHOTS, 'plot-stopped-before.png') });
  await post(page, `/api/repos/${stopped}/disconnect`);
  const cleared = await waitPlots(page, (p) => p.sites === base.sites && p.plazas === base.plazas, 3000);
  let worst = await plotsNow(page);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await repoRow(page, stopped))?.status === 'analyzing') {
    const now = await plotsNow(page);
    if (now.sites > worst.sites || now.plazas > worst.plazas) worst = now;
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(800);
  const after = await plotsNow(page);
  if (after.sites > worst.sites || after.plazas > worst.plazas) worst = after;
  const row = await repoRow(page, stopped);
  check(row?.connected === false && row.status !== 'analyzing', `the stopped connect finished its analysis and stays off (${row?.connected}, ${row?.status})`);
  check(
    cleared && worst.sites === base.sites && worst.plazas === base.plazas,
    `a stopped connect leaves no scaffold or plaza while its analysis runs on (sites ${worst.sites} of ${base.sites}, plazas ${worst.plazas} of ${base.plazas})`,
  );
  check(after.buildings === base.buildings, `and its plot holds the same ambient blocks as before (${after.buildings} of ${base.buildings})`);
  await plotView(page, slot);
  await page.screenshot({ path: join(SHOTS, 'plot-stopped-after.png') });

  // A standing district disconnected: its plaza goes and the blocks that stood there before return, without a reload.
  const target = SAMPLE[1].fullName;
  const d = (await cityOf(page)).find((x) => x.repo === target);
  if (!d) {
    check(false, `${target} stands before the disconnect check`);
    return;
  }
  const withIt = await plotsNow(page);
  await plotView(page, d.index);
  await page.screenshot({ path: join(SHOTS, 'plot-district-before.png') });
  await post(page, `/api/repos/${target}/disconnect`);
  const freed = await waitPlots(page, (p) => p.plazas === withIt.plazas - 1 && p.districts === withIt.districts - 1);
  const without = await plotsNow(page);
  check(freed, `disconnecting a district removes its plaza (${withIt.plazas} then ${without.plazas})`);
  check(without.buildings > withIt.buildings, `and fills its plot with ambient blocks (${withIt.buildings} then ${without.buildings} buildings)`);
  await plotView(page, d.index);
  await page.screenshot({ path: join(SHOTS, 'plot-district-after.png') });

  // Reconnecting clears the plot again: the tower it kept returns to the same place.
  await post(page, `/api/repos/${target}/connect`);
  const back = await waitPlots(page, (p) => p.plazas === withIt.plazas && p.districts === withIt.districts && p.buildings === withIt.buildings, 15_000);
  check(back, 'reconnecting clears the plot for the district again, with the same blocks round it');
  const returned = (await cityOf(page)).find((x) => x.repo === target);
  check(returned?.index === d.index, `and the district returns to its slot (${returned?.index} of ${d.index})`);
  for (let i = 0; i < 300 && (await repoRow(page, target))?.status === 'analyzing'; i++) await page.waitForTimeout(50);
}

// ---------------------------------------------------------------- settings

function reading(atMs: number, five: number, week: number): string {
  const s = Math.floor(atMs / 1000);
  return `${JSON.stringify({ at: s, rate_limits: { five_hour: { used_percentage: five, resets_at: s + 2 * 3600 + 600 }, seven_day: { used_percentage: week, resets_at: s + 4 * 86400 } } })}\n`;
}

async function settingsChecks(page: Page, claudeSettingsPath: string): Promise<void> {
  const { paths } = await import('../engine/home.js');
  const readings = join(paths().usage, 'readings.jsonl');
  writeFileSync(readings, reading(Date.now() - 7 * 3600_000, 62, 18));

  await page.locator('.runhead a[data-route="settings"]').click();
  const shown = await page.waitForSelector('.sheet.settings .usage-five', { timeout: 5000 }).then(() => true).catch(() => false);
  check(shown, 'the Settings screen opens from the running head');
  if (!shown) return;
  await page.waitForTimeout(400);
  const five = (await page.locator('.usage-five .usage-pct').textContent())?.trim();
  const week = (await page.locator('.usage-week .usage-pct').textContent())?.trim();
  check(five === '62%' && week === '18%', `usage shows the seeded percentages (${five}, ${week})`);
  check(await page.locator('.usage-stale').isVisible(), 'an old reading carries the stale warning');
  check(/reset/i.test((await page.locator('.usage-five').textContent()) ?? ''), 'each window shows when it resets');
  check(/window reset/.test((await page.locator('.usage-five .usage-reset').textContent()) ?? ''), 'a reset already past reads as past');
  await page.screenshot({ path: join(SHOTS, 'settings.png') });
  await page.screenshot({ path: join(SHOTS, 'settings-full.png'), fullPage: false });

  // The usage hook, against the temp claude settings file only.
  const original = readFileSync(claudeSettingsPath, 'utf8');
  check(/not installed/i.test((await page.locator('.hook-state').textContent()) ?? ''), 'the hook reads as not installed');
  await page.locator('.hook-install').click();
  await page.waitForFunction(() => /installed/i.test(document.querySelector('.hook-state')?.textContent ?? '') && !/not/i.test(document.querySelector('.hook-state')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
  const installed = readFileSync(claudeSettingsPath, 'utf8');
  check(/statusLine/.test(installed), 'Install writes the hook into the (temp) claude settings');
  check(!/not/i.test((await page.locator('.hook-state').textContent()) ?? ''), 'the hook then reads as installed');
  await page.screenshot({ path: join(SHOTS, 'settings-hook.png') });
  await page.locator('.hook-remove').click();
  await page.waitForFunction(() => /not installed/i.test(document.querySelector('.hook-state')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
  check(readFileSync(claudeSettingsPath, 'utf8') === original, 'Remove restores the claude settings byte for byte');

  // Caps: typed, stored.
  const day = page.locator('input.cap-day');
  let capPatches = 0;
  const countPatch = (r: { method(): string; url(): string }) => {
    if (r.method() === 'PATCH' && r.url().endsWith('/api/settings')) capPatches++;
  };
  page.on('request', countPatch);
  await day.fill('40');
  await day.press('Enter');
  await day.blur();
  await page.waitForTimeout(400);
  page.off('request', countPatch);
  check(capPatches === 1, `Enter then leaving the field sends one PATCH (${capPatches})`);
  let st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.dayCapPct === 40, `the day cap is stored (${st.dayCapPct})`);
  await day.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.dayCapPct === 45, `ArrowUp steps the cap by 5 (${st.dayCapPct})`);
  await day.fill('50');
  await day.press('Enter');

  // Quality.
  await page.locator('[role="radio"][data-quality="medium"]').click();
  await page.waitForTimeout(400);
  st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.quality === 'medium', 'quality is stored');
  await page.locator('[role="radio"][data-quality="high"]').click();

  // The kill switch.
  await page.locator('[role="switch"].kill').click();
  await page.waitForTimeout(500);
  check(existsSync(paths().stop), 'the kill switch writes the stop file');
  check(/stopped/i.test((await page.locator('.runhead').textContent()) ?? ''), 'the running head says the city is stopped');
  await page.locator('[role="switch"].kill').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'settings-stopped.png') });
  await page.locator('[role="switch"].kill').click();
  await page.waitForTimeout(500);
  check(!existsSync(paths().stop), 'turning it off removes the stop file');
  await page.locator('.settings-privacy').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'settings-privacy.png') });

  // A fresh reading: no warning.
  appendFileSync(readings, reading(Date.now() - 10 * 60_000, 23, 19));
  await page.locator('.runhead a[data-route="city"]').click();
  await page.locator('.runhead a[data-route="settings"]').click();
  await page.waitForTimeout(600);
  check((await page.locator('.usage-five .usage-pct').textContent())?.trim() === '23%', 'a new reading shows on reopening');
  check(!(await page.locator('.usage-stale').isVisible()), 'a fresh reading carries no stale warning');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'settings-1280.png') });
  await page.setViewportSize(VIEWPORT);

  // The engine not answering: no empty fields, no buttons, a plain sentence.
  await page.locator('.runhead a[data-route="city"]').click();
  abortingRequests = true;
  await page.route('**/api/settings', (r) => r.abort());
  await page.locator('.runhead a[data-route="settings"]').click();
  await page.waitForTimeout(600);
  check(/did not answer/.test((await page.locator('.hook-state').textContent()) ?? ''), 'settings that fail to load say the engine did not answer');
  check(!(await page.locator('.hook-install').isVisible()) && !(await page.locator('.hook-remove').isVisible()), 'and show neither hook button');
  check(!(await page.locator('input.cap-day').isVisible()), 'and no empty cap fields');
  await page.screenshot({ path: join(SHOTS, 'settings-down.png') });
  await page.unroute('**/api/settings');
  abortingRequests = false;
  await page.locator('#settings-title').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.locator('.sheet.settings').isVisible()), 'Escape leaves Settings for the city');
}

// ---------------------------------------------------------------- the splash

/**
 * The Mac app's splash, opened from its files with Tauri's invoke stood in.
 * When the engine answers but the window cannot be swapped for the city, the
 * splash must not freeze on its hairline: it shows the engine-down state with
 * the reason and a working Start button, both at launch and after Start.
 */
async function splashChecks(browser: Browser): Promise<void> {
  const splash = pathToFileURL(join(ROOT, 'src-tauri', 'splash', 'index.html')).href;
  for (const [when, healthyAtLaunch] of [['at launch', true], ['after Start', false]] as const) {
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // A string, not a function: tsx would wrap a function in helpers the page does not have.
    await page.addInitScript(`
      let installed = false;
      window.__TAURI__ = {
        core: {
          invoke: async (cmd) => {
            if (cmd === 'engine_healthy') return ${healthyAtLaunch} || installed;
            if (cmd === 'engine_command') return 'node ~/palimpsest/bin/palimpsest.mjs engine install';
            if (cmd === 'install_engine') { installed = true; return null; }
            if (cmd === 'open_city') throw 'the window is gone';
            throw new Error('unexpected ' + cmd);
          },
        },
      };
    `);
    await page.goto(splash);
    if (!healthyAtLaunch) {
      await page.waitForFunction(() => document.body.dataset.state === 'down', null, { timeout: 8000 });
      await page.locator('#start').click();
    }
    const shown = await page
      .waitForFunction(() => document.body.dataset.state === 'down' && !document.getElementById('error')!.hidden, null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const text = (await page.locator('#error').textContent()) ?? '';
    check(shown && /could not open the city/i.test(text) && /window is gone/.test(text), `splash ${when}: a failed open shows the engine-down state with the reason (${text || 'nothing shown'})`);
    check(!(await page.locator('#start').isDisabled()), `splash ${when}: Start the engine works again`);
    check(errors.length === 0, `splash ${when}: no unhandled errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
}

// ---------------------------------------------------------------- the view grows with the city

interface Limits {
  home: { eye: number[]; target: number[] };
  maxDistance: number;
  fogDensity: number;
  far: number;
}

const limitsOf = (page: Page): Promise<Limits> =>
  page.evaluate(() => (window as unknown as { __palimpsest: { limits(): Limits } }).__palimpsest.limits());

/** Where each district's crown and base land on screen now, in normalised device coordinates. */
async function projected(page: Page, city: District[]): Promise<Array<{ repo: string; crown: number[]; base: number[] }>> {
  const { CROWN_ALLOWANCE } = await import('../app/src/city/view.js');
  const pts = city.map((d) => ({ repo: d.repo, crown: [d.origin.x, layoutTower(d.tower).top + CROWN_ALLOWANCE, d.origin.z], base: [d.origin.x, 0, d.origin.z] }));
  return page.evaluate(
    (list) =>
      list.map((p) => {
        const h = (window as unknown as { __palimpsest: { project(p: number[]): number[] } }).__palimpsest;
        return { repo: p.repo, crown: h.project(p.crown), base: h.project(p.base) };
      }),
    pts,
  );
}

const inFrame = (p: number[], top = 1): boolean => p[2] < 1 && Math.abs(p[0]) < 1 && p[1] > -1 && p[1] < top;

/**
 * A tower grows to the 120 floor cap while the user is looking elsewhere:
 * the camera stays where they put it, the limits ease rather than snap, the
 * home framing (the H key) shows every crown with sky above, and the camera
 * may fly out far enough to frame every district whole.
 */
async function viewGrowsChecks(page: Page): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { emit } = await import('../engine/events.js');
  const { grownTower } = await import('./sample.js');
  const db = openDb();
  const fullName = 'lantern/assay-kit';
  const was = (db.prepare('SELECT json FROM towers WHERE repo = ?').get(fullName) as { json: string }).json;
  const repo = JSON.parse((db.prepare('SELECT json FROM repos WHERE full_name = ?').get(fullName) as { json: string }).json) as Repo;
  const tall = await grownTower(fullName, 2000);
  check(tall.floors.length === 120, `the grown tower stands at the 120 floor cap (${tall.floors.length})`);

  await setView(page, [300, 60, 620], [40, 40, 120]);
  const camBefore = await debug(page, (d) => d.camera());
  const before = await limitsOf(page);
  const builds = await debug(page, (d) => d.builds);
  db.prepare('UPDATE towers SET json = ? WHERE repo = ?').run(JSON.stringify(tall), fullName);
  emit('repo.patched', { repo });
  const rebuilt = await page
    .waitForFunction((n) => (window as unknown as { __palimpsest: { builds: number } }).__palimpsest.builds > n, builds, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(rebuilt, 'the grown tower is built');
  const soon = await limitsOf(page);
  await page.waitForTimeout(3000);
  const after = await limitsOf(page);
  const camAfter = await debug(page, (d) => d.camera());
  const moved = Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]);
  check(moved < 0.01, `a growing city never moves the camera the user holds (moved ${moved.toFixed(3)} m)`);
  const homeDist = (l: Limits) => Math.hypot(...l.home.eye.map((v, i) => v - l.home.target[i]));
  check(homeDist(after) > homeDist(before) + 1, `the home framing stands back for the taller tower (${homeDist(before).toFixed(0)} to ${homeDist(after).toFixed(0)} m)`);
  check(after.maxDistance > before.maxDistance && soon.maxDistance < after.maxDistance - 0.5, `how far the camera may go eases out rather than snapping (${before.maxDistance.toFixed(0)}, then ${soon.maxDistance.toFixed(0)}, then ${after.maxDistance.toFixed(0)} m)`);
  check(after.far > after.maxDistance, `the far plane reaches past the farthest eye (${after.far.toFixed(0)} m)`);

  const city = await cityOf(page);
  // Home, as the H key takes it: every crown on screen, the tallest with sky above it.
  await page.locator('#city canvas').focus();
  await page.keyboard.press('h');
  await page.waitForTimeout(2600);
  const home = await projected(page, city);
  const tallest = home.find((p) => p.repo === fullName);
  check(!!tallest && tallest.crown[1] < 0.95 && inFrame(tallest.crown), `at the home view the 120 floor crown is inside the frame with sky above (screen y ${tallest?.crown[1].toFixed(3)})`);
  const cut = home.filter((p) => !inFrame(p.crown));
  check(cut.length === 0, `at the home view every crown is inside the frame${cut.length ? ` (cut: ${cut.map((c) => c.repo).join(', ')})` : ''}`);
  await page.screenshot({ path: join(SHOTS, 'view-home-tall.png') });

  // Flown out as far as allowed, along the home bearing and from higher up: every district whole, sky above.
  const t = after.home.target;
  const dir = after.home.eye.map((v, i) => v - t[i]);
  const flat = Math.hypot(dir[0], dir[2]);
  for (const [name, el] of [['bearing', Math.atan2(dir[1], flat)], ['high', (55 * Math.PI) / 180]] as const) {
    const r = after.maxDistance * 0.999;
    const eye = [t[0] + (dir[0] / flat) * Math.cos(el) * r, t[1] + Math.sin(el) * r, t[2] + (dir[2] / flat) * Math.cos(el) * r];
    await setView(page, eye, t);
    const cam = await debug(page, (d) => d.camera());
    const dist = Math.hypot(...cam.map((v, i) => v - t[i]));
    const out = (await projected(page, city)).filter((p) => !inFrame(p.crown, 0.97) || !inFrame(p.base));
    check(dist > after.maxDistance * 0.99 && out.length === 0, `flown out ${dist.toFixed(0)} m (${name}), every district is whole in the frame${out.length ? ` (cut: ${out.map((c) => c.repo).join(', ')})` : ''}`);
    await page.screenshot({ path: join(SHOTS, `view-flyout-${name}.png`) });
  }

  // Back as it was, for the checks that follow.
  db.prepare('UPDATE towers SET json = ? WHERE repo = ?').run(was, fullName);
  const n = await debug(page, (d) => d.builds);
  emit('repo.patched', { repo });
  await page.waitForFunction((k) => (window as unknown as { __palimpsest: { builds: number } }).__palimpsest.builds > k, n, { timeout: 15_000 }).catch(() => {});
}

// ---------------------------------------------------------------- the engine restarting

/**
 * The engine stops and starts again while the city is open. A repo is
 * disconnected while it is down, so its event never reaches the page: once
 * the event stream is back, the city and the running head must show it gone
 * anyway, from a fresh read.
 */
async function reconnectChecks(page: Page, restart: (whileDown: () => Promise<void>) => Promise<void>): Promise<void> {
  await page.locator('.runhead a[data-route="city"]').click();
  const target = SAMPLE[0].fullName;
  const n = await debug(page, (d) => d.districts);
  const head = async () => ((await page.locator('.runhead-count').textContent()) ?? '').trim();
  const countBefore = await head();
  abortingRequests = true;
  await restart(async () => {
    const { disconnect } = await import('../engine/repos.js');
    disconnect(target);
  });
  const caughtUp = await page
    .waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, n - 1, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  abortingRequests = false;
  check(caughtUp, 'after the engine restarts, the city drops a repo disconnected while it was down');
  const countAfter = await head();
  check(countBefore !== '' && Number(countAfter) === Number(countBefore) - 1, `and the running head counts it out (${countBefore} then ${countAfter})`);
  await page.evaluate((t) => fetch(`/api/repos/${t}/connect`, { method: 'POST', headers: { 'x-palimpsest': '1' } }), target);
}

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- the river (Task 29)

/**
 * The river from the stone bridge at dusk (river.png) and a zoomed crop of
 * the civic pier (river-pier.png): the water draws (its own pass), the quays,
 * bridges and piers draw in one call per material, the lanterns stand, and
 * the view holds its frame rate.
 */
/** The most river triangles the main pass may draw from the home framing. */
const RIVER_HOME_TRIANGLES = 120_000;

async function riverChecks(page: Page): Promise<void> {
  type RV = { lamps: number; meshes: number; triangles: number; drewWater: boolean; steps: number; colourScale: number };
  type R = { river(): RV };
  const river = (): Promise<RV> => page.evaluate(() => (window as unknown as { __palimpsest: R }).__palimpsest.river());
  // From home the river draws only its chunks' core (walls, copings, parapets, decks, the bridges' bodies and the
  // lanterns' glass): its detail, shadows and AO stay near the eye (river-lod.ts).
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(600);
  const far = await river();
  check(far.triangles > 0 && far.triangles <= RIVER_HOME_TRIANGLES, `the river draws at most ${RIVER_HOME_TRIANGLES / 1000}k triangles from home (${(far.triangles / 1000).toFixed(0)}k in ${far.meshes} meshes)`);
  const homeStats = await debug(page, (d) => d.stats());
  console.log(`info  city from home with the river: ${homeStats.calls} draw calls, ${(homeStats.triangles / 1e6).toFixed(2)}M triangles`);
  await setView(page, [-353, 2.6, 11.5], [-368, -3, 320]);
  await debug(page, (d) => d.precompile());
  await page.waitForTimeout(1500);
  await river();
  await page.waitForTimeout(300);
  const r = await river();
  check(r.drewWater, 'the water draws, seen from the stone bridge');
  check(r.meshes > 0 && r.meshes <= 90, `the quays, bridges and piers in view draw in at most 90 calls, one per material per chunk (${r.meshes}, ${(r.triangles / 1000).toFixed(0)}k triangles)`);
  check(r.steps === 64 && r.colourScale === 1, `at high quality the water marches 64 steps over the full-resolution frame (${r.steps}, ${r.colourScale})`);
  check(r.lamps >= 200, `lanterns stand along the quays, on the bridges and at the piers (${r.lamps})`);
  await page.screenshot({ path: join(SHOTS, 'river.png') });
  const fps = await pageFps(page);
  const stats = await debug(page, (d) => d.stats());
  console.log(`info  river from the stone bridge: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  check(fps >= overviewFps - 5, `the river view holds the overview's frame rate (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  // A zoomed crop of the civic pier: its landing stage, shelter and lit sign.
  await setView(page, [-358, -3.2, 52], [-340, -4.6, 82]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'river-pier.png'), clip: { x: VIEWPORT.width * 0.2, y: VIEWPORT.height * 0.2, width: VIEWPORT.width * 0.6, height: VIEWPORT.height * 0.6 } });
}

// ---------------------------------------------------------------- the transit network (Task 30)

/** The most the network may draw from home: its far cores only, in the view only. */
const TRANSIT_HOME_TRIANGLES = 450_000;
const TRANSIT_HOME_CALLS = 24;

/**
 * The network as it stands for the sample city: the loops laid for its
 * extent, a rank at each district and the exchange, stations on every line;
 * from home it draws only its far cores in a few calls; a tram stop with the
 * viaduct behind (transit.png) and a pod station at height (pods.png); and
 * up close it holds the overview's frame rate.
 */
async function transitChecks(page: Page): Promise<void> {
  type TV = { meshes: number; triangles: number; stops: number; stations: number; podStations: number; ranks: number; poles: number; bents: number; pylons: number; blocks: number; builds: number; buildMs: number };
  const transit = (): Promise<TV> => page.evaluate(() => (window as unknown as { __palimpsest: { transit(): TV } }).__palimpsest.transit());
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(600);
  const far = await transit();
  console.log(`info  transit from home: ${far.meshes} calls, ${(far.triangles / 1000).toFixed(0)}k triangles; ${far.stops} tram stops, ${far.stations} rail stations, ${far.podStations} pod stations, ${far.ranks} ranks, ${far.poles} poles, ${far.bents} bents, ${far.pylons} pylons`);
  check(far.blocks === 2, `the network is laid for the sample city's extent (${far.blocks} rings)`);
  check(far.stops >= 12 && far.stations >= 8 && far.podStations >= 10, `the tram, the rail and the pods have their stops and stations (${far.stops}, ${far.stations}, ${far.podStations})`);
  const districts = await debug(page, (d) => d.districts);
  console.log(`info  the network was laid ${far.builds} times, the last in ${far.buildMs.toFixed(0)} ms`);
  check(far.ranks === districts + 1, `a cab rank at each of the ${districts} districts and one at the exchange (${far.ranks})`);
  check(far.poles > 100 && far.bents > 100 && far.pylons > 40, `poles, bents and pylons stand along the lines (${far.poles}, ${far.bents}, ${far.pylons})`);
  check(far.triangles > 0 && far.triangles <= TRANSIT_HOME_TRIANGLES, `from home the network draws at most ${TRANSIT_HOME_TRIANGLES / 1000}k triangles (${(far.triangles / 1000).toFixed(0)}k)`);
  check(far.meshes > 0 && far.meshes <= TRANSIT_HOME_CALLS, `from home the network draws in at most ${TRANSIT_HOME_CALLS} calls, one per material (${far.meshes})`);

  // A tram stop on the east side of the loop, looking down its street to the corner where the tram turns and the
  // viaduct crosses the street's end.
  await setView(page, [603.5, 3.2, 436], [598, 7.5, 640]);
  await debug(page, (d) => d.precompile());
  await page.waitForTimeout(1500);
  const near = await transit();
  check(near.meshes > far.meshes, `near the line its chunks draw their own detail (${near.meshes} calls, ${(near.triangles / 1000).toFixed(0)}k triangles)`);
  await page.screenshot({ path: join(SHOTS, 'transit.png') });
  const fps = await pageFps(page);
  const stats = await debug(page, (d) => d.stats());
  console.log(`info  tram stop and viaduct: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  check(fps >= overviewFps - 5, `the street by the lines holds the overview's frame rate (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  // A pod station at height, lit from within, the exchange beyond.
  await setView(page, [264, 21, 152], [240, 19, 120]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, 'pods.png') });
  check((await debug(page, (d) => d.quality())) === 'high', 'the network holds high quality');
}

// ---------------------------------------------------------------- the vehicles (Task 31)

/** From home the vehicles draw every car at its far level: one call per model, a few tens of thousands of triangles. */
const VEHICLE_HOME_CALLS = 8;
const VEHICLE_HOME_TRIANGLES = 80_000;

/**
 * The trams, trains, pods, ferries and cabs: how many run on the sample
 * city's network, what they cost from home, a synthetic trip boarding its
 * tram and summoning its cab, the stills (tram.png: a tram standing at a
 * stop, close; ferry.png: a ferry alongside a pier; cab.png: a rider at the
 * kerb stepping into a summoned cab), and the frame rate by the lines with
 * every vehicle running.
 */
async function vehicleChecks(page: Page): Promise<void> {
  type VV = { trams: number; trains: number; pods: number; ferries: number; cabs: number; near: number; far: number; meshes: number; triangles: number; time: number };
  type Probe = { id: string; kind: string; position: number[]; heading: number; speed: number; floorY: number; phase: string };
  const call = <T>(js: string): Promise<T> => page.evaluate(`(function (d) { return ${js}; })(window.__palimpsest)`) as Promise<T>;
  const view = (): Promise<VV> => call<VV>('d.vehicles()');
  const around = (p: number[], h: number, fwd: number, right: number, y: number): number[] => [p[0] + Math.cos(h) * fwd - Math.sin(h) * right, y, p[2] + Math.sin(h) * fwd + Math.cos(h) * right];

  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(800);
  const far = await view();
  const ranks = (await page.evaluate(() => (window as unknown as { __palimpsest: { transit(): { ranks: number } } }).__palimpsest.transit().ranks)) as number;
  console.log(`info  vehicles: ${far.trams} trams, ${far.trains} trains, ${far.pods} pods, ${far.ferries} ferries, ${far.cabs} cabs; from home ${far.meshes} calls, ${(far.triangles / 1000).toFixed(0)}k triangles (${far.near} near, ${far.far} far)`);
  check(far.trams >= 8 && far.trains >= 4 && far.pods >= 4 && far.ferries >= 3, `trams, trains, pods and ferries run on the network (${far.trams}, ${far.trains}, ${far.pods}, ${far.ferries})`);
  check(far.cabs === ranks * 2, `two cabs wait at each of the ${ranks} ranks (${far.cabs})`);
  check(far.near === 0, 'from home every vehicle draws at its far level');
  check(far.meshes > 0 && far.meshes <= VEHICLE_HOME_CALLS, `from home the vehicles draw in at most ${VEHICLE_HOME_CALLS} calls (${far.meshes})`);
  check(far.triangles <= VEHICLE_HOME_TRIANGLES, `from home the vehicles draw at most ${VEHICLE_HOME_TRIANGLES / 1000}k triangles (${(far.triangles / 1000).toFixed(0)}k)`);
  const t0 = far.time;
  await page.waitForTimeout(500);
  check((await view()).time > t0, 'the vehicles run on their clock');

  // A synthetic trip (persona trips are Task 33's): it boards the next tram on its leg, and a long one summons a cab.
  const tramTrip = await call<Array<{ mode: string; id: string | null; boardsIn: number; alightsIn: number }>>('d.vehicleTrip([560, -300], [600, 200])');
  const tramLeg = tramTrip.find((l) => l.mode === 'tram');
  check(!!tramLeg?.id && tramLeg.boardsIn >= 0 && tramLeg.alightsIn > tramLeg.boardsIn, `a trip boards the next tram on its leg (${JSON.stringify(tramLeg)})`);

  await call('d.vehicleHold(true)');
  // A tram standing at a stop on the east side of the loop, close from the platform: its nose three-quarters on.
  const tram = await call<Probe | null>('d.vehicleStage("tram", [680, 240])');
  check(!!tram && tram.speed < 0.01, 'a tram stands at its stop');
  if (tram) {
    await setView(page, around(tram.position, tram.heading, 21, 5.2, tram.position[1] + 1.7), around(tram.position, tram.heading, 0, -0.5, tram.position[1] + 1.7));
    await debug(page, (d) => d.precompile());
    await page.waitForTimeout(900);
    const near = await view();
    check(near.near > 0 && near.meshes > far.meshes, `close by, the vehicles draw their near level (${near.near} cars, ${near.meshes} calls, ${(near.triangles / 1000).toFixed(0)}k triangles)`);
    await page.screenshot({ path: join(SHOTS, 'tram.png') });
  }
  // A ferry alongside the pier at the foot of the civic axis, from above the quay.
  const ferry = await call<Probe | null>('d.vehicleStage("ferry", [-332, 72])');
  check(!!ferry && Math.abs(ferry.position[1] - -5.2) < 0.01, 'a ferry stands at a pier on the water');
  if (ferry) {
    await setView(page, around(ferry.position, ferry.heading, 26, 16, ferry.position[1] + 6.5), around(ferry.position, ferry.heading, 0, 0, ferry.position[1] + 0.5));
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(SHOTS, 'ferry.png') });
  }
  // A cab summoned to a rider at the kerb: it drives from the nearest rank, pulls up, and the rider steps in.
  const cabTrip = await call<Array<{ mode: string; id: string | null }>>('d.vehicleTrip([446.5, 330], [1100, -200])');
  const cabLeg = cabTrip.find((l) => l.mode === 'cab');
  check(!!cabLeg?.id, `a long trip summons a cab (${cabTrip.map((l) => l.mode).join(', ')})`);
  if (cabLeg?.id) {
    let cab = await call<Probe | null>(`d.vehicle(${JSON.stringify(cabLeg.id)})`);
    check(cab?.phase === 'to-pickup', `the cab sets off from its rank (${cab?.phase})`);
    for (let i = 0; i < 600 && cab && cab.phase !== 'pickup'; i++) {
      await call('d.vehicleSkip(1)');
      cab = await call<Probe | null>(`d.vehicle(${JSON.stringify(cabLeg.id)})`);
    }
    check(cab?.phase === 'pickup' && Math.hypot(cab.position[0] - 446.5, cab.position[2] - 330) < 0.5, 'the cab pulls up where the rider waits');
    if (cab) {
      await call('d.vehicleSkip(2)');
      const kerb = around(cab.position, cab.heading, -0.35, 1.45, cab.position[1]);
      await call(`d.vehicleRider(${JSON.stringify(kerb)}, ${cab.heading - Math.PI / 2 - 0.5})`);
      await setView(page, around(cab.position, cab.heading, 6.5, 4.4, 1.45), around(cab.position, cab.heading, -0.3, 0.7, 0.95));
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(SHOTS, 'cab.png') });
      await call('d.vehicleRider(null)');
    }
  }
  await call('d.vehicleHold(false)');

  // By the lines with every vehicle running: trams through the stop, trains overhead, the shadow map following them.
  await setView(page, [603.5, 3.2, 436], [598, 7.5, 640]);
  await page.waitForTimeout(1500);
  const fps = await pageFps(page);
  const stats = await debug(page, (d) => d.stats());
  const running = await view();
  console.log(`info  by the lines with every vehicle running: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles (${running.near} cars near)`);
  check(fps >= overviewFps - 5, `the street by the lines holds the overview's frame rate with every vehicle running (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  // Close by a ferry under way, its wake and the other ferries' (up to four) drawn in the water.
  const found = await call<boolean>('d.vehicleSeek([{ kind: "ferry", near: [-360, 210], radius: 50, moving: 5 }])');
  check(found, 'a ferry comes under way in mid-river');
  if (found) {
    const ferries = await call<Probe[]>('d.vehicleKinds("ferry")');
    const f = ferries.sort((a, b) => Math.hypot(a.position[0] + 360, a.position[2] - 210) - Math.hypot(b.position[0] + 360, b.position[2] - 210))[0];
    await setView(page, around(f.position, f.heading, -70, 8, 9), around(f.position, f.heading, 6, 0, -5));
    await page.waitForTimeout(1500);
    const wakeFps = await pageFps(page);
    const moving = ferries.filter((x) => x.speed > 0.2).length;
    console.log(`info  close by a ferry under way, ${ferries.length} wakes fed (${moving} moving): ${wakeFps.toFixed(0)} fps`);
    check(wakeFps >= overviewFps - 5, `the river holds the overview's frame rate with the ferries' wakes (${wakeFps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  }
  check((await debug(page, (d) => d.quality())) === 'high', 'the vehicles hold high quality');
}

// ---------------------------------------------------------------- the personas as people (Task 34)

/**
 * The agent personas on the economy's trips: figures in the city, none at
 * its full level from home; a persona sent on the tram walks to its stop,
 * waits on the platform under its plate (commute.png), boards the tram and
 * rides in it; Follow brings the camera to it and Escape lets go.
 */
async function peopleChecks(page: Page): Promise<void> {
  type PV = { figures: number; close: number; near: number; far: number; lanterns: number; meshes: number; triangles: number; following: string | null };
  const view = (): Promise<PV | null> => callDebug<PV | null>(page, 'd.people()');
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(800);
  const far = await view();
  console.log(`info  people: ${far?.figures} figures; from home ${far?.near} near, ${far?.far} far, ${far?.lanterns} lanterns in ${far?.meshes} calls`);
  check(!!far && far.figures >= 3, `the economy's trips put personas in the city (${far?.figures})`);
  check(!!far && far.near === 0 && far.meshes <= 2, `from home no persona draws its full figure (${far?.near} near, ${far?.meshes} calls)`);

  // Dagny on the tram: she walks to the stop, waits on the platform, and boards.
  await callDebug(page, 'd.peopleHold(true)');
  const id = 'dagny-hollis';
  const tripId = await sendPerson(page, id, [560, -300], [600, 200]);
  check(!!tripId, 'a persona is sent on a tram trip');
  let f = await runUntil(page, id, (x) => x.mode === 'tram' && x.stage === 'wait');
  check(!!f && f.mode === 'tram' && f.stage === 'wait' && !!f.ride, `she walks to the stop and waits for the tram (${f?.mode}, ${f?.stage})`);
  if (f?.ride) {
    // The tram coming in: the still a few seconds before it stands at the stop.
    f = await runUntil(page, id, (x, v) => x.stage !== 'wait' || (!!v && apart(x, v) < 34 && v.speed > 0.5), 1200);
    if (f) {
      await setView(page, aroundPerson(f.position, f.heading, 11, 2.4, f.position[1] + 2.4), aroundPerson(f.position, f.heading, -1.5, 0.3, f.position[1] + 1.2));
      await debug(page, (d) => d.precompile());
      await page.waitForTimeout(900);
      const plates = page.locator('.plate.plate-person');
      const plateText = (await plates.allTextContents()).join(' | ');
      check((await plates.count()) >= 1 && /Dagny Hollis/.test(plateText), `her plate stands over her within 150 m (${plateText || 'none'})`);
      const near = await view();
      check(!!near && near.close >= 1 && near.triangles > 9000, `close by she draws as the modelled figure in full (${near?.close} close, ${near?.near} near, ${near?.triangles} triangles)`);
      await page.screenshot({ path: join(SHOTS, 'commute.png') });
    }
    f = await runUntil(page, id, (x) => x.stage === 'ride', 300);
    const v = f?.ride ? await callDebug<{ position: number[] } | null>(page, `d.vehicle(${JSON.stringify(f.ride.id)})`) : null;
    check(!!f && f.stage === 'ride' && !!v && Math.hypot(f.position[0] - v.position[0], f.position[2] - v.position[2]) < 2.5, `she boards and rides in the tram (${f?.stage})`);
    // The tram dwells 20 s at the stop: once it is under way, ten seconds more carry her down the line with it.
    await runUntil(page, id, (_x, tv) => !!tv && tv.speed > 1, 60);
    await callDebug(page, 'd.peopleSkip(10)');
    const f2 = await person(page, id);
    const v2 = f2?.ride ? await callDebug<{ position: number[] } | null>(page, `d.vehicle(${JSON.stringify(f2.ride.id)})`) : null;
    const moved = f2 && f ? Math.hypot(f2.position[0] - f.position[0], f2.position[2] - f.position[2]) : 0;
    const off = f2 && v2 ? Math.hypot(f2.position[0] - v2.position[0], f2.position[2] - v2.position[2]) : Infinity;
    check(moved > 20 && off < 2.5, `and moves with it down the line (${moved.toFixed(0)} m on, ${off.toFixed(1)} m from the tram)`);
  }
  await callDebug(page, 'd.peopleHold(false)');

  // Follow: the camera comes to her and keeps behind her; Escape lets go.
  await callDebug(page, `d.follow(${JSON.stringify(id)})`);
  await page.waitForTimeout(2500);
  const followed = await person(page, id);
  const eye = await debug(page, (d) => d.camera());
  const off = followed ? Math.hypot(eye[0] - followed.position[0], eye[2] - followed.position[2]) : Infinity;
  check((await callDebug<string | null>(page, 'd.following()')) === id && off < 18, `Follow brings the camera to her and keeps about 12 m behind, on the tram too (${off.toFixed(1)} m off in plan)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await callDebug<string | null>(page, 'd.following()')) === null, 'Escape lets the follow go');
  // The agent page's Follow button does the same, and comes back to the city.
  await page.goto(`http://127.0.0.1:${PORT}/?debug#/agents/${id}`);
  await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const btn = page.locator('.agentpage .agent-follow');
  check((await btn.count()) === 1 && (await btn.getAttribute('aria-disabled')) === null, 'the agent page offers Follow');
  await btn.click();
  await page.waitForTimeout(2500);
  const route = await page.evaluate(() => document.body.dataset.route);
  check(route === 'city', `Follow comes back to the city (${route})`);
  const now = await callDebug<string | null>(page, 'd.following()');
  check(now === id || (await person(page, id)) === null, `and follows her figure (${now})`);
  await callDebug(page, 'd.follow(null)');
  // F on an agent with no figure in the city says so in the running head instead of flying anywhere.
  const firms = (await page.evaluate(() => fetch('/api/firms').then((r) => r.json()))) as Array<{ agents: Array<{ id: string; retired: boolean }> }>;
  const out = new Set((await callDebug<Array<{ agentId: string }>>(page, 'd.persons()')).map((p) => p.agentId));
  const stayAt = firms.flatMap((f) => f.agents).find((a) => !a.retired && !out.has(a.id));
  if (stayAt) {
    await page.goto(`http://127.0.0.1:${PORT}/?debug#/agents/${stayAt.id}`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      location.hash = '#/';
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    const said = await debug(page, (d) => d.notice());
    check(/not out in the city/.test(said) && (await callDebug<string | null>(page, 'd.following()')) === null, `F on an agent with no figure says so (${said || 'nothing'})`);
  } else check(false, 'an agent without a figure to try F on');
  check((await debug(page, (d) => d.quality())) === 'high', 'the people hold high quality');
}

// ---------------------------------------------------------------- the ambient traffic and crowd (Task 32)

/** From home the ambient life draws its far levels only: a few calls, and its share of the home budget's room. */
const AMBIENT_HOME_CALLS = 8;
const AMBIENT_HOME_TRIANGLES = 600_000;

/**
 * The unlabelled cars and people at full density: how many, what they cost
 * from home, that they run and that the lights hold them in turn, the still
 * street.png (dusk, at a person's height by a plaza, the streets full), and
 * the frame rate there held within 5 of the overview at high quality.
 */
async function ambientChecks(page: Page): Promise<void> {
  type AV = { cars: number; people: number; walking: number; waiting: number; nearCars: number; farCars: number; nearPeople: number; farPeople: number; meshes: number; triangles: number; density: number; time: number };
  const call = <T>(js: string): Promise<T> => page.evaluate(`(function (d) { return ${js}; })(window.__palimpsest)`) as Promise<T>;
  await call('d.ambientDensity(1)');
  const home = await debug(page, (d) => d.limits().home);
  await setView(page, home.eye, home.target);
  await page.waitForTimeout(800);
  const far = await call<AV>('d.ambient()');
  type T = { calls: number; triangles: number };
  const parts = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, Record<string, T>>;
  const share = Object.values(parts.traffic ?? {}).reduce((a, t) => ({ calls: a.calls + t.calls, triangles: a.triangles + t.triangles }), { calls: 0, triangles: 0 });
  console.log(`info  the traffic and crowd's share of the home frame, every pass: ${share.calls} calls, ${(share.triangles / 1000).toFixed(0)}k triangles`);
  check(share.calls >= 1 && share.calls <= AMBIENT_HOME_CALLS, `from home the traffic and crowd draw, in at most ${AMBIENT_HOME_CALLS} calls over every pass (${share.calls})`);
  console.log(`info  ambient: ${far.cars} cars, ${far.people} people (${far.walking} walking, ${far.waiting} waiting); from home ${far.meshes} calls, ${(far.triangles / 1000).toFixed(0)}k triangles (${far.nearCars} cars near, ${far.farCars} far)`);
  check(far.cars > 200 && far.people > 500, `cars and people fill the streets at full density (${far.cars}, ${far.people})`);
  check(far.meshes <= AMBIENT_HOME_CALLS, `from home the ambient life draws in at most ${AMBIENT_HOME_CALLS} calls (${far.meshes})`);
  check(far.triangles <= AMBIENT_HOME_TRIANGLES, `from home the ambient life draws at most ${AMBIENT_HOME_TRIANGLES / 1000}k triangles (${(far.triangles / 1000).toFixed(0)}k)`);
  const t0 = far.time;
  await page.waitForTimeout(600);
  check((await call<AV>('d.ambient()')).time > t0, 'the ambient clock runs');
  const queues = await call<Array<{ x: number; z: number; held: number }>>('d.ambientQueues([0, 0], 2000)');
  check(queues.length > 3, `cars stand at the lights at several junctions (${queues.length})`);

  // A street at dusk by the district plaza east of the exchange: at a person's height on the pavement, looking up
  // the street into the plaza, traffic crossing at the junction ahead and people on both pavements.
  await setView(page, [195.4, 1.62, -145], [207, 1.45, -30]);
  await debug(page, (d) => d.precompile());
  await page.waitForTimeout(1500);
  const near = await call<AV>('d.ambient()');
  console.log(`info  street by a plaza: ${near.nearCars} cars and ${near.nearPeople} people near, ${near.meshes} calls, ${(near.triangles / 1000).toFixed(0)}k triangles`);
  check(near.nearCars > 0 && near.nearPeople > 0, `at street level the near cars and figures draw (${near.nearCars}, ${near.nearPeople})`);
  await page.screenshot({ path: join(SHOTS, 'street.png') });
  const fps = await pageFps(page);
  const stats = await debug(page, (d) => d.stats());
  console.log(`info  street by a plaza: ${fps.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  check(fps >= overviewFps - 5, `the street by a plaza holds the overview's frame rate with the traffic and crowd (${fps.toFixed(0)} against ${overviewFps.toFixed(0)})`);
  check((await debug(page, (d) => d.quality())) === 'high', 'the ambient life holds high quality');
}

/**
 * The governor's step down to medium, taken on purpose at the river (where the water's own settings change with it)
 * and then the views the city is most often seen from: the drop must leave no error behind, whatever is on screen.
 * Runs last, since it leaves the city at medium.
 */
async function qualityDropChecks(page: Page, errors: string[]): Promise<void> {
  const before = errors.length;
  await setView(page, [-353, 2.6, 11.5], [-368, -3, 320]);
  await page.evaluate('window.__palimpsest.dropQuality()');
  await page.waitForTimeout(1500);
  check((await debug(page, (d) => d.quality())) === 'medium', "the governor's step down takes the city to medium");
  await dropNoticeChecks(page, check, false);
  const home = await debug(page, (d) => d.limits().home);
  for (const [eye, target] of [
    [[-353, 2.6, 11.5], [-368, -3, 320]],
    [[603.5, 3.2, 436], [598, 7.5, 640]],
    [[-368, 21, 520], [-354, 5, 760]],
    [home.eye, home.target],
  ] as Array<[number[], number[]]>) {
    await setView(page, eye, target);
    await debug(page, (d) => d.precompile());
    await page.waitForTimeout(700);
  }
  const fresh = errors.slice(before);
  check(fresh.length === 0, `stepping down to medium leaves no errors${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
}

/**
 * Every screen once more, by its address, after the whole run has moved the economy on (Task 42): each opens on its
 * sheet and adds no console error of its own. The ids are read from the engine, so each page opens on a real record.
 */
async function everyScreenChecks(page: Page, errors: string[]): Promise<void> {
  const api = <T>(path: string): Promise<T> => page.evaluate((p) => fetch(p).then((r) => r.json()), path) as Promise<T>;
  const jobs = await api<Array<{ id: string; runId: string | null }>>('/api/jobs');
  const firms = await api<FirmView[]>('/api/firms');
  const withRun = jobs.find((j) => j.runId);
  const detail = withRun ? await api<{ inspections: Array<{ id: string }> }>(`/api/jobs/${withRun.id}`) : null;
  const screens: Array<[string, string, string]> = [
    ['city', '#/', '.runhead'],
    ['job board', '#/jobs', '.sheet.jobs, .sheet .sec-bidding, .sheet-title'],
    ...(jobs[0] ? ([['job', `#/jobs/${jobs[0].id}`, '.sheet.jobpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(withRun?.runId ? ([['run', `#/runs/${withRun.runId}`, '.runpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(detail?.inspections[0] ? ([['inspection', `#/inspections/${detail.inspections[0].id}`, '.insppage .sheet-title']] as Array<[string, string, string]>) : []),
    ['firms', '#/firms', '.sheet.firms .firm-row'],
    ...(firms[0] ? ([['firm', `#/firms/${firms[0].id}`, '.sheet.firmpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(firms[0]?.agents[0] ? ([['agent', `#/agents/${firms[0].agents[0].id}`, '.sheet.agentpage .sheet-title']] as Array<[string, string, string]>) : []),
    ['treasury', '#/treasury', '.sheet.treasury .sheet-title'],
    ['repos', '#/repos', '.sheet.repos .sheet-title'],
    ['district', `#/repos/${SAMPLE[0].fullName}`, '.sheet.district .sheet-title'],
    ['settings', '#/settings', '.sheet.settings .sheet-title'],
  ];
  for (const [name, hash, ready] of screens) {
    const before = errors.length;
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    const shown = await page
      .waitForSelector(ready, { state: 'attached', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(600);
    const fresh = errors.slice(before);
    check(shown && fresh.length === 0, `the ${name} screen opens at ${hash} with no console error${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
  }
  await page.evaluate(() => {
    location.hash = '#/';
  });
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html missing: run npm run build first');
  }
  // A bundle older than the app's sources tests code that is no longer there (a merge after the last build, say).
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
  const built = statSync(join(DIST, 'index.html')).mtimeMs;
  if (newest(join(ROOT, 'app', 'src')) > built || newest(join(ROOT, 'shared')) > built) {
    throw new Error('dist is older than app/src or shared: run npm run build first');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-ui-test-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  // The treasury reads a transcripts folder (his own use, while a reading is stale). seedSample() writes no
  // sample marker, so the projects guard does not know this home as a sample's; as every test does, the run
  // says it is a test. That switch drops the guard, so it is pinned below: the folder must be the sample's,
  // inside the temp home, or the run stops before anything reads it.
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(SHOTS, { recursive: true });

  await seedSample();
  {
    const { useSampleFolders } = await import('../engine/sample.js');
    useSampleFolders();
    const projects = process.env.PALIMPSEST_CLAUDE_PROJECTS;
    const inside = projects ? relative(resolve(tmp), resolve(projects)) : '..';
    if (!projects || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`ui-test: the transcripts folder ${projects ?? '(unset)'} is not inside the temp home ${tmp}; refusing to run, so nothing reads ~/.claude/projects`);
    }
  }
  const { setRunner } = await import('../engine/exec.js');
  // Slow enough that each analysis step is visible, and never the network.
  setRunner(sampleGh(450));
  // The API key routes. This home has no sample marker (seedSample writes none), so the engine does not enter
  // sample mode and would keep the real spawner: the sample keychain is installed in front of it here, and
  // sampleGh (the runner above) answers `security` too, so no `security` process ever starts. The keychain the
  // engine names is a file in the temp dir besides, never his login keychain.
  await installKeychainStandIn();
  const keychain = join(tmp, 'ui-test.keychain-db');
  writeFileSync(keychain, '');
  const { startServer } = await import('../engine/server.js');
  let server = await startServer({ port: PORT, claudeSettingsPath, keychain });
  // Today's brief is opened first, as his first window would, so every check before the brief's own finds the
  // city; briefChecks takes today's open out again to see the day's first open (tools/ui-test-brief.ts).
  await fetch(`http://127.0.0.1:${PORT}/api/brief/open`, { method: 'POST', headers: { 'x-palimpsest': '1' } });
  const restart = async (whileDown: () => Promise<void>): Promise<void> => {
    await server.close();
    await whileDown();
    await new Promise((r) => setTimeout(r, 500));
    server = await startServer({ port: PORT, claudeSettingsPath, keychain });
  };

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  try {
    await splashChecks(browser);
    await kitFailureChecks(browser);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: Number(process.env.UI_DPR ?? 1) });
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !(abortingRequests && /net::ERR_(FAILED|CONNECTION_REFUSED)/.test(m.text()))) consoleErrors.push(m.text());
    });
    // With the stack, so an error in the page says where it was thrown.
    page.on('pageerror', (e) => consoleErrors.push(e.stack ?? String(e)));

    if (process.env.UI_QUALITY) {
      await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
        method: 'PATCH',
        headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ quality: process.env.UI_QUALITY }),
      });
    }
    // Without ?debug the window exposes no debug handle at all.
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector('#city canvas', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    check(await page.evaluate(() => (window as unknown as { __palimpsest?: unknown }).__palimpsest === undefined), 'a window opened without ?debug exposes no debug handle');
    await page.goto(`http://127.0.0.1:${PORT}/?debug`);
    const ready = await page
      .waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false);
    check(ready, 'city reports ready');
    // The ambient life at full density throughout, whatever the hour: every budget is measured at its worst.
    if (ready) await fullDensity(page);
    await page.waitForTimeout(3000);

    // UI_FORCE_DROP=1: the notice stack alone, then the governor's step down taken from home, whose notice must
    // name what it saw. A quick run for the notice rounds; the full run takes the same checks in their places.
    const forceDrop = process.env.UI_FORCE_DROP === '1';
    // UI_ONLY=spire: the economy seeded and the skyline's checks and shots alone (Task 14's quality rounds).
    const spireOnly = ['spire', 'revival', 'ribbon', 'tour', 'dossier', 'budget'].includes(process.env.UI_ONLY ?? '');
    if (spireOnly && ready) {
      await measureFps(page);
      await earnedChecks(page);
      if (process.env.UI_ONLY === 'budget') {
        const high = await homeBreakdown(page, process.env.UI_BUDGET === 'detail');
        await page.evaluate('window.__palimpsest.dropQuality()');
        await page.waitForTimeout(2500);
        await tierBudgetChecks(page, high);
      } else {
        await spireChecks(page);
        await revivalChecks(page);
        await ribbonChecks(page);
        await tourChecks(page);
        await dossierChecks(page);
        const before = (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
        await page.evaluate('window.__palimpsest.dropQuality()');
        await page.waitForTimeout(1500);
        await spireAfterDropChecks(page, before);
      }
    } else if (forceDrop && ready) {
      await noticeChecks(page, check, SHOTS);
      const home = await debug(page, (d) => d.limits().home);
      await setView(page, home.eye, home.target);
      await page.waitForTimeout(1500);
      await page.evaluate('window.__palimpsest.dropQuality()');
      await page.waitForTimeout(800);
      check((await debug(page, (d) => d.quality())) === 'medium', 'UI_FORCE_DROP steps the city down to medium');
      await dropNoticeChecks(page, check, true);
      await page.screenshot({ path: join(SHOTS, 'notices-quality-drop.png') });
    } else {

      const canvas = await page.$('canvas');
      check(canvas !== null, 'a canvas is on the page');

      const [r, g, b] = await pixel(page, VIEWPORT.width / 2, VIEWPORT.height / 2);
      check(r + g + b > 0, `center pixel is not pure black (rgb ${r},${g},${b})`);

      const districts = await page.evaluate(
        () => (window as unknown as { __palimpsest?: { districts: number } }).__palimpsest?.districts ?? -1,
      );
      check(districts === SAMPLE.length, `city shows ${SAMPLE.length} districts (got ${districts})`);

      await page.screenshot({ path: join(SHOTS, 'city-overview.png') });

      if (ready) {
        for (const [name, eye, target] of VIEWS) {
          await setView(page, eye, target);
          await page.screenshot({ path: join(SHOTS, `${name}.png`) });
        }
      }

      if (ready) {
        const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
        const all = process.env.UI_TOWER_SHOTS === 'all';
        const seen = new Set<string>();
        for (const d of city) {
          // One set of shots per root style, from the first tower with floors.
          if (d.tower.floors.length === 0 || seen.has(d.tower.root)) continue;
          seen.add(d.tower.root);
          for (const [name, eye, target] of towerViews(d, all)) {
            await setView(page, eye, target);
            await page.screenshot({ path: join(SHOTS, `${name}.png`) });
          }
        }
        check(seen.size === 5, `towers stand for all five roots (got ${[...seen].join(', ')})`);
        const empty = city.find((d) => d.tower.floors.length === 0);
        if (empty) {
          const [, eye, target] = towerViews(empty, true)[1];
          await setView(page, eye, target);
          await page.screenshot({ path: join(SHOTS, 'tower-empty.png') });
        }
      }

      if (ready) {
        // Picking: look straight at the first district's plinth and click the middle of the screen.
        const o = await page.evaluate(() => fetch('/api/city').then((r) => r.json()).then((d) => d[0].origin));
        await setView(page, [o.x + 40, 18, o.z + 40], [o.x, 2, o.z]);
        await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
        const pick = await page.evaluate(
          () => (window as unknown as { __palimpsest: { lastPick: { repo: string } | null } }).__palimpsest.lastPick,
        );
        check(pick?.repo === SAMPLE[0].fullName, `clicking a plinth picks its district (got ${pick?.repo ?? 'nothing'})`);

        await measureFps(page);
        check((await debug(page, (d) => d.quality())) === 'high', 'the city holds high quality at the default settings (no automatic drop)');
        await inspectorChecks(page);
        await rideChecks(page);
        await siteChecks(page);
        await disconnectWhileInspecting(page);
        await reposChecks(page);
        await freedPlotChecks(page);
        await settingsChecks(page, claudeSettingsPath);
        await viewGrowsChecks(page);
        await reconnectChecks(page, restart);
        await earnedChecks(page);
        await spireChecks(page);
        await revivalChecks(page);
        await ribbonChecks(page);
        await tourChecks(page);
        await dossierChecks(page);
        await quarterChecks(page);
        await darkTowerChecks(page);
        await exchangeChecks(page);
        // The job board (Task 36): a refusal it provokes on purpose shows in the console as a failed 409, excused here.
        const refusals = await jobBoardChecks(page, check, SHOTS);
        for (let i = 0; i < refusals; i++) {
          const k = consoleErrors.findIndex((t) => /status of 409/.test(t));
          if (k >= 0) consoleErrors.splice(k, 1);
        }
        // The job, run and inspection pages (Task 37).
        await detailChecks(page, check, SHOTS);
        // The firms list, a firm's page and the agent page (Task 38).
        await firmChecks(page, check, SHOTS);
        await rideAgentChecks(page);
        // The treasury and the daily report (Task 39).
        await treasuryChecks(page, check, SHOTS);
        // The notice stack: one Dismiss each, keyed replacement, recall, the keyboard, and clear of an open sheet (Phase 3 Task 12).
        await noticeChecks(page, check, SHOTS);
        // The market switches on Repos, the district page and the provider settings (Task 40).
        await marketChecks(page, check, SHOTS);
        // The README audit on the district page, its own page, proposals with their claims and the scope editor (Phase 3 Task 10).
        const scopeRefusals = await auditChecks(page, check, SHOTS);
        for (let i = 0; i < scopeRefusals; i++) {
          const k = consoleErrors.findIndex((t) => /status of 409/.test(t));
          if (k >= 0) consoleErrors.splice(k, 1);
        }
        // The morning brief: the day's first open, every action in place, a second window (Phase 3 Task 11).
        await briefChecks(page, check, SHOTS);
        await constructionChecks(page);
        await lifecycleChecks(page);
        await silhouetteChecks(page);
        await riverChecks(page);
        await transitChecks(page);
        await vehicleChecks(page);
        await peopleChecks(page);
        await ambientChecks(page);
        await everyScreenChecks(page, consoleErrors);
        const spiresBefore = (await page.evaluate('window.__palimpsest.milestones()')) as SpireShow[];
        const highHome = await homeBreakdown(page);
        await qualityDropChecks(page, consoleErrors);
        await spireAfterDropChecks(page, spiresBefore);
        await tierBudgetChecks(page, highHome);
      }
    }

    check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);

    // The empty morning (Phase 3 Task 11), last: on a fresh home with no repos, since the economy's is never empty.
    await page.close();
    if (!forceDrop && !spireOnly) {
      await server.close();
      process.env.PALIMPSEST_HOME = join(tmp, 'home-empty');
      server = await startServer({ port: PORT, claudeSettingsPath, keychain });
      await emptyMorningChecks(browser, `http://127.0.0.1:${PORT}`, check, SHOTS);
    }
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  // A partial mode never reads as a full pass (tools/ui-verdict.ts).
  const v = verdict(failures, partialMode(process.env));
  console.log(`\n${v.line}`);
  process.exit(v.code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
