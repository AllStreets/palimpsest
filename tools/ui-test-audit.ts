/**
 * The README audit's screens (Phase 3 Task 10), run by tools/ui-test.ts on
 * its own engine (port UI_PORT, default 4779, a temp home) once the sample economy is
 * seeded: the audit on the harbour's district page with its proposals, the
 * audit's own page, "Audit the README" on assay-kit, the kumo audit the
 * economy's clock ends (runs held, so the construction checks after these
 * find the sites where the seed left them), its proposals on the board, a
 * proposal's job page with the claim behind it, and the scope editor.
 *
 * The engine in ui-test runs no scheduler, so the audit started here waits
 * and never reaches a model.
 *
 * Saves district-audit.png, district-audit-waiting.png, audit.png,
 * audit-kumo.png, audit-proposals.png and job-scope.png at 1600 x 1000 for
 * the quality rounds.
 */
import { join } from 'node:path';

import type { Page } from 'playwright';

import type { AuditView, Job } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

const SIZE = { width: 1600, height: 1000 };
const HARBOUR = 'tidewater/harbor-ledger';
const ASSAY = 'lantern/assay-kit';
const KUMO = 'hoshi/kumo';

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

type AuditRow = Omit<AuditView, 'markdown' | 'proposals'>;

/**
 * Returns how many refusals it provoked on purpose: each shows in the
 * browser's console as a failed resource (409), which the caller excuses.
 */
