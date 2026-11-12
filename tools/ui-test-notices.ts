/**
 * The notice stack (Phase 3 Task 12): a short column hanging from the
 * running head, each notice its own ruled line with its own Dismiss, a keyed
 * notice replacing its earlier words, the column fading and recalled by its
 * mark (and announced again through role=status), every path by keyboard,
 * and the column standing clear of an open sheet. Driven through the debug
 * handle's say(), as the city's own notices are made.
 */
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import type { Page } from 'playwright';

import { layoutTower } from '../shared/tower-layout.js';
import type { District } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

async function within(page: Page, ms: number, ok: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok().catch(() => false)) return true;
    await page.waitForTimeout(80);
  }
  return false;
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

const say = (page: Page, text: string, key?: string): Promise<void> =>
  page.evaluate(([t, k]) => (window as unknown as { __palimpsest: { say(t: string, k?: string): void } }).__palimpsest.say(t, k), [text, key] as [string, string | undefined]);
const said = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as { __palimpsest: { notice(): string } }).__palimpsest.notice());
const lines = (page: Page): Promise<string[]> => page.locator('.city-notice-line p').allTextContents();
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return '';
    const li = a.closest('.city-notice-line') as HTMLElement | null;
    return `${a.className}${li ? `@${li.dataset.key}` : ''}`;
  });
/** RGB of a 1x1 PNG: every PNG filter reduces to the raw bytes for a single pixel with no prior row. */
function rgbOf1x1(png: Buffer): [number, number, number] {
  let off = 8;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

/** WCAG relative luminance of an sRGB colour, 0 to 255 a channel. */
function luminance([r, g, b]: number[]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The brightest pixel behind the notice lines, the words hidden (and, with `bare`, the lines' own backing too),
 * sampled on a grid across every line's box.
 */
async function brightestBehind(page: Page, bare: boolean): Promise<number> {
  await page.addStyleTag({
    content: `.city-notice-line p, .city-notice-line button { color: transparent !important; text-shadow: none !important; }${bare ? ' .city-notice-line { background: none !important; }' : ''}`,
  }).then((h) => h.evaluate((e) => (e as Element).setAttribute('data-sampling', '')));
  await page.waitForTimeout(150);
  const boxes = await page.locator('.city-notice-line').evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect()).map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height })));
  let most = 0;
  for (const b of boxes) {
    for (let i = 0; i < 10; i++) {
      for (const fy of [0.3, 0.5, 0.7]) {
        const x = Math.round(b.x + 6 + ((b.w - 10) * i) / 9);
        const y = Math.round(b.y + b.h * fy);
        most = Math.max(most, luminance(rgbOf1x1(await page.screenshot({ clip: { x, y, width: 1, height: 1 } }))));
      }
    }
  }
  await page.evaluate(() => document.querySelectorAll('style[data-sampling]').forEach((e) => e.remove()));
  return most;
}

/** The dimmest of the notice lines' words and Dismisses, as luminance. */
const dimmestWords = (page: Page): Promise<number> =>
  page.locator('.city-notice-line p, .city-notice-dismiss').evaluateAll((es) => es.map((e) => getComputedStyle(e).color)).then((cs) =>
    Math.min(...cs.map((c) => luminance((c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)))),
  );

/** Stands the camera close on the tallest tower's lit face, so it fills the frame behind the running head. */
async function faceTallestTower(page: Page): Promise<void> {
  const city = (await page.evaluate(() => fetch('/api/city').then((r) => r.json()))) as District[];
  const d = city.reduce((a, b) => (layoutTower(b.tower).top > layoutTower(a.tower).top ? b : a));
  const y = layoutTower(d.tower).top * 0.62;
  const { x, z } = d.origin;
  await page.evaluate(
    ([e, t]) => (window as unknown as { __palimpsest: { view(e: number[], t: number[]): void } }).__palimpsest.view(e, t),
    [[x + 0.63 * 48, y - 4, z + 0.78 * 48], [x, y + 6, z]],
  );
  await page.waitForTimeout(2000);
}

const status = (page: Page): Promise<string> => page.locator('.city-notice [role="status"]').evaluate((p) => p.textContent ?? '');

/** Takes every notice away, by its own Dismiss, so a check starts from an empty column. */
async function clear(page: Page): Promise<void> {
  for (let i = 0; i < 6 && (await page.locator('.city-notice-dismiss').count()) > 0; i++) {
    await page.locator('.city-notice-dismiss').first().evaluate((b) => (b as HTMLButtonElement).click());
  }
}

