/**
 * Readouts and figures (app/src/ui/os/readout-model.ts and readout.ts): the
 * pure models under each instrument, then the instruments themselves against
 * a small stand-in for the DOM, and readout.css's text held to 4.5:1 over the
 * panel at its thinnest on the city's brightest pixel.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { contrast, hex, over } from '../app/src/ui/contrast.js';
import { rangeModel, segmentModel, tickModel } from '../app/src/ui/os/readout-model.js';
import { agreementScales, figure, rangefinder, readoutRow, segmentBar, tickStrip } from '../app/src/ui/os/readout.js';
import { cssTokens, GROUND } from '../app/src/ui/os/tokens.js';

// ---------------------------------------------------------------- the models

test('rangeModel: a reading under its cap', () => {
  assert.deepEqual(rangeModel('five-hour', 44.83, 50), { run: 44.83, head: 44.83, cap: 50, over: false, label: 'five-hour window 45%, limit 50%' });
});

test('rangeModel: a window not read has no head and no run', () => {
  const m = rangeModel('five-hour', null, 50);
  assert.equal(m.head, null);
  assert.equal(m.run, 0);
  assert.equal(m.over, false);
  assert.equal(m.label, 'five-hour window not read, limit 50%');
});

test('rangeModel: past the end of the scale the run stops at 100, and it is over its cap', () => {
  const m = rangeModel('seven-day', 120, 50);
  assert.equal(m.run, 100);
  assert.equal(m.head, 100);
  assert.equal(m.over, true);
  assert.equal(m.label, 'seven-day window 120%, limit 50%, over the limit');
});

test('rangeModel: at the cap is over; no cap is never over and says no limit', () => {
  assert.equal(rangeModel('five-hour', 50, 50).over, true);
  assert.equal(rangeModel('five-hour', 50, 50).label, 'five-hour window 50%, limit 50%, over the limit');
  const m = rangeModel('five-hour', 80, null);
  assert.equal(m.over, false);
  assert.equal(m.cap, null);
  assert.equal(m.label, 'five-hour window 80%');
  assert.equal(rangeModel('five-hour', -4, 50).run, 0);
});

test('tickModel: the misses fall at the newest end', () => {
  const t = tickModel(48, 50);
  assert.equal(t.length, 50);
  assert.deepEqual(t.slice(0, 48), Array(48).fill('on'));
  assert.deepEqual(t.slice(48), ['off', 'off']);
  assert.deepEqual(tickModel(0, 0), []);
  assert.deepEqual(tickModel(10, 10), Array(10).fill('on'));
  // More agreed than decided cannot be drawn; it is held to the run.
  assert.deepEqual(tickModel(5, 3), ['on', 'on', 'on']);
});

test('segmentModel: zero parts drop out and the shares sum to 1', () => {
  const s = segmentModel([
    { key: 'real', n: 8 },
    { key: 'partial', n: 0 },
    { key: 'missing', n: 2 },
  ]);
  assert.deepEqual(
    s.map((p) => p.key),
    ['real', 'missing'],
  );
  assert.deepEqual(
    s.map((p) => p.share),
    [0.8, 0.2],
  );
  assert.deepEqual(
    segmentModel([
      { key: 'real', n: 0 },
      { key: 'broken', n: 0 },
    ]),
    [],
  );
});

// ---------------------------------------------------------------- the DOM

/** Just enough of an element for readout.ts. */
class Fake {
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: Fake[] = [];
  readonly props = new Map<string, string>();
  readonly style: Record<string, unknown> = { setProperty: (k: string, v: string) => this.props.set(k, v) };
  text = '';
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
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
    if (k === 'class') this.className = String(v);
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  append(...n: Array<Fake | string>): void {
    for (const c of n) {
      if (typeof c === 'string') {
        const t = new Fake('#text');
        t.text = c;
        this.children.push(t);
      } else this.children.push(c);
    }
  }
  all(): Fake[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): Fake[] {
    return this.all().filter((c) => c.classes.has(cls));
  }
  tags(tag: string): Fake[] {
    return this.all().filter((c) => c.tagName === tag);
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
const SVG = 'http://www.w3.org/2000/svg';

test('readoutRow: each figure in tabular mono, its key beside it, toned by TONE_INK', () => {
  const row = asFake(
    readoutRow([
      { v: '#312', k: 'PR' },
      { v: '4.10', k: 'credits', tone: 'ok' },
      { v: '', k: 'nothing' },
      { v: 'merged' },
    ]),
  );
  const cells = row.find('os-readout');
  assert.equal(cells.length, 3, 'the empty figure renders nothing');
  assert.equal(row.textContent.includes('nothing'), false);
  const v = cells.map((c) => c.find('os-readout-v')[0]);
  assert.ok(v.every((x) => x.classes.has('os-figs')));
  assert.deepEqual(
    v.map((x) => x.textContent),
    ['#312', '4.10', 'merged'],
  );
  assert.equal(cells[1].find('os-readout-k')[0].textContent, 'credits');
  assert.equal(cells[2].find('os-readout-k').length, 0, 'no key, no empty key');
  assert.equal(v[1].style.color, 'var(--os-ok)');
  assert.equal(v[0].style.color, undefined);
});

test('readoutRow: nothing to read is null, never an empty box', () => {
  assert.equal(readoutRow([]), null);
  assert.equal(readoutRow([{ v: '' }, { v: '', k: 'credits' }]), null);
});

test('figure: a value in tabular mono over its label, sentence case, toned or hot', () => {
  const f = asFake(figure('963.24', 'credits'));
  assert.equal(f.find('os-figure-v')[0].textContent, '963.24');
  assert.ok(f.find('os-figure-v')[0].classes.has('os-figs'));
  assert.equal(f.find('os-label')[0].textContent, 'Credits');
  assert.equal(f.dataset.tone, undefined);
  assert.equal(asFake(figure('6', 'wait on you', 'hot')).dataset.tone, 'hot');
  const ok = asFake(figure('11', 'merged', 'ok'));
  assert.equal(ok.find('os-figure-v')[0].style.color, 'var(--os-ok)');
  assert.equal(asFake(figure('0', 'failed', 'quiet')).find('os-figure-v')[0].style.color, 'var(--os-dim)');
});

test('rangefinder: one image with the whole reading, a run, a head and the cap', () => {
  const r = asFake(rangefinder('five-hour', 44.83, 50));
  assert.equal(r.getAttribute('role'), 'img');
  assert.equal(r.getAttribute('aria-label'), 'five-hour window 45%, limit 50%');
  assert.equal(r.find('os-label')[0].textContent, 'Five-hour');
  assert.equal(r.find('os-range-fig')[0].textContent, '45%');
  assert.equal(r.find('os-range-head').length, 1);
  assert.equal(r.find('os-range-cap').length, 1);
  assert.equal(r.classes.has('is-over'), false);
  assert.equal(r.find('os-range-over').length, 0, 'under its cap, no word says over');
  assert.equal(r.props.get('--os-run'), '0.4483');
  assert.equal(r.props.get('--os-head'), '44.83%');
  assert.equal(r.props.get('--os-cap'), '50%');

  const over = asFake(rangefinder('seven-day', 62, 50));
  assert.ok(over.classes.has('is-over'));
  assert.equal(over.getAttribute('aria-label'), 'seven-day window 62%, limit 50%, over the limit');
  // Over is a word on the screen too, not colour alone.
  assert.deepEqual(
    over.find('os-range-over').map((w) => w.textContent),
    ['over'],
  );

  const none = asFake(rangefinder('five-hour', null, null));
  assert.equal(none.getAttribute('aria-label'), 'five-hour window not read');
  assert.equal(none.find('os-range-head').length, 0);
  assert.equal(none.find('os-range-cap').length, 0);
  assert.equal(none.find('os-range-fig')[0].textContent, 'Not read');
  assert.equal(none.find('os-range-over').length, 0);
  assert.ok(!/undefined|NaN|null/.test(none.textContent));
});

test('tickStrip: one rect a decision, the misses last, sized by its count', () => {
  const s = asFake(tickStrip(48, 50, 'all'));
  assert.equal(s.tagName, 'svg');
  assert.equal(s.namespaceURI, SVG);
  assert.equal(s.getAttribute('role'), 'img');
  assert.equal(s.getAttribute('aria-label'), '48 of 50');
  assert.ok(s.classes.has('os-ticks') && s.classes.has('all'));
  const rects = s.tags('rect');
  assert.equal(rects.length, 50);
  assert.deepEqual(
    rects.slice(48).map((r) => r.getAttribute('class')),
    ['off', 'off'],
  );
  assert.ok(rects.every((r) => r.namespaceURI === SVG));
  assert.equal(s.props.get('--os-ticks'), '50');
  assert.equal(asFake(tickStrip(0, 0)).tags('rect').length, 0);
});

test('segmentBar: a part a verdict that has any, its count in the key; null when all are zero', () => {
  const parts = [
    { key: 'real', n: 8 },
    { key: 'partial', n: 3 },
    { key: 'missing', n: 0 },
    { key: 'stubbed', n: 1 },
    { key: 'broken', n: 2 },
  ];
  const b = asFake(segmentBar(parts, '8 real, 3 partial, 1 stubbed, 2 broken'));
  assert.equal(b.getAttribute('role'), 'img');
  assert.equal(b.getAttribute('aria-label'), '8 real, 3 partial, 1 stubbed, 2 broken');
  const segs = b.find('os-seg');
  assert.deepEqual(
    segs.map((s) => s.dataset.key),
    ['real', 'partial', 'stubbed', 'broken'],
  );
  assert.equal(segs[0].props.get('--os-share'), String(8 / 14));
  const key = b.find('os-seg-key');
  assert.deepEqual(
    key.map((k) => k.textContent),
    ['8 real', '3 partial', '1 stubbed', '2 broken'],
  );
  assert.equal(
    segmentBar(
      [
        { key: 'real', n: 0 },
        { key: 'broken', n: 0 },
      ],
      'nothing',
    ),
    null,
  );
});

test('agreementScales: two scales, every repo and here, each with its own count and label', () => {
  const a = asFake(agreementScales({ agreed: 48, of: 50, here: 10, hereOf: 10 }));
  assert.equal(a.getAttribute('role'), 'img');
  assert.equal(a.getAttribute('aria-label'), 'The master agreed with you on 48 of its last 50 decisions over every repo, and on 10 of its last 10 here');
  const strips = a.tags('svg');
  assert.equal(strips.length, 2);
  assert.equal(strips[0].tags('rect').length, 50);
  assert.equal(strips[1].tags('rect').length, 10);
  assert.deepEqual(
    a.find('os-agree-v').map((v) => v.textContent),
    ['48/50', '10/10'],
  );
  assert.deepEqual(
    a.find('os-label').map((v) => v.textContent),
    ['Last 50, every repo', 'Last 10, here'],
  );
});

test('agreementScales: fewer than 10 decisions here shows only those, and none says so', () => {
  const few = asFake(agreementScales({ agreed: 40, of: 50, here: 3, hereOf: 4 }));
  assert.equal(few.tags('svg')[1].tags('rect').length, 4);
  assert.deepEqual(
    few.find('os-agree-v').map((v) => v.textContent),
    ['40/50', '3/4'],
  );
  assert.equal(few.find('os-label')[1].textContent, 'Last 4, here');
  assert.match(few.getAttribute('aria-label') ?? '', /on 3 of its last 4 here$/);

  const none = asFake(agreementScales({ agreed: 40, of: 50, here: 0, hereOf: 0 }));
  assert.equal(none.tags('svg').length, 1);
  assert.match(none.getAttribute('aria-label') ?? '', /, and has made no decisions here yet$/);
  assert.ok(none.textContent.includes('None here yet'));

  assert.equal(agreementScales({ agreed: 0, of: 0, here: 0, hereOf: 0 }), null);
});

// ---------------------------------------------------------------- readout.css

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = readFileSync(join(ROOT, 'app', 'src', 'ui', 'os', 'readout.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = cssTokens();
const PANEL = over([255, 255, 255], GROUND.rgb, GROUND.textMinAlpha);

test("readout.css sets its words in the tokens' inks, each 4.5:1 on the thinnest panel, on no ground of its own", () => {
  const rules = [...SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  let inks = 0;
  for (const [, sel, body] of rules) {
    for (const m of body.matchAll(/(?:^|;|\s)color\s*:\s*([^;]+)/g)) {
      const v = m[1].trim();
      const t = /^var\((--os-[\w-]+)\)$/.exec(v);
      assert.ok(t && TOKENS[t[1]] && /^#/.test(TOKENS[t[1]]), `readout.css ${sel.trim()}: text in ${v}, not a token ink`);
      const r = contrast(hex(TOKENS[t[1]]), PANEL);
      assert.ok(r >= 4.5, `readout.css ${sel.trim()}: ${v} is ${r.toFixed(2)}:1`);
      // Text stands on the panel itself: no ground under it, and never faded.
      assert.ok(!/(?:^|;|\s)background(?:-color)?\s*:/.test(body), `readout.css ${sel.trim()} puts its words on a ground of its own`);
      assert.ok(!/(?:^|;|\s)opacity\s*:/.test(body), `readout.css ${sel.trim()} fades its words`);
      inks++;
    }
  }
  assert.ok(inks >= 4, 'readout.css sets the inks of its words');
});

test('readout.css: red is not used, and labels are the display face, figures the mono', () => {
  assert.ok(!/--os-red/.test(SHEET), 'red is the lock and the grant alone');
  const rule = (sel: string): string => {
    const m = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(SHEET);
    assert.ok(m, `readout.css has ${sel}`);
    return m[1];
  };
  assert.match(rule('.os-label'), /font-family:\s*var\(--os-display\)/);
  assert.match(rule('.os-label'), /white-space:\s*nowrap/);
});
