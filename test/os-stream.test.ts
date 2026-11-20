/**
 * The panel's stream (app/src/ui/os/stream.ts): columns of the brief's own
 * words, cleaned, read downward, never one word twice running, and the same
 * every time for the same words. Then the panel's parallax (panel.ts
 * leanPanes) against stand-ins for the frame clock, matchMedia and the panes:
 * one frame writes at most two transforms, the rect is read on enter only,
 * and the panes rest on leave and under reduced motion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { leanPanes } from '../app/src/ui/os/panel.js';
import { cleanWord, columnLook, streamColumns } from '../app/src/ui/os/stream.js';
import { parallaxOffset } from '../app/src/ui/os/tokens.js';

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui', 'os');
const DOT = '·';
const pieces = (col: string): string[] => col.split(DOT).filter(Boolean);

test('columns are words, not a font sample', () => {
  const cols = streamColumns(['harbor-ledger', '60', '#312', 'halted'], 18, 64);
  assert.equal(cols.length, 18);
  for (const col of cols) {
    const ws = pieces(col);
    assert.ok(ws.length >= 2, `a column of one word: "${col}"`);
    for (let i = 1; i < ws.length; i++) assert.notEqual(ws[i], ws[i - 1], `"${col}" repeats ${ws[i]}`);
    for (const w of ws) assert.ok(['harbor-ledger', '60', '#312', 'halted'].includes(w), `"${w}" is not one of the words`);
  }
});

test('columns differ from their neighbours', () => {
  const cols = streamColumns(['harbor-ledger', '60', '#312', 'halted', 'kumo', '11'], 18, 64);
  for (let i = 1; i < cols.length; i++) assert.notEqual(cols[i], cols[i - 1], `columns ${i - 1} and ${i} are the same`);
});

test('a repeated word in the brief still never runs twice', () => {
  for (const col of streamColumns(['kumo', 'kumo', 'kumo'], 6, 64)) {
    const ws = pieces(col);
    for (let i = 1; i < ws.length; i++) assert.notEqual(ws[i], ws[i - 1], `"${col}"`);
  }
});

test('words are cleaned', () => {
  assert.equal(cleanWord('<b>x</b>'), 'bxb');
  assert.equal(cleanWord('  two words\there '), 'twowordshere');
  assert.equal(cleanWord('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmn');
  assert.equal(cleanWord('45.2% #7 a-b'), '45.2%#7a-b');
  assert.equal(cleanWord('<>/'), '');
  const cols = streamColumns(['<b>x</b>', 'abcdefghijklmnopqrstuvwxyz', 'a b'], 4, 64);
  for (const col of cols) {
    assert.match(col, /^[A-Za-z0-9#.%·-]+$/, `"${col}" has a character it should not`);
    for (const w of pieces(col)) assert.ok(w.length <= 14, `"${w}" is longer than 14`);
  }
  assert.ok(cols.some((c) => pieces(c).includes('bxb')));
  assert.ok(cols.some((c) => pieces(c).includes('ab')));
});

test('a column is cut at a word, within its rows', () => {
  for (const col of streamColumns(['harbor-ledger', '60', '#312', 'halted'], 18, 64)) {
    assert.ok(col.length <= 64, `${col.length} characters`);
    assert.ok(col.length >= 64 - 15, `${col.length} characters leaves the column short`);
    assert.ok(col.endsWith(DOT), `"${col}" ends mid-word`);
  }
});

test('an empty brief still makes a stream', () => {
  const cols = streamColumns([], 18, 64);
  assert.equal(cols.length, 18);
  for (const col of cols) assert.ok(pieces(col).length > 0, `an empty column: "${col}"`);
  const blank = streamColumns(['<>', '   '], 18, 64);
  for (const col of blank) assert.ok(pieces(col).length > 0, 'words that clean to nothing still make a stream');
});

test('deterministic', () => {
  const w = ['harbor-ledger', '60', '#312', 'halted', 'kumo'];
  assert.deepEqual(streamColumns(w, 18, 64), streamColumns([...w], 18, 64));
  assert.deepEqual(streamColumns([], 18, 64), streamColumns([], 18, 64));
});

test('the stream stays under 20% opacity', () => {
  for (let i = 0; i < 18; i++) {
    const look = columnLook(i, 18);
    assert.ok(look.opacity > 0 && look.opacity < 0.2, `column ${i} at ${look.opacity}`);
    assert.ok(look.x >= 0 && look.x < 100, `column ${i} at ${look.x}%`);
    assert.ok(look.seconds > 0, `column ${i} does not fall`);
  }
  const css = readFileSync(join(OS, 'panel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.os-stream-col\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'panel.css has an .os-stream-col rule');
  assert.match(rule[1], /opacity:\s*var\(--os-o\)/, 'the column takes its opacity from columnLook');
  assert.match(rule[1], /will-change:\s*transform/, 'each column is its own layer');
});

// Stand-ins for the browser.
type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, mm: g.matchMedia };
afterEach(() => {
  g.requestAnimationFrame = saved.raf;
  g.cancelAnimationFrame = saved.caf;
  g.matchMedia = saved.mm;
});

function reduce(on: boolean): void {
  g.matchMedia = (q: string) => ({ matches: on && q.includes('prefers-reduced-motion: reduce'), media: q });
}

function clock(): { tick(): void; pending(): number } {
  let queue = new Map<number, (t: number) => void>();
  let id = 0;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    queue.set(++id, cb);
    return id;
  };
  g.cancelAnimationFrame = (h: number) => void queue.delete(h);
  return {
    tick() {
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) cb(0);
    },
    pending: () => queue.size,
  };
}

const RECT = { left: 16, top: 64, width: 600, height: 800, right: 616, bottom: 864, x: 16, y: 64 };

/** A host that counts its rect reads and fires its own pointer events, and two panes that log their transforms. */
function stage(): {
  host: HTMLElement;
  near: HTMLElement;
  far: HTMLElement;
  fire(type: string, x?: number, y?: number): void;
  reads(): number;
  writes: string[];
} {
  const on = new Map<string, Array<(e: unknown) => void>>();
  let reads = 0;
  const writes: string[] = [];
  const pane = (name: string): HTMLElement => {
    let t = '';
    return {
      style: {
        get transform() {
          return t;
        },
        set transform(v: string) {
          t = v;
          writes.push(`${name}:${v}`);
        },
      },
    } as unknown as HTMLElement;
  };
  const host = {
    addEventListener: (type: string, fn: (e: unknown) => void) => on.set(type, [...(on.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: (e: unknown) => void) => on.set(type, (on.get(type) ?? []).filter((f) => f !== fn)),
    getBoundingClientRect: () => {
      reads++;
      return RECT;
    },
  } as unknown as HTMLElement;
  return {
    host,
    near: pane('near'),
    far: pane('far'),
    fire: (type, x = 0, y = 0) => {
      for (const fn of on.get(type) ?? []) fn({ clientX: x, clientY: y });
    },
    reads: () => reads,
    writes,
  };
}

const px = (o: { x: number; y: number }): string => `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0)`;

test('parallax: the near pane leans with the pointer, the far one against it, by transform', () => {
  reduce(false);
  const c = clock();
  const s = stage();
  leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 600, 100);
  s.fire('pointermove', 600, 100);
  c.tick();
  const at = { x: 600, y: 100 };
  assert.equal(s.near.style.transform, px(parallaxOffset(at, RECT, 'near')));
  assert.equal(s.far.style.transform, px(parallaxOffset(at, RECT, 'far')));
});

test('parallax: many moves in a frame are one frame of at most two writes', () => {
  reduce(false);
  const c = clock();
  const s = stage();
  leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 100, 100);
  for (let i = 0; i < 20; i++) s.fire('pointermove', 100 + i * 10, 100 + i * 5);
  assert.equal(c.pending(), 1, 'one frame is asked for');
  c.tick();
  assert.ok(s.writes.length <= 2, `${s.writes.length} writes in a frame`);
  assert.equal(c.pending(), 0);
});

