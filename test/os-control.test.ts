/**
 * The shaped control (app/src/ui/os/control.ts): osKey builds a key in one of
 * four weights, and weighKey dresses an existing button or link in place,
 * keeping its listeners. Run against a small stand-in for the DOM.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { osKey, weighKey, WEIGHTS, type Weight } from '../app/src/ui/os/control.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Just enough of an element for control.ts. */
class Fake {
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: Fake[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  parent: Fake | null = null;
  text = '';
  type = '';
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string) => this.classes.has(c),
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
    this.children.length = 0;
    this.text = v;
  }
  setAttribute(k: string, v: string): void {
    // As in the DOM, the class attribute is the class list.
    if (k === 'class') this.className = String(v);
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  append(...n: Fake[]): void {
    for (const c of n) {
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
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  /** Every descendant, depth first. */
  all(): Fake[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): Fake[] {
    return this.all().filter((c) => c.classes.has(cls));
  }
}

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved = g.document;
beforeEach(() => {
  g.document = {
    createElement: (tag: string) => new Fake(tag),
    createElementNS: (ns: string, tag: string) => new Fake(tag, ns),
  };
});
afterEach(() => {
  g.document = saved;
});

const asFake = (n: unknown): Fake => n as Fake;

test('there are four weights, lightest to heaviest', () => {
  assert.deepEqual([...WEIGHTS], ['look', 'decide', 'spend', 'grant']);
});

test('osKey is a type="button" key with its weight, its label and its click', () => {
  for (const w of WEIGHTS) {
    let hits = 0;
    const k = asFake(osKey('Fly there', w, () => hits++, { className: 'brief-act' }));
    assert.equal(k.tagName, 'button');
    assert.equal(k.type, 'button');
    assert.equal(k.dataset.weight, w);
    for (const c of ['os-key', 'os-focus', 'brief-act']) assert.ok(k.classList.contains(c), `${w} key lacks ${c}`);
    assert.equal(k.find('os-key-label')[0]?.textContent, 'Fly there');
    k.click();
    assert.equal(hits, 1);
  }
});

test('every key has a reticle of four ticks, hidden from the reader', () => {
  for (const w of WEIGHTS) {
    const k = asFake(osKey('Post', w, () => {}));
    const ret = k.find('os-key-ret');
    assert.equal(ret.length, 1, `${w} has one reticle`);
    assert.equal(ret[0].getAttribute('aria-hidden'), 'true');
    assert.equal(ret[0].find('os-key-tick').length, 4);
    // The reticle adds no words to the key's name.
    assert.equal(ret[0].textContent, '');
  }
});

test('a sum sits in its own window, as text, and is part of the name', () => {
  const k = asFake(osKey('Post', 'spend', () => {}, { sum: '60 cr' }));
  const sum = k.find('os-sum');
  assert.equal(sum.length, 1);
  assert.equal(sum[0].textContent, '60 cr');
  assert.match(k.textContent, /Post.*60 cr/);
  assert.equal(asFake(osKey('Post', 'spend', () => {})).find('os-sum').length, 0);
});

test('only the grant carries the seal, an SVG built in its namespace', () => {
  for (const w of WEIGHTS) {
    const seals = asFake(osKey('Let it act here', w, () => {})).find('os-seal');
    if (w !== 'grant') {
      assert.equal(seals.length, 0, `${w} has a seal`);
      continue;
    }
    assert.equal(seals.length, 1);
    assert.equal(seals[0].tagName, 'svg');
    assert.equal(seals[0].namespaceURI, SVG);
    assert.equal(seals[0].getAttribute('aria-hidden'), 'true');
    assert.ok(seals[0].all().every((c) => c.namespaceURI === SVG), 'every part of the seal is SVG');
    assert.ok(seals[0].find('os-seal-spin').length === 1, 'the seal has a turning ring');
  }
});

test('weighKey dresses a button in place and keeps its listener and its words', () => {
  const b = new Fake('button');
  b.className = 'textbtn brief-act';
  b.textContent = 'Retry';
  let hits = 0;
  b.addEventListener('click', () => hits++);
  const out = asFake(weighKey(b as unknown as HTMLElement, 'spend', '4.10 cr'));
  assert.equal(out, b, 'the same node comes back');
  assert.equal(b.dataset.weight, 'spend');
  for (const c of ['textbtn', 'brief-act', 'os-key', 'os-focus']) assert.ok(b.classList.contains(c), `lacks ${c}`);
  assert.equal(b.find('os-sum')[0]?.textContent, '4.10 cr');
  assert.match(b.textContent, /^Retry4\.10 cr$/);
  b.click();
  assert.equal(hits, 1);
});

test('weighKey dresses a link without making it a button', () => {
  const a = new Fake('a');
  a.textContent = 'Open PR';
  weighKey(a as unknown as HTMLElement, 'look');
  assert.equal(a.dataset.weight, 'look');
  assert.equal(a.type, '', 'a link gets no type');
  assert.ok(a.classList.contains('os-key'));
  assert.equal(a.textContent, 'Open PR');
});

test('weighing again replaces the dressing rather than adding to it', () => {
  const b = new Fake('button');
  b.textContent = 'Let it act here';
  const steps: Array<[Weight, string | undefined]> = [
    ['grant', undefined],
    ['spend', '60 cr'],
    ['spend', '30 cr'],
    ['decide', undefined],
  ];
  for (const [w, sum] of steps) {
    weighKey(b as unknown as HTMLElement, w, sum);
    assert.equal(b.dataset.weight, w);
    assert.equal(b.find('os-key-ret').length, 1, `${w}: one reticle`);
    assert.equal(b.find('os-seal').length, w === 'grant' ? 1 : 0, `${w}: seal`);
    assert.deepEqual(
      b.find('os-sum').map((s) => s.textContent),
      sum ? [sum] : [],
      `${w}: sum`,
    );
  }
  assert.equal(b.textContent, 'Let it act here');
});
