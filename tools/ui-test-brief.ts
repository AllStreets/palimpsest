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
 *
 * The act calls the run's clicks make (POST /api/brief/items/:id/:action and
 * its body) are recorded in order and held to tools/fixtures/brief-act-calls.json,
 * the contract the Brief's rebuild must reproduce (screens redesign Task 14).
 * The fixture is written when it is missing, or with BRIEF_ACT_CALLS=record.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page, Request } from 'playwright';

import type { Brief, BriefAction, BriefItem, Job, Milestone, Tier } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

const SIZE = { width: 1600, height: 1000 };
const SECTIONS = [
  ['waiting', 'Waiting on you'],
  ['overnight', 'Overnight'],
  ['recommendations', 'Recommended'],
  ['city', 'In the city'],
] as const;

/** A 240-character PR title with markup in it, and a 600-character summary (Review Focus 5): both must stand as text. */
export const LONG_TITLE = `Keep the <b>nightly</b> ledger export's rows past midnight UTC &amp; stop the window starting at local midnight, so invoices dated 23:59 stay in their own day, the totals match the bank's, and the reconciliation report stops flagging them by hand`.slice(0, 240);
export const LONG_SUMMARY = [
  'The nightly export built its window from **local** midnight, so rows written between 23:00 and 23:59 UTC fell into the next day and the totals drifted from the bank statement.',
  '',
  '- `window.ts` now starts the day at UTC midnight, and `nightly.ts` reads the same window for the totals <b>and</b> the rows.',
  '- A test writes rows at 23:59 UTC &amp; checks they stay in their own day; it failed before the change and passes after it.',
  '- The whole suite passes, 412 of 412, and typecheck is clean. Nothing outside the export was touched.',
].join('\n').slice(0, 600);

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

/** One act call the Brief made: POST /api/brief/items/:id/:action with its body. */
export interface ActCall {
  itemId: string;
  action: string;
  body: Record<string, unknown>;
}

/**
 * The contract the Brief's rebuild must reproduce (screens redesign Task 14):
 * the act calls this script's run makes, in order. An item's id names a job,
 * a run or a week that differ from run to run, so the fixture keeps its kind
 * (the id's prefix) and stars the rest; the run also checks the exact ids.
 */
export const ACT_CALLS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brief-act-calls.json');

export const actCallShape = (c: ActCall): ActCall => ({ itemId: c.itemId.includes(':') ? `${c.itemId.slice(0, c.itemId.indexOf(':'))}:*` : c.itemId, action: c.action, body: c.body });

