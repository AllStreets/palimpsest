/**
 * The screens' checks the end-to-end run takes outside the city (Phase 5
 * Task 0, moved unchanged from tools/ui-test.ts so the screens track never
 * edits that file): the Mac app's splash, the Repos screen against a fake
 * GitHub, a plot given back to the city when its repo goes, Settings
 * against a temp claude settings file, and every screen once more by its
 * address, and the command palette (Phase 5). tools/ui-test.ts hands over its check, its shots folder and its
 * viewport through screensHarness() before it calls any of them.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Browser, Page } from 'playwright';

import type { District, FirmView, Repo } from '../shared/types.js';
import { SAMPLE, SAMPLE_OTHERS, SAMPLE_UNREADABLE } from './sample.js';

type Check = (ok: boolean, what: string) => void;

/** What the run hands over: its check, its shots folder, its viewport, and a switch for requests aborted on purpose. */
export interface ScreensHarness {
  check: Check;
  shots: string;
  viewport: { width: number; height: number };
  /** True while a check aborts requests on purpose: the browser's own "Failed to load resource" line is then expected. */
  aborting(on: boolean): void;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEARING = { x: 0.63, z: 0.78 };
let check: Check = () => {
  throw new Error('ui-test-screens: screensHarness() was not called');
};
let SHOTS = '';
let VIEWPORT = { width: 1600, height: 940 };
let aborting: (on: boolean) => void = () => {};

export function screensHarness(h: ScreensHarness): void {
  check = h.check;
  SHOTS = h.shots;
  VIEWPORT = h.viewport;
  aborting = h.aborting;
}

/** The debug handle's fields these checks read. */
interface Debug {
  districts: number;
  sites: number;
  plots(): { plazas: number; buildings: number };
  rebuilding(): number;
}

function debug<T>(page: Page, read: (d: Debug) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__palimpsest)`) as Promise<T>;
}

const cityOf = (page: Page): Promise<District[]> =>
  page.evaluate(() => fetch('/api/city').then((r) => r.json())) as Promise<District[]>;

async function setView(page: Page, eye: number[], target: number[]): Promise<void> {
  await page.evaluate(([e, t]) => {
    (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t);
  }, [eye, target]);
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------- a fake GitHub

/** Repos the fake gh can see: the sample districts plus a few that are not in the city yet. All fictional. */
const AVAILABLE = [...SAMPLE.map((s) => ({ fullName: s.fullName })), ...SAMPLE_OTHERS];
const UNREADABLE = SAMPLE_UNREADABLE;

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

export async function reposChecks(page: Page): Promise<void> {
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

  // Rapid on, off, on while the first connect is in flight: the last choice wins.
  const quick = 'quill/marginalia';
  const sw = page.locator(`${rowSel(quick)} [role="switch"].connect`);
  await sw.click();
  await sw.click();
  await sw.click();
  const quickSeen = new Set<string>();
  const quickReady = await waitStatus(page, quick, 'ready', quickSeen);
  const quickRepo = ((await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[]).find((r) => r.fullName === quick);
  check(quickReady && quickRepo?.connected === true, `a rapid on, off, on ends connected and ready (${[...quickSeen].join(' > ')})`);
  check((await sw.getAttribute('aria-checked')) === 'true', 'and the switch shows on');

  // The running head and the facts line count the same thing.
  const head = (await page.locator('.runhead-count').textContent())?.trim();
  const facts = (await page.locator('.sheet.repos .sheet-facts').textContent()) ?? '';
  check(facts.startsWith(`${head} of`), `the running head count matches the facts line (${head}; ${facts.split('.')[0]})`);

  // Push mode by keyboard: focus the switch, Space flips it, and it persists.
  const push = page.locator(`${rowSel('marlow/tidepool-notes')} [role="switch"].push`);
  await push.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const repos = (await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[];
  check(repos.find((r) => r.fullName === 'marlow/tidepool-notes')?.pushMode === true, 'Space on the push mode switch stores push mode');
  await page.screenshot({ path: join(SHOTS, 'repos-focus.png') });

  // Push mode on a repo without a test and a build command (ruling 23): refused quietly beside the switch, which stays off.
  const refusedPush = page.locator(`${rowSel('kestrel/fieldnotes')} [role="switch"].push`);
  await refusedPush.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const why = ((await page.locator(`${rowSel('kestrel/fieldnotes')} .repo-push-why`).textContent()) ?? '').trim();
  const afterRefusal = (await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[];
  check(
    (await refusedPush.getAttribute('aria-checked')) === 'false' && afterRefusal.find((r) => r.fullName === 'kestrel/fieldnotes')?.pushMode === false && /test command and a build command/.test(why),
    `push mode without a test and a build stays off and says why (${why.slice(0, 60)})`,
  );

  // Root style: pick another root, the tower is restyled.
  const target = SAMPLE[0].fullName;
  // Said in plain words (audit 2026-11-17): the group is named and described, and every glyph has a name of its own.
  const rootGroup = page.locator(`${rowSel(target)} .root-picker`);
  const rootSaid = await rootGroup.evaluate((g) => ({
    label: document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
    note: document.getElementById(g.getAttribute('aria-describedby') ?? '')?.textContent ?? '',
    names: [...g.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute('aria-label') ?? ''),
  }));
  check(rootSaid.label === 'Tower root' && /base style of this repo's tower/.test(rootSaid.note) && /rebuilds the tower/.test(rootSaid.note), `the Root control says what a root is and that it changes the tower (${rootSaid.label}: ${rootSaid.note})`);
  check(rootSaid.names.length === 5 && rootSaid.names.every((n) => / root$/.test(n)), `each root glyph has an accessible name (${rootSaid.names.join(', ')})`);
  check(await page.locator(`${rowSel(target)} .repo-root-note`).isVisible(), 'and the words stand on the screen, not only for a screen reader');
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

// ---------------------------------------------------------------- plots given back to the city

const post = (page: Page, path: string): Promise<unknown> =>
  page.evaluate((p) => fetch(p, { method: 'POST', headers: { 'x-palimpsest': '1' } }).then((r) => r.json()), path);

type Plots = { plazas: number; buildings: number; sites: number; districts: number };

const plotsNow = (page: Page): Promise<Plots> => debug(page, (d) => ({ ...d.plots(), sites: d.sites, districts: d.districts }));

/** How long a rebuild may take to stand: the quarters' debounce, the plazas laid a block at a time, a freed plot's rise. */
const REBUILT_MS = 20_000;

/**
 * The plots once the city stands as last asked (Task 13): a change is built off screen a step at a time and swapped in,
 * and the ambient blocks are laid again in place a block at a time, so their count read mid-rebuild is neither the old
 * city's nor the new one's. Read only when nothing is being rebuilt (debug.rebuilding() is 0), or null if it never was.
 */
async function standingPlots(page: Page, timeoutMs = REBUILT_MS): Promise<Plots | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await debug(page, (d) => d.rebuilding())) === 0) {
      const p = await plotsNow(page);
      if ((await debug(page, (d) => d.rebuilding())) === 0) return p;
    }
    await page.waitForTimeout(50);
  }
  return null;
}

/** Waits until the city stands with plots matching `want` (nothing left rebuilding), or gives up after `timeoutMs`. */
async function waitPlots(page: Page, want: (p: Plots) => boolean, timeoutMs = REBUILT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await standingPlots(page, deadline - Date.now());
    if (p && want(p)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

/** A high oblique view of a slot's plot and the blocks round it. */
async function plotView(page: Page, slot: number): Promise<void> {
  const { districtOrigin } = await import('../shared/district-layout.js');
  const o = districtOrigin(slot);
  await setView(page, [o.x + BEARING.x * 300, 150, o.z + BEARING.z * 300], [o.x, 0, o.z]);
}

const repoRow = async (page: Page, fullName: string): Promise<Repo | undefined> =>
  ((await page.evaluate(() => fetch('/api/repos').then((r) => r.json()))) as Repo[]).find((r) => r.fullName === fullName);

/**
 * A repo that is not connected leaves no plaza: a connect stopped before any
 * tower, and a district disconnected, both give the plot back to the same
 * ambient blocks, live; reconnecting clears the plot again.
 */
export async function freedPlotChecks(page: Page): Promise<void> {
  // Each count is read with the city standing: the checks before this one (the Repos screen's disconnect) leave a
  // rebuild in flight, and a count taken in its middle is no baseline.
  const base = await standingPlots(page);
  check(base !== null, 'the city stands, nothing rebuilding, before the freed-plot checks');
  if (!base) return;

  // A connect stopped while it analyzes: the scaffold comes down and stays down while the analysis runs on.
  const stopped = 'orrery/star-catalogue';
  const { slot } = (await post(page, `/api/repos/${stopped}/connect`)) as Repo;
  const raised = await waitPlots(page, (p) => p.sites === base.sites + 1 && p.plazas === base.plazas + 1);
  check(raised, 'connecting raises a scaffold on a paved plot');
  await plotView(page, slot);
  await page.screenshot({ path: join(SHOTS, 'plot-stopped-before.png') });
  await post(page, `/api/repos/${stopped}/disconnect`);
  const cleared = await waitPlots(page, (p) => p.sites === base.sites && p.plazas === base.plazas);
  let worst = await plotsNow(page);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await repoRow(page, stopped))?.status === 'analyzing') {
    const now = await plotsNow(page);
    if (now.sites > worst.sites || now.plazas > worst.plazas) worst = now;
    await page.waitForTimeout(40);
  }
  const after = (await standingPlots(page)) ?? (await plotsNow(page));
  if (after.sites > worst.sites || after.plazas > worst.plazas) worst = after;
  const row = await repoRow(page, stopped);
  check(row?.connected === false && row.status !== 'analyzing', `the stopped connect finished its analysis and stays off (${row?.connected}, ${row?.status})`);
  check(
    cleared && worst.sites === base.sites && worst.plazas === base.plazas,
    `a stopped connect leaves no scaffold or plaza while its analysis runs on (sites ${worst.sites} of ${base.sites}, plazas ${worst.plazas} of ${base.plazas})`,
  );
  check(after.buildings === base.buildings, `and its plot holds the same ambient blocks as before (${after.buildings} of ${base.buildings})`);
  await plotView(page, slot);
  await page.screenshot({ path: join(SHOTS, 'plot-stopped-after.png') });

  // A standing district disconnected: its plaza goes and the blocks that stood there before return, without a reload.
  const target = SAMPLE[1].fullName;
  const d = (await cityOf(page)).find((x) => x.repo === target);
  if (!d) {
    check(false, `${target} stands before the disconnect check`);
    return;
  }
  const withIt = (await standingPlots(page)) ?? (await plotsNow(page));
  await plotView(page, d.index);
  await page.screenshot({ path: join(SHOTS, 'plot-district-before.png') });
  await post(page, `/api/repos/${target}/disconnect`);
  const freed = await waitPlots(page, (p) => p.plazas === withIt.plazas - 1 && p.districts === withIt.districts - 1);
  const without = (await standingPlots(page)) ?? (await plotsNow(page));
  check(freed, `disconnecting a district removes its plaza (${withIt.plazas} then ${without.plazas})`);
  check(without.buildings > withIt.buildings, `and fills its plot with ambient blocks (${withIt.buildings} then ${without.buildings} buildings)`);
  await plotView(page, d.index);
  await page.screenshot({ path: join(SHOTS, 'plot-district-after.png') });

  // Reconnecting clears the plot again: the tower it kept returns to the same place.
  await post(page, `/api/repos/${target}/connect`);
  const back = await waitPlots(page, (p) => p.plazas === withIt.plazas && p.districts === withIt.districts && p.buildings === withIt.buildings);
  check(back, 'reconnecting clears the plot for the district again, with the same blocks round it');
  const returned = (await cityOf(page)).find((x) => x.repo === target);
  check(returned?.index === d.index, `and the district returns to its slot (${returned?.index} of ${d.index})`);
  for (let i = 0; i < 300 && (await repoRow(page, target))?.status === 'analyzing'; i++) await page.waitForTimeout(50);
}

// ---------------------------------------------------------------- settings

function reading(atMs: number, five: number, week: number): string {
  const s = Math.floor(atMs / 1000);
  return `${JSON.stringify({ at: s, rate_limits: { five_hour: { used_percentage: five, resets_at: s + 2 * 3600 + 600 }, seven_day: { used_percentage: week, resets_at: s + 4 * 86400 } } })}\n`;
}

export async function settingsChecks(page: Page, claudeSettingsPath: string): Promise<void> {
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
  // Settings shows each window as it stands now, the brief's own figure (GET /api/usage now): the seeded five-hour
  // window of 62% has reset since, so it stands at what was spent after the reset; the week holds its 18%.
  const usageNow = ((await page.evaluate(() => fetch('/api/usage').then((r) => r.json()))) as { now: { fiveHour: number | null; sevenDay: number | null } | null }).now;
  const want = { five: `${usageNow?.fiveHour ?? 62}%`, week: `${usageNow?.sevenDay ?? 18}%` };
  check(five === want.five && week === want.week && week === '18%', `usage shows each window as it stands now, as the brief does (${five}, ${week}; the engine says ${want.five}, ${want.week})`);
  check(await page.locator('.usage-stale').isVisible(), 'an old reading carries the stale warning');
  check(/reset/i.test((await page.locator('.usage-five').textContent()) ?? ''), 'each window shows when it resets');
  check(/^reset at \d\d:\d\d, after the last reading$/.test((await page.locator('.usage-five .usage-reset').textContent()) ?? ''), 'a reset already past reads as past');
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
  let capPatches = 0;
  const countPatch = (r: { method(): string; url(): string }) => {
    if (r.method() === 'PATCH' && r.url().endsWith('/api/settings')) capPatches++;
  };
  page.on('request', countPatch);
  await day.fill('40');
  await day.press('Enter');
  await day.blur();
  await page.waitForTimeout(400);
  page.off('request', countPatch);
  check(capPatches === 1, `Enter then leaving the field sends one PATCH (${capPatches})`);
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
  // The city draws at high (no drop): a stored Medium waits for a reopen, and High again has nothing to reopen.
  const qNote = page.locator('.quality-note');
  check(/Takes effect when the city reopens\./.test((await qNote.textContent()) ?? '') && (await qNote.locator('.quality-reload').textContent()) === 'Reopen now', 'a stored Medium, with the city at high, offers Reopen now');
  await page.locator('[role="radio"][data-quality="high"]').click();
  await page.waitForTimeout(400);
  check((await qNote.textContent()) === 'Read when the city opens.' && (await qNote.locator('.quality-reload').count()) === 0, 'the stored High, with the city at high, has nothing to reopen');

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

  // The engine not answering: no empty fields, no buttons, a plain sentence.
  await page.locator('.runhead a[data-route="city"]').click();
  aborting(true);
  await page.route('**/api/settings', (r) => r.abort());
  await page.locator('.runhead a[data-route="settings"]').click();
  await page.waitForTimeout(600);
  check(/did not answer/.test((await page.locator('.hook-state').textContent()) ?? ''), 'settings that fail to load say the engine did not answer');
  check(!(await page.locator('.hook-install').isVisible()) && !(await page.locator('.hook-remove').isVisible()), 'and show neither hook button');
  check(!(await page.locator('input.cap-day').isVisible()), 'and no empty cap fields');
  await page.screenshot({ path: join(SHOTS, 'settings-down.png') });
  await page.unroute('**/api/settings');
  aborting(false);
  await page.locator('#settings-title').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!(await page.locator('.sheet.settings').isVisible()), 'Escape leaves Settings for the city');
}

// ---------------------------------------------------------------- the splash

/**
 * The Mac app's splash, opened from its files with Tauri's invoke stood in.
 * When the engine answers but the window cannot be swapped for the city, the
 * splash must not freeze on its hairline: it shows the engine-down state with
 * the reason and a working Start button, both at launch and after Start.
 */
export async function splashChecks(browser: Browser): Promise<void> {
  const splash = pathToFileURL(join(ROOT, 'src-tauri', 'splash', 'index.html')).href;
  for (const [when, healthyAtLaunch] of [['at launch', true], ['after Start', false]] as const) {
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // A string, not a function: tsx would wrap a function in helpers the page does not have.
    await page.addInitScript(`
      let installed = false;
      window.__TAURI__ = {
        core: {
          invoke: async (cmd) => {
            if (cmd === 'engine_healthy') return ${healthyAtLaunch} || installed;
            if (cmd === 'engine_command') return 'node ~/palimpsest/bin/palimpsest.mjs engine install';
            if (cmd === 'install_engine') { installed = true; return null; }
            if (cmd === 'open_city') throw 'the window is gone';
            throw new Error('unexpected ' + cmd);
          },
        },
      };
    `);
    await page.goto(splash);
    if (!healthyAtLaunch) {
      await page.waitForFunction(() => document.body.dataset.state === 'down', null, { timeout: 8000 });
      await page.locator('#start').click();
    }
    const shown = await page
      .waitForFunction(() => document.body.dataset.state === 'down' && !document.getElementById('error')!.hidden, null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const text = (await page.locator('#error').textContent()) ?? '';
    if (when === 'at launch') {
      const mark = await page
        .locator('.sheet img.mark')
        .evaluate((img) => {
          const el = img as HTMLImageElement;
          const r = el.getBoundingClientRect();
          return { loaded: el.complete && el.naturalWidth > 0, w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 && getComputedStyle(el).visibility !== 'hidden' };
        })
        .catch(() => null);
      const name = ((await page.locator('.sheet h1.name').textContent().catch(() => '')) ?? '').trim();
      check(!!mark && mark.loaded && mark.shown && mark.w >= 96 && mark.w === mark.h && name === 'Palimpsest', `the splash shows the mark and the name (${mark ? `${mark.w}x${mark.h}, loaded ${mark.loaded}` : 'no mark'}; "${name}")`);
    }
    check(shown && /could not open the city/i.test(text) && /window is gone/.test(text), `splash ${when}: a failed open shows the engine-down state with the reason (${text || 'nothing shown'})`);
    check(!(await page.locator('#start').isDisabled()), `splash ${when}: Start the engine works again`);
    check(errors.length === 0, `splash ${when}: no unhandled errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
}


