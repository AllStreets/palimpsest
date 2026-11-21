/**
 * Terminal mode (app/src/ui/os/terminal.ts, Task 12), run against a small
 * stand-in for the DOM: opening sets html[data-os-mode='terminal'] and moves
 * focus in; Escape and Close call onClose and nothing else; closing takes the
 * mode off and hands focus back to the opener; the body is the caller's own
 * nodes, never a parsed string; the title is read whole; and the city drops
 * to half scale while it is open, when given.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { renderHold } from '../app/src/city/hold.js';
import { createTerminal } from '../app/src/ui/os/terminal.js';

type Listener = (e: unknown) => void;

/** Just enough of an element for terminal.ts and control.ts. */
class Fake {
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  children: Fake[] = [];
  readonly listeners = new Map<string, Listener[]>();
  parent: Fake | null = null;
  text = '';
  type = '';
  id = '';
  hidden = false;
  tabIndex = -1;
  scrollTop = 0;
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(readonly tagName: string) {}
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get isConnected(): boolean {
    let n: Fake | null = this;
    while (n.parent) n = n.parent;
    return n === doc.body || n === doc.documentElement;
  }
  setAttribute(k: string, v: string): void {
    if (k === 'class') this.className = String(v);
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  append(...n: Fake[]): void {
    for (const c of n) {
      c.remove();
      c.parent = this;
      this.children.push(c);
    }
  }
  prepend(...n: Fake[]): void {
    for (const c of n.reverse()) {
      c.remove();
      c.parent = this;
      this.children.unshift(c);
    }
  }
  replaceChildren(...n: Fake[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.text = '';
    this.append(...n);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(n: Fake | null): boolean {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  addEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  removeEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  focus(): void {
    doc.activeElement = this;
  }
  find(cls: string): Fake | null {
    if (this.classes.has(cls)) return this;
    for (const c of this.children) {
      const f = c.find(cls);
      if (f) return f;
    }
    return null;
  }
}

/** The document: its listeners, its focus, its root and body. */
const doc = {
  documentElement: new Fake('html'),
  body: new Fake('body'),
  activeElement: null as Fake | null,
  listeners: new Map<string, Listener[]>(),
  createElement: (tag: string) => new Fake(tag),
  createElementNS: (_ns: string, tag: string) => new Fake(tag),
  addEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  },
  removeEventListener(t: string, fn: Listener): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  },
};

/** Presses a key at the document; returns whether something prevented its default. */
function press(key: string, shiftKey = false): boolean {
  let prevented = false;
  const e = { key, shiftKey, preventDefault: () => (prevented = true), stopPropagation: () => {} };
  for (const fn of doc.listeners.get('keydown') ?? []) fn(e);
  return prevented;
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  doc.documentElement = new Fake('html');
  doc.body = new Fake('body');
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  doc.listeners.clear();
  g.document = doc;
  // Still motion: the title is whole at once.
  g.matchMedia = () => ({ matches: true });
});
afterEach(() => {
  delete g.document;
  delete g.matchMedia;
});

function setup(city?: { hold(on: boolean): void }) {
  const opener = new Fake('button');
  doc.body.append(opener);
  opener.focus();
  let closes = 0;
  const t = createTerminal(doc.body as unknown as HTMLElement, () => closes++, city);
  const root = t.el as unknown as Fake;
  return { t, root, opener, closes: () => closes };
}

const lines = (n: number): Node[] =>
  Array.from({ length: n }, (_, i) => {
    const l = new Fake('div');
    l.textContent = `<b>line ${i}</b>`;
    return l;
  }) as unknown as Node[];

test('built hidden, out of terminal mode', () => {
  const { t, root } = setup();
  assert.equal(root.hidden, true);
  assert.equal(t.isOpen(), false);
  assert.equal(doc.documentElement.getAttribute('data-os-mode'), null);
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
});

test('open sets terminal mode, shows the panel and takes focus into it', () => {
  const { t, root } = setup();
  t.open('Run 41 on harbor-ledger', lines(3));
  assert.equal(t.isOpen(), true);
  assert.equal(root.hidden, false);
  assert.equal(doc.documentElement.getAttribute('data-os-mode'), 'terminal');
  assert.ok(root.contains(doc.activeElement), 'focus is in the terminal');
});

test('the body is the caller\'s own nodes, set as they are; opening again replaces them', () => {
  const { t, root } = setup();
  const first = lines(80);
  t.open('Run log', first);
  const body = root.find('os-terminal-body')!;
  assert.equal(body.children.length, 80);
  assert.ok(body.children.every((c, i) => (c as unknown) === first[i]), 'the same nodes, in order');
  // A string that looks like markup stays text: the terminal never parses.
  assert.equal(body.children[0].textContent, '<b>line 0</b>');
  t.open('Another', lines(2));
  assert.equal(body.children.length, 2);
});

test('the title is typed for the eye and read whole', () => {
  const { t, root } = setup();
  t.open('Run 41 on harbor-ledger', []);
  const title = root.find('os-terminal-title')!;
  assert.equal(root.getAttribute('aria-labelledby'), title.id);
  assert.equal(title.find('os-sr')!.textContent, 'Run 41 on harbor-ledger');
  assert.equal(title.find('os-terminal-typed')!.getAttribute('aria-hidden'), 'true');
  assert.equal(title.find('os-type-ghost')!.getAttribute('aria-hidden'), 'true');
  // Still motion: whole at once.
  assert.equal(title.find('os-terminal-typed')!.textContent, 'Run 41 on harbor-ledger');
});

test('Escape and Close call onClose, and only that', () => {
  const { t, root, closes } = setup();
  t.open('Run log', []);
  assert.equal(press('Escape'), true, 'Escape is taken, so the screens behind do not also close');
  assert.equal(closes(), 1);
  assert.equal(t.isOpen(), true, 'the caller closes it');
  root.find('os-terminal-close')!.click();
  assert.equal(closes(), 2);
  // Closed, Escape is no longer the terminal's.
  t.close();
  assert.equal(press('Escape'), false);
  assert.equal(closes(), 2);
});

test('close takes the mode off, hides the panel and hands focus back to the opener', () => {
  const { t, root, opener } = setup();
  t.open('Run log', lines(3));
  t.close();
  assert.equal(t.isOpen(), false);
  assert.equal(root.hidden, true);
  assert.equal(doc.documentElement.getAttribute('data-os-mode'), null);
  assert.equal(doc.activeElement, opener);
  // Twice is harmless, and so is closing what never opened.
  t.close();
  assert.equal(doc.activeElement, opener);
});

test('opening again while open keeps the first opener, and one key listener', () => {
  const { t, opener } = setup();
  t.open('One', []);
  t.open('Two', []);
  assert.equal(doc.listeners.get('keydown')?.length, 1);
  t.close();
  assert.equal(doc.activeElement, opener);
  assert.equal(doc.listeners.get('keydown')?.length, 0);
});

test('Tab goes round the log and Close, and never leaves the dialog', () => {
  const { t, root } = setup();
  t.open('Run log', []);
  const body = root.find('os-terminal-body')!;
  const close = root.find('os-terminal-close')!;
  assert.equal(doc.activeElement, body);
  press('Tab');
  assert.equal(doc.activeElement, close);
  press('Tab');
  assert.equal(doc.activeElement, body);
  press('Tab', true);
  assert.equal(doc.activeElement, close);
});

/** A city that records its hold calls and says whether it is held now. */
function holdingCity(): { hold(on: boolean): void; calls: boolean[]; held(): boolean } {
  const calls: boolean[] = [];
  return { calls, hold: (on) => void calls.push(on), held: () => calls.at(-1) === true };
}

test('given a city, it holds still while open and draws again on close (still motion: at once)', () => {
  const city = holdingCity();
  const { t } = setup(city);
  t.open('Run log', []);
  assert.deepEqual(city.calls, [true]);
  t.close();
  assert.deepEqual(city.calls, [true, false]);
  assert.equal(city.held(), false);
});

test('Escape, Close and a second close never leave the city held', () => {
  const city = holdingCity();
  let term: ReturnType<typeof createTerminal> | null = null;
  const opener = new Fake('button');
  doc.body.append(opener);
  opener.focus();
  // The gallery's wiring: onClose closes.
  term = createTerminal(doc.body as unknown as HTMLElement, () => term!.close(), city);
  term.open('Run log', []);
  press('Escape');
  assert.equal(city.held(), false, 'Escape releases');
  term.open('Run log', []);
  (term.el as unknown as Fake).find('os-terminal-close')!.click();
  assert.equal(city.held(), false, 'Close releases');
  term.close();
  assert.equal(city.held(), false);
});

test('with motion, the city holds only once the blur has eased in, and never if closed first', async () => {
  g.matchMedia = () => ({ matches: false });
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  try {
    const city = holdingCity();
    const { t } = setup(city);
    t.open('Run log', []);
    assert.deepEqual(city.calls, [], 'the city moves while the blur eases in');
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(city.calls, [true]);
    t.close();
    t.open('Again', []);
    t.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(city.calls, [true, false, false], 'a close before the blur is in cancels the hold');
    assert.equal(city.held(), false);
  } finally {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  }
});

test('the hold: released draws every tick; held draws nothing but one frame owed to each resize', () => {
  const h = renderHold();
  assert.equal(h.held(), false);
  h.owe();
  assert.deepEqual([h.draws(), h.draws()], [true, true], 'a resize while released owes nothing extra');
  h.set(true);
  assert.deepEqual([h.draws(), h.draws()], [false, false]);
  h.owe();
  h.owe();
  assert.deepEqual([h.draws(), h.draws()], [true, false], 'resizes between ticks owe one frame');
  h.owe();
  h.set(false);
  assert.deepEqual([h.draws(), h.draws()], [true, true], 'released, every tick draws again');
  h.set(true);
  assert.equal(h.draws(), false, 'a frame owed before the release is not carried into the next hold');
});

test('the city holds through hold.ts, its loop skips when held, a resize owes a frame, and OsCity carries it', () => {
  const scene = readFileSync(new URL('../app/src/city/scene.ts', import.meta.url), 'utf8');
  assert.match(scene, /hold\(on: boolean\): void;/, 'City declares hold');
  assert.match(scene, /setAnimationLoop\(\(\) => \{\s*(\/\/[^\n]*\n\s*)*if \(!stillness\.draws\(\)\) \{\s*clock\.getDelta\(\);\s*return;/, 'the loop returns first thing when held, keeping its clock');
  assert.match(scene, /const resize = \(\): void => \{\s*(\/\/[^\n]*\n\s*)*stillness\.owe\(\);/, 'a resize owes a frame');
  assert.ok(!/setRenderScale|renderRatio/.test(scene), 'the half-scale fallback is gone');
  const pins = readFileSync(new URL('../app/src/ui/os/pins.ts', import.meta.url), 'utf8');
  assert.match(pins, /hold\(on: boolean\): void;/, 'OsCity declares hold');
  const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /hold: \(on\) => city\.hold\(on\)/, 'main.ts wires it into the OsCity');
});

test('the gallery hands the city to its terminal, and closes it on unmount', () => {
  const src = readFileSync(new URL('../app/src/ui/os/gallery.ts', import.meta.url), 'utf8');
  assert.match(src, /createTerminal\(document\.body, \(\) => term\.close\(\), city\)/);
  assert.match(src, /return \(\) => \{\s*term\.close\(\);/);
});
