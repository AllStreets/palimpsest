import type { Agent, FirmView, ProviderUsage, Settings, UsageWindow } from '../../../shared/types';
import { api, type EngineEvent, type UsageState } from '../api';
import { cleanText } from './board';
import { ago, button, checkRadio, createSheet, createSwitch, el, latestWins, markBusy, plural, rovingRadios, textButton } from './controls';

export interface SettingsScreen {
  show(): void;
  hide(): void;
}

/** What leaves this Mac, word for word. */
export const LEAVES =
  "gh calls, your own claude CLI's calls to Anthropic made on your login exactly as when you use it yourself, package downloads from the registries a job needs, and, only if you turn it on, Anthropic API calls on your key. Ollama stays on this Mac.";

const PRIVACY: Array<[string, string]> = [
  ['Leaves this Mac', LEAVES],
  ['Stays here', 'Repo mirrors, the city, the ledger, every job and its work, and usage readings, all in ~/Library/Application Support/Palimpsest.'],
  ['Never read', "Your Claude, Codex and Gemini logins. Claude usage comes from the statusline hook; Codex and Gemini usage from those CLIs' own logs, read only. Palimpsest keeps no GitHub token."],
  ['Never shown', 'Your API key. It lives in your keychain, is read there only to make a call, and never comes back to this page.'],
  ['Never sent', 'No analytics, no telemetry, no account.'],
];

/** Each provider's name, and how it reaches its models, beneath the name. */
const PROVIDER_HOW: Record<ProviderUsage['provider'], [string, string]> = {
  claude: ['Claude', 'through your Claude Code'],
  'anthropic-api': ['Anthropic API', 'on a key of your own'],
  ollama: ['Ollama', 'local models on this Mac'],
  openai: ['OpenAI', "the Codex CLI's own logs, read only"],
  gemini: ['Gemini', "the Gemini CLI's own logs, read only"],
  mlx: ['MLX', 'on-device, Apple silicon'],
};

const ORDER: Array<ProviderUsage['provider']> = ['claude', 'anthropic-api', 'ollama', 'openai', 'gemini', 'mlx'];

/** The provider a model reference runs on, as Settings groups agents. */
function backendOf(model: string): ProviderUsage['provider'] | null {
  if (model.startsWith('claude:')) return 'claude';
  if (model.startsWith('anthropic:')) return 'anthropic-api';
  if (model.startsWith('ollama:')) return 'ollama';
  return null;
}

