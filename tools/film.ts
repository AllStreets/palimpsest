/**
 * The film and the profile clip (Phase 5 rulings 9 and 10), cut from the
 * frames the capture tool writes on the sample, frame by frame.
 *
 *   npm run build
 *   npm run film                          captures the clips, then cuts, into a fresh temp dir
 *   FILM_FRAMES=<dir> npm run film        cuts from frames a capture kept (CAPTURE_FRAMES=<dir>)
 *   CAPTURE_OUT=<dir> npm run film        writes into <dir>
 *   CAPTURE_WRITE_MEDIA=1 npm run film    writes into docs/media (Task 27 only)
 *
 * The film: 70 to 90 s at 1600 by 1000 and 30 fps, H.264 yuv420p with
 * +faststart, two-pass to at most 9.5 MB, silent, in the ruled order with a
 * title card (Newsreader 40 px on the dusk ink, sentence case, one line,
 * 2 s with 0.5 s fades) before each part; film.mp4 and film-poster.webp
 * (at most 450 KB). The profile clip: an 11 s seamless loop of the
 * flyover's arc at 800 by 500, profile.avif (at most 3 MB) and
 * profile.webp (at most 4 MB), with the HTML for his profile README in
 * profile.md beside them.
 *
 * The capture it runs serves the sample on CAPTURE_PORT (4788 on the
 * screens track), never the engine's 4770 or the dev server's 4771. Nothing
 * is fetched: the title font is the app's own, from app/public/fonts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { outDir } from './diagrams.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;
const KB = 1024;
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';

export const FILM = { width: 1600, height: 1000, fps: 30, maxBytes: 9.5 * MB, posterMax: 450 * KB, minSeconds: 70, maxSeconds: 90 } as const;
export const TITLE_SECONDS = 2;
export const FADE_SECONDS = 0.5;
/** The dusk ink the titles sit on (the app's sheet, --paper) and the ink they are set in (--ink). */
export const TITLE_COLOURS = { ground: '#0a0b0f', ink: '#ece6da' } as const;

export type Segment = { title: string } | { clip: string; from: number; seconds: number } | { still: string; seconds: number };

/** The cut, in the ruled order. A clip is named as the capture tool keeps its frames; a still by its image's name. */
export const FILM_PLAN: Segment[] = [
  { title: 'The city at dusk' },
  { clip: 'hero-rise', from: 0, seconds: 8 },
  { title: 'A job becomes a floor' },
  { clip: 'construction', from: 4, seconds: 10 },
  { title: 'The ride up a tower' },
  { clip: 'ride', from: 0, seconds: 9 },
  { title: 'On the way to work' },
  { clip: 'commute', from: 0, seconds: 8 },
  { title: 'The morning brief and the README audit' },
  { still: 'brief', seconds: 4 },
  { still: 'audit', seconds: 4 },
  { title: 'The school' },
  { clip: 'voyage', from: 0, seconds: 7 },
  { clip: 'observatory', from: 0, seconds: 6 },
  { title: 'The week in review' },
  { clip: 'week', from: 0, seconds: 10 },
  { clip: 'flyover', from: 0, seconds: 7 },
];

export const PROFILE = { clip: 'flyover', seconds: 11, blend: 1, width: 800, height: 500, maxAvif: 3 * MB, maxWebp: 4 * MB } as const;

export function filmSeconds(plan: Segment[]): number {
  return plan.reduce((s, x) => s + ('title' in x ? TITLE_SECONDS : x.seconds), 0);
}

/**
 * The capture tool's shots the cut needs, in the order a bare capture takes
 * them: the stills of the board as it stands before anything ticks the
 * economy's clock, the clips that tick it last.
 */
export function filmShots(): string[] {
  return ['brief', 'audit-page', 'voyage', 'observatory', 'ride', 'week', 'flyover', 'hero-rise', 'construction-clip', 'commute'];
}

export function titleFilter(): string {
  return `fade=t=in:st=0:d=${FADE_SECONDS},fade=t=out:st=${TITLE_SECONDS - FADE_SECONDS}:d=${FADE_SECONDS},format=yuv420p`;
}

