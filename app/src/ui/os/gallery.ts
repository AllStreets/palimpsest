/**
 * The screens layer's debug gallery: each primitive shown alone over the city,
 * for stills (tools/os-stills.ts) and critique. It is reached only through the
 * debug handle's osGallery, by dynamic import, so the normal path never loads
 * it or the os stylesheets it brings. Each later task adds its own kind.
 *
 * All text is set with textContent.
 */
import './index.css';
import './gallery.css';

import { contrast, hex, over } from '../contrast.js';
import { createSheet } from '../controls.js';
import { osKey, WEIGHTS, type Weight } from './control.js';
import { scanOnce, typeIn } from './motion.js';
import { dressPanel } from './panel.js';
import { agreementScales, figure, rangefinder, readoutRow, segmentBar } from './readout.js';
import { COLOUR, GROUND, type ColourToken } from './tokens.js';

export type GalleryKind = 'type' | 'panel' | 'controls' | 'readouts' | 'pins' | 'terminal';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** What each colour is for, in a few words. */
const ROLE: Record<ColourToken, string> = {
  ground: 'the ground',
  ink: 'headlines',
  ink2: 'body',
  dim: 'labels',
  amber: 'brackets, focus',
  amberHi: 'the hot figure',
  red: 'lock and grant',
  ice: 'look keys',
  ok: 'merged, passing',
  warn: 'waiting',
  fail: 'failed',
  benched: 'benched',
};

/** The worst ground any text stands on: the panel at its thinnest over the city's brightest pixel. */
const WORST = over([255, 255, 255], GROUND.rgb, GROUND.textMinAlpha);

/**
 * The type specimen: the date, a headline, two rows of figures, every colour,
 * and the focus ring. The headline types in and the figures take one scan, on
 * mount and on Replay; with reduced motion both are whole and still at once.
 * Returns its cleanup.
 */
function typeSpecimen(host: HTMLElement): () => void {
  host.append(el('p', 'os-gallery-label', 'Type and colour'));

  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  host.append(el('h1', 'os-gallery-date', date));
  const headline = 'Eleven merged overnight. Six wait on you, and one asks for the city.';
  // The whole line holds its place unseen, so the typing never reflows what follows.
  const hold = el('p', 'os-gallery-head os-type-hold');
  const ghost = el('span', 'os-type-ghost', headline);
  ghost.setAttribute('aria-hidden', 'true');
  const head = el('span', '');
  hold.append(ghost, head);
  host.append(hold);

  const figs = el('div', 'os-gallery-figs os-figs');
  const rows: Array<Array<[string, string]>> = [
    [['963.24', 'credits'], ['11', 'merged'], ['45%', 'of 50%'], ['06:40', 'since']],
    [['120.08', 'credits'], ['7', 'merged'], ['21%', 'of 50%'], ['19:52', 'since']],
  ];
  for (const row of rows) {
    for (const [v, k] of row) {
      const cell = el('span', 'os-gallery-fig');
      cell.append(el('span', 'os-gallery-v', v), el('span', 'os-gallery-k', k));
      figs.append(cell);
    }
  }
  host.append(figs);

  let cancel = typeIn(head, headline);
  scanOnce(figs);
  const replay = el('button', 'os-gallery-replay os-focus', 'Replay');
  replay.type = 'button';
  replay.addEventListener('click', () => {
    cancel();
    cancel = typeIn(head, headline);
    scanOnce(figs);
  });
  host.append(replay);

  const swatches = el('ul', 'os-gallery-swatches');
  for (const [name, value] of Object.entries(COLOUR) as Array<[ColourToken, string]>) {
    const li = el('li', `os-gallery-swatch${name === 'ground' ? ' is-ground' : ''}`);
    const chip = el('span', 'os-gallery-chip');
    chip.style.background = value;
    const label = el('span', 'os-gallery-name', name);
    if (name !== 'ground') label.style.color = value;
    const ratio = name === 'ground' ? `alpha ${GROUND.textMinAlpha}` : `${contrast(hex(value), WORST).toFixed(1)}:1`;
    li.append(chip, label, el('span', 'os-gallery-role', ROLE[name]), el('span', 'os-gallery-ratio os-figs', ratio));
    swatches.append(li);
  }
  host.append(swatches);

  const ring = el('div', 'os-gallery-ring');
  const key = el('button', 'os-gallery-key os-focus', 'Fly there');
  key.type = 'button';
  ring.append(key, el('span', 'os-gallery-role', 'Keyboard focus'));
  host.append(ring);
  // After layout, so the ring shows as keyboard focus does.
  requestAnimationFrame(() => key.focus({ preventScroll: true }));
  return () => cancel();
}

