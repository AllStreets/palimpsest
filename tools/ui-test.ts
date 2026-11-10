/**
 * End-to-end UI check. Starts its own engine in-process on port 4779 with a
 * temp data home (never the real engine on 4770), seeds the sample city
 * (tools/sample.ts), opens the built UI in Chromium and checks that the
 * city renders without console errors. Saves screenshots to shots/.
 *
 * The Repos and Settings checks fake every gh/git call in-process (setRunner),
 * and the usage hook buttons write only to a temp claude settings file.
 *
 * Run after `npm run build`: `npm run ui-test`. Optional: UI_DPR=2 renders
 * at retina density, UI_QUALITY=medium switches the quality setting first,
 * UI_TOWER_SHOTS=all adds close shots of every root and era for the quality
 * rounds.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { repoMarketDefaults } from '../shared/market-rules.js';
import { layoutTower } from '../shared/tower-layout.js';
import { QUARTER_OFFSETS } from '../shared/district-layout.js';
import type { District, Era, FirmView, Quarter, Repo, TowerSpec } from '../shared/types.js';
import { BOARD_ORDER, boardFrame, boardTowers, boardViews } from './agent-board.js';
import { SAMPLE, SAMPLE_OTHERS, SAMPLE_UNREADABLE, sampleGh, seedSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, 'shots');
const PORT = 4779;
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

function debug<T>(page: Page, read: (d: Debug) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__palimpsest)`) as Promise<T>;
}

const cityOf = (page: Page): Promise<District[]> =>
  page.evaluate(() => fetch('/api/city').then((r) => r.json())) as Promise<District[]>;

// ---------------------------------------------------------------- fps

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
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const ready = await page
    .waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check(ready && thrown.length === 0, `a corrupt kits.glb still opens the city (${thrown.join(' | ') || 'no errors'})`);
  const districts = (await page.evaluate(() => (window as unknown as { __palimpsest?: { districts: number } }).__palimpsest?.districts ?? 0)) as number;
  check(districts === SAMPLE.length, `and stands every district on plain blocks (${districts})`);
  const notice = (await page.locator('.city-notice p').textContent()) ?? '';
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
  await seedEconomy();
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
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
    if (p) check(/^(\d+ agents?, -?\d+ credits|bankrupt)$/.test(p.sub), `its plate says "${p.sub}"`);
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

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html missing: run npm run build first');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-ui-test-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(SHOTS, { recursive: true });

  await seedSample();
  const { setRunner } = await import('../engine/exec.js');
  // Slow enough that each analysis step is visible, and never the network.
  setRunner(sampleGh(450));
  const { startServer } = await import('../engine/server.js');
  let server = await startServer({ port: PORT, claudeSettingsPath });
  const restart = async (whileDown: () => Promise<void>): Promise<void> => {
    await server.close();
    await whileDown();
    await new Promise((r) => setTimeout(r, 500));
    server = await startServer({ port: PORT, claudeSettingsPath });
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
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    if (process.env.UI_QUALITY) {
      await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
        method: 'PATCH',
        headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ quality: process.env.UI_QUALITY }),
      });
    }
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const ready = await page
      .waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false);
    check(ready, 'city reports ready');
    await page.waitForTimeout(3000);

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
      await siteChecks(page);
      await disconnectWhileInspecting(page);
      await reposChecks(page);
      await freedPlotChecks(page);
      await settingsChecks(page, claudeSettingsPath);
      await viewGrowsChecks(page);
      await reconnectChecks(page, restart);
      await earnedChecks(page);
      await quarterChecks(page);
      await silhouetteChecks(page);
    }

    check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nui-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
