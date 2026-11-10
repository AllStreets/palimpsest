/**
 * README and profile media, captured frame by frame from the real app.
 *
 * Starts its own engine in-process on port 4789 with a temp data home and a
 * temp claude settings file (never the real engine on 4770, never the real
 * data home), seeds the sample city from tools/sample.ts, answers every gh
 * and git call with the sample's stand-in, opens the built UI in Chromium on
 * the GPU at 2x density, and drives the camera through the app's own debug
 * handle (`window.__palimpsest.view`). Every frame is set explicitly and
 * rendered before its screenshot, so the clips never drop or repeat a frame.
 * Frames are downscaled and encoded with ffmpeg.
 *
 *   npm run build
 *   node --no-warnings --import tsx tools/capture.ts [shots...]
 *
 * Shots: hero, stills (tower, root, datum), overview, inspector, repos,
 * settings, flyover, rise, probe. With no shots named, all but probe run.
 * The city-only shots hide the running head and the name plates; overview,
 * inspector, repos and settings show the app as it is.
 * Options (env): CAPTURE_FPS=30, CAPTURE_DPR=2, CAPTURE_KEEP=1 keeps the raw frames,
 * CAPTURE_OUT=<dir> writes somewhere other than docs/media (for probing),
 * PROBE='[[[eye],[target]], ...]' for quick stills in the probe shot, PROBE_CHROME=1
 * keeps the running head and plates in them, PROBE_RESTYLE (see the probe
 * shot) rebuilds towers in named variants, CAPTURE_CITY=tall seeds the
 * sample repos as four short towers and two at the 120-floor cap.
 *
 * Re-run it whenever the city changes, and add a shot here for each new
 * thing worth showing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District } from '../shared/types.js';
import { SAMPLE, SAMPLE_TALL, sampleGh, seedSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// CAPTURE_OUT sends everything elsewhere, for framing probes that should not touch docs/media.
const MEDIA = process.env.CAPTURE_OUT ?? join(ROOT, 'docs', 'media');
const PORT = 4789;
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FPS = Number(process.env.CAPTURE_FPS ?? 30);
const DPR = Number(process.env.CAPTURE_DPR ?? 2);
// 16:10, the whole window: it fits the 800x500 profile card with nothing cropped.
const VIEWPORT = { width: 1600, height: 1000 };

type V3 = [number, number, number];

// ---------------------------------------------------------------- camera helpers

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Smooth start and stop, human-paced. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Gentler: a sine ease, for long moves. */
const easeSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;

