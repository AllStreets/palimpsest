/**
 * The job board's UI checks (Task 36), run by tools/ui-test.ts on its own
 * engine (port UI_PORT, default 4779, a temp home) once the sample economy is seeded. The
 * economy's clock is ticked on demand with the board on (test safety rule
 * 8), a little at a time, so the runs the later checks expect are where the
 * seed left them: no step past the clock's first 30 script seconds runs.
 *
 * Saves jobs.png, jobs-bidding.png, jobs-lower.png and jobs-post.png at
 * 1600 x 1000 for the quality rounds.
 */
import { join } from 'node:path';

import type { Page } from 'playwright';

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

/**
 * Returns how many refusals it provoked on purpose: each shows in the
 * browser's console as a failed resource (409), which the caller excuses.
 */
export async function jobBoardChecks(page: Page, check: Check, shots: string): Promise<number> {
  let refusals = 0;
  const { economyClock } = await import('../engine/market/sample-economy.js');
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  // Five script seconds a tick: the board answers each round once every three ticks.
  const clock = economyClock({ now: () => Date.now(), speed: 20, board: true });
  const tick = async (): Promise<void> => {
    clock.tick(250);
    await clock.idle();
  };
  try {
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    await page.locator('.runhead a[data-route="jobs"]').click();
    const opened = await within(page, 8000, async () => (await page.locator('.sec-bidding .job-row[data-status="bidding"]').count()) === 3);
    check(opened, 'the Jobs link opens the board with the three jobs taking bids');
    if (!opened) return refusals;
    check((await page.locator('.sheet-title', { hasText: 'Job board' }).count()) === 1, 'the board is titled Job board');
    check((await page.evaluate(() => location.hash)) === '#/jobs', 'at #/jobs');

    // Each round's bids as a ruled list, the same bids the engine holds.
    const rows = page.locator('.sec-bidding .job-row[data-status="bidding"]');
    const ids = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.job!));
    const counts = await Promise.all(ids.map((id) => page.evaluate((x) => fetch(`/api/jobs/${x}`).then((r) => r.json()).then((d: { bids: unknown[] }) => d.bids.length), id) as Promise<number>));
    const shown = await Promise.all(ids.map((id) => page.locator(`.job-row[data-job="${id}"] .bids tbody tr[data-bid]`).count()));
    check(JSON.stringify(shown) === JSON.stringify(counts) && counts.every((n) => n > 0), `each round lists its bids (${shown.join(', ')} of ${counts.join(', ')})`);
    const head = await page.locator('.sec-bidding .bids').first().locator('th').allTextContents();
    check(head.join('|') === "Firm|Agent|Price|Confidence|City's estimate|EV", `the bid columns read firm, agent, price, confidence, the city's estimate, EV (${head.join(', ')})`);
    check((await page.locator('.sec-bidding .sat-out li').count()) >= 1, 'an agent that sat out is named with its reason');
    const sat = (await page.locator('.sec-bidding .sat-out li').first().textContent()) ?? '';
    check(/ of .+ sat out: no slot before the window closed/.test(sat), `the sit-out reads plainly (${sat})`);
    const clockText = (await page.locator('.sec-bidding .round-clock').first().getAttribute('aria-label')) ?? '';
    check(/^closes in \d+:\d\d$|^closing$/.test(clockText), `each round shows its clock (${clockText})`);
    check((await page.locator('.sec-bidding .round-lamps i.bid').count()) >= counts.reduce((a, b) => a + b, 0), 'a lamp is lit for every bid');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'jobs.png') });

    // A bid arrives live.
    const total = (): Promise<number> => page.locator('.sec-bidding .bids tbody tr[data-bid]').count();
    const was = await total();
    await tick();
    const arrived = await within(page, 4000, async () => (await total()) > was);
    check(arrived, `a bid arrives on the board without a reload (${was} then ${await total()})`);
    check((await page.locator('.bids tr.fresh').count()) >= 1, 'the new bid is marked as it comes in');
    await page.locator('.sec-bidding').first().screenshot({ path: join(shots, 'jobs-bidding.png') });

    // The running job's progress words change with its counts.
    const running = page.locator('.sec-running .job-row[data-status="running"] .run-counts').first();
    const said = (await running.textContent().catch(() => null)) ?? '';
    check(/\d+ tool calls?/.test(said), `the running job says its progress from real counts (${said})`);
    await tick();
    await tick();
    await tick();
    const moved = await within(page, 4000, async () => ((await running.textContent()) ?? '') !== said);
    check(moved, `the running job's progress text changes live (${said} then ${await running.textContent().catch(() => '')})`);

    // The proposed harness job: Accept, and the next tick opens its round under Bidding.
    // The same proposal on several repos stands as one row with a line per repo.
    const proposals = (await page.evaluate(() => fetch('/api/jobs?status=proposed').then((r) => r.json()))) as Array<{ id: string; repo: string; title: string }>;
    const harnesses = proposals.filter((j) => j.title === 'Add a baseline test and build harness');
    const groupRow = page.locator('.sec-proposed .job-row.group');
    check(harnesses.length < 2 || ((await groupRow.count()) === 1 && (await groupRow.locator('.prop-line').count()) === harnesses.length), `identical proposals stand as one row naming each repo (${harnesses.length} proposals, ${await groupRow.locator('.prop-line').count()} lines)`);
    const harness = harnesses.find((j) => j.repo === 'lantern/assay-kit')?.id ?? null;
    const proposed = page.locator(`.sec-proposed [data-job="${harness}"]`);
    const proposedTitle = harnesses.length > 1 ? await groupRow.locator('.job-title').textContent() : await proposed.locator('.job-title').textContent();
    check(!!harness && (await proposed.count()) === 1 && proposedTitle === 'Add a baseline test and build harness', 'the harness job waits under Proposed');
    await proposed.locator('.job-accept').click();
    const accepted = await within(page, 4000, async () => (await page.locator(`.sec-bidding .job-row[data-job="${harness}"]`).count()) === 1);
    check(accepted, 'Accept moves the harness job under Bidding');
    await tick();
    const roundOpen = await within(page, 4000, async () => (await page.locator(`.sec-bidding .job-row[data-job="${harness}"]`).getAttribute('data-status')) === 'bidding');
    check(roundOpen, 'and its round opens on the next tick');

    // Post a job: it appears under Bidding, its title shown as plain text however it was written.
    await page.locator('.post-job').scrollIntoViewIfNeeded();
    await page.locator('.post-repo').selectOption('lantern/assay-kit');
    const hostile = 'Name the custody columns ‮in the header <img src=x onerror="window.__pwned=1">';
    await page.locator('.post-input[name="title"]').fill(hostile);
    await page.locator('.post-input[name="body"]').fill('The export header should name `assay/custody/export.py` columns.');
    await page.locator('.post-tier[data-tier="low"]').click();
    await page.screenshot({ path: join(shots, 'jobs-post.png') });
    await page.locator('.post-submit').click();
    const postedOk = await within(page, 4000, async () => /^Posted\./.test((await page.locator('.post-said').textContent()) ?? ''));
    check(postedOk, `Post a job answers (${await page.locator('.post-said').textContent()})`);
    const mine = page.locator('.sec-bidding .job-row', { hasText: 'Name the custody columns' });
    check((await mine.count()) === 1, 'the posted job appears under Bidding');
    await tick();
    const mineOpen = await within(page, 4000, async () => (await mine.getAttribute('data-status')) === 'bidding');
    check(mineOpen, 'and takes bids on the next tick');
    const title = (await mine.locator('.job-title').textContent()) ?? '';
    check(!title.includes('‮') && (await mine.locator('img').count()) === 0 && (await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)) === undefined, `text from outside shows only as cleaned text (${title})`);
    check((await mine.locator('.job-value').textContent())?.trim() === '20 credits', 'a low tier job is worth 20 credits');

    // A refusal shows the engine's reason plainly, and every write carries the header.
    const withdrawUrl = '**/api/jobs/*/withdraw';
    let header = '';
    await page.route(withdrawUrl, async (route) => {
      header = route.request().headers()['x-palimpsest'] ?? '';
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the job moved on; look again' }) });
    });
    await mine.locator('.job-withdraw-btn').click();
    await mine.locator('.job-yes').click();
    refusals++;
    const refused = await within(page, 4000, async () => ((await mine.locator('.job-error').textContent()) ?? '') === 'Withdraw refused: the job moved on; look again');
    check(refused, `a refused withdraw says why (${await mine.locator('.job-error').textContent().catch(() => '')})`);
    check(header === '1', 'the withdraw went to the engine with x-palimpsest: 1');
    await page.unroute(withdrawUrl);
    // And a real withdraw takes it off the board.
    await mine.locator('.job-withdraw-btn').click();
    await mine.locator('.job-yes').click();
    const gone = await within(page, 4000, async () => (await page.locator('.job-row', { hasText: 'Name the custody columns' }).count()) === 0);
    check(gone, 'a withdrawn job leaves the board');

    // The lower sections: waiting on him with the PR link, done today, failed, halted with Resume.
    const pr = await page.locator('.sec-waiting .job-pr-link').first().getAttribute('href').catch(() => null);
    check(!!pr && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr), `a job waiting on him links its pull request (${pr})`);
    check((await page.locator('.sec-done .job-row').count()) + (await page.locator('.sec-failed .job-row').count()) >= 1, 'done and failed work stays on the board');
    const haltedRepo = page.locator('.sec-halted .halted-repo').first();
    check((await haltedRepo.count()) === 1, 'a halted repo stands under Halted with its reason');
    await page.locator('.sec-waiting').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'jobs-lower.png') });
    const which = await haltedRepo.getAttribute('data-repo');
    await haltedRepo.locator('.repo-resume').click();
    const resumed = await within(page, 5000, async () => (await page.locator(`.sec-halted .halted-repo[data-repo="${which}"]`).count()) === 0);
    check(resumed, `Resume clears the halt on ${which}`);

    // Filter by repo.
    await page.locator('.jobs-filter [data-repo="hoshi/kumo"]').click();
    const onlyKumo = await page.locator('.job-row[data-job]').evaluateAll((els) => els.every((e) => e.querySelector('.job-repo')?.textContent === 'kumo'));
    check(onlyKumo && (await page.locator('.job-row[data-job]').count()) > 0, 'the filter shows one repo’s jobs');
    await page.locator('.jobs-filter [data-repo=""]').click();

    // A job's title opens its own page (Task 37), and the trail leads back to the board.
    await page.locator(`.job-row[data-job="${ids[0]}"] .job-title`).click();
    const opened2 = await within(page, 4000, async () => (await page.evaluate(() => location.hash)) === `#/jobs/${ids[0]}` && (await page.locator('.sheet.jobpage:not([hidden]) .sheet-title').textContent()) !== '');
    check(opened2, 'a job’s title opens its own page');
    await page.locator('.jobpage .detail-trail-link', { hasText: 'Jobs' }).click();
    check(await within(page, 3000, async () => (await page.evaluate(() => location.hash)) === '#/jobs'), 'the page’s trail leads back to the board');
    check((await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)) === true, 'nothing on the board reloaded the page');
    await page.keyboard.press('Escape');
    check(await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city'), 'Escape returns to the city');
  } finally {
    clock.stop();
    if (before) await page.setViewportSize(before);
  }
  return refusals;
}
