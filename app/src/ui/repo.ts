import { pushModeRefusal, REGISTRY_HOSTS, TIER_LABELS } from '../../../shared/market-rules';
import type { District, FirmView, Floor, Job, JobStatus, Repo, RepoChecks } from '../../../shared/types';
import { api, ApiError, type EngineEvent, type RepoPatchBody } from '../api';
import { placeHref } from '../router';
import { cleanText, money } from './board';
import { ago, button, checkRadio, createSwitch, el, latestWins, markBusy, plural, rovingRadios, textButton, type Switch } from './controls';
import { ROOT_NAMES } from './inspector';
import { isRoute, sourceOf } from './district-words';
import { coalesce, detailSheet, keyedSlot, outLink, secHead, setTrail } from './pages';
import { marketNote, PUSH_NOTE } from './repos';
import { longDate, shortDate } from './story';
import './market.css';

export interface DistrictPage {
  show(fullName: string): void;
  hide(): void;
}

type Command = 'install' | 'test' | 'typecheck' | 'lint' | 'build' | 'screenshot';

/** The six commands, in the order an inspection meets them, each with what it is for. */
const COMMANDS: Array<[Command, string, string]> = [
  ['install', 'Install', 'first, with registries open'],
  ['test', 'Test', 'must pass; push mode needs it'],
  ['typecheck', 'Typecheck', 'must pass when set'],
  ['lint', 'Lint', 'must pass when set'],
  ['build', 'Build', 'must pass; push mode needs it'],
  ['screenshot', 'Screenshot', 'renders the routes below'],
];

const PREVIEW_KINDS: Array<[NonNullable<RepoChecks['preview']>['kind'] | 'none', string]> = [
  ['vite', 'Vite'],
  ['next', 'Next'],
  ['astro', 'Astro'],
  ['static', 'Static'],
  ['none', 'None'],
];

const ECOSYSTEM_NAMES: Record<keyof typeof REGISTRY_HOSTS, string> = { npm: 'npm', python: 'Python', rust: 'Rust', go: 'Go' };

const JOB_WORDS: Record<JobStatus, string> = {
  proposed: 'waiting on you',
  open: 'open',
  bidding: 'bidding',
  awarded: 'awarded',
  running: 'running',
  inspecting: 'inspecting',
  shipping: 'shipping',
  waiting: 'PR open',
  merged: 'merged',
  failed: 'failed',
  closed: 'closed',
  halted: 'halted',
  withdrawn: 'withdrawn',
};

/** A label, as the engine accepts it. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const JOBS_SHOWN = 10;
const FLOORS_SHOWN = 6;

const emptyChecks = (): RepoChecks => ({ test: null, typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: [], install: null, ecosystems: [], detected: false });

/**
 * A district's own page (#/repos/:owner/:name): the switches that put its
 * issues on the market, the label that posts them, the checks an inspection
 * runs (each editable, and each saying whether it was detected or set by
 * him), the preview and the routes the design check shoots, the network its
 * jobs may reach, its halt and strikes, its jobs (a proposed harness job can
 * be accepted here) and the floors the market has earned on it. Reads afresh
 * on every change the engine reports about it.
 */
