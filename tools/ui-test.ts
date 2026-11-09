/**
 * End-to-end UI check. Starts its own engine in-process on port 4779 with a
 * temp data home (never the real engine on 4770), seeds a couple of
 * fictional districts, opens the built UI in Chromium and checks that the
 * city renders without console errors. Saves screenshots to shots/.
 *
 * The Repos and Settings checks fake every gh/git call in-process (setRunner),
 * and the usage hook buttons write only to a temp claude settings file.
 *
 * Run after `npm run build`: `npm run ui-test`. Optional: UI_DPR=2 renders
 * at retina density, UI_QUALITY=medium switches the quality setting first,
 * UI_TOWER_SHOTS=all adds close shots of every root and era for the quality
 * rounds.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      // The index leads, so every short sha (and so every floor id) is distinct.
      sha: `${s.slot}${i.toString(16).padStart(6, '0')}`.padEnd(40, 'a'),
      at: new Date(start + i * 26 * 3600_000).toISOString(),
      author: i % 3 === 0 ? 'Ada' : 'Ben',
      subject: `Change ${i + 1}`,
      // Late floors alternate, so every era shot shows Claude and non-Claude floors side by side.
      body: (i > s.commits * 0.7 && i % 2 === 0) || i % 9 === 4 ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
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

// ---------------------------------------------------------------- debug handle

interface Debug {
  ready: boolean;
  districts: number;
  sites: number;
  builds: number;
  highlight: { repo: string; floorId: string } | null;
  camera(): number[];
  precompile(): Promise<void>;
  stats(): { calls: number; triangles: number };
}

function debug<T>(page: Page, read: (d: Debug) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__palimpsest)`) as Promise<T>;
}

const cityOf = (page: Page): Promise<District[]> =>
  page.evaluate(() => fetch('/api/city').then((r) => r.json())) as Promise<District[]>;

// ---------------------------------------------------------------- fps

/**
 * Steady-state frame rate: every shader is compiled first (renderer.compile
 * through the debug handle) and the view settles, so a first-sight compile
 * never counts against the steady state.
 */
