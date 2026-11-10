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
 * settings, flyover, rise, probe, swatches, families, fidelity. With no shots named,
 * all but probe, swatches, families and fidelity run. families rebuilds the tallest
 * tower's sci-fi run in each family and shoots it close, then from the street. swatches measures every material variant's
 * rendered colour at the overview's distance (SWATCH_WRITE=1 writes
 * app/src/city/tower/rendered.ts).
 * The city-only shots hide the running head and the name plates; overview,
 * inspector, repos and settings show the app as it is.
 * Options (env): CAPTURE_FPS=30, CAPTURE_DPR=2, CAPTURE_KEEP=1 keeps the raw frames,
 * CAPTURE_OUT=<dir> writes somewhere other than docs/media (for probing),
 * PROBE='[[[eye],[target]], ...]' for quick stills in the probe shot, PROBE_CHROME=1
 * keeps the running head and plates in them, PROBE_RESTYLE (see the probe
 * shot) rebuilds towers in named variants, CAPTURE_CITY=tall seeds the
 * sample repos as four short towers and two at the 120-floor cap, and
 * CAPTURE_CITY=small leaves one 8 floor tower (for the view's framing
 * rounds; use with CAPTURE_OUT). CAPTURE_ECONOMY=1 seeds the sample economy
 * (engine/market/sample-economy.ts) on top, so towers carry earned, waiting
 * and scar floors; the `earned` shot frames them, and the `silhouettes` shot
 * stands one agent tower of each silhouette off the city (tools/agent-board.ts),
 * and the `quarters` shot frames the firms' quarters in the city.
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