/** Ten rows of placeholder work, a headline and its figures each, for the panel to hold. */
const SAMPLE_ROWS: Array<[string, string[]]> = [
  ['harbor-ledger: the nightly export is merged', ['#312', '4.10', 'merged']],
  ['kumo: retries halted after the third failure', ['#88', '1.92', 'halted']],
  ['assay-kit: a dependency bump waits on review', ['#41', '0.66', 'waiting']],
  ['quarry: the flaky clock test is fixed', ['#207', '2.38', 'merged']],
  ['blank-slate: the first build asks for a tier', ['#3', '0.00', 'waiting']],
  ['harbor-ledger: the audit found two stale keys', ['#315', '1.14', 'waiting']],
  ['kumo: the cache warmer is benched for a week', ['#90', '0.40', 'benched']],
  ['assay-kit: the parser handles empty rows', ['#44', '3.02', 'merged']],
  ['quarry: the deploy script is rewritten', ['#210', '5.75', 'merged']],
  ['harbor-ledger: the ledger view is 60% faster', ['#318', '2.91', 'merged']],
];

/**
 * The panel: a sample sheet dressed as the screens' panel, its head the date
 * and a line of figures, ten placeholder rows in its list, and the stream of
 * the rows' own words behind them. The date is fixed, so stills compare.
 */
function panelSpecimen(host: HTMLElement): () => void {
  host.classList.add('is-panel');
  const sheet = createSheet(host, 'os-sample', 'Saturday 21 November', () => {});
  const panel = dressPanel(sheet);
  const head = panel.head;
  head.append(el('p', 'os-sample-since', 'Since yesterday 19:52'));
  const figs = el('p', 'os-sample-figs os-figs');
  for (const [v, k] of [['11', 'merged'], ['6', 'wait on you'], ['963.24', 'credits']]) {
    const f = el('span', 'os-sample-fig');
    f.append(el('span', 'os-sample-v', v), el('span', 'os-sample-k', k));
    figs.append(f);
  }
  head.append(figs);

  const list = el('ol', 'os-sample-rows');
  for (const [line, figures] of SAMPLE_ROWS) {
    const row = el('li', 'os-sample-row');
    row.append(el('span', 'os-sample-line', line), el('span', 'os-sample-row-figs os-figs', figures.join('  ')));
    list.append(row);
  }
  panel.list.append(list);
  panel.setStream(SAMPLE_ROWS.flatMap(([line, figures]) => [line.split(':')[0], ...figures]));
  sheet.show();
  return () => panel.dispose();
}

/** Each weight's key in the specimen, with what it is for. */
const KEYS: Record<Weight, { label: string; sum?: string; for: string }> = {
  look: { label: 'Fly there', for: 'Why, Diff, Fly there, Open PR' },
  decide: { label: 'Dismiss', for: 'Dismiss, decline, revoke' },
  spend: { label: 'Post', sum: '60 cr', for: 'Post, retry, resume, audit, tier' },
  grant: { label: 'Let it act here', for: 'The autonomy grant alone' },
};

const STATES = ['at rest', 'focused', 'disabled', 'busy'] as const;

/**
 * The controls: each of the four weights, lightest to heaviest, at rest,
 * focused, disabled and busy. Keyboard focus can be on one key only, so the
 * grant's focused key takes it on mount; the others carry
 * data-gallery-focus, for a still that focuses each in turn.
 */