async function measureFps(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  // A string, so tsx's name-keeping helpers never reach the page.
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
  const settled = async (eye: number[], target: number[]): Promise<number> => {
    await setView(page, eye, target);
    await debug(page, (d) => d.precompile());
    await page.waitForTimeout(1500);
    return fps();
  };
  const gpu = (await page.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  })()`)) as string;
  const ratio = (await page.evaluate('Math.min(devicePixelRatio, 1.75)')) as number;

  const ds = await cityOf(page);
  const cx = ds.reduce((a, d) => a + d.origin.x, 0) / ds.length;
  const cz = ds.reduce((a, d) => a + d.origin.z, 0) / ds.length;
  const overview = await settled([cx + BEARING.x * 900, 300, cz + BEARING.z * 900], [cx, 70, cz]);
  await page.screenshot({ path: join(SHOTS, 'towers-all.png') });
  const stats = await debug(page, (d) => d.stats());
  const d0 = ds.find((d) => d.tower.floors.length > 0) ?? ds[0];
  const top = layoutTower(d0.tower).top;
  const close = await settled(
    [d0.origin.x + BEARING.x * 120, top * 0.45, d0.origin.z + BEARING.z * 120],
    [d0.origin.x, top * 0.5, d0.origin.z],
  );
  const closeStats = await debug(page, (d) => d.stats());
  console.log(`info  ${gpu}, ${VIEWPORT.width}x${VIEWPORT.height} at pixel ratio ${ratio}`);
  console.log(`info  steady overview: ${overview.toFixed(0)} fps, ${stats.calls} draw calls, ${(stats.triangles / 1e6).toFixed(2)}M triangles`);
  console.log(`info  steady close tower: ${close.toFixed(0)} fps, ${closeStats.calls} draw calls, ${(closeStats.triangles / 1e6).toFixed(2)}M triangles`);
}

// ---------------------------------------------------------------- inspector

async function inspectorChecks(page: Page): Promise<void> {
  const ds = await cityOf(page);
  const d = ds.find((x) => x.tower.floors.length > 0);
  if (!d) {
    check(false, 'a district with floors exists for the inspector');
    return;
  }
  // Look square at the middle of the first tower and click it.
  const lay = layoutTower(d.tower);
  const target: [number, number, number] = [d.origin.x, lay.top * 0.55, d.origin.z];
  const dist = lay.top * 2.4;
  await setView(page, [d.origin.x + BEARING.x * dist, lay.top * 0.5, d.origin.z + BEARING.z * dist], target);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
  const opened = await page
    .waitForSelector('.inspector.open', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(opened, 'clicking a tower opens the inspector');
  if (!opened) return;
  await page.waitForTimeout(1200);
  const rows = await page.locator('.insp-floor').count();
  check(rows === d.tower.floors.length, `the inspector lists every floor (${rows} of ${d.tower.floors.length})`);
  const name = await page.locator('.insp-name').textContent();
  check(name === d.repo.split('/')[1], `the inspector names the repo (got ${name})`);
  await page.screenshot({ path: join(SHOTS, 'inspector-open.png') });

  // Click a row a third of the way down: the camera flies to it and the floor is marked.
  const before = await debug(page, (x) => x.camera());
  const pick = Math.floor(rows / 3);
  await page.locator('.insp-floor').nth(pick).click();
  await page.waitForTimeout(2200);
  const after = await debug(page, (x) => x.camera());
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  check(moved > 1, `clicking a floor row moves the camera (${moved.toFixed(1)} m)`);
  const floorId = d.tower.floors[d.tower.floors.length - 1 - pick].id;
  const hl = await debug(page, (x) => x.highlight);
  check(hl?.floorId === floorId, `the clicked floor is highlighted (got ${hl?.floorId ?? 'nothing'})`);
  await page.screenshot({ path: join(SHOTS, 'inspector-floor.png') });

  // Keyboard: arrows move the selection down the list, Enter flies, Escape closes.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const next = await debug(page, (x) => x.highlight);
  const want = d.tower.floors[d.tower.floors.length - 3 - pick].id;
  check(next?.floorId === want, `arrow keys move between floors (got ${next?.floorId ?? 'nothing'})`);
  const pre = await debug(page, (x) => x.camera());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  const post = await debug(page, (x) => x.camera());
  check(Math.hypot(post[0] - pre[0], post[1] - pre[1], post[2] - pre[2]) > 0.5, 'Enter flies to the selected floor');
  await page.screenshot({ path: join(SHOTS, 'inspector-keyboard.png') });

  // A refresh for another repo must leave keyboard focus in the list: arrows still move the selection.
  const { emit } = await import('../engine/events.js');
  const focusedBefore = await debug(page, (x) => x.highlight);
  emit('repo.analyzed', { repo: { fullName: SEED[1].fullName } });
  await page.waitForTimeout(1200);
  const inPanel = await page.evaluate(() => !!document.activeElement?.closest('.inspector'));
  check(inPanel, 'focus stays in the inspector across a refresh for another repo');
  await page.keyboard.press('ArrowDown');
  const afterRefresh = await debug(page, (x) => x.highlight);
  check(
    afterRefresh !== null && afterRefresh.floorId !== focusedBefore?.floorId,
    `arrow keys still move the selection after a refresh (got ${afterRefresh?.floorId ?? 'nothing'})`,
  );

  // The highlight from further out, to judge whether it reads at distance.
  await setView(page, [d.origin.x + BEARING.x * 420, 90, d.origin.z + BEARING.z * 420], [d.origin.x, lay.top * 0.5, d.origin.z]);
  await page.screenshot({ path: join(SHOTS, 'inspector-far.png') });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, 'inspector-1280.png') });
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(500);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(!(await page.locator('.inspector').isVisible()), 'Escape closes the inspector');
  check((await debug(page, (x) => x.highlight)) === null, 'closing clears the floor highlight');
}

// ---------------------------------------------------------------- an analyzing site

async function siteChecks(page: Page): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { emit } = await import('../engine/events.js');
  const { foundingFloors } = await import('../engine/history.js');
  const { districtOrigin } = await import('../shared/district-layout.js');
  const db = openDb();
  const fullName = 'wren/new-site';
  const slot = SEED.length;
  const now = new Date().toISOString();
  const repo: Repo = {
    fullName,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: 'fixture',
    connected: true,
    pushMode: false,
    root: 'chicago',
    slot,
    status: 'analyzing',
    error: null,
    connectedAt: now,
    analyzedAt: null,
  };
  db.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(fullName, JSON.stringify(repo));
  emit('repo.analyzing', { repo, step: 'log' });
  const shown = await page
    .waitForFunction(() => (window as unknown as { __palimpsest: { sites: number } }).__palimpsest.sites === 1, null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(shown, 'an analyzing repo shows a scaffold at its site');
  const o = districtOrigin(slot);
  await setView(page, [o.x + BEARING.x * 95, 16, o.z + BEARING.z * 95], [o.x, 9, o.z]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'site-analyzing.png') });
  await setView(page, [o.x + BEARING.x * 380, 120, o.z + BEARING.z * 380], [o.x, 10, o.z]);
  await page.screenshot({ path: join(SHOTS, 'site-analyzing-far.png') });

  // The analysis finishes: that district alone is built and the scaffold comes down.
  const buildsBefore = await debug(page, (x) => x.builds);
  const commits = Array.from({ length: 22 }, (_, i) => ({
    sha: `${slot}${i.toString(16).padStart(6, '0')}`.padEnd(40, 'a'),
    at: new Date(Date.parse('2025-06-01T09:00:00Z') + i * 30 * 3600_000).toISOString(),
    author: 'Ada',
    subject: `Site change ${i + 1}`,
    body: '',
    lines: 40 + i * 11,
  }));
  const floors = foundingFloors(fullName, commits, []);
  const tower: TowerSpec = { id: `${fullName}#founding`, repo: fullName, kind: 'founding', root: 'chicago', floors, datumIndex: floors.length };
  db.prepare('INSERT INTO towers (repo, json) VALUES (?, ?)').run(fullName, JSON.stringify(tower));
  const ready: Repo = { ...repo, status: 'ready', analyzedAt: new Date().toISOString() };
  db.prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify(ready), fullName);
  emit('repo.analyzed', { repo: ready });
  const done = await page
    .waitForFunction(
      (n) => {
        const d = (window as unknown as { __palimpsest: { districts: number; sites: number } }).__palimpsest;
        return d.districts === n && d.sites === 0;
      },
      SEED.length + 1,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  check(done, 'repo.analyzed replaces the scaffold with the tower');
  const buildsAfter = await debug(page, (x) => x.builds);
  check(buildsAfter - buildsBefore === 1, `repo.analyzed rebuilds only that district (built ${buildsAfter - buildsBefore})`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'site-built.png') });
}