import { FAMILIES, VARIANTS } from '../app/src/city/tower/variants.js';
import { cityExtent, viewLimits, type CityExtent } from '../app/src/city/view.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';
import { boardFrame, boardTowers, boardViews } from './agent-board.js';
import { ambientInputs, towerInputs } from './measure-inputs.js';
import { decodePng, labOf } from './png.js';
import { SAMPLE, SAMPLE_TALL, sampleGh, seedSample, shrinkSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// CAPTURE_OUT sends everything elsewhere, for framing probes that should not touch docs/media.
const MEDIA = process.env.CAPTURE_OUT ?? join(ROOT, 'docs', 'media');
const PORT = 4789;
/** The block pitch (lots.ts PITCH), for framing streets. */
const PITCH_M = 80;
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
    // A city reshaped for the framing rounds (CAPTURE_CITY=small) stands in its one tower.
    const d = city.find((c) => c.repo === repo) ?? (process.env.CAPTURE_CITY ? city[0] : undefined);
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

    async swatches(page) {
      // Every variant's rendered colour in the real scene light, haze and tone mapping, at the overview's distance:
      // the sunlit and shaded face of a short tower per variant, averaged over a patch and converted to Lab.
      // SWATCH_WRITE=1 writes app/src/city/tower/rendered.ts, which the picker steers neighbours apart by.
      await chrome(page, false);
      type P = [number, number];
      const points = (await page.evaluate(() => (window as unknown as { __palimpsest: { swatchBoard(): Promise<unknown> } }).__palimpsest.swatchBoard())) as Array<{ id: string; sun: P; shade: P; sunLow: P; shadeLow: P }>;
      await page.waitForTimeout(2500);
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const shot = await page.screenshot();
      writeFileSync(join(MEDIA, 'swatches.png'), shot);
      const img = decodePng(shot);
      const scale = img.width / VIEWPORT.width;
      const mean = ([cx, cy]: [number, number]): [number, number, number] => {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        // A 7 x 9 css-pixel patch: several windows and the wall between them, as the eye averages them from afar.
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const x = Math.round((cx + dx) * scale);
            const y = Math.round((cy + dy) * scale);
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const i = (y * img.width + x) * 4;
            r += img.data[i];
            g += img.data[i + 1];
            b += img.data[i + 2];
            n++;
          }
        }
        return labOf(r / n, g / n, b / n).map((v) => Math.round(v * 10) / 10) as [number, number, number];
      };
      type Lab = [number, number, number];
      const out: Record<string, { sun: Lab; shade: Lab; sunLow: Lab; shadeLow: Lab }> = {};
      for (const p of points) out[p.id] = { sun: mean(p.sun), shade: mean(p.shade), sunLow: mean(p.sunLow), shadeLow: mean(p.shadeLow) };
      const f = (v: Lab): string => `L${v[0]} a${v[1]} b${v[2]}`;
      for (const [id, v] of Object.entries(out)) console.log(`  ${id.padEnd(26)} high sun ${f(v.sun)} shade ${f(v.shade)}   low sun ${f(v.sunLow)} shade ${f(v.shadeLow)}`);
      const body = [
        '/**',
        " * Each variant's colour as the city renders it at the overview's distance",
        ' * and bearing: CIE Lab of the sunlit and the shaded face, with floors at',
        ' * tall-tower height (sun, shade) and at short-tower height over the street',
        ' * (sunLow, shadeLow). Measured by tools/capture.ts, the swatches shot.',
        ' *',
        ' * VERSIONED DATA. pickLooks chooses every tower\'s materials from these',
        ' * numbers, so regenerating this file is a city-wide look change: towers',
        ' * people already know can change their materials. Nothing regenerates it',
        ' * on its own (not the build, the tests or any default capture); only',
        ' * `SWATCH_WRITE=1 node --import tsx tools/capture.ts swatches`, run by',
        ' * hand as a deliberate change and committed with the reason.',
        ' */',
        `export const RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number]; sunLow?: [number, number, number]; shadeLow?: [number, number, number] }> = ${JSON.stringify(out, null, 2)};`,

        '',
        '/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */',
        `export const RENDERED_INPUTS = '${towerInputs()}';`,
        '',
      ].join('\n');
      // Writes the versioned data only when asked, by name, on the command line.
      writeFileSync(process.env.SWATCH_WRITE === '1' ? join(ROOT, 'app', 'src', 'city', 'tower', 'rendered.ts') : join(MEDIA, 'rendered.ts'), body);
    },

    async ambient(page) {
      // The ambient city's tones in the same light, one plain building per tone (app/src/city/ambient-swatches.ts).
      // AMBIENT_WRITE=1 writes app/src/city/ambient-rendered.ts; otherwise the numbers land beside the shots.
      await chrome(page, false);
      type P = [number, number];
      const points = (await page.evaluate(() => (window as unknown as { __palimpsest: { ambientBoard(): Promise<unknown> } }).__palimpsest.ambientBoard())) as Array<{ id: string; sun: P; shade: P }>;
      await page.waitForTimeout(2500);
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const shot = await page.screenshot();
      writeFileSync(join(MEDIA, 'ambient-swatches.png'), shot);
      const img = decodePng(shot);
      const scale = img.width / VIEWPORT.width;
      type Lab = [number, number, number];
      // A 7 x 9 css-pixel patch, as the swatches shot reads the towers.
      const mean = ([cx, cy]: P): Lab => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const x = Math.round((cx + dx) * scale);
            const y = Math.round((cy + dy) * scale);
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const i = (y * img.width + x) * 4;
            for (let c = 0; c < 3; c++) sum[c] += img.data[i + c];
            n++;
          }
        }
        return labOf(sum[0] / n, sum[1] / n, sum[2] / n).map((v) => Math.round(v * 10) / 10) as Lab;
      };
      const out: Record<string, { sun: Lab; shade: Lab }> = {};
      for (const p of points) out[p.id] = { sun: mean(p.sun), shade: mean(p.shade) };
      for (const [id, v] of Object.entries(out)) console.log(`  ${id.padEnd(30)} sun L${v.sun.join(' ')}  shade L${v.shade.join(' ')}`);
      const body = [
        '/**',
        " * Each ambient tone's colour as the city renders it at the overview's",
        ' * distance and bearing: CIE Lab of the sunlit and the shaded face of a',
        ' * plain building of its type. Measured by tools/capture.ts, the ambient shot.',
        ' *',
        ' * VERSIONED DATA. The plaza-edge rule in lots.ts chooses tones from these',
        ' * numbers, and the tests hold the palette to them; only',
        ' * `AMBIENT_WRITE=1 node --import tsx tools/capture.ts ambient` regenerates',
        ' * it, by hand, committed with the reason.',
        ' */',
        `export const AMBIENT_RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number] }> = ${JSON.stringify(out, null, 2)};`,

        '',
        '/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */',
        `export const AMBIENT_INPUTS = '${ambientInputs()}';`,
        '',
      ].join('\n');
      writeFileSync(process.env.AMBIENT_WRITE === '1' ? join(ROOT, 'app', 'src', 'city', 'ambient-rendered.ts') : join(MEDIA, 'ambient-rendered.ts'), body);
    },

    async families(page) {
      // The tallest tower's sci-fi run rebuilt in each family and shot close at dusk, then a street-level look up at
      // the last one. For the quality rounds (use with CAPTURE_OUT); it restyles the tower, so it runs last.
      await chrome(page, false);
      const first = tallLay.floors.findIndex((l) => l.floor.era === 'scifi');
      const y0 = first >= 0 ? tallLay.floors[first].y0 : tallLay.top - 40;
      const span = Math.max(20, tallLay.top - y0);
      const mid = (y0 + tallLay.top) / 2;
      const dist = Math.max(60, span * 1.05);
      const { x, z } = tall.origin;
      for (const family of FAMILIES) {
        const v = VARIANTS.scifi.find((c) => c.family === family);
        if (!v) continue;
        await page.evaluate(([rp, ids]) => (window as unknown as { __palimpsest: { restyle(r: string, i: string[]): void } }).__palimpsest.restyle(rp, ids), [tall.repo, [v.id]] as [string, string[]]);
        await page.waitForTimeout(2500);
        await still(page, `family-${family}`, [x - dist * 0.72, mid + span * 0.12, z + dist * 0.72], [x, mid, z]);
      }
      await still(page, 'family-street', [x - 70, 2.5, z + 92], [x, tallLay.top * 0.86, z]);
    },

    async fidelity(page) {
      // The architecture-fidelity rounds (use with CAPTURE_OUT): the overview and hero without chrome, the stone
      // and brick shafts at 400 and 900 m, every tower's crown at 160 m, a street among the ambient blocks and
      // an oblique over their roofs.
      await chrome(page, false);
      await still(page, 'af-overview', OVERVIEW.eye, OVERVIEW.target);
      await still(page, 'af-hero', HERO.eye, HERO.target);
      const k = pagoda.origin;
      const ky = pagodaLay.top * 0.5;
      await still(page, 'af-stone-400', [k.x - 380, ky * 0.6, k.z + 240], [k.x, ky, k.z]);
      await still(page, 'af-stone-900', [k.x - 760, ky * 0.8, k.z + 480], [k.x, ky, k.z]);
      // The masonry close (near level of detail) and at 600 m (far level), aimed at the first masonry run.
      const firstStone = pagodaLay.floors.find((l) => l.floor.era === 'stone' || l.floor.era === 'brick');
      const sy = firstStone ? firstStone.y0 + 20 : pagodaLay.rootHeight + 20;
      await still(page, 'af-stone-150', [k.x - 110, sy + 6, k.z + 100], [k.x, sy, k.z]);
      await still(page, 'af-stone-600', [k.x - 480, sy + 40, k.z + 360], [k.x, sy + 20, k.z]);
      for (const d of city) {
        const lay = layoutTower(d.tower);
        const name = d.repo.split('/')[1];
        await still(page, `af-crown-${name}`, [d.origin.x - 62, lay.top + 4, d.origin.z + 58], [d.origin.x, lay.top - 9, d.origin.z]);
      }
      // A street 1.7 m up among the ambient blocks off the gothic tower, looking along the avenue.
      const g = gothic.origin;
      const sx = Math.round(g.x / PITCH_M) * PITCH_M + PITCH_M * 2.5;
      await still(page, 'af-street', [sx, 1.7, g.z + PITCH_M * 3], [sx + 6, 14, g.z - PITCH_M * 2]);
      const kx = Math.round(k.x / PITCH_M) * PITCH_M - PITCH_M * 2.5;
      await still(page, 'af-street2', [kx, 1.7, k.z - PITCH_M * 2], [kx - 4, 12, k.z + PITCH_M * 3]);
      await still(page, 'af-roofs', [sx - 90, 70, g.z + PITCH_M * 3], [sx + 60, 10, g.z + PITCH_M * 0.5]);
      await still(page, 'af-datum', [tall.origin.x - 260, tallLay.datumY + 20, tall.origin.z + 240], [tall.origin.x, tallLay.datumY - 10, tall.origin.z]);
    },

    async earned(page) {
      // The market's floors over the datum (CAPTURE_ECONOMY=1): the harbour tower's earned run and its scar, the
      // kumo tower's waiting floor at the top, the ledge from above, and the inspector's list for each.
      await chrome(page, false);
      const shotsOf = (d: District, tag: string): Array<[string, V3, V3]> => {
        const lay = layoutTower(d.tower);
        const { x, z } = d.origin;
        const mid = (lay.datumY + lay.top) / 2;
        const span = lay.top - lay.datumY;
        return [
          [`earned-${tag}`, [x - 70 - span * 0.6, mid - 6, z + 55 + span * 0.5], [x, mid, z]],
          [`earned-${tag}-ledge`, [x - 46, lay.datumY + 22, z + 40], [x, lay.datumY + 2, z]],
          [`earned-${tag}-far`, [x - 300, lay.datumY * 0.75, z + 240], [x, lay.datumY, z]],
          ...lay.floors
            .filter((l) => l.floor.earned?.state === 'scar')
            .slice(0, 1)
            .map((l): [string, V3, V3] => [`earned-${tag}-scar`, [x - 26, l.y0 + 6, z + 22], [x, l.y0 + l.h / 2, z]]),
        ];
      };
      const kumo = pagoda;
      for (const [name, eye, target] of [...shotsOf(tall, 'harbour'), ...shotsOf(kumo, 'kumo')]) await still(page, name, eye, target);
      await chrome(page, true);
      for (const [d, tag] of [[tall, 'harbour'], [kumo, 'kumo']] as const) {
        await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), d.repo);
        await page.waitForSelector('.inspector.open', { timeout: 5000 });
        await page.waitForTimeout(3500);
        await shoot(page, `earned-${tag}-inspector`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
      }
    },

    async silhouettes(page) {
      // Each agent silhouette (CAPTURE_ECONOMY=1): the economy's agents grown to twenty floors and stood in a row
      // west of the city (tools/agent-board.ts), against the dusk sky, from the home bearing, and close.
      await chrome(page, false);
      const quarters = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
      const towers = boardTowers(quarters);
      const fr = boardFrame(city, towers.length);
      await page.evaluate(
        ([t, s]) => (window as unknown as { __palimpsest: { agentBoard(t: unknown, s: unknown): Promise<void> } }).__palimpsest.agentBoard(t, s),
        [towers, fr.spots] as const,
      );
      await page.waitForTimeout(2500);
      const tops = towers.map((t) => layoutTower(t).top);
      for (const [name, eye, target] of boardViews(fr, towers, tops)) await still(page, name, eye, target);
    },

    async quarters(page) {
      // The firms' quarters (CAPTURE_ECONOMY=1): the city from home with its quarters, two quarters and a district
      // from one bearing, a quarter close, its name plinth, the lens crowns at city distance, the re-clad tower
      // Quickset bought, and a quarter dark as it stands between a bankruptcy and the sale of its towers.
      const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
      const by = (id: string): Quarter => qs.find((q) => q.firmId === id) ?? qs[0];
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: { home(): void } }).__palimpsest.home());
      await page.waitForTimeout(3200);
      await shoot(page, 'quarters-home');
      const quick = by('quickset').origin;
      const kiln = by('kiln').origin;
      const d0 = city[0].origin;
      const cx = (quick.x + kiln.x + d0.x) / 3;
      const cz = (quick.z + kiln.z + d0.z) / 3;
      await still(page, 'quarters', [cx + 360, 150, cz + 430], [cx - 10, 30, cz - 30]);
      await chrome(page, false);
      await still(page, 'quarter-close', [quick.x + 120, 34, quick.z + 170], [quick.x - 4, 30, quick.z + 6]);
      await still(page, 'quarter-court', [quick.x + 30, 1.7, quick.z + 100], [quick.x - 30, 14, quick.z - 40]);
      await still(page, 'quarter-plinth', [quick.x + 9, 2.2, quick.z + 88], [quick.x, 0.9, quick.z + 74]);
      const ashlar = by('ashlar-vane').origin;
      await still(page, 'quarter-lens-far', [ashlar.x + 300, 90, ashlar.z + 380], [ashlar.x, 50, ashlar.z]);
      await still(page, 'quarter-lens', [ashlar.x + 60, 70, ashlar.z + 110], [ashlar.x - 30, 52, ashlar.z]);
      const lode = by('lodestar').origin;
      await still(page, 'quarter-reclad', [lode.x + 90, 30, lode.z + 120], [lode.x - 52, 30, lode.z - 52]);
      for (const extra of (process.env.QUARTER_DARK ?? 'kiln').split(',')) {
        await page.evaluate((f) => (window as unknown as { __palimpsest: { darkQuarter(f: string): void } }).__palimpsest.darkQuarter(f), extra);
        await page.waitForTimeout(1500);
        const o = by(extra).origin;
        await still(page, `quarter-dark-${extra}`, [o.x + 130, 40, o.z + 170], [o.x - 4, 22, o.z]);
      }
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

