/**
 * The screens' readouts and instruments, built on readout-model.ts: a row of
 * figures, a head figure, the rangefinder, a tick scale, a segmented bar, and
 * the autonomy ask's two agreement scales.
 *
 * Every figure is Azeret Mono in tabular numerals (.os-figs), every label Big
 * Shoulders in sentence case (.os-label). Each instrument is one role="img"
 * whose aria-label says the whole reading. Nothing is built that has nothing
 * to show: an empty row or bar is null, and callers skip null. All text is
 * set with textContent. No CSS import, so this runs in node; readout.css
 * draws it.
 */
import { rangeModel, segmentModel, tickModel, type Readout } from './readout-model.js';
import { TONE_INK, type Tone } from './tokens.js';

export type { Readout } from './readout-model.js';

const SVG = 'http://www.w3.org/2000/svg';

const el = (tag: string, cls: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const svg = (tag: string, attrs: Record<string, string>): SVGElement => {
  const n = document.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** 'five-hour' as a label: 'Five-hour'. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Sets a figure in its tone's ink, read from the tokens. */
const ink = (n: HTMLElement, tone: Tone | undefined): void => {
  if (tone) n.style.color = `var(--os-${TONE_INK[tone]})`;
};

const img = (n: Element, label: string): void => {
  n.setAttribute('role', 'img');
  n.setAttribute('aria-label', label);
};

/**
 * A line of readouts: each figure in mono, its key in the display face beside
 * it, toned by its state. A readout with an empty figure is left out, and a
 * row with nothing left is null, never an empty box.
 */
export function readoutRow(rs: Readout[]): HTMLElement | null {
  const shown = rs.filter((r) => r.v !== '');
  if (!shown.length) return null;
  const row = el('div', 'os-readouts');
  for (const r of shown) {
    const cell = el('span', 'os-readout');
    const v = el('span', 'os-readout-v os-figs', r.v);
    ink(v, r.tone);
    cell.append(v);
    if (r.k) cell.append(el('span', 'os-readout-k', r.k));
    row.append(cell);
  }
  return row;
}

/**
 * A head figure: a large numeral over its label. `tone` sets it in a state's
 * ink; 'hot' lights it amber, for the one figure that wants Connor now.
 */
export function figure(value: string, label: string, tone?: Tone | 'hot'): HTMLElement {
  const box = el('div', 'os-figure');
  const v = el('span', 'os-figure-v os-figs', value);
  if (tone) box.dataset.tone = tone;
  if (tone && tone !== 'hot') ink(v, tone);
  box.append(v, el('span', 'os-label', sentence(label)));
  return box;
}

/**
 * A rangefinder: a window's use as a lit run along a ruled scale, a head at
 * its end, and the cap standing on the scale as a bracket. At or past its cap
 * it is .is-over. `label` names the window: 'five-hour'.
 */
export function rangefinder(label: string, pct: number | null, cap: number | null): HTMLElement {
  const m = rangeModel(label, pct, cap);
  const box = el('div', 'os-range');
  img(box, m.label);
  if (m.over) box.classList.add('is-over');
  box.style.setProperty('--os-run', String(m.run / 100));

  const top = el('div', 'os-range-top');
  top.append(el('span', 'os-label', sentence(label)));
  const read = el('span', 'os-range-read');
  read.append(el('span', 'os-range-fig os-figs', m.head === null ? 'Not read' : `${Math.round(pct ?? 0)}%`));
  if (m.cap !== null) read.append(el('span', 'os-range-limit os-figs', `limit ${Math.round(cap ?? 0)}%`));
  top.append(read);

  const scale = el('div', 'os-range-scale');
  scale.append(el('span', 'os-range-run'));
  if (m.head !== null) {
    box.style.setProperty('--os-head', `${m.head}%`);
    scale.append(el('span', 'os-range-head'));
  }
  if (m.cap !== null) {
    box.style.setProperty('--os-cap', `${m.cap}%`);
    scale.append(el('span', 'os-range-cap'));
  }
  box.append(top, scale);
  return box;
}

/**
 * A run of `of` decisions as a strip of ticks, `on` of them agreed and lit,
 * the misses hollow at the newest end. Every tick has the same pitch on every
 * strip (--os-ticks sets its width), so a short run looks short.
 */
export function tickStrip(on: number, of: number, cls?: string): SVGSVGElement {
  const ticks = tickModel(on, of);
  const PITCH = 6;
  const strip = svg('svg', {
    class: `os-ticks${cls ? ` ${cls}` : ''}`,
    viewBox: `0 0 ${Math.max(1, ticks.length * PITCH)} 18`,
    preserveAspectRatio: 'none',
    focusable: 'false',
  }) as SVGSVGElement;
  img(strip, `${ticks.filter((t) => t === 'on').length} of ${ticks.length}`);
  strip.style.setProperty('--os-ticks', String(ticks.length));
  ticks.forEach((t, i) => {
    // A miss is drawn hollow, inset by half its stroke so the outline stays inside its slot.
    const r = t === 'on' ? { x: i * PITCH + 1, y: 0, width: 3, height: 18 } : { x: i * PITCH + 1.6, y: 0.6, width: 1.8, height: 16.8 };
    strip.append(svg('rect', { class: t, x: String(r.x), y: String(r.y), width: String(r.width), height: String(r.height) }));
  });
  return strip;
}

/**
 * Parts of a whole as one segmented bar, a segment a part that has any, and a
 * key under it with each count. `aria` is the whole reading. All zero is null.
 */
export function segmentBar(parts: Array<{ key: string; n: number }>, aria: string): HTMLElement | null {
  const segs = segmentModel(parts);
  if (!segs.length) return null;
  const box = el('div', 'os-segs');
  img(box, aria);
  const bar = el('div', 'os-seg-bar');
  const key = el('div', 'os-seg-keys');
  for (const s of segs) {
    const seg = el('span', 'os-seg');
    seg.dataset.key = s.key;
    seg.style.setProperty('--os-share', String(s.share));
    bar.append(seg);
    const k = el('span', 'os-seg-key');
    k.dataset.key = s.key;
    k.append(el('span', 'os-seg-n os-figs', String(s.n)), ' ', el('span', 'os-seg-word', s.key));
    key.append(k);
  }
  box.append(bar, key);
  return box;
}

/** The autonomy ask's evidence: the master's run over every repo, and its own run in this repo. */
export interface Agreement {
  /** Decisions agreed over every repo, of the last `of`. */
  agreed: number;
  of: number;
  /** Decisions agreed in this repo, of its last `hereOf` (10 or fewer). */
  here: number;
  hereOf: number;
}

function scaleRow(on: number, of: number, scale: 'all' | 'here', label: string): HTMLElement {
  const row = el('div', 'os-agree-row');
  row.dataset.scale = scale;
  row.append(el('span', 'os-agree-v os-figs', `${on}/${of}`), tickStrip(on, of, scale), el('span', 'os-label', label));
  return row;
}

/**
 * The two agreement scales, each its own run with its own count: the last
 * `of` decisions over every repo, and the last `hereOf` here. They share one
 * tick pitch, so ten here stands a fifth as long as fifty everywhere, and the
 * two can never read as one run that contradicts itself. With no decisions
 * here yet it says so. With no decisions at all there is nothing to show.
 */
export function agreementScales(a: Agreement): HTMLElement | null {
  const of = Math.max(0, Math.floor(a.of));
  if (!of) return null;
  const agreed = Math.max(0, Math.min(of, Math.floor(a.agreed)));
  const hereOf = Math.max(0, Math.floor(a.hereOf));
  const here = Math.max(0, Math.min(hereOf, Math.floor(a.here)));
  const box = el('div', 'os-agree');
  img(box, `The master agreed with you on ${agreed} of its last ${of} decisions over every repo, ${hereOf ? `and on ${here} of its last ${hereOf} here` : 'and has made no decisions here yet'}`);
  box.append(scaleRow(agreed, of, 'all', `Last ${of}, every repo`));
  if (hereOf) box.append(scaleRow(here, hereOf, 'here', `Last ${hereOf}, here`));
  else {
    const row = el('div', 'os-agree-row');
    row.dataset.scale = 'here';
    row.append(el('span', 'os-label', 'None here yet'));
    box.append(row);
  }
  return box;
}