/** Collects the act calls a page makes, by listening to its requests, not by asking the page. */
function actRecorder(): { calls: ActCall[]; listen: (p: Page) => void; stop: () => void } {
  const calls: ActCall[] = [];
  const pages: Page[] = [];
  const on = (r: Request): void => {
    if (r.method() !== 'POST') return;
    const m = /^\/api\/brief\/items\/([^/]+)\/([^/]+)$/.exec(new URL(r.url()).pathname);
    if (!m) return;
    let body: Record<string, unknown> = {};
    try {
      body = (r.postDataJSON() as Record<string, unknown> | null) ?? {};
    } catch {
      body = { unread: r.postData() };
    }
    calls.push({ itemId: decodeURIComponent(m[1]), action: decodeURIComponent(m[2]), body });
  };
  return {
    calls,
    listen: (p) => {
      p.on('request', on);
      pages.push(p);
    },
    stop: () => {
      for (const p of pages) p.off('request', on);
    },
  };
}

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
  // Every act call the script's clicks make, and the ones it means to make, in order (Task 14's contract).
  const recorder = actRecorder();
  recorder.listen(page);
  const meant: ActCall[] = [];
  const mean = (itemId: string, action: BriefAction, body: { tier?: Tier; pct?: number } = {}): void => {
    meant.push({ itemId, action, body });
  };
  try {
    // ------------------------------------------------------------ a new morning on the economy
    const today = localDay(Date.now());
    const ribbon = listMilestones(Date.now(), { active: true }).find((m: Milestone) => m.kind === 'ribbon' || m.kind === 'revival');
    if (ribbon) {
      record('milestone.reached', { milestone: ribbon });
      emit('milestone.reached', { milestone: ribbon });
    }
    openDb().prepare("DELETE FROM ledger WHERE kind = 'brief.opened' AND json_extract(json, '$.day') = ?").run(today);
    // Review Focus 5: the first PR waiting for review takes a 240-character title with markup in it, set as text.
    const longPr = briefData(Date.now()).sections.waiting.find((i: BriefItem) => i.kind === 'pr' && i.refs.jobId);
    if (longPr?.refs.jobId) openDb().prepare("UPDATE jobs SET json = json_set(json, '$.title', ?) WHERE id = ?").run(LONG_TITLE, longPr.refs.jobId);
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
    check((await sheet.locator('.brief-kicker').count()) === 0 && (await sheet.getAttribute('aria-label')) === 'Brief', 'named Brief, with the day as its heading and no kicker over it');
    const lead = ((await sheet.locator('.brief-lead').textContent()) ?? '').trim();
    check(lead === brief.lead && lead.length > 20, `the lead stands under the title (${lead.slice(0, 60)})`);
    const usage = ((await sheet.locator('.brief-usage').textContent()) ?? '').trim();
    check(/five-hour window stands at \d+%/.test(usage) && /today's limit of 50%/.test(usage) && /seven-day window at \d+%/.test(usage), `the usage line names both windows and today's limit (${usage})`);
    for (const [key, name] of SECTIONS) {
      const sec = sheet.locator(`.brief-sec[data-sec="${key}"]`);
      const head = ((await sec.locator('.brief-sec-name').textContent().catch(() => '')) ?? '').trim();
      const n = await sec.locator('.brief-item').count();
      check(head === name && n > 0, `"${name}" has at least one item (${n})`);
    }
    check(await runheadSaysBrief(page), 'the running head has Brief, after City, marked as the place');
    // One row per item (screens redesign Task 17): a headline, its figures and its keys in one line, the whole
    // sentence kept for the reader alone.
    const rows = await sheet.locator('.brief-item').evaluateAll((els) =>
      els.map((li) => {
        const line = li.querySelector('.brief-line');
        const acts = [...li.querySelectorAll('.brief-act')];
        const sentence = li.querySelector('.brief-sentence');
        return {
          head: !!li.querySelector('h3.brief-head'),
          read: !!sentence && sentence.classList.contains('os-sr') && (sentence.textContent ?? '').trim().length > 0,
          inLine: acts.every((a) => a.parentElement?.closest('.brief-line') === line),
          focusable: acts.every((a) => (a as HTMLElement).tabIndex >= 0 && /^(BUTTON|A)$/.test(a.tagName)),
          undefinedOrNaN: /\bundefined\b|\bNaN\b/.test(li.textContent ?? ''),
          emptyReadouts: li.querySelectorAll('.os-readouts:empty').length,
        };
      }),
    );
    check(rows.length > 0 && rows.every((r) => r.head && r.read && r.inLine && r.focusable), 'every row is a headline with its keys in its line, each reachable by Tab, and its sentence kept for the reader');
    check(rows.every((r) => !r.undefinedOrNaN && r.emptyReadouts === 0), 'no row shows undefined, NaN or an empty readout box');
    // Every key is weighed, and the one red, filled key is the grant on an open ask: one per ask, no more.
    const keys = await sheet.locator('.brief-act').evaluateAll((els) =>
      els.map((a) => {
        const cs = getComputedStyle(a);
        return { weight: (a as HTMLElement).dataset.weight ?? '', red: /255, 85, 50/.test(cs.backgroundImage) || /255, 85, 50/.test(cs.backgroundColor), underline: cs.textDecorationLine !== 'none', label: a.getAttribute('aria-label') ?? '' };
      }),
    );
    const asks = itemsOf(brief).filter((i) => i.kind === 'autonomy' && i.actions.includes('grant')).length;
    check(keys.length > 0 && keys.every((k) => /^(look|decide|spend|grant)$/.test(k.weight)), `every key has its weight (${keys.length})`);
    check(keys.filter((k) => k.weight === 'grant').length === asks && keys.filter((k) => k.red).length === asks && keys.every((k) => !k.red || k.weight === 'grant'), `exactly one grant, filled red, per open ask (${asks})`);
    check(keys.every((k) => !k.underline), 'no key carries a text button\'s underline');
    const posts = await sheet.locator('.brief-act[data-action="accept"]').evaluateAll((els) => els.map((a) => ({ sum: a.querySelector('.os-sum')?.textContent ?? '', label: a.getAttribute('aria-label') ?? '' })));
    check(posts.length > 0 && posts.every((p) => /^\d[\d.,]* cr$/.test(p.sum) && /^Post, up to [\d.,]+ credits: /.test(p.label)), `Post carries its sum on the key and in its name (${posts.map((p) => `${p.sum} / ${p.label.slice(0, 32)}`).join('; ')})`);
    check((await sheet.locator('img, iframe, script').count()) === 0, 'the brief is set as text only');
    // The pins (screens redesign Task 17): numbered pins on the towers of what waits, the city's own plates gone,
    // and the lock on the autonomy ask while one is open, else on the first target.
    await page.waitForTimeout(900);
    const pinsShown = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.os-pins');
      const plates = document.querySelector('.plates');
      return {
        shown: !!root && !root.hidden,
        numbered: document.querySelectorAll('.os-pin.on:not(.quiet)').length,
        plates: plates ? getComputedStyle(plates).opacity : 'none',
        lockGrant: !!document.querySelector('.os-lock.on.grant'),
        lockOn: !!document.querySelector('.os-lock.on'),
      };
    });
    check(pinsShown.shown && pinsShown.numbered > 0 && pinsShown.plates === '0', `the brief pins what waits on the city's towers, its plates gone (${JSON.stringify(pinsShown)})`);
    check(pinsShown.lockOn && pinsShown.lockGrant === itemsOf(brief).some((i) => i.kind === 'autonomy' && i.actions.includes('grant') && !!i.repo), `the lock stands on the autonomy ask (${JSON.stringify(pinsShown)})`);
    if (longPr) {
      const long = await sheet.locator(`.brief-item[data-item="${longPr.id}"]`).evaluate((r) => ({ head: r.querySelector('h3.brief-head')?.textContent ?? '', tags: r.querySelectorAll('b').length }));
      check(long.head.includes('<b>') && long.head.includes('&amp;') && long.tags === 0, `a title with markup in it stands as text, no <b> element made (${long.head.slice(0, 50)})`);
    }
    // A proposal's pin names what posting it would cost, the sum on its Post key (ruling: the cost, not the tier):
    // aimed at, its row puts the lock on its tower, and the lock's tag carries the pin's figure.
    const post = sheet.locator('.brief-sec[data-sec="waiting"] .brief-list:not(.brief-handled) .brief-item[data-kind="proposal"]:has(.brief-act[data-action="accept"])').first();
    if (await post.count()) {
      await post.scrollIntoViewIfNeeded();
      await post.hover();
      const sum = ((await post.locator('.brief-act[data-action="accept"] .os-sum').textContent()) ?? '').trim();
      const tag = await within(page, 2000, async () => ((await page.locator('.os-lock-fig').textContent()) ?? '').trim() === sum);
      check(tag && / cr$/.test(sum), `a proposal's pin carries its cost (${sum} against ${((await page.locator('.os-lock-fig').textContent()) ?? '').trim()})`);
      await page.mouse.move(SIZE.width - 8, SIZE.height - 8);
      await sheet.locator('.sheet-body').evaluate((b) => {
        b.scrollTop = 0;
      });
    } else check(false, 'a proposal with Post waits, for its pin');
    const numbers = await sheet.locator('.brief-sec[data-sec="waiting"] .brief-list:not(.brief-handled) .brief-des').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    const numbered = numbers.filter((n) => n !== '');
    check(numbered.length > 0 && numbered.every((n, i) => n === String(i + 1).padStart(2, '0')), `the waiting rows with a district are numbered in list order (${numbers.join(' ')})`);
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
      mean(auditProposal.id, 'why');
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
      mean(toAccept.id, 'accept');
      await row.locator('.brief-act[data-action="accept"]').click();
      const said = await within(page, 5000, async () => /^Posted \d{2}:\d{2}$/.test(((await row.locator('.brief-acted').textContent()) ?? '').trim()));
      check(said, `Post as a job moves the proposal and the row says so (${((await row.locator('.brief-acted').textContent()) ?? '').trim()})`);
      const job = (await api<{ job: Job }>(page, `/api/jobs/${toAccept.refs.jobId}`)).job;
      check(job.status !== 'proposed' && job.status !== 'withdrawn', `the job is posted (${job.status})`);
      check((await row.locator('.brief-act[data-action="accept"]').count()) === 0, 'and the row offers it no more');
      check(await page.evaluate(() => document.activeElement?.classList.contains('brief-acted') ?? false), 'focus lands on what the row now says');
      // Settled, it leaves the rows that need a click for the quieter Handled today under them (audit 2026-11-17).
      const waiting = sheet.locator('.brief-sec[data-sec="waiting"]');
      check(await within(page, 3000, async () => (await waiting.locator(`.brief-handled .brief-item[data-item="${toAccept.id}"]`).count()) === 1), 'the posted proposal moves to Handled today');
      check(((await waiting.locator('.brief-handled-head').textContent()) ?? '').trim() === 'Handled today' && (await waiting.locator('.brief-handled-head').isVisible()), 'under its own quiet heading');
      const order = await waiting.locator('.brief-item').evaluateAll((els) => els.map((e) => !!e.closest('.brief-handled')));
      check(order.indexOf(true) === -1 || order.slice(order.indexOf(true)).every(Boolean), `every row that waits comes before every handled one (${JSON.stringify(order)})`);
      // No named helper inside the page function: tsx names it with __name, which the page does not have.
      const sizes = await waiting.evaluate((w) => {
        const open = w.querySelector('.brief-list:not(.brief-handled) .brief-head');
        const handled = w.querySelector('.brief-handled .brief-head');
        return { open: open ? parseFloat(getComputedStyle(open).fontSize) : 99, handled: handled ? parseFloat(getComputedStyle(handled).fontSize) : NaN };
      });
      check(sizes.handled < sizes.open, `and set smaller than the rows that wait (${sizes.handled} against ${sizes.open})`);
    }

    // ------------------------------------------------------------ Dismiss on the failed job: marked, and taught
    const failed = itemsOf(brief).find((i) => i.kind === 'failed' && i.actions.includes('dismiss'));
    check(!!failed, 'the failed job offers Dismiss');
    if (failed) {
      const row = sheet.locator(`.brief-item[data-item="${failed.id}"]`);
      mean(failed.id, 'dismiss');
      await row.locator('.brief-act[data-action="dismiss"]').click();
      check(await within(page, 5000, async () => /^Dismissed \d{2}:\d{2}$/.test(((await row.locator('.brief-acted').textContent()) ?? '').trim())), 'Dismiss marks the failed job in place');
      check((await row.getAttribute('data-acted')) === 'dismiss', 'and quiets the row');
      const act = query({ kind: 'brief.action' }).filter((e) => (e.data as { itemId?: string }).itemId === failed.id).at(-1);
      check((act?.data as { taught?: boolean; action?: string } | undefined)?.taught === true && (act?.data as { action?: string }).action === 'dismiss', 'and records it as taught');
    }

    // ------------------------------------------------------------ a second window: the same items, and the first window's action within 2 s
    const second = await page.context().browser()!.newPage({ viewport: SIZE });
    recorder.listen(second);
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
    check((await sheet2.getAttribute('data-first')) === 'false' && /, second look$/.test((await sheet2.locator('.brief-since .os-sr').textContent()) ?? ''), `and its brief says it is not the first open (${(await sheet2.locator('.brief-since .os-sr').textContent()) ?? ''})`);
    const ids2 = await sheet2.locator('.brief-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item ?? ''));
    check(JSON.stringify([...ids2].sort()) === JSON.stringify([...shownIds].sort()), `with the same items (${ids2.length} and ${shownIds.length})`);
    const tierItem = itemsOf(brief).find((i) => i.kind === 'proposal' && i.actions.includes('tier') && i.id !== toAccept?.id);
    if (tierItem) {
      const row = sheet.locator(`.brief-item[data-item="${tierItem.id}"]`);
      await row.locator('.brief-act[data-action="tier"]').click();
      const want = tierItem.tier === 'low' ? 'high' : 'low';
      mean(tierItem.id, 'tier', { tier: want });
      await row.locator(`.brief-tier [role="radio"][data-tier="${want}"]`).click();
      const t0 = Date.now();
      const seen = await within(second, 2000, async () => new RegExp(`^Tier ${want} \\d{2}:\\d{2}$`).test(((await sheet2.locator(`.brief-item[data-item="${tierItem.id}"] .brief-acted`).textContent()) ?? '').trim()));
      check(seen, `the second window shows the first window's action within 2 s (${Date.now() - t0} ms)`);
      check(await within(page, 3000, async () => new RegExp(`^Tier ${want} \\d{2}:\\d{2}$`).test(((await row.locator('.brief-acted').textContent()) ?? '').trim())), 'and the first says it too');
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
      check(await input.evaluate((i) => getComputedStyle(i).outlineStyle !== 'none' && parseFloat(getComputedStyle(i).outlineWidth) >= 1), 'with its focus drawn, visibly');
      check((await input.getAttribute('max')) === '85' && /85%/.test((await usageRow.locator('.brief-cap').textContent()) ?? ''), 'it may rise to 85%, five points under the hard stop');
      await usageRow.evaluate((r) => r.scrollIntoView({ block: 'center' }));
      await input.fill('60');
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(shots, 'brief-cap.png') });
      // Scrolled, the title stands on the near plate, over the rows passing under it.
      const head = await sheet.locator('.sheet-head').evaluate((h) => {
        const cs = getComputedStyle(h);
        const body = getComputedStyle(h.parentElement!.querySelector('.sheet-body')!);
        return { plate: /gradient/.test(cs.backgroundImage), over: Number(cs.zIndex) > (Number(body.zIndex) || 0), scrolled: (h.closest('.sheet') as HTMLElement).dataset.scrolled };
      });
      check(head.plate && head.over && head.scrolled === 'true', `scrolled, the head is a plate standing over the rows (${JSON.stringify(head)})`);
      // Escape in the field puts it away and stays on the brief.
      await page.keyboard.press('Escape');
      check(await within(page, 2000, async () => (await input.count()) === 0), 'Escape puts the field away');
      check((await page.evaluate(() => document.body.dataset.route)) === 'brief', 'and stays on the brief');
      check(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action === 'cap'), 'with focus back on Change today\'s limit');
      await page.keyboard.press('Enter');
      await within(page, 2000, async () => (await input.count()) === 1);
      await input.fill('60');
      mean('usage', 'cap', { pct: 60 });
      await page.keyboard.press('Enter');
      check(await within(page, 5000, async () => /^Limit 60% \d{2}:\d{2}$/.test(((await usageRow.locator('.brief-acted').textContent()) ?? '').trim())), `Enter sets today's limit to 60%, named as his (${((await usageRow.locator('.brief-acted').textContent()) ?? '').trim()})`);
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
      mean('usage', 'cap', { pct: 50 });
      await usageRow.locator('.brief-cap-set').click();
      check(await within(page, 5000, async () => /^Limit 50% \d{2}:\d{2}$/.test(((await usageRow.locator('.brief-acted').textContent()) ?? '').trim())), 'and lowers it again from the brief');
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
      recorder.listen(tourPage);
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
      const outs = await row.locator('.os-readout').evaluateAll((els) => els.map((e) => [e.querySelector('.os-readout-v')?.textContent ?? '', e.querySelector('.os-readout-k')?.textContent ?? ''].join(' ')));
      check(outs.includes(`${mondayBrief.tour.stops} stops`) && ((await row.locator('.brief-act[data-action="tour"] .brief-act-label').textContent()) ?? '') === 'Walk the week', `with its stop count and "Walk the week" (${outs.join(', ')})`);
      await row.evaluate((r) => r.scrollIntoView({ block: 'center' }));
      await tourPage.waitForTimeout(400);
      await tourPage.screenshot({ path: join(shots, 'brief-tour.png') });
      // Taking the tour (Task 17): the brief gives way to the city, the camera walks the week, and the ledger keeps it.
      // The row here is Monday's, set into today's brief, so the engine (which acts only on today's items) may refuse to
      // record it: what is checked is that the brief asks it to, once the walk has started.
      const asked = tourPage.waitForRequest((r) => r.method() === 'POST' && /\/api\/brief\/items\/tour%3A[^/]+\/tour$/.test(r.url()), { timeout: 8000 }).then(() => true).catch(() => false);
      await row.locator('.brief-act[data-action="tour"]').focus();
      mean(tourItem.id, 'tour');
      await tourPage.keyboard.press('Enter');
      const walking = await within(tourPage, 8000, async () => (await tourPage.evaluate(() => (window as unknown as { __palimpsest: { tour(): unknown } }).__palimpsest.tour())) !== null);
      check(walking, 'Walk through the week starts the tour in the city');
      check(await within(tourPage, 3000, async () => (await tourPage.evaluate(() => document.body.dataset.route)) === 'city'), 'and the brief gives way to it');
      check(await asked, 'and the brief records that he took it');
      await tourPage.keyboard.press('Escape');
      check(await within(tourPage, 3000, async () => (await tourPage.evaluate(() => (window as unknown as { __palimpsest: { tour(): unknown } }).__palimpsest.tour())) === null), 'Escape ends it');
      await tourPage.close();
    }

    // ------------------------------------------------------------ Open PR: the link leaves for GitHub, and the look is recorded
    // window.open is held for the click, so nothing leaves the machine, then put back. A string, as above, not a function.
    const prItem = (await api<Brief>(page, '/api/brief')).sections.waiting.find((i) => i.kind === 'pr' && i.actions.includes('open-pr') && /^https:\/\/github\.com\//.test(i.refs.prUrl ?? ''));
    check(!!prItem, 'a PR waiting for review offers Open PR');
    if (prItem) {
      await page.evaluate(`window.__open0 = window.open; window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };`);
      const link = sheet.locator(`.brief-item[data-item="${prItem.id}"] .brief-act[data-action="open-pr"]`);
      check((await link.getAttribute('href')) === prItem.refs.prUrl, 'Open PR is a link to the PR');
      mean(prItem.id, 'open-pr');
      await link.click();
      const opened = await within(page, 3000, async () => ((await page.evaluate('window.__opened')) as string[]).length === 1);
      check(opened && ((await page.evaluate('window.__opened[0]')) as string) === prItem.refs.prUrl, 'and opens the PR');
      await page.evaluate('window.open = window.__open0');
    }

    // ------------------------------------------------------------ Fly to the floor: the brief gives way and the camera moves
    const merged = (await api<Brief>(page, '/api/brief')).sections.overnight.find((i) => i.kind === 'merged' && i.actions.includes('fly'));
    check(!!merged, 'a merged job offers Fly to the floor');
    if (merged) {
      const was = await camera(page);
      mean(merged.id, 'fly');
      await sheet.locator(`.brief-item[data-item="${merged.id}"] .brief-act[data-action="fly"]`).click();
      check(await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city'), 'Fly to the floor leaves the brief for the city');
      await page.waitForTimeout(2500);
      const now = await camera(page);
      check(Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]) > 1, 'and the camera moves to the floor');
      const flew = query({ kind: 'brief.action' }).filter((e) => (e.data as { itemId?: string }).itemId === merged.id).at(-1);
      check((flew?.data as { action?: string } | undefined)?.action === 'fly', 'and the ledger keeps that he flew');
    }

    // ------------------------------------------------------------ the act calls: what was meant, and main's contract
    await page.waitForTimeout(300);
    const made = recorder.calls;
    check(JSON.stringify(made) === JSON.stringify(meant), `every click made exactly its act call, in order (${made.map((c) => c.action).join(', ')})`);
    const shape = made.map(actCallShape);
    writeFileSync(join(shots, 'brief-act-calls.json'), `${JSON.stringify(shape, null, 2)}\n`);
    if (!existsSync(ACT_CALLS) || process.env.BRIEF_ACT_CALLS === 'record') {
      mkdirSync(dirname(ACT_CALLS), { recursive: true });
      writeFileSync(ACT_CALLS, `${JSON.stringify(shape, null, 2)}\n`);
      check(made.length > 0, `the act calls are recorded as the contract (${ACT_CALLS})`);
    } else {
      const want = JSON.parse(readFileSync(ACT_CALLS, 'utf8')) as ActCall[];
      check(JSON.stringify(shape) === JSON.stringify(want), `the act calls are main's contract (${shape.length} against ${want.length})`);
    }

    // ------------------------------------------------------------ five opens and closes in two seconds (Review Focus 3)
    await go(page, '#/');
    await page.waitForSelector('body[data-route="city"]', { timeout: 8000 });
    await page.waitForTimeout(700);
    const hooks = (): Promise<number> => page.evaluate(() => (window as unknown as { __palimpsest: { frameHooks(): number } }).__palimpsest.frameHooks());
    const hooks0 = await hooks();
    for (let i = 0; i < 5; i++) {
      await go(page, '#/brief');
      await page.waitForTimeout(200);
      await go(page, '#/');
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const plates = document.querySelector('.plates');
      return { pins: document.querySelectorAll('.os-pins:not([hidden]), .os-pin.on, .os-lock.on').length, plates: plates ? getComputedStyle(plates).opacity : 'none', flag: document.documentElement.dataset.osPins ?? '' };
    });
    check((await hooks()) === hooks0 && after.pins === 0 && after.plates === '1' && after.flag === '', `five opens and closes of the brief in two seconds leave no hook, no pin and the plates whole (${await hooks()} hooks against ${hooks0}, ${JSON.stringify(after)})`);

    // ------------------------------------------------------------ T in the city: the week's tour walks
    await page.locator('#city canvas').focus();
    await page.keyboard.press('t');
    const walks = await within(page, 8000, async () => (await page.evaluate(() => (window as unknown as { __palimpsest: { tour(): unknown } }).__palimpsest.tour())) !== null);
    check(walks, 'T in the city walks the week');
    await page.keyboard.press('Escape');
    await within(page, 3000, async () => (await page.evaluate(() => (window as unknown as { __palimpsest: { tour(): unknown } }).__palimpsest.tour())) === null);
  } finally {
    recorder.stop();
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
