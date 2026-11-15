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

import type { Graduate, Grant, NetCard, VoyageView } from '../shared/types.js';
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
    // The cost head's rows leave out the runs that hit their credit cap, and it says so (Phase 5 Task 17).
    const bias = (await sheet.locator('.net-row[data-net="appraiser-cost"] .net-bias').textContent().catch(() => null)) ?? '';
    check(/credit cap/.test(bias) && /reads costs low/.test(bias) && (await sheet.locator('.net-bias').count()) === 1, `the cost head discloses its bias from the capped runs it leaves out (${bias.slice(0, 60)})`);
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

// ---------------------------------------------------------------- autonomy where he decides (Phase 4 Task 31)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayMonth = (ms: number): string => `${new Date(ms).getDate()} ${MONTHS[new Date(ms).getMonth()]}`;

/** Gives `sel` keyboard focus (Shift+Tab then Tab back onto it), so :focus-visible applies as it would for him. */
async function keyFocus(page: Page, sel: string): Promise<boolean> {
  const el = page.locator(sel).first();
  await el.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  return el.evaluate((e) => document.activeElement === e && e.matches(':focus-visible') && getComputedStyle(e).outlineStyle !== 'none');
}

/** Every action in `scope` is a button or a link in the tab order (none taken out of it). */
async function tabbable(page: Page, scope: string): Promise<{ all: boolean; n: number }> {
  return page.locator(scope).evaluate((root) => {
    const acts = [...root.querySelectorAll<HTMLElement>('button, a[href]')];
    return { all: acts.every((a) => a.tabIndex >= 0 && !a.closest('[hidden]') && !a.hasAttribute('inert')), n: acts.length };
  });
}

/**
 * Autonomy in the four places he already looks, on the economy: the
 * harbour's open ask granted from the brief shows granted in Settings and
 * on the district page live (a second window holds the district page); Take
 * it back in Settings revokes it with its quiet date; Settings grants it
 * again; a suspension for his undo names it; the district's "Build an
 * arena" is held with the engine's reason on a market-off repo and while a
 * graduation race runs; a job page shows the master's guess and another its
 * abstention. Every move by the keyboard, with the focus visible.
 *
 * Saves brief-autonomy.png, autonomy-settings.png, district-autonomy.png
 * and job-school.png at 1600 x 1000. Answers the number of refusals it
 * provoked on purpose (each a 409 in the console), for the caller to excuse.
 */