/** "Mack Quickset, Priya Rao and 3 more", for the agents that work on a provider. */
function agentNames(agents: Agent[]): string {
  const names = agents.map((a) => cleanText(a.name, 60));
  if (names.length === 2) return names.join(' and ');
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const numberFormat = new Intl.NumberFormat('en-US');
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** Claude Code reports reset times in epoch seconds; accept milliseconds too. */
function resetText(resetsAt: number, now = Date.now()): string {
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  if (!Number.isFinite(ms)) return '';
  const when = new Date(ms);
  const sameDay = new Date(now).toDateString() === when.toDateString();
  const at = sameDay ? `at ${timeFormat.format(when)}` : `${dayFormat.format(when)}, ${timeFormat.format(when)}`;
  // An old reading can name a reset that has already happened: say so, not "resets" in the past.
  return ms <= now ? `window reset ${at}` : `resets ${at}`;
}

type NumberKey = 'dayCapPct' | 'nightCapPct' | 'hardStopPct' | 'claudeConcurrency' | 'localConcurrency' | 'bidWindowSec';

/** The numbers Caps sets: each field's range, its step for the arrow keys, its unit and what it measures. */
const NUMBERS: Array<{ key: NumberKey; label: string; cls: string; lo: number; hi: number; step: number; unit: string; of: string; aria: string }> = [
  { key: 'dayCapPct', label: 'By day', cls: 'cap-day', lo: 0, hi: 100, step: 5, unit: '%', of: 'of each window', aria: 'By day, percent of each usage window' },
  { key: 'nightCapPct', label: 'By night', cls: 'cap-night', lo: 0, hi: 100, step: 5, unit: '%', of: 'of each window, for work nobody is watching', aria: 'By night, percent of each usage window' },
  { key: 'hardStopPct', label: 'Hard stop', cls: 'cap-hardstop', lo: 50, hi: 95, step: 5, unit: '%', of: 'of either window, whoever spent it: no Claude work starts past it', aria: 'Hard stop, percent of either window' },
  { key: 'claudeConcurrency', label: 'Claude at once', cls: 'cap-claude', lo: 1, hi: 4, step: 1, unit: '', of: 'runs on your plan at a time, 1 to 4', aria: 'Claude runs at once, 1 to 4' },
  { key: 'localConcurrency', label: 'Local at once', cls: 'cap-local', lo: 1, hi: 4, step: 1, unit: '', of: 'Ollama runs at a time, 1 to 4', aria: 'Local runs at once, 1 to 4' },
  { key: 'bidWindowSec', label: 'Bid window', cls: 'cap-bidwindow', lo: 30, hi: 600, step: 30, unit: 's', of: 'for the firms to bid on a new job, 30 to 600', aria: 'Bid window in seconds, 30 to 600' },
];

/**
 * Settings as a ledger: the providers the firms work on (each with what it
 * reads now and its own controls), the caps, quality, the kill switch and
 * privacy, each a section of hairline rows with the label on the left.
 */
export function createSettings(
  parent: HTMLElement,
  opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void; onStopped(stopped: boolean): void },
): SettingsScreen {
  const sheet = createSheet(parent, 'settings', 'Settings', opts.onDismiss);
  const facts = el('p', 'sheet-facts', "Where the city's work runs, what it may spend, and what leaves this Mac.");
  sheet.root.querySelector('.sheet-head')?.append(facts);
  let unlisten: (() => void) | null = null;

  function section(title: string, cls: string): HTMLElement {
    const s = el('section', `set-sec ${cls}`);
    const h = el('h2', 'set-sec-title', title);
    h.id = `set-${cls}`;
    s.setAttribute('aria-labelledby', h.id);
    s.append(h);
    sheet.body.append(s);
    return s;
  }

  function row(sec: HTMLElement, label: string, sub?: string): { row: HTMLElement; main: HTMLElement; side: HTMLElement } {
    const r = el('div', 'set-row');
    const l = el('div', 'set-label');
    l.append(el('span', 'set-label-name', label));
    if (sub) l.append(el('span', 'set-label-sub', sub));
    const main = el('div', 'set-main');
    const side = el('div', 'set-side');
    r.append(l, main, side);
    sec.append(r);
    return { row: r, main, side };
  }

  // ---------------------------------------------------------------- providers

  const providers = section('Providers', 'providers');

  interface Entry {
    el: HTMLElement;
    state: HTMLElement;
    mark: HTMLElement;
    main: HTMLElement;
    agents: HTMLElement;
  }

  /** One provider: its name and how it reaches its models on the left; what it reads now, and its controls, on the right. */
  function provEntry(id: ProviderUsage['provider']): Entry {
    const [name, how] = PROVIDER_HOW[id];
    const p = el('div', 'prov');
    p.dataset.provider = id;
    const label = el('div', 'prov-label');
    label.append(el('span', 'prov-name', name), el('span', 'prov-how', how));
    const main = el('div', 'prov-main');
    const stateLine = el('p', 'prov-state-line');
    const mark = el('i', 'prov-mark');
    mark.setAttribute('aria-hidden', 'true');
    const state = el('span', 'prov-state');
    stateLine.append(mark, state);
    const agents = el('p', 'prov-agents');
    agents.hidden = true;
    main.append(stateLine);
    p.append(label, main);
    providers.append(p);
    return { el: p, state, mark, main, agents };
  }

  function setState(e: Entry, status: ProviderUsage['status'], text: string): void {
    e.el.dataset.status = status;
    e.mark.className = `prov-mark ${status}`;
    e.state.textContent = text;
  }

  /** The agents working on a provider now, by name. */
  function fillAgents(e: Entry, id: ProviderUsage['provider'], firms: FirmView[] | null): void {
    if (!firms) {
      e.agents.hidden = true;
      return;
    }
    const using = firms.flatMap((f) => (f.status === 'bankrupt' ? [] : f.agents.filter((a) => !a.retired && backendOf(a.model) === id)));
    e.agents.hidden = false;
    e.agents.replaceChildren();
    if (!using.length) {
      e.agents.append(el('span', 'prov-agents-word', 'No agent works on it yet.'));
      return;
    }
    e.agents.append(el('span', 'prov-agents-word', `${plural(using.length, 'agent')} work on it: `), document.createTextNode(`${agentNames(using)}.`));
  }

  // Claude, through his own Claude Code: the two windows the usage hook reads, and the hook itself.
  const claude = provEntry('claude');
  /** What could not be read while the percentages held (the transcripts trend), on its own wrapped line. */
  const claudeTrouble = el('p', 'prov-trouble');
  claudeTrouble.hidden = true;
  /** When his newest statusline reading was taken, for the state line when the trend fails. */
  let readAt: number | null = null;
  const windows = el('div', 'usage-windows');
  const fiveRow = usageRow('Five hours', 'usage-five');
  const weekRow = usageRow('Week', 'usage-week');
  windows.append(fiveRow.row, weekRow.row);
  const usageFoot = el('p', 'usage-foot');
  const hookState = el('p', 'hook-state');
  const hookNote = el('p', 'set-note', 'Chains your existing statusline, so it looks the same, and records only the usage percentages Claude Code reports.');
  const hookError = el('p', 'set-error');
  hookError.hidden = true;
  const install = button('hook-install', 'Install', () => void setHook(true));
  const remove = button('hook-remove', 'Remove', () => void setHook(false));
  // Neither button shows until the engine says which state the hook is in.
  install.hidden = true;
  remove.hidden = true;
  const hookLine = el('div', 'prov-hook');
  const hookText = el('div', 'prov-hook-text');
  hookText.append(hookState, hookNote, hookError);
  hookLine.append(hookText, install, remove);
  claude.main.append(claudeTrouble, windows, usageFoot, hookLine, claude.agents);

  function usageRow(label: string, cls: string): { row: HTMLElement; main: HTMLElement } {
    const r = el('div', `usage-row ${cls}`);
    const main = el('div', 'usage-main');
    r.append(el('span', 'usage-label', label), main);
    return { row: r, main };
  }

  // The Anthropic API, on his own key: off until he turns it on.
  const apiP = provEntry('anthropic-api');
  const apiLine = el('p', 'prov-line', "Spends your API key's dollars, not your Claude plan.");
  const keyState = el('p', 'apikey-state');
  keyState.setAttribute('aria-live', 'polite');
  const keyClear = textButton('apikey-clear', 'Remove the key', () => void clearKey());
  keyClear.hidden = true;
  const keyRow = el('div', 'apikey-row');
  keyRow.append(keyState, keyClear);
  const keyForm = el('form', 'apikey-form');
  const keyInput = el('input', 'apikey-input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = 'Paste a key: sk-ant-…';
  keyInput.setAttribute('aria-label', 'Anthropic API key');
  // Password managers are told to leave it alone: the key is for the keychain, not for a vault's form filler.
  keyInput.setAttribute('data-1p-ignore', '');
  keyInput.setAttribute('data-lpignore', 'true');
  const keySave = el('button', 'btn apikey-save', 'Store in keychain');
  keySave.type = 'submit';
  keyForm.append(keyInput, keySave);
  const keyError = el('p', 'set-error apikey-error');
  keyError.setAttribute('aria-live', 'polite');
  keyError.hidden = true;
  const apiControls = el('div', 'apikey-controls');
  const enable = createSwitch('apikey-enable', 'Let firms work on the Anthropic API', (on) => apiSync.set({ enabled: on }));
  const enableWrap = el('div', 'apikey-enable-wrap');
  const enableText = el('span', 'apikey-enable-text', 'Let firms work on it');
  enableText.addEventListener('click', () => enable.el.click());
  enableWrap.append(enable.el, enableText);
  const dailyWrap = el('label', 'apikey-daily-wrap cap-field');
  const daily = el('input', 'apikey-daily cap');
  daily.type = 'text';
  daily.inputMode = 'decimal';
  daily.maxLength = 6;
  daily.setAttribute('aria-label', 'Daily dollar limit for the Anthropic API');
  dailyWrap.append(el('span', 'cap-unit', '$'), daily);
  const dailyLine = el('div', 'apikey-daily-line');
  dailyLine.append(dailyWrap, el('span', 'cap-of', 'a day at most'));
  apiControls.append(enableWrap, dailyLine);
  apiP.main.append(apiLine, keyRow, keyForm, keyError, apiControls, apiP.agents);
  let savedDaily = 0;
  const apiSync = latestWins<Partial<Settings['anthropicApi']>>(
    async (v) => {
      fillApiSettings(await api.patchSettings({ anthropicApi: v }));
    },
    (busy) => markBusy(enable.el, busy),
  );
  const commitDaily = (): void => {
    const n = Number(daily.value.replace(/^\$/, ''));
    if (daily.value.trim() === '' || !Number.isFinite(n)) {
      daily.value = String(savedDaily);
      return;
    }
    const v = Math.max(0, Math.min(100, Math.round(n * 100) / 100));
    daily.value = String(v);
    if (v !== savedDaily) apiSync.set({ dailyUsd: v });
  };
  daily.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDaily();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      daily.value = String(savedDaily);
      daily.blur();
    }
  });
  daily.addEventListener('blur', commitDaily);
  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void storeKey();
  });

  function fillApiSettings(st: Settings): void {
    enable.set(apiSync.want?.enabled ?? st.anthropicApi.enabled);
    savedDaily = st.anthropicApi.dailyUsd;
    if (document.activeElement !== daily) daily.value = String(savedDaily);
  }

  function fillKey(set: boolean | null): void {
    keyState.replaceChildren(el('span', `hook-mark${set ? ' on' : ''}`), document.createTextNode(set === null ? 'The keychain could not be asked.' : set ? 'A key is stored in your keychain.' : 'No key stored.'));
    keyClear.hidden = !set;
    keySave.textContent = set ? 'Replace' : 'Store in keychain';
  }

  async function storeKey(): Promise<void> {
    const key = keyInput.value.trim();
    keyError.hidden = true;
    if (!key) {
      keyInput.focus();
      return;
    }
    // The key leaves the page at once: the field is emptied before the request settles.
    keyInput.value = '';
    keySave.disabled = true;
    try {
      await api.setApiKey(key);
    } catch (err) {
      keyError.textContent = err instanceof Error ? err.message : String(err);
      keyError.hidden = false;
    } finally {
      keySave.disabled = false;
    }
    fillKey((await api.apiKeySet().catch(() => null))?.set ?? null);
  }

  async function clearKey(): Promise<void> {
    keyError.hidden = true;
    keyClear.disabled = true;
    try {
      await api.removeApiKey();
    } catch (err) {
      keyError.textContent = err instanceof Error ? err.message : String(err);
      keyError.hidden = false;
    } finally {
      keyClear.disabled = false;
    }
    fillKey((await api.apiKeySet().catch(() => null))?.set ?? null);
    keyInput.focus({ preventScroll: true });
  }

  // Ollama, the two CLIs, and MLX.
  const ollama = provEntry('ollama');
  const ollamaModels = el('ul', 'prov-models');
  ollamaModels.setAttribute('aria-label', 'Installed models');
  ollama.main.append(ollamaModels, ollama.agents);
  const openai = provEntry('openai');
  const openaiWindows = el('div', 'prov-windows');
  const openaiTokens = el('p', 'prov-tokens');
  openai.main.append(openaiWindows, openaiTokens);
  const gemini = provEntry('gemini');
  const geminiTokens = el('p', 'prov-tokens');
  gemini.main.append(geminiTokens);
  const mlx = provEntry('mlx');
  const entries: Record<ProviderUsage['provider'], Entry> = { claude, 'anthropic-api': apiP, ollama, openai, gemini, mlx };

  const tokensText = (t: { today: number; week: number } | null): string =>
    t ? `${numberFormat.format(t.today)} tokens today, ${numberFormat.format(t.week)} this week` : 'No tokens read in the last 7 days.';

  /** Claude's last answer from GET /api/providers, kept so a newer usage reading can redraw its state line. */
  let lastClaude: ProviderUsage | null = null;

  /** Claude's state line: what failed (the transcripts trend) apart from what held (the statusline percentages, and when they were read). */
  function fillClaudeState(): void {
    const c = lastClaude;
    const trouble = c?.trouble ? cleanText(c.trouble, 400) : '';
    claudeTrouble.textContent = trouble ? `${trouble}${/[.!?]$/.test(trouble) ? '' : '.'}` : '';
    claudeTrouble.hidden = !trouble;
    if (!c || c.status === 'unknown') return;
    const held = `The statusline percentages held${readAt ? `, read ${ago(readAt)}` : ''}.`;
    setState(claude, c.status, c.status !== 'ready' ? 'No usage reading yet.' : trouble ? held : `${cleanText(c.detail, 160).replace(/\d+(\.\d+)?/g, (n) => numberFormat.format(Number(n)))}.`);
  }

  /** What each provider reads now, from GET /api/providers, and who works on it. */
  function fillProviders(list: ProviderUsage[] | null, firms: FirmView[] | null): void {
    const by = new Map((list ?? []).map((p) => [p.provider, p] as const));
    for (const id of ORDER) {
      const p = by.get(id);
      if (!p) setState(entries[id], 'unknown', list ? 'Not read.' : 'The engine did not answer.');
      else if (p.status === 'unknown') setState(entries[id], 'unknown', cleanText(p.detail, 400));
    }

    lastClaude = by.get('claude') ?? null;
    fillClaudeState();
    fillAgents(claude, 'claude', firms);

    const a = by.get('anthropic-api');
    if (a && a.status !== 'unknown') setState(apiP, a.status, a.status === 'off' ? 'Off. No firm works on it until you turn it on.' : a.spendUsd ? `On: $${a.spendUsd.today.toFixed(2)} spent today, $${a.spendUsd.week.toFixed(2)} this week.` : 'On.');
    fillAgents(apiP, 'anthropic-api', firms);

    const o = by.get('ollama');
    ollamaModels.replaceChildren();
    ollamaModels.hidden = true;
    if (o && o.status !== 'unknown') {
      const host = o.host ?? '';
      setState(ollama, o.status, o.status === 'ready' ? `Reachable at ${host}` : `Not reachable${host ? ` at ${host}` : ''}. Local agents wait until it answers.`);
      for (const m of o.models ?? []) ollamaModels.append(el('li', 'prov-model', cleanText(m, 80)));
      if (o.status === 'ready' && !(o.models ?? []).length) ollamaModels.append(el('li', 'prov-none', 'No models installed.'));
      ollamaModels.hidden = ollamaModels.childElementCount === 0;
    }
    fillAgents(ollama, 'ollama', firms);

    const x = by.get('openai');
    openaiWindows.replaceChildren();
    openaiTokens.textContent = '';
    if (x && x.status !== 'unknown') {
      setState(openai, x.status, x.status === 'not-found' ? 'Codex CLI not found on this Mac' : `${cleanText(x.detail, 120).replace(/^Plan windows from the latest Codex session$/, 'Your plan, from your latest Codex session')}.`);
      for (const w of x.windows) openaiWindows.append(miniWindow(w.label, w.usedPct, w.resetsAt));
      if (x.status === 'ready') openaiTokens.textContent = tokensText(x.tokens);
    }
    openaiWindows.hidden = openaiWindows.childElementCount === 0;

    const g = by.get('gemini');
    geminiTokens.textContent = '';
    if (g && g.status !== 'unknown') {
      setState(gemini, g.status, g.status === 'not-found' ? 'Gemini CLI not found on this Mac' : 'Tokens only: the Gemini CLI reports no plan percentages.');
      if (g.status === 'ready') geminiTokens.textContent = tokensText(g.tokens);
    }

    const m = by.get('mlx');
    if (m && m.status !== 'unknown') setState(mlx, m.status, m.status === 'later' ? 'Arrives with the school.' : cleanText(m.detail, 120));
  }

  /** A window the Codex CLI reports: its share used, ruled as a short meter, and when it resets. */
  function miniWindow(label: string, usedPct: number | null, resetsAt: number | null): HTMLElement {
    const w = el('div', 'prov-window');
    const pct = usedPct === null ? null : Math.max(0, Math.min(100, Math.round(usedPct)));
    const name = label === '5 hours' ? 'Five hours' : label === 'week' ? 'Week' : label;
    w.append(el('span', 'prov-window-label', name), el('span', 'prov-window-pct', pct === null ? 'unread' : `${pct}%`));
    const meter = el('span', 'prov-window-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(pct ?? 0));
    meter.setAttribute('aria-label', `${name} used`);
    const fill = el('span', 'prov-window-fill');
    fill.style.width = `${pct ?? 0}%`;
    meter.append(fill);
    w.append(meter, el('span', 'prov-window-reset', resetsAt ? resetText(resetsAt) : ''));
    return w;
  }

  function fillWindow(r: { main: HTMLElement }, w: UsageWindow | null | undefined): void {
    r.main.replaceChildren();
    if (!w) {
      r.main.append(el('span', 'usage-none', 'No reading'));
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercentage)));
    const line = el('div', 'usage-line');
    line.append(el('span', 'usage-pct', `${pct}%`), el('span', 'usage-used', 'used'), el('span', 'usage-reset', resetText(w.resetsAt)));
    const meter = el('div', 'usage-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-label', 'Used');
    const fill = el('span', 'usage-fill');
    fill.style.width = `${pct}%`;
    meter.append(fill);
    r.main.append(line, meter);
  }

  function fillUsage(u: UsageState | null): void {
    readAt = u?.reading?.at ?? null;
    if (lastClaude) fillClaudeState();
    fillWindow(fiveRow, u?.reading?.fiveHour);
    fillWindow(weekRow, u?.reading?.sevenDay);
    usageFoot.replaceChildren();
    if (!u) {
      usageFoot.append(el('span', 'set-error', 'The engine did not answer.'));
    } else if (!u.reading) {
      usageFoot.textContent = u.hookInstalled
        ? 'No reading yet. Use Claude Code once and it arrives here.'
        : 'No reading yet. Install the hook below, then use Claude Code once.';
    } else if (u.stale) {
      const warn = el('span', 'usage-stale', `Last reading ${ago(u.reading.at)}, so these numbers may be out of date.`);
      usageFoot.append(warn, el('span', 'usage-stale-hint', ' Claude Code sends a new one while you use it.'));
    } else {
      usageFoot.textContent = `Read ${ago(u.reading.at)} from your Claude Code statusline.`;
    }
  }

  // ---------------------------------------------------------------- caps

  const caps = section('Caps', 'caps');
  const capFields = new Map<NumberKey, { setSaved(v: number): void; hide(): void }>();
  for (const n of NUMBERS) capFields.set(n.key, numberRow(n));
  const awakeRow = row(caps, 'Keep awake');
  awakeRow.row.classList.add('awake-row');
  const awake = createSwitch('awake', 'Keep the Mac awake while the city is working', (on) => awakeSync.set(on));
  const awakeSync = latestWins<boolean>(
    async (on) => {
      awake.set((await api.patchSettings({ keepAwake: on })).keepAwake);
    },
    (busy) => markBusy(awake.el, busy),
  );
  const awakeText = el('p', 'set-text awake-text', 'Keeps the Mac awake while the city is working.');
  awakeText.addEventListener('click', () => awake.el.click());
  awakeRow.main.append(awakeText, el('p', 'set-note', 'Only while a run is under way. The display may still sleep, and closing the lid still sleeps the Mac.'));
  awakeRow.side.append(awake.el);
  awake.el.hidden = true;
  const capsDown = el('p', 'set-foot');
  caps.append(capsDown, el('p', 'set-foot', 'The most of each usage window the city may spend, and how much of it runs at once. The treasury shows them against your plan.'));

  /** A number field: type a number and press Enter (or leave it), or step with the arrow keys; held to its range. */
  function numberRow(n: (typeof NUMBERS)[number]): { setSaved(v: number): void; hide(): void } {
    const r = row(caps, n.label);
    const field = el('label', 'cap-field');
    const input = el('input', `cap ${n.cls}`);
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = String(n.hi).length;
    input.style.width = `${Math.max(2.6, String(n.hi).length + 0.6)}ch`;
    input.setAttribute('aria-label', n.aria);
    field.append(input);
    if (n.unit) field.append(el('span', 'cap-unit', n.unit));
    r.main.append(field, el('span', 'cap-of', n.of));
    let saved = 0;
    // One PATCH at a time, the last value typed winning; a value already saved or already on its way is not sent again.
    const sync = latestWins<number>(
      async (v) => {
        saved = (await api.patchSettings({ [n.key]: v }))[n.key];
      },
      (busy) => {
        if (!busy) input.value = String(saved);
      },
    );
    const commit = (value: number): void => {
      const v = Math.max(n.lo, Math.min(n.hi, Math.round(value)));
      input.value = String(v);
      if (sync.busy ? v === sync.want : v === saved) return;
      sync.set(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const now = Number(input.value) || 0;
        commit(e.key === 'ArrowUp' ? Math.floor(now / n.step) * n.step + n.step : Math.ceil(now / n.step) * n.step - n.step);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(v)) input.value = String(saved);
        else commit(v);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        input.value = String(saved);
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      const v = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(v)) input.value = String(saved);
      else commit(v);
    });
    field.hidden = true;
    return {
      setSaved(v) {
        saved = v;
        input.value = String(v);
        field.hidden = false;
      },
      hide() {
        field.hidden = true;
      },
    };
  }

  // ---------------------------------------------------------------- quality

  const quality = section('Quality', 'quality');
  const qRow = row(quality, 'The city');
  const qGroup = el('div', 'quality-picker');
  qGroup.setAttribute('role', 'radiogroup');
  qGroup.setAttribute('aria-label', 'Rendering quality');
  const QUALITIES: Array<[Settings['quality'], string, string]> = [
    ['high', 'High', 'Full shadows and reflections'],
    ['medium', 'Medium', 'Lighter shadows, for older Macs'],
  ];
  for (const [value, name, what] of QUALITIES) {
    const b = el('button', 'quality-choice');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.quality = value;
    b.append(el('span', 'quality-mark'), el('span', 'quality-name', name), el('span', 'quality-what', what));
    b.addEventListener('click', () => void pickQuality(b));
    qGroup.append(b);
  }
  rovingRadios(qGroup, (b) => void pickQuality(b));
  let loadedQuality: Settings['quality'] | null = null;
  const qNote = el('p', 'set-note quality-note');
  qRow.main.append(qGroup, qNote);

  async function pickQuality(b: HTMLElement): Promise<void> {
    const q = b.dataset.quality as Settings['quality'];
    checkRadio(qGroup, b);
    try {
      const s = await api.patchSettings({ quality: q });
      fillQualityNote(s.quality);
    } catch {
      /* the choice stays as shown; the next open reads the stored value */
    }
  }

  /** The city reads quality once when it opens: say so, and offer to reopen it when the choice differs. */
  function fillQualityNote(now: Settings['quality']): void {
    qNote.replaceChildren();
    if (loadedQuality && now !== loadedQuality) {
      qNote.append(document.createTextNode('Takes effect when the city reopens. '), textButton('quality-reload', 'Reopen now', () => location.reload()));
    } else {
      qNote.textContent = 'Read when the city opens.';
    }
  }

  // ---------------------------------------------------------------- kill switch

  const stop = section('Kill switch', 'stop');
  const stopRow = row(stop, 'Stop everything');
  const stopState = el('p', 'stop-state');
  stopState.setAttribute('aria-live', 'polite');
  stopRow.main.append(
    stopState,
    el('p', 'set-note', 'Stops new runs at once, and running ones within five seconds; nothing starts again until you turn it off. It writes a stop file in the data folder, and off removes it.'),
  );
  const kill = createSwitch('kill', 'Stop everything', (on) => killSync.set(on));
  const killSync = latestWins<boolean>(setStopped, (busy) => markBusy(kill.el, busy));
  stopRow.side.append(kill.el);

  function fillStop(stopped: boolean): void {
    // While a request is in flight the switch keeps showing what the user last asked for.
    kill.set(killSync.want ?? stopped);
    stopRow.row.classList.toggle('stopped', stopped);
    stopState.textContent = stopped ? 'Stopped. The stop file is in place.' : 'Running';
    opts.onStopped(stopped);
  }

  async function setStopped(on: boolean): Promise<void> {
    try {
      fillStop((await api.stop(on)).stopped);
    } catch {
      const h = await api.health().catch(() => null);
      fillStop(h?.stopped ?? !on);
    }
  }

  // ---------------------------------------------------------------- privacy

  const privacy = section('Privacy', 'privacy');
  privacy.classList.add('settings-privacy');
  const DATA_PATH = '~/Library/Application Support/Palimpsest';
  for (const [label, text] of PRIVACY) {
    const p = el('p', 'set-text');
    // The data folder's path never breaks across lines.
    const [before, after] = text.split(DATA_PATH);
    p.append(before);
    if (after !== undefined) p.append(el('span', 'set-path', DATA_PATH), after);
    const r = row(privacy, label);
    r.row.dataset.privacy = label;
    r.main.append(p);
  }

  // ---------------------------------------------------------------- hook

  function fillHook(installed: boolean): void {
    hookState.replaceChildren(el('span', `hook-mark${installed ? ' on' : ''}`), document.createTextNode(installed ? 'Usage hook installed' : 'Usage hook not installed'));
    install.hidden = installed;
    remove.hidden = !installed;
  }

  async function setHook(on: boolean): Promise<void> {
    hookError.hidden = true;
    const pressed = on ? install : remove;
    pressed.disabled = true;
    try {
      const r = on ? await api.installHook() : await api.uninstallHook();
      fillHook(r.hookInstalled);
      (r.hookInstalled ? remove : install).focus({ preventScroll: true });
      fillUsage(await api.usage().catch(() => null));
    } catch (err) {
      hookError.textContent = err instanceof Error ? err.message : String(err);
      hookError.hidden = false;
    } finally {
      pressed.disabled = false;
    }
  }

  // ---------------------------------------------------------------- load

  async function load(): Promise<void> {
    const [s, u, h, ps, key, firms] = await Promise.all([
      api.settings().catch(() => null),
      api.usage().catch(() => null),
      api.health().catch(() => null),
      api.providers().catch(() => null),
      api.apiKeySet().catch(() => null),
      api.firms().catch(() => null),
    ]);
    if (s) {
      loadedQuality ??= s.quality;
      fillHook(s.hookInstalled);
      for (const n of NUMBERS) capFields.get(n.key)?.setSaved(s[n.key]);
      awake.set(awakeSync.want ?? s.keepAwake);
      awake.el.hidden = false;
      fillApiSettings(s);
      apiControls.hidden = false;
      checkRadio(qGroup, qGroup.querySelector<HTMLElement>(`[data-quality="${s.quality}"]`));
      fillQualityNote(s.quality);
      qGroup.hidden = false;
      capsDown.replaceChildren();
    } else fillUnavailable();
    fillUsage(u);
    fillProviders(ps, firms);
    fillKey(key ? key.set : null);
    if (h) fillStop(h.stopped);
  }

  /** Settings could not be read: say so where the values would be, rather than show empty fields. */
  function fillUnavailable(): void {
    hookState.replaceChildren(el('span', 'set-error', 'The engine did not answer.'));
    install.hidden = true;
    remove.hidden = true;
    for (const main of [capsDown, qNote]) main.replaceChildren(el('span', 'set-error', 'The engine did not answer.'));
    qGroup.hidden = true;
    awake.el.hidden = true;
    apiControls.hidden = true;
    for (const f of capFields.values()) f.hide();
  }

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.stopped' || e.type === 'engine.resumed') fillStop(e.type === 'engine.stopped');
  }

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
