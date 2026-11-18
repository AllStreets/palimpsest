/**
 * README and profile media, captured frame by frame from the real app.
 *
 * Starts its own engine in-process on CAPTURE_PORT (4788 on the screens
 * track, 4789 after the merge) with a temp data home and a
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
 * ride (the lift up the harbor tower, datum to roof), week (week.mp4: the week tour, forty-five
 * seconds; CAPTURE_ECONOMY=1), market-overview, screens (jobs, job,
 * run-log, inspection, firms, agent, treasury, each also a shot of its own),
 * construction-clip (construction.mp4: forty seconds of the economy's clock,
 * crane to cure) and commute (commute.mp4: a tram rider and a cab). The
 * school (Phase 4): school-screens (school, school-net, autonomy-settings,
 * brief-autonomy, agent-graduate, each also a shot of its own), campus (its
 * stills; CAMPUS_ONLY names some), graduate-tower, the clips voyage
 * (voyage.mp4: the library lighting for a voyage) and observatory
 * (observatory.mp4: the dome opening while the nets train), and
 * school-empty (the school on a fresh home, always shot last). With no
 * shots named, it writes exactly the README's media (README_SHOTS) on the
 * sample economy with its clock running (CAPTURE_ECONOMY=live). families rebuilds the tallest
 * tower's sci-fi run in each family and shoots it close, then from the street. swatches measures every material variant's
 * rendered colour at the overview's distance (SWATCH_WRITE=1 writes
 * app/src/city/tower/rendered.ts).
 * The city-only shots hide the running head and the name plates; overview,
 * inspector, repos and settings show the app as it is.
 * Where it writes (Phase 5 test safety rule 17): a fresh temp dir by default,
 * CAPTURE_OUT=<dir> for probing, and docs/media only with
 * CAPTURE_WRITE_MEDIA=1 (Tasks 27 and 28). CAPTURE_FRAMES=<dir> keeps each
 * clip's frames in <dir>/<clip>/ (with clip.json naming its frame rate) and
 * each still's PNG in <dir>/stills/, for tools/film.ts.
 * Phase 5 adds: district-audit and job-scope (stills), audit (a clip: 30 s at
 * the clock's speed, the kumo audit ending and its proposals appearing on the
 * board; the audit page's still is audit-page, written as audit.webp),
 * hero-rise (a clip for the film: up from the street to the hero framing),
 * profile-loop (frames only, for the film tool's profile clip: the flyover's
 * arc there and back, so its tail stands where its head did),
 * week-poster (the week's poster, framed off the sun), overview-clear (the
 * overview in clear air, where the build has the haze control), street and
 * people-follow (the life and people stills on their own), and diagrams
 * (the eight diagram images, through tools/diagrams.ts), and palette (Cmd+K
 * opened over the overview, a query typed, its ranked results; PALETTE_QUERY).
 * The city stills (hero, stills, overview and the rest) stand the app on the
 * city first, so the brief the day's first open draws is never in them.
 * Options (env): CAPTURE_FPS=30, CAPTURE_DPR=2, CAPTURE_KEEP=1 keeps the raw frames,
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
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { SUN_DIRECTION } from '../app/src/city/sky.js';
import { FAMILIES, VARIANTS } from '../app/src/city/tower/variants.js';
import { cityExtent, viewLimits, type CityExtent } from '../app/src/city/view.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';
import { QUARTER_OFFSETS as QUARTER_OFFSETS_CAPTURE } from '../shared/district-layout.js';
import { boardFrame, boardTowers, boardViews } from './agent-board.js';
import { outDir } from './diagrams.js';
import { PROFILE, capturePort, profileLoopArc } from './film.js';
import { seededWeek } from './seeded-week.js';
import { BUDGET } from './media-check.js';
import { ambientInputs, towerInputs } from './measure-inputs.js';
import { MAX_RETRIES, TRAM_WALKERS, boardedTram } from './commute-check.js';
import { apart, around as aroundPerson, callDebug, followView, person, runUntil, sendPerson, type FigureProbe, type VehicleProbe } from './people-stage.js';
import { paneFraming } from './pane-framing.js';
import { decodePng, labOf } from './png.js';
import { SAMPLE, SAMPLE_TALL, sampleGh, seedSample, shrinkSample } from './sample.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// A temp dir unless CAPTURE_OUT names one; docs/media only with CAPTURE_WRITE_MEDIA=1 (test safety rule 17).
const MEDIA = outDir(process.env, 'palimpsest-capture-');
const WRITE_MEDIA = process.env.CAPTURE_WRITE_MEDIA === '1';
const PORT = capturePort(process.env.CAPTURE_PORT ?? '4788');
/** The sample economy's clock (CAPTURE_ECONOMY=live), ticked on demand by the shots that show it moving. */
let economy: { tick(ms: number): void; idle(): Promise<void> } | null = null;
/**
 * The moment the screens' usage reading is taken (final review I1): Settings and the treasury write the same reading,
 * so their five-hour figure and reset time agree to the minute however far apart in the run they are shot.
 */
let readingAt: number | null = null;
async function freshReading(): Promise<void> {
  const { sampleReading } = await import('../engine/market/sample-economy.js');
  sampleReading((readingAt ??= Date.now()));
}
/** When the sample's history was seeded: its week is the one the tour walks (seededWeek). */
let seededAt = Date.now();
/** The block pitch (lots.ts PITCH), for framing streets. */
const PITCH_M = 80;
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FPS = Number(process.env.CAPTURE_FPS ?? 30);
const DPR = Number(process.env.CAPTURE_DPR ?? 2);
// 16:10, the whole window: it fits the 800x500 profile card with nothing cropped.
const VIEWPORT = { width: 1600, height: 1000 };

type V3 = [number, number, number];

/** The commute's platform eye, in her frame: metres up the platform ahead of her, and to her right (toward the shelter). */
const COMMUTE_EYE = { along: 11, out: 0.6 } as const;

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
  /** Where in the clip its poster is taken, 0 to 1 (default the middle). */
  posterAt?: number;
  /** Frames for the film tool only (CAPTURE_FRAMES): no mp4, avif or poster of its own. */
  framesOnly?: boolean;
}

// ---------------------------------------------------------------- encoding

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
}

function mb(path: string): string {
  return `${(statSync(path).size / 1e6).toFixed(1)} MB`;
}

/**
 * The README's share of the 45 MB docs/media holds (ruling 8): with the film
 * (9.5 MB), the profile loop and about sixty stills beside them, a linked
 * clip is held to 2.5 MB and an inline one to 1.5 MB, well under their own caps.
 */
const README_LINKED = 2.5 * 1024 * 1024;
const README_INLINE = 1.5 * 1024 * 1024;

/**
 * From 2x PNG frames: a 1280x800 H.264 MP4, an animated AVIF at 960x600
 * for the README to play inline, and a poster from the clip itself as the
 * AVIF's fallback (Phase 5 dropped the GIF and the profile card: the
 * profile clip is tools/film.ts's, and the film cuts from the kept frames).
 */