export function createDistrictPage(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): DistrictPage {
  const sheet = detailSheet(parent, 'district', opts.onDismiss);
  const body = sheet.body;
  const trouble = el('p', 'detail-trouble');
  trouble.setAttribute('aria-live', 'polite');
  trouble.hidden = true;
  body.append(trouble);

  // The switches and the label, and the checks, keep their inputs across reads (focus and typing stay put).
  const market = el('section', 'detail-sec district-sec district-switches');
  const checksSec = el('section', 'detail-sec district-sec district-checks');
  body.append(market, checksSec);
  const slots = {
    actions: keyedSlot(sheet.actions),
    network: keyedSlot(body),
    halt: keyedSlot(body),
    jobs: keyedSlot(body),
    floors: keyedSlot(body),
  };
  const note = el('p', 'district-note', 'Autonomy grants arrive with Phase 4.');
  body.append(note);

  let fullName: string | null = null;
  let repo: Repo | null = null;
  let jobs: Job[] = [];
  let district: District | null = null;
  let firms: FirmView[] = [];
  let unlisten: (() => void) | null = null;
  /** The last refusal or failure of a change made here, shown beside what was changed. */
  const why = new Map<string, string>();

  const read = coalesce(async () => {
    const want = fullName;
    if (!want) return;
    try {
      const [repos, js, ds, fs] = await Promise.all([api.repos(), api.jobs({ repo: want }), api.city().catch(() => [] as District[]), api.firms().catch(() => firms)]);
      if (want !== fullName) return;
      repo = repos.find((r) => r.fullName === want) ?? null;
      jobs = js;
      district = ds.find((d) => d.repo === want) ?? null;
      firms = fs;
      trouble.hidden = repo !== null;
      if (!repo) trouble.textContent = 'This repo is not connected to the city. Connect it from Repos and its district stands here.';
    } catch (err) {
      if (want !== fullName) return;
      trouble.textContent = `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (!fullName) return;
    if (e.type === 'engine.reconnected') return read();
    const d = (e.data ?? {}) as Record<string, any>;
    const repoName = d.repo?.fullName ?? (typeof d.repo === 'string' ? d.repo : null) ?? d.job?.repo ?? d.run?.repo ?? null;
    if (repoName === fullName || e.type.startsWith('floor.') || e.type === 'merge.detected') read();
  }

  // ---------------------------------------------------------------- changes

  async function patch(p: RepoPatchBody, key: string): Promise<void> {
    if (!fullName) return;
    why.delete(key);
    try {
      repo = await api.patchRepo(fullName, p);
    } catch (err) {
      why.set(key, err instanceof Error ? err.message : String(err));
    }
    render();
  }

  // ---------------------------------------------------------------- the switches and the label

  const swConnect = createSwitch('connect', 'In the city', (on) => connectSync.set(on));
  const swMarket = createSwitch('market', 'Market', (on) => marketSync.set(on));
  const swPush = createSwitch('push', 'Push mode', (on) => pushSync.set(on));
  const connectSync = latestWins<boolean>(
    async (on) => {
      if (!fullName) return;
      why.delete('connect');
      try {
        if (on) await api.connect(fullName);
        else await api.disconnect(fullName);
      } catch (err) {
        why.set('connect', err instanceof Error ? err.message : String(err));
      }
      read();
    },
    (busy) => markBusy(swConnect.el, busy),
  );
  const marketSync = latestWins<boolean>((on) => (repo?.market === on ? Promise.resolve() : patch({ market: on }, 'market')), (busy) => markBusy(swMarket.el, busy));
  const pushSync = latestWins<boolean>(
    async (on) => {
      const refusal = on ? pushModeRefusal(repo?.checks ?? null) : null;
      if (refusal) {
        why.set('push', refusal);
        render();
        return;
      }
      await patch({ pushMode: on }, 'push');
    },
    (busy) => markBusy(swPush.el, busy),
  );

  function switchRow(sw: Switch, name: string, what: HTMLElement, key: string): { row: HTMLElement; what: HTMLElement; why: HTMLElement } {
    const row = el('div', `district-row district-switch ${key}`);
    row.dataset.switch = key;
    const label = el('span', 'district-row-name', name);
    label.addEventListener('click', () => sw.el.click());
    const w = el('p', 'district-why');
    w.id = `district-why-${key}`;
    w.setAttribute('aria-live', 'polite');
    sw.el.setAttribute('aria-describedby', w.id);
    const main = el('div', 'district-row-main');
    main.append(what, w);
    row.append(label, main, sw.el);
    return { row, what, why: w };
  }

  const connectRow = switchRow(swConnect, 'In the city', el('p', 'district-what'), 'connect');
  const marketRow = switchRow(swMarket, 'Market', el('p', 'district-what'), 'market');
  const pushRow = switchRow(swPush, 'Push mode', el('p', 'district-what', `It ${PUSH_NOTE.replace('; needs', '. It needs')}.`), 'push');

  // The label: its three tiers, set as it will be typed on an issue.
  const labelRow = el('div', 'district-row district-label-row');
  const labelName = el('label', 'district-row-name', 'Label');
  const labelInput = el('input', 'district-label mono-field');
  labelInput.id = 'district-label-input';
  labelName.htmlFor = labelInput.id;
  labelInput.spellcheck = false;
  labelInput.autocomplete = 'off';
  labelInput.maxLength = 40;
  const tiers = el('p', 'district-tiers');
  const labelWhy = el('p', 'district-why');
  labelWhy.setAttribute('aria-live', 'polite');
  const labelMain = el('div', 'district-row-main');
  labelMain.append(labelInput, tiers, labelWhy);
  labelRow.append(labelName, labelMain, el('span', 'district-row-side'));

  function fillTiers(base: string): void {
    tiers.replaceChildren();
    const [normal, low, high] = TIER_LABELS(base);
    for (const [label, tier] of [
      [low, 'low'],
      [normal, 'normal'],
      [high, 'high'],
    ] as const) {
      const t = el('span', 'district-tier');
      t.append(el('code', 'district-tier-label', label), el('span', 'district-tier-name', tier));
      tiers.append(t);
    }
  }
  const commitLabel = (): void => {
    const v = labelInput.value.trim();
    if (!repo || v === repo.label) {
      labelWhy.textContent = '';
      return;
    }
    if (!LABEL.test(v)) {
      labelWhy.textContent = 'A label is 1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.';
      return;
    }
    void patch({ label: v }, 'label');
  };
  labelInput.addEventListener('input', () => fillTiers(LABEL.test(labelInput.value.trim()) ? labelInput.value.trim() : (repo?.label ?? 'palimpsest')));
  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLabel();
    } else if (e.key === 'Escape' && repo && labelInput.value !== repo.label) {
      e.preventDefault();
      e.stopPropagation();
      labelInput.value = repo.label;
      fillTiers(repo.label);
      labelWhy.textContent = '';
    }
  });
  labelInput.addEventListener('blur', commitLabel);

  market.append(secHead('The market here'), connectRow.row, marketRow.row, pushRow.row, labelRow);

  function fillSwitches(r: Repo): void {
    swConnect.set(connectSync.want ?? r.connected);
    connectRow.what.textContent = r.connected
      ? `Its tower ${r.joinedAt ? `has stood in the city since ${longDate(r.joinedAt)}` : 'stands in the city'}${district ? `, ${plural(district.tower.floors.length, 'floor')} high` : ''}. Off takes the district down; nothing changes on GitHub.`
      : 'Not in the city. On reads its history and raises its tower.';
    connectRow.why.textContent = why.get('connect') ?? '';
    const on = r.connected;
    for (const row of [marketRow.row, pushRow.row, labelRow]) row.hidden = !on;
    swMarket.set(marketSync.want ?? r.market);
    marketRow.what.textContent = r.market ? `On: ${marketNote(r.label)}, and the firms bid on them.` : `Off: issues labelled ${r.label} wait. On, they post jobs for the firms to bid on.`;
    marketRow.why.textContent = why.get('market') ?? '';
    const refusal = r.pushMode ? null : pushModeRefusal(r.checks);
    swPush.setDisabled(refusal !== null);
    swPush.set(refusal ? false : (pushSync.want ?? r.pushMode));
    pushRow.why.textContent = refusal ?? why.get('push') ?? '';
    pushRow.row.classList.toggle('held', refusal !== null);
    if (document.activeElement !== labelInput) {
      labelInput.value = r.label;
      fillTiers(r.label);
    }
    labelWhy.textContent = why.get('label') ?? (document.activeElement === labelInput ? labelWhy.textContent : '');
  }

  // ---------------------------------------------------------------- the checks

  const checksHead = secHead('Checks', '');
  const checksAside = checksHead.querySelector<HTMLElement>('.repos-sec-count')!;
  const checksList = el('div', 'check-list');
  checksList.setAttribute('role', 'list');
  const cmdInputs = new Map<Command, { input: HTMLInputElement; src: HTMLElement; why: HTMLElement; row: HTMLElement }>();
  for (const [key, name, what] of COMMANDS) {
    const row = el('div', 'check-row');
    row.setAttribute('role', 'listitem');
    row.dataset.check = key;
    const label = el('label', 'check-name');
    const input = el('input', 'check-cmd mono-field');
    input.id = `check-${key}`;
    label.htmlFor = input.id;
    label.append(el('span', 'check-name-word', name), el('span', 'check-name-what', what));
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = 500;
    input.placeholder = 'not set';
    const src = el('span', 'check-src');
    src.id = `check-src-${key}`;
    const w = el('p', 'check-why');
    w.id = `check-why-${key}`;
    w.setAttribute('aria-live', 'polite');
    // A screen reader hears where the command came from (detected, set by you, none) and any refusal with it.
    input.setAttribute('aria-describedby', `${src.id} ${w.id}`);
    const main = el('div', 'check-main');
    main.append(input, w);
    row.append(label, main, src);
    checksList.append(row);
    cmdInputs.set(key, { input, src, why: w, row });
    const saved = (): string => repo?.checks?.[key] ?? '';
    const commit = (): void => {
      const v = input.value.trim();
      if (v === saved()) return;
      if (v.length > 500 || /[\x00-\x1f\x7f]/.test(v)) {
        w.textContent = 'A command is one line of up to 500 characters.';
        return;
      }
      void patch({ checks: { [key]: v === '' ? null : v } }, `check-${key}`);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && input.value !== saved()) {
        e.preventDefault();
        e.stopPropagation();
        input.value = saved();
        w.textContent = '';
      }
    });
    input.addEventListener('blur', commit);
  }

  // The preview: what kind of site, and the folder its build writes.
  const previewRow = el('div', 'check-row preview-row');
  const previewLabel = el('span', 'check-name');
  previewLabel.append(el('span', 'check-name-word', 'Preview'), el('span', 'check-name-what', 'how the built site is served'));
  const kinds = el('div', 'preview-kind');
  kinds.setAttribute('role', 'radiogroup');
  kinds.setAttribute('aria-label', 'Preview kind');
  for (const [k, word] of PREVIEW_KINDS) {
    const b = el('button', 'preview-choice');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.kind = k;
    b.append(el('span', 'quality-mark'), el('span', 'preview-word', word));
    b.addEventListener('click', () => pickKind(b));
    kinds.append(b);
  }
  rovingRadios(kinds, (b) => pickKind(b));
  const outWrap = el('label', 'preview-out-wrap');
  const outInput = el('input', 'preview-out mono-field');
  outInput.spellcheck = false;
  outInput.autocomplete = 'off';
  outInput.maxLength = 100;
  outInput.setAttribute('aria-label', 'The folder the build writes');
  outWrap.append(el('span', 'preview-out-word', 'from'), outInput);
  const previewWhy = el('p', 'check-why');
  previewWhy.setAttribute('aria-live', 'polite');
  const previewMain = el('div', 'check-main');
  const previewLine = el('div', 'preview-line');
  previewLine.append(kinds, outWrap);
  previewMain.append(previewLine, previewWhy);
  const previewSrc = el('span', 'check-src');
  previewRow.append(previewLabel, previewMain, previewSrc);

  function pickKind(b: HTMLElement): void {
    checkRadio(kinds, b);
    const kind = b.dataset.kind as (typeof PREVIEW_KINDS)[number][0];
    const cur = repo?.checks?.preview ?? null;
    if (kind === 'none') {
      outWrap.hidden = true;
      if (cur !== null) void patch({ checks: { preview: null } }, 'preview');
      return;
    }
    outWrap.hidden = false;
    const outDir = outInput.value.trim() || cur?.outDir || 'dist';
    outInput.value = outDir;
    if (cur?.kind !== kind) void patch({ checks: { preview: { kind, outDir } } }, 'preview');
  }
  const commitOut = (): void => {
    const cur = repo?.checks?.preview;
    const v = outInput.value.trim();
    if (!cur || v === cur.outDir) return;
    if (!/^[A-Za-z0-9_./-]{1,100}$/.test(v) || v.startsWith('/') || v.split('/').includes('..')) {
      previewWhy.textContent = 'A folder inside the repo, such as dist or build/site.';
      return;
    }
    void patch({ checks: { preview: { kind: cur.kind, outDir: v } } }, 'preview');
  };
  outInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitOut();
    }
  });
  outInput.addEventListener('blur', commitOut);

  // The routes the design check shoots: an editable list.
  const shotsRow = el('div', 'check-row shots-row');
  const shotsLabel = el('span', 'check-name');
  shotsLabel.append(el('span', 'check-name-word', 'Routes'), el('span', 'check-name-what', 'shot before and after'));
  const routeList = el('ul', 'shot-routes');
  routeList.setAttribute('aria-label', 'Screenshot routes');
  const addInput = el('input', 'shot-add mono-field');
  addInput.placeholder = 'Add a route, such as /settings';
  addInput.setAttribute('aria-label', 'Add a screenshot route');
  addInput.spellcheck = false;
  addInput.autocomplete = 'off';
  addInput.maxLength = 200;
  const shotWhy = el('p', 'check-why shot-why');
  shotWhy.setAttribute('aria-live', 'polite');
  const shotsMain = el('div', 'check-main');
  shotsMain.append(routeList, addInput, shotWhy);
  const shotsSrc = el('span', 'check-src');
  shotsRow.append(shotsLabel, shotsMain, shotsSrc);
  addInput.addEventListener('input', () => {
    shotWhy.textContent = '';
  });
  addInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = addInput.value.trim();
    if (!v) return;
    const cur = repo?.checks?.shots ?? [];
    if (!isRoute(v)) {
      shotWhy.textContent = 'A route starts with / and has no spaces or backslashes, such as /settings.';
      return;
    }
    if (cur.includes(v)) {
      shotWhy.textContent = `${v} is already shot.`;
      return;
    }
    if (cur.length >= 20) {
      shotWhy.textContent = 'Twenty routes at most.';
      return;
    }
    shotWhy.textContent = '';
    addInput.value = '';
    void patch({ checks: { shots: [...cur, v] } }, 'shots').then(() => addInput.focus({ preventScroll: true }));
  });

  function fillRoutes(shots: string[]): void {
    const key = JSON.stringify(shots);
    if (routeList.dataset.key === key) return;
    routeList.dataset.key = key;
    routeList.replaceChildren();
    for (const r of shots) {
      const li = el('li', 'shot-route');
      li.append(el('code', 'shot-path', r));
      const x = textButton('shot-remove', 'Remove', () => {
        void patch({ checks: { shots: (repo?.checks?.shots ?? []).filter((s) => s !== r) } }, 'shots').then(() => addInput.focus({ preventScroll: true }));
      });
      x.setAttribute('aria-label', `Stop shooting ${r}`);
      li.append(x);
      routeList.append(li);
    }
    if (!shots.length) routeList.append(el('li', 'shot-none', 'No routes: the design check has nothing to shoot.'));
  }

  const checksFoot = el('p', 'district-foot', 'An inspection runs these in a sandbox with no network. Changing a command forgets the baselines, so the next inspection measures afresh.');
  checksSec.append(checksHead, checksList, previewRow, shotsRow, checksFoot);

  function fillChecks(r: Repo): void {
    const c = r.checks ?? emptyChecks();
    checksSec.hidden = !r.connected;
    const mine = COMMANDS.filter(([k]) => sourceOf(r.checks, k) === 'set by you').length;
    const found = COMMANDS.filter(([k]) => sourceOf(r.checks, k) === 'detected').length;
    checksAside.textContent = !r.checks ? 'not read yet' : mine ? `${found} detected, ${mine} set by you` : found ? `${found} of 6 detected` : 'none detected';
    for (const [key] of COMMANDS) {
      const f = cmdInputs.get(key)!;
      if (document.activeElement !== f.input) f.input.value = c[key] ?? '';
      const src = sourceOf(r.checks, key);
      f.src.textContent = src;
      f.src.dataset.src = src;
      f.row.dataset.src = src;
      f.why.textContent = why.get(`check-${key}`) ?? '';
    }
    const kind = c.preview?.kind ?? 'none';
    if (!kinds.contains(document.activeElement)) checkRadio(kinds, kinds.querySelector<HTMLElement>(`[data-kind="${kind}"]`));
    outWrap.hidden = kind === 'none';
    if (document.activeElement !== outInput) outInput.value = c.preview?.outDir ?? '';
    previewWhy.textContent = why.get('preview') ?? (document.activeElement === outInput ? previewWhy.textContent : '');
    previewSrc.textContent = sourceOf(r.checks, 'preview');
    previewSrc.dataset.src = previewSrc.textContent;
    fillRoutes(c.shots);
    shotsSrc.textContent = sourceOf(r.checks, 'shots');
    shotsSrc.dataset.src = shotsSrc.textContent;
    if (why.has('shots')) shotWhy.textContent = why.get('shots')!;
    else if (document.activeElement !== addInput) shotWhy.textContent = '';
  }

  // ---------------------------------------------------------------- the network, read only

  function networkSection(r: Repo): HTMLElement {
    const sec = el('section', 'detail-sec district-sec district-network');
    const eco = r.checks?.ecosystems ?? [];
    sec.append(secHead('Network', eco.length ? 'read only, from its ecosystems' : 'read only'));
    const list = el('div', 'net-list');
    for (const e of eco) {
      const row = el('div', 'net-row');
      row.append(el('span', 'net-eco', ECOSYSTEM_NAMES[e] ?? e));
      const hosts = el('span', 'net-hosts');
      for (const h of REGISTRY_HOSTS[e] ?? []) hosts.append(el('code', 'net-host', h));
      row.append(hosts);
      list.append(row);
    }
    if (eco.length) sec.append(list);
    sec.append(
      el(
        'p',
        'district-foot',
        eco.length
          ? `A job here may reach ${eco.length === 1 ? 'this registry' : 'these registries'} while it installs and works, and nothing else; a Claude run also reaches Anthropic. Its checks run with no network at all.`
          : 'No ecosystem was detected, so its jobs reach no registry; a Claude run reaches only Anthropic. Its checks run with no network at all.',
      ),
    );
    return sec;
  }

  // ---------------------------------------------------------------- halt and strikes

  function haltSection(r: Repo): HTMLElement {
    const sec = el('section', 'detail-sec district-sec district-halt');
    sec.append(secHead('Standing', r.halted ? 'halted' : 'running'));
    const row = el('div', `halt-row${r.halted ? ' halted' : ''}`);
    const strikes = el('span', 'district-strikes');
    strikes.setAttribute('role', 'img');
    strikes.setAttribute('aria-label', `${plural(r.strikes, 'strike')} of 3`);
    for (let i = 0; i < 3; i++) strikes.append(el('i', `strike${i < r.strikes ? ' on' : ''}`));
    const text = el('div', 'halt-text');
    if (r.halted) {
      text.append(el('p', 'halt-title', `Halted ${ago(Date.parse(r.halted.at))}`), el('p', 'halt-reason', `${cleanText(r.halted.reason, 300).replace(/\.?$/, '.')} Its jobs wait, and no new ones open, until you resume.`));
    } else {
      text.append(
        el('p', 'halt-title', r.strikes === 0 ? 'No strikes' : `${plural(r.strikes, 'strike')} of three`),
        el('p', 'halt-reason', r.strikes === 0 ? 'Its last inspection passed, or none has run. Three failed inspections in a row halt the repo.' : `${r.strikes === 2 ? 'One more failed inspection' : 'Two more failed inspections'} in a row halt the repo. A passing one clears them.`),
      );
    }
    row.append(strikes, text);
    if (r.halted) {
      const b = button('district-resume', 'Resume', () => void resume(b));
      row.append(b);
    }
    sec.append(row);
    return sec;
  }

  async function resume(b: HTMLButtonElement): Promise<void> {
    if (!fullName) return;
    b.disabled = true;
    try {
      repo = await api.resumeRepo(fullName);
    } catch (err) {
      trouble.textContent = `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    read();
  }

  // ---------------------------------------------------------------- jobs

  function jobsSection(): HTMLElement {
    const sec = el('section', 'detail-sec district-sec district-jobs');
    const order = (j: Job): number => (j.status === 'proposed' ? 0 : ['open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'halted'].includes(j.status) ? 1 : 2);
    const sorted = [...jobs].sort((a, b) => order(a) - order(b) || Date.parse(b.postedAt) - Date.parse(a.postedAt));
    const live = jobs.filter((j) => order(j) === 1).length;
    sec.append(secHead('Jobs', jobs.length ? `${plural(jobs.length, 'job')}, ${live} under way or open` : 'none yet'));
    if (!jobs.length) {
      sec.append(el('p', 'detail-quiet', repo?.market ? `None yet. An issue labelled ${repo.label} posts one.` : 'None. With the market on, its labelled issues post jobs here.'));
      return sec;
    }
    const list = el('ol', 'djob-list');
    for (const j of sorted.slice(0, JOBS_SHOWN)) {
      const li = el('li', `djob status-${j.status}`);
      li.dataset.job = j.id;
      const st = el('span', 'djob-status', JOB_WORDS[j.status] ?? j.status);
      const t = el('a', 'djob-title', cleanText(j.title, 160));
      t.href = placeHref('job', j.id);
      const meta = el('span', 'djob-meta', `${j.issue !== null ? `#${j.issue}, ` : j.source === 'harness' ? 'harness, ' : ''}${j.tier}, ${money(j.value)} credits, posted ${shortDate(j.postedAt)}`);
      const main = el('div', 'djob-main');
      main.append(t, meta);
      li.append(st, main);
      if (j.status === 'proposed' && j.source === 'harness') {
        const a = button('djob-accept', 'Accept', () => void accept(j, a));
        a.setAttribute('aria-label', `Accept the harness job: ${cleanText(j.title, 120)}`);
        li.append(a);
      } else li.append(el('span', 'djob-side'));
      list.append(li);
    }
    sec.append(list);
    if (jobs.length > JOBS_SHOWN) {
      const more = el('p', 'district-more', `And ${plural(jobs.length - JOBS_SHOWN, 'older job')}, closed or merged, on `);
      const board = el('a', 'district-more-link', 'the board');
      board.href = placeHref('jobs');
      more.append(board, '.');
      sec.append(more);
    }
    return sec;
  }

  async function accept(j: Job, b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      await api.acceptJob(j.id);
    } catch (err) {
      trouble.textContent = err instanceof ApiError && err.status < 500 ? `Accept refused: ${err.message}` : `Accept failed: ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    read();
  }

  // ---------------------------------------------------------------- floors earned

  function floorsSection(): HTMLElement {
    const sec = el('section', 'detail-sec district-sec district-floors');
    const earned = (district?.tower.floors ?? []).filter((f): f is Floor & { earned: NonNullable<Floor['earned']> } => !!f.earned);
    const lit = earned.filter((f) => f.earned.state === 'lit').length;
    const waiting = earned.filter((f) => f.earned.state === 'waiting').length;
    const scars = earned.filter((f) => f.earned.state === 'scar').length;
    sec.append(secHead('Floors earned', earned.length ? `above ${plural((district?.tower.floors.length ?? 0) - earned.length, 'founding floor')}` : ''));
    const figure = el('div', 'floors-figure');
    figure.append(el('span', 'floors-n', String(earned.length)));
    const parts = [`${lit} lit`, ...(waiting ? [`${waiting} waiting on a merge`] : []), ...(scars ? [`${plural(scars, 'scar')}`] : [])];
    figure.append(el('span', 'floors-what', earned.length ? `${earned.length === 1 ? 'floor' : 'floors'} built by the firms: ${parts.join(', ')}` : 'None yet. Each job merged here adds a floor above its history.'));
    sec.append(figure);
    if (earned.length) {
      const names = new Map(firms.map((f) => [f.id, cleanText(f.name, 60)] as const));
      const list = el('ol', 'floor-list');
      for (const f of [...earned].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, FLOORS_SHOWN)) {
        const li = el('li', `dfloor ${f.earned.state}`);
        const mark = el('i', 'dfloor-mark');
        mark.setAttribute('aria-hidden', 'true');
        const t = el('a', 'dfloor-title', cleanText(f.title, 140));
        t.href = placeHref('job', f.earned.jobId);
        li.append(mark, t, el('span', 'dfloor-meta', `${names.get(f.earned.firmId) ?? cleanText(f.earned.firmId, 40)}, ${f.earned.state === 'scar' ? 'scar' : f.earned.state === 'waiting' ? 'waiting' : 'lit'} ${shortDate(f.at)}`));
        list.append(li);
      }
      sec.append(list);
    }
    return sec;
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    if (!fullName) return;
    const [owner, name] = fullName.split('/');
    setTrail(sheet.trail, [
      ['Repos', placeHref('repos')],
      [name ?? fullName, null],
    ]);
    sheet.title.textContent = name ?? fullName;
    const r = repo;
    market.hidden = !r;
    if (!r) {
      checksSec.hidden = true;
      note.hidden = true;
      sheet.sub.textContent = '';
      for (const s of Object.values(slots)) s('none', () => null);
      return;
    }
    note.hidden = !r.connected;
    sheet.sub.textContent = r.description ? cleanText(r.description, 200).replace(/\.?$/, '.') : '';
    const facts = [owner, r.language, `${ROOT_NAMES[r.root]} root`, r.private ? 'private' : ''].filter(Boolean) as string[];
    slots.actions(JSON.stringify([fullName, facts]), () => {
      const wrap = el('div', 'detail-actions-wrap');
      const row = el('div', 'detail-actions-row district-facts');
      for (const f of facts) row.append(el('span', 'district-fact', f));
      row.append(outLink('district-github', 'Open on GitHub', `https://github.com/${fullName}`));
      wrap.append(row);
      return wrap;
    });
    fillSwitches(r);
    fillChecks(r);
    slots.network(r.connected ? JSON.stringify(r.checks?.ecosystems ?? []) : 'off', () => (r.connected ? networkSection(r) : null));
    slots.halt(r.connected ? JSON.stringify([r.halted, r.strikes, Math.floor(Date.now() / 60_000)]) : 'off', () => (r.connected ? haltSection(r) : null));
    slots.jobs(r.connected ? JSON.stringify([jobs.map((j) => [j.id, j.status, j.title]), r.market, r.label]) : 'off', () => (r.connected ? jobsSection() : null));
    slots.floors(r.connected ? JSON.stringify([district?.tower.floors.filter((f) => f.earned).map((f) => [f.id, f.earned?.state]), firms.length]) : 'off', () => (r.connected ? floorsSection() : null));
  }

  return {
    show(name) {
      const changed = name !== fullName;
      fullName = name;
      if (changed) {
        repo = null;
        jobs = [];
        district = null;
        why.clear();
        trouble.hidden = true;
        for (const s of Object.values(slots)) s('', () => null);
        market.hidden = true;
        checksSec.hidden = true;
      }
      sheet.show();
      unlisten ??= opts.listen(onEvent);
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
    },
  };
}