// ---------------------------------------------------------------- a fake GitHub

/** Repos the fake gh can see: the seeded districts plus a few that are not in the city yet. All fictional. */
const AVAILABLE = [
  ...SEED.map((s) => ({ fullName: s.fullName, private: false, description: 'A seeded district', language: 'TypeScript' })),
  { fullName: 'marlow/tidepool-notes', private: false, description: 'Field notes from the tide pools, kept as markdown', language: 'Markdown' },
  { fullName: 'marlow/locked-vault', private: true, description: 'Private records the CLI cannot read', language: 'Rust' },
  { fullName: 'orrery/brass-gears', private: true, description: 'Gear trains for a desk orrery', language: 'Python' },
  { fullName: 'orrery/star-catalogue', private: false, description: null, language: 'Go' },
  { fullName: 'quill/marginalia', private: false, description: 'Notes in the margins of old manuals', language: 'TypeScript' },
];
const UNREADABLE = 'marlow/locked-vault';
const RS = '\x1e';
const US = '\x1f';

/** A gh/git stand-in: slow enough that each analysis step is visible, never touching the network. */
async function fakeGh(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  await new Promise((r) => setTimeout(r, 450));
  const row = (fullName: string) => {
    const a = AVAILABLE.find((x) => x.fullName === fullName);
    return {
      nameWithOwner: fullName,
      isPrivate: a?.private ?? false,
      description: a?.description ?? null,
      primaryLanguage: a?.language ? { name: a.language } : null,
      defaultBranchRef: { name: 'main' },
    };
  };
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  if (cmd === 'gh' && args[0] === 'auth') return ok('');
  if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'list') return ok(JSON.stringify(AVAILABLE.map((a) => row(a.fullName))));
  if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
    if (args[2] === UNREADABLE) return { stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${UNREADABLE}'.`, code: 1 };
    return ok(JSON.stringify(row(args[2])));
  }
  if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') return ok('');
  if (cmd === 'git' && args.includes('log')) {
    const log = Array.from({ length: 18 }, (_, i) => {
      const sha = `9${i.toString(16).padStart(6, '0')}`.padEnd(40, 'b');
      const at = new Date(Date.parse('2025-09-01T10:00:00Z') + i * 40 * 3600_000).toISOString();
      return `${RS}${sha}${US}${at}${US}Ada${US}Tide note ${i + 1}${US}${US}\n\n${30 + i * 13}\t0\tnotes.md\n`;
    }).join('');
    return ok(log);
  }
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
  throw new Error(`fakeGh: unexpected command ${cmd} ${args.join(' ')}`);
}

