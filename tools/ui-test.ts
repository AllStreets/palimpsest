/**
 * End-to-end UI check. Starts its own engine in-process on port 4779 with a
 * temp data home (never the real engine on 4770), seeds a couple of
 * fictional districts, opens the built UI in Chromium and checks that the
 * city renders without console errors. Saves screenshots to shots/.
 *
 * Run after `npm run build`: `npm run ui-test`. Optional: UI_DPR=2 renders
 * at retina density, UI_QUALITY=medium switches the quality setting first,
 * UI_TOWER_SHOTS=all adds close shots of every root and era for the quality
 * rounds.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District, Era, Repo, RootStyle, TowerSpec } from '../shared/types.js';

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
// Every root, every era (each history runs stone to sci-fi), Claude floors late in each, and one empty repo.
const SEED: SeedRepo[] = [
  { fullName: 'tidewater/harbor-ledger', root: 'beauxarts', slot: 0, commits: 46 },
  { fullName: 'kestrel/fieldnotes', root: 'chicago', slot: 1, commits: 34 },
  { fullName: 'lantern/assay-kit', root: 'gothic', slot: 2, commits: 40 },
  { fullName: 'ferro/quarry', root: 'roman', slot: 3, commits: 28 },
  { fullName: 'hoshi/kumo', root: 'pagoda', slot: 4, commits: 38 },
  { fullName: 'alder/blank-slate', root: 'roman', slot: 5, commits: 0 },
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
      body: i > s.commits * 0.7 || i % 9 === 4 ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
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

// Tower views, relative to a district origin: a bearing that turns the sunlit faces toward the eye.
const BEARING = { x: 0.63, z: 0.78 };

function towerViews(d: District, all: boolean): View[] {
  const root = d.tower.root;
  const lay = layoutTower(d.tower);
  const { x, z } = d.origin;
  const at = (dist: number, eyeY: number, ty: number, turn = 0): [[number, number, number], [number, number, number]] => {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const bx = BEARING.x * c - BEARING.z * s;
    const bz = BEARING.x * s + BEARING.z * c;
    return [[x + bx * dist, eyeY, z + bz * dist], [x, ty, z]];
  };
  const views: View[] = [[`tower-${root}`, ...at(Math.max(140, lay.top * 1.9), 22, lay.top * 0.47)]];
  if (!all) return views;
  views.push([`tower-${root}-root`, ...at(75, 6, lay.rootHeight * 0.5)]);
  views.push([`tower-${root}-root-close`, ...at(34, 3, lay.rootHeight * 0.38, 0.35)]);
  // Close on each era's run of floors.
  const runs = new Map<Era, { y0: number; y1: number }>();
  for (const l of lay.floors) {
    const r = runs.get(l.floor.era);
    if (r) r.y1 = l.y0 + l.h;
    else runs.set(l.floor.era, { y0: l.y0, y1: l.y0 + l.h });
  }
  for (const [era, r] of runs) {
    const mid = (r.y0 + r.y1) / 2;
    views.push([`tower-${root}-era-${era}`, ...at(70, mid + 6, mid)]);
  }
  return views;
}

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
      const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
      const all = process.env.UI_TOWER_SHOTS === 'all';
      const seen = new Set<string>();
      for (const d of city) {
        // One set of shots per root style, from the first tower with floors.
        if (d.tower.floors.length === 0 || seen.has(d.tower.root)) continue;
        seen.add(d.tower.root);
        for (const [name, eye, target] of towerViews(d, all)) {
          await setView(page, eye, target);
          await page.screenshot({ path: join(SHOTS, `${name}.png`) });
        }
      }
      check(seen.size === 5, `towers stand for all five roots (got ${[...seen].join(', ')})`);
      const empty = city.find((d) => d.tower.floors.length === 0);
      if (empty) {
        const [, eye, target] = towerViews(empty, true)[1];
        await setView(page, eye, target);
        await page.screenshot({ path: join(SHOTS, 'tower-empty.png') });
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

      // Every tower in view: the overview from the opening bearing.
      const fps = (): Promise<number> =>
        page.evaluate(`new Promise((resolve) => {
          let frames = 0;
          const t0 = performance.now();
          function tick() {
            frames++;
            if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
            else resolve((frames * 1000) / (performance.now() - t0));
          }
          requestAnimationFrame(tick);
        })`) as Promise<number>;
      const ds = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
      const cx = ds.reduce((a, d) => a + d.origin.x, 0) / ds.length;
      const cz = ds.reduce((a, d) => a + d.origin.z, 0) / ds.length;
      await setView(page, [cx + BEARING.x * 900, 300, cz + BEARING.z * 900], [cx, 70, cz]);
      await page.screenshot({ path: join(SHOTS, 'towers-all.png') });
      const all6 = await fps();
      const stats = await page.evaluate(
        () => (window as unknown as { __palimpsest: { stats(): { calls: number; triangles: number } } }).__palimpsest.stats(),
      );
      console.log(`info  six towers in view: ${all6.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles per frame`);
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
