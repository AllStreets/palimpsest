import type { District, Job, Repo, RootStyle } from '../../../shared/types';
import { pushModeRefusal } from '../../../shared/market-rules';
import { api, ApiError, type AvailableRepo, type EngineEvent } from '../api';
import { placeHref } from '../router';
import {
  ago,
  button,
  checkRadio,
  createSheet,
  createSwitch,
  el,
  latestWins,
  type LatestWins,
  markBusy,
  plural,
  rovingRadios,
  type Switch,
  textButton,
} from './controls';
import { ROOT_NAMES } from './inspector';
import { coalesce } from './pages';

const ROOTS: RootStyle[] = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];

/** Each root as a small elevation drawing, filled in the current colour. */
const ROOT_ICONS: Record<RootStyle, string> = {
  beauxarts:
    '<path d="M11.4 3.5h1.2V6h-1.2z"/><path d="M7 11a5 5 0 0 1 10 0z"/><path d="M6 11.6h12v1.2H6z"/><path d="M7 13.4h1.3v5H7zM10 13.4h1.3v5H10zM12.7 13.4H14v5h-1.3zM15.7 13.4H17v5h-1.3z"/><path d="M4.5 19h15v2h-15z"/>',
  roman:
    '<path d="M12 4.2 21 9.4H3z"/><path d="M3.5 10.2h17v1.3h-17z"/><path d="M5 12.3h1.5v6.4H5zM8.4 12.3h1.5v6.4H8.4zM11.25 12.3h1.5v6.4h-1.5zM14.1 12.3h1.5v6.4h-1.5zM17.5 12.3H19v6.4h-1.5z"/><path d="M3 19.3h18V21H3z"/>',
  gothic:
    '<path d="M12 1.8 14.4 9h-4.8z"/><path d="M9.8 9.6h4.4V21H9.8z"/><path d="M6.8 7.2 8 11H5.6zM17.2 7.2 18.4 11H16z"/><path d="M5.8 11.4h2.2V21H5.8zM16 11.4h2.2V21H16z"/><path d="M8 15.5h1.8V21H8zM14.2 15.5H16V21h-1.8z"/>',
  pagoda:
    '<path d="M11.5 2h1v2.6h-1z"/><path d="M7.5 7.2C9.5 6.6 10.6 5.4 12 4.6c1.4.8 2.5 2 4.5 2.6z"/><path d="M9.6 7.6h4.8v2.2H9.6z"/><path d="M5.8 12C8.4 11.3 10 10.6 12 9.8c2 .8 3.6 1.5 6.2 2.2z"/><path d="M8.6 12.4h6.8v2.4H8.6z"/><path d="M3.8 17.2c3-.8 5.6-1.6 8.2-2.4 2.6.8 5.2 1.6 8.2 2.4z"/><path d="M7.4 17.6h9.2V21H7.4z"/>',
  chicago:
    '<path d="M6.2 3h11.6v1.6H6.2z"/><path d="M7 5h10v16H7zm1.6 1.6v1.6h1.8V6.6zm2.5 0v1.6h1.8V6.6zm2.5 0v1.6h1.8V6.6zM8.6 9.6v1.6h1.8V9.6zm2.5 0v1.6h1.8V9.6zm2.5 0v1.6h1.8V9.6zm-5 3v1.6h1.8v-1.6zm2.5 0v1.6h1.8v-1.6zm2.5 0v1.6h1.8v-1.6zm-5 3v1.6h1.8v-1.6zm2.5 0v1.6h1.8v-1.6zm2.5 0v1.6h1.8v-1.6z"/>',
};

const icon = (root: RootStyle): string =>
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">${ROOT_ICONS[root]}</svg>`;

/** A small keyhole beside the word private: a shape, not a badge. */
const KEYHOLE =
  '<svg viewBox="0 0 8 11" width="7" height="10" aria-hidden="true" fill="currentColor"><circle cx="4" cy="3.4" r="2.6"/><path d="M2.6 5h2.8l.9 5.4H1.7z"/></svg>';

