import type { Settings, UsageWindow } from '../../../shared/types';
import { api, type EngineEvent, type UsageState } from '../api';
import { ago, button, checkRadio, createSheet, createSwitch, el, rovingRadios, textButton } from './controls';

export interface SettingsScreen {
  show(): void;
  hide(): void;
}

const LATER: Array<[string, string]> = [
  ['Anthropic API key', 'Claude through a key of your own'],
  ['Ollama', 'local models'],
  ['MLX', 'on-device models on Apple silicon'],
  ['OpenAI', 'GPT models through your key'],
  ['Gemini', 'Google models through your key'],
];

const PRIVACY: Array<[string, string]> = [
  ['Leaves this Mac', 'Only gh calls to GitHub, made with your own gh login. Palimpsest keeps no GitHub token.'],
  ['Stays here', 'Repo mirrors, the city, the ledger and usage readings, all in ~/Library/Application Support/Palimpsest.'],
  ['Never read', 'Your Claude login or keys. Usage comes only from the statusline hook.'],
  ['Never sent', 'No analytics, no telemetry, no account.'],
];

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

/**
 * Settings as a ledger: providers, usage, caps, quality, the kill switch and
 * privacy, each a section of hairline rows with the label on the left.
 */
export function createSettings(
  parent: HTMLElement,
  opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void; onStopped(stopped: boolean): void },
): SettingsScreen {
  const sheet = createSheet(parent, 'settings', 'Settings', opts.onDismiss);
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
  const claude = row(providers, 'Claude', 'through your Claude Code');
  const hookState = el('p', 'hook-state');
  const hookNote = el(
    'p',
    'set-note',
    'Chains your existing statusline, so it looks the same, and records only the usage percentages Claude Code reports.',
  );
  const hookError = el('p', 'set-error');
  hookError.hidden = true;
  claude.main.append(hookState, hookNote, hookError);
  const install = button('hook-install', 'Install', () => void setHook(true));
  const remove = button('hook-remove', 'Remove', () => void setHook(false));
  claude.side.append(install, remove);

  const later = row(providers, 'Later', 'with the market');
  const laterList = el('ul', 'set-later');
  for (const [name, what] of LATER) {
    const li = el('li');
    li.append(el('span', 'set-later-name', name), el('span', 'set-later-what', what));
    laterList.append(li);
  }
  later.main.append(laterList);

  // ---------------------------------------------------------------- usage

  const usage = section('Usage', 'usage');
  const fiveRow = row(usage, 'Five-hour window');
  fiveRow.row.classList.add('usage-five');
  const weekRow = row(usage, 'Weekly');
  weekRow.row.classList.add('usage-week');
  const usageFoot = el('p', 'usage-foot');
  usage.append(usageFoot);

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
    fillWindow(fiveRow, u?.reading?.fiveHour);
    fillWindow(weekRow, u?.reading?.sevenDay);
    usageFoot.replaceChildren();
    if (!u) {
      usageFoot.append(el('span', 'set-error', 'The engine did not answer.'));
    } else if (!u.reading) {
      usageFoot.textContent = u.hookInstalled
        ? 'No reading yet. Use Claude Code once and it arrives here.'
        : 'No reading yet. Install the hook above, then use Claude Code once.';
    } else if (u.stale) {
      const warn = el('span', 'usage-stale', `Last reading ${ago(u.reading.at)}, so these numbers may be out of date.`);
      usageFoot.append(warn, el('span', 'usage-stale-hint', ' Claude Code sends a new one while you use it.'));
    } else {
      usageFoot.textContent = `Read ${ago(u.reading.at)} from your Claude Code statusline.`;
    }
  }

  // ---------------------------------------------------------------- caps

  const caps = section('Caps', 'caps');
  const capFields: Record<'dayCapPct' | 'nightCapPct', { setSaved(v: number): void }> = {
    dayCapPct: capRow('By day', 'cap-day', 'dayCapPct'),
    nightCapPct: capRow('By night', 'cap-night', 'nightCapPct'),
  };
  caps.append(el('p', 'set-foot', 'The most of each usage window the city may spend. Stored now, enforced when the market opens.'));

  /** A cap field: type a number and press Enter (or leave it), or step by 5 with the arrow keys. */
  function capRow(label: string, cls: string, key: 'dayCapPct' | 'nightCapPct'): { setSaved(v: number): void } {
    const r = row(caps, label);
    const field = el('label', 'cap-field');
    const input = el('input', `cap ${cls}`);
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = 3;
    input.setAttribute('aria-label', `${label}, percent of each usage window`);
    field.append(input, el('span', 'cap-unit', '%'));
    r.main.append(field, el('span', 'cap-of', 'of each window'));
    let saved = 0;
    const commit = async (value: number): Promise<void> => {
      const v = Math.max(0, Math.min(100, Math.round(value)));
      input.value = String(v);
      if (v === saved) return;
      try {
        const s = await api.patchSettings({ [key]: v });
        saved = s[key];
        input.value = String(saved);
      } catch {
        input.value = String(saved);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const now = Number(input.value) || 0;
        void commit(e.key === 'ArrowUp' ? Math.floor(now / 5) * 5 + 5 : Math.ceil(now / 5) * 5 - 5);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const n = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(n)) input.value = String(saved);
        else void commit(n);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        input.value = String(saved);
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      const n = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(n)) input.value = String(saved);
      else void commit(n);
    });
    return {
      setSaved(v) {
        saved = v;
        input.value = String(v);
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
    el('p', 'set-note', 'Writes a stop file in the data folder. From the market on, nothing starts while it is there. Turn it off to remove the file.'),
  );
  const kill = createSwitch('kill', 'Stop everything', (on) => void setStopped(on));
  stopRow.side.append(kill.el);

  function fillStop(stopped: boolean): void {
    kill.set(stopped);
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
    row(privacy, label).main.append(p);
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
    const [s, u, h] = await Promise.all([api.settings().catch(() => null), api.usage().catch(() => null), api.health().catch(() => null)]);
    if (s) {
      loadedQuality ??= s.quality;
      fillHook(s.hookInstalled);
      capFields.dayCapPct.setSaved(s.dayCapPct);
      capFields.nightCapPct.setSaved(s.nightCapPct);
      checkRadio(qGroup, qGroup.querySelector<HTMLElement>(`[data-quality="${s.quality}"]`));
      fillQualityNote(s.quality);
    }
    fillUsage(u);
    if (h) fillStop(h.stopped);
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
