/**
 * The firm pages and the agent page's UI checks (Task 38), run by
 * tools/ui-test.ts on its own engine (port 4779, a temp home) after the job
 * pages' checks, on the sample economy: six firms with Lodestar bankrupt and
 * its tower sold to Quickset, Dagny Hollis hired from the roster, the rest
 * seeded with the city. The firms list shows all six with one bankrupt, a
 * firm's running balance ends at its balance, the agent page shows the
 * workflow shape and the hired specialist's lineage, and Follow points at
 * the persona. A firm below zero reads its hours left in rust.
 *
 * Saves firms.png, firms-negative.png, firm.png, firm-books.png,
 * firm-bankrupt.png, agent.png, agent-persona.png and agent-tower.png at 1600 x 1000 for the quality rounds.
 */
import { join } from 'node:path';

import type { Page } from 'playwright';

import type { AgentDetail, Firm, FirmDetail, FirmView } from '../shared/types.js';

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

/** A figure as the page sets it, back to a number: no thousands comma, a true minus read as a minus. */
const num = (s: string | null): number => Number((s ?? '').replace(/,/g, '').replace('\u2212', '-'));

export async function firmChecks(page: Page, check: Check, shots: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  try {
    const firms = await api<FirmView[]>(page, '/api/firms');

    // ------------------------------------------------------------ the firms list
    await go(page, '#/firms');
    const rows = page.locator('.sheet.firms .firm-row');
    check(await within(page, 6000, async () => (await rows.count()) === 6), `the firms list shows six firms (${await rows.count()})`);
    check((await page.evaluate(() => document.body.dataset.route)) === 'firms', 'the route is the firms list');
    check((await page.locator('.runhead-link[data-route="firms"]').getAttribute('aria-current')) === 'page', 'the running head marks Firms');
    const bankrupt = page.locator('.sheet.firms .firm-row.bankrupt');
    check((await bankrupt.count()) === 1 && /Lodestar/.test((await bankrupt.locator('.firm-name').textContent()) ?? ''), 'one firm is bankrupt: Lodestar, with its dark marker');
    check((await bankrupt.locator('.firm-dark').count()) === 1, 'the bankrupt row carries the dark marker');
    check(/bought by Quickset/.test((await bankrupt.textContent()) ?? ''), `its sold tower says bought by Quickset (${((await bankrupt.locator('.firm-towers').textContent()) ?? '').trim()})`);
    check((await page.locator('.sheet.firms .firm-row').first().locator('svg.gauge').count()) === 3, 'each firm shows three hand-drawn gauges: pass rate, calibration, durability');
    const qs = firms.find((f) => f.id === 'quickset')!;
    const qrow = page.locator('.sheet.firms .firm-row[data-firm="quickset"]');
    // The balance as the engine has it now, read beside the page's figure.
    const [shownBal, nowBal] = await Promise.all([qrow.locator('.firm-bal-num').textContent(), api<FirmView[]>(page, '/api/firms').then((fs) => fs.find((f) => f.id === 'quickset')!.balance)]);
    check(num(shownBal) === nowBal, `a firm's balance reads as its books do (${shownBal} against ${nowBal})`);
    check((await qrow.locator('.firm-motto').textContent()) === qs.motto, 'and its motto');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'firms.png') });

    // ------------------------------------------------------------ a firm's page
    await qrow.locator('.firm-name').click();
    check(await within(page, 6000, async () => (await page.evaluate(() => location.hash)) === '#/firms/quickset' && (await page.locator('.sheet.firmpage .sheet-title').textContent()) === 'Quickset'), 'a firm’s name opens its page');
    check(await within(page, 5000, async () => (await page.locator('.firmpage .books-row').count()) > 3), `the firm page shows its books (${await page.locator('.firmpage .books-row').count()} lines)`);
    // The page reads its books once and again on each change: wait for it to agree with the engine read beside it.
    let last: string | null = null;
    let first: string | null = null;
    let detail = await api<FirmDetail>(page, '/api/firms/quickset');
    const agrees = await within(page, 5000, async () => {
      [last, detail] = await Promise.all([page.locator('.firmpage .books-row').first().locator('.books-bal').textContent(), api<FirmDetail>(page, '/api/firms/quickset')]);
      first ??= last;
      return num(last) === detail.balance;
    });
    check(agrees, `the running balance ends at the firm's balance (${last} against ${detail.balance}; first drawn ${first})`);
    check((await page.locator('.firmpage .person').count()) === detail.agents.length, `its people are listed (${await page.locator('.firmpage .person').count()})`);
    check((await page.locator('.firmpage .person svg.silhouette').count()) === detail.agents.length, 'each with its tower’s silhouette drawn');
    check((await page.locator('.firmpage .round-row.lost .round-ev').count()) > 0, 'a lost round shows the expected value that lost it');
    check((await page.locator('.firmpage svg.repline path.repline-line').count()) === 1, 'reputation over time is drawn as a line');
    check(((await page.locator('.firmpage .repline-era-now').textContent()) ?? '') === 'Sci-fi', 'with the era its score builds in named beside it');
    check(((await page.locator('.firmpage .standing-since').textContent()) ?? '').includes(`opened with ${detail.opening.toFixed(2)}`), `it says what it opened with, from its seeded balance (${await page.locator('.firmpage .standing-since').textContent()})`);
    const tally = (await page.locator('.firmpage .firm-rounds .repos-sec-count').textContent()) ?? '';
    const won = detail.rounds.filter((r) => r.won).length;
    const lost = detail.rounds.filter((r) => !r.won && r.winner).length;
    const none = detail.rounds.length - won - lost;
    check(tally === `${won} won, ${lost} lost, ${none} unawarded`, `rounds nobody won are not counted as lost (${tally})`);
    check((await page.locator('.firmpage .rounds-filter [data-filter="none"]').count()) === 1, 'and have a filter of their own');
    check(/Dagny Hollis/.test((await page.locator('.firmpage .deals').textContent()) ?? '') && /Corin Hale/.test((await page.locator('.firmpage .deals').textContent()) ?? ''), 'its hires and the tower it bought are listed');
    check((await page.locator('.firmpage .firm-fly').count()) === 1, 'it offers to fly to its quarter');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'firm.png') });
    await page.locator('.firmpage .firm-books').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'firm-books.png') });

    // ------------------------------------------------------------ the hired specialist
    await page.locator('.firmpage .person a.person-name', { hasText: 'Dagny Hollis' }).click();
    check(await within(page, 6000, async () => (await page.evaluate(() => location.hash)) === '#/agents/dagny-hollis' && (await page.locator('.sheet.agentpage .sheet-title').textContent()) === 'Dagny Hollis'), 'a person’s name opens the agent page');
    const dagny = await api<AgentDetail>(page, '/api/agents/dagny-hollis');
    check(await within(page, 4000, async () => (await page.locator('.agentpage .design-row[data-field="workflow.shape"] .design-val').textContent()) === dagny.genome.workflow.shape), `the agent page shows the workflow shape (${await page.locator('.agentpage .design-row[data-field="workflow.shape"] .design-val').textContent()})`);
    check((await page.locator('.agentpage .design-row[data-field="model"] .design-val').textContent()) === dagny.genome.model, 'and the model, as the genome reads');
    check((await page.locator('.agentpage .design-tool').count()) === dagny.genome.tools.length, 'and each of its tools');
    const lineage = (await page.locator('.agentpage .lineage-origin').textContent()) ?? '';
    check(/^Hired from the roster on \d+ \w+ \d{4}\.$/.test(lineage), `the hired specialist's lineage says the roster (${lineage})`);
    check((await page.locator('.agentpage .persona .md-h').count()) >= 2, 'the persona reads in full, from its file');
    const follow = page.locator('.agentpage .agent-follow');
    check((await follow.count()) === 1 && (await follow.getAttribute('data-follow')) === 'dagny-hollis' && /Dagny Hollis/.test((await follow.getAttribute('aria-label')) ?? ''), 'Follow is present and points at the persona');
    check((await page.locator('.agentpage .agent-ride').getAttribute('data-ride')) === 'dagny-hollis', 'Ride up points at its tower');
    check((await follow.getAttribute('aria-disabled')) === null && (await follow.getAttribute('title')) === null, 'Follow is live (Task 34)');
    const ride = page.locator('.agentpage .agent-ride');
    check((await ride.getAttribute('aria-disabled')) === 'true' && (await ride.getAttribute('title')) === 'Arrives with the city tour', '.agent-ride says it is not ready yet');
    check(!/\.md/.test((await page.locator('.agentpage .persona .repos-sec').textContent()) ?? ''), 'the persona heading names no file path');
    check(/persona below/.test((await page.locator('.agentpage .design-row[data-field="instructions"] .design-gloss').textContent()) ?? ''), 'the design points down to the persona');
    check(!/his plan/.test((await page.locator('.agentpage .agent-design').textContent()) ?? ''), 'and speaks to you, not about you');
    check((await page.locator('.agentpage .agent-tower .insp-floor').count()) === dagny.tower!.floors.length, 'its tower lists floor by floor, as the inspector does');
    check((await page.locator('.agentpage .agent-tower [role]').count()) === 0, 'as a plain list: no listbox or option roles where nothing can be picked');
    const refs = await page.locator('.agentpage .agent-tower .insp-ref a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).tabIndex));
    check(refs.length > 0 && refs.every((t) => t >= 0), `and its PR and report links can be reached with Tab (${refs.join(',')})`);
    check(/Quickset/.test((await page.locator('.agentpage .agent-calibration').textContent()) ?? ''), 'and its firm’s calibration');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'agent.png') });
    await page.locator('.agentpage .persona').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'agent-persona.png') });
    await page.locator('.agentpage .agent-tower').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'agent-tower.png') });
    await page.locator('.agentpage .sheet-body').evaluate((b) => {
      b.scrollTop = 0;
    });
    // With reduced motion asked for, the jump lands at once rather than gliding.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.agentpage .agent-jump').click();
    const landed = await page.locator('.agentpage .persona').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; });
    check(landed, 'with reduced motion the persona jump lands at once');
    await page.emulateMedia({ reducedMotion: null });
    check(await within(page, 2000, async () => (await page.locator('.agentpage .persona').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; }))), 'a jump link brings the persona into view');

    // A seeded agent says so.
    await go(page, '#/agents/ines-ashlar');
    check(await within(page, 5000, async () => /^Seeded with the city on /.test((await page.locator('.agentpage .lineage-origin').textContent()) ?? '')), 'a seeded agent was seeded with the city');

    // Lodestar's page: bankrupt, its tower bought.
    await go(page, '#/firms/lodestar');
    check(await within(page, 5000, async () => (await page.locator('.firmpage .sheet-title').textContent()) === 'Lodestar' && (await page.locator('.firmpage .books-row').count()) > 0), 'a bankrupt firm keeps its page');
    check(/Bankrupt/.test((await page.locator('.firmpage .detail-sub').textContent()) ?? ''), 'and says it is bankrupt');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'firm-bankrupt.png') });

    // Leaving a firm's page empties it, so reopening never shows the last firm's books first.
    await go(page, '#/');
    check(await within(page, 3000, async () => (await page.locator('.firmpage .books-row').count()) === 0 && ((await page.locator('.firmpage .sheet-title').textContent()) ?? '') === ''), 'a firm page left behind is emptied');

    // One balance on every screen: charges written but not yet settled count on the list, the firm's
    // page and the agent page's firm alike. The charge is a credits row the treasury never settles
    // here; it is removed after, before anything settles it.
    {
      const { openDb } = await import('../engine/db.js');
      const { balances } = await import('../engine/market/treasury.js');
      const { entries } = await import('../engine/ledger.js');
      const was = JSON.stringify(balances());
      // Nothing may book while the charge is planted (no economy clock runs here): if the ledger moves, a
      // settle could have booked the planted row, and deleting it after would leave the books unbalanced.
      const ledgerAt = entries().length;
      const id = Number(openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'quickset', 'run-unsettled', 'run', 12.5, NULL, '{}')").run(new Date().toISOString()).lastInsertRowid);
      try {
        const want = balances().quickset;
        await go(page, '#/firms');
        const onList = await within(page, 5000, async () => num(await page.locator('.sheet.firms .firm-row[data-firm="quickset"] .firm-bal-num').textContent()) === want);
        await go(page, '#/firms/quickset');
        const onPage = await within(page, 5000, async () => num(await page.locator('.firmpage .standing-bal .firm-bal-num').textContent()) === want);
        await go(page, '#/agents/mack-quickset');
        const onAgent = await within(page, 5000, async () => num(await page.locator('.agentpage .agent-firm-bal-num').textContent()) === want);
        check(onList && onPage && onAgent, `the list, the firm page and the agent page show one balance with charges unsettled (${want}: ${onList}, ${onPage}, ${onAgent})`);
      } finally {
        openDb().prepare('DELETE FROM credits WHERE id = ?').run(id);
      }
      const moved = entries().length - ledgerAt;
      check(moved === 0, `the ledger stood still while the unsettled charge was planted (${moved} entries written meanwhile: something settled or ticked inside the window, so the planted row may have been booked)`);
      check(JSON.stringify(balances()) === was, 'and the unsettled charge leaves nothing behind');
    }

    // A firm below zero: its balance in rust, and the hours it has left. A throwaway firm, written
    // straight into the firms table with one unsettled charge for this check alone and both removed
    // after it: nothing reaches the ledger, so no other firm's books move and replay still holds.
    const { openDb } = await import('../engine/db.js');
    const { balances, replayBalances, settle } = await import('../engine/market/treasury.js');
    const { entries } = await import('../engine/ledger.js');
    // The economy's clock (the job pages' checks) charged run costs it never settled: book those
    // first, as the treasury's hourly tick would, so the ledger and the rows agree before this check.
    settle(Date.now());
    const booksBefore = JSON.stringify(balances());
    const ledgerBefore = entries().length;
    const overdraft: Firm = { id: 'overdraft-check', name: 'Overdraft & Sons', root: 'roman', motto: 'Everything on account.', slot: 990, balance: -40.21, status: 'active', negativeSince: new Date().toISOString(), bankruptAt: null, createdAt: new Date().toISOString() };
    openDb().prepare('INSERT INTO firms (id, json) VALUES (?, ?)').run(overdraft.id, JSON.stringify(overdraft));
    // Its debt is an unsettled charge, the way a firm goes below zero between settles; removed with the firm.
    const debtRow = Number(openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, NULL, 'run', 340.21, NULL, '{}')").run(new Date().toISOString(), overdraft.id).lastInsertRowid);
    try {
      await go(page, '#/firms');
      const srow = page.locator(`.sheet.firms .firm-row[data-firm="${overdraft.id}"]`);
      check(await within(page, 5000, async () => /bankrupt in 72 h/.test((await srow.locator('.firm-bal').textContent()) ?? '')), `a firm below zero says how long it has (${await srow.locator('.firm-bal').textContent()})`);
      check((await srow.locator('.firm-bal.neg').count()) === 1, 'its balance is set in rust');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, 'firms-negative.png') });
    } finally {
      openDb().prepare('DELETE FROM credits WHERE id = ?').run(debtRow);
      openDb().prepare('DELETE FROM firms WHERE id = ?').run(overdraft.id);
    }
    const movedMeanwhile = entries().length - ledgerBefore;
    check(movedMeanwhile === 0, `the ledger stood still while the overdraft's charge was planted (${movedMeanwhile} entries written meanwhile: something settled or ticked inside the window, so the planted row may have been booked)`);
    check(JSON.stringify(balances()) === booksBefore, 'every firm’s books are as they were before the check');
    const replayed = replayBalances(entries());
    const now = balances();
    check(Object.keys(now).every((id) => Math.abs((replayed[id] ?? NaN) - now[id]) < 1e-9), `and the ledger replays to the same balances (${JSON.stringify(replayed)} against ${JSON.stringify(now)})`);

    // Fly to its quarter: the city comes back and goes there.
    await go(page, '#/firms/kiln');
    await within(page, 5000, async () => (await page.locator('.firmpage .firm-fly').count()) === 1);
    await page.locator('.firmpage .firm-fly').click();
    check(await within(page, 4000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city'), 'Fly to its quarter returns to the city');

    // An agent's tower in the city opens its page; so does a builder's name in the inspector.
    await page.evaluate(() => (window as unknown as { __palimpsest: { openAgent(id: string): void } }).__palimpsest.openAgent('priya-rao'));
    check(await within(page, 5000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'agent' && (await page.locator('.agentpage .sheet-title').textContent()) === 'Priya Rao'), 'an agent tower opens the agent page');
    await go(page, '#/');
    const city = (await api<Array<{ repo: string; tower: { floors: Array<{ earned?: unknown }> } }>>(page, '/api/city')).find((d) => d.tower.floors.some((f) => f.earned));
    if (city) {
      await page.evaluate((r) => (window as unknown as { __palimpsest: { inspect(r: string): void } }).__palimpsest.inspect(r), city.repo);
      const who = page.locator('.inspector .insp-who a.insp-agent').first();
      check(await within(page, 6000, async () => (await who.count()) > 0), 'the inspector names each builder as a link');
      check(/^#\/agents\//.test((await who.getAttribute('href')) ?? ''), 'to the agent page');
      // From the keyboard: Shift+Enter on a floor's row opens its builder's page, and the row says so.
      const row = page.locator('.inspector .insp-earned').first();
      const href = await row.locator('a.insp-agent').getAttribute('href');
      check(/Shift\+Enter opens .*’s page/.test((await row.getAttribute('aria-label')) ?? ''), `an earned floor's label tells of Shift+Enter (${await row.getAttribute('aria-label')})`);
      await row.focus();
      await page.keyboard.press('Shift+Enter');
      check(await within(page, 3000, async () => (await page.evaluate(() => location.hash)) === href), `Shift+Enter on the row opens the builder's page (${href})`);
      await go(page, '#/');
    }
  } finally {
    if (before) await page.setViewportSize(before);
  }
}