const SEARCH_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m10.3 10.3 4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/** The engine's analysis steps, in order, as the Repos screen says them. */
const STEPS: Array<[string, string]> = [
  ['mirror', 'Cloning history'],
  ['log', 'Reading history'],
  ['prs', 'Reading pull requests'],
  ['floors', 'Laying out floors'],
];

/** What push mode does, beside its switch. */
export const PUSH_NOTE = 'merges to main after inspection; needs a test and a build command';

/** What the market switch does on a repo, with its label. */
export function marketNote(label: string): string {
  return `issues labelled ${label} post jobs`;
}

/** gh's not-found text quotes GraphQL; say what it means instead. Every other engine message is already plain. */
function plainError(message: string): string {
  if (/^Repository not found/i.test(message)) return 'GitHub could not find this repo, or your gh login cannot read it.';
  return message;
}

export interface ReposScreen {
  show(): void;
  hide(): void;
}

interface Row {
  fullName: string;
  el: HTMLElement;
  connect: Switch;
  /** One request at a time per control, the user's last choice winning: connect, push mode, root. */
  connectSync: LatestWins<boolean>;
  pushSync: LatestWins<boolean> | null;
  marketSync: LatestWins<boolean> | null;
  rootSync: LatestWins<RootStyle> | null;
  /** The status line: what the analysis says (rebuilt only when it changes), then Disconnect at the right. */
  status: HTMLElement;
  statusBody: HTMLElement;
  statusKey: string;
  disconnect: HTMLButtonElement;
  controls: HTMLElement | null;
  push: Switch | null;
  market: Switch | null;
  /** The name: a link to the district page while the repo is in the city. */
  name: HTMLAnchorElement;
  /** A halt with Resume, or a harness job waiting on him; rebuilt only when what it says changes. */
  alerts: HTMLElement;
  alertsKey: string;
  roots: HTMLElement | null;
  /** Text the search matches against. */
  haystack: string;
}

/**
 * Every repo gh can see, one hairline row each, with a connect switch.
 * Connected repos stand first, under "In the city", each with its status
 * (the analysis step, ready with its floor count, or an error and Retry),
 * a halt (with Resume) or a harness job waiting on him, its market and push
 * mode switches, its root and Disconnect. A connected repo's name opens its
 * district page.
 */