// ---------------------------------------------------------------- repos

const rowSel = (fullName: string): string => `.repo-row[data-repo="${fullName}"]`;

async function waitStatus(page: Page, fullName: string, want: string, seen: Set<string>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await page.locator(rowSel(fullName)).getAttribute('data-status').catch(() => null);
    if (st) seen.add(st);
    if (st === want) return true;
    await page.waitForTimeout(60);
  }
  return false;
}

async function reposChecks(page: Page): Promise<void> {
  await page.locator('.runhead a[data-route="repos"]').click();
  const shown = await page
    .waitForSelector(`${rowSel('marlow/tidepool-notes')}`, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(shown, 'the Repos screen lists every repo gh can see');
  if (!shown) return;
  let listed = 0;
  for (const a of AVAILABLE) listed += await page.locator(rowSel(a.fullName)).count();
  check(listed === AVAILABLE.length, `every available repo has one row (${listed} of ${AVAILABLE.length})`);
  // A connected repo gh no longer lists (the site from the scaffold check) still stands under "In the city".
  check((await page.locator(rowSel('wren/new-site')).count()) === 1, 'a connected repo outside the gh list is still listed');
  check(
    (await page.locator(`${rowSel('orrery/brass-gears')} .repo-private`).textContent())?.trim() === 'private',
    'a private repo carries the word private',
  );
  check((await page.locator(`${rowSel('quill/marginalia')} .repo-private`).count()) === 0, 'a public repo carries no private marker');
  check(
    (await page.locator(`${rowSel('quill/marginalia')} [role="switch"].connect`).getAttribute('aria-checked')) === 'false',
    'an unconnected repo is off by default',
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'repos.png') });

  // Search: "/" focuses the field, typing narrows the list.
  await page.keyboard.press('/');
  check(await page.locator('.repos-search').evaluate((e) => e === document.activeElement), '"/" focuses the search');
  await page.keyboard.type('orrery');
  await page.waitForTimeout(150);
  const visible = await page.locator('.repo-row:visible').count();
  check(visible === 2, `search narrows the list (${visible} rows for "orrery")`);
  await page.screenshot({ path: join(SHOTS, 'repos-search.png') });
  await page.keyboard.press('Escape');
  check((await page.locator('.repos-search').inputValue()) === '', 'Escape clears the search first');
  check((await page.locator('.sheet.repos').isVisible()), 'and leaves the screen open');

  // Connect: off to analyzing to ready, by SSE.
  const before = await debug(page, (d) => d.districts);
  const seen = new Set<string>();
  await page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].connect`).click();
  const analyzing = await waitStatus(page, 'marlow/tidepool-notes', 'analyzing', seen, 4000);
  check(analyzing, 'connecting shows the analysis under way');
  await page.waitForTimeout(500);
  const step = (await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-status`).textContent()) ?? '';
  check(/Cloning|Reading|Laying|Surveying/.test(step), `the analyzing row names its step (${step.trim()})`);
  await page.screenshot({ path: join(SHOTS, 'repos-analyzing.png') });
  const ready = await waitStatus(page, 'marlow/tidepool-notes', 'ready', seen);
  check(ready && seen.has('analyzing'), `the status passes through analyzing to ready (${[...seen].join(' > ')})`);
  const readyText = (await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-status`).textContent()) ?? '';
  check(/18 floors/.test(readyText), `ready shows the floor count (${readyText.trim()})`);
  const grew = await page
    .waitForFunction((n) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === n, before + 1, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(grew, 'the new district stands in the city');

  // An unreadable repo: a readable error and a Retry.
  const errSeen = new Set<string>();
  await page.locator(`${rowSel(UNREADABLE)} [role="switch"].connect`).click();
  const failed = await waitStatus(page, UNREADABLE, 'error', errSeen);
  check(failed, 'an unreadable repo ends in an error, not a hang');
  const msg = (await page.locator(`${rowSel(UNREADABLE)} .repo-error`).textContent()) ?? '';
  check(/could not find this repo/i.test(msg), `the error reads plainly (${msg.trim().slice(0, 60)})`);
  check(await page.locator(`${rowSel(UNREADABLE)} .repo-retry`).isVisible(), 'the error offers Retry');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'repos-states.png') });

  // Push mode by keyboard: focus the switch, Space flips it, and it persists.
  const push = page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].push`);
  await push.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const repos = (await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[];
  check(repos.find((r) => r.fullName === 'marlow/tidepool-notes')?.pushMode === true, 'Space on the push mode switch stores push mode');
  await page.screenshot({ path: join(SHOTS, 'repos-focus.png') });

  // Root style: pick another root, the tower is restyled.
  const target = SEED[0].fullName;
  await page.locator(`${rowSel(target)} [role="radio"][data-root="pagoda"]`).click();
  const restyled = await page
    .waitForFunction(
      (t) => fetch('/api/city').then((r) => r.json()).then((ds: Array<{ repo: string; tower: { root: string } }>) => ds.find((d) => d.repo === t)?.tower.root === 'pagoda'),
      target,
      { timeout: 4000 },
    )
    .then(() => true)
    .catch(() => false);
  check(restyled, 'picking a root restyles the tower');
  await page.locator(`${rowSel(target)} [role="radio"][data-root="beauxarts"]`).click();

  // Disconnect from the screen: the district leaves the city.
  const n = await debug(page, (d) => d.districts);
  await page.locator(`${rowSel('marlow/tidepool-notes')} .repo-disconnect`).click();
  const left = await page
    .waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, n - 1, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(left, 'disconnecting removes the district from the city');
  check(
    (await page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].connect`).getAttribute('aria-checked')) === 'false',
    'the disconnected repo shows as off',
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, 'repos-1280.png') });
  await page.setViewportSize(VIEWPORT);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.locator('.sheet.repos').isVisible()), 'Escape returns to the city');
}

/** Disconnecting a repo while the inspector is open on it closes the inspector and removes the district. */
async function disconnectWhileInspecting(page: Page): Promise<void> {
  const target = SEED[2].fullName;
  await page.evaluate((t) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(t), target);
  const open = await page.waitForSelector('.inspector.open', { timeout: 3000 }).then(() => true).catch(() => false);
  check(open, 'the inspector opens on the repo about to be disconnected');
  const n = await debug(page, (d) => d.districts);
  await page.evaluate(
    (t) => fetch(`/api/repos/${t}/disconnect`, { method: 'POST', headers: { 'x-palimpsest': '1' } }),
    target,
  );
  const gone = await page
    .waitForFunction((k) => (window as unknown as { __palimpsest: { districts: number } }).__palimpsest.districts === k, n - 1, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(gone, 'repo.disconnected removes its district');
  await page.waitForTimeout(300);
  check(!(await page.locator('.inspector').isVisible()), 'and closes the inspector open on it');
  await page.evaluate((t) => fetch(`/api/repos/${t}/connect`, { method: 'POST', headers: { 'x-palimpsest': '1' } }), target);
}

// ---------------------------------------------------------------- settings

function reading(atMs: number, five: number, week: number): string {
  const s = Math.floor(atMs / 1000);
  return `${JSON.stringify({ at: s, rate_limits: { five_hour: { used_percentage: five, resets_at: s + 2 * 3600 + 600 }, seven_day: { used_percentage: week, resets_at: s + 4 * 86400 } } })}\n`;
}

async function settingsChecks(page: Page, claudeSettingsPath: string): Promise<void> {
  const { paths } = await import('../engine/home.js');
  const readings = join(paths().usage, 'readings.jsonl');
  writeFileSync(readings, reading(Date.now() - 7 * 3600_000, 62, 18));

  await page.locator('.runhead a[data-route="settings"]').click();
  const shown = await page.waitForSelector('.sheet.settings .usage-five', { timeout: 5000 }).then(() => true).catch(() => false);
  check(shown, 'the Settings screen opens from the running head');
  if (!shown) return;
  await page.waitForTimeout(400);
  const five = (await page.locator('.usage-five .usage-pct').textContent())?.trim();
  const week = (await page.locator('.usage-week .usage-pct').textContent())?.trim();
  check(five === '62%' && week === '18%', `usage shows the seeded percentages (${five}, ${week})`);
  check(await page.locator('.usage-stale').isVisible(), 'an old reading carries the stale warning');
  check(/reset/i.test((await page.locator('.usage-five').textContent()) ?? ''), 'each window shows when it resets');
  check(/window reset/.test((await page.locator('.usage-five .usage-reset').textContent()) ?? ''), 'a reset already past reads as past');
  await page.screenshot({ path: join(SHOTS, 'settings.png') });
  await page.screenshot({ path: join(SHOTS, 'settings-full.png'), fullPage: false });

  // The usage hook, against the temp claude settings file only.
  const original = readFileSync(claudeSettingsPath, 'utf8');
  check(/not installed/i.test((await page.locator('.hook-state').textContent()) ?? ''), 'the hook reads as not installed');
  await page.locator('.hook-install').click();
  await page.waitForFunction(() => /installed/i.test(document.querySelector('.hook-state')?.textContent ?? '') && !/not/i.test(document.querySelector('.hook-state')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
  const installed = readFileSync(claudeSettingsPath, 'utf8');
  check(/statusLine/.test(installed), 'Install writes the hook into the (temp) claude settings');
  check(!/not/i.test((await page.locator('.hook-state').textContent()) ?? ''), 'the hook then reads as installed');
  await page.screenshot({ path: join(SHOTS, 'settings-hook.png') });
  await page.locator('.hook-remove').click();
  await page.waitForFunction(() => /not installed/i.test(document.querySelector('.hook-state')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
  check(readFileSync(claudeSettingsPath, 'utf8') === original, 'Remove restores the claude settings byte for byte');

  // Caps: typed, stored.
  const day = page.locator('input.cap-day');
  await day.fill('40');
  await day.press('Enter');
  await page.waitForTimeout(400);
  let st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.dayCapPct === 40, `the day cap is stored (${st.dayCapPct})`);
  await day.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.dayCapPct === 45, `ArrowUp steps the cap by 5 (${st.dayCapPct})`);
  await day.fill('50');
  await day.press('Enter');

  // Quality.
  await page.locator('[role="radio"][data-quality="medium"]').click();
  await page.waitForTimeout(400);
  st = (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))) as { dayCapPct: number; quality: string };
  check(st.quality === 'medium', 'quality is stored');
  await page.locator('[role="radio"][data-quality="high"]').click();

  // The kill switch.
  await page.locator('[role="switch"].kill').click();
  await page.waitForTimeout(500);
  check(existsSync(paths().stop), 'the kill switch writes the stop file');
  check(/stopped/i.test((await page.locator('.runhead').textContent()) ?? ''), 'the running head says the city is stopped');
  await page.locator('[role="switch"].kill').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'settings-stopped.png') });
  await page.locator('[role="switch"].kill').click();
  await page.waitForTimeout(500);
  check(!existsSync(paths().stop), 'turning it off removes the stop file');
  await page.locator('.settings-privacy').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, 'settings-privacy.png') });

  // A fresh reading: no warning.
  appendFileSync(readings, reading(Date.now() - 10 * 60_000, 23, 19));
  await page.locator('.runhead a[data-route="city"]').click();
  await page.locator('.runhead a[data-route="settings"]').click();
  await page.waitForTimeout(600);
  check((await page.locator('.usage-five .usage-pct').textContent())?.trim() === '23%', 'a new reading shows on reopening');
  check(!(await page.locator('.usage-stale').isVisible()), 'a fresh reading carries no stale warning');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'settings-1280.png') });
  await page.setViewportSize(VIEWPORT);
  await page.locator('#settings-title').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.locator('.sheet.settings').isVisible()), 'Escape leaves Settings for the city');
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
  const { setRunner } = await import('../engine/exec.js');
  setRunner(fakeGh);
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

      await measureFps(page);
      await inspectorChecks(page);
      await siteChecks(page);
      await disconnectWhileInspecting(page);
      await reposChecks(page);
      await settingsChecks(page, claudeSettingsPath);
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
