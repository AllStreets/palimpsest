/**
 * The city's notices: what it did by itself (stood on plain blocks without
 * the kits, stepped down in quality), what a key could not do just now, and
 * the quiet lines of the morning. They stand in a short column that hangs
 * from the running head's end, newest on the head's own line, each its own
 * ruled line with its own Dismiss. The column fades after a few seconds; a
 * small bronze mark before it, at the head's end, stays to recall it. While a sheet is
 * open the column stands to the sheet's right, never over it.
 */

/** How long the column stands before it fades. */
export const NOTICE_MS = 6000;
/** How many notices the column keeps. */
export const NOTICES_KEPT = 3;
/** The space between an open sheet's edge and the column beside it. */
const BESIDE_GAP = 28;

export interface Kept {
  /** The notice's key: the one it was given, or its own words. */
  key: string;
  text: string;
}

/**
 * The column's notices, newest first, without the page: a notice with a
 * key replaces the one with that key, and one without is keyed by its own
 * words, so the same line said twice stands once.
 */
export function noticeStack(cap = NOTICES_KEPT): {
  add(text: string, o?: { key?: string }): { replaced: boolean };
  dismiss(key: string): boolean;
  list(): Kept[];
  texts(): string[];
} {
  const kept: Kept[] = [];
  return {
    add(text, o = {}) {
      const key = o.key ?? text;
      const at = kept.findIndex((n) => n.key === key);
      if (at >= 0) kept.splice(at, 1);
      kept.unshift({ key, text });
      if (kept.length > cap) kept.length = cap;
      return { replaced: at >= 0 };
    },
    dismiss(key) {
      const at = kept.findIndex((n) => n.key === key);
      if (at < 0) return false;
      kept.splice(at, 1);
      return true;
    },
    list: () => kept.map((n) => ({ ...n })),
    texts: () => kept.map((n) => n.text),
  };
}

export interface Notices {
  /** Shows a notice at the top of the column; with a key it replaces the notice that has that key. */
  add(text: string, o?: { key?: string }): void;
  /** Takes one notice away by its key (or its words, for one given no key). */
  dismiss(key: string): void;
  /** The notices showing, joined newest first, or '' when the column has faded or holds none. */
  text(): string;
  /** Every notice the column keeps, newest first, shown or faded. */
  texts(): string[];
}

let ids = 0;

export function createNotices(parent: HTMLElement): Notices {
  const doc = parent.ownerDocument;
  const stack = noticeStack();
  const box = doc.createElement('div');
  box.className = 'city-notice';
  box.hidden = true;
  const list = doc.createElement('ul');
  list.className = 'city-notice-list';
  list.id = `city-notices-${++ids}`;
  list.setAttribute('aria-label', 'Notices');
  const recall = doc.createElement('button');
  recall.type = 'button';
  recall.className = 'city-notice-recall';
  recall.textContent = 'Notice';
  recall.title = 'Show the last notices again';
  recall.setAttribute('aria-controls', list.id);
  recall.setAttribute('aria-expanded', 'false');
  // What a screen reader hears: the newest notice as it comes, and the column again when it is recalled.
  const said = doc.createElement('p');
  said.className = 'city-notice-said';
  said.setAttribute('role', 'status');
  // The mark first, at a fixed place after the head's last link; the column follows it.
  box.append(recall, list, said);
  parent.append(box);

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Hover or focus inside the column holds it: it never fades from under a pointer or a key. */
  let held = false;

  /** Sets the status line's text so a screen reader announces it again, even when the words are the same. */
  const announce = (text: string): void => {
    said.textContent = '';
    requestAnimationFrame(() => {
      said.textContent = text;
    });
  };
  const shown = (): boolean => !box.hidden && box.dataset.shown !== undefined;
  const fade = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    delete box.dataset.shown;
    recall.setAttribute('aria-expanded', 'false');
  };
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = held ? null : setTimeout(fade, NOTICE_MS);
  };
  const show = (): void => {
    box.dataset.shown = '';
    recall.setAttribute('aria-expanded', 'true');
    arm();
  };

  const render = (): void => {
    const lines = stack.list().map((n) => {
      const li = doc.createElement('li');
      li.className = 'city-notice-line';
      li.dataset.key = n.key;
      const p = doc.createElement('p');
      p.id = `${list.id}-${++ids}`;
      p.textContent = n.text;
      // A pointer hint only, for a line cut short: the words are in the page whole, for a screen reader as for search.
      li.addEventListener('pointerenter', () => {
        if (p.scrollWidth > p.clientWidth) p.title = n.text;
        else p.removeAttribute('title');
      });
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'city-notice-dismiss';
      close.textContent = 'Dismiss';
      close.setAttribute('aria-describedby', p.id);
      close.addEventListener('click', () => dismiss(n.key, true));
      li.append(p, close);
      return li;
    });
    list.replaceChildren(...lines);
    box.hidden = lines.length === 0;
    if (box.hidden) fade();
  };

  function dismiss(key: string, byHand = false): void {
    const keys = stack.list().map((n) => n.key);
    const at = keys.indexOf(key);
    const hadFocus = box.contains(doc.activeElement);
    if (!stack.dismiss(key)) return;
    render();
    if (!byHand && !hadFocus) return;
    // Focus goes to the next notice's Dismiss (or the one above it); with none left, to the head's own place.
    const rest = [...list.querySelectorAll<HTMLButtonElement>('.city-notice-dismiss')];
    const next = rest[Math.min(at, rest.length - 1)];
    if (next) next.focus();
    else (parent.querySelector<HTMLElement>('[aria-current="page"]') ?? parent.querySelector<HTMLElement>('a'))?.focus();
  }

  recall.addEventListener('click', () => {
    if (shown()) return fade();
    announce(stack.texts().join(' '));
    show();
  });
  box.addEventListener('pointerenter', () => {
    held = true;
    arm();
  });
  box.addEventListener('pointerleave', () => {
    held = box.contains(doc.activeElement);
    if (shown()) arm();
  });
  box.addEventListener('focusin', () => {
    held = true;
    arm();
  });
  box.addEventListener('focusout', (e) => {
    if (box.contains(e.relatedTarget as Node | null)) return;
    held = box.matches(':hover');
    if (shown()) arm();
  });
  // Escape in the column folds it away and leaves the key on the mark; the sheet behind keeps its own Escape.
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shown()) return;
    e.preventDefault();
    e.stopPropagation();
    fade();
    recall.focus();
  });

  // Beside an open sheet: the column stands to its right, at the sheet's own width, never over it.
  const beside = (): void => {
    const open = [...doc.querySelectorAll<HTMLElement>('.sheet')].find((s) => !s.hidden);
    if (!open) {
      delete box.dataset.beside;
      box.style.removeProperty('--sheet-width');
      return;
    }
    const w = getComputedStyle(open).getPropertyValue('--sheet-w').trim() || `${open.offsetWidth}px`;
    box.dataset.beside = '';
    box.style.setProperty('--sheet-width', `calc(${w} + ${BESIDE_GAP}px)`);
  };
  new MutationObserver((records) => {
    if (records.some((r) => r.target instanceof HTMLElement && r.target.classList.contains('sheet'))) beside();
  }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  beside();

  return {
    add(text, o) {
      stack.add(text, o);
      render();
      announce(text);
      show();
    },
    dismiss: (key) => dismiss(key),
    text: () => (shown() ? stack.texts().join(' ') : ''),
    texts: () => stack.texts(),
  };
}