const SCALE = `fps=${FILM.fps},scale=${FILM.width}:${FILM.height}:flags=lanczos,format=yuv420p`;
/** Each part is encoded near-losslessly first; the two passes at the end set the size. */
const INTERMEDIATE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-pix_fmt', 'yuv420p', '-r', String(FILM.fps), '-an'];

/** ffmpeg's arguments for one part of the cut: a clip from its frames, a still held, or a title card held and faded. */
export function segmentArgs(seg: Segment, src: { dir: string; fps: number }, out: string): string[] {
  if ('clip' in seg) {
    const start = Math.round(seg.from * src.fps);
    return ['-framerate', String(src.fps), '-start_number', String(start), '-i', join(src.dir, 'f%04d.png'), '-t', String(seg.seconds), '-vf', SCALE, ...INTERMEDIATE, out];
  }
  if ('still' in seg) {
    return ['-loop', '1', '-framerate', String(FILM.fps), '-i', join(src.dir, `${seg.still}.png`), '-t', String(seg.seconds), '-vf', SCALE, ...INTERMEDIATE, out];
  }
  return ['-loop', '1', '-framerate', String(FILM.fps), '-i', src.dir, '-t', String(TITLE_SECONDS), '-vf', `scale=${FILM.width}:${FILM.height},${titleFilter()}`, ...INTERMEDIATE, out];
}

/** The video bitrate that fits `maxBytes` over `seconds`, with room for the container and the encoder's drift. */
export function bitrateKbps(maxBytes: number, seconds: number, headroom = 0.92): number {
  return Math.floor((maxBytes * 8 * headroom) / seconds / 1000);
}

/** One of the two passes: the first measures, the second writes the film. */
export function passArgs(pass: 1 | 2, input: string, out: string, kbps: number, passlog: string): string[] {
  const common = ['-i', input, '-c:v', 'libx264', '-preset', 'slow', '-tune', 'film', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.6)}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p', '-r', String(FILM.fps), '-s', `${FILM.width}x${FILM.height}`, '-an', '-pass', String(pass), '-passlogfile', passlog];
  return pass === 1 ? [...common, '-f', 'null', '/dev/null'] : [...common, '-movflags', '+faststart', out];
}

/**
 * A seamless loop of `seconds` from a clip `seconds + blend` long: the clip
 * from `blend` on, its last `blend` seconds dissolving into its first, so
 * the loop's last frame meets its first.
 */
export function loopFilter(seconds: number, blend: number, input = '[0:v]'): string {
  return `${input}split[a][b];[a]trim=start=${blend}:end=${seconds + blend},setpts=PTS-STARTPTS[main];[b]trim=start=0:end=${blend},setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=${blend}:offset=${seconds - blend},format=yuv420p[out]`;
}

export const PROFILE_ALT = 'A slow flight round the Palimpsest sample city at dusk: towers on lit plazas slide past each other while the low sun drifts behind them.';

/** The HTML for his profile README: the loop, linking the repo. */
export function profileSnippet(repo: string): string {
  const raw = `https://raw.githubusercontent.com/${repo}/main/docs/media`;
  return [
    `<a href="https://github.com/${repo}"><picture>`,
    `  <source type="image/avif" srcset="${raw}/profile.avif" />`,
    `  <img src="${raw}/profile.webp" alt="${PROFILE_ALT}" width="${PROFILE.width}" />`,
    `</picture></a>`,
    '',
  ].join('\n');
}

export function capturePort(raw: string | undefined): number {
  const port = raw ? Number(raw) : 4788;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`CAPTURE_PORT must be a port number, not ${raw}`);
  if (port === 4770 || port === 4771) throw new Error(`CAPTURE_PORT ${port} is the engine's or the dev server's; pick another`);
  return port;
}

// ---------------------------------------------------------------- the cut

function ff(args: string[], cwd?: string): void {
  execFileSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: 'inherit', cwd });
}

