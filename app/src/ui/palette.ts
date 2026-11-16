/**
 * The command palette (Phase 5): Cmd+K or Ctrl+K opens one centred popup
 * over the city or any screen, with one ranked list across everything the
 * app knows (palette-sources.ts), graded by palette-rank.ts. Enter or a
 * click goes there; Escape or a click outside closes it; focus is held
 * inside while it is open and goes back where it was after. The running
 * head mounts it (runhead.ts), so main.ts stays as it is.
 */
import { api } from '../api';
import { navigate } from '../router';
import { el } from './controls';
import { handoffs } from './handoffs';
import { rank, rememberPick, tallyLine, type PaletteEntry, type RecentPick } from './palette-rank';
import { paletteSources, type PaletteSource } from './palette-sources';

export interface Palette {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly shown: boolean;
}

/** Where the recent picks are kept between windows. */
export const RECENT_KEY = 'palimpsest.palette.recent';
/** Rows shown at once: the recent picks and the first of each kind on an empty query, the best matches on one. */
const ROWS_EMPTY = 12;
const ROWS_QUERY = 12;

/** The shortcut as the running head prints it for this Mac, or for another machine. */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}

/** Whether a key event is the palette's shortcut: Cmd+K or Ctrl+K, without Alt. */
export function isPaletteKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey;
}

function readRecent(): RecentPick[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((r): r is RecentPick => typeof r?.key === 'string' && typeof r?.at === 'number') : [];
  } catch {
    return [];
  }
}

function writeRecent(list: RecentPick[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* a window without storage forgets its picks; nothing else changes */
  }
}

