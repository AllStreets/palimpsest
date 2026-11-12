/**
 * The morning brief (Phase 3 Task 11), run by tools/ui-test.ts on its own
 * engine (port UI_PORT, default 4779, a temp home) once the sample economy
 * is seeded and the audit checks are done.
 *
 * The harness opened today's brief before its first page, so every earlier
 * check found the city; here today's `brief.opened` rows are taken out of
 * the temp home's ledger, which makes the next load the first open of the
 * day again. A milestone the city reached long ago is reached again (as the
 * engine does when it dates a ribbon's end), so "In the city" has a line on
 * a day that is not a Monday. The Monday offer of the week's tour is shown
 * from the engine's own Monday brief (`briefData` at next Monday), laid into
 * the page's answer, since the clock here is not a Monday.
 *
 * The empty morning runs last, on a fresh home with no repos and a fresh
 * reading (`emptyMorningChecks`), because the economy's home is never empty.
 *
 * Saves brief.png, brief-why.png, brief-cap.png, brief-tour.png and
 * brief-empty.png at 1600 x 1000 for the quality rounds.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, Page } from 'playwright';

import type { Brief, BriefItem, Job, Milestone } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

const SIZE = { width: 1600, height: 1000 };
const SECTIONS = [
  ['waiting', 'Waiting on you'],
  ['overnight', 'Overnight'],
  ['recommendations', 'Recommended'],
  ['city', 'In the city'],
] as const;

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

const itemsOf = (b: Brief): BriefItem[] => [...b.sections.waiting, ...b.sections.overnight, ...b.sections.recommendations, ...b.sections.city];

async function camera(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __palimpsest: { camera(): number[] } }).__palimpsest.camera());
}

/**
 * The brief on the economy: it opens before the city on the day's first
 * open, records that once, and every action works in place, by mouse and
 * by keyboard; a second window carries the same items and sees the first
 * window's action without a reload.
 */
