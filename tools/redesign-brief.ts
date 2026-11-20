/**
 * The screens redesign's Brief harness (Stage 1): the six stills every Brief
 * direction is judged by, and the Brief's frame times against the city alone.
 *
 * Starts its own engine in-process on REDESIGN_PORT (4789 by default; 4770
 * and 4771 are refused) with a data home under REDESIGN_HOME (a scratch
 * folder, never the real data home), seeds the sample city and the sample
 * economy (as CAPTURE_ECONOMY=1 does), and opens the built UI in Chromium on
 * the GPU.
 *
 *   npm run build
 *   REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-brief.ts stills <out dir>
 *   REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-brief.ts frames <out dir>
 *
 * stills, at capture's 1600 x 1000 window and 2x: brief.png (its first
 * screen over the screens framing), brief-scrolled.png (its body scrolled to
 * the end), brief-overview.png (over the overview, the city at its
 * brightest framing), brief-autonomy.png (the city's autonomy ask at the
 * top), brief-1280.png (a 1280 x 800 window), brief-reduced-motion.png
 * (prefers-reduced-motion emulated) and brief-closed.png (the city over the
 * first still's framing once the Brief has closed, its own plates back).
 *
 * frames, at perf's 1512 x 890 window and 2x, on high and on medium with
 * the governor held: the city alone from home, then the Brief open over it,
 * each over REDESIGN_RUNS (3) runs of 5 s after a settle, through the debug
 * handle's frameLog. Writes frames.json with every frame's median and p95.
 * REDESIGN_UNCAPPED=1 measures with vsync and the frame-rate limit lifted
 * (frames-uncapped.json): at 60 Hz both views sit at 16.7 ms, so only the
 * uncapped times show what the Brief's drawing costs.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { cityExtent, viewLimits } from '../app/src/city/view.js';
import type { District } from '../shared/types.js';
import { paneFraming } from './pane-framing.js';
import { sampleGh, seedSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.REDESIGN_PORT ?? 4789);
if (PORT === 4770 || PORT === 4771) throw new Error(`REDESIGN_PORT ${PORT} is the real engine's or the dev server's`);
const HOME_ROOT = process.env.REDESIGN_HOME;
if (!HOME_ROOT) throw new Error('REDESIGN_HOME must name a scratch folder');
const STILL_VIEW = { width: 1600, height: 1000 };
const PERF_VIEW = { width: 1512, height: 890 };
type V3 = [number, number, number];
type Frame = { eye: V3; target: V3 };

async function view(page: Page, f: Frame): Promise<void> {
  await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t), [f.eye, f.target]);
}
const settle = (page: Page): Promise<unknown> => page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
}

async function framings(page: Page, w: number, h: number): Promise<{ screens: Frame; overview: Frame }> {
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const aspect = w / h;
  const lim = viewLimits(cityExtent(city), aspect);
  const sheetW = Math.min(760, Math.max(600, 0.47 * w));
  return { screens: paneFraming(lim.home, sheetW / w, 1, 36, aspect, 1.35) as Frame, overview: lim.home as Frame };
}

async function openBrief(page: Page, f: Frame): Promise<void> {
  await view(page, f);
  await page.evaluate(() => {
    location.hash = '#/brief';
  });
  await page.waitForSelector('.sheet.brief .brief-item', { timeout: 15_000 });
  await page.mouse.move(STILL_VIEW.width - 8, STILL_VIEW.height - 8);
  // Long enough for any type-in or entrance to finish.
  await page.waitForTimeout(4500);
  await view(page, f);
  await settle(page);
}

async function toCity(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForSelector('body[data-route="city"]', { timeout: 10_000 });
  await page.waitForTimeout(900);
}

async function stills(out: string, browser: import('playwright').Browser): Promise<void> {
  const url = `http://127.0.0.1:${PORT}/?fixed-quality&debug`;
  const shot = async (page: Page, name: string): Promise<void> => {
    await settle(page);
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(`  ${name}.png`);
  };
  {
    const page = await browser.newPage({ viewport: STILL_VIEW, deviceScaleFactor: 2 });
    await ready(page, url);
    const f = await framings(page, STILL_VIEW.width, STILL_VIEW.height);
    await openBrief(page, f.screens);
    await shot(page, 'brief');
    await page.locator('.sheet.brief .sheet-body').evaluate((b) => {
      b.scrollTop = b.scrollHeight;
    });
    await page.waitForTimeout(1500);
    await shot(page, 'brief-scrolled');
    await page.locator('.sheet.brief .brief-item[data-item^="autonomy:"]').first().evaluate((sec) => {
      const body = sec.closest('.sheet-body') as HTMLElement;
      body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
    });
    await page.waitForTimeout(1500);
    await shot(page, 'brief-autonomy');
    await toCity(page);
    await openBrief(page, f.overview);
    await page.locator('.sheet.brief .sheet-body').evaluate((b) => {
      b.scrollTop = 0;
    });
    await shot(page, 'brief-overview');
    // The Brief closed again over the first still's framing: the city's own plates are back, the HUD gone.
    await toCity(page);
    await view(page, f.screens);
    await page.waitForTimeout(1500);
    await shot(page, 'brief-closed');
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await ready(page, url);
    const f = await framings(page, 1280, 800);
    await openBrief(page, f.screens);
    await shot(page, 'brief-1280');
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: STILL_VIEW, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await ready(page, url);
    const f = await framings(page, STILL_VIEW.width, STILL_VIEW.height);
    // Shot early: with reduced motion the page must read whole at once, with no type-in to wait for.
    await view(page, f.screens);
    await page.evaluate(() => {
      location.hash = '#/brief';
    });
    await page.waitForSelector('.sheet.brief .brief-item', { timeout: 15_000 });
    await page.mouse.move(STILL_VIEW.width - 8, STILL_VIEW.height - 8);
    await page.waitForTimeout(700);
    await view(page, f.screens);
    await shot(page, 'brief-reduced-motion');
    await page.close();
  }
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : 0;
};

async function frames(out: string, browser: import('playwright').Browser): Promise<void> {
  const runs = Number(process.env.REDESIGN_RUNS ?? 3);
  const result: Record<string, Record<string, { median: number; p95: number; frames: number; runs: Array<{ median: number; p95: number }> }>> = {};
  for (const tier of ['high', 'medium'] as const) {
    await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ quality: tier }),
    });
    const page = await browser.newPage({ viewport: PERF_VIEW, deviceScaleFactor: 2 });
    await ready(page, `http://127.0.0.1:${PORT}/?fixed-quality&debug`);
    const stands = await page.evaluate('window.__palimpsest.quality()');
    if (stands !== tier) throw new Error(`frames: the city opened at ${stands}, not ${tier}`);
    const f = await framings(page, PERF_VIEW.width, PERF_VIEW.height);
    result[tier] = {};
    for (const mode of ['city', 'brief'] as const) {
      if (mode === 'city') {
        await toCity(page);
        await view(page, f.overview);
      } else {
        await openBrief(page, f.screens);
      }
      await page.waitForTimeout(1500);
      const all: number[] = [];
      const each: Array<{ median: number; p95: number }> = [];
      for (let i = 0; i < runs; i++) {
        await page.evaluate('window.__palimpsest.frameLog.start()');
        await page.waitForTimeout(5000);
        const ms = ((await page.evaluate('window.__palimpsest.frameLog.stop()')) as number[]).filter((t) => t > 0);
        all.push(...ms);
        each.push({ median: pct(ms, 0.5), p95: pct(ms, 0.95) });
      }
      result[tier][mode] = { median: pct(all, 0.5), p95: pct(all, 0.95), frames: all.length, runs: each };
      console.log(`${tier} ${mode}: median ${pct(all, 0.5).toFixed(2)} ms, p95 ${pct(all, 0.95).toFixed(2)} ms over ${all.length} frames (${each.map((r) => `${r.median.toFixed(1)}/${r.p95.toFixed(1)}`).join(', ')})`);
    }
    await page.close();
  }
  writeFileSync(join(out, process.env.REDESIGN_UNCAPPED === '1' ? 'frames-uncapped.json' : 'frames.json'), JSON.stringify(result, null, 1));
}

async function main(): Promise<void> {
  const [mode, outArg] = process.argv.slice(2);
  if (mode !== 'stills' && mode !== 'frames') throw new Error('usage: redesign-brief.ts stills|frames <out dir>');
  const out = resolve(outArg ?? join(HOME_ROOT!, mode));
  mkdirSync(out, { recursive: true });
  const tmp = join(HOME_ROOT!, `run-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  const at = Date.now();
  await seedSample(at);
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  const { useSampleFolders } = await import('../engine/sample.js');
  useSampleFolders();
  const projects = process.env.PALIMPSEST_CLAUDE_PROJECTS ?? '';
  if (!resolve(projects).startsWith(resolve(tmp))) throw new Error(`the transcripts folder ${projects} is not inside ${tmp}; refusing to run`);
  const { seedEconomy } = await import('../engine/market/sample-economy.js');
  await seedEconomy(at, {});
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  (await import('../engine/school/campus.js')).ensureCampus();
  // REDESIGN_UNCAPPED=1 lifts vsync and the frame-rate limit, so a frame's time is its cost and not the 60 Hz refresh.
  const uncapped = process.env.REDESIGN_UNCAPPED === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', ...uncapped] });
  try {
    if (mode === 'stills') await stills(out, browser);
    else await frames(out, browser);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Wrote to ${out}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
