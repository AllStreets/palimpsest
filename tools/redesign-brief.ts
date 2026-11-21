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
 * top), brief-1280.png (a 1280 x 800 window) and brief-reduced-motion.png
 * (prefers-reduced-motion emulated).
 *
 * frames, at perf's 1512 x 890 window and 2x, on high and on medium with
 * the governor held: the city alone from home, then the Brief open over it,
 * then terminal mode open over the screens framing (the gallery's terminal kind, Task 12),
 * each over REDESIGN_RUNS (3) runs of 5 s after a settle, through the debug
 * handle's frameLog. Writes frames.json with every frame's median and p95.
 * REDESIGN_UNCAPPED=1 measures with vsync and the frame-rate limit lifted
 * (frames-uncapped.json): at 60 Hz both views sit at 16.7 ms, so only the
 * uncapped times show what the Brief's drawing costs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Browser, Page } from 'playwright';

import { framings, launch, PERF_VIEW, pageUrl, ready, redesignHome, redesignPort, settle, STILL_VIEW, toCity, view } from './redesign-harness.js';
import type { Frame } from './redesign-harness.js';

const PORT = redesignPort();
const HOME_ROOT = redesignHome();

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

/** Terminal mode open over the screens framing (Task 12): the gallery's terminal kind, over the city alone. */
async function openTerminal(page: Page, f: Frame): Promise<void> {
  await toCity(page);
  await view(page, f);
  await page.evaluate(() => (window as unknown as { __palimpsest: { osGallery(k: string): void } }).__palimpsest.osGallery('terminal'));
  await page.waitForSelector('.os-terminal:not([hidden])', { timeout: 15_000 });
  await page.mouse.move(STILL_VIEW.width - 8, STILL_VIEW.height - 8);
  // Long enough for the title to type and the city's filter to ease in.
  await page.waitForTimeout(2000);
  await view(page, f);
  await settle(page);
}

async function stills(out: string, browser: Browser): Promise<void> {
  const url = pageUrl(PORT);
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

async function frames(out: string, browser: Browser): Promise<void> {
  const runs = Number(process.env.REDESIGN_RUNS ?? 3);
  const result: Record<string, Record<string, { median: number; p95: number; frames: number; runs: Array<{ median: number; p95: number }> }>> = {};
  for (const tier of ['high', 'medium'] as const) {
    await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ quality: tier }),
    });
    const page = await browser.newPage({ viewport: PERF_VIEW, deviceScaleFactor: 2 });
    await ready(page, pageUrl(PORT));
    const stands = await page.evaluate('window.__palimpsest.quality()');
    if (stands !== tier) throw new Error(`frames: the city opened at ${stands}, not ${tier}`);
    const f = await framings(page, PERF_VIEW.width, PERF_VIEW.height);
    result[tier] = {};
    for (const mode of ['city', 'brief', 'terminal'] as const) {
      if (mode === 'city') {
        await toCity(page);
        await view(page, f.overview);
      } else if (mode === 'brief') {
        await openBrief(page, f.screens);
      } else {
        await openTerminal(page, f.screens);
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
  const out = resolve(outArg ?? join(HOME_ROOT, mode));
  mkdirSync(out, { recursive: true });
  // REDESIGN_UNCAPPED=1 lifts vsync and the frame-rate limit, so a frame's time is its cost and not the 60 Hz refresh.
  const run = await launch({ uncapped: process.env.REDESIGN_UNCAPPED === '1' });
  const { browser } = run;
  try {
    if (mode === 'stills') await stills(out, browser);
    else await frames(out, browser);
  } finally {
    await run.close();
  }
  console.log(`Wrote to ${out}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
