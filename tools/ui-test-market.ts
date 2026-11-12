/**
 * The market's switches on the Repos screen, the district page and the
 * provider settings (Task 40), run by tools/ui-test.ts on its own engine
 * (port UI_PORT, default 4779, a temp home) after the treasury's checks, on the sample
 * economy. gh, git and `ollama list` go to the sample stand-in; the API key
 * goes to the sample keychain in this process's memory (installKeychainStandIn),
 * so `security` never runs and no keychain on this Mac is touched; the Codex
 * and Gemini readings come from the sample home's own fixtures.
 *
 * Saves repos.png, district.png, settings-providers.png, settings-caps.png and
 * settings-privacy.png (as market-*.png) at 1600 x 1000 for the quality rounds.
 */
import { join } from 'node:path';

import type { Page, Response } from 'playwright';

import { PUSH_MODE_NEEDS } from '../shared/market-rules.js';
import type { Job, ProviderUsage, Repo } from '../shared/types.js';

type Check = (ok: boolean, what: string) => void;

const SIZE = { width: 1600, height: 1000 };
/** A made-up key in the shape the engine accepts. It exists only in this test and the stand-in's memory. */
const FAKE_KEY = 'sk-ant-api03-UITESTONLY-qz7Jm2Lw9Xc4Rv8Tn';

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

/**
 * A harness job proposed and waiting on him. The economy leaves one on
 * assay-kit, but the job board's checks accept it earlier in a full run: then
 * one is proposed (as an analysis would) on a sample repo that has none.
 */
async function proposedHarness(page: Page): Promise<Job | undefined> {
  const waiting = (await api<Job[]>(page, '/api/jobs?status=proposed')).find((j) => j.source === 'harness');
  if (waiting) return waiting;
  const { proposeHarnessJob, listJobs } = await import('../engine/market/jobs.js');
  const { getRepo } = await import('../engine/repos.js');
  for (const name of ['lantern/assay-kit', 'kestrel/fieldnotes', 'alder/blank-slate']) {
    const r = getRepo(name);
    if (!r?.connected || listJobs({ repo: name, source: 'harness' }).some((j) => j.status !== 'merged')) continue;
    const j = proposeHarnessJob(r);
    if (j.status === 'proposed') return j;
  }
  return undefined;
}

const repoOf = async (page: Page, fullName: string): Promise<Repo | undefined> => (await api<Repo[]>(page, '/api/repos')).find((r) => r.fullName === fullName);
const rowSel = (fullName: string): string => `.sheet.repos .repo-row[data-repo="${fullName}"]`;

/**
 * Installs the sample keychain in front of the UI test engine's spawner. Its
 * home has no sample marker, so the engine never enters sample mode and keeps
 * the real spawner: without this the API key route's `security -i` would
 * start. The runner side is already the sample stand-in (sampleGh answers
 * `security`).
 */
export async function installKeychainStandIn(): Promise<void> {
  const { getSpawner, setSpawner } = await import('../engine/exec.js');
  const { sampleSpawner, withSampleKeychain } = await import('../engine/sample.js');
  const next = withSampleKeychain(getSpawner());
  // Keep awake is switched on and off here: caffeinate is never started either.
  setSpawner((cmd, args, opts) => (/(^|\/)caffeinate$/.test(cmd) ? sampleSpawner(cmd, args, opts) : next(cmd, args, opts)));
}

export async function marketChecks(page: Page, check: Check, shots: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize(SIZE);
  const { haltRepo } = await import('../engine/market/runs.js');
  const { patchSettings, getSettings } = await import('../engine/settings.js');
  const { sampleKeychain } = await import('../engine/sample.js');
  const savedSettings = getSettings();
  try {
    await repoChecks(page, check, shots, haltRepo);
    await districtChecks(page, check, shots);
    await settingsChecks(page, check, shots, sampleKeychain.isSet);
  } finally {
    patchSettings({ claudeConcurrency: savedSettings.claudeConcurrency, keepAwake: savedSettings.keepAwake, hardStopPct: savedSettings.hardStopPct, bidWindowSec: savedSettings.bidWindowSec });
    sampleKeychain.reset();
    if (before) await page.setViewportSize(before);
  }
}

