/**
 * End-to-end UI check. Starts its own engine in-process on port 4779 with a
 * temp data home (never the real engine on 4770), seeds a couple of
 * fictional districts, opens the built UI in Chromium and checks that the
 * city renders without console errors. Saves screenshots to shots/.
 *
 * Run after `npm run build`: `npm run ui-test`. Optional: UI_DPR=2 renders
 * at retina density, UI_QUALITY=medium switches the quality setting first.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import type { Repo, RootStyle, TowerSpec } from '../shared/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, 'shots');
const PORT = 4779;
const VIEWPORT = { width: 1600, height: 940 };

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

// ---------------------------------------------------------------- seeding

interface SeedRepo {
  fullName: string;
  root: RootStyle;
  slot: number;
  commits: number;
}

// Fictional repos only: screenshots must never show his private data.
const SEED: SeedRepo[] = [
  { fullName: 'tidewater/harbor-ledger', root: 'beauxarts', slot: 0, commits: 140 },
  { fullName: 'kestrel/fieldnotes', root: 'chicago', slot: 1, commits: 60 },
];

async function seed(): Promise<void> {
  // Imported after PALIMPSEST_HOME is set so the db lands in the temp home.
  const { openDb } = await import('../engine/db.js');
  const { foundingFloors } = await import('../engine/history.js');
  const db = openDb();
  const start = Date.parse('2025-02-01T09:00:00Z');

  for (const s of SEED) {
    const commits = Array.from({ length: s.commits }, (_, i) => ({
      sha: `${s.slot}${i.toString(16).padStart(39, '0')}`,
      at: new Date(start + i * 26 * 3600_000).toISOString(),
      author: i % 3 === 0 ? 'Ada' : 'Ben',
      subject: `Change ${i + 1}`,
      body: i > s.commits * 0.7 ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
      lines: 20 + ((i * 37) % 300),
    }));
    const floors = foundingFloors(s.fullName, commits, []);
    const at = new Date(start + s.slot * 1000).toISOString();
    const repo: Repo = {
      fullName: s.fullName,
      private: false,
      defaultBranch: 'main',
      language: 'TypeScript',
      description: 'fixture',
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

// ---------------------------------------------------------------- pixels

/** RGB of a 1x1 PNG. Every PNG filter type reduces to the raw bytes for a single pixel with no prior row. */
function rgbOf1x1(png: Buffer): [number, number, number] {
  let off = 8;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return rgbOf1x1(await page.screenshot({ clip: { x, y, width: 1, height: 1 } }));
}

// ---------------------------------------------------------------- views

type View = [string, [number, number, number], [number, number, number]];

// Named camera views for the quality rounds: [file, eye, target].
const VIEWS: View[] = [
  ['city-horizon', [-120, 60, 520], [-600, 40, -600]],
  ['city-street', [118, 2.2, 52], [118, 14, -260]],
  ['city-skyline-mid', [560, 140, 620], [80, 40, 40]],
];

async function setView(page: Page, eye: number[], target: number[]): Promise<void> {
  await page.evaluate(([e, t]) => {
    (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
  }, [eye, target]);
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html missing: run npm run build first');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-ui-test-'));
  process.env.PALIMPSEST_HOME = join(tmp, 'home');
  process.env.PALIMPSEST_DIST = DIST;
  const claudeSettingsPath = join(tmp, 'claude-settings.json');
  writeFileSync(claudeSettingsPath, '{}\n');
  mkdirSync(SHOTS, { recursive: true });

  await seed();
  const { startServer } = await import('../engine/server.js');
  const server = await startServer({ port: PORT, claudeSettingsPath });

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: Number(process.env.UI_DPR ?? 1) });
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    if (process.env.UI_QUALITY) {
      await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
        method: 'PATCH',
        headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ quality: process.env.UI_QUALITY }),
      });
    }
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const ready = await page
      .waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false);
    check(ready, 'city reports ready');
    await page.waitForTimeout(3000);

    const canvas = await page.$('canvas');
    check(canvas !== null, 'a canvas is on the page');

    const [r, g, b] = await pixel(page, VIEWPORT.width / 2, VIEWPORT.height / 2);
    check(r + g + b > 0, `center pixel is not pure black (rgb ${r},${g},${b})`);

    const districts = await page.evaluate(
      () => (window as unknown as { __palimpsest?: { districts: number } }).__palimpsest?.districts ?? -1,
    );
    check(districts === SEED.length, `city shows ${SEED.length} districts (got ${districts})`);

    await page.screenshot({ path: join(SHOTS, 'city-overview.png') });

    if (ready) {
      for (const [name, eye, target] of VIEWS) {
        await setView(page, eye, target);
        await page.screenshot({ path: join(SHOTS, `${name}.png`) });
      }
    }

    if (ready) {
      // Picking: look straight at the first district's plinth and click the middle of the screen.
      const o = await page.evaluate(() => fetch('/api/city').then((r) => r.json()).then((d) => d[0].origin));
      await setView(page, [o.x + 40, 18, o.z + 40], [o.x, 2, o.z]);
      await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
      const pick = await page.evaluate(
        () => (window as unknown as { __palimpsest: { lastPick: { repo: string } | null } }).__palimpsest.lastPick,
      );
      check(pick?.repo === SEED[0].fullName, `clicking a plinth picks its district (got ${pick?.repo ?? 'nothing'})`);

      // A string, so tsx's name-keeping helpers never reach the page.
      const perf = (await page.evaluate(`new Promise((resolve) => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        let frames = 0;
        const t0 = performance.now();
        function tick() {
          frames++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else resolve({ fps: (frames * 1000) / (performance.now() - t0), gpu });
        }
        requestAnimationFrame(tick);
      })`)) as { fps: number; gpu: string };
      console.log(`info  ${perf.fps.toFixed(0)} fps at ${VIEWPORT.width}x${VIEWPORT.height} on ${perf.gpu}`);
    }

    check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nui-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
