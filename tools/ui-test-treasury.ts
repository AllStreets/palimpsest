/**
 * The treasury screen's UI checks (Task 39), run by tools/ui-test.ts on its
 * own engine (port UI_PORT, default 4779, a temp home) after the firm pages' checks, on the
 * sample economy: his reading at 44% of the five-hour window and 21% of the
 * week, a calibration measured from 14 pairs, three daily reports and the
 * assay-kit harness job waiting on him. Then the stale variant: the same
 * reading six hours old pauses the city, and Resume anyway clears it.
 *
 * Saves treasury.png, treasury-spend.png, treasury-stale.png and report.png at 1600 x 1000 for the quality rounds.
 */
import { join } from 'node:path';

import type { Page } from 'playwright';

import type { TreasuryView } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

const SIZE = { width: 1600, height: 1000 };

async function within(page: Page, ms: number, ok: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok().catch(() => false)) return true;
    await page.waitForTimeout(80);
  }
  return false;
}

async function api<T>(page: Page, path: string): Promise<T> {
  return (await page.evaluate((p) => fetch(p).then((r) => r.json()), path)) as T;
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

const num = (s: string | null): number => Number((s ?? '').replace(/,/g, '').replace('\u2212', '-'));
const text = async (page: Page, sel: string): Promise<string> => ((await page.locator(sel).first().textContent()) ?? '').trim();

export async function treasuryChecks(page: Page, check: Check, shots: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const { sampleReading } = await import('../engine/market/sample-economy.js');
  const { patchSettings } = await import('../engine/settings.js');
  try {
    // ------------------------------------------------------------ his plan, fresh
    sampleReading(Date.now());
    await go(page, '#/treasury');
    const sheet = page.locator('.sheet.treasury');
    check(await within(page, 6000, async () => (await sheet.locator('.meter').count()) === 2), `the treasury shows two ruled meters (${await sheet.locator('.meter').count()})`);
    check((await page.evaluate(() => document.body.dataset.route)) === 'treasury', 'the route is the treasury');
    check((await page.locator('.runhead-link[data-route="treasury"]').getAttribute('aria-current')) === 'page', 'the running head marks Treasury');
    const five = sheet.locator('.meter[data-window="five"]');
    const seven = sheet.locator('.meter[data-window="seven"]');
    check((await text(page, '.meter[data-window="five"] .meter-used')) === '44%', `the five-hour meter reads the seeded 44% (${await text(page, '.meter[data-window="five"] .meter-used')})`);
    check((await text(page, '.meter[data-window="seven"] .meter-used')) === '21%', `the seven-day meter reads the seeded 21% (${await text(page, '.meter[data-window="seven"] .meter-used')})`);
    for (const [name, m] of [['five-hour', five], ['seven-day', seven]] as const) {
      check((await m.locator('svg.meter-rule .meter-his').count()) === 1, `the ${name} meter draws his use`);
      check((await m.locator('svg.meter-rule .meter-city').count()) === 1, `the ${name} meter draws the city's share`);
      check((await m.locator('svg.meter-rule .meter-stop').count()) === 1, `the ${name} meter marks the hard stop`);
      check(/resets /.test((await m.locator('.meter-reset').textContent()) ?? ''), `the ${name} meter says when it resets (${await m.locator('.meter-reset').textContent()})`);
    }
    check((await five.locator('svg.meter-rule .meter-cap').count()) === 1, 'the five-hour meter marks the city’s cap');
    check(/of the window, against its 50% cap/.test((await five.locator('.meter-legend').textContent()) ?? ''), `the city's share is said against its cap (${await five.locator('.meter-legend').textContent()})`);
    // The night cap measures unattended use alone: its own darker segment, set against the night mark.
    const tNow = await api<TreasuryView>(page, '/api/treasury');
    const night = seven.locator('svg.meter-rule .meter-night');
    const nightMark = seven.locator('svg.meter-rule .meter-cap.night');
    check((await night.count()) === 1 && (await nightMark.count()) === 1, 'the seven-day meter draws unattended use as its own segment, with the night mark');
    check((await night.count()) === 1 && (await night.getAttribute('data-pct')) === String(tNow.night.usedPct), `measured from the night use, not the city's total (${(await night.count()) ? await night.getAttribute('data-pct') : 'none'} against ${tNow.night.usedPct}, city ${tNow.sevenDay.cityPct})`);
    const onLine = (await night.count()) === 1 && (await nightMark.count()) === 1 && Number(await night.getAttribute('y')) >= (await nightMark.evaluate((e) => (e as SVGGraphicsElement).getBBox().y));
    check(onLine, 'on the night mark’s own line');
    // A night cap past about 60% of the scale reads to the left of its mark, so its label never runs into the hard stop.
    const stopAt = async (): Promise<number> => seven.locator('svg.meter-rule .meter-stop').evaluate((e) => (e as SVGGraphicsElement).getBBox().x);
    const nightLabel = seven.locator('svg.meter-rule .meter-mark-label.night');
    check((await nightLabel.getAttribute('text-anchor')) !== 'end', `at the default 20% the night label reads to the right of its mark (${await nightLabel.getAttribute('text-anchor')})`);
    patchSettings({ nightCapPct: 80 });
    try {
      await go(page, '#/');
      await go(page, '#/treasury');
      check(await within(page, 6000, async () => (await nightLabel.getAttribute('text-anchor')) === 'end'), `a night cap at 80% sets its label to the left of its mark (${await nightLabel.getAttribute('text-anchor').catch(() => null)})`);
      const box = await nightLabel.evaluate((e) => {
        const b = (e as SVGGraphicsElement).getBBox();
        return { x: b.x, right: b.x + b.width };
      });
      const markX = await seven.locator('svg.meter-rule .meter-cap.night').evaluate((e) => (e as SVGGraphicsElement).getBBox().x);
      check(box.right <= markX && box.right < (await stopAt()), `and clear of the hard stop (label ends at ${box.right.toFixed(1)}, mark at ${markX.toFixed(1)}, stop at ${(await stopAt()).toFixed(1)})`);
    } finally {
      patchSettings({ nightCapPct: 20 });
      await go(page, '#/');
      await go(page, '#/treasury');
      await within(page, 6000, async () => (await sheet.locator('.meter').count()) === 2);
    }
    for (const sel of ['.meter-num', '.meter-mark-label']) {
      const style = await seven.locator(`svg.meter-rule ${sel}`).first().evaluate((e) => getComputedStyle(e).fontSize);
      check(style === '11px', `${sel} is set at 11 px (${style})`);
    }
    check((await text(page, '.treasury .calibration-line')) === '1% of the window is about 58,000 weighted tokens, measured from 14 pairs.', `the calibration line (${await text(page, '.treasury .calibration-line')})`);
    check((await sheet.locator('.treasury-pause[data-reason="stale"]').count()) === 0, 'a fresh reading does not pause the city');
    for (const key of ['concurrency', 'night', 'api', 'awake']) check((await sheet.locator(`.now-row[data-now="${key}"]`).count()) === 1, `it says the ${key} state now`);
    check(/Claude \d+ of \d+/.test((await sheet.locator('.now-row[data-now="concurrency"]').textContent()) ?? ''), 'concurrency says Claude slots in use of the most');

    // Spend by firm and by model, and the balances; every row opens to its credits entries.
    const t = await api<TreasuryView>(page, '/api/treasury');
    const firmRows = sheet.locator('.spend-firms .spend-row');
    check((await firmRows.count()) >= Object.keys(t.balances).length, `every firm has a row (${await firmRows.count()})`);
    const qs = sheet.locator('.spend-firms .spend-row[data-firm="quickset"]');
    check(num(await qs.locator('.spend-bal').textContent()) === Math.round(t.balances.quickset * 100) / 100, `a firm's balance reads as the books (${await qs.locator('.spend-bal').textContent()} against ${t.balances.quickset})`);
    check(/^#\/firms\/quickset$/.test((await qs.locator('.spend-bal').getAttribute('href')) ?? ''), 'and links to its books');
    check((await sheet.locator('.spend-models .spend-row').count()) === t.spend.week.models.length, 'every model spent on this week has a row');
    check((await sheet.locator('.spend-firms .spend-row[data-firm="~city"]').count()) === (t.spend.week.firms.some((f) => f.firmId === null) ? 1 : 0), 'the city’s own row has a key no firm can take');
    check((await sheet.locator('.spend-th', { hasText: 'Last 7 days' }).count()) === 2, 'the rolling week is called the last 7 days');
    check((await sheet.locator('.spend-table a[role]').count()) === 0, 'no link stands in for a cell');
    check((await sheet.locator('.spend-table > :not([role="row"])').count()) === 0, 'every child of a spend table is a row: notes stand outside it');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'treasury.png') });

    const busiest = t.spend.week.firms.find((f) => f.firmId !== null && f.entries > 0);
    if (busiest) {
      const row = sheet.locator(`.spend-firms .spend-row[data-firm="${busiest.firmId}"]`);
      await row.locator('.spend-open').click();
      const entries = row.locator('xpath=following-sibling::*[1]').locator('.entry');
      check(await within(page, 5000, async () => (await entries.count()) > 0), `a firm's row opens to its credits entries (${await entries.count()})`);
      check((await row.locator('.spend-open').getAttribute('aria-expanded')) === 'true', 'and says it is open');
      const block = row.locator('xpath=following-sibling::*[1]');
      const cellOf = block.locator('> [role="cell"]');
      const spanning = (await cellOf.count()) === 1;
      check((await block.getAttribute('role')) === 'row' && spanning && (await cellOf.getAttribute('aria-colspan')) === '5', 'its entries sit in a row of their own, one cell spanning the table');
      check(spanning && (await row.locator('.spend-open').getAttribute('aria-controls')) === (await cellOf.getAttribute('id')), 'and the row’s button names them');
      check((await sheet.locator('.spend-table a[role]').count()) === 0 && (await sheet.locator('.spend-table > :not([role="row"])').count()) === 0, 'open, the table is still rows and cells');
      check(/^No\. \d+$/.test((await entries.first().locator('.entry-id').textContent()) ?? ''), `each entry names its credits row (${await entries.first().locator('.entry-id').textContent()})`);
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, 'treasury-spend.png') });
      await row.locator('.spend-open').click();
    }
    const model = t.spend.week.models[0];
    if (model) {
      const row = sheet.locator('.spend-models .spend-row').first();
      await row.locator('.spend-open').click();
      check(await within(page, 5000, async () => (await row.locator('xpath=following-sibling::*[1]').locator('.entry').count()) > 0), 'a model’s row opens to its entries too');
      await row.locator('.spend-open').click();
    }

    // ------------------------------------------------------------ the daily report
    const report = sheet.locator('.report');
    check(await within(page, 6000, async () => (await report.locator('.report-h1').count()) === 1), 'the latest daily report renders below');
    const days = t.reports;
    check(days.length >= 3, `the economy wrote three reports (${days.join(', ')})`);
    check((await sheet.locator('.report-day[aria-checked="true"]').getAttribute('data-day')) === days[0], 'the latest day is picked');
    const waiting = report.locator('.report-sec[data-sec="waiting-on-you"]');
    check(/assay-kit/.test((await waiting.textContent()) ?? '') && /proposed job/i.test((await waiting.textContent()) ?? ''), `the proposed harness job waits on him (${((await waiting.textContent()) ?? '').slice(0, 160)})`);
    check((await report.locator('table.report-table').count()) > 0, 'its tables are tables');
    // The report's head at the top of the sheet, as he would scroll to it.
    await sheet.locator('.treasury-report').evaluate((sec) => {
      const body = sec.closest('.sheet-body') as HTMLElement;
      // Exactly at the top: nothing of the section above shows through the fade under the head.
      body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'report.png') });
    const firstHead = await text(page, '.treasury .report-h1');
    await sheet.locator(`.report-day[data-day="${days[1]}"]`).click();
    check(await within(page, 5000, async () => (await text(page, '.treasury .report-h1')) !== firstHead), `the day picker opens an earlier day (${await text(page, '.treasury .report-h1')})`);
    // The days run oldest to newest, left to right.
    await sheet.locator(`.report-day[data-day="${days[1]}"]`).press('ArrowRight');
    check(await within(page, 5000, async () => (await sheet.locator('.report-day[aria-checked="true"]').getAttribute('data-day')) === days[0]), 'and the arrow keys walk the days');

    // ------------------------------------------------------------ the stale variant
    sampleReading(Date.now(), { stale: true });
    await go(page, '#/');
    await go(page, '#/treasury');
    const pause = sheet.locator('.treasury-pause[data-reason="stale"]');
    check(await within(page, 6000, async () => (await pause.count()) === 1), 'a reading six hours old pauses the city, said at the head');
    check(/6 hours old/.test((await pause.textContent()) ?? ''), `in plain words (${(await pause.locator('.pause-title').textContent()) ?? ''})`);
    const resume = pause.locator('button.pause-resume');
    check((await resume.count()) === 1 && (await resume.textContent()) === 'Resume anyway', 'with the one action that clears it: Resume anyway');
    await sheet.locator('.sheet-body').evaluate((b) => {
      b.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'treasury-stale.png') });
    await resume.click();
    check(await within(page, 5000, async () => (await pause.count()) === 0), 'Resume anyway clears the stale pause');
    const after = await api<TreasuryView>(page, '/api/treasury');
    check(await within(page, 3000, async () => page.evaluate(() => document.activeElement?.classList.contains('treasury-resumed') === true)), 'focus moves to the line that says the city resumed');
    check((await sheet.locator('.treasury-pause-host').count()) === 1 && (await sheet.locator('.treasury-pause-host').getAttribute('aria-live')) === 'polite', 'and the notice is announced politely as it changes');
    check(after.paused?.reason !== 'stale' && after.resumedUntil !== null, `and the engine carries on until ${after.resumedUntil ? new Date(after.resumedUntil).toLocaleTimeString('en-GB') : 'never'}`);
    check(/Resumed on your say-so until \d\d:\d\d/.test((await sheet.locator('.treasury-resumed').textContent()) ?? ''), `the page says until when (${await sheet.locator('.treasury-resumed').textContent()})`);

    // The stop switch: Settings is the way out.
    const { paths } = await import('../engine/home.js');
    const { writeFileSync, rmSync } = await import('node:fs');
    writeFileSync(paths().stop, 'stop\n');
    try {
      await go(page, '#/');
      await go(page, '#/treasury');
      const stopped = sheet.locator('.treasury-pause[data-reason="stopped"]');
      check(await within(page, 6000, async () => (await stopped.count()) === 1), 'the stop switch shows as stopped');
      check((await stopped.locator('a.pause-settings').getAttribute('href')) === '#/settings', 'with Open Settings as its way out');
    } finally {
      rmSync(paths().stop, { force: true });
    }
  } finally {
    patchSettings({ resumeStaleUntil: null });
    sampleReading(Date.now());
    if (before) await page.setViewportSize(before);
  }
}
