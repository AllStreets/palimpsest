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
 * settings, flyover, rise, probe, swatches, families, fidelity, river, transit, vehicles, life (the ambient traffic and crowd),
 * ride (the lift up the harbour tower, datum to roof), week (week.mp4: the week tour, forty-five
 * seconds; CAPTURE_ECONOMY=1), market-overview, screens (jobs, job,
 * run-log, inspection, firms, agent, treasury, each also a shot of its own),
 * construction-clip (construction.mp4: forty seconds of the economy's clock,
 * crane to cure) and commute (commute.mp4: a tram rider and a cab). With no
 * shots named, it writes exactly the README's media (README_SHOTS) on the
 * sample economy with its clock running (CAPTURE_ECONOMY=live). families rebuilds the tallest
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { FAMILIES, VARIANTS } from '../app/src/city/tower/variants.js';
import { cityExtent, viewLimits, type CityExtent } from '../app/src/city/view.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';
import { QUARTER_OFFSETS as QUARTER_OFFSETS_CAPTURE } from '../shared/district-layout.js';
import { boardFrame, boardTowers, boardViews } from './agent-board.js';
import { ambientInputs, towerInputs } from './measure-inputs.js';
import { apart, around as aroundPerson, callDebug, followView, person, runUntil, sendPerson, type FigureProbe, type VehicleProbe } from './people-stage.js';
import { decodePng, labOf } from './png.js';
import { SAMPLE, SAMPLE_TALL, sampleGh, seedSample, shrinkSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// CAPTURE_OUT sends everything elsewhere, for framing probes that should not touch docs/media.
const MEDIA = process.env.CAPTURE_OUT ?? join(ROOT, 'docs', 'media');
const PORT = Number(process.env.CAPTURE_PORT ?? 4789);
/** The sample economy's clock (CAPTURE_ECONOMY=live), ticked on demand by the shots that show it moving. */
let economy: { tick(ms: number): void; idle(): Promise<void> } | null = null;
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

/**
 * The README's clips, kept small enough to sit in the repo: a 1280x800 H.264
 * MP4 to click through to and, for the inline ones, an 800x500 animated AVIF
 * the page plays. No card or GIF set: those are the flyover's and the rise's.
 */
function encodeClip(dir: string, name: string, inline: boolean, posterAt?: number, fps: number = FPS, mp4Opts: { size: string; crf: number; film?: boolean } = { size: '1280:800', crf: 24 }): void {
  // A still from the clip itself, for the README to show where the clip is linked rather than played.
  if (posterAt !== undefined) {
    const frames = readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort();
    const pick = frames[Math.min(frames.length - 1, Math.round(posterAt * (frames.length - 1)))];
    const poster = join(MEDIA, `${name}-poster.webp`);
    execFileSync('cwebp', ['-q', '86', '-m', '6', '-resize', '1600', '1000', join(dir, pick), '-o', poster], { stdio: 'ignore' });
    console.log(`  ${name}-poster.webp ${mb(poster)} (frame ${pick})`);
  }
  const input = ['-framerate', String(fps), '-i', join(dir, 'f%04d.png')];
  const mp4 = join(MEDIA, `${name}.mp4`);
  const tuning = mp4Opts.film ? ['-preset', 'veryslow', '-tune', 'film'] : ['-preset', 'slow'];
  ff([...input, '-vf', `scale=${mp4Opts.size}:flags=lanczos`, '-c:v', 'libx264', ...tuning, '-crf', String(mp4Opts.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  let line = `  ${name}: mp4 ${mb(mp4)}`;
  if (inline) {
    const avif = join(MEDIA, `${name}.avif`);
    ff([...input, '-vf', 'fps=24,scale=800:500:flags=lanczos', '-c:v', 'libsvtav1', '-preset', '4', '-crf', '36', '-g', '96', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', avif]);
    line += `, avif ${mb(avif)}`;
  }
  console.log(line);
}

/**
 * Puts the page on a virtual clock: `performance.now()` (which the scene's
 * frame clock reads) stands still until `tick()` moves it on, so each frame of
 * a clip is exactly 1/FPS of the city's time however long its screenshot
 * takes. The vehicles, the people, the crowd, the crane and the sparks all
 * step on that clock. `off()` gives the page its own clock back.
 */
async function virtualClock(page: Page): Promise<{ tick(seconds: number): Promise<void>; off(): Promise<void> }> {
  await page.evaluate(() => {
    const w = window as unknown as { __realNow?: () => number; __vt: number };
    w.__realNow ??= performance.now.bind(performance);
    w.__vt = w.__realNow();
    performance.now = () => w.__vt;
  });
  return {
    async tick(seconds) {
      await page.evaluate((ms) => {
        (window as unknown as { __vt: number }).__vt += ms;
      }, seconds * 1000);
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    },
    async off() {
      await page.evaluate(() => {
        const w = window as unknown as { __realNow?: () => number };
        if (w.__realNow) performance.now = w.__realNow;
      });
    },
  };
}

/**
 * A clip on the virtual clock: `each(i, t)` sets the camera (and moves
 * anything else on) before each frame, then the city steps one frame's time
 * and the frame is taken.
 */
async function film(page: Page, name: string, frames: number, each: (i: number, t: number) => Promise<{ eye: V3; target: V3 }>, inline: boolean, posterAt?: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `palimpsest-${name}-`));
  console.log(`${name}: ${frames} frames`);
  const clock = await virtualClock(page);
  try {
    for (let i = 0; i < frames; i++) {
      const { eye, target } = await each(i, frames === 1 ? 0 : i / (frames - 1));
      await page.evaluate(([e, t]) => {
        (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
      }, [eye, target] as [V3, V3]);
      await clock.tick(1 / FPS);
      await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
      if (i % 60 === 0) process.stdout.write(`  ${i}/${frames}\r`);
    }
  } finally {
    await clock.off();
  }
  encodeClip(dir, name, inline, posterAt);
  if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

/** Eases a camera toward a moving aim, so a followed figure's turns never jerk the frame. */
function chase(rate: number): (eye: V3, target: V3) => { eye: V3; target: V3 } {
  let e: V3 | null = null;
  let t: V3 | null = null;
  return (eye, target) => {
    e = e ? lerp3(e, eye, rate) : eye;
    t = t ? lerp3(t, target, rate) : target;
    return { eye: e, target: t };
  };
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

/**
 * Phase 3's stills, kept small for the README: the page at 2x, written as a
 * 1600 x 1000 WebP (the README shows them at most that wide), quality 84 for
 * the city and 90 for a screen of text.
 */
async function lean(page: Page, name: string, text = false): Promise<void> {
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const path = join(MEDIA, `${name}.png`);
  const webp = join(MEDIA, `${name}.webp`);
  await page.screenshot({ path });
  execFileSync('cwebp', ['-q', text ? '90' : '84', '-m', '6', '-resize', '1600', '1000', path, '-o', webp], { stdio: 'ignore' });
  console.log(`  ${name}.webp ${mb(webp)}`);
  if (!process.env.CAPTURE_OUT) rmSync(path);
}

type Show = { id: string; kind: string; towerId: string; lit: boolean; y: number; height: number; tip: number[] };
/** The milestones as the city shows them now (the debug handle's milestones()). */
async function shows(page: Page): Promise<Show[]> {
  await page.waitForFunction('window.__palimpsest.milestones().length > 0', null, { timeout: 15_000 });
  return (await page.evaluate('window.__palimpsest.milestones()')) as Show[];
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

/** Opens a screen by its address, over the city's screens framing, and waits for it to settle. */
async function openHash(page: Page, hash: string, ready: string): Promise<void> {
  await chrome(page, true);
  if (hash !== '#/') await frame(page, SCREENS.eye, SCREENS.target);
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForSelector(ready, { timeout: 10_000 });
  await page.waitForTimeout(hash === '#/' ? 800 : 1800);
}

/** The economy's running harbour job, the one the job and run stills show. */
async function runningHarbour(page: Page): Promise<{ id: string; runId: string }> {
  const jobs = (await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()))) as Array<{ id: string; status: string; repo: string; runId: string | null }>;
  const j = jobs.find((x) => x.status === 'running' && x.repo === 'tidewater/harbor-ledger');
  if (!j?.runId) throw new Error('the economy has no running harbour job');
  return { id: j.id, runId: j.runId };
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

    async ride(page) {
      // The ride up the outside of a tower (Task 35): the harbour tower from its datum to the roof, the car on its rail
      // and the captions at the lower left. Stills at street level, at the datum and over the roof (RIDE_ONLY='street,mid,top,clip').
      const only = process.env.RIDE_ONLY?.split(',');
      const want = (k: string): boolean => !only || only.includes(k);
      await chrome(page, true);
      type Riding = { length: number; stops: Array<{ t: number; dwell: number; mark: string | null }> };
      const seekShot = async (key: string, name: string, at: (r: Riding) => number): Promise<void> => {
        if (!(await page.evaluate(`window.__palimpsest.ride(${JSON.stringify(key)})`))) throw new Error(`no ride up ${key}`);
        await page.evaluate('window.__palimpsest.rideHold(true)');
        const rr = (await page.evaluate('window.__palimpsest.riding()')) as Riding;
        for (let i = 0; i < 2; i++) {
          await page.evaluate(`window.__palimpsest.rideSeek(${at(rr)})`);
          await page.waitForTimeout(900);
        }
        await shoot(page, name);
        await page.evaluate('window.__palimpsest.ride(null)');
        await page.waitForTimeout(2000);
      };
      // The crew's hoist on a tower at work (CAPTURE_ECONOMY=live): the car at the new floor, the frame going up over it.
      if (only?.includes('hoist')) {
        await page.waitForFunction('window.__palimpsest.liveSites().some((s) => s.stage === "framing")', null, { timeout: 15_000 }).catch(() => {});
        const sites = (await page.evaluate('window.__palimpsest.liveSites()')) as Array<{ repo: string; stage: string }>;
        const framing = sites.find((x) => x.stage === 'framing');
        if (!framing) throw new Error('no framing site to ride');
        await page.waitForTimeout(2500);
        await seekShot(framing.repo, 'ride-hoist', (rr) => rr.stops[rr.stops.length - 1].t + 3);
      }
      // An agent tower's crown, from the end of its ride (CAPTURE_ECONOMY=1): a lens or a spire where one stands.
      if (only?.includes('crown')) {
        const quarters = (await page.evaluate(() => fetch('/api/quarters').then((x) => x.json()))) as Quarter[];
        const towers = quarters.flatMap((q) => q.towers).filter((t) => t.agentId && !t.dark);
        const crowned = towers.find((t) => t.silhouette === 'lens' || t.silhouette === 'needle') ?? towers[0];
        if (!crowned) throw new Error('no agent tower to ride');
        console.log(`  crown: ${crowned.agentId} (${crowned.silhouette ?? 'plain'}, ${crowned.floors.length} floors)`);
        await seekShot(`agent:${crowned.agentId}`, 'ride-agent-crown', (rr) => {
          const roof = rr.stops[rr.stops.length - 1];
          return roof.t + roof.dwell * 0.6;
        });
      }
      if (only && !only.some((k) => ['street', 'mid', 'top', 'clip'].includes(k))) return;
      // The tallest tower with no job site on it: on a tower at work the ride is the crew's hoist, whose car fills the frame.
      // RIDE_TOWER names another.
      const busy = new Set(((await page.evaluate('window.__palimpsest.liveSites()')) as Array<{ repo: string }>).map((x) => x.repo));
      const rideOn = process.env.RIDE_TOWER ?? [...city].filter((d) => !busy.has(d.repo)).sort((a, b) => b.tower.floors.length - a.tower.floors.length)[0]?.repo ?? tall.repo;
      console.log(`  riding ${rideOn}`);
      const ok = await page.evaluate(`window.__palimpsest.ride(${JSON.stringify(rideOn)})`);
      if (!ok) throw new Error('the ride did not start');
      await page.evaluate('window.__palimpsest.rideHold(true)');
      const r = (await page.evaluate('window.__palimpsest.riding()')) as Riding;
      const datum = r.stops.find((s) => s.mark === 'datum') ?? r.stops[1] ?? r.stops[0];
      const roof = r.stops[r.stops.length - 1];
      const at = async (t: number): Promise<void> => {
        await page.evaluate(`window.__palimpsest.rideSeek(${t})`);
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      };
      const stillAt = async (name: string, t: number): Promise<void> => {
        await at(t);
        await page.waitForTimeout(900);
        await at(t);
        await shoot(page, name);
      };
      if (want('street')) await stillAt('ride-street', 0.9);
      if (want('mid')) await stillAt('ride-mid', datum.t + 0.6);
      if (want('top')) await stillAt('ride-top', roof.t + roof.dwell * 0.6);
      if (want('clip')) {
        // From just below the datum to the roof, on the virtual clock so the streets below move at the ride's pace.
        const dir = mkdtempSync(join(tmpdir(), 'palimpsest-ride-'));
        const from = Math.max(0, datum.t - 1.5);
        const n = Math.round((r.length - from) * FPS);
        console.log(`ride: ${n} frames`);
        const clock = await virtualClock(page);
        try {
          for (let i = 0; i < n; i++) {
            await page.evaluate(`window.__palimpsest.rideSeek(${from + i / FPS})`);
            await clock.tick(1 / FPS);
            await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
            if (i % 60 === 0) process.stdout.write(`  ${i}/${n}\r`);
          }
        } finally {
          await clock.off();
        }
        encodeClip(dir, 'ride', true, Number(process.env.RIDE_POSTER ?? 0.5));
        if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
        else rmSync(dir, { recursive: true, force: true });
      }
      await page.evaluate('window.__palimpsest.ride(null)');
      // The ride's last caption holds a moment after the ride ends: let it go before the next shot.
      await page.waitForTimeout(4000);
    },

    async brief(page) {
      // The morning brief (Phase 3 Task 11) as the sample economy's morning stands: its items and every action in place.
      await openHash(page, '#/brief', '.sheet.brief .brief-item');
      await page.waitForTimeout(800);
      await lean(page, 'brief', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async audit(page) {
      // The harbour README audit's own page: the claims, each verdict with its evidence at file and line, the proposals.
      const audits = (await page.evaluate(() => fetch('/api/audits?repo=tidewater%2Fharbor-ledger').then((r) => r.json()))) as Array<{ id: string; status: string }>;
      const done = audits.find((a) => a.status === 'done');
      if (!done) throw new Error('the economy has no finished harbour audit');
      await openHash(page, `#/audits/${done.id}`, '.sheet.auditpage .claim');
      await page.waitForTimeout(600);
      await lean(page, 'audit', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async spire(page) {
      // The lit spire at dusk on the tower that stands tallest above its datum (Phase 3 Task 14).
      // On the city, with no sheet open over it (the day's first open shows the brief).
      await openHash(page, '#/', 'body[data-route="city"]');
      await chrome(page, false);
      const lit = (await shows(page)).find((m) => m.kind === 'skyline' && m.lit);
      const d = lit ? city.find((x) => x.tower.id === lit.towerId) : undefined;
      if (!lit || !d) throw new Error('no lit spire on a district tower');
      const foot: V3 = [d.origin.x, lit.y, d.origin.z];
      // The live economy has a crew at work on that roof: the job sites stand aside for the still, so the mast reads alone.
      await page.evaluate('window.__palimpsest.showSites(false)');
      await frame(page, [foot[0] - lit.height * 1.15, lit.y + lit.height * 0.55, foot[2] + lit.height * 1.55], [foot[0], lit.y + lit.height * 0.5, foot[2]]);
      await page.waitForTimeout(1800);
      await lean(page, 'spire');
      await page.evaluate('window.__palimpsest.showSites(true)');
      await chrome(page, true);
    },

    async revival(page) {
      // Scaffolding lights on a repo that came back to life (Phase 3 Task 15): the festoon round its floor and the one below.
      // On the city, with no sheet open over it (the day's first open shows the brief).
      await openHash(page, '#/', 'body[data-route="city"]');
      await chrome(page, false);
      const r = (await shows(page)).find((m) => m.kind === 'revival');
      const d = r ? city.find((x) => x.tower.id === r.towerId) : undefined;
      if (!r || !d) throw new Error('no revival in the economy');
      const mid = r.y + r.height * 0.5;
      await frame(page, [d.origin.x - 38, mid + 4, d.origin.z + 46], [d.origin.x, mid - 1, d.origin.z]);
      await page.waitForTimeout(1800);
      await lean(page, 'revival');
      await chrome(page, true);
    },

    async ribbon(page) {
      // The ribbon on a new firm's first PR floor (Phase 3 Task 16), from the street corner its bow faces.
      // On the city, with no sheet open over it (the day's first open shows the brief).
      await openHash(page, '#/', 'body[data-route="city"]');
      await chrome(page, false);
      const r = (await shows(page)).find((m) => m.kind === 'ribbon');
      const d = r ? city.find((x) => x.tower.id === r.towerId) : undefined;
      if (!r || !d) throw new Error('no ribbon in the economy');
      await frame(page, [d.origin.x + 30, r.y - 3, d.origin.z + 34], [d.origin.x + 4, r.y - 0.5, d.origin.z + 4]);
      await page.waitForTimeout(1800);
      await lean(page, 'ribbon');
      await chrome(page, true);
    },

    async 'ride-dossier'(page) {
      await openHash(page, '#/', 'body[data-route="city"]');
      // The ride's floor dossier (Phase 3 Task 18): a ride held at its tower's newest floor, the dossier under the caption.
      // A tower with a crew at work rides the crew's hoist, whose car fills the frame: the tallest tower without one.
      const busy = new Set(((await page.evaluate('window.__palimpsest.liveSites()')) as Array<{ repo: string }>).map((x) => x.repo));
      const repo = [...city].filter((x) => !busy.has(x.repo) && x.tower.floors.some((f) => f.earned)).sort((a, b) => b.tower.floors.length - a.tower.floors.length)[0]?.repo;
      if (!repo) throw new Error('no tower without a crew to ride');
      console.log(`  ride-dossier on ${repo}`);
      await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), repo);
      await page.waitForTimeout(2500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      if (!(await page.evaluate((r) => (window as unknown as { __palimpsest: { ride(k: string): boolean } }).__palimpsest.ride(r), repo))) throw new Error('the harbour ride did not start');
      await page.evaluate('window.__palimpsest.rideHold(true)');
      const r = (await page.evaluate('window.__palimpsest.riding()')) as { stops: Array<{ t: number; dossier: boolean }> };
      const stop = r.stops.filter((x) => x.dossier).at(-1);
      if (!stop) throw new Error('the harbour ride has no dossier stop');
      await page.evaluate(`window.__palimpsest.rideSeek(${stop.t + 0.8})`);
      await page.waitForTimeout(1600);
      await page.evaluate(`window.__palimpsest.rideSeek(${stop.t + 0.8})`);
      await lean(page, 'ride-dossier', true);
      await page.evaluate('window.__palimpsest.ride(null)');
      await page.waitForTimeout(4000);
    },

    async week(page) {
      // The week tour (Phase 3 Task 17): the camera's walk through the economy's week, exchange to exchange, its
      // captions at the lower left. Forty-five seconds: the walk's ninety on the virtual clock at twice its pace,
      // encoded as lean as the ride (an mp4, and the avif the README plays inline).
      await chrome(page, true);
      const ok = (await page.evaluate('window.__palimpsest.tourStart()')) as boolean;
      if (!ok) throw new Error('the week has no tour to walk');
      await page.evaluate('window.__palimpsest.tourHold(true)');
      const tour = (await page.evaluate('window.__palimpsest.tour()')) as { length: number };
      const speed = Number(process.env.WEEK_SPEED ?? 2);
      // Lean: 24 frames a second is enough for a camera that glides and holds.
      const fps = Number(process.env.WEEK_FPS ?? 24);
      const n = Math.round((tour.length / speed) * fps);
      const dir = mkdtempSync(join(tmpdir(), 'palimpsest-week-'));
      console.log(`week: ${n} frames`);
      const clock = await virtualClock(page);
      try {
        for (let i = 0; i < n; i++) {
          await page.evaluate(`window.__palimpsest.tourSeek(${(i * speed) / fps})`);
          await clock.tick(1 / fps);
          await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
          if (i % 60 === 0) process.stdout.write(`  ${i}/${n}\r`);
        }
      } finally {
        await clock.off();
      }
      // The walk moves the whole frame for most of its length, so the ride's encoding would run to tens of megabytes: the
      // week is linked from its poster rather than played inline, and kept to 960 x 600 at CRF 32 (about 5 MB).
      encodeClip(dir, 'week', false, Number(process.env.WEEK_POSTER ?? 0.45), fps, { size: '960:600', crf: 32, film: true });
      if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
      await page.evaluate('window.__palimpsest.tourHold(false)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3000);
    },

    async river(page) {
      // The river (Task 29): the city from home, the river from the stone bridge, each bridge close, a quay at the
      // water's level and a pier. RIVER_ONLY='home,stone' takes a subset.
      await chrome(page, false);
      const only = process.env.RIVER_ONLY?.split(',');
      const views: Array<[string, V3, V3]> = [
        ['river-home', OVERVIEW.eye, OVERVIEW.target],
        ['river', [-353, 2.6, 11.5], [-368, -3, 320]],
        ['river-high', [-150, 160, 560], [-360, -6, 40]],
        ['bridge-stone', [-336, -4.4, 64], [-362, -2.5, 0]],
        ['bridge-arch', [-334, -1.5, -420], [-360, 3, -480]],
        ['bridge-stayed', [-372, 2, 410], [-344, 14, 480]],
        ['quay-water', [-382, -5.3, 150], [-332, -3.2, 230]],
        ['pier', [-358, -3.2, 52], [-340, -4.6, 82]],
      ];
      for (const [name, eye, target] of views) if (!only || only.includes(name)) await still(page, name, eye, target);
    },

    async transit(page) {
      // The transit network (Task 30), on the sample city (its loops at extent 2: the tram on the streets at 600 m,
      // the rail at 680 m, the pod lines on z 120 and x 120): the city from home, a tram stop with the viaduct
      // behind, a rail station from its platform end and from the street, the elevated line crossing the river, a
      // pod station at height and inside, the interchange, a cab rank, the tram's own bridge over the river. TRANSIT_ONLY='home,station' takes a subset.
      await chrome(page, false);
      const only = process.env.TRANSIT_ONLY?.split(',');
      const views: Array<[string, V3, V3]> = [
        ['transit-home', OVERVIEW.eye, OVERVIEW.target],
        ['tram-stop', [603.5, 3.2, 436], [598, 7.5, 640]],
        ['station', [-40, 15.2, -683], [10, 14, -679]],
        ['station-street', [-40, 2.0, -716], [2, 9, -680]],
        ['rail-river', [-292, 4, -566], [-372, 10, -680]],
        ['rail-river-high', [-260, 60, -520], [-400, 8, -690]],
        ['pod-station', [264, 21, 152], [240, 19, 120]],
        ['interchange', [165, 32, 175], [120, 18, 120]],
        ['cab-rank', [279.5, 2.5, 352], [284, 1, 318]],
        ['tram-bridge', [-322, 2.2, 652], [-366, 1.4, 682]],
        ['tram-bridge-high', [-250, 45, 590], [-370, 4, 700]],
        ['pod-interior', [227, 20.2, 123.6], [252, 19.6, 122.6]],
        ['pod-street', [262, 2, 104], [240, 17, 122]],
      ];
      for (const [name, eye, target] of views) if (!only || only.includes(name)) await still(page, name, eye, target);
    },

    async vehicles(page) {
      // The vehicles (Task 31) on the sample city's network: a tram standing at a stop, a train at a station, a pod at
      // its station at height, a ferry alongside a pier, a cab pulled up for a rider at the kerb, and the city at dusk
      // with everything running. Each vehicle is staged (the clock moved on until it stands) and the clock held for
      // the still. VEHICLE_ONLY='tram,cab' takes a subset.
      await chrome(page, false);
      const only = process.env.VEHICLE_ONLY?.split(',');
      type Probe = { id: string; position: number[]; heading: number; phase: string };
      type VD = {
        vehicleHold(on: boolean): void;
        vehicleSkip(s: number): void;
        vehicleStage(kind: string, near?: number[]): Probe | null;
        vehicleTrip(from: number[], to: number[]): Array<{ mode: string; id: string | null }>;
        vehicle(id: string): Probe | null;
        vehicleRider(at: number[] | null, heading?: number): void;
        vehicleSeek(conds: Array<{ kind: string; near: number[]; radius: number; moving?: number }>, horizon?: number): boolean;
        vehicleKinds(kind: string): Probe[];
      };
      const d = <T>(fn: (v: VD, a: unknown) => T, arg?: unknown): Promise<T> => page.evaluate(`(${fn.toString()})(window.__palimpsest, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
      const around = (p: number[], h: number, fwd: number, right: number, y: number): V3 => [p[0] + Math.cos(h) * fwd - Math.sin(h) * right, y, p[2] + Math.sin(h) * fwd + Math.cos(h) * right];
      const want = (name: string): boolean => !only || only.includes(name);
      await d((v) => v.vehicleHold(true));
      const views = JSON.parse(process.env.VEHICLE_VIEWS ?? '{}') as Record<string, [number, number, number, number, number, number]>;
      const stageShot = async (name: string, kind: string, near: number[], def: [number, number, number, number, number, number]): Promise<void> => {
        if (!want(name)) return;
        const p = await d((v, a) => v.vehicleStage((a as [string, number[]])[0], (a as [string, number[]])[1]), [kind, near]);
        if (!p) return console.log(`  no ${kind} to stage`);
        const [ef, er, ey, tf, tr, ty] = views[name] ?? def;
        await still(page, name, around(p.position, p.heading, ef, er, p.position[1] + ey), around(p.position, p.heading, tf, tr, p.position[1] + ty));
      };
      await stageShot('tram', 'tram', [680, 240], [21, 5.2, 1.7, 0, -0.5, 1.7]);
      await stageShot('train', 'rail', [0, -760], [30, 2.6, 2.6, 0, 0, 2.0]);
      await stageShot('pod', 'pod', [240, 120], [12, -6, 2.4, 0, 0, 1.3]);
      await stageShot('ferry', 'ferry', [-332, 72], [26, 16, 6.5, 0, 0, 0.5]);
      if (want('cab')) {
        const trip = await d((v) => v.vehicleTrip([446.5, 330], [1100, -200]));
        const cab = trip.find((l) => l.mode === 'cab');
        if (cab?.id) {
          for (let i = 0; i < 400; i++) {
            const c = await d((v, id) => v.vehicle(id as string), cab.id);
            if (!c || c.phase === 'pickup') break;
            await d((v) => v.vehicleSkip(1));
          }
          await d((v) => v.vehicleSkip(2));
          const c = (await d((v, id) => v.vehicle(id as string), cab.id))!;
          // The rider at the kerb beside the cab's rear door, turning to step in.
          const kerb = around(c.position, c.heading, -0.35, 1.45, c.position[1]);
          await d((v, a) => v.vehicleRider((a as number[][])[0], (a as number[][])[1][0]), [kerb, [c.heading - Math.PI / 2 - 0.5]]);
          const [ef, er, ey, tf, tr, ty] = views.cab ?? [6.5, 4.4, 1.45, -0.3, 0.7, 0.95];
          await still(page, 'cab', around(c.position, c.heading, ef, er, ey), around(c.position, c.heading, tf, tr, ty));
          await d((v) => v.vehicleRider(null));
        }
      }
      if (want('ferry-wake')) {
        // A ferry under way in mid-river, from the stone bridge's parapet behind it: its wake spreading astern.
        if (await d((v) => v.vehicleSeek([{ kind: 'ferry', near: [-360, 210], radius: 50, moving: 5.5 }]))) {
          const f = (await d((v) => v.vehicleKinds('ferry'))).sort((a, b) => Math.hypot(a.position[0] + 360, a.position[2] - 210) - Math.hypot(b.position[0] + 360, b.position[2] - 210))[0];
          const go = f.heading;
          const [ef, er, ey, tf, tr, ty] = views['ferry-wake'] ?? [-70, 8, 9, 6, 0, -5];
          await still(page, 'ferry-wake', around(f.position, go, ef, er, ey), around(f.position, go, tf, tr, ty));
        }
      }
      if (want('dusk-close')) {
        // Close by the tram's bridge at dusk: a lit tram crossing over the river and a ferry coming up to pass under.
        const blocks = (await page.evaluate('window.__palimpsest.transit().blocks')) as number;
        const h = 240 * blocks + 200;
        const tries = [
          [
            { kind: 'tram', near: [-360, h], radius: 20 },
            { kind: 'ferry', near: [-360, h - 70], radius: 45 },
          ],
          [
            { kind: 'tram', near: [-360, h], radius: 25 },
            { kind: 'ferry', near: [-360, h - 70], radius: 90 },
          ],
          [{ kind: 'tram', near: [-360, h], radius: 25 }],
        ];
        for (const t of tries) if (await d((v, c) => v.vehicleSeek(c as never, 30000), t)) break;
        const [e, t] = (process.env.DUSK_CLOSE_VIEW ? JSON.parse(process.env.DUSK_CLOSE_VIEW) : [[-336, 4.5, h - 92], [-366, -0.5, h - 2]]) as [V3, V3];
        await still(page, 'dusk-close', e, t);
      }
      if (want('home')) await still(page, 'home', OVERVIEW.eye, OVERVIEW.target);
      if (want('dusk')) {
        // The river at dusk looking south to the tram's bridge and the elevated line's truss: a train crossing, a tram
        // on its bridge and a ferry on the water, when the timetable brings them together (else as many as it can).
        const blocks = (await page.evaluate('window.__palimpsest.transit().blocks')) as number;
        const h = 240 * blocks + 200;
        const rz = Math.ceil((Math.max(240 * blocks + 280, h + 80) - 40) / 80) * 80 + 40;
        const tries = [
          [
            { kind: 'rail', near: [-360, rz + 2], radius: 50, moving: 4 },
            { kind: 'tram', near: [-360, h], radius: 80 },
            { kind: 'ferry', near: [-360, h - 70], radius: 90, moving: 3 },
          ],
          [
            { kind: 'rail', near: [-360, rz + 2], radius: 50, moving: 4 },
            { kind: 'ferry', near: [-360, h - 70], radius: 120 },
          ],
          [{ kind: 'rail', near: [-360, rz + 2], radius: 50, moving: 4 }],
        ];
        for (const t of tries) if (await d((v, c) => v.vehicleSeek(c as never, 6000), t)) break;
        const [e, t] = (process.env.DUSK_VIEW ? JSON.parse(process.env.DUSK_VIEW) : [[-368, 21, h - 160], [-354, 5, h + 80]]) as [V3, V3];
        await still(page, 'dusk', e, t);
      }
      await d((v) => v.vehicleHold(false));
    },

    async people(page) {
      // The personas as people (Task 34; CAPTURE_ECONOMY=1 for the firms): a close follow shot of a figure walking
      // (people-follow), close enough to read the face and hands (people-close), a figure stepping into its cab
      // (people-cab) and seated in it, through its window (people-seated), a figure on a tram platform with the tram
      // coming in (people-platform), and a medium shot of her among the waiting crowd there (people-crowd). PEOPLE_ONLY='follow,cab' takes a subset;
      // PEOPLE_VIEWS='{"people-follow": [[eye], [target]]}' overrides a view; PEOPLE_DAY=1 leaves the lanterns dark.
      await chrome(page, false);
      const only = process.env.PEOPLE_ONLY?.split(',');
      const views = JSON.parse(process.env.PEOPLE_VIEWS ?? '{}') as Record<string, [V3, V3]>;
      const want = (n: string): boolean => !only || only.includes(n);
      await callDebug(page, 'd.ambientDensity(1)');
      await callDebug(page, 'd.ambientSkip(60)');
      await callDebug(page, 'd.ambientHold(true)');
      await callDebug(page, 'd.peopleHold(true)');
      await callDebug(page, `d.peopleLantern(${process.env.PEOPLE_DAY ? 'false' : 'true'})`);
      const shot = async (name: string, def: [V3, V3]): Promise<void> => {
        const [eye, target] = views[name] ?? def;
        await still(page, name, eye, target);
      };
      // Dagny on her way to the tram: twenty seconds into the walk, framed as the follow camera frames her.
      await sendPerson(page, 'dagny-hollis', [560, -300], [600, 200]);
      await callDebug(page, 'd.peopleSkip(22)');
      if (want('follow') || want('close')) {
        const f = await person(page, 'dagny-hollis');
        if (f) {
          if (want('follow')) await shot('people-follow', followView(f));
          // The orbit's nearest stand is 12 m, so the close shot looks past her: the eye 4 m off her shoulder, the target well behind.
          if (want('close')) await shot('people-close', [aroundPerson(f.position, f.heading, 2.6, -3.0, f.position[1] + 1.5), aroundPerson(f.position, f.heading, -5.5, 6.2, f.position[1] + 0.5)]);
        }
      }
      if (want('platform') || want('crowd')) {
        // On the platform among the waiting crowd as the tram comes in: close from behind her, and a medium shot from up the platform.
        const f0 = await runUntil(page, 'dagny-hollis', (x) => x.mode === 'tram' && x.stage === 'wait');
        const f = f0 ? await runUntil(page, 'dagny-hollis', (x, v) => x.stage !== 'wait' || (!!v && apart(x, v) < 34 && v.speed > 0.5), 1200) : null;
        if (f && want('platform')) await shot('people-platform', [aroundPerson(f.position, f.heading, 11, 2.4, f.position[1] + 2.4), aroundPerson(f.position, f.heading, -1.5, 0.3, f.position[1] + 1.2)]);
        if (f && want('crowd')) await shot('people-crowd', [aroundPerson(f.position, f.heading, 13, 3.5, f.position[1] + 2.0), aroundPerson(f.position, f.heading, 0, 0.5, f.position[1] + 1.1)]);
        if (!f) console.log('  no figure on the platform');
      }
      if (want('cab') || want('seated')) {
        // Hal's cab: a second and a half into stepping in at the rear door; then seated inside, through the rear window.
        await sendPerson(page, 'hal-meridian', [446.5, 330], [1100, -200]);
        const f0 = await runUntil(page, 'hal-meridian', (x) => x.stage === 'board');
        if (f0) {
          await callDebug(page, 'd.peopleSkip(1.4)');
          const f = await person(page, 'hal-meridian');
          const v = f?.ride ? await callDebug<{ position: number[]; heading: number } | null>(page, `d.vehicle(${JSON.stringify(f.ride.id)})`) : null;
          if (f && v && want('cab')) await shot('people-cab', [aroundPerson(v.position, v.heading, 6.5, 4.4, 1.45), aroundPerson(v.position, v.heading, -0.3, 0.7, 0.95)]);
        } else console.log('  no figure at a cab');
      }
      if (want('seated')) {
        // Bruno seated in the train (the cab's glass is too dark to see in): from inside the car, a few seats up.
        await sendPerson(page, 'bruno-kiln', [600, -600], [-600, 600]);
        const r = await runUntil(page, 'bruno-kiln', (x) => x.mode === 'rail' && x.stage === 'ride', 1800, 2);
        const rv = r?.ride ? await callDebug<{ position: number[]; heading: number; floorY: number } | null>(page, `d.vehicle(${JSON.stringify(r.ride.id)})`) : null;
        if (r && rv) {
          await callDebug(page, 'd.peopleSkip(3)');
          const f = (await person(page, 'bruno-kiln'))!;
          await shot('people-seated', [aroundPerson(f.position, f.heading, 2.4, -1.3, f.position[1] + 1.15), aroundPerson(f.position, f.heading, -0.1, 0.1, f.position[1] + 0.55)]);
        } else console.log('  no figure seated on the train');
      }
      await callDebug(page, 'd.peopleHold(false)');
      await callDebug(page, 'd.ambientHold(false)');
      await callDebug(page, 'd.peopleLantern(null)');
    },

    async life(page) {
      // The ambient traffic and crowd (Task 32) at full density, the clock run on until the lights have queued
      // traffic: a street at dusk at a person's height by a plaza (street), a junction with traffic queued at its
      // lights (junction), the crowd on a tram platform (stop), and the streets from a rooftop (rooftop).
      // LIFE_ONLY='street,stop' takes a subset; LIFE_VIEWS='{"street": [[eye], [target]]}' overrides a view.
      await chrome(page, false);
      const only = process.env.LIFE_ONLY?.split(',');
      const views = JSON.parse(process.env.LIFE_VIEWS ?? '{}') as Record<string, [V3, V3]>;
      const call = <T>(js: string): Promise<T> => page.evaluate(`(function (d) { return ${js}; })(window.__palimpsest)`) as Promise<T>;
      if (process.env.LIFE_FPS) {
        // LIFE_FPS='[[eye],[target]]': frames per second there with the streets full, then empty (tuning).
        const [e, t] = JSON.parse(process.env.LIFE_FPS) as [V3, V3];
        // LIFE_DROP=1: the governor's step down first, so the numbers are medium's.
        if (process.env.LIFE_DROP) {
          await page.evaluate('window.__palimpsest.dropQuality()');
          await page.waitForTimeout(3000);
        }
        const fps = (): Promise<number> => page.evaluate(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r((n * 1000) / (performance.now() - t0)); }; requestAnimationFrame(f); })`) as Promise<number>;
        await frame(page, e, t);
        for (const n of [1, 0, 1, 0]) {
          await call(`d.ambientDensity(${n})`);
          await page.waitForTimeout(1500);
          console.log(`  density ${n}: ${(await fps()).toFixed(1)} fps`);
        }
      }
      if (process.env.LIFE_BREAKDOWN) {
        // The traffic and crowd's share of a frame from home, every pass (tuning).
        await call('d.ambientDensity(1)');
        await call('d.home()');
        await page.waitForTimeout(4000);
        const b = (await page.evaluate('window.__palimpsest.breakdown()')) as Record<string, unknown>;
        console.log(`  breakdown traffic ${JSON.stringify(b.traffic)} keys ${Object.keys(b).join(',')} ambient ${JSON.stringify(await call('d.ambient()'))}`);
      }
      await call('d.ambientDensity(1)');
      const info = await page.evaluate(`(async function (d) { const city = await fetch('/api/city').then((r) => r.json()); return { blocks: d.transit().blocks, districts: city.map((c) => [c.origin.x, c.origin.z]), ambient: d.ambient() }; })(window.__palimpsest)`);
      console.log(`  ${JSON.stringify(info)}`);
      await call(`d.ambientSkip(${Number(process.env.LIFE_SKIP ?? 90)})`);
      await call('d.ambientHold(true)');
      const want = (n: string): boolean => !only || only.includes(n);
      const shot = async (name: string, def: [V3, V3]): Promise<void> => {
        if (!want(name)) return;
        const [eye, target] = views[name] ?? def;
        await still(page, name, eye, target);
        console.log(`  ${name}: ${JSON.stringify(await call('d.ambient()'))}`);
      };
      await shot('street', [[195.4, 1.62, -145], [207, 1.45, -30]]);
      if (want('junction')) {
        // The junction near the plaza with the most cars standing at its lines, seen from a corner above the kerb.
        const q = await call<Array<{ x: number; z: number; held: number }>>('d.ambientQueues([280, -120], 130)');
        const j = q[0] ?? { x: 280, z: -120, held: 0 };
        console.log(`  junction ${j.x},${j.z} with ${j.held} held`);
        await shot('junction', [[j.x + 6.5, 4.5, j.z + 30], [j.x - 2, 0.5, j.z - 6]]);
      }
      await shot('stop', [[435.5, 1.6, -20], [442, 1.3, 4]]);
      await shot('rooftop', [[287, 64, -430], [276, 0, -150]]);
      // LIFE_STRIP='[[eye],[target]]': four frames 0.12 s apart from one view, for the walk cycle (walk-0..3).
      if (process.env.LIFE_STRIP) {
        const [e, t] = JSON.parse(process.env.LIFE_STRIP) as [V3, V3];
        for (let i = 0; i < 4; i++) {
          await still(page, `walk-${i}`, e, t);
          await call('d.ambientSkip(0.12)');
        }
      }
      // Any other named view in LIFE_VIEWS, for framing.
      for (const [name, v] of Object.entries(views)) if (!['street', 'junction', 'stop', 'rooftop'].includes(name)) await still(page, name, v[0], v[1]);
      await call('d.ambientHold(false)');
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
        await page.evaluate((f) => (window as unknown as { __palimpsest: { darkQuarter(f: string, on: boolean): void } }).__palimpsest.darkQuarter(f, false), extra);
      }
    },

    async dark(page) {
      // Dark towers and the buyer's re-clad (Task 28; CAPTURE_ECONOMY=live CAPTURE_HOLD_SALE=1): Lodestar's tower
      // dark on its plot between the bankruptcy and the sale, from home, close and at its boarded foot; Kiln's quarter
      // going dark as a live bankruptcy shows it (the one debug override: the economy's story has no second
      // bankruptcy); then the economy's clock sells Lodestar's tower live and the shots follow Quickset's re-clad:
      // the scaffold rising, wrapped to the top with the floors rebuilt behind it, struck, and the windows relit.
      type Show = { plate: string; court: number; settled: boolean; towers: Array<{ agentId: string; lit: number; scaffold: number; phase: string; root: string; firmId: string }> };
      const show = (firm: string): Promise<Show | null> => page.evaluate((f) => (window as unknown as { __palimpsest: { quarterShow(f: string): Show | null } }).__palimpsest.quarterShow(f), firm);
      const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
      const by = (id: string): Quarter => qs.find((q) => q.firmId === id) ?? qs[0];
      const lode = by('lodestar');
      const plot = QUARTER_OFFSETS_CAPTURE[lode.towers[0]?.towerIndex ?? 0];
      const tx = lode.origin.x + plot.x;
      const tz = lode.origin.z + plot.z;
      console.log(`  lodestar ${JSON.stringify(await show('lodestar'))}`);
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: { home(): void } }).__palimpsest.home());
      await page.waitForTimeout(3200);
      await shoot(page, 'dark-home');
      await chrome(page, false);
      await still(page, 'dark-tower', [tx + 95, 26, tz + 120], [tx - 2, 24, tz]);
      await still(page, 'dark-far', [tx + 330, 110, tz + 420], [tx, 30, tz]);
      await still(page, 'dark-foot', [tx + 26, 2.2, tz + 34], [tx - 4, 5, tz]);
      await still(page, 'dark-court', [lode.origin.x + 40, 2, lode.origin.z + 96], [lode.origin.x - 20, 14, lode.origin.z - 30]);
      // A lit firm's lantern standard and its plane trees, close, from the court.
      const meri = by('meridian').origin;
      await still(page, 'lantern', [meri.x + 16, 6, meri.z + 30], [meri.x, 16, meri.z]);
      await still(page, 'lantern-top', [meri.x + 7, 21, meri.z + 11], [meri.x, 21, meri.z]);
      await still(page, 'trees', [meri.x + 34, 4, meri.z + 40], [meri.x + 20, 6, meri.z + 20]);
      // A live bankruptcy, at Kiln: the windows going out.
      const kiln = by('kiln');
      const kEye: V3 = [kiln.origin.x + 130, 40, kiln.origin.z + 170];
      const kAt: V3 = [kiln.origin.x - 4, 22, kiln.origin.z];
      await frame(page, kEye, kAt);
      await page.waitForTimeout(600);
      await save(page, 'darkening-before', 86);
      await page.evaluate(() => (window as unknown as { __palimpsest: { darkQuarter(f: string): void } }).__palimpsest.darkQuarter('kiln'));
      await page.waitForFunction(() => {
        const s = (window as unknown as { __palimpsest: { quarterShow(f: string): { towers: Array<{ lit: number }> } | null } }).__palimpsest.quarterShow('kiln');
        return !!s && s.towers.some((t) => t.lit < 0.6);
      }, null, { timeout: 8000 });
      await save(page, 'darkening', 86);
      await page.waitForTimeout(2600);
      await save(page, 'darkening-after', 86);
      // The override ends with its shots: Kiln is not bankrupt in the economy, and its lantern relights.
      await page.evaluate(() => (window as unknown as { __palimpsest: { darkQuarter(f: string, on: boolean): void } }).__palimpsest.darkQuarter('kiln', false));
      // The sale, live: Quickset buys Lodestar's tower and re-clads it.
      economy?.tick(1000);
      await economy?.idle();
      const phase = async (want: string[], ms = 30_000): Promise<Show['towers'][number] | null> => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const s = await show('lodestar');
          const t = s?.towers.find((x) => want.includes(x.phase));
          if (t) return t;
          await page.waitForTimeout(120);
        }
        return null;
      };
      const eye: V3 = [tx + 85, 30, tz + 110];
      const at: V3 = [tx - 2, 24, tz];
      await frame(page, eye, at);
      const rising = await phase(['rising']);
      console.log(`  rising ${JSON.stringify(rising)}`);
      await page.waitForFunction(() => {
        const s = (window as unknown as { __palimpsest: { quarterShow(f: string): { towers: Array<{ scaffold: number }> } | null } }).__palimpsest.quarterShow('lodestar');
        return !!s && s.towers.some((t) => t.scaffold > 0.45);
      }, null, { timeout: 20_000 });
      await save(page, 'reclad-rising', 86);
      console.log(`  rebuilt ${JSON.stringify(await phase(['rebuilding']))}`);
      await page.waitForTimeout(400);
      await save(page, 'reclad-wrapped', 86);
      await page.waitForFunction(() => {
        const s = (window as unknown as { __palimpsest: { quarterShow(f: string): { towers: Array<{ phase: string; scaffold: number }> } | null } }).__palimpsest.quarterShow('lodestar');
        return !!s && s.towers.some((t) => t.phase === 'striking' && t.scaffold < 0.6);
      }, null, { timeout: 20_000 });
      await save(page, 'reclad-striking', 86);
      await phase(['relighting']);
      await page.waitForTimeout(500);
      await save(page, 'reclad-relighting', 86);
      await page.waitForFunction(() => (window as unknown as { __palimpsest: { quarterShow(f: string): { settled: boolean } | null } }).__palimpsest.quarterShow('lodestar')?.settled === true, null, { timeout: 20_000 });
      await page.waitForTimeout(800);
      await still(page, 'reclad-done', eye, at);
      console.log(`  done ${JSON.stringify(await show('lodestar'))}`);
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: { home(): void } }).__palimpsest.home());
      await page.waitForTimeout(3200);
      await shoot(page, 'reclad-home');
    },

    async exchange(page) {
      // The civic exchange (CAPTURE_ECONOMY=1): the city from home, the hall from its forecourt and from across the
      // city, the tote board close with the economy's bidding jobs lit, the fountain at street level, and the fountain
      // stilled as it stands while the engine is stopped.
      type Ex = { exchange(): { slots: Array<{ state: string; lamps: number }>; running: boolean } | null };
      await page.waitForFunction(() => ((window as unknown as { __palimpsest: Ex }).__palimpsest.exchange()?.slots ?? []).some((s) => s.state === 'bidding'), null, { timeout: 15_000 }).catch(() => {});
      const ex = await page.evaluate(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange());
      console.log(`  board: ${JSON.stringify(ex?.slots.filter((s) => s.state !== 'empty'))}`);
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: { home(): void } }).__palimpsest.home());
      await page.waitForTimeout(3200);
      await shoot(page, 'exchange-home');
      const at = await page.evaluate(() => {
        const d = (window as unknown as { __palimpsest: { project(p: number[]): number[] } }).__palimpsest;
        return [d.project([0, 30, -6]), d.project([-42, 0, 9]), d.project([42, 0, 9]), d.project([0, 104, -52])];
      });
      const px = (v: number[]): string => `${Math.round(((v[0] + 1) / 2) * 1600)},${Math.round(((1 - v[1]) / 2) * 1000)}`;
      console.log(`  home: exchange at ${px(at[0])}, front ${px(at[1])} to ${px(at[2])}, campanile top ${px(at[3])}`);
      await chrome(page, false);
      await still(page, 'exchange', [34, 11, 84], [0, 24, -8]);
      await still(page, 'exchange-far', [300, 150, 420], [0, 26, -10]);
      await still(page, 'exchange-board', [3, 22.5, 30], [-1.5, 26.6, 9]);
      await still(page, 'exchange-capital', [-4, 22, 22], [-6.9, 24, 8]);
      await still(page, 'exchange-portico', [20, 5.5, 34], [-2, 14, 4]);
      await still(page, 'exchange-fountain', [14, 2.2, 68], [0, 5, 40]);
      await still(page, 'exchange-dome', [88, 75, 70], [0, 48, -20]);
      await still(page, 'exchange-campanile', [70, 40, 30], [0, 75, -52]);
      await still(page, 'exchange-clock', [6, 74, -30], [0, 76.5, -50]);
      // The kill switch, set through the engine's own route on the temp home: the stream tells the page, the water stills.
      await page.evaluate(() => fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-palimpsest': '1' }, body: '{"on":true}' }));
      await page.waitForTimeout(2500);
      await still(page, 'exchange-fountain-stopped', [14, 2.2, 66], [0, 5, 38]);
      const after = await page.evaluate(() => (window as unknown as { __palimpsest: Ex }).__palimpsest.exchange());
      console.log(`  fountain running after the stop: ${after?.running}`);
      await page.evaluate(() => fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-palimpsest': '1' }, body: '{"on":false}' }));
    },

    async construction(page) {
      // Live construction (CAPTURE_ECONOMY=live): the economy's working run framing a floor on its repo's tower. The
      // clock is ticked on demand, so each frame of the strip is one real progress step. Shots: the city from home, the
      // site from across the street, the crane close, the arc mid-weld, and a four-frame strip of the frame rising.
      type SV = { stage: string; progress: number; beams: number; beamsTotal: number; crane: number[]; weld: number[] | null; arc: number; top: number; floorHeight: number; centre: number[] };
      type Dbg = { liveSites(): Array<{ repo: string; stage: string }>; site(r: string): SV | null };
      const dbg = (): Promise<Array<{ repo: string; stage: string }>> => page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites());
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().some((s) => s.stage === 'framing'), null, { timeout: 15_000 }).catch(() => {});
      const framing = (await dbg()).find((s) => s.stage === 'framing');
      if (!framing) throw new Error('no framing site in the economy');
      const repo = framing.repo;
      const view = (): Promise<SV | null> => page.evaluate((r) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r), repo);
      const step = async (ms: number): Promise<void> => {
        economy?.tick(ms);
        await economy?.idle();
        await page.waitForTimeout(400);
      };
      // Into the work: a few steps of real progress.
      await step(1000);
      let s = (await view())!;
      console.log(`  ${repo}: ${s.stage} ${s.progress} beams ${s.beams}/${s.beamsTotal} top ${s.top.toFixed(1)}`);
      const [cx, , cz] = s.crane;
      const top = s.top;
      const w = (s.weld ?? [cx, top + s.floorHeight, cz]) as V3;
      const midWeld = async (name: string, eye: V3, target: V3): Promise<void> => {
        await frame(page, eye, target);
        await page.waitForTimeout(600);
        // Mid-bead: the arc has burned a third of a second (the spray is built up) and still burns.
        for (let tries = 0; tries < 30; tries++) {
          await page.waitForFunction((r) => ((window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r)?.arc ?? 0) > 0.3, repo, { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(350);
          if (((await view())?.arc ?? 0) > 0.3) break;
        }
        await save(page, name, 90);
      };
      // CONSTRUCTION_ONLY=weld: just the close-up of the arc, for quick spark rounds.
      if (process.env.CONSTRUCTION_ONLY === 'weld') {
        await chrome(page, false);
        const [ox, oz] = s.centre;
        for (let i = 0; i < 3; i++) await midWeld(`construction-weld-${i}`, [ox + (w[0] - ox) * 0.45 + 2.5, w[1] + 1.6, oz + (w[2] - oz) * 0.45 + 1.5], [w[0], w[1] - 0.8, w[2]]);
        return;
      }
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: { home(): void } }).__palimpsest.home());
      await page.waitForTimeout(3500);
      await shoot(page, 'construction-home');
      await chrome(page, false);
      await midWeld('construction', [cx - 70, top + 22, cz + 62], [cx + 4, top + 12, cz - 2]);
      await midWeld('construction-far', [cx - 260, top * 0.7 + 40, cz + 240], [cx, top + 6, cz]);
      await midWeld('construction-crane', [cx - 26, top + 14, cz + 34], [cx + 6, top + 14, cz - 4]);
      // Close on the arc from the deck inside the frame, looking out over the working edge.
      const [ox, oz] = s.centre;
      const inX = ox + (w[0] - ox) * 0.45;
      const inZ = oz + (w[2] - oz) * 0.45;
      await midWeld('construction-weld', [inX + 2.5, w[1] + 1.6, inZ + 1.5], [w[0], w[1] - 0.8, w[2]]);
      await midWeld('construction-street', [cx - 120, 6, cz + 150], [cx, top + 8, cz]);
      // The strip: four real progress steps, from the same eye.
      for (let i = 0; i < 4; i++) {
        await step(3000);
        s = (await view())!;
        console.log(`  strip ${i}: ${s.stage} ${s.progress} beams ${s.beams}/${s.beamsTotal}`);
        await page.waitForTimeout(3500);
        await midWeld(`construction-strip-${i}`, [cx - 70, top + 22, cz + 62], [cx + 4, top + 12, cz - 2]);
      }
    },

    async lifecycle(page) {
      // The rest of a run's life on its site (CAPTURE_ECONOMY=live, Task 27), every step a real event of the economy's
      // clock: the guild's searchlights sweeping a finished frame while its inspection runs (assay-kit), that
      // inspection failing (the clock is told to fail it) so the site is struck onto its scar and a work lamp is left
      // burning, then the harbour run's frame curing into its floor, the PR merging, the windows lighting row by row and
      // the crane climbing down. LIFECYCLE_ONLY=inspection stops after the searchlights.
      type SV = { stage: string; progress: number; crane: number[]; top: number; floorHeight: number; centre: number[]; searchlights: Array<{ at: number[]; end: number[] }>; frameFade: number; strike: number; dismantle: number; windows: number | null; workLamp: number[] | null; floor: string | null; busy: boolean; panes: number; era: string | null };
      type Dbg = { liveSites(): Array<{ repo: string; stage: string }>; site(r: string): SV | null; home(): void };
      const dbg = (): Promise<Array<{ repo: string; stage: string }>> => page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites());
      const view = (repo: string): Promise<SV | null> => page.evaluate((r) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r), repo);
      const step = async (ms: number): Promise<void> => {
        economy?.tick(ms);
        await economy?.idle();
        await page.waitForTimeout(300);
      };
      const log = async (repo: string, what: string): Promise<SV> => {
        const s = (await view(repo))!;
        console.log(`  ${what}: ${repo} ${s?.stage} fade ${s?.frameFade.toFixed(2)} strike ${s?.strike.toFixed(2)} dismantle ${s?.dismantle.toFixed(2)} windows ${s?.windows} lamp ${!!s?.workLamp} floor ${s?.floor} ${s?.era} panes ${s?.panes} lights ${s?.searchlights.length} ${s?.searchlights.map((l) => l.end.map((v) => v.toFixed(0)).join(',')).join(' ')}`);
        return s;
      };
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().some((s) => s.stage === 'inspecting'), null, { timeout: 15_000 });
      const insp = (await dbg()).find((s) => s.stage === 'inspecting')!.repo;
      const work = (await dbg()).find((s) => s.stage === 'framing')?.repo ?? null;
      await step(1000);
      let s = await log(insp, 'inspecting');
      const [cx, cz] = s.centre;
      const top = s.top;
      // From the plaza's city side, the home view's bearing, where the guild set up.
      const B = [0.63, 0.78];
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.home());
      await page.waitForTimeout(3500);
      await shoot(page, 'inspection-home');
      await chrome(page, false);
      const lens = s.searchlights[0]?.at ?? [cx + 40, 2, cz + 40];
      await still(page, 'inspection-site', [cx + B[0] * 150 - 40, Math.max(18, top * 0.25), cz + B[1] * 150 + 30], [cx, top * 0.72, cz]);
      await still(page, 'inspection-plaza', [lens[0] + B[0] * 14 - 6, 3.2, lens[2] + B[1] * 14 + 4], [cx, top + 2, cz]);
      await still(page, 'inspection-up', [cx + B[0] * 70 + 25, top - 70, cz + B[1] * 70 - 20], [cx, top + 1, cz]);
      await still(page, 'inspection-close', [cx + B[0] * 34 + 6, top + 11, cz + B[1] * 34 - 6], [cx, top + s.floorHeight * 0.5, cz]);
      await page.waitForTimeout(4000);
      await still(page, 'inspection-close-2', [cx + B[0] * 34 + 6, top + 11, cz + B[1] * 34 - 6], [cx, top + s.floorHeight * 0.5, cz]);
      await still(page, 'inspection-far', [cx + B[0] * 420 + 120, 60, cz + B[1] * 420 - 60], [cx, top * 0.7, cz]);
      if (process.env.LIFECYCLE_ONLY === 'inspection') return;

      // The verdict at 190 script seconds fails: the site is struck onto its scar.
      await step(8600);
      s = await log(insp, 'verdict');
      const scarEye: V3 = [cx + B[0] * 40 + 8, top + 9, cz + B[1] * 40 - 4];
      const scarAt: V3 = [cx + 2, top + s.floorHeight * 0.45, cz + 2];
      await page.waitForTimeout(1800);
      await log(insp, 'striking');
      await still(page, 'scar-strike', scarEye, scarAt);
      await page.waitForTimeout(6000);
      s = await log(insp, 'struck');
      await still(page, 'scar', scarEye, scarAt);
      const wl = s.workLamp ?? [cx + 13, top + 2.6, cz + 13];
      await still(page, 'scar-lamp', [wl[0] + 7, wl[1] + 1.2, wl[2] + 9], [wl[0] - 4, wl[1] - 0.6, wl[2] - 2]);
      await still(page, 'scar-far', [cx + B[0] * 260 + 40, top * 0.7 + 20, cz + B[1] * 260 - 30], [cx, top - 4, cz]);
      if (!work) return;

      // The harbour run: inspected and passed at 370 script seconds, so its frame cures into the floor and its PR waits.
      const h = (await view(work))!;
      const [hx, hz] = h.centre;
      const ht = h.top;
      const cureEye: V3 = [hx + B[0] * 42 + 6, ht + 12, hz + B[1] * 42 - 6];
      const cureAt: V3 = [hx, ht + h.floorHeight * 0.5, hz];
      await step(9000);
      await log(work, 'verdict');
      await page.waitForTimeout(900);
      await log(work, 'curing');
      await still(page, 'cure', cureEye, cureAt);
      await page.waitForTimeout(4500);
      await log(work, 'cured');
      await still(page, 'cure-done', cureEye, cureAt);
      // Merged at 520: the windows light row by row, then the crane climbs down.
      await step(7500);
      await page.waitForTimeout(1600);
      await log(work, 'lighting');
      await still(page, 'cured-lighting', cureEye, cureAt);
      await page.waitForTimeout(3500);
      await log(work, 'dismantling');
      await still(page, 'cured-dismantle', cureEye, cureAt);
      await page.waitForTimeout(7000);
      await log(work, 'lit');
      await still(page, 'cured', cureEye, cureAt);
      await still(page, 'cured-far', [hx + B[0] * 260 + 40, ht * 0.7 + 20, hz + B[1] * 260 - 30], [hx, ht - 4, hz]);
      await chrome(page, true);
      await page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.home());
      await page.waitForTimeout(3500);
      await shoot(page, 'lifecycle-home');
    },

    async 'market-overview'(page) {
      // The market at work (CAPTURE_ECONOMY=live): the city with the harbour tower's crane up, a tram passing, the
      // exchange lit, and the firms' lens, cantilever and needle towers on the skyline. MARKET_VIEW='[[eye],[target]]'
      // overrides the framing; the positions it is framed on are logged.
      await page.waitForFunction('window.__palimpsest.liveSites().some((s) => s.stage === "framing")', null, { timeout: 15_000 }).catch(() => {});
      const quarters = (await page.evaluate(() => fetch('/api/quarters').then((x) => x.json()))) as Quarter[];
      const crowns = quarters.flatMap((q) => q.towers.filter((t) => t.agentId && !t.dark && t.silhouette && t.silhouette !== 'plain').map((t) => `${t.silhouette} ${t.agentId} at ${Math.round(q.origin.x + QUARTER_OFFSETS_CAPTURE[t.towerIndex ?? 0].x)},${Math.round(q.origin.z + QUARTER_OFFSETS_CAPTURE[t.towerIndex ?? 0].z)}`));
      console.log(`  crowns: ${crowns.join(' | ')}`);
      const sites = (await page.evaluate('window.__palimpsest.liveSites()')) as Array<{ repo: string; stage: string }>;
      console.log(`  sites: ${sites.map((s) => `${s.repo} ${s.stage}`).join(', ')}`);
      const [eye, target] = (process.env.MARKET_VIEW ? JSON.parse(process.env.MARKET_VIEW) : MARKET_VIEW_DEFAULT) as [V3, V3];
      // A tram where the frame crosses its loop, moving.
      const near = (process.env.MARKET_TRAM ? JSON.parse(process.env.MARKET_TRAM) : MARKET_TRAM_DEFAULT) as number[];
      const passing = await callDebug<boolean>(page, `d.vehicleSeek([{ kind: 'tram', near: ${JSON.stringify(near)}, radius: 40, moving: 4 }], 4000)`);
      if (!passing) console.log('  no tram passing where the frame looks for one');
      await chrome(page, false);
      await still(page, 'market-overview', eye, target);
    },

    async screens(page) {
      // The market's screens (CAPTURE_ECONOMY=live), each over the city as it opens: the job board, the harbour job
      // that is running, its run's live transcript, the scarred job's inspection report, the firms, Dagny Hollis's
      // agent page and the treasury. Taken before any clip ticks the economy's clock on.
      const table = this as unknown as Record<string, (p: Page) => Promise<void>>;
      for (const name of ['jobs', 'job', 'run-log', 'inspection', 'firms', 'agent', 'treasury']) await table[name](page);
    },

    async jobs(page) {
      await openHash(page, '#/jobs', '.sheet .sec-bidding .job-row');
      await shoot(page, 'jobs');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async job(page) {
      const running = await runningHarbour(page);
      await openHash(page, `#/jobs/${running.id}`, '.jobpage .job-award');
      await shoot(page, 'job');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'run-log'(page) {
      // The live run's first view: its stage, its figures and the transcript's tail together.
      const running = await runningHarbour(page);
      await openHash(page, `#/runs/${running.runId}`, '.runpage .run-log .log-row');
      await page.waitForTimeout(800);
      await shoot(page, 'run-log');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async inspection(page) {
      // The scarred job's first attempt: eight checks, two failed (scope and review), the reviewer's concerns.
      const jobs = (await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()))) as Array<{ id: string; title: string }>;
      const scarred = jobs.find((j) => j.title === 'Search index rebuild blocks the API for 40 seconds');
      if (!scarred) throw new Error('no scarred job in the economy');
      const d = (await page.evaluate((id) => fetch(`/api/jobs/${id}`).then((r) => r.json()), scarred.id)) as { runs: Array<{ id: string; outcome: string }>; inspections: Array<{ id: string; runId: string }> };
      const failed = d.runs.find((r) => r.outcome === 'failed');
      const insp = d.inspections.find((i) => i.runId === failed?.id);
      if (!insp) throw new Error('the scarred job has no failed inspection');
      await openHash(page, `#/inspections/${insp.id}`, '.insppage .check-row');
      await shoot(page, 'inspection');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async firms(page) {
      await openHash(page, '#/firms', '.sheet.firms .firm-row');
      await shoot(page, 'firms');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async agent(page) {
      // Dagny Hollis, the specialist Quickset hired from the roster: her design, lineage and tower.
      await openHash(page, '#/agents/dagny-hollis', '.sheet.agentpage .agent-design');
      await shoot(page, 'agent');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async treasury(page) {
      // A fresh reading of the sample plan (34% and 21%), so the meters read as they do in use.
      const { sampleReading } = await import('../engine/market/sample-economy.js');
      sampleReading(Date.now());
      await openHash(page, '#/treasury', '.sheet.treasury .meter');
      await shoot(page, 'treasury');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'construction-clip'(page) {
      // Forty seconds of the economy's clock at speed 20 (CAPTURE_ECONOMY=live), one tick a frame: the harbour run's
      // crane over a frame going up in sparks, the guild's searchlights on the finished frame, the frame curing into
      // its floor, the merge, the windows lighting and the crane climbing down. Written as construction.mp4.
      type SV = { stage: string; crane: number[]; top: number; floorHeight: number; centre: number[] };
      type Dbg = { liveSites(): Array<{ repo: string; stage: string }>; site(r: string): SV | null };
      await page.waitForFunction(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites().some((s) => s.stage === 'framing'), null, { timeout: 15_000 });
      const repo = (await page.evaluate(() => (window as unknown as { __palimpsest: Dbg }).__palimpsest.liveSites())).find((s) => s.stage === 'framing')!.repo;
      const s = (await page.evaluate((r) => (window as unknown as { __palimpsest: Dbg }).__palimpsest.site(r), repo))!;
      const [cx, cz] = s.centre;
      const top = s.top;
      const seconds = Number(process.env.CONSTRUCTION_SECONDS ?? 40);
      // From the plaza's city side (the lifecycle's bearing), drifting a little round the site as it works.
      const a0 = Math.atan2(0.78, 0.63);
      const span = Number(process.env.CONSTRUCTION_SPAN ?? 0.5);
      const r = Number(process.env.CONSTRUCTION_RADIUS ?? 110);
      await chrome(page, false);
      await film(
        page,
        'construction',
        Math.round(seconds * FPS),
        async (_i, t) => {
          economy?.tick(1000 / FPS);
          await economy?.idle();
          const a = a0 - span / 2 + span * easeSine(t);
          return { eye: [cx + Math.cos(a) * r, top + 10, cz + Math.sin(a) * r], target: [cx, top + 16, cz] };
        },
        false,
        Number(process.env.CONSTRUCTION_POSTER ?? 0.4),
      );
    },

    async commute(page) {
      // Two people on their way to work (CAPTURE_ECONOMY=live): Dagny Hollis walking to the tram from her firm's side
      // of the city, on the platform as the tram comes in, and riding it; then Hal Meridian stepping into a cab at the
      // kerb and the cab pulling away. The city routes a trip from the exchange to a site on foot (the tram loop runs
      // outside the districts), so the tram trip is one the router does put on a tram. Each part is filmed on the
      // virtual clock; between parts the people's clock is moved on. COMMUTE_TRAM and COMMUTE_CAB='[[from],[to]]' move the trips.
      const dir = mkdtempSync(join(tmpdir(), 'palimpsest-commute-'));
      let n = 0;
      const clock = await virtualClock(page);
      const shoot1 = async (eye: V3, target: V3): Promise<void> => {
        await page.evaluate(([e, t]) => (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t), [eye, target] as [V3, V3]);
        await clock.tick(1 / FPS);
        await page.screenshot({ path: join(dir, `f${String(n++).padStart(4, '0')}.png`) });
        if (n % 60 === 0) process.stdout.write(`  ${n}\r`);
      };
      /** Follows a figure for `seconds`, the camera easing after it; `aim` frames it (the follow camera's framing by default). */
      const follow = async (id: string, seconds: number, aim: (f: FigureProbe, v: { position: number[]; heading: number } | null) => [V3, V3] = (f) => followView(f)): Promise<void> => {
        const ease = chase(0.12);
        for (let i = 0; i < Math.round(seconds * FPS); i++) {
          const f = await person(page, id);
          if (!f) return;
          const v = f.ride ? await callDebug<{ position: number[]; heading: number } | null>(page, `d.vehicle(${JSON.stringify(f.ride.id)})`) : null;
          const [e, t] = aim(f, v);
          const c = ease(e, t);
          await shoot1(c.eye, c.target);
        }
      };
      /** runUntil, but null unless the figure really reached the state asked for. */
      const until = async (id: string, ok: (f: FigureProbe, v: VehicleProbe | null) => boolean, max = 900, step = 0.5): Promise<FigureProbe | null> => {
        const f = await runUntil(page, id, ok, max, step);
        if (!f) return null;
        const v = f.ride ? await callDebug<VehicleProbe | null>(page, `d.vehicle(${JSON.stringify(f.ride.id)})`) : null;
        return ok(f, v) ? f : null;
      };
      try {
        await chrome(page, false);
        await callDebug(page, 'd.peopleLantern(true)');
        const [tFrom, tTo] = (process.env.COMMUTE_TRAM ? JSON.parse(process.env.COMMUTE_TRAM) : [[560, -300], [600, 200]]) as [[number, number], [number, number]];
        await sendPerson(page, 'dagny-hollis', tFrom, tTo);
        const legs = ((await person(page, 'dagny-hollis')) ? await callDebug<Array<{ mode: string }>>(page, `d.vehicleTrip(${JSON.stringify(tFrom)}, ${JSON.stringify(tTo)})`) : []).map((l) => l.mode);
        console.log(`  tram trip legs: ${legs.join(' > ')}`);
        await callDebug(page, 'd.peopleSkip(8)');
        await follow('dagny-hollis', 4);
        // On the platform, as the tram comes in: from up the platform, looking back at her.
        const w = await until('dagny-hollis', (x) => x.mode === 'tram' && x.stage === 'wait');
        if (w) {
          const f0 = await until('dagny-hollis', (x, v) => x.stage !== 'wait' || (!!v && apart(x, v) < 90 && v.speed > 0.5), 1200);
          const at = f0 ?? w;
          const eye = aroundPerson(at.position, at.heading, 11, 2.4, at.position[1] + 2.4);
          const target = aroundPerson(at.position, at.heading, -1.5, 0.3, at.position[1] + 1.2);
          for (let i = 0; i < Math.round(6 * FPS); i++) await shoot1(eye, target);
          // Riding: beside the tram, keeping pace with it.
          const r = await until('dagny-hollis', (x) => x.stage === 'ride', 240);
          if (r) {
            await callDebug(page, 'd.peopleSkip(4)');
            await follow('dagny-hollis', 5, (f, v) => (v ? [aroundPerson(v.position, v.heading, -20, 1.5, v.position[1] + 7), aroundPerson(v.position, v.heading, 10, 0, v.position[1] + 1.5)] : followView(f)));
          } else console.log('  dagny never rode the tram');
        } else console.log('  dagny never waited for a tram');
        // Hal's cab: at the kerb as it pulls up, then away.
        const [cFrom, cTo] = (process.env.COMMUTE_CAB ? JSON.parse(process.env.COMMUTE_CAB) : [[446.5, 330], [1100, -200]]) as [[number, number], [number, number]];
        await sendPerson(page, 'hal-meridian', cFrom, cTo);
        const b = await until('hal-meridian', (x) => x.stage === 'board', 900, 1);
        if (b) {
          const v0 = b.ride ? await callDebug<{ position: number[]; heading: number } | null>(page, `d.vehicle(${JSON.stringify(b.ride.id)})`) : null;
          if (v0) {
            const eye = aroundPerson(v0.position, v0.heading, 7.5, 5.2, 1.6);
            const target = aroundPerson(v0.position, v0.heading, -0.5, 0.6, 1.0);
            for (let i = 0; i < Math.round(3.5 * FPS); i++) await shoot1(eye, target);
          }
          // Then from the kerb as it pulls away into the street.
          const kerb = v0 ? aroundPerson(v0.position, v0.heading, 9, 5.5, 1.7) : null;
          if (!(await until('hal-meridian', (x) => x.stage === 'ride', 120, 0.25))) console.log('  hal never rode off');
          await follow('hal-meridian', 6, (f, v) => (v && kerb ? [kerb, [v.position[0], 1.2, v.position[2]]] : followView(f)));
        } else console.log('  hal never boarded a cab');
      } finally {
        await clock.off();
        await callDebug(page, 'd.peopleLantern(null)');
      }
      console.log(`commute: ${n} frames`);
      encodeClip(dir, 'commute', false, Number(process.env.COMMUTE_POSTER ?? 0.4));
      if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
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

/** What a bare `tools/capture.ts` writes: the README's media. */
const README_SHOTS = ['hero', 'stills', 'overview', 'market-overview', 'inspector', 'repos', 'settings', 'screens', 'brief', 'audit', 'spire', 'revival', 'ribbon', 'ride-dossier', 'people', 'life', 'ride', 'week', 'flyover', 'rise', 'construction-clip', 'commute'];

/** The market overview's framing and where it looks for a passing tram (MARKET_VIEW and MARKET_TRAM override). */
const MARKET_VIEW_DEFAULT: [V3, V3] = [[620, 190, 560], [60, 60, -40]];
const MARKET_TRAM_DEFAULT = [600, -150];

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
  // With no shots named: every still and clip the README shows, on the sample economy with its clock running, in an
  // order where nothing that ticks the clock comes before the screens and stills that show the board as it stands.
  const readme = process.argv.slice(2).length === 0;
  const wanted = readme ? README_SHOTS : process.argv.slice(2);
  if (readme) {
    process.env.CAPTURE_ECONOMY ??= 'live';
    process.env.PEOPLE_ONLY ??= 'follow';
    process.env.LIFE_ONLY ??= 'street';
    process.env.RIDE_ONLY ??= 'clip';
  }
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
    // The treasury reads a transcripts folder, and so does the brief the history opens (Phase 3). As in the UI test, the
    // run says it is a test so the guard lets it read the sample's own empty folder, and that folder is pinned inside the
    // temp home before anything reads it, so ~/.claude/projects is never read.
    process.env.PALIMPSEST_TEST_PROJECTS = '1';
    const { useSampleFolders } = await import('../engine/sample.js');
    useSampleFolders();
    const projects = process.env.PALIMPSEST_CLAUDE_PROJECTS;
    const inside = projects ? relative(resolve(tmp), resolve(projects)) : '..';
    if (!projects || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`capture: the transcripts folder ${projects ?? '(unset)'} is not inside the temp home ${tmp}; refusing to run`);
    }
    // CAPTURE_HOLD_SALE=1: Lodestar's dark tower is not sold in the history, so the `dark` shot sees it dark and then sold live.
    await seedEconomy(Date.now(), { holdSale: !!process.env.CAPTURE_HOLD_SALE });
  }
  // Every gh and git call goes to the sample's stand-in: the Repos screen lists only fictional repos.
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });
  // CAPTURE_ECONOMY=live: the economy's job sites and trips in the live view, and its clock at speed 20, ticked by the shots.
  if (process.env.CAPTURE_ECONOMY === 'live') {
    const { setMarketExtras } = await import('../engine/market/api.js');
    const { economyClock, economySites } = await import('../engine/market/sample-economy.js');
    setMarketExtras({ sites: economySites });
    // Two long rides for the stills, on top of the economy's own trips: the pods along z 120 and the rail round the city.
    const { agent } = await import('../engine/market/firms.js');
    const { startTrip } = await import('../engine/market/trips.js');
    const rider = (id: string) => {
      const a = agent(id);
      if (!a) throw new Error(`no sample agent ${id}`);
      return a;
    };
    startTrip(rider('hal-meridian'), 'job', null, { x: -700, z: 120 }, { x: 900, z: 120 });
    startTrip(rider('bruno-kiln'), 'home', null, { x: 600, z: -600 }, { x: -600, z: 600 });
    // The lifecycle shot has the clock fail the inspecting repo's inspection, so a scar is struck (CAPTURE_FAIL overrides).
    const fail = process.env.CAPTURE_FAIL ? process.env.CAPTURE_FAIL.split(',') : wanted.includes('lifecycle') ? ['lantern/assay-kit'] : [];
    economy = economyClock({ now: () => Date.now(), speed: 20, fail, sell: process.env.CAPTURE_HOLD_SALE ? 5 : undefined });
  }
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // Fixed quality: a slow headless frame must never step a capture down to medium.
    // ?debug exposes the app's debug handle (window.__palimpsest), which drives every shot.
    await page.goto(`http://127.0.0.1:${PORT}/?fixed-quality&debug`);
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
