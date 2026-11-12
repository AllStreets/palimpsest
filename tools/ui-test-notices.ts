/**
 * The notice stack (Phase 3 Task 12): a short column hanging from the
 * running head, each notice its own ruled line with its own Dismiss, a keyed
 * notice replacing its earlier words, the column fading and recalled by its
 * mark (and announced again through role=status), every path by keyboard,
 * and the column standing clear of an open sheet. Driven through the debug
 * handle's say(), as the city's own notices are made.
 */
import { join } from 'node:path';

import type { Page } from 'playwright';

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
  const re = /^The city stepped down to medium quality: \d+ fps and \d+\.\dM triangles( from home)?\.$/;
  const line = (await lines(page))[0] ?? '';
  check(re.test(line) && /\d+ fps/.test(text), `the quality-drop notice names the frame rate and the triangles (${line})`);
  check(/ from home\.$/.test(line) === fromHome, `and says from home only when the camera stood there (${fromHome})`);
}