function controlsSpecimen(host: HTMLElement): void {
  host.append(el('p', 'os-gallery-label', 'Keys, lightest to heaviest'));
  let first: HTMLButtonElement | null = null;
  for (const w of WEIGHTS) {
    const spec = KEYS[w];
    const row = el('section', 'os-gallery-weight');
    row.dataset.weight = w;
    const head = el('p', 'os-gallery-wname');
    head.append(el('span', 'os-gallery-wword', w[0].toUpperCase() + w.slice(1)), el('span', 'os-gallery-role', spec.for));
    row.append(head);
    const states = el('div', 'os-gallery-states');
    for (const state of STATES) {
      const cell = el('div', 'os-gallery-state');
      const key = osKey(spec.label, w, () => {}, { sum: spec.sum });
      if (state === 'disabled') key.disabled = true;
      if (state === 'busy') key.setAttribute('aria-busy', 'true');
      if (state === 'focused') {
        key.dataset.galleryFocus = w;
        if (w === 'grant') first = key;
      }
      cell.append(key, el('span', 'os-gallery-role', state));
      states.append(cell);
    }
    row.append(states);
    host.append(row);
  }
  // After layout, so the ring shows as keyboard focus does.
  requestAnimationFrame(() => first?.focus({ preventScroll: true }));
}

/** The five verdicts an audit gives its claims, for the claims bar. */
const CLAIMS: Array<{ key: string; n: number }> = [
  { key: 'real', n: 18 },
  { key: 'partial', n: 4 },
  { key: 'missing', n: 2 },
  { key: 'stubbed', n: 1 },
  { key: 'broken', n: 1 },
];

/**
 * The readouts: a row of head figures with a line of readouts under it, two
 * rangefinders (the seven-day one over its cap), the autonomy ask's two
 * agreement scales (48 of 50 over every repo, 10 of 10 here), and an audit's
 * claims bar with all five verdicts.
 */
function readoutsSpecimen(host: HTMLElement): void {
  const section = (label: string, cls: string): HTMLElement => {
    const s = el('section', `os-gallery-readout ${cls}`);
    s.append(el('p', 'os-gallery-label', label));
    host.append(s);
    return s;
  };
  const figs = section('Figures', 'is-figures');
  const row = el('div', 'os-gallery-figrow');
  row.append(figure('6', 'wait on you', 'hot'), figure('11', 'merged'), figure('963.24', 'credits'));
  figs.append(row);
  const line = readoutRow([
    { v: '#312', k: 'PR' },
    { v: '4.10', k: 'credits' },
    { v: 'merged', tone: 'ok' },
    { v: '', k: 'left out' },
  ]);
  if (line) figs.append(line);

  const ranges = section('Rangefinders', 'is-ranges');
  const pair = el('div', 'os-gallery-ranges');
  pair.append(rangefinder('five-hour', 44.83, 50), rangefinder('seven-day', 62, 50));
  ranges.append(pair);

  const agree = agreementScales({ agreed: 48, of: 50, here: 10, hereOf: 10 });
  if (agree) section('Agreement', 'is-agree').append(agree);

  const claims = segmentBar(CLAIMS, CLAIMS.map((c) => `${c.n} ${c.key}`).join(', '));
  if (claims) section('Claims', 'is-claims').append(claims);
}

const BUILT: Partial<Record<GalleryKind, (host: HTMLElement) => void | (() => void)>> = { type: typeSpecimen, panel: panelSpecimen, controls: controlsSpecimen, readouts: readoutsSpecimen };

/** Shows one kind of the gallery over the city, and returns its unmount. */
export function mountGallery(parent: HTMLElement, kind: GalleryKind): () => void {
  const root = el('section', 'os-gallery');
  root.dataset.kind = kind;
  root.setAttribute('aria-label', `Gallery: ${kind}`);
  const build = BUILT[kind];
  const cleanup = build ? build(root) : root.append(el('p', 'os-gallery-label', `${kind}: not built yet`));
  parent.append(root);
  return () => {
    cleanup?.();
    root.remove();
  };
}
