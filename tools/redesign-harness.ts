/**
 * What the screens redesign's tools share (redesign-brief.ts, os-stills.ts):
 * the guards, the launch of an engine and a GPU Chromium over the sample city
 * and economy, and the camera helpers every still is framed by.
 *
 * The engine runs in-process on REDESIGN_PORT (4789 by default; 4770 and 4771
 * are refused) with a data home under REDESIGN_HOME, a scratch folder that is
 * never the real data home. Nothing here runs at import: the guards are
 * functions, so a test can import the harness without a scratch home.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

import { cityExtent, viewLimits } from '../app/src/city/view.js';
import type { District } from '../shared/types.js';
import { paneFraming } from './pane-framing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** capture's window, for stills. */
export const STILL_VIEW = { width: 1600, height: 1000 };
/** perf's window, for frame times. */
export const PERF_VIEW = { width: 1512, height: 890 };
export type V3 = [number, number, number];
export type Frame = { eye: V3; target: V3 };

/** The port itself, unless it is the real engine's (4770) or the dev server's (4771). */
export function guardPort(port: number): number {
  if (port === 4770 || port === 4771) throw new Error(`REDESIGN_PORT ${port} is the real engine's or the dev server's`);
  return port;
}

/** REDESIGN_PORT, 4789 by default, guarded. */
export const redesignPort = (): number => guardPort(Number(process.env.REDESIGN_PORT ?? 4789));

/** REDESIGN_HOME, which must name a scratch folder. */
export function redesignHome(): string {
  const home = process.env.REDESIGN_HOME;
  if (!home) throw new Error('REDESIGN_HOME must name a scratch folder');
  return home;
}

/** The built UI's address on the harness's engine, with the debug handle and the quality held. */
export const pageUrl = (port: number): string => `http://127.0.0.1:${port}/?fixed-quality&debug`;

export async function view(page: Page, f: Frame): Promise<void> {
  await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t), [f.eye, f.target]);
}

export const settle = (page: Page): Promise<unknown> => page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

export async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
}

export async function framings(page: Page, w: number, h: number): Promise<{ screens: Frame; overview: Frame }> {
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const aspect = w / h;
  const lim = viewLimits(cityExtent(city), aspect);
  const sheetW = Math.min(760, Math.max(600, 0.47 * w));
  return { screens: paneFraming(lim.home, sheetW / w, 1, 36, aspect, 1.35) as Frame, overview: lim.home as Frame };
}

export async function toCity(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForSelector('body[data-route="city"]', { timeout: 10_000 });
  await page.waitForTimeout(900);
}

export interface Launched {
  browser: Browser;
  port: number;
  /** Closes the browser and the engine and removes the run's scratch home. */
  close(): Promise<void>;
}

/**
 * Seeds the sample city and the sample economy (as CAPTURE_ECONOMY=1 does) in
 * a fresh run folder under REDESIGN_HOME, starts the engine on REDESIGN_PORT
 * over the built UI, and opens Chromium on the GPU. `uncapped` lifts vsync
 * and the frame-rate limit, so a frame's time is its cost and not the refresh.
 */
export async function launch(opts: { uncapped?: boolean } = {}): Promise<Launched> {
  const port = redesignPort();
  const tmp = join(redesignHome(), `run-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  const at = Date.now();
  const { sampleGh, seedSample } = await import('./sample.js');
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
  const server = await startServer({ port, claudeSettingsPath });
  (await import('../engine/school/campus.js')).ensureCampus();
  const uncapped = opts.uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', ...uncapped] });
  return {
    browser,
    port,
    close: async () => {
      await browser.close();
      await server.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