// ---------------------------------------------------------------- the mark

/**
 * The mark where the window shows it (Task 22): the running head draws it at
 * 18 px before the name, and the browser tab's favicon is served as a PNG.
 */
export async function brandChecks(page: Page): Promise<void> {
  const head = await page
    .locator('.runhead img.runhead-icon')
    .evaluate((img) => {
      const el = img as HTMLImageElement;
      const r = el.getBoundingClientRect();
      const name = el.nextElementSibling as HTMLElement | null;
      const nr = name?.getBoundingClientRect();
      return {
        loaded: el.complete && el.naturalWidth > 0,
        w: Math.round(r.width),
        h: Math.round(r.height),
        beforeName: !!nr && r.right <= nr.left + 1 && Math.abs((r.top + r.bottom) / 2 - (nr.top + nr.bottom) / 2) < 8,
        src: el.currentSrc,
      };
    })
    .catch(() => null);
  check(!!head && head.loaded && head.w === 18 && head.h === 18 && head.beforeName, `the running head draws the mark at 18 px (${head ? `${head.w}x${head.h}, loaded ${head.loaded}, before the name ${head.beforeName}, ${head.src}` : 'no mark'})`);
  const favicon = (await page.evaluate(async () => {
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (!link) return { href: null, status: 0, type: '' };
    const r = await fetch(link.href);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const png = bytes.length > 8 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    return { href: link.getAttribute('href'), status: r.status, type: r.headers.get('content-type') ?? '', png };
  })) as { href: string | null; status: number; type: string; png?: boolean };
  check(favicon.href !== null && favicon.status === 200 && favicon.png === true, `the favicon is served (${favicon.href ?? 'no link'}: ${favicon.status} ${favicon.type})`);
  await page.screenshot({ path: join(SHOTS, 'brand-runhead.png'), clip: { x: 0, y: 0, width: 520, height: 70 } });
}

