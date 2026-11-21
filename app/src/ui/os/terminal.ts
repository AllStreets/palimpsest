/**
 * Terminal mode: deep reading over the city. While it is open, <html> carries
 * data-os-mode="terminal", the city host is blurred and dimmed behind it (the
 * one filter the os layer sets, terminal.css), and a full-height panel in the
 * mono face stands over it, amber on the ground.
 *
 * The title types in (typeIn, plain text only); the body is set at once. The
 * body is the caller's own nodes (the summary renderer's, or text nodes): the
 * terminal appends them as they are and never parses a string.
 *
 * Escape and the Close key call onClose; the caller closes the terminal from
 * there. Closing hands focus back to whatever had it when the terminal opened.
 * No CSS import, so this runs in node.
 */
import { osKey } from './control.js';
import { stillMotion, typeIn } from './motion.js';
import { MOTION } from './tokens.js';

export interface Terminal {
  el: HTMLElement;
  open(title: string, body: Node[]): void;
  close(): void;
  isOpen(): boolean;
}

/** What terminal mode asks of the city while it is open: a lower render scale, if the blur costs too much (Task 12). */
export interface TerminalCity {
  setRenderScale(s: number): void;
}

/**
 * The render scale the city drops to while the terminal is open: half, which the 6px blur hides. The blur alone
 * cost 14% on high and 43% on medium over the Brief open, measured uncapped (Task 12); at half scale the city
 * draws a quarter of the pixels, and the blur stays within the frame budget.
 */
export const TERMINAL_RENDER_SCALE = 0.5;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let made = 0;

/**
 * Builds the terminal, hidden, in `parent`. `onClose` is called by Escape and
 * by Close. Given `city`, the city draws at TERMINAL_RENDER_SCALE while the
 * terminal is open (from when the blur has eased in), and at full scale again
 * when it closes.
 */
export function createTerminal(parent: HTMLElement, onClose: () => void, city?: TerminalCity): Terminal {
  const id = `os-terminal-${++made}`;
  const root = el('section', 'os-terminal');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', `${id}-title`);

  const head = el('header', 'os-terminal-head');
  // The title holds its place unseen while it types; the typed text is hidden from readers, who get it whole.
  const title = el('h2', 'os-terminal-title os-type-hold');
  title.id = `${id}-title`;
  const ghost = el('span', 'os-type-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  const typed = el('span', 'os-terminal-typed');
  typed.setAttribute('aria-hidden', 'true');
  const spoken = el('span', 'os-sr');
  title.append(ghost, typed, spoken);
  const close = osKey('Close', 'look', () => onClose(), { className: 'os-terminal-close' });
  head.append(title, close);

  // The log itself: focusable, so the keys scroll it.
  const body = el('div', 'os-terminal-body');
  body.tabIndex = 0;
  body.setAttribute('role', 'document');
  body.setAttribute('aria-label', 'Log');
  root.append(head, body);
  parent.append(root);

  let open = false;
  let opener: HTMLElement | null = null;
  let cancelType: () => void = () => {};
  let scaleTimer: ReturnType<typeof setTimeout> | undefined;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Focus stays in the dialog: Tab goes round its two stops, the log and Close.
    if (e.key === 'Tab') {
      const stops: HTMLElement[] = [body, close];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = at < 0 ? 0 : (at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length;
      stops[next].focus({ preventScroll: true });
    }
  };

  return {
    el: root,
    open(text, nodes) {
      cancelType();
      if (!open) {
        const active = document.activeElement as HTMLElement | null;
        opener = active && active !== document.body && !root.contains(active) ? active : null;
        document.addEventListener('keydown', onKey, true);
      }
      open = true;
      ghost.textContent = text;
      spoken.textContent = text;
      body.replaceChildren(...nodes);
      body.scrollTop = 0;
      root.hidden = false;
      document.documentElement.setAttribute('data-os-mode', 'terminal');
      // Once the blur has eased in, so the softer city never shows sharp; at once when still.
      clearTimeout(scaleTimer);
      if (city && stillMotion()) city.setRenderScale(TERMINAL_RENDER_SCALE);
      else if (city) scaleTimer = setTimeout(() => city.setRenderScale(TERMINAL_RENDER_SCALE), MOTION.slow);
      cancelType = typeIn(typed, text);
      body.focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      cancelType();
      cancelType = () => {};
      document.removeEventListener('keydown', onKey, true);
      root.hidden = true;
      document.documentElement.removeAttribute('data-os-mode');
      clearTimeout(scaleTimer);
      city?.setRenderScale(1);
      const back = opener;
      opener = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    },
    isOpen: () => open,
  };
}