export async function briefChecks(page: Page, check: Check, shots: string): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { query, record } = await import('../engine/ledger.js');
  const { emit } = await import('../engine/events.js');
  const { listMilestones } = await import('../engine/market/milestones.js');
  const { briefData } = await import('../engine/brief.js');
  const { localDay } = await import('../shared/day.js');
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  try {
    // ------------------------------------------------------------ a new morning on the economy
    const today = localDay(Date.now());
    const ribbon = listMilestones(Date.now(), { active: true }).find((m: Milestone) => m.kind === 'ribbon' || m.kind === 'revival');
    if (ribbon) {
      record('milestone.reached', { milestone: ribbon });
      emit('milestone.reached', { milestone: ribbon });
    }
    openDb().prepare("DELETE FROM ledger WHERE kind = 'brief.opened' AND json_extract(json, '$.day') = ?").run(today);
    const opensBefore = query({ kind: 'brief.opened' }).length;

    // The order the page did things in: when the brief took the route, and when the veil began to lift.
    // A string, not a function: tsx would wrap a function in helpers the page does not have.
    await page.addInitScript(`
      window.__order = { n: 0, brief: 0, veil: 0 };
      new MutationObserver(() => {
        const o = window.__order;
        if (!o.brief && document.body && document.body.dataset.route === 'brief') o.brief = ++o.n;
        const v = document.getElementById('veil');
        if (!o.veil && v && v.classList.contains('gone')) o.veil = ++o.n;
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-route', 'class'] });
    `);
    await page.goto(`${new URL(page.url()).origin}/?debug`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    const order = await page.evaluate(() => (window as unknown as { __order: { brief: number; veil: number } }).__order);
    check(order.brief > 0 && order.veil > 0 && order.brief < order.veil, `on the day's first open the brief opens before the city, while the veil still stands (${JSON.stringify(order)})`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    const sheet = page.locator('.sheet.brief');
    check(await within(page, 8000, async () => (await sheet.locator('.brief-item').count()) > 0), 'the brief shows its items');

    const opens = query({ kind: 'brief.opened' });
    const todays = opens.filter((e) => (e.data as { day?: string }).day === today);
    check(opens.length === opensBefore + 1 && todays.length === 1, `brief.opened is recorded once for today (${todays.length})`);
    const brief = await api<Brief>(page, '/api/brief');
    const shownIds = await sheet.locator('.brief-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item ?? ''));
    const recorded = ((todays[0]?.data as { items?: string[] } | undefined)?.items ?? []).slice().sort();
    check(JSON.stringify(recorded) === JSON.stringify(itemsOf(brief).map((i) => i.id).sort()), `with the ids of the items it showed (${recorded.length})`);
    check(JSON.stringify([...shownIds].sort()) === JSON.stringify(recorded), `and the page shows exactly those items (${shownIds.length})`);
    check(brief.firstOpen === false, 'after the open, the brief says it is no longer the first open');
    check((await sheet.getAttribute('data-first')) === 'true', 'but this window keeps that it was the first to open it');

    // ------------------------------------------------------------ the page
    check(((await sheet.locator('.sheet-title').textContent()) ?? '').trim() === (await page.evaluate(() => {
      const d = new Date();
      return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]} ${d.getDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()]}`;
    })), 'the title is the day');
    check(((await sheet.locator('.brief-kicker').textContent()) ?? '') === 'Brief', 'under the name Brief');
    const lead = ((await sheet.locator('.brief-lead').textContent()) ?? '').trim();
    check(lead === brief.lead && lead.length > 20, `the lead stands under the title (${lead.slice(0, 60)})`);
    const usage = ((await sheet.locator('.brief-usage').textContent()) ?? '').trim();
    check(/five-hour window stands at \d+%/.test(usage) && /today's limit of 50%/.test(usage) && /seven-day window at \d+%/.test(usage), `the usage line names both windows and today's limit (${usage})`);
    for (const [key, name] of SECTIONS) {
      const sec = sheet.locator(`.brief-sec[data-sec="${key}"]`);
      const head = ((await sec.locator('.repos-sec-name').textContent().catch(() => '')) ?? '').trim();
      const n = await sec.locator('.brief-item').count();
      check(head === name && n > 0, `"${name}" has at least one item (${n})`);
    }
    check(await runheadSaysBrief(page), 'the running head has Brief, after City, marked as the place');
    // One ruled row per item: the sentence, then its actions in the sentence's own line.
    const rows = await sheet.locator('.brief-item').evaluateAll((els) =>
      els.map((li) => {
        const line = li.querySelector('.brief-line');
        const acts = [...li.querySelectorAll('.brief-act')];
        return { line: !!line && !!line.querySelector('.brief-sentence'), inLine: acts.every((a) => a.parentElement?.closest('.brief-line') === line), focusable: acts.every((a) => (a as HTMLElement).tabIndex >= 0 && /^(BUTTON|A)$/.test(a.tagName)) };
      }),
    );
    check(rows.length > 0 && rows.every((r) => r.line && r.inLine && r.focusable), 'every row is a sentence with its actions as text buttons in its line, each reachable by Tab');
    check((await sheet.locator('.brief-act.btn, .btn.brief-act').count()) === 0, 'and never a row of buttons');
    check((await sheet.locator('img, iframe, script').count()) === 0, 'the brief is set as text only');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'brief.png') });

    // ------------------------------------------------------------ Ask why on a proposal: the claim unfolds under the row
    const auditProposal = itemsOf(brief).find((i) => i.kind === 'proposal' && i.refs.auditId && i.actions.includes('accept') && i.actions.includes('why'));
    check(!!auditProposal, 'a proposal from an audit waits with Post as a job and Ask why');
    if (auditProposal) {
      const row = sheet.locator(`.brief-item[data-item="${auditProposal.id}"]`);
      const why = row.locator('.brief-act[data-action="why"]');
      check((await why.getAttribute('aria-expanded')) === 'false', 'Ask why starts folded');
      await why.focus();
      await page.keyboard.press('Enter');
      const claim = await within(page, 5000, async () => /The README says|README/.test((await row.locator('.brief-why').textContent()) ?? '') && (await row.locator('.brief-why .why-claim-text').count()) === 1);
      check(claim, `Ask why (by keyboard) unfolds the claim under the proposal (${((await row.locator('.brief-why').textContent()) ?? '').slice(0, 80)})`);
      check((await why.getAttribute('aria-expanded')) === 'true' && !!(await why.getAttribute('aria-controls')), 'and says it is open, naming what it opened');
      check((await row.locator('.brief-why .why-ev').count()) > 0, 'with its evidence');
      await row.evaluate((r) => r.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, 'brief-why.png') });
      await why.click();
      check(await within(page, 2000, async () => (await row.locator('.brief-why').count()) === 0), 'and folds again');
    }

    // ------------------------------------------------------------ Post as a job
    const toAccept = itemsOf(brief).find((i) => i.kind === 'proposal' && i.actions.includes('accept') && i.id !== auditProposal?.id) ?? auditProposal;
    if (toAccept) {
      const row = sheet.locator(`.brief-item[data-item="${toAccept.id}"]`);
      await row.locator('.brief-act[data-action="accept"]').click();
      const said = await within(page, 5000, async () => /^Posted as a job, \d{1,2}:\d\d$/.test(((await row.locator('.brief-acted').textContent()) ?? '').trim()));
      check(said, `Post as a job moves the proposal and the row says so (${((await row.locator('.brief-acted').textContent()) ?? '').trim()})`);
      const job = (await api<{ job: Job }>(page, `/api/jobs/${toAccept.refs.jobId}`)).job;
      check(job.status !== 'proposed' && job.status !== 'withdrawn', `the job is posted (${job.status})`);
      check((await row.locator('.brief-act[data-action="accept"]').count()) === 0, 'and the row offers it no more');
      check(await page.evaluate(() => document.activeElement?.classList.contains('brief-acted') ?? false), 'focus lands on what the row now says');
      check((await sheet.locator('.brief-item').first().getAttribute('data-item')) === shownIds[0], 'the acted item stays in place');
    }

    // ------------------------------------------------------------ Dismiss on the failed job: marked, and taught
    const failed = itemsOf(brief).find((i) => i.kind === 'failed' && i.actions.includes('dismiss'));
    check(!!failed, 'the failed job offers Dismiss');
    if (failed) {
      const row = sheet.locator(`.brief-item[data-item="${failed.id}"]`);
      await row.locator('.brief-act[data-action="dismiss"]').click();
      check(await within(page, 5000, async () => /^Dismissed, \d{1,2}:\d\d$/.test(((await row.locator('.brief-acted').textContent()) ?? '').trim())), 'Dismiss marks the failed job in place');
      check((await row.getAttribute('data-acted')) === 'dismiss', 'and quiets the row');
      const act = query({ kind: 'brief.action' }).filter((e) => (e.data as { itemId?: string }).itemId === failed.id).at(-1);
      check((act?.data as { taught?: boolean; action?: string } | undefined)?.taught === true && (act?.data as { action?: string }).action === 'dismiss', 'and records it as taught');
    }

    // ------------------------------------------------------------ a second window: the same items, and the first window's action within 2 s
    const second = await page.context().browser()!.newPage({ viewport: SIZE });
    const errors2: string[] = [];
    second.on('console', (m) => {
      if (m.type() === 'error') errors2.push(m.text());
    });
    second.on('pageerror', (e) => errors2.push(String(e)));
    await second.setViewportSize(SIZE);
    await second.goto(`${new URL(page.url()).origin}/?debug`);
    await second.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    check((await second.evaluate(() => document.body.dataset.route)) === 'city', 'a second window the same day opens on the city');
    await go(second, '#/brief');
    const sheet2 = second.locator('.sheet.brief');
    await within(second, 8000, async () => (await sheet2.locator('.brief-item').count()) > 0);
    check((await sheet2.getAttribute('data-first')) === 'false' && /opened it once already today/.test((await sheet2.locator('.brief-since').textContent()) ?? ''), `and its brief says it is not the first open (${(await sheet2.locator('.brief-since').textContent()) ?? ''})`);
    const ids2 = await sheet2.locator('.brief-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item ?? ''));
    check(JSON.stringify([...ids2].sort()) === JSON.stringify([...shownIds].sort()), `with the same items (${ids2.length} and ${shownIds.length})`);
    const tierItem = itemsOf(brief).find((i) => i.kind === 'proposal' && i.actions.includes('tier') && i.id !== toAccept?.id);
    if (tierItem) {
      const row = sheet.locator(`.brief-item[data-item="${tierItem.id}"]`);
      await row.locator('.brief-act[data-action="tier"]').click();
      const want = tierItem.tier === 'low' ? 'high' : 'low';
      await row.locator(`.brief-tier [role="radio"][data-tier="${want}"]`).click();
      const t0 = Date.now();
      const seen = await within(second, 2000, async () => new RegExp(`^Tier set to ${want}, `).test(((await sheet2.locator(`.brief-item[data-item="${tierItem.id}"] .brief-acted`).textContent()) ?? '').trim()));
      check(seen, `the second window shows the first window's action within 2 s (${Date.now() - t0} ms)`);
      check(await within(page, 3000, async () => new RegExp(`^Tier set to ${want}, `).test(((await row.locator('.brief-acted').textContent()) ?? '').trim())), 'and the first says it too');
    }
    check(errors2.length === 0, `the second window has no console errors${errors2.length ? `: ${errors2.join(' | ')}` : ''}`);
    await second.close();

    // ------------------------------------------------------------ Change today's limit: above the cap, by keyboard, until midnight
    const usageRow = sheet.locator('.brief-item[data-item="usage"]');
    check((await usageRow.count()) === 1, 'the usage line offers to change today\'s limit');
    if (await usageRow.count()) {
      const cap = usageRow.locator('.brief-act[data-action="cap"]');
      await cap.click();
      const input = usageRow.locator('input.brief-cap-input');
      check(await within(page, 2000, async () => (await input.count()) === 1), 'Change today\'s limit opens a one-line field');
      check((await input.inputValue()) === '50' && /until midnight/.test((await usageRow.locator('.brief-cap').textContent()) ?? ''), `with the current cap and "until midnight" (${await input.inputValue()})`);
      check(await page.evaluate(() => document.activeElement?.classList.contains('brief-cap-input') ?? false), 'and the field takes focus');
      check((await input.getAttribute('max')) === '85' && /85%/.test((await usageRow.locator('.brief-cap').textContent()) ?? ''), 'it may rise to 85%, five points under the hard stop');
      await usageRow.evaluate((r) => r.scrollIntoView({ block: 'center' }));
      await input.fill('60');
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(shots, 'brief-cap.png') });
      // Scrolled, the title stands on an opaque head, ruled off from the rows passing under it.
      const head = await sheet.locator('.sheet-head').evaluate((h) => {
        const cs = getComputedStyle(h);
        const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(cs.backgroundColor)?.[1];
        return { bg: cs.backgroundColor, opaque: cs.backgroundColor.startsWith('rgb(') || alpha === '1', ruled: parseFloat(cs.borderBottomWidth) >= 1, scrolled: (h.closest('.sheet') as HTMLElement).dataset.scrolled };
      });
      check(head.opaque && head.ruled && head.scrolled === 'true', `scrolled, the head is opaque and ruled off from the rows (${JSON.stringify(head)})`);
      // Escape in the field puts it away and stays on the brief.
      await page.keyboard.press('Escape');
      check(await within(page, 2000, async () => (await input.count()) === 0), 'Escape puts the field away');
      check((await page.evaluate(() => document.body.dataset.route)) === 'brief', 'and stays on the brief');
      check(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action === 'cap'), 'with focus back on Change today\'s limit');
      await page.keyboard.press('Enter');
      await within(page, 2000, async () => (await input.count()) === 1);
      await input.fill('60');
      await page.keyboard.press('Enter');
      check(await within(page, 5000, async () => /^Today's limit set to 60% by you, /.test(((await usageRow.locator('.brief-acted').textContent()) ?? '').trim())), `Enter sets today's limit to 60%, named as his (${((await usageRow.locator('.brief-acted').textContent()) ?? '').trim()})`);
      check(await within(page, 3000, async () => /today's limit of 60%, set by you until midnight/.test((await sheet.locator('.brief-usage').textContent()) ?? '')), 'the usage line says so');
      check((await usageRow.locator('.brief-act[data-action="cap"]').count()) === 1, 'and he can change it again from here while it holds');
      await go(page, '#/treasury');
      const five = page.locator('.sheet.treasury .meter[data-window="five"]');
      check(await within(page, 6000, async () => /today's limit 60%/i.test((await five.textContent()) ?? '')), `the treasury shows "today's limit 60%" beside the five-hour meter (${((await five.locator('.meter-today').textContent().catch(() => '')) ?? '').trim()})`);
      check(/set by you/.test((await five.textContent()) ?? ''), 'set by him');
      await go(page, '#/brief');
      await within(page, 4000, async () => (await sheet.locator('.brief-item').count()) > 0);
      // Lowered again from the brief, back to the usual 50%.
      await usageRow.locator('.brief-act[data-action="cap"]').click();
      await usageRow.locator('input.brief-cap-input').fill('50');
      await usageRow.locator('.brief-cap-set').click();
      check(await within(page, 5000, async () => /^Today's limit set to 50% by you, /.test(((await usageRow.locator('.brief-acted').textContent()) ?? '').trim())), 'and lowers it again from the brief');
    }

    // ------------------------------------------------------------ the tour row (from the engine's own Monday brief)
    const monday = (() => {
      const d = new Date();
      const ahead = (8 - d.getDay()) % 7 || 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + ahead, 8, 0).getTime();
    })();
    const mondayBrief = briefData(monday);
    const tourItem = mondayBrief.sections.city.find((i) => i.kind === 'tour');
    check(!!tourItem && !!mondayBrief.tour, `the engine's Monday brief offers the week's tour (${mondayBrief.tour?.stops ?? 0} stops)`);
    if (tourItem && mondayBrief.tour) {
      const tourPage = await page.context().browser()!.newPage({ viewport: SIZE });
      await tourPage.setViewportSize(SIZE);
      await tourPage.route('**/api/brief', async (route) => {
        const res = await route.fetch();
        const b = (await res.json()) as Brief;
        b.sections.city.push(tourItem);
        b.tour = mondayBrief.tour;
        await route.fulfill({ response: res, json: b });
      });
      await tourPage.goto(`${new URL(page.url()).origin}/?debug#/brief`);
      const row = tourPage.locator(`.brief-item[data-item="${tourItem.id}"]`);
      check(await within(tourPage, 10_000, async () => (await row.count()) === 1), 'on a Monday the brief offers the week\'s tour');
      const text = ((await row.textContent()) ?? '').trim();
      check(new RegExp(`${mondayBrief.tour.stops} stops`).test(text) && (await row.locator('.brief-act[data-action="tour"]').textContent()) === 'Walk through the week', `with its stop count and "Walk through the week" (${text.slice(0, 90)})`);
      await row.evaluate((r) => r.scrollIntoView({ block: 'center' }));
      await tourPage.waitForTimeout(400);
      await tourPage.screenshot({ path: join(shots, 'brief-tour.png') });
      // Until the city walks it (Task 17), taking the tour says when it comes, and nothing is recorded as taken.
      const toursBefore = query({ kind: 'brief.action' }).filter((e) => (e.data as { action?: string }).action === 'tour').length;
      await row.locator('.brief-act[data-action="tour"]').focus();
      await tourPage.keyboard.press('Enter');
      const later = await within(tourPage, 3000, async () => ((await row.locator('.brief-quiet').textContent()) ?? '').trim() === 'The tour arrives with the city track.');
      check(later, `Walk through the week says the tour arrives with the city track (${((await row.locator('.brief-quiet').textContent().catch(() => '')) ?? '').trim()})`);
      await tourPage.waitForTimeout(500);
      check(!/Walked through the week/.test((await row.textContent()) ?? '') && (await row.locator('.brief-error').count()) === 0, 'and the row does not say he walked it');
      check(query({ kind: 'brief.action' }).filter((e) => (e.data as { action?: string }).action === 'tour').length === toursBefore, 'and no tour is recorded until one starts');
      check(await tourPage.evaluate(() => document.activeElement?.classList.contains('brief-quiet') ?? false), 'focus lands on the quiet line');
      await tourPage.close();
    }

    // ------------------------------------------------------------ Fly to the floor: the brief gives way and the camera moves
    const merged = (await api<Brief>(page, '/api/brief')).sections.overnight.find((i) => i.kind === 'merged' && i.actions.includes('fly'));
    check(!!merged, 'a merged job offers Fly to the floor');
    if (merged) {
      const was = await camera(page);
      await sheet.locator(`.brief-item[data-item="${merged.id}"] .brief-act[data-action="fly"]`).click();
      check(await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city'), 'Fly to the floor leaves the brief for the city');
      await page.waitForTimeout(2500);
      const now = await camera(page);
      check(Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]) > 1, 'and the camera moves to the floor');
      const flew = query({ kind: 'brief.action' }).filter((e) => (e.data as { itemId?: string }).itemId === merged.id).at(-1);
      check((flew?.data as { action?: string } | undefined)?.action === 'fly', 'and the ledger keeps that he flew');
    }

    // ------------------------------------------------------------ T in the city: the tour, or the quiet line saying when it comes
    await page.locator('#city canvas').focus();
    await page.keyboard.press('t');
    const said = await within(page, 2000, async () => /The tour arrives with the city track/.test(await page.evaluate(() => (window as unknown as { __palimpsest: { notice(): string } }).__palimpsest.notice())));
    check(said, 'T in the city says the tour arrives with the city track');
    await page.locator('.city-notice-line[data-key="tour"] .city-notice-dismiss').click().catch(() => {});
    await page.keyboard.press('Escape');
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

