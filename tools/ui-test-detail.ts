/**
 * The job, run and inspection pages' UI checks (Task 37), run by
 * tools/ui-test.ts on its own engine (port 4779, a temp home) after the job
 * board's checks, with the sample economy's clock ticked on demand (test
 * safety rule 8). The running job's log grows live and the hold toggle
 * stops it following; refusals show with their reason; the scarred job's
 * inspection shows eight checks with two failed; an award names its winner
 * and who sat out; and a hostile log line reaches the page only as cleaned,
 * redacted text.
 *
 * Saves job.png, job-rounds.png, run-live.png, run-diff.png, inspection.png
 * and inspection-design.png at 1600 x 1000 for the quality rounds.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from 'playwright';

import type { FirmView, Job, JobDetail } from '../shared/types.js';

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

export async function detailChecks(page: Page, check: Check, shots: string): Promise<void> {
  const { economyClock } = await import('../engine/market/sample-economy.js');
  const { paths } = await import('../engine/home.js');
  const { emit } = await import('../engine/events.js');
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const clock = economyClock({ now: () => Date.now(), speed: 20, board: true });
  const tick = async (): Promise<void> => {
    clock.tick(250);
    await clock.idle();
  };
  try {
    const jobs = await api<Job[]>(page, '/api/jobs');
    const firms = await api<FirmView[]>(page, '/api/firms');
    const firmName = (id: string) => firms.find((f) => f.id === id)?.name ?? id;
    const agentName = (id: string) => firms.flatMap((f) => f.agents).find((a) => a.id === id)?.name ?? id;

    // ------------------------------------------------------------ the running job's page
    const running = jobs.find((j) => j.status === 'running' && j.repo === 'tidewater/harbor-ledger');
    check(!!running?.runId, `the economy has the harbour job running (${running?.title ?? 'none'})`);
    if (!running?.runId) return;
    const rd = await api<JobDetail>(page, `/api/jobs/${running.id}`);
    await go(page, `#/jobs/${running.id}`);
    const shown = await within(page, 6000, async () => (await page.locator('.sheet.jobpage .sheet-title').textContent()) === running.title);
    check(shown, 'a job’s address opens its page, titled with the issue');
    check((await page.evaluate(() => document.body.dataset.route)) === 'job', 'the route is the job page');
    const winner = rd.award?.chosen;
    const prose = (await page.locator('.jobpage .job-award').first().textContent()) ?? '';
    check(!!winner && prose.startsWith(`${firmName(winner.firmId)} won at `) && prose.includes(`${agentName(winner.agentId)} does the work`), `the award reads as prose naming the winner (${prose.slice(0, 90)})`);
    check(/calibrated [\d.]+/.test(prose) && /expected value of [\d.]+/.test(prose), 'and gives the calibrated chance and the expected value');
    check((await page.locator('.jobpage .md-code').count()) >= 1 && (await page.locator('.jobpage .job-glob').count()) === running.scope.length, 'the issue renders as markdown, with its scope listed');
    check((await page.locator('.jobpage .job-checklist li').count()) === running.acceptance.length, 'the acceptance reads as a checklist');
    check((await page.locator('.jobpage .job-kill').count()) === 1, 'a running job offers Kill');
    const runHref = await page.locator('.jobpage .job-run-link').first().getAttribute('href');
    check(runHref === `#/runs/${running.runId}`, `the job links its run (${runHref})`);
    check((await page.locator('.jobpage .trail-row').count()) > 5, 'the ledger trail lists the job’s steps by day');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'job.png') });

    // ------------------------------------------------------------ an award with a sit-out
    let satJob: { job: Job; agentId: string; reason: string; firmId: string } | null = null;
    for (const j of jobs.filter((x) => x.status === 'merged').slice(0, 40)) {
      const d = await api<JobDetail>(page, `/api/jobs/${j.id}`);
      const row = d.ledger.find((r) => r.kind === 'job.awarded' && (r.data as { chosen?: unknown; satOut?: unknown[] }).chosen && ((r.data as { satOut?: unknown[] }).satOut ?? []).length > 0);
      if (row) {
        const data = row.data as { chosen: { firmId: string }; satOut: Array<{ agentId: string; reason: string }> };
        satJob = { job: j, agentId: data.satOut[0].agentId, reason: data.satOut[0].reason, firmId: data.chosen.firmId };
        break;
      }
    }
    check(!!satJob, 'the economy has an award that someone sat out');
    if (satJob) {
      await go(page, `#/jobs/${satJob.job.id}`);
      await within(page, 5000, async () => (await page.locator('.jobpage .sheet-title').textContent()) === satJob!.job.title && (await page.locator('.jobpage .job-award').count()) > 0);
      const award = (await page.locator('.jobpage .job-award').last().textContent()) ?? '';
      check(award.startsWith(`${firmName(satJob.firmId)} won at`), `the award names the winner (${award.slice(0, 60)})`);
      const sat = (await page.locator('.jobpage .sat-out li').allTextContents()).join(' | ');
      check(sat.includes(`${agentName(satJob.agentId)} of `) && sat.includes(`sat out: ${satJob.reason}`), `and who sat out, with why (${sat})`);
    }

    // ------------------------------------------------------------ the live run
    await go(page, `#/runs/${running.runId}`);
    const logRows = page.locator('.runpage .run-log .log-row');
    check(await within(page, 6000, async () => (await logRows.count()) > 20), `the run page shows the transcript (${await logRows.count()} lines)`);
    const pane = page.locator('.runpage .run-log');
    const atEnd = () => pane.evaluate((p) => p.scrollTop + p.clientHeight >= p.scrollHeight - 30);
    check(await within(page, 2000, atEnd), 'the transcript opens on its tail');
    check((await page.locator('.runpage .log-hold').getAttribute('aria-pressed')) === 'false' && /Following/.test((await page.locator('.runpage .log-state').textContent()) ?? ''), 'it follows the live tail');

    // Refusals and network decisions as their own ruled lines, with the reason.
    const guard = page.locator('.runpage .log-row.k-refused', { hasText: 'run git push origin HEAD' }).first();
    check((await guard.count()) === 1 && /refused by the guard\. A run never pushes/.test((await guard.locator('.log-rule-why').textContent()) ?? ''), 'a refusal shows what was refused and why');
    const egress = page.locator('.runpage .log-row.k-egress.no').first();
    check((await egress.locator('.log-rule-what').textContent()) === 'fonts.googleapis.com:443' && (await egress.locator('.log-rule-why').textContent()) === "not on this run's list", 'a refused network request shows its host and why');
    check((await page.locator('.runpage .run-fig.refused .run-fig-num').textContent()) === '2', 'the counts say two refused');

    // A tool call folds its result; a click opens it.
    const call = page.locator('.runpage .log-row.k-call:has(.log-peek)').first();
    await call.locator('.log-call').click();
    check((await page.locator('.runpage .log-row.k-call .log-out').count()) >= 1, 'a tool call unfolds to its result');

    // The log grows live, without a reload, and the pane follows it.
    const grows = async (): Promise<boolean> => {
      const was = await logRows.count();
      for (let i = 0; i < 12; i++) {
        await tick();
        if (await within(page, 700, async () => (await logRows.count()) > was)) return true;
      }
      return false;
    };
    const n0 = await logRows.count();
    check(await grows(), `the running job's log grows live (${n0} then ${await logRows.count()})`);
    check(await within(page, 1500, atEnd), 'and the pane follows the new lines');

    // Hold: the pane stays where he left it while lines arrive.
    await page.locator('.runpage .log-hold').click();
    check((await page.locator('.runpage .log-hold').getAttribute('aria-pressed')) === 'true', 'the hold toggle holds');
    await pane.evaluate((p) => {
      p.scrollTop = 0;
    });
    const n1 = await logRows.count();
    check(await grows(), `lines still arrive while held (${n1} then ${await logRows.count()})`);
    check((await pane.evaluate((p) => p.scrollTop)) === 0, 'and the held pane does not follow them');
    check(/Held; \d+ new lines? below/.test((await page.locator('.runpage .log-state').textContent()) ?? ''), `the hold says how many lines wait below (${await page.locator('.runpage .log-state').textContent()})`);
    await page.locator('.runpage .log-hold').click();
    check(await within(page, 1500, atEnd), 'releasing the hold returns to the tail');

    // A hostile line from the run reaches the page only as cleaned, redacted text.
    const hostile = 'done ‮gnp.exe <img src=x onerror="window.__pwned=1"> /Users/someone/.ssh/id_rsa ghp_abcdefghijklmnopqrstuvwxyz0123 \u001b[31mred\u001b[0m';
    appendFileSync(join(paths().runs, running.runId, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), kind: 'assistant', text: hostile })}\n`);
    emit('run.log', { runId: running.runId, line: { at: new Date().toISOString(), kind: 'assistant', text: 'x' } });
    const last = page.locator('.runpage .log-row.k-assistant', { hasText: 'gnp.exe' });
    check(await within(page, 4000, async () => (await last.count()) === 1), 'a new log line arrives from the event stream');
    const said = (await last.textContent()) ?? '';
    check(!said.includes('‮') && !said.includes('/Users/someone') && !said.includes('ghp_') && !said.includes('\u001b') && (await page.locator('.runpage .run-log img').count()) === 0 && (await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)) === undefined, `a log line shows only as cleaned, redacted text (${said.slice(0, 80)})`);
    await page.locator('.runpage .run-transcript').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'run-live.png') });

    // ------------------------------------------------------------ the scarred job: its rounds, its run, its inspection
    const scarred = jobs.find((j) => j.title === 'Search index rebuild blocks the API for 40 seconds');
    check(!!scarred, 'the economy has the scarred search index job');
    if (!scarred) return;
    const sd = await api<JobDetail>(page, `/api/jobs/${scarred.id}`);
    const failed = sd.runs.find((r) => r.outcome === 'failed');
    const insp = sd.inspections.find((i) => i.runId === failed?.id);
    check(!!failed?.scar && !!insp, 'its first attempt failed inspection and left a scar');
    if (!failed || !insp) return;
    await go(page, `#/jobs/${scarred.id}`);
    await within(page, 5000, async () => (await page.locator('.jobpage .job-round').count()) === 2);
    check((await page.locator('.jobpage .job-round').count()) === 2, 'the job page shows both of its rounds');
    const first = (await page.locator('.jobpage .job-round').first().locator('.job-award').textContent()) ?? '';
    check(first.startsWith('Lodestar won at'), `the first round names Lodestar (${first.slice(0, 40)})`);
    check(/failed inspection \(scope, review\)/.test((await page.locator('.jobpage .job-award-after').first().textContent()) ?? ''), 'and says its work failed inspection on scope and review');
    check((await page.locator('.jobpage .job-attempt').count()) === 2 && (await page.locator('.jobpage .job-insp-link').count()) === 2, 'both attempts link their run and inspection');
    const scar = page.locator('.jobpage .job-floor-row.scar');
    check((await scar.count()) === 1, 'the floor section shows the scar');
    await page.locator('.jobpage .job-bidding').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'job-rounds.png') });

    // The failed run's diff, as a unified patch with file headers.
    await go(page, `#/runs/${failed.id}`);
    check(await within(page, 5000, async () => (await page.locator('.runpage .diff-file').count()) === 4), `the run shows its diff by file (${await page.locator('.runpage .diff-file').count()})`);
    const heads = await page.locator('.runpage .diff-path').allTextContents();
    check(heads.includes('.github/workflows/ci.yml') && heads.includes('src/search/index.ts'), `the file headers name the files (${heads.join(', ')})`);
    check((await page.locator('.runpage .diff-line.add').count()) > 10 && (await page.locator('.runpage .diff-line.del').count()) > 5, 'added and removed lines are marked');
    check(/Failed: scope, review/.test((await page.locator('.runpage .run-verdict-line').textContent()) ?? ''), 'the run says its verdict');
    check((await page.locator('.runpage .log-hold').isHidden()) && /ended/.test((await page.locator('.runpage .log-state').textContent()) ?? ''), 'an ended run has no hold and says it ended');
    await page.locator('.runpage .run-diff').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'run-diff.png') });

    // The inspection report: eight checks, two failed, the reviewer, the scope and the design.
    await page.locator('.runpage .run-insp-link').click();
    check(await within(page, 5000, async () => (await page.evaluate(() => location.hash)) === `#/inspections/${insp.id}` && (await page.locator('.insppage .check-row').count()) === 8), `the inspection page shows eight checks (${await page.locator('.insppage .check-row').count()})`);
    const fails = await page.locator('.insppage .check-row.s-fail').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.check));
    check(JSON.stringify(fails) === JSON.stringify(['scope', 'review']), `fail on two: scope and review (${fails.join(', ')})`);
    check((await page.locator('.insppage .check-row.s-fail .status-word').first().textContent()) === 'fail' && (await page.locator('.insppage .check-row.s-fail .status-shape').count()) === 2, 'each status is a word with a small shape');
    check(((await page.locator('.insppage .sheet-title').textContent()) ?? '').trim() === 'Failed: scope, review', 'the verdict line reads Failed: scope, review');
    await page.locator('.insppage .check-row[data-check="test"] .check-log-btn').click();
    check(/ℹ pass 99/.test((await page.locator('.insppage .check-log').first().textContent()) ?? ''), 'a check folds open to its log');
    check((await page.locator('.insppage .insp-concerns li').count()) === 3, 'the reviewer’s concerns are listed');
    check(/\.github\/workflows\/ci\.yml/.test((await page.locator('.insppage .insp-out').textContent()) ?? ''), 'the scope names the file outside it');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'inspection.png') });
    await page.locator('.insppage .insp-design').scrollIntoViewIfNeeded();
    const loaded = await within(page, 5000, async () => (await page.locator('.insppage .insp-img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length)) === 4);
    check(loaded, 'the design shows before and after side by side for each route');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'inspection-design.png') });

    // Fly to the floor: the city comes back and goes to it.
    await go(page, `#/jobs/${scarred.id}`);
    await within(page, 5000, async () => (await page.locator('.jobpage .job-fly').count()) > 0);
    await page.locator('.jobpage .job-fly').first().click();
    check(await within(page, 4000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city' && (await page.locator('.inspector.open').count()) === 1), 'Fly to it returns to the city with the floor’s tower open');
    await page.keyboard.press('Escape');
  } finally {
    clock.stop();
    if (before) await page.setViewportSize(before);
  }
}
