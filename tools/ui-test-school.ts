/**
 * The school screen's UI checks (Phase 4 Task 30), run by tools/ui-test.ts
 * on its own engine (port UI_PORT, default 4779, a temp home) after the
 * treasury's checks, on the sample economy: seven nets with the appraiser,
 * triage and the master trusted, the master's agreement by kind with
 * harness proposals skewed, a suspended grant with the engine's sentence, a
 * voyage sailing (and advancing live), one finished and one queued, Ada
 * Quarry graduated by +0.14, and the trains. Then, on the empty home at the
 * end of the run (`schoolEmptyChecks`): seven thin nets each naming its
 * cause, no arena, 0 of 100 verified changes with the base model not
 * downloaded, the trainer not set up, and no chart drawn anywhere.
 *
 * Saves school.png, school-master.png, school-net.png, school-voyage.png
 * and school-empty.png at 1600 x 1000 for the quality rounds.
 */
import { join } from 'node:path';

import type { Browser, Page } from 'playwright';

import type { Graduate, NetCard, VoyageView } from '../shared/types.js';
import type { SchoolView } from '../app/src/api.js';

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

const text = async (page: Page, sel: string): Promise<string> => ((await page.locator(sel).first().textContent()) ?? '').trim();

/** Scrolls the sheet so `sel` stands at the top of the body, for a shot. */
async function toTop(page: Page, sel: string): Promise<void> {
  await page.locator(sel).first().evaluate((sec) => {
    const body = sec.closest('.sheet-body') as HTMLElement;
    body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await page.waitForTimeout(350);
}

export async function schoolChecks(page: Page, check: Check, shots: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  try {
    const view = await api<SchoolView>(page, '/api/school');
    const scored = view.nets.filter((n) => n.current);
    check(view.nets.length === 7 && scored.length >= 3, `the economy's school has seven nets, ${scored.length} with a version (${view.nets.map((n) => `${n.net} ${n.status}`).join(', ')})`);

    // ------------------------------------------------------------ the school
    await go(page, '#/school');
    const sheet = page.locator('.sheet.school');
    const rows = sheet.locator('.net-row');
    check(await within(page, 8000, async () => (await rows.count()) === 7), `the school lists seven nets (${await rows.count()})`);
    check((await page.evaluate(() => document.body.dataset.route)) === 'school', 'the route is the school');
    check((await page.locator('.runhead-link[data-route="school"]').getAttribute('aria-current')) === 'page', 'the running head marks School');
    check((await page.locator('.runhead-link[data-route="firms"] + .runhead-link[data-route="school"]').count()) === 1, 'School stands after Firms in the running head');
    check((await page.locator('.inspector.open').count()) === 0, 'the campus inspector does not open under the school');
    // Every net with a version shows its score with the interval and n; every one without says why.
    for (const n of view.nets) {
      const row = sheet.locator(`.net-row[data-net="${n.net}"]`);
      const line = (await row.locator('.net-line').textContent()) ?? '';
      if (n.current) {
        const score = (await row.locator('.net-score').textContent()) ?? '';
        check(/^(Brier|Error) \d\.\d\d$/.test(score.trim()) && /\d\.\d\d to \d\.\d\d, \d+ rows/.test(((await row.locator('.net-ci').textContent()) ?? '').trim()), `${n.net} shows its score with the interval and n (${score.trim()}; ${((await row.locator('.net-ci').textContent()) ?? '').trim()})`);
        check((await row.locator('svg.ciplate').count()) === 1, `${n.net} draws its interval against the baseline as a plate`);
      } else {
        check(n.status === 'thin' ? new RegExp(`\\b${n.labels} of ${n.needs}\\b`).test(line) && line.endsWith('.') && (!n.cause || line.includes(n.cause)) : /not trained|weights|beat its baseline/.test(line), `${n.net} says why it has no score (${line})`);
        check((await row.locator('svg').count()) === 0, `${n.net} draws no plate`);
      }
      check(line.length > 0 && !/undefined|null|NaN/.test(line), `${n.net}'s line reads (${line})`);
    }
    const thin = view.nets.filter((n) => n.status === 'thin');
    for (const n of thin) {
      const line = await text(page, `.net-row[data-net="${n.net}"] .net-line`);
      check(!!n.cause && line.includes(n.cause) && line.endsWith('.'), `the thin ${n.net} names its cause (${line})`);
    }
    check((await sheet.locator('.net-row[data-net="appraiser-pass"] .net-self').count()) === (view.nets.find((n) => n.net === 'appraiser-pass')?.selfSelected ? 1 : 0), 'the appraiser says when its rows are partly self-selected');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'school.png') });

    // ------------------------------------------------------------ the master
    const master = sheet.locator('.school-sec[data-sec="master"]');
    const skewed = view.agreements.find((a) => a.skewed);
    check(!!skewed, `the economy marks a kind skewed (${skewed?.kind ?? 'none'})`);
    if (skewed) {
      const row = master.locator(`.kind-row[data-kind="${skewed.kind}"]`);
      check(/You approve nearly all of these, so the master cannot show it knows better than that; this kind may never be offered\./.test((await row.textContent()) ?? ''), `the skewed kind carries its sentence (${((await row.locator('.kind-line').textContent()) ?? '').trim()})`);
      check((await row.locator('svg').count()) === 0, 'and no plate stands in for it');
    }
    const eligible = view.agreements.find((a) => a.eligible && !a.skewed && a.rate);
    if (eligible) {
      const row = master.locator(`.kind-row[data-kind="${eligible.kind}"]`);
      check(/Agreed with you on \d+ of the last \d+ decisions: \d\.\d\d, 95% interval \d\.\d\d to \d\.\d\d\. Enough for autonomy\./.test(((await row.locator('.kind-line').textContent()) ?? '').trim()), `an eligible kind reads its count and interval (${((await row.locator('.kind-line').textContent()) ?? '').trim()})`);
      check((await row.locator('svg.ciplate').count()) === 1, 'with its rate drawn against the 95% mark');
    }
    check((await master.locator('.kind-row').count()) === 6, `every kind of work has a row (${await master.locator('.kind-row').count()})`);
    const suspended = view.grants.find((g) => g.state === 'suspended');
    check(!!suspended && /autonomy needs 50 at 95%/.test(suspended.reason ?? ''), `the economy holds a suspended grant with the engine's sentence (${suspended?.reason ?? 'none'})`);
    if (suspended) {
      const row = master.locator(`.grant-row[data-kind="${suspended.kind}"][data-repo="${suspended.repo}"]`);
      check((await row.getAttribute('data-state')) === 'suspended' && /Suspended by the school: the master agreed with you on 44 of the last 50 merge:low decisions; autonomy needs 50 at 95%\./.test((await row.textContent()) ?? ''), `the suspended grant reads the engine's sentence (${((await row.locator('.grant-line').textContent()) ?? '').trim()})`);
    }
    check((await master.locator('.grant-row[data-state="asked"]').count()) === view.grants.filter((g) => g.state === 'asked').length, 'the open ask is listed as asked');
    check((await master.locator('.master-card .net-score').count()) === 1 && /Brier \d\.\d\d/.test((await master.locator('.master-card').textContent()) ?? ''), 'the master card carries its Brier');
    check(/Agreement \d\.\d\d, 95% interval \d\.\d\d to \d\.\d\d, on \d+ decisions/.test((await master.locator('.master-card').textContent()) ?? ''), 'and its agreement with him, with the interval and n');
    await go(page, '#/school/master');
    check(
      await within(page, 4000, async () => {
        const d = await master.evaluate((sec) => Math.abs(sec.getBoundingClientRect().top - sec.closest('.sheet-body')!.getBoundingClientRect().top));
        return d < 40;
      }),
      'the dome’s address, #/school/master, lands on the master’s section',
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'school-master.png') });
    await toTop(page, '.school-sec[data-sec="arenas"]');
    await page.screenshot({ path: join(shots, 'school-arenas.png') });
    await toTop(page, '.school-sec[data-sec="graduates"]');
    await page.screenshot({ path: join(shots, 'school-graduates.png') });

    // ------------------------------------------------------------ arenas, voyages, graduates, training
    const arenas = sheet.locator('.school-sec[data-sec="arenas"] .arena-row');
    check((await arenas.count()) === view.arenas.length && view.arenas.length >= 2, `every arena has a row (${await arenas.count()})`);
    const planted = view.arenas.find((a) => a.kind === 'planted');
    if (planted) check(new RegExp(`sealed set used ${planted.sealedUses} of 10 times`).test((await sheet.locator(`.arena-row[data-arena="${planted.id}"]`).textContent()) ?? ''), `the planted arena counts its sealed uses (${planted.sealedUses})`);
    // A refused arena build, as the engine records one when a build is turned away as it starts.
    {
      const { record } = await import('../engine/ledger.js');
      const { emit } = await import('../engine/events.js');
      const refusal = { repo: 'hoshi/kumo', kind: 'past' as const, reason: 'A graduation race is running; build the arena once it ends', at: new Date().toISOString() };
      record('arena.refused', refusal);
      emit('arena.refused', refusal);
      const shown = sheet.locator('.arena-refusal').first();
      check(await within(page, 8000, async () => /A graduation race is running; build the arena once it ends/.test((await shown.textContent()) ?? '')), `a refused arena build shows with its reason (${((await shown.textContent()) ?? '').trim()})`);
      check(/hoshi\/kumo/.test((await shown.textContent()) ?? '') && /past/.test((await shown.textContent()) ?? ''), 'naming the repo and the kind');
    }

    const voyages = sheet.locator('.school-sec[data-sec="voyages"] .voyage-row');
    check((await voyages.count()) === view.voyages.length && view.voyages.length >= 3, `every voyage has a row (${await voyages.count()})`);
    const queued = view.voyages.find((v) => v.queued);
    check(!!queued, 'the economy holds a queued commission');
    if (queued) {
      const row = sheet.locator(`.voyage-row[data-voyage="${queued.id}"]`);
      check((await row.getAttribute('data-status')) === 'queued' && /^Queued\. Commissioned by Quickset/.test(((await row.locator('.voyage-line').textContent()) ?? '').trim()), `the commission reads as queued, not paused (${((await row.locator('.voyage-line').textContent()) ?? '').trim()})`);
    }
    const sailing = view.voyages.find((v) => v.status === 'sailing');
    check(!!sailing, 'a voyage is sailing');
    if (sailing) {
      const row = sheet.locator(`.voyage-row[data-voyage="${sailing.id}"]`);
      const line = ((await row.locator('.voyage-line').textContent()) ?? '').trim();
      check(line === `Sailing: generation ${sailing.generation} of ${sailing.of}, ${sailing.runs.done} of ${sailing.runs.of} runs. A voyage spans several nights.`, `the sailing voyage reads its generation and runs (${line})`);
      // The engine races on: the next generation is announced as voyages.ts announces one, and the row moves with it.
      const { voyage: stored } = await import('../engine/school/voyage-table.js');
      const { openDb } = await import('../engine/db.js');
      const { record } = await import('../engine/ledger.js');
      const { emit } = await import('../engine/events.js');
      const v = stored(sailing.id)!;
      const next: VoyageView = { ...v, runs: { ...v.runs, done: v.runs.done + 23 } };
      openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(next.id, JSON.stringify(next));
      const data = { voyageId: next.id, voyage: structuredClone(next), repo: next.repo ?? null };
      record('voyage.generation', data);
      emit('voyage.generation', structuredClone(data));
      check(await within(page, 8000, async () => new RegExp(`${next.runs.done} of ${next.runs.of} runs`).test((await row.locator('.voyage-line').textContent()) ?? '')), `the sailing voyage advances live (${((await row.locator('.voyage-line').textContent()) ?? '').trim()})`);
    }
    const done = view.voyages.find((v) => v.status === 'done');
    if (done) check(/beat every seeded local agent on the sealed tasks/.test((await sheet.locator(`.voyage-row[data-voyage="${done.id}"]`).textContent()) ?? ''), 'the finished voyage carries its champion’s claim');

    const grads = sheet.locator('.school-sec[data-sec="graduates"] .graduate-row');
    check((await grads.count()) === view.graduates.length && view.graduates.length === 1, `the graduate has a row (${await grads.count()})`);
    const g = view.graduates[0] as Graduate | undefined;
    if (g) {
      const row = sheet.locator(`.graduate-row[data-graduate="${g.id}"]`);
      check(/\+0\.14, 95% interval \+0\.06 to \+0\.22/.test((await row.textContent()) ?? ''), `the graduate's difference carries its interval (${((await row.locator('.graduate-diff').textContent()) ?? '').trim()})`);
      check(/Ada Quarry/.test((await row.textContent()) ?? ''), 'and is named as the roster named it');
      check(/Score 0\.61, 95% interval 0\.52 to 0\.70, on \d+ sealed tasks/.test((await row.textContent()) ?? ''), 'with its sealed score and n');
    }
    check(/enough to train|verified changes/.test((await sheet.locator('.school-sec[data-sec="graduates"] .lora-line').textContent()) ?? ''), `the LoRA counts its verified changes (${await text(page, '.school-sec[data-sec="graduates"] .lora-line')})`);
    check(/is downloaded/.test((await sheet.locator('.school-sec[data-sec="graduates"] .lora-base').textContent()) ?? ''), `the base model is downloaded on the economy (${await text(page, '.school-sec[data-sec="graduates"] .lora-base')})`);

    const training = sheet.locator('.school-sec[data-sec="training"]');
    check(/^Training (waits|may run): .+\.$/.test(await text(page, '.school-sec[data-sec="training"] .gate-line')), `the gate says whether training may run (${await text(page, '.school-sec[data-sec="training"] .gate-line')})`);
    check((await training.locator('.train-row').count()) === view.trains.length && view.trains.length > 0, `every recent train has a row (${await training.locator('.train-row').count()} of ${view.trains.length})`);
    const pausedLora = view.trains.find((t) => t.kind === 'lora' && t.status === 'paused');
    if (pausedLora) check(/A LoRA, paused: on battery\. \d+ of \d+ steps, \d+ lost to the pause, the optimizer reset\./.test((await training.locator(`.train-row[data-train="${pausedLora.id}"]`).textContent()) ?? ''), `the paused LoRA says what the pause lost (${await text(page, `.train-row[data-train="${pausedLora.id}"] .train-line`)})`);
    check(/^The trainer /.test(await text(page, '.school-sec[data-sec="training"] .trainer-line')), `the trainer says where it stands (${await text(page, '.school-sec[data-sec="training"] .trainer-line')})`);

    // ------------------------------------------------------------ a net's page
    await go(page, '#/school/nets/appraiser-pass');
    const detail = await api<NetCard & { versions: unknown[] }>(page, '/api/school/nets/appraiser-pass');
    check(await within(page, 8000, async () => (await sheet.getAttribute('data-page')) === 'net' && (await sheet.locator('.sheet-title').textContent()) === 'Appraiser, pass'), `a net's address opens its page (${await sheet.locator('.sheet-title').textContent()})`);
    const plot = sheet.locator('svg.netplot');
    check((await plot.count()) === 1 && (await plot.locator('.netplot-point').count()) === detail.versions.length && detail.versions.length >= 2, `the net's plate carries one point per version (${await plot.locator('.netplot-point').count()} of ${detail.versions.length})`);
    check((await plot.locator('.netplot-whisker').count()) === detail.versions.length, 'each with its interval as a whisker');
    check((await plot.locator('.netplot-base').count()) >= 1, 'and the baseline ruled across it');
    check((await sheet.locator('.version-row').count()) === detail.versions.length, 'and every version listed beneath');
    check(/School/.test((await sheet.locator('.detail-trail').textContent()) ?? '') && /The nets/.test((await sheet.locator('.detail-trail').textContent()) ?? ''), 'with the trail back to the school');
    for (const sel of ['.netplot-axis', '.netplot-tick-label']) {
      const style = await plot.locator(sel).first().evaluate((e) => getComputedStyle(e).fontSize);
      check(style === '11px', `${sel} is set at 11 px (${style})`);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'school-net.png') });
    // A net with one version draws no plate: the sentence stands instead.
    const one = view.nets.find((n) => n.history.length === 1 && n.current);
    if (one) {
      await go(page, `#/school/nets/${one.net}`);
      check(await within(page, 8000, async () => (await sheet.locator('.sheet-title').textContent()) !== 'Appraiser, pass' && (await sheet.locator('.version-row').count()) === 1), `a net with one version opens (${one.net})`);
      check((await sheet.locator('svg.netplot').count()) === 0 && /one version/i.test((await sheet.locator('.netplot-none').textContent()) ?? ''), `and says a plate needs two (${await text(page, '.netplot-none')})`);
    }
    // A thin net's page says why, and draws nothing.
    await go(page, '#/school/nets/taste');
    check(await within(page, 8000, async () => (await sheet.locator('.sheet-title').textContent()) === 'Taste'), 'a thin net opens its page');
    check((await sheet.locator('svg').count()) === 0 && /labels/.test((await sheet.locator('.detail-sub').textContent()) ?? ''), `with its counts and cause, no plate (${await text(page, '.sheet.school .detail-sub')})`);

    // ------------------------------------------------------------ a voyage's page
    if (sailing) {
      await go(page, `#/school/voyages/${sailing.id}`);
      check(await within(page, 8000, async () => (await sheet.getAttribute('data-page')) === 'voyage' && (await sheet.locator('.voyage-gen').count()) >= 2), `the sailing voyage's page lists its generations (${await sheet.locator('.voyage-gen').count()})`);
      check((await sheet.locator('.voyage-gen[data-generation="1"] .genome-row').count()) === 4, 'generation 1 is the four seeded local agents');
      check((await sheet.locator('.genome-row[data-scored="false"]').count()) > 0 && /racing now/.test((await sheet.locator('.genome-row[data-scored="false"]').first().textContent()) ?? ''), 'the generation racing now says so instead of a number');
      check(/Sailing: generation/.test((await sheet.locator('.detail-sub').textContent()) ?? ''), 'its line stands under the title');
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, 'school-voyage.png') });
    }
    if (done) {
      await go(page, `#/school/voyages/${done.id}`);
      check(await within(page, 8000, async () => (await sheet.locator('.voyage-champion').count()) === 1), 'the finished voyage shows its champion');
      check((await sheet.locator('.vslocal-row').count()) === (done.vsLocal?.length ?? 0) && (done.vsLocal?.length ?? 0) > 0, `against each seeded local agent (${await sheet.locator('.vslocal-row').count()})`);
      check((await sheet.locator('svg.genplot').count()) === 1 && (await sheet.locator('svg.genplot .genplot-point').count()) === done.of, 'with the best of each generation as a plate');
    }

    // ------------------------------------------------------------ a graduate's page
    if (g) {
      await go(page, `#/school/graduates/${g.id}`);
      check(await within(page, 8000, async () => (await sheet.getAttribute('data-page')) === 'graduate' && (await sheet.locator('.sheet-title').textContent()) === 'Ada Quarry'), `the graduate's page is named for the agent (${await sheet.locator('.sheet-title').textContent()})`);
      check(/Score 0\.61, 95% interval 0\.52 to 0\.70/.test((await sheet.locator('.graduate-sealed').textContent()) ?? '') && /Score 0\.47, 95% interval 0\.38 to 0\.56/.test((await sheet.locator('.graduate-sealed').textContent()) ?? ''), 'its sealed score stands against the base’s');
      check((await sheet.locator('a[href^="#/agents/"]').count()) >= 1, 'and links to the agent it became');
    }
    await go(page, '#/');
    await within(page, 4000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city');
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

/**
 * The school on a fresh home with no repos (the economy's is never empty):
 * every net thin with its cause, no arena, no voyage, no graduate, the base
 * model not downloaded, the trainer not set up, and no chart anywhere.
 */
export async function schoolEmptyChecks(browser: Browser, origin: string, check: Check, shots: string): Promise<void> {
  const page = await browser.newPage({ viewport: SIZE });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    const view = (await (await fetch(`${origin}/api/school`)).json()) as SchoolView;
    check(view.nets.every((n) => n.status === 'thin') && view.arenas.length === 0 && view.voyages.length === 0 && view.graduates.length === 0, 'a fresh home has a thin school');
    await page.goto(`${origin}/?debug#/school`);
    await page.waitForFunction(() => (window as unknown as { __palimpsest?: { ready: boolean } }).__palimpsest?.ready === true, null, { timeout: 30_000 });
    const sheet = page.locator('.sheet.school');
    const rows = sheet.locator('.net-row');
    check(await within(page, 8000, async () => (await rows.count()) === 7), `the empty school lists seven nets (${await rows.count()})`);
    check((await sheet.locator('.net-row[data-status="thin"]').count()) === 7, 'every one thin');
    for (const n of view.nets) {
      const line = await text(page, `.net-row[data-net="${n.net}"] .net-line`);
      check(new RegExp(`^0 of ${n.needs} labels[.:] .+\\.$`).test(line), `${n.net} names its cause (${line})`);
      check(n.cause !== null && line.includes(n.cause), `in the engine's words (${n.cause})`);
    }
    check(/No arena/.test(await text(page, '.school-sec[data-sec="arenas"] .school-empty')), `no arena, and why (${await text(page, '.school-sec[data-sec="arenas"] .school-empty')})`);
    check(/No voyage/.test(await text(page, '.school-sec[data-sec="voyages"] .school-empty')), `no voyage, and why (${await text(page, '.school-sec[data-sec="voyages"] .school-empty')})`);
    check((await text(page, '.school-sec[data-sec="graduates"] .lora-line')) === '0 of 100 verified changes', `0 of 100 verified changes (${await text(page, '.school-sec[data-sec="graduates"] .lora-line')})`);
    check(/is not downloaded\.$/.test(await text(page, '.school-sec[data-sec="graduates"] .lora-base')), `the base model is not downloaded (${await text(page, '.school-sec[data-sec="graduates"] .lora-base')})`);
    check((await text(page, '.school-sec[data-sec="training"] .trainer-line')) === 'The trainer is not set up on this Mac.', `the trainer is not set up (${await text(page, '.school-sec[data-sec="training"] .trainer-line')})`);
    check((await sheet.locator('.school-sec[data-sec="master"] .kind-row').count()) === 6 && (await sheet.locator('.school-sec[data-sec="master"] .kind-row .kind-line', { hasText: 'No decision of this kind has had a prediction yet.' }).count()) === 6, 'every kind says no decision has had a prediction yet');
    check(/^The master is thin/.test(await text(page, '.school-sec[data-sec="master"] .master-card')), `the master card says it is thin (${(await text(page, '.school-sec[data-sec="master"] .master-card')).slice(0, 80)})`);
    check(/No autonomy/.test(await text(page, '.school-sec[data-sec="master"] .grants .school-empty')), `no autonomy asked, and why (${await text(page, '.school-sec[data-sec="master"] .grants .school-empty')})`);
    check(/No train/.test(await text(page, '.school-sec[data-sec="training"] .school-empty')), `no train yet, and why (${await text(page, '.school-sec[data-sec="training"] .school-empty')})`);
    check((await sheet.locator('svg').count()) === 0, `no chart element anywhere on the empty school (${await sheet.locator('svg').count()})`);
    check((await sheet.locator('.sheet-body').evaluate((b) => /\b(undefined|null|NaN)\b/.test(b.textContent ?? ''))) === false, 'no undefined, null or NaN in its text');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'school-empty.png') });
    await go(page, '#/school/nets/master');
    check(await within(page, 8000, async () => (await sheet.getAttribute('data-page')) === 'net' && (await sheet.locator('.sheet-title').textContent()) === 'Master'), 'a thin net’s page opens on the empty home');
    check((await sheet.locator('svg').count()) === 0 && /^0 of 40 labels\. /.test(await text(page, '.sheet.school .detail-sub')), `with its counts and cause, no plate (${await text(page, '.sheet.school .detail-sub')})`);
    check(errors.length === 0, `the empty school has no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } finally {
    await page.close();
  }
}
