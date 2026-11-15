/**
 * Draws the README's four diagrams from the code's own lists (Phase 5
 * ruling 11) and renders each in both themes with Playwright, 1600 wide at
 * DPR 2, in the app's own Newsreader and IBM Plex Sans, to
 * `diagram-<name>-light.webp` and `diagram-<name>-dark.webp`, each at most
 * 300 KB.
 *
 *   npm run diagrams                       renders into a fresh temp dir
 *   CAPTURE_OUT=<dir> npm run diagrams     renders into <dir>
 *   CAPTURE_WRITE_MEDIA=1 npm run diagrams renders into docs/media (Task 27 only)
 *   DIAGRAMS_ONLY=floor,school             renders only those
 *   DIAGRAMS_PNG=1                         keeps the PNGs beside the webps, for review
 *
 * The page is served on 127.0.0.1:4792 (DIAGRAMS_PORT), never the engine's
 * 4770 or the dev server's 4771. Nothing is fetched from the network: the
 * fonts are the app's own, read from app/public/fonts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { floor } from './diagrams/floor.js';
import { machine } from './diagrams/machine.js';
import { sandbox } from './diagrams/sandbox.js';
import { school } from './diagrams/school.js';
import { page, type Diagram } from './diagrams/sheet.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, 'docs', 'media');
const FONTS = join(ROOT, 'app', 'public', 'fonts');
export const DIAGRAMS_PORT_DEFAULT = 4792;
export const MAX_BYTES = 300 * 1024;
/** The size each image aims under, for margin below the cap. */
export const AIM_BYTES = 270 * 1024;
const WIDTH = 1600;

export function diagrams(): Diagram[] {
  return [machine(), floor(), sandbox(), school()];
}

/** Where the images go: docs/media only with CAPTURE_WRITE_MEDIA=1 (rule 17), else CAPTURE_OUT, else a temp dir. */
export function outDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CAPTURE_WRITE_MEDIA === '1') return MEDIA;
  if (env.CAPTURE_OUT) {
    const out = resolve(env.CAPTURE_OUT);
    const rel = relative(MEDIA, out);
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new Error('docs/media is written only with CAPTURE_WRITE_MEDIA=1 (Task 27)');
    return out;
  }
  return mkdtempSync(join(tmpdir(), 'palimpsest-diagrams-'));
}

export function diagramsPort(raw: string | undefined): number {
  const port = raw ? Number(raw) : DIAGRAMS_PORT_DEFAULT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`DIAGRAMS_PORT must be a port number, not ${raw}`);
  if (port === 4770 || port === 4771) throw new Error(`DIAGRAMS_PORT ${port} is the engine's or the dev server's; pick another`);
  return port;
}

async function main(): Promise<void> {
  const out = outDir();
  mkdirSync(out, { recursive: true });
  const port = diagramsPort(process.env.DIAGRAMS_PORT);
  const only = process.env.DIAGRAMS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const list = diagrams().filter((d) => !only || only.includes(d.name));
  const byName = new Map(list.map((d) => [d.name, d]));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname);
    if (font && existsSync(join(FONTS, font[1]))) {
      res.writeHead(200, { 'content-type': 'font/woff2' });
      res.end(readFileSync(join(FONTS, font[1])));
      return;
    }
    const d = byName.get(url.pathname.slice(1) as Diagram['name']);
    if (d) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(d));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(port, '127.0.0.1', ok));

  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    for (const d of list) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ viewport: { width: WIDTH, height: d.height }, deviceScaleFactor: 2, colorScheme: theme });
        // Nothing leaves the machine: only this server answers.
        await ctx.route(/^(?!http:\/\/127\.0\.0\.1:\d+\/)/, (r) => r.abort());
        const p = await ctx.newPage();
        await p.goto(`http://127.0.0.1:${port}/${d.name}`);
        await p.evaluate(async () => {
          await document.fonts.ready;
        });
        const families = await p.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')));
        for (const fam of ['Newsreader', 'IBM Plex Sans']) if (!families.includes(fam)) problems.push(`${d.name} ${theme}: ${fam} did not load`);
        const png = join(out, `diagram-${d.name}-${theme}.png`);
        const webp = join(out, `diagram-${d.name}-${theme}.webp`);
        await p.screenshot({ path: png, clip: { x: 0, y: 0, width: WIDTH, height: d.height } });
        await ctx.close();
        let q = 92;
        for (;;) {
          execFileSync('cwebp', ['-q', String(q), '-m', '6', '-sharp_yuv', png, '-o', webp], { stdio: 'ignore' });
          if (statSync(webp).size <= AIM_BYTES || q <= 60) break;
          q -= 4;
        }
        const kb = Math.round(statSync(webp).size / 1024);
        if (statSync(webp).size > MAX_BYTES) problems.push(`${d.name} ${theme}: ${kb} KB is over ${MAX_BYTES / 1024} KB`);
        if (process.env.DIAGRAMS_PNG !== '1') rmSync(png);
        console.log(`  diagram-${d.name}-${theme}.webp  ${kb} KB  q${q}  ${WIDTH}x${d.height} at 2x`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`Wrote to ${out}`);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