const size = (p: string): number => statSync(p).size;
const fmt = (n: number): string => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / KB)} KB`);

/** The frames of a kept clip: its folder, its frame rate and how many frames it holds. */
function clipSource(frames: string, name: string): { dir: string; fps: number; count: number } {
  const dir = join(frames, name);
  if (!existsSync(dir)) throw new Error(`film: no frames for ${name} in ${frames}; capture it with CAPTURE_FRAMES`);
  const meta = existsSync(join(dir, 'clip.json')) ? (JSON.parse(readFileSync(join(dir, 'clip.json'), 'utf8')) as { fps?: number }) : {};
  const count = readdirSync(dir).filter((f) => /^f\d{4}\.png$/.test(f)).length;
  return { dir, fps: meta.fps ?? FILM.fps, count };
}

/** Runs the capture tool for the film's shots, keeping their frames, on a temp sample. Never writes docs/media. */
function captureFrames(work: string, port: number): string {
  const frames = join(work, 'frames');
  mkdirSync(frames, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CAPTURE_FRAMES: frames, CAPTURE_OUT: join(work, 'capture'), CAPTURE_PORT: String(port), CAPTURE_ECONOMY: 'live', RIDE_ONLY: 'clip' };
  delete env.CAPTURE_WRITE_MEDIA;
  const r = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', join(ROOT, 'tools', 'capture.ts'), ...filmShots()], { stdio: 'inherit', env, cwd: ROOT });
  if (r.status !== 0) throw new Error(`film: the capture failed (exit ${r.status})`);
  return frames;
}

/** Each title as a 1600 by 1000 PNG, set by the browser in the app's own Newsreader. */
async function titleCards(titles: string[], dir: string): Promise<Map<string, string>> {
  const { chromium } = await import('playwright');
  const font = readFileSync(join(ROOT, 'app', 'public', 'fonts', 'newsreader.woff2')).toString('base64');
  const out = new Map<string, string>();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: FILM.width, height: FILM.height }, deviceScaleFactor: 1 });
    // Nothing leaves the machine.
    await ctx.route(/^https?:/, (r) => r.abort());
    const page = await ctx.newPage();
    for (const [i, t] of titles.entries()) {
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Newsreader;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:400 500}` +
          `html,body{margin:0;height:100%;background:${TITLE_COLOURS.ground}}body{display:flex;align-items:center;justify-content:center}` +
          `p{margin:0;font:400 40px/1.2 Newsreader,serif;color:${TITLE_COLOURS.ink};white-space:nowrap}</style><p></p>`,
      );
      await page.locator('p').evaluate((p, text) => {
        p.textContent = text;
      }, t);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      if (!(await page.evaluate(() => document.fonts.check('40px Newsreader')))) throw new Error('film: Newsreader did not load for the titles');
      const png = join(dir, `title-${i}.png`);
      await page.screenshot({ path: png });
      out.set(t, png);
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function cutFilm(frames: string, out: string, work: string): Promise<void> {
  const parts = join(work, 'parts');
  mkdirSync(parts, { recursive: true });
  const titles = await titleCards(FILM_PLAN.flatMap((x) => ('title' in x ? [x.title] : [])), parts);
  const files: string[] = [];
  for (const [i, seg] of FILM_PLAN.entries()) {
    const part = join(parts, `p${String(i).padStart(2, '0')}.mp4`);
    if ('clip' in seg) {
      const src = clipSource(frames, seg.clip);
      const need = Math.round((seg.from + seg.seconds) * src.fps);
      if (src.count < need) throw new Error(`film: ${seg.clip} holds ${src.count} frames; the cut needs ${need}`);
      ff(segmentArgs(seg, src, part));
    } else if ('still' in seg) {
      const dir = join(frames, 'stills');
      if (!existsSync(join(dir, `${seg.still}.png`))) throw new Error(`film: no still ${seg.still} in ${dir}`);
      ff(segmentArgs(seg, { dir, fps: FILM.fps }, part));
    } else {
      ff(segmentArgs(seg, { dir: titles.get(seg.title)!, fps: FILM.fps }, part));
    }
    files.push(part);
  }
  const list = join(work, 'parts.txt');
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n') + '\n');
  const cut = join(work, 'cut.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', cut]);

  const seconds = filmSeconds(FILM_PLAN);
  const film = join(out, 'film.mp4');
  let headroom = 0.92;
  for (;;) {
    const kbps = bitrateKbps(FILM.maxBytes, seconds, headroom);
    const log = join(work, 'pass');
    ff(passArgs(1, cut, film, kbps, log), work);
    ff(passArgs(2, cut, film, kbps, log), work);
    console.log(`  film.mp4 ${fmt(size(film))}, ${seconds} s at ${kbps} kbps`);
    if (size(film) <= FILM.maxBytes) break;
    if (headroom < 0.7) throw new Error(`film: ${fmt(size(film))} is over 9.5 MB`);
    headroom -= 0.08;
  }

  // The poster: the city at dusk, the hero rise's last frame.
  const rise = clipSource(frames, 'hero-rise');
  const posterSrc = join(rise.dir, `f${String(rise.count - 1).padStart(4, '0')}.png`);
  const poster = join(out, 'film-poster.webp');
  for (let q = 86; ; q -= 6) {
    execFileSync('cwebp', ['-q', String(q), '-m', '6', '-resize', String(FILM.width), String(FILM.height), posterSrc, '-o', poster], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (size(poster) <= FILM.posterMax) break;
    if (q <= 50) throw new Error(`film: the poster is ${fmt(size(poster))}, over 450 KB`);
  }
  console.log(`  film-poster.webp ${fmt(size(poster))}`);
}

