/**
 * Stills of the screens layer's debug gallery (app/src/ui/os/gallery.ts), one
 * kind at a time over the city at the screens framing, for critique.
 *
 *   npm run build
 *   REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/os-stills.ts <kind|all> <out dir>
 *
 * For each kind it writes <kind>.png (capture's 1600 x 1000 window at 2x),
 * <kind>-1280.png (a 1280 x 800 window) and <kind>-reduced-motion.png
 * (prefers-reduced-motion emulated). The engine, the port guard and the
 * scratch home are redesign-harness.ts's, shared with redesign-brief.ts.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Browser, Page } from 'playwright';

import { framings, launch, pageUrl, ready, redesignHome, settle, STILL_VIEW, toCity, view } from './redesign-harness.js';

/**
 * The kinds the gallery has built so far (gallery.ts GalleryKind); each later
 * task adds its own. Not imported from gallery.ts, which brings stylesheets.
 */
const BUILT = ['type'] as const;
type GalleryKind = (typeof BUILT)[number];

async function show(page: Page, kind: GalleryKind, w: number, h: number, wait: number): Promise<void> {
  // Over the city alone: the app may reopen on a screen.
  await toCity(page);
  const f = await framings(page, w, h);
  await view(page, f.screens);
  await page.evaluate((k) => (window as unknown as { __palimpsest: { osGallery(k: string): void } }).__palimpsest.osGallery(k), kind);
  await page.waitForSelector(`.os-gallery[data-kind="${kind}"]`, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.mouse.move(w - 8, h - 8);
  await page.waitForTimeout(wait);
  await view(page, f.screens);
  await settle(page);
}

async function stills(kind: GalleryKind, out: string, browser: Browser, port: number): Promise<void> {
  const shots: Array<{ name: string; size: { width: number; height: number }; reduced: boolean; wait: number }> = [
    { name: kind, size: STILL_VIEW, reduced: false, wait: 2000 },
    { name: `${kind}-1280`, size: { width: 1280, height: 800 }, reduced: false, wait: 2000 },
    // Shot early: with reduced motion the gallery must read whole at once.
    { name: `${kind}-reduced-motion`, size: STILL_VIEW, reduced: true, wait: 700 },
  ];
  for (const s of shots) {
    const page = await browser.newPage({ viewport: s.size, deviceScaleFactor: 2, reducedMotion: s.reduced ? 'reduce' : 'no-preference' });
    await ready(page, pageUrl(port));
    await show(page, kind, s.size.width, s.size.height, s.wait);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    console.log(`  ${s.name}.png`);
    await page.close();
  }
}

async function main(): Promise<void> {
  const [which, outArg] = process.argv.slice(2);
  const kinds: GalleryKind[] = which === 'all' ? [...BUILT] : BUILT.filter((k) => k === which);
  if (!kinds.length) throw new Error(`usage: os-stills.ts <${BUILT.join('|')}|all> <out dir>`);
  const out = resolve(outArg ?? join(redesignHome(), 'os-stills'));
  mkdirSync(out, { recursive: true });
  const run = await launch();
  try {
    for (const k of kinds) await stills(k, out, run.browser, run.port);
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