const KITS = 'The architecture kits did not load (kits/kits.glb is missing or damaged), so the city is built from plain blocks. Reinstalling Palimpsest restores them.';
const TOWER = 'That tower is not standing in the city just now.';
const AUDIT_1 = 'An audit of harbor-ledger is reading its README.';
const AUDIT_2 = 'The audit of harbor-ledger found 3 claims missing.';
const TOUR = 'The tour arrives with the city track.';

export async function noticeChecks(page: Page, check: Check, shots: string): Promise<void> {
  await go(page, '#/');
  await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city');
  await clear(page);
  const head = page.locator('.runhead');
  const headBefore = (await head.boundingBox())?.height ?? 0;

  // ------------------------------------------------------------ three notices, newest first, each its own line
  await say(page, KITS);
  await say(page, AUDIT_1, 'audit:harbor-ledger');
  await say(page, TOWER);
  check((await lines(page)).join('|') === [TOWER, AUDIT_1, KITS].join('|'), `three notices stand newest first, each its own line (${(await lines(page)).length})`);
  check((await page.locator('.city-notice-line .city-notice-dismiss').count()) === 3, 'each with its own Dismiss');
  const geo = await page.evaluate(() => {
    const head = document.querySelector('.runhead')!.getBoundingClientRect();
    const link = document.querySelector('.runhead-link')!.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.city-notice-line')].map((li) => {
      const b = li.getBoundingClientRect();
      const ruled = getComputedStyle(li).borderLeftWidth;
      return { top: b.top, bottom: b.bottom, left: b.left, oneLine: (li.querySelector('p') as HTMLElement).getBoundingClientRect().height < 24, ruled };
    });
    return { head, link, rows };
  });
  check(Math.abs(geo.rows[0].bottom - geo.link.bottom) < 8 && geo.rows[0].left > geo.link.right, 'the newest stands on the running head’s own line, at its end');
  check(geo.rows.every((r, i) => i === 0 || (r.top >= geo.rows[i - 1].bottom && Math.abs(r.left - geo.rows[0].left) < 1)), 'the older ones hang beneath it in one column');
  check(geo.rows.every((r) => r.oneLine && r.ruled === '2px'), 'every notice is one ruled line');
  check(Math.abs(((await head.boundingBox())?.height ?? 0) - headBefore) < 1, 'and the running head itself does not grow over the city');
  check(await within(page, 1000, async () => (await status(page)) === TOWER), 'the newest is announced through role=status');
  check(/That tower is not standing/.test(await said(page)) && /kits did not load/.test(await said(page)), 'the debug handle still returns the joined text');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'notices-three.png') });
  await page.screenshot({ path: join(shots, 'notices-three-crop.png'), clip: { x: 0, y: 0, width: 1600, height: 140 } });

  // ------------------------------------------------------------ a keyed notice replaces its earlier words
  await say(page, AUDIT_2, 'audit:harbor-ledger');
  check((await lines(page)).join('|') === [AUDIT_2, TOWER, KITS].join('|'), 'a keyed notice replaces its earlier words and comes to the top');

  // ------------------------------------------------------------ the keyboard: Tab between the Dismisses, Enter and Space take one each
  const dismissOf = (key: string) => page.locator(`.city-notice-line[data-key="${key}"] .city-notice-dismiss`);
  const described = await dismissOf(TOWER).evaluate((b) => document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent ?? '');
  check(described === TOWER && (await dismissOf(TOWER).evaluate((b) => b.tagName === 'BUTTON' && b.textContent === 'Dismiss')), 'each Dismiss is a button described by its own notice');
  await page.locator('.city-notice-line .city-notice-dismiss').first().focus();
  await page.keyboard.press('Tab');
  check((await focused(page)) === `city-notice-dismiss@${TOWER}`, `Tab moves to the next notice’s Dismiss (${await focused(page)})`);
  // Held while focus is in the column: it does not fade from under the key.
  await page.waitForTimeout(6600);
  check((await said(page)) !== '', 'the column holds while focus is in it');
  await page.keyboard.press('Enter');
  check((await lines(page)).join('|') === [AUDIT_2, KITS].join('|'), 'Enter on a Dismiss takes that notice alone');
  check((await focused(page)) === `city-notice-dismiss@${KITS}`, `and focus goes to the next notice’s Dismiss (${await focused(page)})`);
  await page.keyboard.press(' ');
  check((await lines(page)).join('|') === AUDIT_2, 'Space takes the next one alone');
  check((await focused(page)) === 'city-notice-dismiss@audit:harbor-ledger', `and focus steps back to the one above (${await focused(page)})`);

  // ------------------------------------------------------------ Escape folds the column onto its mark; the mark recalls it
  await say(page, TOUR, 'tour');
  await say(page, TOWER);
  await page.locator('.city-notice-dismiss').first().focus();
  await page.keyboard.press('Escape');
  check((await said(page)) === '' && (await focused(page)) === 'city-notice-recall', 'Escape in the column folds it and leaves focus on the mark');
  check((await page.evaluate(() => document.body.dataset.route)) === 'city', 'and the Escape stays in the column');
  const recall = page.locator('.city-notice-recall');
  check((await recall.getAttribute('aria-expanded')) === 'false' && (await recall.getAttribute('aria-controls')) === (await page.locator('.city-notice-list').getAttribute('id')), 'the mark says the column is folded and names it');
  await page.keyboard.press('Enter');
  check(await within(page, 1500, async () => (await page.locator('.city-notice-list').evaluate((l) => getComputedStyle(l).visibility)) === 'visible'), 'Enter on the mark shows the column again');
  check((await recall.getAttribute('aria-expanded')) === 'true', 'and the mark says so');
  const joined = [TOWER, TOUR, AUDIT_2].join(' ');
  check(await within(page, 1000, async () => (await status(page)) === joined), `the recalled notices are announced again through role=status (${(await status(page)).slice(0, 50)})`);
  await page.mouse.move(800, 600);
  // Over a lit tower the lines keep their words legible: WCAG 4.5:1 against the brightest pixel behind them.
  await faceTallestTower(page);
  const bare = await brightestBehind(page, true);
  check(bare > 0.12, `the column stands over a lit facade (brightest behind it ${bare.toFixed(2)})`);
  const behind = await brightestBehind(page, false);
  const words = await dimmestWords(page);
  const ratio = (words + 0.05) / (behind + 0.05);
  check(ratio >= 4.5, `and every line reads at 4.5:1 or better over it (${ratio.toFixed(1)}:1)`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'notices-recalled.png') });
  await page.screenshot({ path: join(shots, 'notices-recalled-crop.png'), clip: { x: 0, y: 0, width: 1600, height: 140 } });
  await page.locator('#city canvas').focus();
  check(await within(page, 9000, async () => (await said(page)) === ''), 'away from the column it fades after a few seconds');
  check(await recall.isVisible(), 'and the mark stays to recall it');

  // ------------------------------------------------------------ beside an open sheet, never over it
  await go(page, '#/treasury');
  await page.locator('.sheet.treasury').waitFor({ state: 'visible', timeout: 6000 });
  await page.waitForTimeout(500);
  await say(page, 'The city stepped down to medium quality: 41 fps and 13.2M triangles from home.', 'quality');
  await page.waitForTimeout(400);
  const beside = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet.treasury')!.getBoundingClientRect();
    const head = document.querySelector('.runhead-link')!.getBoundingClientRect();
    const box = document.querySelector('.city-notice')!.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.city-notice-line, .city-notice-recall')].map((e) => e.getBoundingClientRect());
    return { sheetRight: sheet.right, left: Math.min(box.left, ...rows.map((r) => r.left)), right: Math.max(...rows.map((r) => r.right)), firstBottom: rows[0].bottom, headBottom: head.bottom, vw: innerWidth };
  });
  check(beside.left >= beside.sheetRight, `with the treasury open the column stands right of the sheet’s edge (${beside.left.toFixed(0)} against ${beside.sheetRight.toFixed(0)})`);
  check(beside.right <= beside.vw, `and inside the window (${beside.right.toFixed(0)})`);
  check(Math.abs(beside.firstBottom - beside.headBottom) < 8, 'on the running head’s line');
  await page.screenshot({ path: join(shots, 'notices-beside-sheet.png') });
  await page.locator('.city-notice-dismiss').first().focus();
  await page.keyboard.press('Escape');
  check((await page.evaluate(() => document.body.dataset.route)) === 'treasury' && (await focused(page)) === 'city-notice-recall', 'Escape in the column folds it and leaves the sheet open');
  await page.keyboard.press('Escape');
  await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city');
  check(await within(page, 1500, async () => (await page.locator('.city-notice').evaluate((b) => (b as HTMLElement).dataset.beside === undefined))), 'and with the sheet closed it returns to the head’s end');
  await clear(page);
}

/** The governor's own notice, from a drop taken where the caller stands the camera: it names what it saw. */
export async function dropNoticeChecks(page: Page, check: Check, fromHome: boolean): Promise<void> {
  const text = await said(page);
  const re = /^The city stepped down to medium quality: \d+ fps and \d+\.\dM triangles( from home)?\. Settings can set it back to high\.$/;
  const line = (await lines(page))[0] ?? '';
  check(re.test(line) && /\d+ fps/.test(text), `the quality-drop notice names the frame rate and the triangles (${line})`);
  check(/Settings can set it back to high\./.test(text), 'and says Settings can set it back to high');
  check(/ from home\./.test(line) === fromHome, `and says from home only when the camera stood there (${fromHome})`);
}