export async function autonomyChecks(page: Page, check: Check, shots: string): Promise<number> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const { openDb } = await import('../engine/db.js');
  const { record } = await import('../engine/ledger.js');
  const { emit } = await import('../engine/events.js');
  const { suspend } = await import('../engine/school/autonomy.js');
  const { holdTrain } = await import('../engine/school/trainer.js');
  const { arenaRefusal, RACE_REFUSAL } = await import('../shared/school-rules.js');
  const harbour = 'tidewater/harbor-ledger';
  const kind = 'propose:readme-gap';
  const pairSel = (root: string) => `${root} .grant-entry[data-kind="${kind}"][data-repo="${harbour}"]`;
  const second = await page.context().browser()!.newPage({ viewport: SIZE });
  const errors2: string[] = [];
  second.on('console', (m) => {
    if (m.type() === 'error') errors2.push(m.text());
  });
  second.on('pageerror', (e) => errors2.push(String(e)));
  try {
    const view = await api<SchoolView>(page, '/api/school');
    const ask = view.grants.find((g) => g.kind === kind && g.repo === harbour);
    check(ask?.state === 'asked', `the economy holds the harbour's open ask for README gap proposals (${ask?.state ?? 'none'})`);
    check(view.settings.enabled, 'the school is on in the economy');

    // ------------------------------------------------------------ a second window on the harbour's district page
    await second.goto(`${new URL(page.url()).origin}/#/repos/tidewater/harbor-ledger`);
    const district2 = second.locator('.sheet.district');
    check(await within(second, 15_000, async () => (await second.locator(pairSel('.sheet.district')).count()) === 1), 'the harbour’s district page lists its ask');
    check((await second.locator(pairSel('.sheet.district')).getAttribute('data-state')) === 'asked' && /^asked (today|yesterday)$/.test(((await second.locator(`${pairSel('.sheet.district')} .grant-entry-state`).textContent()) ?? '').trim()), `as asked (${((await second.locator(`${pairSel('.sheet.district')} .grant-entry-state`).textContent()) ?? '').trim()})`);
    check((await district2.locator('.district-note').count()) === 0, 'the Phase 3 note is gone');

    // ------------------------------------------------------------ the brief: the ask, granted by the keyboard
    await go(page, '#/brief');
    const brief = page.locator('.sheet.brief');
    const itemId = `autonomy:${kind}:${harbour}`;
    const row = brief.locator(`.brief-item[data-item="${itemId}"]`);
    check(await within(page, 8000, async () => (await row.count()) === 1), 'the brief holds the ask, waiting on him');
    const sentence = ((await row.locator('.brief-sentence').textContent()) ?? '').trim();
    check(/README gap proposals/.test(sentence) && !/propose:readme-gap/.test(sentence), `its sentence names the kind in words (${sentence.slice(0, 120)})`);
    const labels = await row.locator('.brief-act').allTextContents();
    check(labels.includes('Let the city do this on its own here') && labels.includes('Not yet'), `it offers the grant and Not yet (${labels.join(', ')})`);
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, 'brief-autonomy.png') });
    // Ask why: the kind's agreement and where every grant is kept.
    await row.locator('.brief-act[data-action="why"]').click();
    check(await within(page, 6000, async () => /the master agreed with you on \d+ of the last \d+ decisions/.test((await row.locator('.brief-why').textContent()) ?? '')), `Ask why gives the kind's agreement (${((await row.locator('.brief-why').textContent()) ?? '').trim().slice(0, 140)})`);
    check((await row.locator('.brief-why a[href="#/settings"]').count()) === 1, 'and points to Settings');
    check(await keyFocus(page, `.brief-item[data-item="${itemId}"] .brief-act[data-action="grant"]`), 'the grant takes the keyboard’s focus, visibly');
    await page.keyboard.press('Enter');
    const said = async (sel: string) => ((await row.locator(sel).textContent({ timeout: 500 }).catch(() => '')) ?? '').trim();
    check(await within(page, 8000, async () => /^Granted, \d+:\d\d$/.test(await said('.brief-acted'))), `the row says it was granted (${(await said('.brief-acted')) || (await said('.brief-error')) || `focus on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`})`);
    check((await row.locator('.brief-act[data-action="grant"]').count()) === 0, 'and offers the grant no longer');
    check(await within(second, 8000, async () => (await second.locator(pairSel('.sheet.district')).getAttribute('data-state')) === 'granted'), 'the district page in the other window shows it granted, live');
    check(/^granted \d+ [A-Z][a-z]+, none since$/.test(((await second.locator(`${pairSel('.sheet.district')} .grant-entry-state`).textContent()) ?? '').trim()), `in a ledger's words (${((await second.locator(`${pairSel('.sheet.district')} .grant-entry-state`).textContent()) ?? '').trim()})`);

    // ------------------------------------------------------------ Settings: every pair, Take it back, grant it again
    await go(page, '#/settings');
    const settings = page.locator('.sheet.settings .set-sec.autonomy');
    const now = await api<SchoolView>(page, '/api/school');
    check(await within(page, 8000, async () => (await settings.locator('.grant-entry').count()) === now.grants.length), `Settings lists every pair (${await settings.locator('.grant-entry').count()} of ${now.grants.length})`);
    const srow = page.locator(pairSel('.sheet.settings'));
    check((await srow.getAttribute('data-state')) === 'granted', 'the harbour’s pair reads granted in Settings');
    check((await srow.locator('.grant-entry-repo').getAttribute('href')) === '#/repos/tidewater/harbor-ledger', 'its repo links to the district page');
    check(/^\d\.\d\d$/.test(((await srow.locator('.grant-entry-rate').textContent()) ?? '').trim()) && /^\d+ of \d+$/.test(((await srow.locator('.grant-entry-of').textContent()) ?? '').trim()), `with the master's agreement on the kind (${((await srow.locator('.grant-entry-fig').textContent()) ?? '').trim()})`);
    check(((await srow.locator('.grant-entry-where').textContent()) ?? '').trim() === 'on all repos', 'Settings labels it the kind’s, on all repos');
    {
      const fig = second.locator(`${pairSel('.sheet.district')} .grant-entry-fig`);
      const where = ((await fig.locator('.grant-entry-where').textContent().catch(() => '')) ?? '').trim();
      const of = ((await fig.locator('.grant-entry-of').textContent().catch(() => '')) ?? '').trim();
      const own = (await api<SchoolView>(page, '/api/school')).grantAgreements.find((a) => a.kind === kind && a.repo === harbour);
      check(where === 'on this repo' && !!own && of === `${own.repoAgreed} of ${own.repoRows}`, `the district page shows the repo's own agreement, labelled (${of} ${where}; engine ${own?.repoAgreed} of ${own?.repoRows})`);
    }
    const kumo = now.grants.find((g) => g.state === 'suspended');
    if (kumo) {
      const k = page.locator(`.sheet.settings .grant-entry[data-kind="${kumo.kind}"][data-repo="${kumo.repo}"] .grant-entry-state`);
      check(/^suspended: the master agreed with you on 44 of the last 50 low-tier merges; autonomy needs 50 at 95%$/.test(((await k.textContent()) ?? '').trim()), `the window's suspension keeps the engine's sentence, its kind in words (${((await k.textContent()) ?? '').trim()})`);
    }
    const reverted = now.grants.find((g) => g.state === 'revoked' && g.by === 'revert');
    if (reverted) check(/^revoked by a revert on \d+ [A-Z][a-z]+$/.test(((await page.locator(`.sheet.settings .grant-entry[data-kind="${reverted.kind}"][data-repo="${reverted.repo}"] .grant-entry-state`).textContent()) ?? '').trim()), 'a revert’s revocation says so');
    check((await page.locator('.sheet.settings .grant-entry[data-repo="AllStreets/beagle" i] [data-move="grant"], .sheet.settings .grant-entry[data-repo="AllStreets/beagle" i] [data-move="regrant"]').count()) === 0, 'Beagle is never offered a grant');
    const tab = await tabbable(page, '.sheet.settings .set-sec.autonomy');
    check(tab.all && tab.n > 0, `every move in Settings is in the tab order (${tab.n})`);
    check(await keyFocus(page, `${pairSel('.sheet.settings')} [data-move="revoke"]`), 'Take it back takes the keyboard’s focus, visibly');
    await page.keyboard.press('Enter');
    const quiet = dayMonth(Date.now() + 30 * 86_400_000);
    check(await within(page, 8000, async () => ((await srow.locator('.grant-entry-state').textContent()) ?? '').trim() === `you took it back; quiet until ${quiet}`), `Take it back revokes it and shows the quiet date (${((await srow.locator('.grant-entry-state').textContent()) ?? '').trim()})`);
    check((await page.evaluate(() => document.activeElement?.closest('[data-pair]')?.getAttribute('data-pair') ?? '')) === `${kind} ${harbour}`, 'focus stays on the pair after the move');
    check(await within(second, 8000, async () => (await second.locator(pairSel('.sheet.district')).getAttribute('data-state')) === 'revoked'), 'the district page shows it taken back, live');
    check((await second.locator(`${pairSel('.sheet.district')} [data-move]`).count()) === 0 && (await second.locator(`${pairSel('.sheet.district')} .grant-entry-to`).getAttribute('href')) === '#/settings', 'and there sends him to Settings to grant it again');
    check(await keyFocus(page, `${pairSel('.sheet.settings')} [data-move="regrant"]`), 'Grant it again takes the keyboard’s focus, visibly');
    await page.keyboard.press('Enter');
    check(await within(page, 8000, async () => (await srow.getAttribute('data-state')) === 'granted'), 'Settings grants it again');
    check(await within(second, 8000, async () => (await second.locator(pairSel('.sheet.district')).getAttribute('data-state')) === 'granted'), 'and the district page follows, live');

    // His undo of an accepted proposal suspends the pair (decisions.ts's hook, UNDO_REASON): the row names it.
    suspend(kind, harbour, 'he undid it', Date.now());
    check(await within(page, 8000, async () => ((await srow.locator('.grant-entry-state').textContent()) ?? '').trim() === 'suspended: you undid an accepted proposal'), `the suspended row names his undo (${((await srow.locator('.grant-entry-state').textContent()) ?? '').trim()})`);
    check((await srow.locator('[data-move]').allTextContents()).join() === 'Take it back', 'and offers to take it back');
    await page.locator('.sheet.settings .sheet-body').evaluate((b) => {
      const sec = b.querySelector('.set-sec.autonomy') as HTMLElement;
      b.scrollTop += sec.getBoundingClientRect().top - b.getBoundingClientRect().top - 24;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'autonomy-settings.png') });

    // A move the engine refuses keeps its sentence under the row. He takes the suspended pair back; meanwhile it is
    // granted again where this window cannot hear (the row and its ledger entry written, no event), so his Grant it
    // again meets the engine's refusal.
    await srow.locator('[data-move="revoke"]').click();
    check(await within(page, 8000, async () => (await srow.getAttribute('data-state')) === 'revoked'), 'Take it back on the suspended pair revokes it');
    {
      const row = openDb().prepare('SELECT json FROM grants WHERE kind = ? AND repo = ?').get(kind, harbour) as { json: string };
      const g = { ...(JSON.parse(row.json) as Grant), state: 'granted' as const, at: new Date().toISOString(), by: 'him' as const, reason: null, quietUntil: null };
      openDb().prepare('UPDATE grants SET state = ?, at = ?, json = ? WHERE kind = ? AND repo = ?').run(g.state, g.at, JSON.stringify(g), kind, harbour);
      record('autonomy.granted', { kind, repo: harbour, fromSettings: true, grant: g, at: g.at });
    }
    await srow.locator('[data-move="regrant"]').click();
    const refused = srow.locator('.grant-entry-error');
    check(await within(page, 8000, async () => ((await refused.textContent().catch(() => '')) ?? '').trim() === `Grant it again refused: ${kind} on ${harbour} is already granted.`), `the engine's refusal stands under the row in its own words (${((await refused.textContent().catch(() => '')) ?? '').trim()})`);
    check((await refused.getAttribute('role')) === 'alert', 'and is announced');
    check(await within(page, 8000, async () => (await srow.getAttribute('data-state')) === 'granted'), 'and the row reads the pair as the engine has it');

    // ------------------------------------------------------------ the district page: the arena held with its reason
    await second.close();
    const repos = await api<Array<{ fullName: string; connected: boolean; market: boolean; checks: { test: string | null } | null }>>(page, '/api/repos');
    const onRepo = repos.find((r) => r.connected && arenaRefusal(r, true) === null && r.fullName === 'hoshi/kumo') ?? repos.find((r) => r.connected && arenaRefusal(r, true) === null);
    if (onRepo) {
      await go(page, `#/repos/${onRepo.fullName}`);
      const sec = page.locator('.sheet.district .district-arena');
      const btn = sec.locator('.darena-go');
      check(await within(page, 8000, async () => (await btn.count()) === 1 && (await btn.textContent()) === 'Build an arena'), `${onRepo.fullName}'s district page offers Build an arena`);
      check(await within(page, 4000, async () => (await btn.getAttribute('aria-disabled')) === null), `enabled on a market-on repo with a test command (${((await sec.locator('.darena-why').textContent()) ?? '').trim() || 'no reason'})`);
      check((await sec.locator('.darena-kind[role="radio"]').count()) === 2, 'with its two kinds, planted bugs and past changes');
      // The block draws after the page's own school read lands: waited for, as the arena button above is.
      check(await within(page, 8000, async () => (await page.locator('.sheet.district .district-autonomy .grant-entry').count()) === now.grants.filter((g) => g.repo === onRepo.fullName).length), 'its pairs are listed on its page');
      await page.locator('.sheet.district .district-autonomy').evaluate((s) => {
        const body = s.closest('.sheet-body') as HTMLElement;
        body.scrollTop += s.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, 'district-autonomy.png') });
      // A graduation race holds the graduates' server: the build is refused with the engine's reason (Task 27).
      const release = holdTrain({ id: 'ui-eval', kind: 'eval', status: 'running', reason: null, startedAt: new Date().toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 }, () => {});
      try {
        await go(page, '#/repos');
        await page.waitForTimeout(300);
        await go(page, `#/repos/${onRepo.fullName}`);
        check(await within(page, 8000, async () => (await btn.getAttribute('aria-disabled')) === 'true' && ((await sec.locator('.darena-why').textContent()) ?? '').trim() === `${RACE_REFUSAL}.`), `while a graduation race runs it is held with the engine's reason (${((await sec.locator('.darena-why').textContent()) ?? '').trim()})`);
        check(await keyFocus(page, '.sheet.district .darena-go'), 'the held button still takes focus, so its reason is heard');
        const asked = await api<SchoolView>(page, '/api/school');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        const after = await api<SchoolView>(page, '/api/school');
        check(after.arenas.length === asked.arenas.length && after.arenaRefusals.length === asked.arenaRefusals.length, 'and Enter on it asks the engine nothing');
      } finally {
        release();
      }
    } else check(false, 'the economy holds a market-on repo with a test command');
    const off = repos.find((r) => r.connected && !r.market);
    const offName = off?.fullName ?? 'kestrel/fieldnotes';
    if (!off) await page.evaluate((n) => fetch(`/api/repos/${n}`, { method: 'PATCH', headers: { 'x-palimpsest': '1', 'content-type': 'application/json' }, body: JSON.stringify({ market: false }) }), offName);
    try {
      await go(page, `#/repos/${offName}`);
      const sec = page.locator('.sheet.district .district-arena');
      const reason = `The market is off on ${offName}; an arena is built only from a market-on repo.`;
      check(await within(page, 8000, async () => (await sec.locator('.darena-go').getAttribute('aria-disabled')) === 'true' && ((await sec.locator('.darena-why').textContent()) ?? '').trim() === reason), `on the market-off ${offName} Build an arena is held with the engine's reason (${((await sec.locator('.darena-why').textContent()) ?? '').trim()})`);
      check(((await page.locator('.sheet.district .district-autonomy .grants-empty, .sheet.district .district-autonomy .grant-entry').first().textContent()) ?? '').length > 0, 'and its autonomy says where it stands');
    } finally {
      if (!off) await page.evaluate((n) => fetch(`/api/repos/${n}`, { method: 'PATCH', headers: { 'x-palimpsest': '1', 'content-type': 'application/json' }, body: JSON.stringify({ market: true }) }), offName);
    }

    // ------------------------------------------------------------ a job page: the master's guess, and an abstention
    const jobs = await api<Array<{ id: string; repo: string; status: string; title: string }>>(page, '/api/jobs');
    const [guessed, abstained] = jobs.filter((j) => j.status === 'proposed' || j.status === 'merged');
    const write = (jobId: string, repo: string, p: number | null, reason: string | null) => {
      const data = { key: `${kind}:${jobId}`, kind, repo, jobId, p, version: p === null ? null : 5, reason, at: new Date(Date.now() - 40 * 60_000).toISOString() };
      const id = record('master.predicted', { ...data, inputs: {} });
      openDb().prepare('INSERT OR IGNORE INTO predictions (id, key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?, ?)').run(id, data.key, kind, repo, data.at, JSON.stringify({ id, ...data }));
      emit('master.predicted', { prediction: { id, ...data } });
    };
    if (guessed && abstained) {
      write(guessed.id, guessed.repo, 0.88, null);
      write(abstained.id, abstained.repo, null, 'The master v5 is 9 days old.');
      await go(page, `#/jobs/${guessed.id}`);
      const sec = page.locator('.sheet.jobpage .job-school');
      check(await within(page, 8000, async () => /^The master guessed you would accept it: 0\.88, from v5, written down \d+ [A-Z][a-z]+ at \d{1,2}:\d\d\.$/.test(((await sec.locator('.job-school-master').textContent()) ?? '').trim())), `a job page shows the master's guess (${((await sec.locator('.job-school-master').textContent().catch(() => '')) ?? '').trim()})`);
      check(((await sec.locator('.repos-sec-name').textContent()) ?? '') === 'What the school thinks', 'under What the school thinks');
      check((await sec.locator('a.job-school-link').getAttribute('href')) === '#/school/master', 'with a way to the master');
      await sec.evaluate((s) => {
        const body = s.closest('.sheet-body') as HTMLElement;
        body.scrollTop += s.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, 'job-school.png') });
      await go(page, `#/jobs/${abstained.id}`);
      check(await within(page, 8000, async () => ((await page.locator('.sheet.jobpage .job-school-master').textContent().catch(() => '')) ?? '').trim() === 'The master made no guess: the master v5 is 9 days old.'), `another shows the abstention's reason (${((await page.locator('.sheet.jobpage .job-school-master').textContent().catch(() => '')) ?? '').trim()})`);
    } else check(false, 'the economy holds two jobs to guess on');
    check(errors2.length === 0, `the second window has no console errors${errors2.length ? `: ${errors2.join(' | ')}` : ''}`);
    await go(page, '#/');
    await within(page, 4000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'city');
    return 1;
  } finally {
    if (!second.isClosed()) await second.close();
    if (before) await page.setViewportSize(before);
  }
}