// ---------------------------------------------------------------- the Repos screen

async function repoChecks(
  page: Page,
  check: Check,
  shots: string,
  haltRepo: (fullName: string, reason: string) => unknown,
): Promise<void> {
  const harbour = 'tidewater/harbor-ledger';
  const assay = 'lantern/assay-kit';
  const quarry = 'ferro/quarry';
  // The harbour repo carries every check (its tree is a Vite app); assay-kit has tests and no build.
  check((await repoOf(page, assay))?.checks?.build === null && !!(await repoOf(page, assay))?.checks?.test, 'assay-kit has a test command and no build command');
  haltRepo(quarry, 'Three failed inspections in a row');

  await go(page, '#/repos');
  const shown = await within(page, 8000, async () => (await page.locator(`${rowSel(harbour)} [role="switch"].market`).count()) === 1);
  check(shown, 'every connected repo carries a Market switch');
  if (!shown) return;
  for (const r of await api<Repo[]>(page, '/api/repos')) {
    if (!r.connected) continue;
    const sw = page.locator(`${rowSel(r.fullName)} [role="switch"].market`);
    if ((await sw.count()) === 1) check((await sw.getAttribute('aria-checked')) === String(r.market), `${r.fullName}'s Market switch shows what is stored (${r.market ? 'on' : 'off'})`);
  }
  const off = (await api<Repo[]>(page, '/api/repos')).find((r) => r.connected && !r.market && r.fullName !== harbour);
  check(!!off, 'a connected repo starts with the market off');

  // The market switch patches `market` and nothing else.
  const patches: string[] = [];
  const onReq = (r: { method(): string; url(): string; postData(): string | null }) => {
    if (r.method() === 'PATCH' && /\/api\/repos\//.test(r.url())) patches.push(r.postData() ?? '');
  };
  page.on('request', onReq);
  const target = off?.fullName ?? harbour;
  await page.locator(`${rowSel(target)} [role="switch"].market`).click();
  check(await within(page, 4000, async () => (await repoOf(page, target))?.market === true), `the Market switch turns the market on for ${target}`);
  page.off('request', onReq);
  check(patches.length === 1 && JSON.stringify(JSON.parse(patches[0] || '{}')) === '{"market":true}', `as one PATCH of market alone (${patches.join(' | ')})`);
  check((await page.locator(`${rowSel(target)} [role="switch"].market`).getAttribute('aria-checked')) === 'true', 'and the switch shows on');
  await page.locator(`${rowSel(target)} [role="switch"].market`).click();
  check(await within(page, 4000, async () => (await repoOf(page, target))?.market === false), 'and off again');

  // Push mode beside it: the note says what it does; without a build command the switch is disabled and says why.
  check(((await page.locator(`${rowSel(harbour)} .repo-push .repo-push-note`).textContent()) ?? '').trim() === 'merges to main after inspection; needs a test and a build command', 'the push note says what push mode does and needs');
  const assayPush = page.locator(`${rowSel(assay)} [role="switch"].push`);
  check((await assayPush.getAttribute('aria-disabled')) === 'true', 'push mode is disabled on the repo without a build command');
  const why = ((await page.locator(`${rowSel(assay)} .repo-push-why`).textContent()) ?? '').trim();
  check(why === PUSH_MODE_NEEDS, `and says why beside it (${why})`);
  const describedBy = (await assayPush.getAttribute('aria-describedby')) ?? '';
  check(describedBy !== '' && (await page.locator(`[id="${describedBy}"]`).textContent())?.trim() === PUSH_MODE_NEEDS, "the reason is the switch's description");
  await assayPush.click({ force: true });
  await page.waitForTimeout(300);
  check((await assayPush.getAttribute('aria-checked')) === 'false' && (await repoOf(page, assay))?.pushMode === false, 'clicking the disabled switch changes nothing');
  check((await page.locator(`${rowSel(harbour)} [role="switch"].push`).getAttribute('aria-disabled')) !== 'true', 'push mode stays open where both commands exist');

  // A halted repo says so, with Resume.
  const halt = page.locator(`${rowSel(quarry)} .repo-halt`);
  check(await within(page, 5000, async () => (await halt.count()) === 1), 'a halted repo shows a halted line');
  check(/halted/i.test((await halt.textContent()) ?? '') && /Three failed inspections/.test((await halt.textContent()) ?? ''), `with its reason (${((await halt.textContent()) ?? '').trim()})`);
  const resume = halt.locator('button.repo-resume');
  check((await resume.count()) === 1, 'and a Resume button');

  // A harness proposal waiting on him (the job board's checks may have accepted assay-kit's): a line links to its job.
  const harness = await proposedHarness(page);
  check(!!harness, `a harness job waits proposed (${harness?.repo ?? 'none'})`);
  const harnessRepo = harness?.repo ?? assay;
  await within(page, 4000, async () => (await page.locator(`${rowSel(harnessRepo)} .repo-harness a`).count()) === 1);
  const harnessLine = page.locator(`${rowSel(harnessRepo)} .repo-harness a`);
  check((await harnessLine.count()) === 1 && (await harnessLine.getAttribute('href')) === `#/jobs/${harness?.id}`, `a "harness proposed" line links to the job (${await harnessLine.getAttribute('href').catch(() => null)})`);
  check(/harness proposed/i.test((await page.locator(`${rowSel(harnessRepo)} .repo-harness`).textContent()) ?? ''), 'and says a harness is proposed');

  // The row name opens the district page.
  const name = page.locator(`${rowSel(harbour)} a.repo-name`);
  check((await name.getAttribute('href')) === '#/repos/tidewater/harbor-ledger', `the row name links to the district page (${await name.getAttribute('href')})`);
  await page.locator(`${rowSel(assay)}`).scrollIntoViewIfNeeded();
  await page.locator('.sheet.repos .sheet-body').evaluate((b) => {
    b.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'market-repos.png') });

  await resume.click();
  check(await within(page, 5000, async () => (await repoOf(page, quarry))?.halted === null), 'Resume clears the halt');
  check(await within(page, 4000, async () => (await halt.count()) === 0), 'and the halted line goes');

  await name.click();
  check(await within(page, 5000, async () => (await page.evaluate(() => document.body.dataset.route)) === 'repo'), 'clicking the name opens the district page');
}

