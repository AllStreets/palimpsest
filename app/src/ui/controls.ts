/**
 * The pieces the Repos and Settings sheets share: the sheet itself, the
 * slide switch, the square-cornered button, and small text helpers.
 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "just now", "12 minutes ago", "7 hours ago", "3 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${plural(m, 'minute')} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

export interface Switch {
  el: HTMLButtonElement;
  on: boolean;
  set(on: boolean): void;
}

/**
 * A slide switch: a recessed square-cornered track and a small machined
 * knob. A real button with role="switch", so Space and Enter flip it.
 */
export function createSwitch(className: string, label: string, onChange: (on: boolean) => void): Switch {
  const b = el('button', `slide ${className}`);
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-label', label);
  b.append(el('span', 'slide-knob'));
  const sw: Switch = {
    el: b,
    on: false,
    set(on) {
      sw.on = on;
      b.setAttribute('aria-checked', String(on));
    },
  };
  sw.set(false);
  b.addEventListener('click', () => {
    sw.set(!sw.on);
    onChange(sw.on);
  });
  return sw;
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `btn ${className}`, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** A text-only action, underlined on hover: Retry, Disconnect, Reload. */
export function textButton(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `textbtn ${className}`, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Arrow keys move the choice within a radio group (roving tabindex), as
 * a native radio group does. `pick` is called with the newly chosen radio.
 */
export function rovingRadios(group: HTMLElement, pick: (radio: HTMLElement) => void): void {
  group.addEventListener('keydown', (e) => {
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    const at = radios.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = radios.length - 1;
    if (next < 0) return;
    e.preventDefault();
    radios[next].focus();
    pick(radios[next]);
  });
}

/** Marks `chosen` as the checked radio in its group and makes it the group's one tab stop. */
export function checkRadio(group: HTMLElement, chosen: HTMLElement | null): void {
  for (const r of group.querySelectorAll<HTMLElement>('[role="radio"]')) {
    const on = r === chosen;
    r.setAttribute('aria-checked', String(on));
    r.tabIndex = on ? 0 : -1;
  }
}

export interface Sheet {
  root: HTMLElement;
  body: HTMLElement;
  show(): void;
  hide(): void;
  readonly shown: boolean;
}

/**
 * A sheet laid over the left of the city, which keeps running beside it
 * under a dimming scrim. Clicking the scrim returns to the city.
 */
export function createSheet(parent: HTMLElement, name: string, title: string, onDismiss: () => void): Sheet {
  const scrim = el('div', 'scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', onDismiss);
  const root = el('section', `sheet ${name}`);
  root.hidden = true;
  root.setAttribute('aria-labelledby', `${name}-title`);
  const head = el('header', 'sheet-head');
  const h = el('h1', 'sheet-title', title);
  h.id = `${name}-title`;
  h.tabIndex = -1;
  head.append(h);
  const body = el('div', 'sheet-body');
  root.append(head, body);
  parent.append(scrim, root);

  let shown = false;
  return {
    root,
    body,
    show() {
      if (shown) return;
      shown = true;
      scrim.hidden = false;
      root.hidden = false;
      requestAnimationFrame(() => {
        scrim.classList.add('open');
        root.classList.add('open');
      });
      root.scrollTop = 0;
      body.scrollTop = 0;
      h.focus({ preventScroll: true });
    },
    hide() {
      if (!shown) return;
      shown = false;
      scrim.classList.remove('open');
      root.classList.remove('open');
      scrim.hidden = true;
      root.hidden = true;
    },
    get shown() {
      return shown;
    },
  };
}