export async function auditChecks(page: Page, check: Check, shots: string): Promise<number> {
  let refusals = 0;
  const { scopeRefused } = await import('../engine/market/jobs.js');
  const { economyClock } = await import('../engine/market/sample-economy.js');
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  try {
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });

    // ------------------------------------------------------------ the harbour's district page
    const harbourAudit = (await api<AuditRow[]>(page, `/api/audits?repo=${encodeURIComponent(HARBOUR)}`)).find((a) => a.status === 'done');
    check(!!harbourAudit, 'the harbour has a done audit');
    if (!harbourAudit) return refusals;
    const view = await api<AuditView>(page, `/api/audits/${harbourAudit.id}`);
    const byTitle = (re: RegExp): Job | undefined => view.proposals.find((j) => re.test(j.title));
    const ubl = byTitle(/UBL/);
    const reason = byTitle(/reason on fee override/);
    const schedule = byTitle(/harbour's day/);
    check(!!ubl && !!reason && !!schedule, 'the harbour audit proposed the UBL, override reason and schedule jobs');

    await go(page, `#/repos/${HARBOUR}`);
    const sheet = page.locator('.sheet.district');
    const sec = sheet.locator('.district-audit');
    const shown = await within(page, 8000, async () => (await sec.locator('.audit-claims .claim').count()) === 14);
    check(shown, `the district page lists the audit's 14 claims (${await sec.locator('.audit-claims .claim').count()})`);
    if (!shown) return refusals;
    check(((await sec.locator('.repos-sec-name').first().textContent()) ?? '') === 'README against the code', 'under the heading "README against the code"');
    const lead = ((await sec.locator('.audit-lead').textContent()) ?? '').trim();
    check(lead.startsWith('Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1 broken.'), `the lead gives the counts (${lead})`);
    const unverified = sec.locator('.claim.unverified');
    check((await unverified.count()) === 1 && /evidence not found at the commit/.test((await unverified.textContent()) ?? ''), 'one claim says its evidence was not found at the commit');
    check((await unverified.locator('a.claim-evidence').count()) === 0, 'and its evidence is not a link');
    const marks = await sec.locator('.claim .verdict-mark').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.mark))].sort());
    check(JSON.stringify(marks) === JSON.stringify(['empty', 'full', 'half', 'struck']), `each verdict has its own drawn mark (${marks.join(', ')})`);
    const words = await sec.locator('.claim .verdict-word').allTextContents();
    check(words.length === 14 && words.every((w) => /^(real|partial|missing|stubbed|broken)$/.test(w)), 'and its word');
    const href = (await sec.locator('a.claim-evidence').first().getAttribute('href')) ?? '';
    check(new RegExp(`^https://github\\.com/${HARBOUR}/blob/${harbourAudit.baseSha}/[\\w/.%-]+#L\\d+$`).test(href), `evidence links to GitHub at the audited commit (${href})`);
    check((await sec.locator('a.claim-evidence').evaluateAll((as) => as.every((a) => (a as HTMLAnchorElement).target === '_blank' && /noopener/.test((a as HTMLAnchorElement).rel)))), 'and leaves the app safely');
    const props = sec.locator('.claim-proposal');
    const states = await props.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state).sort());
    // The one he accepted last night is wherever the board's clock has taken it since: taking bids, or awarded on a full run.
    const accepted = ['open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'];
    const rest = states.filter((x) => !accepted.includes(x ?? ''));
    check(states.length === 4 && JSON.stringify(rest) === JSON.stringify(['proposed', 'proposed', 'withdrawn']), `four proposals stand with their states: one accepted, two waiting on him, one dismissed (${states.join(', ')})`);
    const acceptedRow = props.and(page.locator(`[data-job="${view.proposals.find((j) => accepted.includes(j.status))?.id}"]`));
    check(/^accepted/.test(((await acceptedRow.locator('.prop-word').textContent()) ?? '').trim()), `the accepted one says so (${((await acceptedRow.locator('.prop-word').textContent()) ?? '').trim()})`);
    const dismissedRow = props.and(page.locator(`[data-job="${schedule?.id}"]`));
    check(/dismissed/.test((await dismissedRow.locator('.prop-word').textContent()) ?? ''), 'the dismissed one says so');
    check((await dismissedRow.locator('.prop-again').count()) === 1, 'and offers Propose again');
    check((await props.and(page.locator(`[data-job="${ubl?.id}"]`)).locator('.prop-accept, .prop-dismiss, .prop-tier [role="radio"]').count()) === 5, 'a proposed one offers Accept, three tiers and Dismiss');
    check((await sec.locator('img, script, iframe').count()) === 0, 'the audit is set as text only');
    await sec.evaluate((s) => s.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'district-audit.png') });

    // The tier picker patches the value.
    const ublRow = props.and(page.locator(`[data-job="${ubl?.id}"]`));
    await ublRow.locator('.prop-tier [role="radio"][data-tier="normal"]').click();
    check(await within(page, 4000, async () => (await api<{ job: Job }>(page, `/api/jobs/${ubl?.id}`)).job.tier === 'normal'), 'the tier picker sets the tier');
    check((await api<{ job: Job }>(page, `/api/jobs/${ubl?.id}`)).job.value === 60, 'and the value with it');
    check(await within(page, 3000, async () => (await ublRow.locator('[role="radio"][aria-checked="true"]').getAttribute('data-tier')) === 'normal'), 'and the picker shows it');

    // Accept: the row's state moves without a reload, and the job stands under Bidding on the board.
    const reasonRow = props.and(page.locator(`[data-job="${reason?.id}"]`));
    await reasonRow.locator('.prop-accept').click();
    check(await within(page, 4000, async () => (await reasonRow.getAttribute('data-state')) === 'open'), `Accept moves the row on in place (${await reasonRow.getAttribute('data-state')})`);
    check(/accepted/.test((await reasonRow.locator('.prop-word').textContent()) ?? ''), 'and it says accepted');

    // Propose again: the dismissed proposal is back, waiting on him.
    await dismissedRow.locator('.prop-again').click();
    check(
      await within(page, 4000, async () => (await api<Job[]>(page, `/api/jobs?status=proposed&repo=${encodeURIComponent(HARBOUR)}`)).some((j) => j.key === schedule?.key)),
      'Propose again puts the dismissed proposal back on the board',
    );
    check(await within(page, 4000, async () => (await props.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state))).filter((s) => s === 'proposed').length === 2), 'and its row waits on him again');

    // ------------------------------------------------------------ the audit's own page
    await sec.locator('a.audit-page-link').first().click();
    const onPage = await within(page, 5000, async () => (await page.evaluate(() => location.hash)) === `#/audits/${harbourAudit.id}` && (await page.locator('.sheet.auditpage .claim').count()) === 14);
    check(onPage, 'the audit opens on its own page with its claims');
    const trail = (await page.locator('.sheet.auditpage .detail-trail > *:not(.detail-trail-sep)').allTextContents()).map((t) => t.trim());
    check(trail.length === 3 && trail[0] === 'Repos' && trail[1] === 'harbor-ledger' && /^audit of \d+ \w+ \d{4}$/.test(trail[2]), `its trail reads Repos, the repo, the audit's date (${trail.join(' / ')})`);
    check((await page.locator('.sheet.auditpage .detail-trail a').nth(1).getAttribute('href')) === `#/repos/${HARBOUR}`, 'and leads back to the district');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'audit.png') });

    // ------------------------------------------------------------ Audit the README on assay-kit
    await go(page, `#/repos/${ASSAY}`);
    const start = sheet.locator('.district-audit .audit-start');
    check(await within(page, 6000, async () => (await start.count()) === 1 && (await start.isEnabled())), 'assay-kit offers Audit the README');
    check(((await sheet.locator('.district-audit .audit-lead').textContent()) ?? '').trim() === 'No README to check.', 'its last audit found no README to check');
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/repos/${ASSAY}/audit`) && r.request().method() === 'POST');
    await start.click();
    check((await answered).status() === 202, 'Audit the README starts an audit (202)');
    check(await within(page, 4000, async () => (await start.isDisabled()) && /^An audit is waiting/.test(((await sheet.locator('.district-audit .audit-held').textContent()) ?? '').trim())), `and the button holds with the reason (${await sheet.locator('.district-audit .audit-held').textContent()})`);
    check(await within(page, 4000, async () => /Waiting/.test((await sheet.locator('.district-audit .audit-stage').textContent()) ?? '')), 'the waiting audit shows where it stands');
    check(await within(page, 3000, async () => (await sheet.locator('.district-audit .audit-lead').count()) === 0), 'the last audit\'s lead steps aside while the new one waits');
    check(/^The last audit: Read /.test(((await sheet.locator('.district-audit .audit-colophon').textContent()) ?? '').trim()), `and the last audit says it is the last (${((await sheet.locator('.district-audit .audit-colophon').textContent()) ?? '').trim()})`);
    await sheet.locator('.district-audit').evaluate((s) => s.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'district-audit-waiting.png') });

    // ------------------------------------------------------------ the kumo audit ends on the clock
    await go(page, '#/jobs');
    check(await within(page, 6000, async () => (await page.locator('.sec-proposed').count()) === 1), 'the board opens with its proposals');
    check(await within(page, 4000, async () => (await page.locator(`.sec-bidding .job-row[data-job="${reason?.id}"]`).count()) === 1), 'the accepted proposal stands under Bidding');
    const harbourGroup = page.locator(`.sec-proposed .audit-group[data-repo="${HARBOUR}"]`);
    check((await harbourGroup.count()) === 1 && (await harbourGroup.locator('.prop-line').count()) === 2, `the harbour's proposals stand under its audit (${await harbourGroup.locator('.prop-line').count()})`);
    check(/^Invoices can also be sent/.test(((await harbourGroup.locator(`.prop-line[data-job="${ubl?.id}"] .prop-claim-text`).textContent()) ?? '').trim()), 'each with the claim behind it');
    const kumoBefore = (await api<AuditRow[]>(page, `/api/audits?repo=${encodeURIComponent(KUMO)}`))[0];
    check(kumoBefore?.status === 'reading', `the kumo audit is reading (${kumoBefore?.status})`);
    // Stop on the reading audit: the engine has no live session behind the sample's, and its refusal shows in place.
    await go(page, `#/repos/${KUMO}`);
    const stop = sheet.locator('.district-audit .audit-stop');
    check(await within(page, 6000, async () => (await stop.count()) === 1 && /Reading/.test((await sheet.locator('.district-audit .audit-stage').textContent()) ?? '')), 'the reading kumo audit offers Stop beside its stage');
    await stop.click();
    refusals++;
    const stopErr = sheet.locator('.district-audit .audit-block .job-error');
    check(await within(page, 4000, async () => /^Stop refused: the audit is not live/.test(((await stopErr.textContent()) ?? '').trim())), `a refused Stop says why in place (${((await stopErr.textContent().catch(() => '')) ?? '').trim()})`);
    check((await stopErr.getAttribute('role')) === 'alert', 'as an alert');
    await go(page, '#/jobs');
    check(await within(page, 6000, async () => (await page.locator('.sec-proposed').count()) === 1), 'back on the board');
    const clock = economyClock({ now: () => Date.now(), speed: 20, runs: false });
    try {
      for (let i = 0; i < 24; i++) {
        clock.tick(1000);
        await clock.idle();
      }
    } finally {
      clock.stop();
    }
    const kumoGroup = page.locator(`.sec-proposed .audit-group[data-repo="${KUMO}"]`);
    // The engine's side first, so a miss on the board says which half missed.
    const kumoDone = (await api<AuditRow[]>(page, `/api/audits?repo=${encodeURIComponent(KUMO)}`))[0];
    const kumoJobs = (await api<Job[]>(page, `/api/jobs?status=proposed&repo=${encodeURIComponent(KUMO)}`)).filter((j) => j.proposal?.auditId === kumoDone?.id);
    check(kumoDone?.status === 'done' && kumoJobs.length === 2, `the clock ends the kumo audit done with two proposals (${kumoDone?.status}, ${kumoJobs.length})`);
    check(await within(page, 10_000, async () => (await kumoGroup.locator('.prop-line').count()) === 2), `and they appear on the board under its heading (${await kumoGroup.locator('.prop-line').count()})`);
    const kumoHead = ((await kumoGroup.locator('.audit-group-head').textContent({ timeout: 3000 }).catch(() => '')) ?? '').trim();
    check(/README audit/.test(kumoHead), `the heading names the audit (${kumoHead})`);
    // Its own page carries the marks the harbour's has not: stubbed and partial among them.
    const kumoAudit = (await api<AuditRow[]>(page, `/api/audits?repo=${encodeURIComponent(KUMO)}`))[0];
    await go(page, `#/audits/${kumoAudit?.id}`);
    check(await within(page, 5000, async () => (await page.locator('.sheet.auditpage .claim').count()) === kumoAudit?.findings.length), 'the kumo audit opens on its own page');
    const kumoMarks = await page.locator('.sheet.auditpage .claim .verdict-mark').evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.mark))].sort());
    check(JSON.stringify(kumoMarks) === JSON.stringify(['empty', 'full', 'half', 'hatched', 'struck']), `all five marks stand in its ledger (${kumoMarks.join(', ')})`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'audit-kumo.png') });
    await go(page, '#/jobs');
    check(await within(page, 5000, async () => (await kumoGroup.locator('.prop-line').count()) === 2), 'back on the board');
    await page.locator('.sec-proposed').scrollIntoViewIfNeeded();
    await page.locator('.sheet.jobs .sheet-body').evaluate((b) => {
      b.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'audit-proposals.png') });

    // The tier picker on the board, then Dismiss withdraws.
    const kumoFirst = kumoGroup.locator('.prop-line').first();
    const kumoId = (await kumoFirst.getAttribute('data-job')) ?? '';
    await kumoFirst.locator('.prop-tier [role="radio"][data-tier="high"]').click();
    check(await within(page, 4000, async () => (await api<{ job: Job }>(page, `/api/jobs/${kumoId}`)).job.tier === 'high'), 'the board’s tier picker sets the tier');
    await kumoGroup.locator(`.prop-line[data-job="${kumoId}"] .job-dismiss`).click();
    check(await within(page, 4000, async () => (await api<{ job: Job }>(page, `/api/jobs/${kumoId}`)).job.status === 'withdrawn'), 'Dismiss withdraws the proposal');
    check(await within(page, 4000, async () => (await page.locator(`.sec-proposed [data-job="${kumoId}"]`).count()) === 0), 'and it leaves the board');

    // ------------------------------------------------------------ a proposal's own page and its scope
    await go(page, `#/jobs/${ubl?.id}`);
    const jp = page.locator('.sheet.jobpage');
    const why = jp.locator('.job-why');
    check(await within(page, 5000, async () => (await why.count()) === 1), 'the proposal’s page says why the city proposes it');
    check(/Invoices can also be sent as e-invoices in the UBL format/.test((await why.locator('.why-claim').textContent()) ?? ''), 'with the claim');
    check(((await why.locator('.verdict-word').textContent()) ?? '') === 'missing', 'the verdict');
    const ev = (await why.locator('a.claim-evidence').first().getAttribute('href')) ?? '';
    check(new RegExp(`^https://github\\.com/${HARBOUR}/blob/${harbourAudit.baseSha}/`).test(ev), `and the evidence, linked at the audited commit (${ev})`);

    const add = jp.locator('.term-add[data-list="scope"]');
    check(await within(page, 3000, async () => (await add.count()) === 1), 'its scope can be edited while it is proposed');
    check((await add.getAttribute('aria-label')) === 'Add a glob to the scope', 'the add row is labelled');
    const rowLabels = await jp.locator('.job-globs .term-input').evaluateAll((is) => is.map((i) => i.getAttribute('aria-label')));
    check(rowLabels.length > 0 && rowLabels.every((l, i) => l === `Glob ${i + 1} of the scope`), `each glob is labelled by its place (${rowLabels.join(', ')})`);
    check((await jp.locator('.terms-why').getAttribute('aria-live')) === 'polite', 'the editor says what happened through a polite live region');
    const focused = (): Promise<string> => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.className}|${a.dataset.list ?? ''}` : '';
    });
    /** Tabs on until `want` holds focus, at most `n` times. */
    const tabTo = async (want: RegExp, n = 12): Promise<boolean> => {
      for (let i = 0; i < n; i++) {
        if (want.test(await focused())) return true;
        await page.keyboard.press('Tab');
      }
      return want.test(await focused());
    };
    // By keyboard alone: from the last glob's Remove, Tab reaches the add row; type, Enter, Tab to Save, Enter.
    await jp.locator('.job-globs .term-remove').last().focus();
    await page.keyboard.press('Tab');
    check(/term-add.*\|scope$/.test(await focused()), `Tab from the last glob reaches the add row (${await focused()})`);
    await page.keyboard.type('src/**');
    await page.keyboard.press('Enter');
    check(await tabTo(/terms-save/), 'Tab reaches Save');
    await page.keyboard.press('Enter');
    check(await within(page, 4000, async () => (await api<{ job: Job }>(page, `/api/jobs/${ubl?.id}`)).job.scope.includes('src/**')), 'a glob added and saved by keyboard is stored');
    check(await within(page, 4000, async () => (await jp.locator('.job-globs .term-input').evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value))).includes('src/**')), 'and shows in the list');
    check(await within(page, 3000, async () => (await jp.locator('.terms-foot').isHidden()) && ((await jp.locator('.terms-why').textContent()) ?? '') === ''), 'the editor is quiet again once saved: no Save, no Discard, nothing said');
    check(await within(page, 3000, async () => /term-add.*\|scope$/.test(await focused())), `and focus waits in the scope's add row (${await focused()})`);
    const stored = (await api<{ job: Job }>(page, `/api/jobs/${ubl?.id}`)).job.scope;
    // Focus is in the add row already: type a denied glob, Enter, Tab to Save, Enter.
    await page.keyboard.type('**/.env');
    await page.keyboard.press('Enter');
    check(await tabTo(/terms-save/), 'Tab reaches Save again');
    await page.keyboard.press('Enter');
    refusals++;
    const want = scopeRefused('**/.env') ?? '';
    check(want.length > 0, `the engine refuses **/.env (${want})`);
    const whyEl = jp.locator('.terms-why');
    check(await within(page, 4000, async () => want.length > 0 && ((await whyEl.textContent()) ?? '').includes(want)), `a denied glob is refused with the engine's reason in place (${await whyEl.textContent()})`);
    const refusedInput = jp.locator('.job-globs li.refused .term-input');
    check((await refusedInput.count()) === 1 && (await refusedInput.inputValue()) === '**/.env', 'the refused row is marked');
    check((await refusedInput.getAttribute('aria-invalid')) === 'true', 'and invalid to a screen reader');
    const whyId = (await whyEl.getAttribute('id')) ?? '';
    check(whyId !== '' && (await refusedInput.getAttribute('aria-describedby')) === whyId, `and described by the reason (${await refusedInput.getAttribute('aria-describedby')})`);
    check(JSON.stringify((await api<{ job: Job }>(page, `/api/jobs/${ubl?.id}`)).job.scope) === JSON.stringify(stored), 'and nothing changed');
    await jp.locator('.job-issue').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'job-scope.png') });
    await jp.locator('.terms-discard').click();
    check(await within(page, 3000, async () => !(await jp.locator('.job-globs .term-input').evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value))).includes('**/.env')), 'Discard puts the stored scope back');

    // Read only once it is under way: a running job, seeded from the accepted proposal if the economy has none left.
    let running = (await api<Job[]>(page, '/api/jobs?status=running'))[0];
    if (!running && reason) {
      const { job: storedJob, transition } = await import('../engine/market/jobs.js');
      let cur = storedJob(reason.id)!;
      for (const step of ['bidding', 'awarded', 'running'] as const) {
        const road = ['open', 'bidding', 'awarded', 'running'];
        if (road.indexOf(cur.status) < road.indexOf(step)) cur = transition(cur, step);
      }
      running = cur;
    }
    check(running?.status === 'running', `a running job to read (${running?.id ?? 'none'})`);
    await go(page, `#/jobs/${running?.id}`);
    check(await within(page, 5000, async () => (await jp.locator('.job-globs').count()) === 1 && (await jp.locator('.job-globs .term-input, .term-add, .terms-save').count()) === 0), 'a running job’s scope is read only');

    // Propose again weighs every job on the key in the repo, not only the audit's own: a newer one from another audit holds it.
    const again = (await api<Job[]>(page, `/api/jobs?status=proposed&repo=${encodeURIComponent(HARBOUR)}`)).find((j) => j.key === schedule?.key);
    check(!!again, 'the schedule proposal is proposed again');
    if (again) {
      await page.evaluate((id) => fetch(`/api/jobs/${id}/dismiss`, { method: 'POST', headers: { 'x-palimpsest': '1' } }), again.id);
      const { postProposal } = await import('../engine/market/jobs.js');
      const other = postProposal({ repo: HARBOUR, title: again.title, body: 'Another audit found it too.', scope: again.scope, acceptance: again.acceptance, tier: again.tier, key: again.key!, source: 'proposal', proposal: { auditId: 'audit-elsewhere', findingId: 'f1' } });
      await go(page, `#/repos/${HARBOUR}`);
      const row = sheet.locator(`.district-audit .claim-proposal[data-job="${again.id}"]`);
      check(await within(page, 6000, async () => (await row.getAttribute('data-state')) === 'withdrawn'), 'the dismissed proposal stands dismissed on the district page');
      check((await row.locator('.prop-again').count()) === 0, 'and offers no Propose again while a newer job holds its key');
      await page.evaluate((id) => fetch(`/api/jobs/${id}/dismiss`, { method: 'POST', headers: { 'x-palimpsest': '1' } }), other.id);
    }
    check((await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)) === true, 'nothing reloaded the page');
    await page.keyboard.press('Escape');
    await within(page, 3000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city');
  } finally {
    if (before) await page.setViewportSize(before);
  }
  return refusals;
}