// ---------------------------------------------------------------- the district page

async function districtChecks(page: Page, check: Check, shots: string): Promise<void> {
  const harbour = 'tidewater/harbor-ledger';
  await go(page, '#/repos/tidewater/harbor-ledger');
  const sheet = page.locator('.sheet.district');
  const shown = await within(page, 6000, async () => (await sheet.locator('.check-row[data-check]').count()) === 6);
  check(shown, `the district page lists six checks (${await sheet.locator('.check-row[data-check]').count()})`);
  if (!shown) return;
  check(((await sheet.locator('.sheet-title').textContent()) ?? '').trim() === 'harbor-ledger', "titled with the repo's name");
  check((await page.locator('.runhead-link[data-route="repos"]').getAttribute('aria-current')) === 'page', 'the running head marks Repos');
  check((await sheet.locator('.detail-trail a').first().getAttribute('href')) === '#/repos', 'the trail leads back to Repos');
  for (const k of ['connect', 'market', 'push']) check((await sheet.locator(`.district-switches [role="switch"].${k}`).count()) === 1, `it carries the ${k} switch`);
  check((await sheet.locator('input.district-label').inputValue()) === 'palimpsest', 'and the label');
  const names = await sheet.locator('.check-row[data-check]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.check));
  check(names.join(',') === 'install,test,typecheck,lint,build,screenshot', `in order: ${names.join(', ')}`);
  const testRow = sheet.locator('.check-row[data-check="test"]');
  check(((await testRow.locator('.check-src').textContent()) ?? '').trim() === 'detected', `a detected command says so (${await testRow.locator('.check-src').textContent()})`);

  // The network its jobs may reach, from its ecosystems, read only.
  const hosts = await sheet.locator('.district-network .net-host').allTextContents();
  check(hosts.includes('registry.npmjs.org'), `the network names the npm registry (${hosts.join(', ')})`);
  check((await sheet.locator('.district-network input, .district-network button').count()) === 0, 'and offers nothing to change');
  check((await sheet.locator('.district-halt').count()) === 1 && /strike/i.test((await sheet.locator('.district-halt').textContent()) ?? ''), 'the halt state and strikes are shown');
  check((await sheet.locator('.district-strikes .strike').count()) === 3, 'three strike marks, as three halt the repo');
  check((await sheet.locator('.district-jobs .djob').count()) > 0, `the jobs on this repo are listed (${await sheet.locator('.district-jobs .djob').count()})`);
  check((await sheet.locator('.district-floors').count()) === 1, 'floors earned are shown');
  check(((await sheet.locator('.district-note').textContent()) ?? '').includes('Autonomy grants arrive with Phase 4.'), 'and the note on autonomy grants');
  await sheet.locator('.sheet-body').evaluate((b) => {
    b.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'market-district.png') });

  // Save a test command: Enter stores it, and the row says he set it.
  const cmd = 'npm test -- --run';
  const input = testRow.locator('input.check-cmd');
  await input.fill(cmd);
  await input.press('Enter');
  check(await within(page, 4000, async () => (await repoOf(page, harbour))?.checks?.test === cmd), 'a test command typed and Entered is stored');
  check(await within(page, 3000, async () => ((await testRow.locator('.check-src').textContent()) ?? '').trim() === 'set by you'), `and the row says set by you (${await testRow.locator('.check-src').textContent()})`);
  check(((await sheet.locator('.check-row[data-check="build"] .check-src').textContent()) ?? '').trim() === 'detected', 'the others still say detected');
  check(((await input.getAttribute('aria-describedby')) ?? '').split(' ').includes((await testRow.locator('.check-src').getAttribute('id')) ?? '-'), 'the input is described by where its command came from');

  // Emptying a command leaves nothing to call his: it reads none.
  const lint = sheet.locator('.check-row[data-check="lint"]');
  await lint.locator('input.check-cmd').fill('');
  await lint.locator('input.check-cmd').press('Enter');
  check(await within(page, 4000, async () => (await repoOf(page, harbour))?.checks?.lint === null), 'an emptied command is stored as none');
  check(await within(page, 3000, async () => ((await lint.locator('.check-src').textContent()) ?? '').trim() === 'none'), `and the row says none, not set by you (${await lint.locator('.check-src').textContent()})`);

  // Add a screenshot route.
  const routes = (await repoOf(page, harbour))?.checks?.shots ?? [];
  const add = sheet.locator('input.shot-add');
  await add.fill('/berths');
  await add.press('Enter');
  check(await within(page, 4000, async () => ((await repoOf(page, harbour))?.checks?.shots ?? []).includes('/berths')), 'a screenshot route added is stored');
  const after = (await repoOf(page, harbour))?.checks?.shots ?? [];
  check(after.length === routes.length + 1 && routes.every((r) => after.includes(r)), `beside the routes it had (${after.join(', ')})`);
  check(await within(page, 3000, async () => (await sheet.locator('.shot-route', { hasText: '/berths' }).count()) === 1), 'and listed');
  const bad = 'no slash';
  await add.fill(bad);
  await add.press('Enter');
  await page.waitForTimeout(300);
  check(!((await repoOf(page, harbour))?.checks?.shots ?? []).includes(bad) && /\//.test((await sheet.locator('.shot-why').textContent()) ?? ''), 'a route without a leading slash is refused, and says why');
  await sheet.locator('.shot-route', { hasText: '/berths' }).locator('button.shot-remove').click();
  check(await within(page, 4000, async () => !((await repoOf(page, harbour))?.checks?.shots ?? []).includes('/berths')), 'and a route can be removed');

  // A harness proposal is accepted from its district.
  const harness = await proposedHarness(page);
  const repoName = harness?.repo ?? 'lantern/assay-kit';
  await go(page, `#/repos/${repoName}`);
  const accept = sheet.locator('.district-jobs button.djob-accept');
  check(await within(page, 5000, async () => (await accept.count()) === 1), `the ${repoName} district offers Accept on its proposed harness job`);
  await accept.click();
  check(await within(page, 5000, async () => (await api<Job[]>(page, `/api/jobs?repo=${encodeURIComponent(repoName)}`)).find((j) => j.id === harness?.id)?.status === 'open'), 'Accept opens the harness job');
  check((await sheet.locator('.district-switches [role="switch"].push').getAttribute('aria-disabled')) === 'true', 'and push mode stays disabled there, with no build command');
}

// ---------------------------------------------------------------- Settings

async function settingsChecks(page: Page, check: Check, shots: string, keySet: () => boolean): Promise<void> {
  await go(page, '#/settings');
  const sheet = page.locator('.sheet.settings');
  const shown = await within(page, 6000, async () => (await sheet.locator('.prov').count()) === 6);
  check(shown, `Settings lists six providers (${await sheet.locator('.prov').count()})`);
  if (!shown) return;
  const order = await sheet.locator('.prov').evaluateAll((ps) => ps.map((p) => (p as HTMLElement).dataset.provider));
  check(order.join(',') === 'claude,anthropic-api,ollama,openai,gemini,mlx', `in the engine's order (${order.join(', ')})`);
  check((await sheet.locator('.prov[data-provider="claude"] .usage-five').count()) === 1 && (await sheet.locator('.prov[data-provider="claude"] .usage-week').count()) === 1, 'Claude carries the five-hour and weekly readings');

  const providers = await api<ProviderUsage[]>(page, '/api/providers');
  const ollama = sheet.locator('.prov[data-provider="ollama"]');
  check(await within(page, 4000, async () => /reachable at 127\.0\.0\.1:11434/i.test((await ollama.locator('.prov-state').textContent()) ?? '')), `Ollama is reachable at its host (${await ollama.locator('.prov-state').textContent()})`);
  check(!/not reachable/i.test((await ollama.locator('.prov-state').textContent()) ?? ''), 'not "not reachable"');
  const models = providers.find((p) => p.provider === 'ollama')?.models ?? [];
  check(models.length === 5 && (await ollama.locator('.prov-model').count()) === models.length, `its installed models are listed (${await ollama.locator('.prov-model').count()} of ${models.length})`);
  check((await ollama.locator('.prov-agents').count()) === 1 && /\w/.test((await ollama.locator('.prov-agents').textContent()) ?? ''), `and the agents that use them (${((await ollama.locator('.prov-agents').textContent()) ?? '').trim().slice(0, 80)})`);

  const codex = providers.find((p) => p.provider === 'openai');
  const openai = sheet.locator('.prov[data-provider="openai"]');
  const wins = await openai.locator('.prov-window').evaluateAll((ws) => ws.map((w) => (w.textContent ?? '').replace(/\s+/g, ' ').trim()));
  check(codex?.status === 'ready' && codex.windows.length === 2, `the sample fixture gives Codex two windows (${codex?.windows.map((w) => `${w.label} ${w.usedPct}%`).join(', ')})`);
  for (const w of codex?.windows ?? []) check(wins.some((t) => t.includes(`${Math.round(w.usedPct ?? -1)}%`)), `Settings shows the Codex ${w.label} window at ${w.usedPct}% (${wins.join(' | ')})`);
  check(/tokens/i.test((await openai.textContent()) ?? ''), 'and its tokens');
  check(/Gemini/.test((await sheet.locator('.prov[data-provider="gemini"]').textContent()) ?? '') && /tokens/i.test((await sheet.locator('.prov[data-provider="gemini"]').textContent()) ?? ''), 'Gemini shows its tokens');
  check(/arrives with the school/i.test((await sheet.locator('.prov[data-provider="mlx"]').textContent()) ?? ''), 'MLX arrives with the school');
  const apiProv = sheet.locator('.prov[data-provider="anthropic-api"]');
  check(((await apiProv.locator('.prov-line').textContent()) ?? '').trim() === "Spends your API key's dollars, not your Claude plan.", 'the API key says whose dollars it spends');
  check((await apiProv.locator('[role="switch"].apikey-enable').getAttribute('aria-checked')) === 'false', 'the Anthropic API is off by default');
  check((await apiProv.locator('input.apikey-daily').count()) === 1, 'with a daily dollar limit');
  await sheet.locator('.sheet-body').evaluate((b) => {
    b.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'market-settings-providers.png') });

  // The API key: posted, stored in the (stand-in) keychain, never shown again.
  const bodies: string[] = [];
  const pending: Array<Promise<void>> = [];
  const onResponse = (r: Response) => {
    if (!/\/api\//.test(r.url()) || /\/api\/events/.test(r.url())) return;
    pending.push(r.text().then((t) => void bodies.push(`${r.url()} ${t}`)).catch(() => {}));
  };
  page.on('response', onResponse);
  const keyInput = apiProv.locator('input.apikey-input');
  check((await keyInput.getAttribute('type')) === 'password' && (await keyInput.getAttribute('autocomplete')) === 'off', 'the key field is a password field that nothing fills');
  check(/No key/i.test((await apiProv.locator('.apikey-state').textContent()) ?? ''), `before, no key is stored (${await apiProv.locator('.apikey-state').textContent()})`);
  await keyInput.fill(FAKE_KEY);
  await apiProv.locator('button.apikey-save').click();
  check(await within(page, 5000, async () => /stored in your keychain/i.test((await apiProv.locator('.apikey-state').textContent()) ?? '')), `the page says a key is stored (${await apiProv.locator('.apikey-state').textContent()})`);
  check(keySet(), 'the stand-in keychain holds a key');
  check((await keyInput.inputValue()) === '', 'the field empties');
  const status = await api<{ set: boolean }>(page, '/api/providers/anthropic/key');
  check(status.set === true && Object.keys(status).join() === 'set', `GET says only that a key is set (${JSON.stringify(status)})`);
  // Every API answer the page has read since, and a fresh read of each route the page uses.
  for (const path of ['/api/providers', '/api/providers/anthropic/key', '/api/settings', '/api/treasury', '/api/firms', '/api/repos']) {
    const t = (await page.evaluate((p) => fetch(p).then((r) => r.text()), path)) as string;
    bodies.push(`${path} ${t}`);
  }
  await go(page, '#/');
  await go(page, '#/settings');
  await within(page, 4000, async () => /stored in your keychain/i.test((await apiProv.locator('.apikey-state').textContent()) ?? ''));
  await page.waitForTimeout(500);
  const html = await page.content();
  const values = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value).join('\n'));
  check(!html.includes(FAKE_KEY) && !values.includes(FAKE_KEY) && !html.includes('UITESTONLY'), 'the key appears nowhere in the page afterwards');
  await apiProv.locator('button.apikey-clear').click();
  check(await within(page, 5000, async () => /No key/i.test((await apiProv.locator('.apikey-state').textContent()) ?? '')), 'Clear removes it, and the page says no key is stored');
  check(!keySet() && (await api<{ set: boolean }>(page, '/api/providers/anthropic/key')).set === false, 'and the keychain holds none');
  await Promise.all(pending);
  page.off('response', onResponse);
  const leaked = bodies.filter((b) => b.includes(FAKE_KEY) || b.includes('UITESTONLY'));
  check(bodies.length > 6 && leaked.length === 0, `no API response carried the key (${bodies.length} read${leaked.length ? `; leaked in ${leaked.map((b) => b.split(' ')[0]).join(', ')}` : ''})`);

  // Caps: concurrency, the bid window, the hard stop and keep awake.
  const caps = sheet.locator('.set-sec.caps');
  for (const cls of ['cap-day', 'cap-night', 'cap-hardstop', 'cap-claude', 'cap-local', 'cap-bidwindow']) check((await caps.locator(`input.${cls}`).count()) === 1, `Caps carries ${cls}`);
  const conc = caps.locator('input.cap-claude');
  await conc.fill('3');
  await conc.press('Enter');
  check(await within(page, 3000, async () => (await api<{ claudeConcurrency: number }>(page, '/api/settings')).claudeConcurrency === 3), 'Claude concurrency is stored');
  await conc.fill('9');
  await conc.press('Enter');
  await page.waitForTimeout(300);
  check((await api<{ claudeConcurrency: number }>(page, '/api/settings')).claudeConcurrency === 4 && (await conc.inputValue()) === '4', 'and held to its range (4 at most)');
  await conc.fill('2');
  await conc.press('Enter');
  await within(page, 3000, async () => (await api<{ claudeConcurrency: number }>(page, '/api/settings')).claudeConcurrency === 2);
  const awake = caps.locator('[role="switch"].awake');
  check(/keeps the Mac awake while the city is working/i.test((await caps.textContent()) ?? ''), 'keep awake says what it does');
  await awake.click();
  check(await within(page, 3000, async () => (await api<{ keepAwake: boolean }>(page, '/api/settings')).keepAwake === true), 'and the switch stores it');
  await awake.click();
  await within(page, 3000, async () => (await api<{ keepAwake: boolean }>(page, '/api/settings')).keepAwake === false);
  await caps.scrollIntoViewIfNeeded();
  await sheet.locator('.sheet-body').evaluate((b) => {
    const c = b.querySelector('.set-sec.caps') as HTMLElement;
    b.scrollTop += c.getBoundingClientRect().top - b.getBoundingClientRect().top - 28;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'market-settings-caps.png') });

  const stopText = (await sheet.locator('.set-sec.stop').textContent()) ?? '';
  check(/new runs at once/.test(stopText) && /within five seconds/.test(stopText), `the kill switch says what stops (${stopText.replace(/\s+/g, ' ').slice(0, 140)})`);
  const leaves = sheet.locator('.settings-privacy .set-row[data-privacy="Leaves this Mac"]');
  const said = `${((await leaves.locator('.set-label-name').textContent()) ?? '').trim()}: ${((await leaves.locator('.set-text').textContent()) ?? '').trim()}`;
  check(
    said === "Leaves this Mac: gh calls, your own claude CLI's calls to Anthropic made on your login exactly as when you use it yourself, package downloads from the registries a job needs, and, only if you turn it on, Anthropic API calls on your key. Ollama stays on this Mac.",
    `Privacy says what leaves this Mac (${said.slice(0, 60)})`,
  );
  const all = ((await sheet.textContent()) ?? '') + ((await page.locator('.sheet.repos').textContent()) ?? '');
  check(!/market opens|when the market|opens later/i.test(all), 'no copy says the market opens later');
  await sheet.locator('.sheet-body').evaluate((b) => {
    const c = b.querySelector('.settings-privacy') as HTMLElement;
    b.scrollTop += c.getBoundingClientRect().top - b.getBoundingClientRect().top - 28;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'market-settings-privacy.png') });
  await go(page, '#/');
}