function cutProfile(frames: string, out: string, work: string, repo: string): void {
  const src = clipSource(frames, PROFILE.clip);
  const need = Math.round((PROFILE.seconds + PROFILE.blend) * src.fps);
  if (src.count < need) throw new Error(`film: ${PROFILE.clip} holds ${src.count} frames; the loop needs ${need}`);
  const loop = join(work, 'loop.mp4');
  const pre = `[0:v]fps=30,scale=${PROFILE.width}:${PROFILE.height}:flags=lanczos[s];`;
  ff(['-framerate', String(src.fps), '-i', join(src.dir, 'f%04d.png'), '-filter_complex', pre + loopFilter(PROFILE.seconds, PROFILE.blend, '[s]'), '-map', '[out]', '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', loop]);

  const avif = join(out, 'profile.avif');
  for (let crf = 34; ; crf += 4) {
    ff(['-i', loop, '-vf', 'fps=24', '-c:v', 'libsvtav1', '-preset', '4', '-crf', String(crf), '-g', '96', '-pix_fmt', 'yuv420p', '-f', 'avif', '-loop', '0', avif]);
    if (size(avif) <= PROFILE.maxAvif) break;
    if (crf >= 54) throw new Error(`film: profile.avif is ${fmt(size(avif))}, over 3 MB`);
  }
  const still = join(work, 'profile-frames');
  mkdirSync(still, { recursive: true });
  ff(['-i', loop, '-vf', 'fps=15', join(still, 's%04d.png')]);
  const pngs = readdirSync(still).filter((f) => f.endsWith('.png')).sort().map((f) => join(still, f));
  const webp = join(out, 'profile.webp');
  for (let q = 62; ; q -= 8) {
    // Keyframes every 15 frames so dark gradients never keep stale blocks.
    execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', String(q), '-m', '6', '-kmax', '15', '-d', String(Math.round(1000 / 15)), ...pngs, '-o', webp], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (size(webp) <= PROFILE.maxWebp) break;
    if (q <= 30) throw new Error(`film: profile.webp is ${fmt(size(webp))}, over 4 MB`);
  }
  writeFileSync(join(out, 'profile.md'), profileSnippet(repo));
  console.log(`  profile.avif ${fmt(size(avif))}, profile.webp ${fmt(size(webp))}, profile.md`);
}

async function main(): Promise<void> {
  const s = filmSeconds(FILM_PLAN);
  if (s < FILM.minSeconds || s > FILM.maxSeconds) throw new Error(`film: the plan runs ${s} s, outside 70 to 90`);
  const out = outDir(process.env, 'palimpsest-film-');
  mkdirSync(out, { recursive: true });
  const port = capturePort(process.env.CAPTURE_PORT ?? '4788');
  const work = mkdtempSync(join(tmpdir(), 'palimpsest-film-work-'));
  try {
    const frames = process.env.FILM_FRAMES ? resolve(process.env.FILM_FRAMES) : captureFrames(work, port);
    await cutFilm(frames, out, work);
    cutProfile(frames, out, work, process.env.FILM_REPO ?? 'AllStreets/palimpsest');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Wrote to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