// ---------------------------------------------------------------- every screen by its address

/**
 * Every screen once more, by its address, after the whole run has moved the economy on (Task 42): each opens on its
 * sheet and adds no console error of its own. The ids are read from the engine, so each page opens on a real record.
 */
export async function everyScreenChecks(page: Page, errors: string[]): Promise<void> {
  const api = <T>(path: string): Promise<T> => page.evaluate((p) => fetch(p).then((r) => r.json()), path) as Promise<T>;
  const jobs = await api<Array<{ id: string; runId: string | null }>>('/api/jobs');
  const firms = await api<FirmView[]>('/api/firms');
  const withRun = jobs.find((j) => j.runId);
  const detail = withRun ? await api<{ inspections: Array<{ id: string }> }>(`/api/jobs/${withRun.id}`) : null;
  const screens: Array<[string, string, string]> = [
    ['city', '#/', '.runhead'],
    ['job board', '#/jobs', '.sheet.jobs, .sheet .sec-bidding, .sheet-title'],
    ...(jobs[0] ? ([['job', `#/jobs/${jobs[0].id}`, '.sheet.jobpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(withRun?.runId ? ([['run', `#/runs/${withRun.runId}`, '.runpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(detail?.inspections[0] ? ([['inspection', `#/inspections/${detail.inspections[0].id}`, '.insppage .sheet-title']] as Array<[string, string, string]>) : []),
    ['firms', '#/firms', '.sheet.firms .firm-row'],
    ...(firms[0] ? ([['firm', `#/firms/${firms[0].id}`, '.sheet.firmpage .sheet-title']] as Array<[string, string, string]>) : []),
    ...(firms[0]?.agents[0] ? ([['agent', `#/agents/${firms[0].agents[0].id}`, '.sheet.agentpage .sheet-title']] as Array<[string, string, string]>) : []),
    ['treasury', '#/treasury', '.sheet.treasury .sheet-title'],
    ['school', '#/school', '.sheet.school .net-row'],
    ['repos', '#/repos', '.sheet.repos .sheet-title'],
    ['district', `#/repos/${SAMPLE[0].fullName}`, '.sheet.district .sheet-title'],
    ['settings', '#/settings', '.sheet.settings .sheet-title'],
  ];
  for (const [name, hash, ready] of screens) {
    const before = errors.length;
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    const shown = await page
      .waitForSelector(ready, { state: 'attached', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(600);
    const fresh = errors.slice(before);
    check(shown && fresh.length === 0, `the ${name} screen opens at ${hash} with no console error${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
  }
  // The running head lights one place on every screen, whatever the pointer last touched.
  await navLightingChecks(page);
  // The command palette (Phase 5), over the city and over a screen.
  await paletteChecks(page, errors);
  await page.evaluate(() => {
    location.hash = '#/';
  });
  // The screens' city pins and lock-on (screens redesign Task 10), from the gallery's pins kind.
  await pinsChecks(page, errors);
  // Terminal mode (screens redesign Task 12), from the gallery's terminal kind.
  await terminalChecks(page, errors);
}

// ---------------------------------------------------------------- the city pins (screens redesign Task 10)

/** The gallery's handle, its frame hook count, and the plates' drawn opacity. */
const gallery = (page: Page, kind: string | null): Promise<void> =>
  page.evaluate((k) => (window as unknown as { __palimpsest: { osGallery(k: string | null): void } }).__palimpsest.osGallery(k), kind);
const frameHooks = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __palimpsest: { frameHooks(): number } }).__palimpsest.frameHooks());
const platesOpacity = (page: Page): Promise<string> => page.evaluate(() => {
  const p = document.querySelector('.plates');
  return p ? getComputedStyle(p).opacity : 'none';
});

/**
 * The pins over the sample city (Review Focus 2 and 3): with targets, pins stand and the city's own plates fade;
 * a target whose district does not stand makes no pin and no error; unmounted, the plates are back within 600 ms,
 * the frame hook is gone and no pin is left; five opens and closes in two seconds leave the same. Shot: pins.png.
 */
export async function pinsChecks(page: Page, errors: string[]): Promise<void> {
  const before = errors.length;
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForSelector('body[data-route="city"]', { timeout: 8000 });
  await gallery(page, 'pins');
  const mounted = await page
    .waitForSelector('.os-gallery[data-kind="pins"] .os-pins', { state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(mounted, 'the gallery\'s pins kind mounts over the city');
  if (!mounted) return;
  // A frame or two to measure the tags, and the plates' 450 ms fade.
  await page.waitForTimeout(900);
  const targets = await page.locator('.os-gallery[data-kind="pins"] .os-sample-row[data-target]').count();
  const on = await page.locator('.os-pin.on').count();
  check(targets >= 3 && on > 0, `with ${targets} targets, ${on} pins stand on their towers`);
  check((await platesOpacity(page)) === '0', `the city's own plates fade while the pins show (${await platesOpacity(page)})`);
  check((await frameHooks(page)) === 1, `the pins run one frame hook (${await frameHooks(page)})`);
  const unbuilt = await page.locator('.os-sample-row[data-target][data-unbuilt]').count();
  const unbuiltPins = await page.evaluate(() => {
    const repos = [...document.querySelectorAll<HTMLElement>('.os-sample-row[data-unbuilt]')].map((r) => r.dataset.repo);
    return [...document.querySelectorAll<HTMLElement>('.os-pin')].filter((p) => repos.includes(p.dataset.repo)).length;
  });
  check(unbuilt === 1 && unbuiltPins === 0 && errors.length === before, `a target whose district does not stand makes no pin and no error (${unbuilt} such, ${unbuiltPins} pins)`);
  await page.screenshot({ path: join(SHOTS, 'pins.png') });

  await gallery(page, null);
  const back = await page
    .waitForFunction(() => {
      const p = document.querySelector('.plates');
      return !p || getComputedStyle(p).opacity === '1';
    }, null, { timeout: 600, polling: 'raf' })
    .then(() => true)
    .catch(() => false);
  check(back, `unmounted, the plates are back at full opacity within 600 ms (${await platesOpacity(page)})`);
  check((await frameHooks(page)) === 0, `unmounted, no frame hook is left (${await frameHooks(page)})`);
  check((await page.locator('.os-pin').count()) === 0, 'unmounted, no pin is left in the page');

  // Five opens and closes in two seconds (Review Focus 3).
  for (let i = 0; i < 5; i++) {
    await gallery(page, 'pins');
    await page.waitForTimeout(200);
    await gallery(page, null);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);
  check((await frameHooks(page)) === 0 && (await platesOpacity(page)) === '1' && (await page.locator('.os-pin').count()) === 0, `five opens and closes in two seconds leave no hook, no pin and the plates whole (${await frameHooks(page)} hooks, plates ${await platesOpacity(page)})`);
  const fresh = errors.slice(before);
  check(fresh.length === 0, `the pins raised no console error${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
}

// ---------------------------------------------------------------- terminal mode (screens redesign Task 12)

/** What terminal mode shows: the mode on <html>, the city host's drawn filter, where focus is, and the panel's edges. */
async function terminalState(page: Page): Promise<{ mode: string | null; filter: string; focus: string; top: number; bottom: number; lines: number; shown: boolean; held: boolean }> {
  return page.evaluate(() => {
    const term = document.querySelector<HTMLElement>('.os-terminal');
    const r = term?.getBoundingClientRect();
    const a = document.activeElement as HTMLElement | null;
    const focus = !a || a === document.body ? 'body' : a.closest('.os-terminal') ? 'terminal' : a.matches('[data-terminal-opener]') ? 'opener' : a.className;
    return {
      mode: document.documentElement.getAttribute('data-os-mode'),
      filter: getComputedStyle(document.getElementById('city')!).filter,
      focus,
      top: r ? Math.round(r.top) : -1,
      bottom: r ? Math.round(innerHeight - r.bottom) : -1,
      lines: term?.querySelectorAll('.os-terminal-body > *').length ?? 0,
      shown: !!term && !term.hidden && getComputedStyle(term).display !== 'none',
      held: (window as unknown as { __palimpsest: { cityHeld(): boolean } }).__palimpsest.cityHeld(),
    };
  });
}

/**
 * Terminal mode over the sample city (Task 12): the gallery's terminal kind opens it from its opener, so html
 * carries data-os-mode="terminal", the city host is blurred and dimmed, and the panel stands 64 px under the top
 * and 16 px over the foot with its 80 lines; Escape and Close each take the mode off, hand focus back to the
 * opener and leave the city host with no filter; unmounted while open, the mode goes with it. Shot: terminal.png.
 */
export async function terminalChecks(page: Page, errors: string[]): Promise<void> {
  const before = errors.length;
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForSelector('body[data-route="city"]', { timeout: 8000 });
  await gallery(page, 'terminal');
  const mounted = await page
    .waitForSelector('.os-terminal', { state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(mounted, 'the gallery\'s terminal kind opens the terminal over the city');
  if (!mounted) return;
  // The city's filter eases in over MOTION.slow.
  await page.waitForTimeout(700);
  let s = await terminalState(page);
  check(s.mode === 'terminal', `terminal mode is set on html (data-os-mode=${s.mode})`);
  check(/blur\(6px\)/.test(s.filter) && /brightness\(0\.3\)/.test(s.filter) && /saturate\(0\.6\)/.test(s.filter), `the city host is blurred and dimmed behind it (${s.filter})`);
  check(s.top === 64 && s.bottom === 16, `the panel stands 64 px under the top and 16 px over the foot (${s.top}, ${s.bottom})`);
  check(s.lines === 80, `the sample run log shows its 80 lines (${s.lines})`);
  check(s.focus === 'terminal', `focus is in the terminal while it is open (${s.focus})`);
  check(s.held, 'the city holds still behind the open terminal');
  await page.screenshot({ path: join(SHOTS, 'terminal.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  s = await terminalState(page);
  check(s.mode === null && !s.shown, `Escape takes terminal mode off (data-os-mode=${s.mode}, shown ${s.shown})`);
  check(s.focus === 'opener', `Escape hands focus back to the opener (${s.focus})`);
  check(s.filter === 'none', `closed, the city host has no filter (${s.filter})`);
  check(!s.held, 'Escape lets the city draw again');

  // Opened again from its opener, and closed with the Close key.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  s = await terminalState(page);
  check(s.mode === 'terminal' && s.shown, `the opener opens it again (data-os-mode=${s.mode})`);
  await page.locator('.os-terminal .os-terminal-close').click();
  await page.waitForTimeout(100);
  s = await terminalState(page);
  check(s.mode === null && s.focus === 'opener' && s.filter === 'none' && !s.held, `Close takes it off, hands focus back and lets the city draw (data-os-mode=${s.mode}, focus ${s.focus}, ${s.filter}, held ${s.held})`);

  // Unmounted while open: the mode leaves with it.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check((await terminalState(page)).held, 'opened again, the city holds once the blur is in');
  await gallery(page, null);
  await page.waitForTimeout(100);
  s = await terminalState(page);
  check(s.mode === null && s.filter === 'none' && !s.held && (await page.locator('.os-terminal').count()) === 0, `unmounted while open, no mode, filter, hold or panel is left (data-os-mode=${s.mode}, ${s.filter}, held ${s.held})`);
  const fresh = errors.slice(before);
  check(fresh.length === 0, `the terminal raised no console error${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
}

// ---------------------------------------------------------------- the running head's lighting

/** Each head link's route, its drawn colour and whether it is the current place. */
export async function headColours(page: Page): Promise<Array<{ route: string; color: string; current: boolean }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('.runhead-link')].map((a) => ({
      route: a.dataset.route ?? '',
      color: getComputedStyle(a).color,
      current: a.getAttribute('aria-current') === 'page',
    })),
  );
}

/**
 * The lit place is the current one alone (audit 2026-11-17): every idle link draws in one colour and only the
 * aria-current link differs. Taken the way the stills reached each screen: City clicked from the head, the pointer
 * left resting on it, then each screen opened by its address (as the palette, a plate or a brief row would).
 */
export async function navLightingChecks(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = '#/brief';
  });
  await page.waitForSelector('body[data-route="brief"]', { timeout: 8000 });
  await page.locator('.runhead a[data-route="city"]').click();
  await page.waitForSelector('body[data-route="city"]', { timeout: 8000 });
  for (const route of ['brief', 'jobs', 'school', 'treasury', 'settings', 'firms', 'repos']) {
    await page.evaluate((r) => {
      location.hash = `#/${r}`;
    }, route);
    await page.waitForSelector(`body[data-route="${route}"]`, { timeout: 8000 });
    const links = await headColours(page);
    const current = links.filter((l) => l.current);
    const idle = new Set(links.filter((l) => !l.current).map((l) => l.color));
    const ok = current.length === 1 && current[0].route === route && idle.size === 1 && !idle.has(current[0].color);
    check(ok, `on ${route} with the pointer resting on City, every idle head link draws in one colour and only ${route} differs${ok ? '' : `: ${JSON.stringify(links)}`}`);
  }
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 40);
}

// ---------------------------------------------------------------- the command palette (Phase 5)

/** The palette's rows as shown: kind, name, state and which is selected. */
async function paletteRows(page: Page): Promise<Array<{ kind: string; name: string; state: string; selected: boolean }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.palette-row')].map((r) => ({
      kind: r.querySelector('.palette-kind')?.textContent ?? '',
      name: r.querySelector('.palette-name')?.textContent ?? '',
      state: r.querySelector('.palette-state')?.textContent ?? '',
      selected: r.getAttribute('aria-selected') === 'true',
    })),
  );
}

