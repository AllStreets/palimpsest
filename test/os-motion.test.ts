/**
 * The os layer's motion (app/src/ui/os/motion.ts): the type-in's frame plan,
 * typeIn on plain text with its cancel, and the one-off scan, each with its
 * still equivalent under reduced motion. typeIn and scanOnce run against small
 * stand-ins for the DOM, the frame clock and matchMedia.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanOnce, stillMotion, typeIn, typeSteps } from '../app/src/ui/os/motion.js';
import { MOTION } from '../app/src/ui/os/tokens.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui', 'os', 'motion.ts');

test('typeSteps: nothing to type is one frame of nothing', () => {
  assert.deepEqual(typeSteps(0, 90, 16, 600, false), [0]);
});

test('typeSteps: a short line types at its pace and ends whole', () => {
  const s = typeSteps(30, 90, 16, 600, false);
  assert.equal(s.at(-1), 30);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], `step ${i} goes back`);
  assert.ok(s.length * 16 <= 600 + 16, `${s.length} frames run past the cap`);
  // 30 characters at 90 a second is a third of a second, not the cap.
  assert.ok(s.length * 16 < 400, `${s.length} frames is slower than 90 a second`);
});

test('typeSteps: a long summary speeds up rather than running long', () => {
  const s = typeSteps(600, 90, 16, 600, false);
  assert.ok(s.length <= 38, `${s.length} frames`);
  assert.equal(s.at(-1), 600);
});

test('typeSteps: still is the whole text at once', () => {
  assert.deepEqual(typeSteps(600, 90, 16, 600, true), [600]);
});

test("typeIn's source never sets HTML", () => {
  assert.doesNotMatch(readFileSync(SRC, 'utf8'), /innerHTML|insertAdjacentHTML/);
});

// Stand-ins for the browser.
type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, mm: g.matchMedia, doc: g.document };
afterEach(() => {
  g.requestAnimationFrame = saved.raf;
  g.cancelAnimationFrame = saved.caf;
  g.matchMedia = saved.mm;
  g.document = saved.doc;
});

function reduce(on: boolean): void {
  g.matchMedia = (q: string) => ({ matches: on && q.includes('prefers-reduced-motion: reduce'), media: q });
}

/** A frame clock driven by hand: tick(ms) runs the queued frames at that time. */
function clock(): { tick(ms: number): void; pending(): number } {
  let queue = new Map<number, (t: number) => void>();
  let id = 0;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    queue.set(++id, cb);
    return id;
  };
  g.cancelAnimationFrame = (h: number) => void queue.delete(h);
  return {
    tick(ms) {
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) cb(ms);
    },
    pending: () => queue.size,
  };
}

function node(): HTMLElement & { log: string[] } {
  const attrs = new Map<string, string>();
  const log: string[] = [];
  let text = '';
  return {
    log,
    setAttribute(k: string, v: string) {
      attrs.set(k, v);
      log.push(`@${k}=${v}`);
    },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
      log.push(v);
    },
  } as unknown as HTMLElement & { log: string[] };
}

test('stillMotion follows prefers-reduced-motion', () => {
  reduce(true);
  assert.equal(stillMotion(), true);
  reduce(false);
  assert.equal(stillMotion(), false);
  g.matchMedia = undefined;
  assert.equal(stillMotion(), false, 'no matchMedia is not still');
});

test('typeIn: labels the whole text first, types it, and ends whole', () => {
  reduce(false);
  const c = clock();
  const n = node();
  const text = 'Eleven merged overnight.';
  typeIn(n, text);
  assert.equal(n.log[0], `@aria-label=${text}`, 'the label comes before any text');
  c.tick(1000);
  c.tick(1016);
  assert.ok(n.textContent.length > 0 && n.textContent.length < text.length, `part way: "${n.textContent}"`);
  assert.ok(text.startsWith(n.textContent));
  for (let t = 1032; c.pending() && t < 3000; t += 16) c.tick(t);
  assert.equal(n.textContent, text);
  assert.equal(c.pending(), 0, 'the loop stops when the text is whole');
});

test('typeIn: a cancel ends with the whole text and stops the loop', () => {
  reduce(false);
  const c = clock();
  const n = node();
  const cancel = typeIn(n, 'A line that is cut short by a cancel.');
  c.tick(0);
  c.tick(16);
  cancel();
  assert.equal(n.textContent, 'A line that is cut short by a cancel.');
  assert.equal(c.pending(), 0);
  cancel();
  assert.equal(n.textContent, 'A line that is cut short by a cancel.', 'a second cancel is harmless');
});

test('typeIn: with reduced motion the text is whole at once', () => {
  reduce(true);
  const c = clock();
  const n = node();
  typeIn(n, 'Still.');
  assert.equal(n.textContent, 'Still.');
  assert.equal(c.pending(), 0);
});

test('scanOnce: adds os-scanning for the scan, then removes it', async () => {
  reduce(false);
  const classes = new Set<string>();
  const children: unknown[] = [];
  g.document = {
    createElement: () => {
      const child = {
        className: '',
        setAttribute() {},
        remove() {
          children.splice(children.indexOf(child), 1);
        },
      };
      return child;
    },
  };
  const host = {
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    append: (c: unknown) => children.push(c),
  } as unknown as HTMLElement;
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    scanOnce(host);
    assert.ok(classes.has('os-scanning'));
    assert.equal(children.length, 1, 'the cursor is drawn');
    mock.timers.tick(MOTION.scanMs - 1);
    assert.ok(classes.has('os-scanning'));
    mock.timers.tick(1);
    assert.ok(!classes.has('os-scanning'));
    assert.equal(children.length, 0, 'the cursor is gone');
  } finally {
    mock.timers.reset();
  }
});

test('scanOnce: does nothing when still', () => {
  reduce(true);
  const classes = new Set<string>();
  const host = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, append() {} } as unknown as HTMLElement;
  scanOnce(host);
  assert.equal(classes.size, 0);
});
