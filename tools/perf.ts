/**
 * The city's frame budget, view by view: where the triangles and draw calls
 * go (by subsystem and by pass, through the debug handle's breakdown()), the
 * frame rate, and a still of each view for comparing looks before and after
 * a performance change (SSIM, with ffmpeg).
 *
 * Starts its own engine in-process on port 4791 with a temp data home (never
 * the real engine on 4770, never the real data home), seeds the sample city
 * and the sample economy at a fixed date so two runs build the same city,
 * and opens the built UI in Chromium on the GPU.
 *
 *   npm run build
 *   node --no-warnings --import tsx tools/perf.ts <out dir>
 *
 * Phase one shoots and measures each named view on the settled economy. Phase
 * two turns the economy's job sites live (four sites) and measures the city
 * from home and the overview with them, with the quality governor running.
 * Writes <out>/<view>.png, <out>/perf.json and prints a table.
 */
import './seeded-uuid.js';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';
import { seedSample, sampleGh } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = 4791;
const VIEWPORT = { width: 1600, height: 940 };
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
}
const dbg = <T>(page: Page, fn: string): Promise<T> => page.evaluate(`(${fn})(window.__palimpsest)`) as Promise<T>;
/** The breakdown, or an empty one on a build that has none (a baseline built from an older commit). */
const breakdownOf = (page: Page, detail: boolean): Promise<Breakdown> => dbg<Breakdown>(page, `(d) => d.breakdown ? d.breakdown(${detail}) : {}`);

function fps(page: Page): Promise<number> {
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
    ['street', [118, 2.2, 52], [118, 14, -260]],
    ['skyline-mid', [560, 140, 620], [80, 40, 40]],
    ['horizon', [-120, 60, 520], [-600, 40, -600]],
  ];
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

async function settle(page: Page, eye: V3, target: V3): Promise<void> {
  await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.view(e, t), [eye, target]);
  await page.waitForTimeout(600);
  await dbg(page, '(d) => d.precompile()');
  await page.waitForTimeout(1800);
}

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? join(ROOT, 'shots', 'perf'));
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-perf-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  await seedSample(SEED_AT);
  const { seedEconomy } = await import('../engine/market/sample-economy.js');
  await seedEconomy(SEED_AT);
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const result: Record<string, { stats: Tally; breakdown: Breakdown; fps: number }> = {};
  const only = process.env.PERF_ONLY?.split(',');
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const open = async (q: string): Promise<void> => {
      await page.goto(`http://127.0.0.1:${PORT}/?${q}`);
      await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 60_000 });
      await page.addStyleTag({ content: '.runhead, .plates { display: none !important; }' });
      await page.waitForTimeout(2500);
    };
    // PERF_GOVERNOR=1 leaves the quality governor running in phase one too.
    await open(process.env.PERF_GOVERNOR ? 'debug' : 'fixed-quality&debug');
    for (const [name, eye, target] of await views(page)) {
      if (only && !only.includes(name)) continue;
      await settle(page, eye, target);
      await page.screenshot({ path: join(out, `${name}.png`) });
      const breakdown = await breakdownOf(page, !!process.env.PERF_DETAIL);
      const f = await fps(page);
      const stats = await dbg<Tally>(page, '(d) => d.stats()');
      result[name] = { stats, breakdown, fps: f };
      console.log(`${name}: ${f.toFixed(0)} fps, steady ${stats.calls} calls ${(stats.triangles / 1e6).toFixed(2)}M; with the shadow redrawn ${sum(breakdown).calls} calls ${(sum(breakdown).triangles / 1e6).toFixed(2)}M`);
      console.log(table(name, breakdown));
    }
    if (!process.env.PERF_STATIC) {
      // Phase two: four live job sites, the governor running.
      const { setMarketExtras } = await import('../engine/market/api.js');
      const { economySites, economyTrips } = await import('../engine/market/sample-economy.js');
      setMarketExtras({ sites: economySites, trips: economyTrips });
      await open('debug');
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().length >= 4, null, { timeout: 15_000 }).catch(() => {});
      const nSites = await dbg<number>(page, '(d) => d.liveSites().length');
      const vs = await views(page);
      for (const [name, eye, target] of vs.filter(([n]) => n === 'home' || n === 'overview' || n === 'quarters')) {
        await settle(page, eye, target);
        await page.screenshot({ path: join(out, `live-${name}.png`) });
        const breakdown = await breakdownOf(page, false);
        const f = await fps(page);
        const stats = await dbg<Tally>(page, '(d) => d.stats()');
        result[`live-${name}`] = { stats, breakdown, fps: f };
        console.log(`live ${name} (${nSites} sites): ${f.toFixed(0)} fps, steady ${stats.calls} calls ${(stats.triangles / 1e6).toFixed(2)}M; with the shadow redrawn ${sum(breakdown).calls} calls ${(sum(breakdown).triangles / 1e6).toFixed(2)}M`);
        console.log(table(`live ${name}`, breakdown));
      }
      console.log(`quality after the live views: ${await dbg<string>(page, '(d) => d.quality()')}`);
      // How the frames ran over the live views: the slowest and the mean over a further ten seconds at home.
      await settle(page, vs[0][1], vs[0][2]);
      const frames = (await page.evaluate(`new Promise((resolve) => {
        const t = [];
        let last = performance.now();
        const t0 = last;
        function tick(now) {
          t.push(now - last);
          last = now;
          if (now - t0 < 10000) requestAnimationFrame(tick);
          else resolve(t);
        }
        requestAnimationFrame(tick);
      })`)) as number[];
      const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
      const slow = frames.filter((f) => f > 1000 / 48).length;
      console.log(`live home frames over 10 s: mean ${mean.toFixed(2)} ms, slowest ${Math.max(...frames).toFixed(1)} ms, ${slow} of ${frames.length} over 20.8 ms`);
      setMarketExtras({});
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