async function runheadSaysBrief(page: Page): Promise<boolean> {
  const links = await page.locator('.runhead .runhead-link').evaluateAll((as) => as.map((a) => ({ route: (a as HTMLElement).dataset.route, current: a.getAttribute('aria-current') === 'page' })));
  return links[0]?.route === 'city' && links[1]?.route === 'brief' && links[1].current;
}

/**
 * The empty morning, on a fresh home: no repos, nothing in the ledger and
 * a fresh reading well under the cap, so the brief has no item. The city
 * opens with the one quiet line, the Brief link stays in the running head,
 * and `brief.opened` is still recorded, with no items.
 */
export async function emptyMorningChecks(browser: Browser, origin: string, check: Check, shots: string): Promise<void> {
  const { query } = await import('../engine/ledger.js');
  const { paths } = await import('../engine/home.js');
  const { localDay } = await import('../shared/day.js');
  // A fresh reading at 12%: no stale reading and no window near its cap.
  const sec = Math.floor(Date.now() / 1000) - 120;
  mkdirSync(paths().usage, { recursive: true });
  writeFileSync(join(paths().usage, 'readings.jsonl'), `${JSON.stringify({ at: sec, rate_limits: { five_hour: { used_percentage: 12, resets_at: sec + 4 * 3600 }, seven_day: { used_percentage: 9, resets_at: sec + 5 * 86400 } } })}\n`);
  const page = await browser.newPage({ viewport: SIZE });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    const brief = (await (await fetch(`${origin}/api/brief`)).json()) as Brief;
    check(itemsOf(brief).length === 0 && brief.due === false, `a fresh home with no repos has an empty brief (${itemsOf(brief).map((i) => i.id).join(', ') || 'no items'})`);
    await page.goto(`${origin}/?debug`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    check((await page.evaluate(() => document.body.dataset.route)) === 'city', 'on an empty morning the city opens');
    const notice = await page.evaluate(() => (window as unknown as { __palimpsest: { notice(): string } }).__palimpsest.notice());
    check(/Nothing waits on you this morning/.test(notice), `with the one quiet line (${notice})`);
    const opened = query({ kind: 'brief.opened' }).filter((e) => (e.data as { day?: string }).day === localDay(Date.now()));
    check(opened.length === 1 && ((opened[0].data as { items?: string[] }).items ?? ['x']).length === 0, `and brief.opened is still recorded, with no items (${opened.length})`);
    check(await page.locator('.runhead-link[data-route="brief"]').count() === 1, 'the Brief link stays in the running head');
    await page.screenshot({ path: join(shots, 'brief-empty.png') });
    await go(page, '#/brief');
    const empty = await within(page, 5000, async () => /Nothing waits on you this morning/.test((await page.locator('.sheet.brief .brief-empty').textContent()) ?? ''));
    check(empty, 'and the brief itself says so');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'brief-empty-page.png') });
    check(errors.length === 0, `the empty morning has no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } finally {
    await page.close();
  }
}