function encode(dir: string, name: string, posterAt = 0.5): void {
  const input = ['-framerate', String(FPS), '-i', join(dir, 'f%04d.png')];
  const mp4 = join(MEDIA, `${name}.mp4`);
  const c = underBudget(mp4, Math.min(BUDGET.linkedMp4, README_LINKED), 24, 2, (crf) => ff([...input, '-vf', 'scale=1280:800:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'film', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]));
  const avif = join(MEDIA, `${name}.avif`);
  const a = underBudget(avif, Math.min(BUDGET.inlineAnimation, README_INLINE), 34, 3, (crf) => ff([...input, '-vf', 'fps=24,scale=960:600:flags=lanczos', '-c:v', 'libsvtav1', '-preset', '4', '-crf', String(crf), '-g', '96', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', avif]));
  console.log(`  ${name}: mp4 ${mb(mp4)} (crf ${c}), avif ${mb(avif)} (crf ${a})`);
  writePoster(dir, name, posterAt);
}

/**
 * Encodes at `crf`, then steps it up by `step` until the file is within
 * `cap` bytes (the README's media budget, tools/media-check.ts), at most
 * five steps; returns the CRF it settled on. Over the cap after that is
 * left for media:check to name.
 */
function underBudget(path: string, cap: number, crf: number, step: number, run: (crf: number) => void): number {
  for (let i = 0; ; i++, crf += step) {
    run(crf);
    if (statSync(path).size <= cap) return crf;
    if (i === 5) {
      console.warn(`  warning: ${basename(path)} is ${mb(path)} at crf ${crf}, still over its ${(cap / 1024 / 1024).toFixed(0)} MB cap`);
      return crf;
    }
  }
}

/** A 2x PNG as a 1600 x 1000 WebP, its quality stepped down from `quality` until it is within the still budget (450 KB). */
function stillWebp(png: string, webp: string, quality: number): number {
  for (let q = quality; ; q -= 4) {
    execFileSync('cwebp', ['-q', String(q), '-m', '6', '-resize', '1600', '1000', png, '-o', webp], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (statSync(webp).size <= BUDGET.still) return q;
    if (q <= 60) {
      console.warn(`  warning: ${basename(webp)} is ${mb(webp)} at q${q}, still over the 450 KB for a still`);
      return q;
    }
  }
}

/** A still from the clip itself, for the README to show where the clip is linked, or as its inline AVIF's fallback. */
function writePoster(dir: string, name: string, posterAt: number): void {
  const frames = readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort();
  const pick = frames[Math.min(frames.length - 1, Math.round(posterAt * (frames.length - 1)))];
  const poster = join(MEDIA, `${name}-poster.webp`);
  const q = stillWebp(join(dir, pick), poster, 86);
  console.log(`  ${name}-poster.webp ${mb(poster)} (frame ${pick}, q${q})`);
}

/**
 * A clip's frames once encoded: kept in CAPTURE_FRAMES/<name>/ for the film
 * (with the frame rate they were taken at), kept where they are with
 * CAPTURE_KEEP=1, or removed.
 */
function keepFrames(dir: string, name: string, fps: number = FPS): void {
  if (process.env.CAPTURE_FRAMES) {
    const to = join(process.env.CAPTURE_FRAMES, name);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true });
    cpSync(dir, to, { recursive: true, filter: (src) => src === dir || /\/f\d+\.png$/.test(src) });
    writeFileSync(join(to, 'clip.json'), `${JSON.stringify({ fps, frames: readdirSync(to).filter((f) => f.endsWith('.png')).length })}\n`);
    rmSync(dir, { recursive: true, force: true });
    console.log(`  frames kept in ${to}`);
  } else if (process.env.CAPTURE_KEEP) console.log(`  frames kept in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

/** A still's full-size PNG, kept in CAPTURE_FRAMES/stills/ for the film. */
function keepStill(path: string, name: string): void {
  if (!process.env.CAPTURE_FRAMES) return;
  const dir = join(process.env.CAPTURE_FRAMES, 'stills');
  mkdirSync(dir, { recursive: true });
  cpSync(path, join(dir, `${name}.png`));
}

async function record(page: Page, shot: Shot): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `palimpsest-${shot.name}-`));
  const n = Math.round(shot.seconds * FPS);
  console.log(`${shot.name}: ${n} frames`);
  // On the virtual clock, as film() is: a frame takes a second or more to shoot, and on the page's own clock the
  // crane's slew, the searchlights and the traffic jumped that far between frames.
  const clock = await virtualClock(page);
  try {
    for (let i = 0; i < n; i++) {
      const { eye, target } = shot.at(n === 1 ? 0 : i / (n - 1));
      await page.evaluate(([e, t]) => {
        (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
      }, [eye, target] as [V3, V3]);
      await clock.tick(1 / FPS);
      await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
      if (i % 60 === 0) process.stdout.write(`  ${i}/${n}\r`);
    }
  } finally {
    await clock.off();
  }
  if (!shot.framesOnly) encode(dir, shot.name, shot.posterAt);
  keepFrames(dir, shot.name);
}

/**
 * The README's clips, kept small enough to sit in the repo: a 1280x800 H.264
 * MP4 to click through to and, for the inline ones, an 800x500 animated AVIF
 * the page plays. No card or GIF set: those are the flyover's and the rise's.
 */
function encodeClip(dir: string, name: string, inline: boolean, posterAt?: number, fps: number = FPS, mp4Opts: { size: string; crf: number; film?: boolean } = { size: '1280:800', crf: 24 }): void {
  if (posterAt !== undefined) writePoster(dir, name, posterAt);
  const input = ['-framerate', String(fps), '-i', join(dir, 'f%04d.png')];
  const mp4 = join(MEDIA, `${name}.mp4`);
  const tuning = mp4Opts.film ? ['-preset', 'veryslow', '-tune', 'film'] : ['-preset', 'slow'];
  const c = underBudget(mp4, Math.min(BUDGET.linkedMp4, README_LINKED), mp4Opts.crf, 2, (crf) => ff([...input, '-vf', `scale=${mp4Opts.size}:flags=lanczos`, '-c:v', 'libx264', ...tuning, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]));
  let line = `  ${name}: mp4 ${mb(mp4)} (crf ${c})`;
  if (inline) {
    const avif = join(MEDIA, `${name}.avif`);
    const a = underBudget(avif, Math.min(BUDGET.inlineAnimation, README_INLINE), 36, 3, (crf) => ff([...input, '-vf', 'fps=24,scale=800:500:flags=lanczos', '-c:v', 'libsvtav1', '-preset', '4', '-crf', String(crf), '-g', '96', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', avif]));
    line += `, avif ${mb(avif)} (crf ${a})`;
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
  keepFrames(dir, name);
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
 * Screenshots the page at 2x and writes the WebP the README shows, at
 * 1600 x 1000 and within the still budget (450 KB). In docs/media the PNG
 * is removed once its WebP is written; elsewhere it stays for review.
 */
async function save(page: Page, name: string, quality: number): Promise<void> {
  const path = join(MEDIA, `${name}.png`);
  const webp = join(MEDIA, `${name}.webp`);
  await page.screenshot({ path });
  const q = stillWebp(path, webp, quality);
  console.log(`  ${name}.png ${mb(path)}, .webp ${mb(webp)} (q${q})`);
  keepStill(path, name);
  // docs/media keeps only what the README uses (media:check); elsewhere the PNG stays for review.
  if (WRITE_MEDIA) rmSync(path);
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
  const q = stillWebp(path, webp, text ? 90 : 84);
  console.log(`  ${name}.webp ${mb(webp)} (q${q})`);
  keepStill(path, name);
  if (WRITE_MEDIA) rmSync(path);
}

type Show = { id: string; kind: string; towerId: string; lit: boolean; y: number; height: number; tip: number[] };
/** The milestones as the city shows them now (the debug handle's milestones()). */
async function shows(page: Page): Promise<Show[]> {
  await page.waitForFunction('window.__palimpsest.milestones().length > 0', null, { timeout: 15_000 });
  return (await page.evaluate('window.__palimpsest.milestones()')) as Show[];
}

/**
 * Hides the running head, the notices and the name plates, for the shots that show only the city, and stands the
 * app on the city first: on the day's first open the brief draws over the left of the frame, and a city still is
 * never a page beside a city (Phase 5 audit). `plates` keeps the name plates, which are the city's own.
 */
async function chrome(page: Page, on: boolean, o: { plates?: boolean } = {}): Promise<void> {
  if (!on) await toCity(page);
  await page.evaluate(([show, plates]) => {
    let style = document.getElementById('capture-chrome');
    if (!style) {
      style = document.createElement('style');
      style.id = 'capture-chrome';
      document.head.append(style);
    }
    style.textContent = show ? '' : `.runhead, .city-notice${plates ? '' : ', .plates'} { display: none !important; }`;
  }, [on, !!o.plates] as [boolean, boolean]);
}

/** Closes any sheet (the brief the day's first open draws, or a screen left open) so the city is the whole frame. */
async function toCity(page: Page): Promise<void> {
  if ((await page.evaluate('document.body.dataset.route')) === 'city') return;
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForSelector('body[data-route="city"]', { timeout: 10_000 });
  // The sheet and its scrim fade out (0.3 s) before the frame is the city's alone.
  await page.waitForTimeout(900);
}

/** Opens a screen from the running head, as a click would, and waits for it to settle. */
async function openScreen(page: Page, route: 'city' | 'repos' | 'settings', ready: string): Promise<void> {
  await page.locator(`.runhead a[data-route="${route}"]`).click();
  // The pointer leaves the head, so no still shows a link under it marked by the hover's rule.
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 4);
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

/** The economy's running harbor job, the one the job and run stills show. */
async function runningHarbor(page: Page): Promise<{ id: string; runId: string }> {
  const jobs = (await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()))) as Array<{ id: string; status: string; repo: string; runId: string | null }>;
  const j = jobs.find((x) => x.status === 'running' && x.repo === 'tidewater/harbor-ledger');
  if (!j?.runId) throw new Error('the economy has no running harbor job');
  return { id: j.id, runId: j.runId };
}

/** The campus's own frame, as the ui-test reads it: x from the gate toward the library, z across it. */
async function campusFrame(page: Page): Promise<(x: number, y: number, z: number) => V3> {
  type C = { origin: { x: number; z: number }; anchors: Record<'library' | 'clock' | 'dome' | 'gate', V3> } | null;
  const c = (await page.evaluate('window.__palimpsest.campus()')) as C;
  if (!c) throw new Error('capture: no campus stands (the engine has not taken the plot)');
  const g = c.anchors.gate;
  const l = c.anchors.library;
  const n = Math.hypot(l[0] - g[0], l[2] - g[2]);
  const ax = [(l[0] - g[0]) / n, (l[2] - g[2]) / n];
  return (x, y, z) => [g[0] + ax[0] * x - ax[1] * z, y, g[2] + ax[1] * x + ax[0] * z];
}

/** Scrolls an open sheet so `sel` stands at the top of its body, for a shot. */
async function toSheetTop(page: Page, sel: string, margin = 16): Promise<void> {
  await page.locator(sel).first().evaluate((sec, m) => {
    const body = sec.closest('.sheet-body') as HTMLElement;
    body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top - m;
  }, margin);
  await page.waitForTimeout(500);
}

/** The most scrolled stills a sheet gives after its first screen (so a sheet gives at most 1 + this many). */
const SCROLL_STILLS_MAX = 5;

/**
 * Scrolls an open sheet's own body (.sheet-body) one screen at a time and takes a still of each, named `<name>-2`,
 * `<name>-3` and so on, until the body's end or the cap. The audit reads these for what lies below the first screen.
 * The README's media (CAPTURE_WRITE_MEDIA) stay as they were, so there it takes none.
 */
async function scrolledStills(page: Page, sheet: string, name: string, text = true): Promise<void> {
  if (WRITE_MEDIA) return;
  const body = page.locator(`${sheet} .sheet-body`).first();
  for (let i = 2; i < 2 + SCROLL_STILLS_MAX; i++) {
    // One screen down, less the sheet's pinned head and a strip of overlap, so no row falls between two stills.
    const moved = (await body.evaluate((el) => {
      const b = el as HTMLElement;
      const before = b.scrollTop;
      b.scrollTop = before + Math.max(1, b.clientHeight - 270);
      return b.scrollTop - before;
    })) as number;
    if (moved < 1) break;
    await page.waitForTimeout(500);
    await lean(page, `${name}-${i}`, text);
  }
}

/** Runs `fn` with one environment variable set, then puts it back. */
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const was = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
}

/** True when the low sun stands in (or at the edge of) the frame the camera holds now, so its bloom would be in the shot. */
async function sunInFrame(page: Page): Promise<boolean> {
  const eye = (await page.evaluate('window.__palimpsest.camera()')) as number[];
  const at: V3 = [eye[0] + SUN_DIRECTION.x * 500, eye[1] + SUN_DIRECTION.y * 500, eye[2] + SUN_DIRECTION.z * 500];
  const [x, y, z] = (await page.evaluate(`window.__palimpsest.project(${JSON.stringify(at)})`)) as number[];
  return z < 1 && Math.abs(x) < 1.35 && Math.abs(y) < 1.35;
}

/**
 * A framing pulled back along its line, 6% at a time, until the lit spire's
 * tip stands inside the frame with a margin (Phase 5: hero and overview
 * re-framed with the spire standing). Unchanged where no spire is lit.
 */
async function withSpire(page: Page, name: string, v: { eye: V3; target: V3 }): Promise<{ eye: V3; target: V3 }> {
  const lit = (await shows(page).catch(() => [] as Show[])).find((m) => m.kind === 'skyline' && m.lit);
  if (!lit) {
    console.log(`  ${name}: no lit spire stands; the framing is unchanged`);
    return v;
  }
  let eye = v.eye;
  let pulled = 0;
  for (; pulled < 12; pulled++) {
    await frame(page, eye, v.target);
    const [x, y, z] = (await page.evaluate(`window.__palimpsest.project(${JSON.stringify(lit.tip)})`)) as number[];
    if (z < 1 && Math.abs(x) < 0.92 && y < 0.88) break;
    eye = lerp3(v.target, eye, 1.06);
  }
  if (pulled) console.log(`  ${name}: pulled back ${pulled} steps so the spire stands in the frame`);
  return { eye, target: v.target };
}

/** A framing pulled back along its line, 4% at a time, until `tip` projects inside the frame below its top margin. */
async function fitTip(page: Page, v: { eye: V3; target: V3 }, tip: V3): Promise<{ eye: V3; target: V3 }> {
  let eye = v.eye;
  for (let i = 0; i < 20; i++) {
    await frame(page, eye, v.target);
    const [x, y, z] = (await page.evaluate(`window.__palimpsest.project(${JSON.stringify(tip)})`)) as number[];
    if (z < 1 && Math.abs(x) < 0.92 && y < 0.9) break;
    eye = lerp3(v.target, eye, 1.04);
  }
  return { eye, target: v.target };
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

    async campus(page) {
      // The university (Phase 4 Tasks 34 to 37): from home, across the front quad from over the gate at dusk, close on a
      // hall's porch, the clock tower lit, and the observatory shut and open. CAMPUS_ONLY='home,quad,clock,observatory-open'
      // (the README's, set by a bare run) keeps only those. CAMPUS_VIEWS='[[[x,y,z],[x,y,z]], ...]' in the campus's own
      // frame (x from the gate toward the library, y over the street, z across) adds stills for the rounds. Written lean,
      // 1600 x 1000, like Phase 3's stills.
      await chrome(page, false);
      const only = process.env.CAMPUS_ONLY?.split(',');
      const want = (k: string): boolean => !only || only.includes(k);
      const at = await campusFrame(page);
      const shot = async (name: string, eye: V3, target: V3): Promise<void> => {
        await frame(page, eye, target);
        await page.waitForTimeout(1500);
        await frame(page, eye, target);
        await lean(page, name);
      };
      const home = await callDebug<{ home: { eye: V3; target: V3 } }>(page, 'd.limits()');
      if (want('home')) await shot('campus-home', home.home.eye, home.home.target);
      if (want('quad')) await shot('campus-quad', at(-30, 30, 10), at(60, 10, -4));
      if (want('hall')) await shot('campus-hall', at(92, 8, 36), at(66, 11, 54));
      if (want('terrace')) await shot('campus-terrace', at(-44, 5, -34), at(-10, 7, -2));
      if (want('library')) await shot('campus-library', at(104, 18, 8), at(181, 20, -1));
      // The clock tower at dusk on the campus's own clock (Phase 5: held at ten past ten at night, the lit dial's bloom
      // stood over the tower as a white disc).
      if (want('clock')) {
        // From the far side of the quad, with the low sun behind the camera (Phase 5: from the gate side its bloom stood
        // over the tower as a white disc).
        const target = at(97, 27, -56);
        const eye = at(150, 12, 2);
        await shot('campus-clock', eye, target);
      }
      if (want('above')) await shot('campus-above', at(40, 110, 30), at(62, 6, -6));
      // The observatory shut (a thin master), then open with the nets training and the master trusted (Task 36).
      if (want('observatory-shut') || want('observatory-open') || want('observatory-quad')) {
        await page.evaluate('window.__palimpsest.school({ training: false, masterTrusted: false, version: 0 })');
        if (want('observatory-shut')) await shot('observatory-shut', at(131, 11, 84), at(183, 14, 90));
        await page.evaluate('window.__palimpsest.school({ training: true, masterTrusted: true, version: 1 })');
        await page.waitForTimeout(7500);
        if (want('observatory-open')) await shot('observatory-open', at(131, 11, 84), at(183, 14, 90));
        if (want('observatory-quad')) await shot('observatory-quad', at(70, 13, 93), at(183, 13, 90));
        await page.evaluate('window.__palimpsest.school(null)');
        await page.waitForTimeout(6500);
      }
      // The library lit for the voyage the sample economy sails (Task 37): across the inner quad, then close on the bays.
      if (want('voyage')) await shot('campus-voyage', at(100, 12, 34), at(181, 17, -4));
      if (want('bays')) await shot('campus-bays', at(147, 9.5, 19), at(178, 10, -1));
      const extra = JSON.parse(process.env.CAMPUS_VIEWS ?? '[]') as [V3, V3][];
      for (const [i, [e, t]] of extra.entries()) await shot(`campus-${i}`, at(e[0], e[1], e[2]), at(t[0], t[1], t[2]));
    },

    async voyage(page) {
      // The library lighting for a voyage (Task 37), on the virtual clock: the sample economy's voyage paused for the
      // night, so the reading room stands dark; then it sails again and its bays light one after another down the room,
      // one for each genome racing, while the students cross the inner quad. Written as voyage.mp4 with a poster.
      await chrome(page, false);
      const at = await campusFrame(page);
      const live = await callDebug<{ voyage: Record<string, unknown> | null } | null>(page, 'd.campusLife()');
      if (!live?.voyage) throw new Error('capture: the sample economy has no voyage sailing on the campus');
      await page.evaluate(`window.__palimpsest.life(${JSON.stringify({ voyage: { ...live.voyage, status: 'paused' }, nets: [], graduates: [] })})`);
      await frame(page, at(96, 11, 40), at(181, 16, -4));
      await page.waitForTimeout(8000);
      const seconds = Number(process.env.VOYAGE_SECONDS ?? 11);
      await film(
        page,
        'voyage',
        Math.round(seconds * FPS),
        async (i, t) => {
          // A second of the dark room, then the ledger's state back: the voyage sails and the bays light.
          if (i === FPS) await page.evaluate('window.__palimpsest.life(null)');
          const k = easeSine(t);
          return { eye: lerp3(at(96, 11, 40), at(112, 12.5, 30), k), target: lerp3(at(181, 16, -4), at(181, 17, -2), k) };
        },
        false,
        Number(process.env.VOYAGE_POSTER ?? 0.9),
      );
      const lit = await callDebug<{ lit: number } | null>(page, 'd.campusLife()');
      console.log(`  voyage: ${lit?.lit ?? 0} bays lit at the end`);
    },

    async observatory(page) {
      // The observatory where the master net lives (Task 36), on the virtual clock: shut and dark with a thin master,
      // then the nets train with the master trusted, the shutters part over a lit slit and the telescope turns. Written
      // as observatory.mp4 with a poster.
      await chrome(page, false);
      const at = await campusFrame(page);
      await page.evaluate('window.__palimpsest.school({ training: false, masterTrusted: false, version: 0 })');
      await frame(page, at(131, 11, 84), at(183, 14, 90));
      await page.waitForTimeout(8000);
      const seconds = Number(process.env.OBSERVATORY_SECONDS ?? 12);
      try {
        await film(
          page,
          'observatory',
          Math.round(seconds * FPS),
          async (i, t) => {
            if (i === FPS) await page.evaluate('window.__palimpsest.school({ training: true, masterTrusted: true, version: 1 })');
            const k = easeSine(t);
            return { eye: lerp3(at(131, 11, 84), at(143, 13, 86), k), target: lerp3(at(183, 14, 90), at(183, 17, 90), k) };
          },
          false,
          Number(process.env.OBSERVATORY_POSTER ?? 0.85),
        );
        const o = await callDebug<{ open: number; lit: boolean } | null>(page, 'd.observatory()');
        console.log(`  observatory: open ${o?.open.toFixed(2)}, lit ${o?.lit}`);
      } finally {
        await page.evaluate('window.__palimpsest.school(null)');
      }
    },

    async 'graduate-tower'(page) {
      // The sample's graduate's tower on the collegiate root in its firm's quarter (Task 38), from its court.
      await openHash(page, '#/', 'body[data-route="city"]');
      await chrome(page, false);
      const qs = (await page.evaluate(() => fetch('/api/quarters').then((r) => r.json()))) as Quarter[];
      const grad = qs.flatMap((q) => q.towers.filter((t) => t.root === 'collegiate').map((t) => ({ q, t })))[0];
      if (!grad) throw new Error('capture: no graduate stands on the collegiate root');
      const o = QUARTER_OFFSETS_CAPTURE[grad.t.towerIndex ?? 0];
      const ox = grad.q.origin.x + o.x;
      const oz = grad.q.origin.z + o.z;
      await frame(page, [ox + 26, 11, oz + 40], [ox, 7.5, oz]);
      await page.waitForTimeout(1800);
      await frame(page, [ox + 26, 11, oz + 40], [ox, 7.5, oz]);
      await lean(page, 'graduate-tower');
      await chrome(page, true);
    },

    async 'school-screens'(page) {
      // The school's screens (Phase 4 Tasks 30 to 33) on the sample economy, each over the city as it opens.
      const table = this as unknown as Record<string, (p: Page) => Promise<void>>;
      for (const name of ['school', 'school-net', 'autonomy-settings', 'brief-autonomy', 'agent-graduate']) await table[name](page);
    },

    async school(page) {
      // The school: the seven nets with their scores, intervals and n, each against its baseline, or why it has none.
      await openHash(page, '#/school', '.sheet.school .net-row');
      await lean(page, 'school', true);
      await scrolledStills(page, '.sheet.school', 'school');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'school-net'(page) {
      // One net's page: every version as a point with its interval, the baseline ruled across.
      await openHash(page, '#/school/nets/appraiser-pass', '.sheet.school[data-page="net"] svg.netplot');
      await lean(page, 'school-net', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'autonomy-settings'(page) {
      // Settings' Autonomy section: every pair asked, granted, suspended or taken back, with the master's agreement.
      await openHash(page, '#/settings', '.sheet.settings .set-sec.autonomy .grant-entry');
      await toSheetTop(page, '.sheet.settings .set-sec.autonomy');
      await lean(page, 'autonomy-settings', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'brief-autonomy'(page) {
      // The brief with the city's ask: the master agreed often enough on README gap proposals for the harbor.
      await openHash(page, '#/brief', '.sheet.brief .brief-item[data-item^="autonomy:"]');
      await toSheetTop(page, '.sheet.brief .brief-item[data-item^="autonomy:"]');
      await lean(page, 'brief-autonomy', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'agent-graduate'(page) {
      // Ada Quarry's page, the sample's graduate: where it came from, its sealed race against its base.
      await openHash(page, '#/agents/grad-qwen25c7-1', '.sheet.agentpage .agent-school[data-school="graduate"]');
      // Flush with the sheet's head: with a margin, the last line of the section above showed as a cut sliver under it.
      await toSheetTop(page, '.sheet.agentpage .agent-lineage', 0);
      await lean(page, 'agent-graduate', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async ride(page) {
      // The ride up the outside of a tower (Task 35): the harbor tower from its datum to the roof, the car on its rail
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
        keepFrames(dir, 'ride');
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
      await scrolledStills(page, '.sheet.brief', 'brief');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'audit-page'(page) {
      // The harbor README audit's own page: the claims, each verdict with its evidence at file and line, the proposals.
      // Written as audit.webp; the shot named audit is the clip of the kumo audit ending.
      const audits = (await page.evaluate(() => fetch('/api/audits?repo=tidewater%2Fharbor-ledger').then((r) => r.json()))) as Array<{ id: string; status: string }>;
      const done = audits.find((a) => a.status === 'done');
      if (!done) throw new Error('the economy has no finished harbor audit');
      await openHash(page, `#/audits/${done.id}`, '.sheet.auditpage .claim');
      await page.waitForTimeout(600);
      await lean(page, 'audit', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'district-audit'(page) {
      // The harbor district's page at its README audit (Phase 3 Task 12): the lead with its counts, then each claim
      // with its verdict, its evidence at file and line, and the job proposed from it with its state.
      await openHash(page, `#/repos/${tall.repo}`, '.sheet.district .district-audit .audit-claims .claim');
      await page.locator('.sheet.district .district-audit').first().evaluate((sec) => sec.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(600);
      await lean(page, 'district-audit', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'job-scope'(page) {
      // A proposal's own page (Phase 3 Task 13): why the city proposes it (the claim, its verdict and its evidence)
      // and the scope it may touch, which can be edited while it is proposed.
      const audits = (await page.evaluate(() => fetch('/api/audits?repo=tidewater%2Fharbor-ledger').then((r) => r.json()))) as Array<{ id: string; status: string }>;
      const done = audits.find((a) => a.status === 'done');
      if (!done) throw new Error('the economy has no finished harbor audit');
      const view = (await page.evaluate((id) => fetch(`/api/audits/${id}`).then((r) => r.json()), done.id)) as { proposals: Array<{ id: string; title: string; status: string }> };
      const job = view.proposals.find((j) => j.status === 'proposed' && /UBL/.test(j.title)) ?? view.proposals.find((j) => j.status === 'proposed');
      if (!job) throw new Error('the harbor audit has no proposal waiting');
      await openHash(page, `#/jobs/${job.id}`, '.sheet.jobpage .job-why');
      await toSheetTop(page, '.sheet.jobpage .job-why').catch(() => {});
      await lean(page, 'job-scope', true);
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async audit(page) {
      // The kumo README audit ending (Phase 3), 30 s at the clock's speed over the job board: the audit reads on, answers
      // 400 script seconds in (20 s at speed 20), and its two proposals appear on the board under its heading. On a
      // clock of its own that moves only the audit (main leaves the audit off the economy's clock when this shot is
      // named), so the construction the other clips film stays where it stands.
      const { economyClock } = await import('../engine/market/sample-economy.js');
      const clock = economyClock({ now: () => Date.now(), speed: 20, runs: false, school: false });
      try {
        await openHash(page, '#/jobs', '.sheet .sec-proposed');
        await toSheetTop(page, '.sheet .sec-proposed').catch(() => {});
        const seconds = Number(process.env.AUDIT_SECONDS ?? 30);
        await film(
          page,
          'audit',
          Math.round(seconds * FPS),
          async () => {
            clock.tick(1000 / FPS);
            await clock.idle();
            return SCREENS;
          },
          false,
          Number(process.env.AUDIT_POSTER ?? 0.85),
        );
        const kumo = (await page.evaluate(() => fetch('/api/audits?repo=hoshi%2Fkumo').then((r) => r.json()))) as Array<{ status: string }>;
        const shown = await page.locator('.sec-proposed .audit-group[data-repo="hoshi/kumo"] .prop-line').count();
        console.log(`  audit: kumo ${kumo[0]?.status ?? 'none'}, ${shown} proposals on the board`);
      } finally {
        clock.stop();
      }
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
      // Close enough that the festoon's bulbs read as bulbs (Phase 5: the Phase 3 still stood too far off).
      await frame(page, [d.origin.x - 24, mid + 3, d.origin.z + 29], [d.origin.x, mid - 1, d.origin.z]);
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
      // From the home framing, so the lift runs up the face the city is seen from, with the low sun behind the camera.
      const home = (await page.evaluate('window.__palimpsest.limits().home')) as { eye: V3; target: V3 };
      await frame(page, home.eye, home.target);
      if (!(await page.evaluate((r) => (window as unknown as { __palimpsest: { ride(k: string): boolean } }).__palimpsest.ride(r), repo))) throw new Error('the ride did not start');
      await page.evaluate('window.__palimpsest.rideHold(true)');
      const r = (await page.evaluate('window.__palimpsest.riding()')) as { stops: Array<{ t: number; dossier: boolean }> };
      // RIDE_DOSSIER_STOP picks which dossier stop to try first (default the first: lower on the tower); the still is
      // taken at the first moment, at that stop or the next, with the sun out of the frame (Phase 5: framed off the sun).
      const dossierStops = r.stops.filter((x) => x.dossier);
      const first = Math.min(dossierStops.length - 1, Number(process.env.RIDE_DOSSIER_STOP ?? 0));
      if (first < 0) throw new Error('the harbor ride has no dossier stop');
      const order = [...dossierStops.slice(first), ...dossierStops.slice(0, first)];
      let at = order[0].t + 0.8;
      seek: for (const stop of order) {
        for (const off of [0.8, 0.4, 1.4, 2.0]) {
          await page.evaluate(`window.__palimpsest.rideSeek(${stop.t + off})`);
          await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
          if (!(await sunInFrame(page))) {
            at = stop.t + off;
            break seek;
          }
        }
      }
      console.log(`  ride-dossier at ${at.toFixed(1)} s${(await sunInFrame(page)) ? ' (no moment off the sun; the first stop)' : ''}`);
      await page.evaluate(`window.__palimpsest.rideSeek(${at})`);
      await page.waitForTimeout(1600);
      await page.evaluate(`window.__palimpsest.rideSeek(${at})`);
      await lean(page, 'ride-dossier', true);
      await page.evaluate('window.__palimpsest.ride(null)');
      await page.waitForTimeout(4000);
    },

    async week(page) {
      // The week tour (Phase 3 Task 17): the camera's walk through the economy's week, exchange to exchange, its
      // captions at the lower left. Forty-five seconds: the walk's ninety on the virtual clock at twice its pace,
      // encoded as lean as the ride (an mp4, and the avif the README plays inline).
      // The running head and the plates stand aside (Phase 5: no chrome over the city); the captions are the walk's own.
      await chrome(page, false);
      const ok = (await page.evaluate(`window.__palimpsest.tourStart(${JSON.stringify(await seededWeek(page, seededAt))})`)) as boolean;
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
      // Its poster is the week-poster shot's, framed off the sun.
      encodeClip(dir, 'week', false, undefined, fps, { size: '960:600', crf: 32, film: true });
      keepFrames(dir, 'week', fps);
      await page.evaluate('window.__palimpsest.tourHold(false)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3000);
    },

    async 'week-poster'(page) {
      // The week's poster (Phase 5): a stop on the tour framed off the sun, so the low sun's bloom stays out of it, at
      // the moment off the sun nearest WEEK_POSTER (0.45 of the walk).
      await chrome(page, false);
      if (!((await page.evaluate(`window.__palimpsest.tourStart(${JSON.stringify(await seededWeek(page, seededAt))})`)) as boolean)) throw new Error('the week has no tour to walk');
      await page.evaluate('window.__palimpsest.tourHold(true)');
      const { length } = (await page.evaluate('window.__palimpsest.tour()')) as { length: number };
      const want = Number(process.env.WEEK_POSTER ?? 0.45) * length;
      const times: number[] = [];
      for (let t = length * 0.1; t <= length * 0.9; t += 0.5) times.push(t);
      times.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
      let at = want;
      for (const t of times) {
        await page.evaluate(`window.__palimpsest.tourSeek(${t})`);
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        if (!(await sunInFrame(page))) {
          at = t;
          break;
        }
      }
      console.log(`  week-poster at ${at.toFixed(1)} of ${length.toFixed(1)} s`);
      await page.evaluate(`window.__palimpsest.tourSeek(${at})`);
      await page.waitForTimeout(1800);
      await page.evaluate(`window.__palimpsest.tourSeek(${at})`);
      await lean(page, 'week-poster');
      await page.evaluate('window.__palimpsest.tourHold(false)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3000);
    },

    async street(page) {
      // The life shot's street still on its own (Phase 5 ruling 17: in the README only if the controller agrees).
      const table = this as unknown as Record<string, (p: Page) => Promise<void>>;
      await withEnv('LIFE_ONLY', 'street', () => table.life(page));
    },

    async 'people-follow'(page) {
      // The people shot's follow still on its own (ruling 17, as street).
      const table = this as unknown as Record<string, (p: Page) => Promise<void>>;
      await withEnv('PEOPLE_ONLY', 'follow', () => table.people(page));
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
      // A person's height on the pavement, clear of the street trees and the shopfront canopies (Phase 5 audit: the eye
      // stood in a tree), looking down the street to the Beaux-Arts root and its tower.
      await shot('street', [[188.5, 1.65, -128], [203, 3.2, -20]]);
      if (want('junction')) {
        // The junction near the plaza with the most cars standing at its lines, seen from a corner above the kerb.
        const q = await call<Array<{ x: number; z: number; held: number }>>('d.ambientQueues([280, -120], 130)');
        const j = q[0] ?? { x: 280, z: -120, held: 0 };
        console.log(`  junction ${j.x},${j.z} with ${j.held} held`);
        // Over the road's own line, not the corner: an eye inside a corner block drew the block's back faces as a blank
        // (Phase 5 audit: a flat navy rectangle over three quarters of the frame).
        await shot('junction', [[j.x + 3, 5, j.z + 34], [j.x - 2, 0.5, j.z - 4]]);
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
      // The market's floors over the datum (CAPTURE_ECONOMY=1): the harbor tower's earned run and its scar, the
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
      for (const [name, eye, target] of [...shotsOf(tall, 'harbor'), ...shotsOf(kumo, 'kumo')]) await still(page, name, eye, target);
      await chrome(page, true);
      for (const [d, tag] of [[tall, 'harbor'], [kumo, 'kumo']] as const) {
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
      // burning, then the harbor run's frame curing into its floor, the PR merging, the windows lighting row by row and
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

      // The harbor run: inspected and passed at 370 script seconds, so its frame cures into the floor and its PR waits.
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
      // The market at work (CAPTURE_ECONOMY=live), at the exchange: the tote board over the portico with a card lit for
      // each job taking bids and a lamp under it for each bid, the bidders queued at the foot of the stair, the fountain
      // and the forecourt's lamps. From the old 600 m the board and the queue read as lantern points (Phase 5 audit), so
      // it stands about 100 m off. MARKET_VIEW='[[eye],[target]]' overrides the framing.
      await page.waitForFunction(() => ((window as unknown as { __palimpsest: { exchange(): { slots: Array<{ state: string }> } | null } }).__palimpsest.exchange()?.slots ?? []).some((x) => x.state === 'bidding'), null, { timeout: 15_000 }).catch(() => {});
      const board = await callDebug<Array<{ state: string; lamps: number }>>(page, 'd.exchange()?.slots ?? []');
      console.log(`  market-overview: ${board.filter((x) => x.state === 'bidding').length} cards lit, ${board.reduce((a, x) => a + x.lamps, 0)} lamps`);
      // The bidders on their way: the people's clock moved on until every figure on a live bid trip stands in the queue
      // at the hall's stair (as tools/perf.ts stages exchange-600), at most ten minutes on.
      type Fig = { stage: string; position: V3; tripId: string | null; reason: string | null };
      const atDoors = (fs: Fig[]): number => fs.filter((f) => f.tripId !== null && f.reason === 'bid' && f.stage === 'idle' && f.position[0] > -2 && f.position[0] < 30 && f.position[2] > 20 && f.position[2] < 32).length;
      const live = (await page.evaluate(() => fetch('/api/live').then((r) => (r.ok ? r.json() : { trips: [] })).catch(() => ({ trips: [] })))) as { trips?: Array<{ reason: string; endedAt: string | null }> };
      const bidding = (live.trips ?? []).filter((t) => t.reason === 'bid' && !t.endedAt).length;
      await callDebug(page, 'd.peopleHold(true)');
      let queued = atDoors(await callDebug<Fig[]>(page, 'd.persons()'));
      for (let t = 0; t < 600 && queued < bidding; t += 20) {
        await callDebug(page, 'd.peopleSkip(20)');
        queued = atDoors(await callDebug<Fig[]>(page, 'd.persons()'));
      }
      console.log(`  market-overview: ${queued} of ${bidding} bidders in the queue at the doors`);
      const [eye, target] = (process.env.MARKET_VIEW ? JSON.parse(process.env.MARKET_VIEW) : MARKET_VIEW_DEFAULT) as [V3, V3];
      await chrome(page, false);
      try {
        await still(page, 'market-overview', eye, target);
      } finally {
        await callDebug(page, 'd.peopleHold(false)');
      }
    },

    async screens(page) {
      // The market's screens (CAPTURE_ECONOMY=live), each over the city as it opens: the job board, the harbor job
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
      const running = await runningHarbor(page);
      await openHash(page, `#/jobs/${running.id}`, '.jobpage .job-award');
      await shoot(page, 'job');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'run-log'(page) {
      // The live run's first view: its stage, its figures and the transcript's tail together.
      const running = await runningHarbor(page);
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
      // A fresh reading of the sample plan, so the meters read as they do in use: the one reading Settings shows too.
      await freshReading();
      await openHash(page, '#/treasury', '.sheet.treasury .meter');
      await shoot(page, 'treasury');
      await openHash(page, '#/', 'body[data-route="city"]');
    },

    async 'construction-clip'(page) {
      // Forty seconds of the economy's clock at speed 20 (CAPTURE_ECONOMY=live), one tick a frame: the harbor run's
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
      // From the plaza's city side (the lifecycle's bearing), drifting a little round the site as it works. The poster is
      // taken while the frame goes up (0.2): later, the guild's searchlights wash the frame white.
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
        Number(process.env.CONSTRUCTION_POSTER ?? 0.2),
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
        const legs = (await callDebug<Array<{ mode: string }>>(page, `d.vehicleTrip(${JSON.stringify(tFrom)}, ${JSON.stringify(tTo)})`).catch(() => [])).map((l) => l.mode);
        console.log(`  tram trip legs: ${legs.join(' > ')}`);
        // The tram leg: filmed with one walker, kept only if she boarded the tram within the clip (the people system's
        // trip state); otherwise its frames are dropped and the next walker is tried, up to MAX_RETRIES more.
        let tramOk = false;
        for (const [attempt, id] of TRAM_WALKERS.slice(0, MAX_RETRIES + 1).entries()) {
          for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
          n = 0;
          const seen: Array<FigureProbe | null> = [];
          if (attempt) console.log(`  ${TRAM_WALKERS[attempt - 1]} never boarded the tram; retrying with ${id} (retry ${attempt} of ${MAX_RETRIES})`);
          await sendPerson(page, id, tFrom, tTo);
          await callDebug(page, 'd.peopleSkip(8)');
          await follow(id, 4);
          // On the platform, as the tram comes in: from up the platform, looking back at her. The eye stands 11 m up the
          // platform and 0.6 m to her right (final review I3: 1.8 m further out from the shelter than it was, along the same
          // line), so the blank wall behind the shelter leaves the frame and the street and the far platform come in. Two
          // metres further back stood the eye behind the platform's tree (Task 32's probe).
          const w = await until(id, (x) => x.mode === 'tram' && x.stage === 'wait');
          if (w) {
            const f0 = await until(id, (x, v) => x.stage !== 'wait' || (!!v && apart(x, v) < 90 && v.speed > 0.5), 1200);
            const at = f0 ?? w;
            const eye = aroundPerson(at.position, at.heading, COMMUTE_EYE.along, COMMUTE_EYE.out, at.position[1] + 2.4);
            const target = aroundPerson(at.position, at.heading, -1.5, COMMUTE_EYE.out - 2.1, at.position[1] + 1.2);
            for (let i = 0; i < Math.round(6 * FPS); i++) await shoot1(eye, target);
            // Riding: beside the tram, keeping pace with it.
            const r = await until(id, (x) => x.stage === 'ride', 240);
            seen.push(r);
            if (r) {
              await callDebug(page, 'd.peopleSkip(4)');
              await follow(id, 5, (f, v) => (v ? [aroundPerson(v.position, v.heading, -20, 1.5, v.position[1] + 7), aroundPerson(v.position, v.heading, 10, 0, v.position[1] + 1.5)] : followView(f)));
              seen.push(await person(page, id));
            }
          }
          if (boardedTram(seen)) {
            tramOk = true;
            break;
          }
        }
        if (!tramOk) throw new Error(`commute: no walker boarded the tram within the clip after ${MAX_RETRIES + 1} attempts (${TRAM_WALKERS.slice(0, MAX_RETRIES + 1).join(', ')}); not writing a clip without its tram leg`);
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
      // The poster: the tram drawn up at the platform with the people waiting to board (final review I3), frame 298 of 735.
      encodeClip(dir, 'commute', false, Number(process.env.COMMUTE_POSTER ?? 298 / 734));
      keepFrames(dir, 'commute');
    },

    async hero(page) {
      // The whole sample city at dusk from above the rooftops, the sunlit faces turned to the eye.
      // Pulled back, if it must be, until the lit spire on the tallest tower stands inside the frame.
      await chrome(page, false);
      const v = await withSpire(page, 'hero', HERO);
      await still(page, 'hero', v.eye, v.target);
    },

    async 'hero-rise'(page) {
      // The film's opening (Phase 5 ruling 9): the camera rises from low over the streets to the hero framing, the city
      // at dusk opening out below. Nine seconds, moving for the first 85% and holding on the hero.
      await chrome(page, false);
      const end = await withSpire(page, 'hero-rise', HERO);
      const eye0: V3 = [lerp(end.target[0], end.eye[0], 0.94), 12, lerp(end.target[2], end.eye[2], 0.94)];
      const target0: V3 = [end.target[0], end.target[1] * 0.45, end.target[2]];
      await record(page, {
        name: 'hero-rise',
        seconds: Number(process.env.HERO_RISE_SECONDS ?? 9),
        posterAt: 1,
        at(t) {
          const k = easeSine(Math.min(1, t / 0.85));
          return { eye: lerp3(eye0, end.eye, k), target: lerp3(target0, end.target, k) };
        },
      });
    },

    async stills(page) {
      await chrome(page, false);
      // One whole tower, root to crown: the pagoda, lit by the low sun, the rest of the skyline behind it.
      // Pulled back along its line until its crown stands inside the frame (Phase 5: the crown was cut at the top edge);
      // the tallest tower behind it may run out of the top. The job sites stand aside for it: a live inspection's
      // searchlight glint on the Gothic tower burnt out a corner of the frame.
      const k = pagoda.origin;
      const whole = await fitTip(page, { eye: [k.x - 480, 30, k.z + 120], target: [k.x, pagodaLay.top * 0.5, k.z] }, [k.x, pagodaLay.top + 6, k.z]);
      await page.evaluate('window.__palimpsest.showSites(false)');
      await page.waitForTimeout(600);
      await still(page, 'tower', whole.eye, whole.target);
      await page.evaluate('window.__palimpsest.showSites(true)');
      const o = gothic.origin;
      await still(page, 'root', [o.x - 58, 6, o.z + 66], [o.x, gothicLay.rootHeight * 0.55, o.z]);
      const t = tall.origin;
      // From just below the top, so the datum band and the crown stand against the sky.
      await still(page, 'datum', [t.x - 90, tallLay.datumY - 27, t.z + 80], [t.x, tallLay.datumY - 17, t.z]);
    },

    async overview(page) {
      // The city from home with every district's name plate, and nothing else over it: no brief, no running head,
      // no notice (Phase 5 audit: the city is the subject, not a wallpaper beside a page).
      await chrome(page, false, { plates: true });
      const v = await withSpire(page, 'overview', OVERVIEW);
      await still(page, 'overview', v.eye, v.target);
      await chrome(page, true);
    },

    async palette(page) {
      // Find (Cmd+K) as a first-time user meets it by keyboard: opened over the city, a query typed, its results ranked.
      // PALETTE_QUERY overrides the query.
      await chrome(page, false, { plates: true });
      await chrome(page, true);
      await frame(page, OVERVIEW.eye, OVERVIEW.target);
      await page.waitForTimeout(600);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
      await page.waitForSelector('.palette .palette-input', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.palette .palette-row', { timeout: 10_000 });
      await page.keyboard.type(process.env.PALETTE_QUERY ?? 'harb', { delay: 90 });
      await page.waitForTimeout(900);
      await page.waitForSelector('.palette .palette-row', { timeout: 5000 });
      await shoot(page, 'palette');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    },

    async 'overview-clear'(page) {
      // The overview in clear air (Phase 5 Decision 5: a clear-air dusk, the haze at 40% of the home value). The haze
      // control is the city track's (Task 6, the debug handle's haze(k), null for the home value); a build without it
      // cannot take this still and says so.
      if (!(await page.evaluate('typeof window.__palimpsest.haze === "function"'))) {
        console.log('  overview-clear: this build has no haze control (city Task 6); not shot');
        return;
      }
      await chrome(page, true);
      await page.evaluate('window.__palimpsest.haze(0.4)');
      try {
        const v = await withSpire(page, 'overview-clear', OVERVIEW);
        await still(page, 'overview-clear', v.eye, v.target);
      } finally {
        await page.evaluate('window.__palimpsest.haze(null)');
      }
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
      await freshReading();
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

    async 'profile-loop'(page) {
      // The profile clip's loop (Phase 5 ruling 10): the flyover's arc from a third of the way along to its end and
      // back, eased to a stop at each end, over PROFILE_LOOP_PERIOD seconds (11), then one more second along the
      // same path. The camera at 11 + s stands where it stood at s, so the film tool's one-second dissolve from the
      // tail into the head blends only what moved on the city's clock, never two framings.
      await chrome(page, false);
      const period = Number(process.env.PROFILE_LOOP_PERIOD ?? PROFILE.seconds);
      const seconds = period + 1;
      const from = Number(process.env.PROFILE_LOOP_FROM ?? 0.35);
      await record(page, {
        name: 'profile-loop',
        seconds,
        framesOnly: true,
        at(t) {
          // record() hands t as frame / (frames - 1): back to seconds on the frame grid, so frame 11 * FPS + j stands
          // exactly where frame j did.
          const s = (t * (Math.round(seconds * FPS) - 1)) / FPS;
          const k = profileLoopArc(s, period, from);
          const e = easeSine(k);
          const a = lerp(FLY.a0, FLY.a1, e);
          const r = lerp(FLY.r0, FLY.r1, e);
          const eye: V3 = [FLY.cx + Math.cos(a) * r, lerp(FLY.y0, FLY.y1, e), FLY.cz + Math.sin(a) * r];
          const target: V3 = [FLY.cx, lerp(FLY.ty0, FLY.ty1, e), FLY.cz];
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
// street and people-follow stay out unless the controller agrees (Phase 5 ruling 17); the audit clip runs on its own
// clock, so its place in the order moves nothing the others show.
const README_SHOTS = ['hero', 'stills', 'overview', 'palette', 'market-overview', 'inspector', 'repos', 'settings', 'screens', 'brief', 'audit-page', 'district-audit', 'job-scope', 'school-screens', 'campus', 'graduate-tower', 'voyage', 'observatory', 'spire', 'revival', 'ribbon', 'ride-dossier', 'ride', 'week', 'week-poster', 'flyover', 'rise', 'construction-clip', 'audit', 'commute', 'diagrams', 'school-empty'];

/** The market overview's framing: the exchange's front from about 100 m, the board, the stair and the forecourt (MARKET_VIEW overrides). */
const MARKET_VIEW_DEFAULT: [V3, V3] = [[64, 32, 124], [4, 20, 10]];

/** Framings tuned by eye in the quality rounds (see the probe shot), on the sample city; followCity fits them to the city served. */
let HERO: { eye: V3; target: V3 } = { eye: [700, 70, 700], target: [0, 170, 80] };
let OVERVIEW: { eye: V3; target: V3 } = { eye: [540, 380, 960], target: [-40, 70, 0] };
/** Behind an open sheet: the whole skyline set in the pane right of the sheet (pane-framing.ts); followCity derives it. */
let SCREENS: { eye: V3; target: V3 } = { eye: [-700, 90, 520], target: [160, 150, -200] };
/** How much farther back than home the screens' framing stands, so the skyline's breadth fits the pane. */
const SCREENS_BACK = Number(process.env.SCREENS_BACK ?? 1.35);
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
  // The sheets stand clamp(600px, 47vw, 760px) wide on the left (screens.css --sheet-w): the city shows right of them.
  const sheetW = Math.min(760, Math.max(600, 0.47 * VIEWPORT.width));
  SCREENS = paneFraming(lim.home, sheetW / VIEWPORT.width, 1, 36, aspect, SCREENS_BACK);
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
  const wanted = readme ? [...README_SHOTS] : process.argv.slice(2);
  if (readme) {
    process.env.CAPTURE_ECONOMY ??= 'live';
    process.env.RIDE_ONLY ??= 'clip';
    process.env.CAMPUS_ONLY ??= 'home,quad,clock';
  }
  // The eight diagram images are drawn by tools/diagrams.ts, into the same place as everything else.
  if (wanted.includes('diagrams')) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CAPTURE_WRITE_MEDIA;
    if (WRITE_MEDIA) env.CAPTURE_WRITE_MEDIA = '1';
    else env.CAPTURE_OUT = MEDIA;
    const r = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', join(ROOT, 'tools', 'diagrams.ts')], { stdio: 'inherit', env, cwd: ROOT });
    if (r.status !== 0) throw new Error(`capture: the diagrams failed (exit ${r.status})`);
    wanted.splice(wanted.indexOf('diagrams'), 1);
    if (wanted.length === 0) {
      console.log(`Wrote to ${MEDIA}`);
      return;
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-capture-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(MEDIA, { recursive: true });

  // CAPTURE_CITY=tall seeds the same repos in a working developer's shape (four short towers, two at the cap), for probes.
  seededAt = Date.now();
  await seedSample(seededAt, process.env.CAPTURE_CITY === 'tall' ? SAMPLE_TALL : SAMPLE);
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
    await seedEconomy(seededAt, { holdSale: !!process.env.CAPTURE_HOLD_SALE });
  }
  // Every gh and git call goes to the sample's stand-in: the Repos screen lists only fictional repos.
  const { setRunner } = await import('../engine/exec.js');
  setRunner(sampleGh());
  const { startServer } = await import('../engine/server.js');
  let server = await startServer({ port: PORT, claudeSettingsPath });
  // The engine's own start takes the university's plot (Phase 4 Task 1); startServer alone does not, so it is taken here.
  (await import('../engine/school/campus.js')).ensureCampus();
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
    // The audit clip ends the kumo audit on a clock of its own; the economy's leaves it reading for that shot.
    economy = economyClock({ now: () => Date.now(), speed: 20, fail, sell: process.env.CAPTURE_HOLD_SALE ? 5 : undefined, audit: !wanted.includes('audit') });
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
      // The empty school is shot last, on a fresh home of its own (below).
      if (name === 'school-empty') continue;
      if (!all[name]) throw new Error(`unknown shot ${name}`);
      await all[name](page);
    }
    if (wanted.includes('school-empty')) {
      // The school on a fresh home with no repos (the economy's is never empty), as the ui-test reads it: every net
      // thin with its cause, no arena, no voyage, no graduate, and nothing drawn. A second engine on the same port.
      await page.close();
      await server.close();
      process.env.PALIMPSEST_HOME = join(tmp, 'home-empty');
      server = await startServer({ port: PORT, claudeSettingsPath });
      const empty = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
      empty.on('pageerror', (e) => errors.push(String(e)));
      empty.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await empty.goto(`http://127.0.0.1:${PORT}/?fixed-quality&debug#/school`);
      await empty.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 60_000 });
      await empty.waitForSelector('.sheet.school .net-row[data-status="thin"]', { timeout: 15_000 });
      // The morning's line on a fresh home folds onto its mark after a few seconds (notices.ts NOTICE_MS): the page
      // is shot as it reads once it has, and the city beside it framed on the skyline, not a street canyon.
      await frame(empty, SCREENS.eye, SCREENS.target);
      await empty.waitForTimeout(7500);
      await frame(empty, SCREENS.eye, SCREENS.target);
      await lean(empty, 'school-empty', true);
    }
    if (errors.length) console.log(`console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Wrote to ${MEDIA}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