test('parallax: the rect is read on enter only', () => {
  reduce(false);
  const c = clock();
  const s = stage();
  leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 100, 100);
  for (let i = 0; i < 10; i++) {
    s.fire('pointermove', 100 + i, 100);
    c.tick();
  }
  assert.equal(s.reads(), 1);
});

test('parallax: at rest on leave', () => {
  reduce(false);
  const c = clock();
  const s = stage();
  leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 600, 800);
  s.fire('pointermove', 600, 800);
  c.tick();
  assert.notEqual(s.near.style.transform, '');
  s.fire('pointerleave');
  c.tick();
  assert.equal(s.near.style.transform, '');
  assert.equal(s.far.style.transform, '');
  s.fire('pointermove', 300, 300);
  c.tick();
  assert.equal(s.near.style.transform, '', 'a move after leaving, before entering, does not lean');
});

test('parallax: still under reduced motion', () => {
  reduce(true);
  const c = clock();
  const s = stage();
  leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 600, 800);
  s.fire('pointermove', 600, 800);
  c.tick();
  assert.deepEqual(s.writes, []);
  assert.equal(c.pending(), 0);
});

test('parallax: the unlean stops listening and sets the panes at rest', () => {
  reduce(false);
  const c = clock();
  const s = stage();
  const stop = leanPanes(s.host, s.near, s.far);
  s.fire('pointerenter', 600, 800);
  s.fire('pointermove', 600, 800);
  stop();
  assert.equal(c.pending(), 0, 'the pending frame is cancelled');
  assert.equal(s.near.style.transform, '');
  s.fire('pointerenter', 600, 800);
  s.fire('pointermove', 600, 800);
  assert.equal(c.pending(), 0);
});