// ---------------------------------------------------------------- the school's settings and its spend (Phase 4 Task 32)

/**
 * Settings' School section and the treasury's school rows, on the economy.
 * Every switch is flipped and flipped back, each time checked against the
 * engine's settings; "25:00" is refused in place in the engine's words and
 * nothing is kept; Train now is held on battery (the gate's pmset probe is
 * answered "Battery Power" by a runner put in front of the sample's), then
 * on AC it opens the window "until h:mm" with Stop; the base model is made
 * not ready and Download answers 202 and then reads Ready, through a stand-in
 * installed at the engine (`setBaseDownloader`), so nothing is downloaded;
 * the treasury lists the school's calls and its training from the credits
 * rows, and how long it trained this week. No bundle carries a placeholder.
 *
 * Saves settings-school.png, settings-school-base.png and treasury-school.png
 * at 1600 x 1000. Answers the number of refusals it provoked (each a 400 in
 * the console), for the caller to excuse.
 */
export async function schoolSettingsChecks(page: Page, check: Check, shots: string, dist: string): Promise<number> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const { readdirSync, readFileSync } = await import('node:fs');
  const { getSettings, patchSettings } = await import('../engine/settings.js');
  const { getRunner, setRunner } = await import('../engine/exec.js');
  const { resetGateCache } = await import('../engine/school/gate.js');
  const { setBaseDownloader } = await import('../engine/school/api.js');
  const runner = getRunner();
  let refusals = 0;
  const wasSchool = getSettings().school;
  try {
    // ------------------------------------------------------------ no placeholder in any bundle
    const assets = join(dist, 'assets');
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
    const placeholder = js.filter((f) => /arrives? with (Phase 4|the school)/i.test(readFileSync(join(assets, f), 'utf8')));
    check(js.length > 0 && placeholder.length === 0, `no bundle says the school arrives later (${placeholder.join(', ') || `${js.length} read`})`);

    await go(page, '#/settings');
    const sec = page.locator('.sheet.settings .set-sec.school');
    check(await within(page, 8000, async () => (await sec.locator('.slide.school-on').isVisible()) && ((await sec.locator('.school-gate').textContent()) ?? '').length > 0), 'Settings has its School section, read from the engine');
    const labels = (await sec.locator('.set-label-name').allTextContents()).map((s) => s.trim());
    const want = ['Run the school', 'Train between', 'Only after the Mac has been idle for', 'Train in Low Power mode on power', 'Train now', 'The school may spend on Claude each day', 'Design agents with', 'Count my own commits as verified work', 'Read your taste from Understudy', 'Base model for coders', 'Trainer'];
    check(want.every((w, i) => labels[i] === w), `its rows in order (${labels.join(' | ')})`);
    check(((await sec.locator('.school-on-row .set-text, .set-row.school-on .set-text').first().textContent()) ?? '').trim() === 'Off by default. While on, the city trains its nets at night, races agents on arenas you build, and trains coders on this Mac.', 'the switch says what the school does');
    check(((await sec.locator('.school-credits-of').textContent()) ?? '').trim() === `${getSettings().school.claudeCreditsPerDay} credits, ${Math.round(getSettings().school.claudeCreditsPerDay * 0.1 * 10) / 10}% of a window`, `the daily Claude credits read against a window (${await sec.locator('.school-credits-of').textContent()})`);
    check((await sec.locator('.set-note', { hasText: "It takes one of the city's Claude slots and waits while you are using Claude." }).count()) === 1, 'and say they take a Claude slot and wait for him');
    check((await sec.locator('.set-text', { hasText: 'Commits that touched source, lasted 30 days with no revert or fix, and pass their tests. This goes beyond changes the guild inspected.' }).count()) === 1, 'his commits say what counts');
    check((await sec.locator('.set-text', { hasText: 'Read only, on this Mac. Your taste statements are also added to the bar every UI change in the market is judged against.' }).count()) === 1, 'Understudy says it is read only');
    check(/^Training (waits|may run): /.test(((await sec.locator('.school-gate').textContent()) ?? '').trim()), `the heavy gate's line (${((await sec.locator('.school-gate').textContent()) ?? '').trim()})`);
    check(((await sec.locator('.school-trainer').textContent()) ?? '').trim().length > 0, `the trainer's line (${((await sec.locator('.school-trainer').textContent()) ?? '').trim()})`);
    const privacy = ((await page.locator('.sheet.settings .settings-privacy .set-row[data-privacy="Training"] .set-text').textContent()) ?? '').trim();
    check(privacy === 'Training happens on this Mac and nothing it learns leaves it. Arenas are built only from repos whose market you turned on, and only when you click. The one download is the base model, when you click Download.', `Privacy says where training happens (${privacy.slice(0, 60)})`);
    const mlxText = async () => ((await page.locator('.sheet.settings .prov[data-provider="mlx"]').textContent()) ?? '').trim();
    check(await within(page, 8000, async () => /One graduate of the school runs on it, on this Mac\./.test(await mlxText()) && /Ada Quarry/.test(await mlxText())), `MLX says the graduate runs on it, by name (${(await mlxText()).slice(0, 120)})`);
    check(!/arrive/i.test(await mlxText()), 'and never that it arrives later');

    // ------------------------------------------------------------ each switch patches its own field, and back
    for (const [cls, key] of [['school-on', 'enabled'], ['school-lowpower', 'allowLowPower'], ['school-commits', 'commitsAsWork'], ['school-understudy', 'understudy']] as const) {
      const sw = sec.locator(`.slide.${cls}`);
      const was = getSettings().school[key];
      await sw.click();
      const flipped = await within(page, 6000, async () => getSettings().school[key] === !was && (await sw.getAttribute('aria-checked')) === String(!was));
      await sw.click();
      const back = await within(page, 6000, async () => getSettings().school[key] === was && (await sw.getAttribute('aria-checked')) === String(was));
      check(flipped && back, `${key} patches its own field, and back (${was} to ${!was} to ${was})`);
    }
    // The fields: the window, the idle wait, the credits and the designer, each sent and read back.
    const typeIn = async (sel: string, value: string) => {
      const f = sec.locator(sel);
      await f.fill(value);
      await f.press('Enter');
    };
    await typeIn('.school-from', '0:30');
    check(await within(page, 6000, async () => getSettings().school.window.from === '00:30'), `the window's start patches window.from (${getSettings().school.window.from})`);
    await typeIn('.school-idle', '20');
    check(await within(page, 6000, async () => getSettings().school.idleMinutes === 20), 'the idle wait patches idleMinutes');
    await typeIn('.school-credits', '25');
    check(await within(page, 6000, async () => getSettings().school.claudeCreditsPerDay === 25 && ((await sec.locator('.school-credits-of').textContent()) ?? '').trim() === '25 credits, 2.5% of a window'), `the daily credits patch claudeCreditsPerDay (${await sec.locator('.school-credits-of').textContent()})`);
    await typeIn('.school-designer', 'ollama:qwen2.5-coder:14b');
    check(await within(page, 6000, async () => getSettings().school.designer === 'ollama:qwen2.5-coder:14b'), 'the designer patches designer');

    // ------------------------------------------------------------ 25:00 refused in place, in the engine's words
    await typeIn('.school-to', '25:00');
    refusals++;
    const winWhy = sec.locator('#school-window-why');
    check(await within(page, 6000, async () => ((await winWhy.textContent()) ?? '').trim() === '25:00 is not a time of day: say it as hours and minutes, 00:00 to 23:59.' && (await winWhy.isVisible())), `25:00 is refused under the window in the engine's words (${((await winWhy.textContent()) ?? '').trim()})`);
    check((await sec.locator('.school-to').getAttribute('aria-invalid')) === 'true' && (await sec.locator('.school-to').getAttribute('aria-describedby')) === 'school-window-why', 'the field is marked and names the refusal');
    check(getSettings().school.window.to === wasSchool.window.to, `nothing refused is kept (${getSettings().school.window.to})`);
    await typeIn('.school-idle', '2');
    refusals++;
    check(await within(page, 6000, async () => ((await sec.locator('#school-idle-why').textContent()) ?? '').trim() === 'The idle wait is a whole number of minutes, 5 to 120.'), `an idle wait of 2 is refused in place (${((await sec.locator('#school-idle-why').textContent()) ?? '').trim()})`);
    await typeIn('.school-designer', 'gpt-4');
    refusals++;
    check(await within(page, 6000, async () => ((await sec.locator('#school-designer-why').textContent()) ?? '').trim() === 'Name a model as ollama:<name> or claude:<name>.'), 'a malformed designer is refused in place');
    await sec.locator('.school-to').scrollIntoViewIfNeeded();
    await page.locator('.sheet.settings .sheet-body').evaluate((b) => {
      const s = b.querySelector('.set-sec.school') as HTMLElement;
      b.scrollTop += s.getBoundingClientRect().top - b.getBoundingClientRect().top - 24;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'settings-school.png') });
    // Escape puts each back as saved, and its refusal goes.
    for (const sel of ['.school-to', '.school-idle', '.school-designer']) {
      await sec.locator(sel).focus();
      await page.keyboard.press('Escape');
    }
    check(await within(page, 4000, async () => (await sec.locator('.set-error:visible').count()) === 0), 'Escape puts the fields back and their refusals go');

    // ------------------------------------------------------------ Train now: held on battery, then open until h:mm, then Stop
    setRunner(async (cmd, args, o) => (cmd === '/usr/bin/pmset' && args.join(' ') === '-g batt' ? { stdout: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; 4:10 remaining present: true\n", stderr: '', code: 0 } : runner(cmd, args, o)));
    resetGateCache();
    await go(page, '#/');
    await page.waitForTimeout(300);
    await go(page, '#/settings');
    const now = sec.locator('.school-train-now');
    check(await within(page, 8000, async () => (await now.getAttribute('aria-disabled')) === 'true' && ((await sec.locator('.school-held').textContent()) ?? '').trim() === 'Train now waits: on battery.'), `on battery Train now is held with the reason (${((await sec.locator('.school-held').textContent()) ?? '').trim()})`);
    check((await now.getAttribute('aria-describedby')) === 'school-held', 'the held button names its reason');
    check(await keyFocus(page, '.sheet.settings .school-train-now'), 'and still takes the keyboard’s focus, visibly');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    check(getSettings().school.trainNowUntil === null, 'Enter on it asks the engine nothing');
    setRunner(runner);
    resetGateCache();
    await go(page, '#/');
    await page.waitForTimeout(300);
    await go(page, '#/settings');
    check(await within(page, 8000, async () => (await now.getAttribute('aria-disabled')) === null && (await now.isVisible())), 'on power Train now is offered');
    await now.click();
    const until = sec.locator('.school-until');
    check(await within(page, 8000, async () => /^until \d{1,2}:\d\d$/.test(((await until.textContent()) ?? '').trim()) && (await until.isVisible())), `Train now opens the window, until h:mm (${((await until.textContent()) ?? '').trim()})`);
    {
      const u = getSettings().school.trainNowUntil;
      const d = u ? new Date(u) : null;
      check(!!d && ((await until.textContent()) ?? '').trim() === `until ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 'the time is the engine’s, three hours on');
    }
    {
      const g = (await api<SchoolView>(page, '/api/school')).gate.heavy;
      check(g.trainNowUntil === getSettings().school.trainNowUntil, `the gate reads Train now as live (${g.trainNowUntil}; the line: ${((await sec.locator('.school-gate').textContent()) ?? '').trim()})`);
    }
    await sec.locator('.school-stop').click();
    check(await within(page, 8000, async () => getSettings().school.trainNowUntil === null && (await now.isVisible()) && !(await until.isVisible())), 'Stop ends it, and Train now is offered again');

    // ------------------------------------------------------------ the base model: Download answers 202, then Ready
    let landed = false;
    setBaseDownloader(async () => {
      await new Promise((r) => setTimeout(r, 2500));
      patchSettings({ school: { ...getSettings().school, baseModelReady: true } });
      landed = true;
      return { status: 'ready', reason: null };
    });
    patchSettings({ school: { ...getSettings().school, baseModelReady: false } });
    await go(page, '#/');
    await page.waitForTimeout(300);
    await go(page, '#/settings');
    const dl = sec.locator('.school-download');
    check(await within(page, 8000, async () => ((await dl.textContent()) ?? '').trim() === 'Download, about 4.3 GB' && (await dl.isVisible())), `with the base model not there, Download says its size (${((await dl.textContent()) ?? '').trim()})`);
    check(((await sec.locator('.school-base-state').textContent()) ?? '').includes('is not downloaded') && (await sec.locator('.set-note', { hasText: 'Your Hugging Face login is not sent.' }).count()) === 1, 'it says the base is not downloaded, and that his login is not sent');
    await sec.locator('.school-base-row').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'settings-school-base.png') });
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/school/download-base') && r.request().method() === 'POST', { timeout: 6000 });
    await dl.click();
    const r = await answer.catch(() => null);
    check(r?.status() === 202, `Download answers 202 (${r?.status() ?? 'no answer'})`);
    check(await within(page, 4000, async () => ((await dl.textContent()) ?? '').trim() === 'Downloading' && (await dl.getAttribute('aria-disabled')) === 'true'), 'it reads Downloading while it comes down');
    check(await within(page, 10_000, async () => landed && (await sec.locator('.school-ready').isVisible()) && !(await dl.isVisible())), 'and then Ready, without a reload');
    check(((await sec.locator('.school-base-state').textContent()) ?? '').includes('is downloaded'), 'the line says it is downloaded');

    // ------------------------------------------------------------ the treasury: the school's calls, its training, its week
    await go(page, '#/treasury');
    const t = await api<{ spend: { week: { city: Array<{ kind: string; credits: number; entries: number }> } }; school: { enabled: boolean; trainedSeconds: number } }>(page, '/api/treasury');
    const tsheet = page.locator('.sheet.treasury');
    for (const kind of ['school', 'train']) {
      const k = t.spend.week.city.find((x) => x.kind === kind);
      const row = tsheet.locator(`.spend-firms .spend-row[data-kind="${kind}"]`);
      check(!!k && k.entries > 0 && (await within(page, 8000, async () => (await row.count()) === 1)), `the treasury lists the ${kind} spend from its credits rows (${k ? `${k.credits} credits, ${k.entries} entries` : 'none'})`);
      if (k) check(((await row.locator('.c-n').textContent()) ?? '').trim() === String(k.entries), `with its entries (${await row.locator('.c-n').textContent()})`);
    }
    {
      const row = tsheet.locator('.spend-firms .spend-row[data-kind="school"]');
      await row.locator('.spend-open').click();
      const entries = row.locator('xpath=following-sibling::*[1]').locator('.entry');
      check(await within(page, 6000, async () => (await entries.count()) > 0 && /School call/.test((await entries.first().textContent()) ?? '')), `the school's row opens to its own entries (${await entries.count()})`);
      await row.locator('.spend-open').click();
    }
    const line = ((await tsheet.locator('.now-row[data-now="school"] .now-val').textContent()) ?? '').trim();
    const h = Math.floor(t.school.trainedSeconds / 3600);
    const m = Math.floor((t.school.trainedSeconds % 3600) / 60);
    check(t.school.trainedSeconds > 0 && line === `Trained ${h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`} on power this week.`, `the treasury says how long the school trained (${line})`);
    await tsheet.locator('.treasury-now').evaluate((s) => {
      const body = s.closest('.sheet-body') as HTMLElement;
      body.scrollTop += s.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'treasury-school.png') });
  } finally {
    setRunner(runner);
    resetGateCache();
    setBaseDownloader(null);
    patchSettings({ school: { ...getSettings().school, ...wasSchool, trainNowUntil: null, baseModelReady: true } });
    // The stand-in wrote nothing to disk: the sample's base folder is as the economy left it.
    if (before) await page.setViewportSize(before);
  }
  await go(page, '#/');
  return refusals;
}

// ---------------------------------------------------------------- lineage on the agent page (Phase 4 Task 33)

/**
 * A school agent's own page, on the economy. Ada Quarry, the graduate of the
 * voyage Quickset commissioned (hired by Ashlar & Vane, since Quickset's
 * quarter is full), shows its base model, its adapter, the examples it was
 * taught on and the arena of its sealed race, and its sealed score against
 * its base with the difference and interval. A bred specialist, written for
 * the check as voyages.ts and the roster would leave one (a finished voyage
 * whose generation 2 champion was bred from two seeded local agents, hired
 * through `hireSeed` with no event, so no tower rises in the city) and taken
 * out again after, links its two parents, names its voyage, generation and
 * commissioner, and its score against each seeded local agent. A seeded
 * agent's page is unchanged.
 *
 * Saves agent-graduate.png and agent-bred.png at 1600 x 1000.
 */
export async function lineageChecks(page: Page, check: Check, shots: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const { openDb } = await import('../engine/db.js');
  const { hireSeed } = await import('../engine/market/firms.js');
  const { bredId, schoolRoster } = await import('../engine/school/roster.js');
  const errors: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') errors.push(m.text());
  };
  const onError = (e: Error) => errors.push(String(e));
  page.on('console', onConsole);
  page.on('pageerror', onError);
  const bredVoyage = 'v-ui-bred-1';
  let bredAgent: string | null = null;
  try {
    // ------------------------------------------------------------ Ada Quarry, the graduate
    const view = await api<SchoolView>(page, '/api/school');
    const g = view.graduates.find((x) => x.id === 'grad-qwen25c7-1');
    check(!!g && g.agentId === 'grad-qwen25c7-1', `the economy's graduate is on the roster (${g?.agentId ?? 'none'})`);
    const firms = await api<Array<{ id: string; name: string; agents: Array<{ id: string; name: string; model: string; lineage: { origin: string } }> }>>(page, '/api/firms');
    const holder = firms.find((f) => f.agents.some((a) => a.id === 'grad-qwen25c7-1'));
    check(holder?.id === 'ashlar-vane', `Ashlar & Vane hired it (${holder?.name ?? 'nobody'})`);
    const commissioned = view.voyages.find((v) => v.commissionedBy === 'quickset');
    check(!!commissioned, 'Quickset commissioned the voyage');
    await go(page, '#/agents/grad-qwen25c7-1');
    const sheet = page.locator('.sheet.agentpage');
    const sec = sheet.locator('.agent-school[data-school="graduate"]');
    check(await within(page, 8000, async () => (await sheet.locator('.sheet-title').textContent()) === 'Ada Quarry' && (await sec.count()) === 1), 'Ada Quarry’s page has where it came from');
    if (g) {
      const val = async (f: string) => ((await sec.locator(`.design-row[data-field="${f}"] .design-val`).textContent()) ?? '').trim();
      check((await val('base')) === g.base, `its base model (${await val('base')})`);
      check((await val('adapter')) === g.loraId, `its adapter (${await val('adapter')})`);
      check((await val('examples')) === String(g.examples), `the examples it was taught on (${await val('examples')})`);
      const gloss = ((await sec.locator('.design-row[data-field="examples"] .design-gloss').textContent()) ?? '').trim();
      check(gloss === 'Taught on 112 verified changes, and raced sealed on the planted bugs arena on tidewater/harbor-ledger.', `the arena of its sealed race (${gloss})`);
      const diff = ((await sec.locator('.agent-school-diff').textContent()) ?? '').trim();
      check(diff === 'Beat its base by +0.14, 95% interval +0.06 to +0.22 on the sealed race, so it graduated.', `its difference against its base with the interval (${diff})`);
      const nums = (await sec.locator('.master-num').allTextContents()).map((s) => s.trim());
      check(nums.join(' ') === '0.61 0.47', `its sealed score beside its base's (${nums.join(' ')})`);
      check(/Score 0\.61, 95% interval 0\.52 to 0\.70, on 15 sealed tasks/.test((await sec.locator('.master-note').first().textContent()) ?? ''), 'each with its interval and n');
      check((await sec.locator('a.agent-school-link').getAttribute('href')) === '#/school/graduates/grad-qwen25c7-1', 'and a way to its record in the school');
    }
    await toTop(page, '.sheet.agentpage .agent-lineage');
    await page.screenshot({ path: join(shots, 'agent-graduate.png') });

    // ------------------------------------------------------------ a seeded agent's page is unchanged
    const seeded = firms.flatMap((f) => f.agents).find((a) => a.lineage.origin === 'seeded');
    if (seeded) {
      await go(page, `#/agents/${seeded.id}`);
      check(await within(page, 8000, async () => (await sheet.locator('.sheet-title').textContent()) === seeded.name && (await sheet.locator('.agent-lineage').count()) === 1), `${seeded.name}'s page opens`);
      check((await sheet.locator('.agent-school').count()) === 0, 'a seeded agent’s page shows no school section');
    }

    // ------------------------------------------------------------ a bred specialist, bred from two seeded local agents
    const locals = firms.flatMap((f) => f.agents).filter((a) => a.lineage.origin === 'seeded' && a.model.startsWith('ollama:')).slice(0, 2);
    const arena = view.arenas.find((a) => a.kind === 'planted') ?? view.arenas[0];
    const now = Date.now();
    const genome = 'ui-harbour-2-1';
    const v: VoyageView = {
      id: bredVoyage,
      arena: arena.id,
      repo: arena.repo,
      status: 'done',
      generation: 2,
      of: 2,
      runs: { done: 240, of: 240 },
      commissionedBy: 'quickset',
      scores: [
        ...locals.map((a) => ({ genome: a.id, name: a.name, generation: 1, mean: 0.41, lo: 0.32, hi: 0.5, parents: [] as string[] })),
        { genome, name: 'Harbour 2.1', generation: 2, mean: 0.62, lo: 0.53, hi: 0.71, parents: locals.map((a) => a.id) },
      ],
      promoted: [{ child: genome, parent: locals[0].id, diff: 0.21, lo: 0.12, hi: 0.3 }],
      sealed: { value: 0.58, lo: 0.46, hi: 0.7, n: 15 },
      credits: 14.2,
      startedAt: new Date(now - 2 * 86_400_000).toISOString(),
      endedAt: new Date(now - 86_400_000).toISOString(),
      reason: null,
      pausedAt: null,
      champion: { genome, name: 'Harbour 2.1', model: locals[0].model, generation: 2, parents: locals.map((a) => a.id), body: { id: genome, name: 'Harbour 2.1', model: locals[0].model, instructions: 'Read the failing test first; change the least code that makes it pass.\n', tools: ['read', 'edit', 'run'], workflow: { shape: 'single' }, memory: { examples: 2 } } },
      vsLocal: locals.map((a, i) => ({ agent: a.id, name: a.name, diff: 0.19 - 0.03 * i, lo: 0.11 - 0.03 * i, hi: 0.27 - 0.03 * i })),
      claim: true,
      notCompared: 'Claude agents are never raced.',
      sealedUsesSpent: 1,
    };
    openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(v.id, JSON.stringify(v));
    const seed = schoolRoster().find((s) => s.id === bredId(genome));
    const room = firms.map((f) => f.id).find((id) => id !== 'lodestar' && seed && !!hireSeed(id, seed));
    bredAgent = seed && room ? seed.id : null;
    check(locals.length === 2 && !!bredAgent, `a firm with room hires the bred champion (${room ?? 'none'})`);
    if (bredAgent) {
      await go(page, `#/agents/${bredAgent}`);
      const bred = sheet.locator('.agent-school[data-school="bred"]');
      check(await within(page, 8000, async () => (await sheet.locator('.sheet-title').textContent()) === 'Harbour 2.1' && (await bred.count()) === 1), 'the bred specialist’s page has where it came from');
      const links = bred.locator('.agent-school-parents a.agent-school-parent');
      const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      check(hrefs.length === 2 && locals.every((a) => hrefs.includes(`#/agents/${a.id}`)), `it links its two parents (${hrefs.join(', ')})`);
      check(((await bred.locator('.agent-school-parents').textContent()) ?? '').trim() === `Bred from ${locals[0].name} and ${locals[1].name}.`, `in words (${((await bred.locator('.agent-school-parents').textContent()) ?? '').trim()})`);
      const origin = ((await bred.locator('.agent-school-origin').textContent()) ?? '').trim();
      check(origin === `Bred in generation 2 of a voyage on the planted bugs arena on ${arena.repo}, commissioned by Quickset.`, `its voyage, generation and commissioner (${origin})`);
      check((await bred.locator('.master-num').first().textContent())?.trim() === '0.58' && /Score 0\.58, 95% interval 0\.46 to 0\.70, on 15 sealed tasks/.test((await bred.locator('.master-note').first().textContent()) ?? ''), 'its sealed score with interval and n');
      const rows = bred.locator('.vslocal-row');
      check((await rows.count()) === 2 && /^\+0\.19$/.test(((await rows.first().locator('.net-score').textContent()) ?? '').trim()) && ((await rows.first().locator('.net-ci').textContent()) ?? '').trim() === '+0.11 to +0.27', `against each seeded local agent, with the interval (${await rows.count()} rows)`);
      check((await rows.first().locator('a').getAttribute('href')) === `#/agents/${locals[0].id}`, 'each local agent a link');
      check((await bred.locator('a.agent-school-link').getAttribute('href')) === `#/school/voyages/${bredVoyage}`, 'and a way to its voyage');
      check((await api<{ school: { voyage: VoyageView | null } }>(page, `/api/agents/${bredAgent}`)).school.voyage?.champion?.body === undefined, 'its voyage is served without the genome’s body');
      await toTop(page, '.sheet.agentpage .agent-lineage');
      await page.screenshot({ path: join(shots, 'agent-bred.png') });
    }
    check(errors.length === 0, `the agent pages have no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onError);
    // The fixture goes: the bred agent and its voyage, so nothing later sees a tower or a voyage the economy never made.
    if (bredAgent) openDb().prepare('DELETE FROM agents WHERE id = ?').run(bredAgent);
    openDb().prepare('DELETE FROM voyages WHERE id = ?').run(bredVoyage);
    await go(page, '#/');
    if (before) await page.setViewportSize(before);
  }
}
