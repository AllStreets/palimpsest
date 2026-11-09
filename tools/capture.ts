/**
 * README and profile media, captured frame by frame from the real app.
 *
 * Starts its own engine in-process on port 4789 with a temp data home (never
 * the real engine on 4770), seeds fictional repos, opens the built UI in
 * Chromium on the GPU at 2x density, and drives the camera through the app's
 * own debug handle (`window.__palimpsest.view`). Every frame is set
 * explicitly and rendered before its screenshot, so the clips never drop or
 * repeat a frame. Frames are downscaled and encoded with ffmpeg.
 *
 *   npm run build
 *   node --no-warnings --import tsx tools/capture.ts [shots...]
 *
 * Shots: hero, stills, flyover, rise, probe (default: hero stills flyover rise).
 * Options (env): CAPTURE_FPS=30, CAPTURE_DPR=2, CAPTURE_KEEP=1 keeps the raw frames,
 * PROBE='[[eye],[target]]' for one quick still in the probe shot.
 *
 * Output goes to docs/media/. Re-run it whenever the city changes (construction,
 * the inspector), and add a shot here for each new thing worth showing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District, Repo, RootStyle, TowerSpec } from '../shared/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const MEDIA = join(ROOT, 'docs', 'media');
const PORT = 4789;
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FPS = Number(process.env.CAPTURE_FPS ?? 30);
const DPR = Number(process.env.CAPTURE_DPR ?? 2);
// 16:10, the whole window: it fits the 800x500 profile card with nothing cropped.
const VIEWPORT = { width: 1600, height: 1000 };

type V3 = [number, number, number];

// ---------------------------------------------------------------- seeding

interface SeedRepo {
  fullName: string;
  root: RootStyle;
  slot: number;
  commits: number;
}

// Fictional repos only. Media must never show anyone's real or private repos.
const SEED: SeedRepo[] = [
  { fullName: 'tidewater/harbor-ledger', root: 'beauxarts', slot: 0, commits: 52 },
  { fullName: 'kestrel/fieldnotes', root: 'chicago', slot: 1, commits: 30 },
  { fullName: 'lantern/assay-kit', root: 'gothic', slot: 2, commits: 44 },
  { fullName: 'ferro/quarry', root: 'roman', slot: 3, commits: 22 },
  { fullName: 'hoshi/kumo', root: 'pagoda', slot: 4, commits: 38 },
  { fullName: 'marlow/tidepool', root: 'chicago', slot: 5, commits: 64 },
  { fullName: 'orrery/almanac', root: 'beauxarts', slot: 6, commits: 18 },
  { fullName: 'saltmarsh/ferry', root: 'gothic', slot: 7, commits: 34 },
];

async function seed(): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { foundingFloors } = await import('../engine/history.js');
  const db = openDb();
  const start = Date.parse('2024-03-01T09:00:00Z');
  for (const s of SEED) {
    const commits = Array.from({ length: s.commits }, (_, i) => ({
      sha: `${s.slot}${i.toString(16).padStart(39, '0')}`,
      at: new Date(start + i * 31 * 3600_000 + s.slot * 7200_000).toISOString(),
      author: i % 3 === 0 ? 'Ada' : i % 3 === 1 ? 'Ben' : 'Cy',
      subject: `Change ${i + 1}`,
      body: i > s.commits * 0.7 || i % 9 === 4 ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
      lines: 40 + ((i * 53 + s.slot * 17) % 520),
    }));
    const floors = foundingFloors(s.fullName, commits, []);
    const at = new Date(start + s.slot * 1000).toISOString();
    const repo: Repo = {
      fullName: s.fullName,
      private: false,
      defaultBranch: 'main',
      language: 'TypeScript',
      description: 'sample',
      connected: true,
      pushMode: false,
      root: s.root,
      slot: s.slot,
      status: 'ready',
      error: null,
      connectedAt: at,
      analyzedAt: at,
    };
    const tower: TowerSpec = {
      id: `${s.fullName}#founding`,
      repo: s.fullName,
      kind: 'founding',
      root: s.root,
      floors,
      datumIndex: floors.length,
    };
    db.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(s.fullName, JSON.stringify(repo));
    db.prepare('INSERT INTO towers (repo, json) VALUES (?, ?)').run(s.fullName, JSON.stringify(tower));
  }
}

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
 * From 2x PNG frames: a full-quality 1600x1000 H.264 MP4 (yuv420p), an animated
 * AVIF at 1280x800 for the README, an 800x500 AVIF with a WebP fallback for the
 * GitHub profile card, and a 560x350 GIF fallback.
 */