async function frame(page: Page, eye: V3, target: V3): Promise<void> {
  await page.evaluate(([e, t]) => {
    (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
  }, [eye, target] as [V3, V3]);
  // Two animation frames: the view is applied, then a whole frame renders with it.
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

interface Shot {
  name: string;
  seconds: number;
  /** Camera at t in [0, 1]. */
  at(t: number): { eye: V3; target: V3 };
}

// ---------------------------------------------------------------- encoding

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
}

function mb(path: string): string {
  return `${(statSync(path).size / 1e6).toFixed(1)} MB`;
}

/**
 * From 2x PNG frames: a 1600x1000 H.264 MP4 (yuv420p), an animated AVIF at
 * 1280x800 for the README, an 800x500 AVIF with a WebP fallback for the
 * GitHub profile card, and a 480x300 GIF fallback.
 */
function encode(dir: string, name: string): void {
  const input = ['-framerate', String(FPS), '-i', join(dir, 'f%04d.png')];
  const mp4 = join(MEDIA, `${name}.mp4`);
  ff([...input, '-vf', 'scale=1600:1000:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  const avif = join(MEDIA, `${name}.avif`);
  ff([...input, '-vf', 'scale=1280:800:flags=lanczos', '-c:v', 'libsvtav1', '-preset', '4', '-crf', '30', '-g', '120', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', avif]);
  // The GitHub profile card: 800x500. AVIF first (a moving camera is cheap in AV1), WebP as its fallback.
  const cardAvif = join(MEDIA, `${name}-card.avif`);
  ff([...input, '-vf', 'fps=20,scale=800:500:flags=lanczos', '-c:v', 'libsvtav1', '-preset', '4', '-crf', '32', '-g', '100', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', cardAvif]);
  // Card frames at 800x500, 15 fps, for the WebP and the GIF.
  const small = join(dir, 'small');
  mkdirSync(small, { recursive: true });
  ff([...input, '-vf', 'fps=15,scale=800:500:flags=lanczos', join(small, 's%04d.png')]);
  const frames = readdirSync(small).filter((f) => f.endsWith('.png')).sort();
  const webp = join(MEDIA, `${name}-card.webp`);
  // Keyframes every 15 frames so dark gradients never keep stale blocks.
  execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '62', '-m', '6', '-kmax', '15', '-d', String(Math.round(1000 / 15)), ...frames.map((f) => join(small, f)), '-o', webp], {
    stdio: 'inherit',
  });
  const gif = join(MEDIA, `${name}.gif`);
  // A moving camera changes every pixel, so the GIF fallback is kept small: 480x300, 10 fps, 96 colours.
  ff(['-i', mp4, '-vf', 'fps=10,scale=480:300:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', gif]);
  console.log(`  ${name}: mp4 ${mb(mp4)}, avif ${mb(avif)}, card avif ${mb(cardAvif)}, card webp ${mb(webp)}, gif ${mb(gif)}`);
}

async function record(page: Page, shot: Shot): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `palimpsest-${shot.name}-`));
  const n = Math.round(shot.seconds * FPS);
  console.log(`${shot.name}: ${n} frames`);
  for (let i = 0; i < n; i++) {
    const { eye, target } = shot.at(n === 1 ? 0 : i / (n - 1));
    await frame(page, eye, target);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
    if (i % 60 === 0) process.stdout.write(`  ${i}/${n}\r`);
  }
  encode(dir, shot.name);
  if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

async function still(page: Page, name: string, eye: V3, target: V3): Promise<void> {
  await frame(page, eye, target);
  await page.waitForTimeout(300);
  await frame(page, eye, target);
  await save(page, name, 86);
}

/**
 * Screenshots the page at 2x and writes the WebP the README shows. Only the
 * hero keeps its full-size PNG as well (for the profile and the release
 * page); the other PNGs are removed once their WebP is written, unless
 * CAPTURE_OUT sends the shots somewhere else for review.
 */
async function save(page: Page, name: string, quality: number): Promise<void> {
  const path = join(MEDIA, `${name}.png`);
  const webp = join(MEDIA, `${name}.webp`);
  await page.screenshot({ path });
  execFileSync('cwebp', ['-q', String(quality), '-m', '6', path, '-o', webp], { stdio: 'ignore' });
  console.log(`  ${name}.png ${mb(path)}, .webp ${mb(webp)}`);
  if (name !== 'hero' && !name.startsWith('probe') && !process.env.CAPTURE_OUT) rmSync(path);
}

// ---------------------------------------------------------------- shots

/** A still of the page as it stands, UI and all. Interface text gets a higher WebP quality than the city. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await save(page, name, 92);
}

/** Hides the running head and the name plates, for the shots that show only the city. */
async function chrome(page: Page, on: boolean): Promise<void> {
  await page.evaluate((show) => {
    let style = document.getElementById('capture-chrome');
    if (!style) {
      style = document.createElement('style');
      style.id = 'capture-chrome';
      document.head.append(style);
    }
    style.textContent = show ? '' : '.runhead, .plates { display: none !important; }';
  }, on);
}

/** Opens a screen from the running head, as a click would, and waits for it to settle. */
async function openScreen(page: Page, route: 'city' | 'repos' | 'settings', ready: string): Promise<void> {
  await page.locator(`.runhead a[data-route="${route}"]`).click();
  await page.waitForSelector(ready, { timeout: 10_000 });
  await page.waitForTimeout(1200);
}

function shots(city: District[]): Record<string, (page: Page) => Promise<void>> {
  const by = (repo: string): District => {
    const d = city.find((c) => c.repo === repo);
    if (!d) throw new Error(`no district ${repo}`);
    return d;
  };
  const tall = by('tidewater/harbor-ledger');
  const tallLay = layoutTower(tall.tower);
  const gothic = by('lantern/assay-kit');
  const gothicLay = layoutTower(gothic.tower);
  const pagoda = by('hoshi/kumo');
  const pagodaLay = layoutTower(pagoda.tower);

  return {
    async probe(page) {
      // One still per [eye, target] pair, written to probe-N.png for framing new shots.
      // PROBE_CHROME=1 keeps the running head and plates.
      await chrome(page, !!process.env.PROBE_CHROME);
      // PROBE_RESTYLE='{"owner/repo": {"ids": ["brick:salmon"], "datum": 20}}' rebuilds towers in named variants first.
      const restyles = JSON.parse(process.env.PROBE_RESTYLE ?? '{}') as Record<string, { ids: string[]; datum?: number }>;
      for (const [repo, r] of Object.entries(restyles)) {
        await page.evaluate(([rp, ids, at]) => (window as unknown as { __palimpsest: { restyle(r: string, i: string[], d?: number): void } }).__palimpsest.restyle(rp, ids, at), [repo, r.ids, r.datum] as [string, string[], number | undefined]);
      }
      if (Object.keys(restyles).length) await page.waitForTimeout(3000);
      const views = JSON.parse(process.env.PROBE ?? '[[[600,160,700],[0,80,0]]]') as [V3, V3][];
      for (const [i, [eye, target]] of views.entries()) await still(page, `probe-${i}`, eye, target);
    },

    async hero(page) {
      // The whole sample city at dusk from above the rooftops, the sunlit faces turned to the eye.
      await chrome(page, false);
      await still(page, 'hero', HERO.eye, HERO.target);
    },

    async stills(page) {
      await chrome(page, false);
      // One whole tower, root to crown: the pagoda, lit by the low sun, the rest of the skyline behind it.
      const k = pagoda.origin;
      await still(page, 'tower', [k.x - 480, 30, k.z + 120], [k.x, pagodaLay.top * 0.5, k.z]);
      const o = gothic.origin;
      await still(page, 'root', [o.x - 58, 6, o.z + 66], [o.x, gothicLay.rootHeight * 0.55, o.z]);
      const t = tall.origin;
      // From just below the top, so the datum band and the crown stand against the sky.
      await still(page, 'datum', [t.x - 90, tallLay.datumY - 27, t.z + 80], [t.x, tallLay.datumY - 17, t.z]);
    },

    async overview(page) {
      // The app as it opens: the city, the running head and every district's name plate.
      await chrome(page, true);
      await still(page, 'overview', OVERVIEW.eye, OVERVIEW.target);
    },

    async inspector(page) {
      // Click a tower, then a floor in the list: the camera flies to it and the floor is marked.
      await chrome(page, true);
      await frame(page, OVERVIEW.eye, OVERVIEW.target);
      await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), gothic.repo);
      await page.waitForSelector('.inspector.open', { timeout: 5000 });
      await page.waitForTimeout(2500);
      const rows = await page.locator('.insp-floor').count();
      const row = page.locator('.insp-floor').nth(Math.floor(rows * 0.3));
      await row.click();
      await page.waitForTimeout(3000);
      // Scroll the list so it starts on the era heading above the chosen floor, never on a half-cut row.
      await row.evaluate((r) => {
        let head = r.previousElementSibling;
        while (head && !head.classList.contains('insp-era')) head = head.previousElementSibling;
        let box = r.parentElement;
        while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
        if (head && box) box.scrollTop += head.getBoundingClientRect().top - box.getBoundingClientRect().top;
      });
      await page.waitForTimeout(400);
      await shoot(page, 'inspector');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    },

    async repos(page) {
      await chrome(page, true);
      await frame(page, SCREENS.eye, SCREENS.target);
      await openScreen(page, 'repos', '.sheet.repos .repo-row');
      await shoot(page, 'repos');
      await openScreen(page, 'city', '.runhead');
    },

    async settings(page) {
      await chrome(page, true);
      await frame(page, SCREENS.eye, SCREENS.target);
      await openScreen(page, 'settings', '.sheet.settings .usage-five');
      // Installed, as it is once you use it: the hook writes only to this run's temp claude settings file.
      await page.locator('.hook-install').click();
      await page.waitForFunction(() => /installed/i.test(document.querySelector('.hook-state')?.textContent ?? '') && !/not/i.test(document.querySelector('.hook-state')?.textContent ?? ''), null, { timeout: 5000 });
      await page.waitForTimeout(600);
      await shoot(page, 'settings');
      await openScreen(page, 'city', '.runhead');
    },

    async flyover(page) {
      // A slow arc across the skyline, the low sun drifting across the frame behind the towers.
      await chrome(page, false);
      await record(page, {
        name: 'flyover',
        seconds: 14,
        at(t) {
          const k = easeSine(t);
          const a = lerp(FLY.a0, FLY.a1, k);
          const r = lerp(FLY.r0, FLY.r1, k);
          const eye: V3 = [FLY.cx + Math.cos(a) * r, lerp(FLY.y0, FLY.y1, k), FLY.cz + Math.sin(a) * r];
          const target: V3 = [FLY.cx, lerp(FLY.ty0, FLY.ty1, k), FLY.cz];
          return { eye, target };
        },
      });
    },

    async rise(page) {
      // Up the tallest tower from its root to the bronze datum line, slowly circling it.
      await chrome(page, false);
      const { x, z } = tall.origin;
      await record(page, {
        name: 'rise',
        seconds: 14,
        at(t) {
          // Move for the first 86% of the take, then hold on the datum line.
          const k = easeSine(Math.min(1, t / 0.86));
          const y = lerp(tallLay.rootHeight * 0.5, tallLay.datumY - 12, k);
          const a = lerp(2.0, 2.75, k);
          const r = lerp(72, 120, k);
          const eye: V3 = [x + Math.cos(a) * r, Math.max(2, y + lerp(-4, 10, k)), z + Math.sin(a) * r];
          const target: V3 = [x, y + lerp(6, 0, k), z];
          return { eye, target };
        },
      });
    },
  };
}

/** Framings tuned by eye in the quality rounds (see the probe shot). */
const HERO: { eye: V3; target: V3 } = { eye: [700, 70, 700], target: [0, 170, 80] };
const OVERVIEW: { eye: V3; target: V3 } = { eye: [540, 380, 960], target: [-40, 70, 0] };
const SCREENS: { eye: V3; target: V3 } = { eye: [-700, 90, 520], target: [160, 150, -200] };
const FLY = { cx: 0, cz: 80, a0: 0.42, a1: 1.12, r0: 980, r1: 840, y0: 110, y1: 72, ty0: 175, ty1: 160 };

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html missing: run npm run build first');
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['hero', 'stills', 'overview', 'inspector', 'repos', 'settings', 'flyover', 'rise'];
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-capture-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(MEDIA, { recursive: true });

  // CAPTURE_CITY=tall seeds the same repos in a working developer's shape (four short towers, two at the cap), for probes.
  await seedSample(Date.now(), process.env.CAPTURE_CITY === 'tall' ? SAMPLE_TALL : SAMPLE);
  // Every gh and git call goes to the sample's stand-in: the Repos screen lists only fictional repos.
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, {
      timeout: 60_000,
    });
    // Let the veil fade out completely before any frame is taken.
    await page.waitForTimeout(2500);
    const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
    const all = shots(city);
    for (const name of wanted) {
      if (!all[name]) throw new Error(`unknown shot ${name}`);
      await all[name](page);
    }
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