export function createRepos(
  parent: HTMLElement,
  opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void },
): ReposScreen {
  const sheet = createSheet(parent, 'repos', 'Repos', opts.onDismiss);
  const facts = el('p', 'sheet-facts');
  sheet.root.querySelector('.sheet-head')?.append(facts);

  const searchWrap = el('label', 'repos-find');
  searchWrap.innerHTML = SEARCH_ICON;
  const search = el('input', 'repos-search');
  search.type = 'search';
  search.placeholder = 'Find a repo';
  search.setAttribute('aria-label', 'Find a repo by name or description');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const findCount = el('span', 'repos-find-count');
  findCount.setAttribute('aria-live', 'polite');
  searchWrap.append(search, findCount);
  sheet.root.querySelector('.sheet-head')?.append(searchWrap);

  const cityHead = sectionHead('In the city');
  const cityList = el('ol', 'repo-list');
  const restHead = sectionHead('On GitHub, not connected');
  const restList = el('ol', 'repo-list');
  const notice = el('div', 'repos-notice');
  sheet.body.append(cityHead.el, cityList, restHead.el, restList, notice);

  let available: AvailableRepo[] | null = null;
  let availableError: string | null = null;
  const stored = new Map<string, Repo>();
  const floors = new Map<string, number>();
  const steps = new Map<string, string>();
  /** Errors from the screen's own calls (a refused connect, say), shown in the row until the next change. */
  const callErrors = new Map<string, string>();
  /** Why push mode is off where he asked for it on. */
  const pushWhy = new Map<string, string>();
  /** Harness jobs proposed and waiting on him, by repo. */
  const harness = new Map<string, Job>();
  const rows = new Map<string, Row>();
  let unlisten: (() => void) | null = null;

  function sectionHead(title: string): { el: HTMLElement; count: HTMLElement } {
    const h = el('h2', 'repos-sec');
    const count = el('span', 'repos-sec-count');
    h.append(el('span', 'repos-sec-name', title), count);
    return { el: h, count };
  }

  // ---------------------------------------------------------------- data

  async function load(): Promise<void> {
    notice.replaceChildren(el('p', 'repos-waiting', 'Asking GitHub for your repos'));
    await Promise.all([loadStored(), loadProposals()]);
    render();
    try {
      available = await api.available();
      availableError = null;
    } catch (err) {
      availableError = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  /** The engine's own record of the repos and their floor counts, read afresh. */
  async function loadStored(): Promise<void> {
    const [repos, districts] = await Promise.all([api.repos().catch(() => [] as Repo[]), api.city().catch(() => [] as District[])]);
    stored.clear();
    for (const r of repos) stored.set(r.fullName, r);
    readFloors(districts);
  }

  /** The harness jobs proposed and waiting on him (ruling 23), one per repo at most. */
  async function loadProposals(): Promise<void> {
    const jobs = await api.jobs({ status: 'proposed' }).catch(() => null);
    if (!jobs) return;
    harness.clear();
    for (const j of jobs) if (j.source === 'harness' && !harness.has(j.repo)) harness.set(j.repo, j);
  }
  const reloadProposals = coalesce(async () => {
    await loadProposals();
    render();
  });

  function readFloors(districts: District[]): void {
    floors.clear();
    for (const d of districts) floors.set(d.repo, d.tower.floors.length);
  }

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected') {
      // The stream was down, so events may have been missed: take the engine's record as it is now.
      void Promise.all([loadStored(), loadProposals()]).then(render);
      return;
    }
    if (e.type.startsWith('job.')) {
      reloadProposals();
      return;
    }
    if (e.type === 'repo.halted' || e.type === 'repo.resumed') {
      void loadStored().then(render);
      return;
    }
    const data = e.data as { repo?: Repo; step?: string; error?: string } | null;
    const repo = data?.repo;
    if (!repo?.fullName || !e.type.startsWith('repo.')) return;
    callErrors.delete(repo.fullName);
    const known = stored.get(repo.fullName);
    if (e.type === 'repo.analyzing') {
      // The step event carries the repo as analysis found it; keep what this screen already knows of its toggles.
      stored.set(repo.fullName, { ...(known ?? repo), status: 'analyzing', error: null });
      steps.set(repo.fullName, data?.step ?? '');
    } else if (e.type === 'repo.error') {
      stored.set(repo.fullName, { ...repo, status: 'error', error: data?.error ?? repo.error });
    } else if (e.type === 'repo.analyzed') {
      // Ready and its floor count arrive together: the row never says a bare "Ready" first.
      // A disconnect or patch may land while the city is fetched: the toggles come from the latest
      // state this screen holds, only the analysis result (status, checks) from the event.
      void api.city().then(readFloors, () => {}).finally(() => {
        const latest = stored.get(repo.fullName) ?? repo;
        stored.set(repo.fullName, { ...latest, status: repo.status, error: repo.error, analyzedAt: repo.analyzedAt, checks: repo.checks });
        render();
      });
      return;
    } else {
      stored.set(repo.fullName, repo);
    }
    render();
  }

  // ---------------------------------------------------------------- actions

  async function setConnected(fullName: string, on: boolean): Promise<void> {
    callErrors.delete(fullName);
    try {
      if (on) {
        steps.set(fullName, '');
        stored.set(fullName, await api.connect(fullName));
      } else {
        await api.disconnect(fullName);
        const r = stored.get(fullName);
        if (r) stored.set(fullName, { ...r, connected: false });
      }
    } catch (err) {
      callErrors.set(fullName, err instanceof Error ? err.message : String(err));
    }
    render();
    // Disconnect removes the button that was pressed: focus lands on the row's switch, not the page.
    if (!sheet.root.contains(document.activeElement)) rows.get(fullName)?.connect.el.focus({ preventScroll: true });
  }

  async function retry(fullName: string): Promise<void> {
    const r = stored.get(fullName);
    if (r) stored.set(fullName, { ...r, status: 'analyzing', error: null });
    steps.set(fullName, '');
    callErrors.delete(fullName);
    render();
    try {
      await api.analyze(fullName);
    } catch (err) {
      callErrors.set(fullName, err instanceof Error ? err.message : String(err));
      render();
    }
  }

  /**
   * Push mode (ruling 23): refused here, before any request, when the repo
   * has no test or no build command; and if the engine still refuses it
   * (409), its reason. Either way the reason shows quietly beside the
   * switch and the switch goes back to what is stored.
   */
  async function patchPush(fullName: string, on: boolean): Promise<void> {
    const refusal = on ? pushModeRefusal(stored.get(fullName)?.checks ?? null) : null;
    if (refusal) {
      pushWhy.set(fullName, refusal);
      render();
      return;
    }
    try {
      stored.set(fullName, await api.patchRepo(fullName, { pushMode: on }));
      pushWhy.delete(fullName);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) pushWhy.set(fullName, err.message);
      else callErrors.set(fullName, err instanceof Error ? err.message : String(err));
    }
    render();
  }

  async function resume(fullName: string): Promise<void> {
    callErrors.delete(fullName);
    try {
      stored.set(fullName, await api.resumeRepo(fullName));
    } catch (err) {
      callErrors.set(fullName, err instanceof Error ? err.message : String(err));
    }
    render();
    // Resume removes the button that was pressed: focus goes to the row's market switch.
    if (!sheet.root.contains(document.activeElement)) rows.get(fullName)?.market?.el.focus({ preventScroll: true });
  }

  async function patch(fullName: string, p: Partial<Pick<Repo, 'pushMode' | 'root' | 'market'>>): Promise<void> {
    try {
      stored.set(fullName, await api.patchRepo(fullName, p));
    } catch (err) {
      callErrors.set(fullName, err instanceof Error ? err.message : String(err));
    }
    render();
  }

  // ---------------------------------------------------------------- rows

  function rowFor(fullName: string, meta: AvailableRepo | Repo): Row {
    const existing = rows.get(fullName);
    if (existing) return existing;
    const [owner, name] = fullName.split('/');
    const li = el('li', 'repo-row');
    li.dataset.repo = fullName;
    const connect = createSwitch('connect', `Connect ${fullName}`, (on) => row.connectSync.set(on));

    const head = el('div', 'repo-head');
    const title = el('a', 'repo-name', name ?? fullName);
    head.append(title, el('span', 'repo-owner', owner ?? ''));
    if (meta.private) {
      const p = el('span', 'repo-private');
      p.innerHTML = KEYHOLE;
      p.append(document.createTextNode('private'));
      head.append(p);
    }
    const lang = el('span', 'repo-lang', meta.language ?? '');
    const status = el('div', 'repo-status');
    const statusBody = el('p', 'repo-status-body');
    statusBody.setAttribute('aria-live', 'polite');
    status.append(statusBody);
    const disconnect = textButton('repo-disconnect', 'Disconnect', () => {
      row.connect.set(false);
      row.connectSync.set(false);
    });
    disconnect.setAttribute('aria-label', `Disconnect ${fullName}`);
    const desc = el('p', 'repo-desc', meta.description ?? '');
    if (!meta.description) desc.hidden = true;
    const alerts = el('div', 'repo-alerts');
    alerts.setAttribute('aria-live', 'polite');
    alerts.hidden = true;
    li.append(connect.el, head, lang, desc, status, alerts);

    const row: Row = {
      fullName,
      el: li,
      connect,
      connectSync: latestWins<boolean>(
        (on) => setConnected(fullName, on),
        (busy) => {
          markBusy(connect.el, busy);
          if (!busy) render();
        },
      ),
      pushSync: null,
      marketSync: null,
      rootSync: null,
      status,
      statusBody,
      statusKey: '',
      disconnect,
      controls: null,
      push: null,
      market: null,
      name: title,
      alerts,
      alertsKey: '',
      roots: null,
      haystack: `${fullName} ${meta.description ?? ''} ${meta.language ?? ''}`.toLowerCase(),
    };
    rows.set(fullName, row);
    return row;
  }

  function controlsFor(row: Row): HTMLElement {
    if (row.controls) return row.controls;
    const c = el('div', 'repo-controls');

    const rootWrap = el('div', 'repo-root');
    const rootLabel = el('span', 'repo-ctl-label', 'Root');
    const group = el('div', 'root-picker');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', `Root style for ${row.fullName}`);
    for (const r of ROOTS) {
      const b = el('button', 'root-choice');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.root = r;
      b.title = ROOT_NAMES[r];
      b.setAttribute('aria-label', ROOT_NAMES[r]);
      b.innerHTML = icon(r);
      b.addEventListener('click', () => choose(b));
      group.append(b);
    }
    const rootName = el('span', 'root-name');
    const choose = (b: HTMLElement): void => {
      const r = b.dataset.root as RootStyle;
      checkRadio(group, b);
      rootName.textContent = ROOT_NAMES[r];
      row.rootSync?.set(r);
    };
    rovingRadios(group, choose);
    rootWrap.append(rootLabel, group, rootName);

    const switches = el('div', 'repo-switches');
    const marketWrap = el('div', 'repo-market');
    const market = createSwitch('market', `Market for ${row.fullName}`, (on) => row.marketSync?.set(on));
    row.marketSync = latestWins<boolean>(
      (on) => (stored.get(row.fullName)?.market === on ? Promise.resolve() : patch(row.fullName, { market: on })),
      (busy) => {
        markBusy(market.el, busy);
        if (!busy) render();
      },
    );
    const marketText = el('span', 'repo-push-text');
    marketText.append(el('span', 'repo-ctl-label', 'Market'), el('span', 'repo-push-note repo-market-note', marketNote(stored.get(row.fullName)?.label ?? 'palimpsest')));
    marketText.addEventListener('click', () => market.el.click());
    marketWrap.append(market.el, marketText);

    const pushWrap = el('div', 'repo-push');
    const push = createSwitch('push', `Push mode for ${row.fullName}`, (on) => row.pushSync?.set(on));
    row.pushSync = latestWins<boolean>(
      (on) => patchPush(row.fullName, on),
      (busy) => {
        markBusy(push.el, busy);
        if (!busy) render();
      },
    );
    row.rootSync = latestWins<RootStyle>(
      (r) => (stored.get(row.fullName)?.root === r ? Promise.resolve() : patch(row.fullName, { root: r })),
      (busy) => {
        markBusy(group, busy);
        if (!busy) render();
      },
    );
    const pushText = el('span', 'repo-push-text');
    pushText.append(el('span', 'repo-ctl-label', 'Push mode'), el('span', 'repo-push-note', PUSH_NOTE));
    pushText.addEventListener('click', () => push.el.click());
    const why = el('span', 'repo-push-why');
    why.id = `push-why-${row.fullName.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    why.setAttribute('aria-live', 'polite');
    push.el.setAttribute('aria-describedby', why.id);
    pushWrap.append(push.el, pushText, why);
    switches.append(marketWrap, pushWrap);

    c.append(switches, rootWrap);
    row.controls = c;
    row.push = push;
    row.market = market;
    row.roots = group;
    return c;
  }

  /**
   * The status line. Its text is rebuilt only when what it says changes, so
   * an event for another repo never pulls keyboard focus off this row's Retry.
   */
  function fillStatus(row: Row, repo: Repo | undefined): void {
    const callError = callErrors.get(row.fullName);
    const on = !!repo?.connected;
    const state = callError ? 'error' : on ? repo!.status : 'off';
    row.el.dataset.status = state;
    const step = steps.get(row.fullName) ?? '';
    const n = floors.get(row.fullName);
    const key = [state, callError ?? '', step, n ?? '', repo?.error ?? '', on].join('|');
    if (on && row.disconnect.parentElement !== row.status) row.status.append(row.disconnect);
    if (!on && row.disconnect.parentElement) row.disconnect.remove();
    if (key === row.statusKey) return;
    row.statusKey = key;

    const s = row.statusBody;
    s.replaceChildren();
    if (callError) {
      s.append(el('span', 'repo-error', callError));
    } else if (!on) {
      // Nothing to say for a repo that is off.
    } else if (state === 'analyzing') {
      const at = STEPS.findIndex(([k]) => k === step);
      const ticks = el('span', 'repo-ticks');
      ticks.setAttribute('aria-hidden', 'true');
      STEPS.forEach((_, i) => ticks.append(el('i', i <= at ? 'done' : '')));
      s.append(ticks, el('span', 'repo-step', at >= 0 ? `${STEPS[at][1]}, step ${at + 1} of ${STEPS.length}` : 'Surveying the site'));
    } else if (state === 'ready') {
      s.append(el('span', 'repo-ready', n === undefined ? 'Ready' : n === 0 ? 'Ready, root only: no merged changes yet' : `Ready, ${plural(n, 'floor')}`));
    } else if (state === 'error') {
      const raw = repo?.error ?? 'The analysis failed.';
      const msg = el('span', 'repo-error', plainError(raw));
      msg.title = raw;
      s.append(msg, textButton('repo-retry', 'Retry', () => void retry(row.fullName)));
    } else {
      s.append(el('span', 'repo-step', 'Waiting to be read'));
    }
    row.status.hidden = !on && !callError;
  }

  /** The halt (with Resume) and the harness job waiting on him, each a line of its own. */
  function fillAlerts(row: Row, repo: Repo | undefined): void {
    const on = !!repo?.connected;
    const halted = on ? repo!.halted : null;
    const proposal = on ? harness.get(row.fullName) : undefined;
    const key = JSON.stringify([halted, proposal?.id ?? null, proposal?.title ?? null]);
    if (key === row.alertsKey) return;
    row.alertsKey = key;
    row.alerts.replaceChildren();
    if (halted) {
      const block = el('div', 'repo-halt');
      const head = el('p', 'repo-halt-head');
      head.append(el('span', 'repo-halt-word', `Halted ${ago(Date.parse(halted.at))}`));
      const b = textButton('repo-resume', 'Resume', () => void resume(row.fullName));
      b.setAttribute('aria-label', `Resume the market on ${row.fullName}`);
      head.append(b);
      block.append(head, el('p', 'repo-halt-reason', `${halted.reason.replace(/\.?$/, '.')} No jobs open here until you resume.`));
      row.alerts.append(block);
    }
    if (proposal) {
      const line = el('p', 'repo-harness');
      const a = el('a', 'repo-harness-link', proposal.title);
      a.href = placeHref('job', proposal.id);
      line.append(el('span', 'repo-harness-word', 'Harness proposed'), document.createTextNode(' '), a);
      row.alerts.append(line);
    }
    row.alerts.hidden = !halted && !proposal;
  }

  /** Push mode needs a test and a build command (ruling 23): without them the switch is held off, and says why. */
  function fillPush(row: Row, repo: Repo): void {
    const refusal = repo.pushMode ? null : pushModeRefusal(repo.checks);
    row.push?.setDisabled(refusal !== null);
    row.push?.set(refusal ? false : (row.pushSync?.want ?? repo.pushMode));
    const why = row.controls?.querySelector('.repo-push-why');
    const text = refusal ?? pushWhy.get(row.fullName) ?? '';
    if (why && why.textContent !== text) why.textContent = text;
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    const all = new Map<string, AvailableRepo | Repo>();
    for (const a of available ?? []) all.set(a.fullName, a);
    for (const r of stored.values()) if (r.connected) all.set(r.fullName, { ...all.get(r.fullName), ...r });

    const connected: Repo[] = [...stored.values()].filter((r) => r.connected).sort((a, b) => a.slot - b.slot);
    const rest = (available ?? []).filter((a) => !stored.get(a.fullName)?.connected);
    const q = search.value.trim().toLowerCase();
    let shownCity = 0;
    let shownRest = 0;

    const place = (list: HTMLElement, names: string[]): number => {
      let shown = 0;
      names.forEach((fullName, i) => {
        const row = rowFor(fullName, all.get(fullName)!);
        const repo = stored.get(fullName);
        const on = !!repo?.connected;
        // While a request is in flight the switch shows what the user asked for, not the stale stored state.
        row.connect.set(row.connectSync.want ?? on);
        row.el.classList.toggle('on', on);
        if (on) {
          const c = controlsFor(row);
          if (c.parentElement !== row.el) row.el.append(c);
          fillPush(row, repo);
          row.market?.set(row.marketSync?.want ?? repo.market);
          const note = row.controls?.querySelector('.repo-market-note');
          if (note && note.textContent !== marketNote(repo.label)) note.textContent = marketNote(repo.label);
          const href = placeHref('repo', fullName);
          if (row.name.getAttribute('href') !== href) row.name.setAttribute('href', href);
          const root = row.rootSync?.want ?? repo.root;
          const chosen = row.roots?.querySelector<HTMLElement>(`[data-root="${root}"]`) ?? null;
          // Re-checking moves the tab stop; leave a radio the user is on alone.
          if (row.roots && chosen?.getAttribute('aria-checked') !== 'true') checkRadio(row.roots, chosen);
          const nameEl = row.controls?.querySelector('.root-name');
          if (nameEl) nameEl.textContent = ROOT_NAMES[root];
        } else {
          if (row.controls?.parentElement === row.el) row.controls.remove();
          row.name.removeAttribute('href');
        }
        fillStatus(row, repo);
        fillAlerts(row, repo);
        const match = !q || row.haystack.includes(q);
        row.el.hidden = !match;
        if (match) shown++;
        // Keep the order without moving rows that are already in place: moving a node drops its focus.
        if (list.children[i] !== row.el) {
          const hadFocus = row.el.contains(document.activeElement);
          const focused = document.activeElement as HTMLElement | null;
          list.insertBefore(row.el, list.children[i] ?? null);
          if (hadFocus) focused?.focus({ preventScroll: true });
        }
      });
      while (list.children.length > names.length) list.lastElementChild?.remove();
      return shown;
    };
    shownCity = place(cityList, connected.map((r) => r.fullName));
    shownRest = place(restList, rest.map((a) => a.fullName));

    cityHead.count.textContent = q ? `${shownCity} of ${connected.length}` : plural(connected.length, 'repo');
    restHead.count.textContent = available ? (q ? `${shownRest} of ${rest.length}` : plural(rest.length, 'repo')) : '';
    cityHead.el.hidden = connected.length === 0 && !!q;
    cityList.hidden = connected.length === 0;
    if (connected.length === 0 && !q) {
      cityHead.count.textContent = 'none yet';
    }
    restHead.el.hidden = !available || rest.length === 0;

    const total = new Set([...(available ?? []).map((a) => a.fullName), ...connected.map((r) => r.fullName)]).size;
    facts.textContent = available
      ? `${connected.length} of ${plural(total, 'repo')} in the city. Nothing connects until you turn it on.`
      : `${plural(connected.length, 'repo')} in the city`;
    findCount.textContent = q ? plural(shownCity + shownRest, 'match').replace('matchs', 'matches') : '';

    notice.replaceChildren();
    if (availableError) {
      const p = el('div', 'repos-trouble');
      p.append(el('p', 'repos-trouble-text', `GitHub could not be read. ${availableError}`), button('repos-retry-list', 'Try again', () => void load()));
      notice.append(p);
    } else if (!available) {
      notice.append(el('p', 'repos-waiting', 'Asking GitHub for your repos'));
    } else if (q && shownCity + shownRest === 0) {
      notice.append(el('p', 'repos-waiting', `Nothing matches “${search.value.trim()}”.`));
    }
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      render();
    }
  });

  const onKey = (e: KeyboardEvent): void => {
    if (!sheet.shown || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === '/' && !typing) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    show() {
      if (sheet.shown) return;
      sheet.show();
      unlisten = opts.listen(onEvent);
      void load();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
    },
  };
}