/** Framings tuned by eye in the quality rounds (see the probe shot), on the sample city; followCity fits them to the city served. */
let HERO: { eye: V3; target: V3 } = { eye: [700, 70, 700], target: [0, 170, 80] };
let OVERVIEW: { eye: V3; target: V3 } = { eye: [540, 380, 960], target: [-40, 70, 0] };
const SCREENS: { eye: V3; target: V3 } = { eye: [-700, 90, 520], target: [160, 150, -200] };
let FLY = { cx: 0, cz: 80, a0: 0.42, a1: 1.12, r0: 980, r1: 840, y0: 110, y1: 72, ty0: 175, ty1: 160 };

/** The sample city the framings above were tuned on: six districts round (-40, 80), the tallest of 92 floors. */
const TUNED_ON: CityExtent = { cx: -40, cz: 80, radius: 377.36, height: 410.6, count: 6 };

/**
 * Derives the framings from the city served, so README media follow it. The
 * overview is the app's own home framing (view.ts). The hero and the flyover
 * keep their tuned composition, scaled about the city's centre by how much
 * farther its home framing stands, or how much taller its tallest crown is,
 * than the sample's: unchanged for the sample, wider for a taller or broader city.
 */
function followCity(city: District[]): void {
  const aspect = VIEWPORT.width / VIEWPORT.height;
  const e = cityExtent(city);
  const lim = viewLimits(e, aspect);
  OVERVIEW = lim.home;
  // Low and looking up, the hero is bound by the tallest crown as much as by the city's breadth.
  const k = Math.max(lim.homeDistance / viewLimits(TUNED_ON, aspect).homeDistance, e.height / TUNED_ON.height);
  const at = (p: V3): V3 => [e.cx + k * (p[0] - TUNED_ON.cx), k * p[1], e.cz + k * (p[2] - TUNED_ON.cz)];
  HERO = { eye: at(HERO.eye), target: at(HERO.target) };
  const [cx, , cz] = at([FLY.cx, 0, FLY.cz]);
  FLY = { ...FLY, cx, cz, r0: FLY.r0 * k, r1: FLY.r1 * k, y0: FLY.y0 * k, y1: FLY.y1 * k, ty0: FLY.ty0 * k, ty1: FLY.ty1 * k };
}

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
  // CAPTURE_CITY=small leaves one tower of 8 floors, for the view's framing rounds.
  if (process.env.CAPTURE_CITY === 'small') await shrinkSample();
  // CAPTURE_ECONOMY=1: the sample economy on top, its firms' floors standing above every datum.
  if (process.env.CAPTURE_ECONOMY) {
    const { seedEconomy } = await import('../engine/market/sample-economy.js');
    await seedEconomy();
  }
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
    // Fixed quality: a slow headless frame must never step a capture down to medium.
    await page.goto(`http://127.0.0.1:${PORT}/?fixed-quality`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, {
      timeout: 60_000,
    });
    // Let the veil fade out completely before any frame is taken.
    await page.waitForTimeout(2500);
    const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
    followCity(city);
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