function encode(dir: string, name: string): void {
  const input = ['-framerate', String(FPS), '-i', join(dir, 'f%04d.png')];
  const mp4 = join(MEDIA, `${name}.mp4`);
  ff([...input, '-vf', 'scale=1600:1000:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
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
  execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '72', '-m', '6', '-kmax', '15', '-d', String(Math.round(1000 / 15)), ...frames.map((f) => join(small, f)), '-o', webp], {
    stdio: 'inherit',
  });
  const gif = join(MEDIA, `${name}.gif`);
  // A moving camera changes every pixel, so the GIF fallback is kept small: 560x350, 10 fps, 96 colours.
  ff(['-i', mp4, '-vf', 'fps=10,scale=560:350:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', gif]);
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
  const path = join(MEDIA, `${name}.png`);
  await page.screenshot({ path });
  // The README shows these at about 1000 px wide; keep the 2x original as is, and a 1600 px JPEG-quality PNG is too big, so also write a WebP.
  execFileSync('cwebp', ['-q', '86', '-m', '6', path, '-o', join(MEDIA, `${name}.webp`)], { stdio: 'ignore' });
  console.log(`  ${name}.png ${mb(path)}, .webp ${mb(join(MEDIA, `${name}.webp`))}`);
}

// ---------------------------------------------------------------- shots

function shots(city: District[]): Record<string, (page: Page) => Promise<void>> {
  const by = (repo: string): District => {
    const d = city.find((c) => c.repo === repo);
    if (!d) throw new Error(`no district ${repo}`);
    return d;
  };
  const cx = city.reduce((a, d) => a + d.origin.x, 0) / city.length;
  const cz = city.reduce((a, d) => a + d.origin.z, 0) / city.length;
  const hero = by('marlow/tidepool');
  const heroLay = layoutTower(hero.tower);

  return {
    async probe(page) {
      // One still per [eye, target] pair, written to docs/media/probe-N.png for framing new shots.
      const views = JSON.parse(process.env.PROBE ?? '[[[600,160,700],[0,80,0]]]') as [V3, V3][];
      for (const [i, [eye, target]] of views.entries()) await still(page, `probe-${i}`, eye, target);
    },

    async hero(page) {
      // Low over the river of streets, looking across the founding towers into the dusk.
      await still(page, 'hero', [820, 50, 90], [-60, 140, -30]);
    },

    async stills(page) {
      const o = hero.origin;
      await still(page, 'tower', [o.x + heroLay.top * 1.25, heroLay.top * 0.2, o.z + heroLay.top * 1.55], [o.x, heroLay.top * 0.52, o.z]);
      const root = by('lantern/assay-kit');
      const rl = layoutTower(root.tower);
      await still(page, 'root', [root.origin.x + 46, 7, root.origin.z + 58], [root.origin.x, rl.rootHeight * 0.55, root.origin.z]);
      const top = by('tidewater/harbor-ledger');
      const tl = layoutTower(top.tower);
      await still(page, 'datum', [top.origin.x + 70, tl.datumY + 4, top.origin.z + 88], [top.origin.x, tl.datumY - 10, top.origin.z]);
    },

    async flyover(page) {
      // A slow, low arc across the skyline into the dusk, the towers backlit by the sun.
      await record(page, {
        name: 'flyover',
        seconds: 14,
        at(t) {
          const k = easeSine(t);
          const a = lerp(0.08, 0.72, k);
          const r = lerp(930, 800, k);
          const eye: V3 = [Math.cos(a) * r, lerp(70, 48, k), Math.sin(a) * r];
          const target: V3 = [lerp(-60, -40, k), lerp(140, 130, k), lerp(-40, -60, k)];
          return { eye, target };
        },
      });
    },

    async rise(page) {
      // Up one tower from its root to the bronze datum line, slowly circling it.
      const d = by('tidewater/harbor-ledger');
      const lay = layoutTower(d.tower);
      const { x, z } = d.origin;
      await record(page, {
        name: 'rise',
        seconds: 13,
        at(t) {
          // Move for the first 88% of the take, then hold on the datum line.
          const k = ease(Math.min(1, t / 0.88));
          const y = lerp(lay.rootHeight * 0.45, lay.datumY - 8, k);
          const a = lerp(0.55, 1.05, k);
          const r = lerp(70, 92, k);
          const eye: V3 = [x + Math.cos(a) * r, Math.max(2, y + lerp(-3, 7, k)), z + Math.sin(a) * r];
          const target: V3 = [x, y, z];
          return { eye, target };
        },
      });
    },
  };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html missing: run npm run build first');
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['hero', 'stills', 'flyover', 'rise'];
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-capture-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(MEDIA, { recursive: true });

  await seed();
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