export function createPalette(parent: HTMLElement, opts: { sources?: PaletteSource[] } = {}): Palette {
  const sources =
    opts.sources ??
    paletteSources(api, {
      navigate: (route, id = null) => navigate(route, id),
      flyToTower: (repo) => handoffs.flyToTower?.(repo) ?? false,
      flyToQuarter: (firmId) => handoffs.flyToQuarter?.(firmId) ?? false,
    });
  const kinds = sources.map((s) => s.kind);
  const labels = new Map(sources.map((s) => [s.kind, s.label]));

  const scrim = el('div', 'palette-scrim');
  scrim.hidden = true;
  const root = el('div', 'palette');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Find anything in the city');
  const find = el('div', 'palette-find');
  const input = el('input', 'palette-input');
  input.type = 'text';
  input.placeholder = 'Find a district, a firm, an agent, a job, a page';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', 'Find anything in the city');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  const esc = el('span', 'palette-esc', 'Esc closes');
  esc.setAttribute('aria-hidden', 'true');
  find.append(input, esc);
  const list = el('ul', 'palette-list');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Results');
  const foot = el('p', 'palette-foot');
  foot.setAttribute('aria-live', 'polite');
  root.append(find, list, foot);
  parent.append(scrim, root);

  /** Each source's last read, by kind, in the sources' order when flattened. */
  const byKind = new Map<string, PaletteEntry[]>();
  const entries = (): PaletteEntry[] => sources.flatMap((s) => byKind.get(s.kind) ?? []);
  let recent = readRecent();
  let shown: PaletteEntry[] = [];
  let selected = 0;
  let open = false;
  let before: Element | null = null;
  let unlisten: (() => void) | null = null;
  /** The sources an event made stale, re-read together a moment later. */
  const stale = new Set<PaletteSource>();
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which open this read belongs to: a read that lands after a close, or after the next open, changes nothing. */
  let generation = 0;

  const tally = (): string => tallyLine(sources.flatMap((s) => s.tally ?? []));

  function render(): void {
    const q = input.value;
    const ranked = rank(q, entries(), recent, kinds);
    const keep = shown[selected]?.key;
    shown = ranked.slice(0, q.trim() ? ROWS_QUERY : ROWS_EMPTY);
    const kept = shown.findIndex((e) => e.key === keep);
    selected = q.trim() && kept < 0 ? 0 : Math.max(0, Math.min(kept < 0 ? selected : kept, shown.length - 1));
    list.replaceChildren(
      ...shown.map((e, i) => {
        const li = el('li', 'palette-row');
        li.id = `palette-opt-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === selected));
        li.dataset.key = e.key;
        li.dataset.kind = e.kind;
        li.append(el('span', 'palette-kind', labels.get(e.kind) ?? e.kind), el('span', 'palette-name', e.name), el('span', 'palette-state', e.state));
        li.addEventListener('mousemove', () => {
          if (selected !== i) select(i);
        });
        li.addEventListener('click', () => pick(e));
        return li;
      }),
    );
    if (shown.length) input.setAttribute('aria-activedescendant', `palette-opt-${selected}`);
    else input.removeAttribute('aria-activedescendant');
    foot.classList.toggle('palette-foot-tally', !q.trim());
    if (!q.trim()) foot.textContent = byKind.size ? tally() : '';
    else if (!ranked.length) foot.textContent = `Nothing in the city answers to “${q.trim()}”.`;
    else foot.textContent = ranked.length > shown.length ? `${shown.length} of ${ranked.length} shown. Keep typing to narrow it.` : '';
  }

  function select(i: number): void {
    if (!shown.length) return;
    selected = (i + shown.length) % shown.length;
    list.querySelectorAll<HTMLElement>('.palette-row').forEach((row, k) => row.setAttribute('aria-selected', String(k === selected)));
    input.setAttribute('aria-activedescendant', `palette-opt-${selected}`);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  async function read(which: PaletteSource[]): Promise<void> {
    const gen = generation;
    const lists = await Promise.all(which.map((s) => s.read().catch(() => null)));
    if (gen !== generation || !open) return;
    which.forEach((s, i) => {
      if (lists[i]) byKind.set(s.kind, lists[i]!);
    });
    render();
  }

  function pick(e: PaletteEntry): void {
    recent = rememberPick(recent, e.key, Date.now());
    writeRecent(recent);
    close();
    e.go();
  }

  function show(): void {
    if (open) return;
    open = true;
    generation++;
    before = document.activeElement;
    document.body.dataset.palette = '';
    scrim.hidden = false;
    root.hidden = false;
    input.value = '';
    selected = 0;
    shown = [];
    render();
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (!open) return;
      scrim.classList.add('open');
      root.classList.add('open');
    });
    // Everything read afresh on each open; what the last open read stands meanwhile.
    void read(sources);
    unlisten = handoffs.listen?.((ev) => {
      for (const s of sources) if (s.stale(ev.type)) stale.add(s);
      if (!stale.size || staleTimer) return;
      staleTimer = setTimeout(() => {
        staleTimer = null;
        const which = [...stale];
        stale.clear();
        void read(which);
      }, 200);
    }) ?? null;
  }

  function close(): void {
    if (!open) return;
    open = false;
    generation++;
    unlisten?.();
    unlisten = null;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    stale.clear();
    scrim.classList.remove('open');
    root.classList.remove('open');
    scrim.hidden = true;
    root.hidden = true;
    delete document.body.dataset.palette;
    const back = before instanceof HTMLElement && before.isConnected && before.checkVisibility() ? before : document.querySelector<HTMLElement>('#city canvas');
    back?.focus({ preventScroll: true });
    before = null;
  }

  input.addEventListener('input', () => {
    selected = 0;
    render();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === 'Home' && !input.value) {
      e.preventDefault();
      select(0);
    } else if (e.key === 'End' && !input.value) {
      e.preventDefault();
      select(shown.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const e1 = shown[selected];
      if (e1) pick(e1);
    } else if (e.key === 'Tab') {
      // The field is the one stop inside: focus stays on it.
      e.preventDefault();
    }
  });
  scrim.addEventListener('click', close);
  // Cmd+K or Ctrl+K from anywhere, a field included; the same again closes it.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!isPaletteKey(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (open) close();
      else show();
    },
    true,
  );
  // Focus that lands outside while it is open (a pointer on the city, say) comes back to the field.
  document.addEventListener('focusin', (e) => {
    if (open && !root.contains(e.target as Node)) input.focus({ preventScroll: true });
  });

  return {
    el: root,
    open: show,
    close,
    get shown() {
      return open;
    },
  };
}