const paletteOpen = (page: Page): Promise<boolean> => page.evaluate(() => !document.querySelector<HTMLElement>('.palette')!.hidden);
const activeIs = (page: Page, sel: string): Promise<boolean> => page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
const camera = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as { __palimpsest: { camera(): number[] } }).__palimpsest.camera());
const moved = (a: number[], b: number[]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1;

/** Opens the palette with the keyboard and waits for its first read. */
async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('.palette:not([hidden])', { timeout: 4000 });
  await page.waitForFunction(() => document.querySelectorAll('.palette-row').length > 0, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(350);
}

/**
 * Cmd+K opens the palette over the city and over a screen; the empty query
 * counts the city and lists pages; typing filters one ranked list; Enter on a
 * district flies the city, on a firm flies to its quarter, on a net opens its
 * school page; Escape and a click outside close it, with focus back where it
 * was; all of it by keyboard. Shots: palette-empty.png and palette-query.png.
 */
export async function paletteChecks(page: Page, errors: string[]): Promise<void> {
  const before = errors.length;
  const api = <T>(path: string): Promise<T> => page.evaluate((p) => fetch(p).then((r) => r.json()), path) as Promise<T>;
  const repos = await api<Repo[]>('/api/repos');
  const firms = await api<FirmView[]>('/api/firms');
  const city = await api<District[]>('/api/city');
  const school = await api<{ nets: Array<{ net: string }> }>('/api/school');
  const standing = repos.filter((r) => r.connected && city.some((d) => d.repo === r.fullName));

  // From the city, by the keyboard, with focus on a link of the running head first so its return can be seen.
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForTimeout(600);
  await page.focus('.runhead a[data-route="jobs"]');
  await openPalette(page);
  check(await paletteOpen(page), 'Cmd+K opens the palette over the city');
  check(await activeIs(page, '.palette-input'), 'the palette takes focus into its field');
  check(await page.evaluate(() => document.querySelector('.palette')?.getAttribute('role') === 'dialog' && document.querySelector('.palette')?.getAttribute('aria-modal') === 'true' && document.querySelector('.palette-input')?.getAttribute('role') === 'combobox' && document.querySelector('.palette-list')?.getAttribute('role') === 'listbox'), 'the palette is a dialog with a combobox over a listbox, labelled for a screen reader');
  let rows = await paletteRows(page);
  const foot = (await page.locator('.palette-foot').textContent()) ?? '';
  check(/^The city holds \d+ districts? and \d+ floors?, \d+ firms? and \d+ agents?\.$/.test(foot), `the empty query counts what the city holds: "${foot}"`);
  check(rows.length > 0 && rows[0].selected && rows.some((r) => r.kind === 'Page' && r.name === 'Treasury'), `the empty query lists the pages with the first row selected (${rows.length} rows)`);
  await page.screenshot({ path: join(SHOTS, 'palette-empty.png') });
  // Tab stays inside.
  await page.keyboard.press('Tab');
  check(await activeIs(page, '.palette-input'), 'Tab keeps focus inside the palette');
  // Arrow keys move the selection and the field says which row is active.
  await page.keyboard.press('ArrowDown');
  rows = await paletteRows(page);
  check(rows[1]?.selected === true && (await page.evaluate(() => document.querySelector('.palette-input')?.getAttribute('aria-activedescendant'))) === 'palette-opt-1', 'ArrowDown moves the selection and aria-activedescendant follows');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  rows = await paletteRows(page);
  check(rows.at(-1)?.selected === true, 'ArrowUp from the first row wraps to the last');
  // Escape closes and focus returns to the link that had it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await paletteOpen(page)), 'Escape closes the palette');
  check(await activeIs(page, '.runhead a[data-route="jobs"]'), 'focus returns to where it was before the palette opened');
  check(await page.evaluate(() => document.body.dataset.route === 'city'), 'Escape in the palette does not leave the city or close anything else');

  // A district: the query filters one ranked list, the first row the repo by prefix, and Enter flies the city to it.
  const target = standing[0];
  if (target) {
    const prefix = target.fullName.slice(0, 5);
    await openPalette(page);
    await page.keyboard.type(prefix);
    await page.waitForTimeout(250);
    rows = await paletteRows(page);
    check(rows[0]?.kind === 'District' && rows[0].name === target.fullName && /\d+ floors?/.test(rows[0].state), `typing "${prefix}" puts the district ${target.fullName} first with its floors: ${JSON.stringify(rows[0])}`);
    check(rows.every((r) => new RegExp(prefix, 'i').test(`${r.name} ${r.state}`) || r.kind !== 'Page'), 'every row shown answers to the query');
    await page.screenshot({ path: join(SHOTS, 'palette-query.png') });
    const cam0 = await camera(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);
    check(!(await paletteOpen(page)), 'Enter closes the palette');
    check(await page.evaluate(() => document.body.dataset.route === 'city') && moved(cam0, await camera(page)), 'Enter on a district flies the city to its tower');
  } else check(false, 'a standing district for the palette to fly to');

  // A firm: Enter flies to its quarter when it stands, else opens its page.
  const firm = firms.find((f) => f.status === 'active') ?? firms[0];
  if (firm) {
    await openPalette(page);
    await page.keyboard.type(firm.name);
    await page.waitForTimeout(250);
    rows = await paletteRows(page);
    check(rows[0]?.kind === 'Firm' && rows[0].name === firm.name && /credits, \d+ agents?|Bankrupt/.test(rows[0].state), `typing the firm's name puts ${firm.name} first with its balance: ${JSON.stringify(rows[0])}`);
    const cam0 = await camera(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);
    const route = await page.evaluate(() => document.body.dataset.route);
    const hash = await page.evaluate(() => location.hash);
    check((route === 'city' && moved(cam0, await camera(page))) || hash === `#/firms/${encodeURIComponent(firm.id)}`, `Enter on a firm flies to its quarter or opens its page (${route} ${hash})`);
  } else check(false, 'a firm for the palette to go to');

  // A school page: a net by its name, Enter opens it; and the palette opens over a screen too.
  const net = school.nets.find((n) => n.net === 'triage') ?? school.nets[0];
  if (net) {
    await page.evaluate(() => {
      location.hash = '#/jobs';
    });
    await page.waitForTimeout(700);
    await openPalette(page);
    check(await paletteOpen(page), 'Cmd+K opens the palette over a screen');
    await page.keyboard.type('Triage');
    await page.waitForTimeout(250);
    rows = await paletteRows(page);
    check(rows[0]?.kind === 'Net' && rows[0].name === 'Triage' && rows[0].state.length > 0, `typing "Triage" puts the net first with its trust: ${JSON.stringify(rows[0])}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    check((await page.evaluate(() => location.hash)) === '#/school/nets/triage' && (await page.evaluate(() => document.body.dataset.route)) === 'net', 'Enter on a net opens its school page');
  } else check(false, 'a net for the palette to open');

  // Nothing answers: said plainly. A click outside closes. The Find word in the head opens it too, and recent picks rise.
  await openPalette(page);
  await page.keyboard.type('zqxv');
  await page.waitForTimeout(250);
  check((await paletteRows(page)).length === 0 && /Nothing in the city answers to/.test((await page.locator('.palette-foot').textContent()) ?? ''), 'a query nothing answers says so');
  await page.mouse.click(30, 900);
  await page.waitForTimeout(200);
  check(!(await paletteOpen(page)), 'a click outside closes the palette');
  await page.locator('.runhead-find').click();
  await page.waitForTimeout(500);
  rows = await paletteRows(page);
  check(await paletteOpen(page) && rows[0]?.kind === 'Net' && rows[0].name === 'Triage', `Find in the running head opens the palette, the last pick first: ${JSON.stringify(rows[0])}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const fresh = errors.slice(before);
  check(fresh.length === 0, `the palette raised no console error${fresh.length ? `: ${fresh.join(' | ')}` : ''}`);
  await page.evaluate(() => {
    location.hash = '#/';
  });
  await page.waitForTimeout(600);
}
