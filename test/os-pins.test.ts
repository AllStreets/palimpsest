/**
 * The city pins and the lock-on (app/src/ui/os/pins.ts, Task 10), run against a small stand-in for the DOM and a
 * real camera: show and hide are idempotent and leave no hook behind, the plates hand over by an attribute, one
 * pin stands per district (numbered where items wait, quiet elsewhere), a district not standing gets no pin, a
 * null frame is skipped, red is the grant's and the lock's alone, and the leader is routed only when what it
 * avoids moves.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import * as THREE from 'three';

import { tagCustomProperties } from '../app/src/ui/os/pin-layout.js';
import { createPins, type OsCity, type PinTarget } from '../app/src/ui/os/pins.js';

type Listener = (e?: unknown) => void;

/** Just enough of an element for pins.ts. */
class Fake {
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: Fake[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly props = new Map<string, string>();
  readonly style = {
    transform: '',
    setProperty: (k: string, v: string) => void this.props.set(k, v),
    removeProperty: (k: string) => void this.props.delete(k),
  };
  parent: Fake | null = null;
  text = '';
  hidden = false;
  tabIndex = -1;
  /** What layout would say: set by the test. */
  offsetWidth = 120;
  offsetHeight = 34;
  offsetLeft = 0;
  offsetTop = 70;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  /** Every setAttribute('d', ...) this element took, so a test can count reroutes. */
  dWrites = 0;
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
  };
  constructor(
    readonly tagName: string,
    readonly namespaceURI: string = 'http://www.w3.org/1999/xhtml',
  ) {}
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
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
    this.text = v;
  }
  get isConnected(): boolean {
    let n: Fake | null = this;
    while (n.parent) n = n.parent;
    return n === body;
  }
  setAttribute(k: string, v: string): void {
    if (k === 'class') this.className = String(v);
    if (k === 'd') this.dWrites++;
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  append(...n: Array<Fake | string>): void {
    for (const c of n) {
      if (typeof c === 'string') {
        this.text += c;
        continue;
      }
      c.remove();
      c.parent = this;
      this.children.push(c);
    }
  }
  prepend(...n: Fake[]): void {
    for (const c of [...n].reverse()) {
      c.remove();
      c.parent = this;
      this.children.unshift(c);
    }
  }
  replaceChildren(...n: Fake[]): void {
    for (const c of [...this.children]) c.remove();
    this.append(...n);
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  getBoundingClientRect(): Fake['rect'] {
    return this.rect;
  }
  all(): Fake[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): Fake[] {
    return this.all().filter((c) => c.classes.has(cls));
  }
}

let body: Fake;
let html: Fake;
let win: Fake & { innerWidth: number; innerHeight: number };

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved = { document: g.document, window: g.window };
beforeEach(() => {
  body = new Fake('body');
  html = new Fake('html');
  win = Object.assign(new Fake('window'), { innerWidth: 1440, innerHeight: 900 });
  g.document = {
    createElement: (tag: string) => new Fake(tag),
    createElementNS: (ns: string, tag: string) => new Fake(tag, ns),
    documentElement: html,
  };
  g.window = win;
});
afterEach(() => {
  g.document = saved.document;
  g.window = saved.window;
});

/** A city of towers along the x axis, seen from the south, its hooks run by hand. */
function makeCity(towers: Record<string, number | null>): OsCity & { hooks: Set<() => void>; frame(n?: number): void; frames: Map<string, number> } {
  const camera = new THREE.PerspectiveCamera(50, 1440 / 900, 1, 5000);
  camera.position.set(0, 200, 900);
  camera.lookAt(0, 60, 0);
  camera.updateMatrixWorld();
  const hooks = new Set<() => void>();
  const frames = new Map<string, number>();
  return {
    camera,
    hooks,
    frames,
    towerFrame(repo) {
      frames.set(repo, (frames.get(repo) ?? 0) + 1);
      const x = towers[repo];
      if (x === undefined || x === null) return null;
      return { center: new THREE.Vector3(x, 60, 0), width: 30, height: 120 };
    },
    onFrame(fn) {
      hooks.add(fn);
      return () => hooks.delete(fn);
    },
    districts: () => Object.keys(towers),
    frame(n = 1) {
      for (let i = 0; i < n; i++) for (const fn of [...hooks]) fn();
    },
  };
}

/** The panel and its list: the panel's right edge at 560, the list from 120 to 860. */
function makeHost(): { parent: Fake; panel: Fake; scroller: Fake } {
  const parent = new Fake('div');
  body.append(parent);
  const panel = new Fake('section');
  panel.offsetLeft = 0;
  panel.offsetWidth = 560;
  const scroller = new Fake('div');
  scroller.rect = { left: 0, top: 120, right: 560, bottom: 860, width: 560, height: 740 };
  panel.append(scroller);
  parent.append(panel);
  return { parent, panel, scroller };
}

const row = (top: number, scroller: Fake): Fake => {
  const r = new Fake('li');
  r.rect = { left: 0, top, right: 560, bottom: top + 60, width: 560, height: 60 };
  scroller.append(r);
  return r;
};

const T = (id: string, n: number, repo: string, tone: PinTarget['tone'] = 'warn', name = repo.split('/')[1]): PinTarget => ({ id, n, repo, name, figure: `${n}.00 cr`, tone });

const TOWERS = { 'a/one': -60, 'a/two': 120, 'a/three': 260, 'a/rebuilding': null };

function setup(towers: Record<string, number | null> = TOWERS) {
  const city = makeCity(towers);
  const host = makeHost();
  const pins = createPins(host.parent as unknown as HTMLElement, host.panel as unknown as HTMLElement, host.scroller as unknown as HTMLElement, city);
  const root = host.parent.find('os-pins')[0];
  const pinOf = (repo: string): Fake | undefined => root.find('os-pin').find((p) => p.dataset.repo === repo);
  return { city, host, pins, root, pinOf };
}

test('show and hide are idempotent: one hook, one resize listener, the plates handed over and back', () => {
  const { city, pins } = setup();
  pins.show();
  pins.show();
  assert.equal(city.hooks.size, 1, 'a second show adds no second hook');
  assert.equal(win.listeners.get('resize')?.length, 1, 'one resize listener');
  assert.equal(html.dataset.osPins, 'on', 'the plates are told to fade');
  pins.hide();
  pins.hide();
  assert.equal(city.hooks.size, 0);
  assert.equal(win.listeners.get('resize')?.length, 0);
  assert.equal(html.dataset.osPins, undefined, 'the plates come back');
  for (let i = 0; i < 5; i++) {
    pins.show();
    pins.hide();
  }
  assert.equal(city.hooks.size, 0, 'five opens and closes leave no hook');
  assert.equal(html.dataset.osPins, undefined);
});

test('the plates stay faded while any pins show', () => {
  const a = setup();
  const b = setup();
  a.pins.show();
  b.pins.show();
  a.pins.hide();
  assert.equal(html.dataset.osPins, 'on');
  b.pins.hide();
  assert.equal(html.dataset.osPins, undefined);
});

test('the tag offsets reach pins.css as custom properties on the root', () => {
  const { root } = setup();
  for (const [k, v] of Object.entries(tagCustomProperties())) assert.equal(root.props.get(k), v, k);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
});

test('one pin per standing district: numbered where items wait, quiet elsewhere, none where nothing stands', () => {
  const { pins, root, pinOf } = setup();
  pins.setTargets([T('i5', 5, 'a/one'), T('i3', 3, 'a/one'), T('i4', 4, 'a/two', 'grant'), T('i9', 9, 'x/unbuilt')]);
  const all = root.find('os-pin');
  assert.deepEqual(all.map((p) => p.dataset.repo).sort(), ['a/one', 'a/rebuilding', 'a/three', 'a/two']);
  assert.equal(pinOf('x/unbuilt'), undefined, 'a target whose district does not stand makes no pin');
  // A shared district shows its lowest number plus how many more, and its lowest item's name.
  assert.equal(pinOf('a/one')!.find('os-pin-n')[0].textContent, '03 +1');
  assert.equal(pinOf('a/one')!.find('os-pin-name')[0].textContent, 'one');
  assert.equal(pinOf('a/one')!.find('os-pin-fig')[0].textContent, '3.00 cr');
  // Quiet: never numbered.
  const quiet = pinOf('a/three')!;
  assert.ok(quiet.classList.contains('quiet'));
  assert.equal(quiet.find('os-pin-n').length, 0);
  assert.equal(quiet.find('os-pin-name')[0].textContent, 'three');
  // Red is the grant's: its pin alone carries the class.
  assert.ok(pinOf('a/two')!.classList.contains('grant'));
  assert.ok(!pinOf('a/one')!.classList.contains('grant'));
  assert.ok(!quiet.classList.contains('grant'));
  // The telemetry counts the items it tracks.
  assert.equal(root.find('os-pins-tele')[0].textContent, 'track 03');
});

test('names are set as text, never parsed', () => {
  const { pins, pinOf } = setup();
  pins.setTargets([T('i1', 1, 'a/one', 'ok', '<img src=x onerror=alert(1)>')]);
  const name = pinOf('a/one')!.find('os-pin-name')[0];
  assert.equal(name.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(name.children.length, 0);
});

test('frames: the pins stand on their towers, a null frame is skipped without a throw', () => {
  const { city, pins, pinOf } = setup();
  pins.setTargets([T('i1', 1, 'a/one'), T('i2', 2, 'a/two')]);
  pins.show();
  city.frame(3);
  assert.equal(city.hooks.size, 1, 'the hook did not throw and was not removed');
  assert.ok(pinOf('a/one')!.classList.contains('on'));
  assert.ok(pinOf('a/two')!.classList.contains('on'));
  assert.ok(!pinOf('a/rebuilding')!.classList.contains('on'), 'a district mid-rebuild has no frame and no pin on');
  assert.match(pinOf('a/one')!.style.transform, /^translate3d\(/);
});

test('towerFrame is read again every 90 frames, not every frame', () => {
  const { city, pins } = setup();
  pins.setTargets([T('i1', 1, 'a/one')]);
  pins.show();
  city.frame(2);
  const first = city.frames.get('a/one') ?? 0;
  city.frame(60);
  assert.equal(city.frames.get('a/one'), first, 'no reads between refreshes');
  city.frame(40);
  assert.equal(city.frames.get('a/one'), first + 1, 'one read at the next refresh');
});

test('the lock: amber on an item, red on the grant, its words as text, its brackets closing on each new lock', () => {
  const { city, host, pins, root, pinOf } = setup();
  pins.setTargets([T('i1', 1, 'a/one'), T('i2', 2, 'a/two', 'grant')]);
  pins.show();
  const r1 = row(200, host.scroller);
  pins.setActive('i1', r1 as unknown as HTMLElement);
  city.frame(3);
  const lock = root.find('os-lock')[0];
  assert.ok(lock.classList.contains('on'));
  assert.ok(!lock.classList.contains('grant'), 'an ordinary item locks in amber');
  assert.equal(lock.find('os-lock-n')[0].textContent, '01');
  assert.equal(lock.find('os-lock-name')[0].textContent, 'one');
  assert.ok(pinOf('a/one')!.classList.contains('locked'), 'the locked district\'s pin gives way to the lock');
  const acquired = [...lock.classes].filter((c) => c.startsWith('acquire'));
  assert.equal(acquired.length, 1);
  pins.setActive('i2', row(300, host.scroller) as unknown as HTMLElement);
  city.frame(2);
  assert.ok(lock.classList.contains('grant'), 'the grant locks in red');
  assert.equal(root.find('os-pins-lines')[0].classList.contains('grant'), true);
  const again = [...lock.classes].filter((c) => c.startsWith('acquire'));
  assert.equal(again.length, 1);
  assert.notEqual(again[0], acquired[0], 'the brackets close in again');
  // Still: the same lock asked again does not restart them.
  pins.setActive('i2', row(300, host.scroller) as unknown as HTMLElement);
  assert.deepEqual([...lock.classes].filter((c) => c.startsWith('acquire')), again);
  pins.setActive(null, null);
  city.frame(1);
  assert.ok(!lock.classList.contains('on'));
});

test('the leader is routed only when what it avoids moves', () => {
  const { city, host, pins, root } = setup();
  pins.setTargets([T('i1', 1, 'a/two'), T('i2', 2, 'a/three')]);
  pins.show();
  const r = row(400, host.scroller);
  pins.setActive('i1', r as unknown as HTMLElement);
  city.frame(4);
  const leader = root.find('os-leader')[0];
  const lines = root.find('os-pins-lines')[0];
  assert.ok(lines.classList.contains('on'), 'the leader shows');
  const routed = leader.dWrites;
  assert.ok(routed >= 1);
  city.frame(30);
  assert.equal(leader.dWrites, routed, 'a still scene routes nothing more');
  // The list scrolls: the row moves, so the leader is routed again.
  r.rect = { ...r.rect, top: 460, bottom: 520 };
  host.scroller.fire('scroll');
  city.frame(1);
  assert.equal(leader.dWrites, routed + 1);
  // Scrolled out of the list: no leader, the lock stays.
  r.rect = { ...r.rect, top: 900, bottom: 960 };
  host.scroller.fire('scroll');
  city.frame(1);
  assert.ok(!lines.classList.contains('on'), 'no leader for a row out of view');
  assert.ok(root.find('os-lock')[0].classList.contains('on'), 'the lock stays');
});

test('without a city nothing hooks and the plates stay', () => {
  const host = makeHost();
  const pins = createPins(host.parent as unknown as HTMLElement, host.panel as unknown as HTMLElement, host.scroller as unknown as HTMLElement, undefined);
  pins.setTargets([T('i1', 1, 'a/one')]);
  pins.show();
  assert.equal(html.dataset.osPins, undefined);
  pins.hide();
});
