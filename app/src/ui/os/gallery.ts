/**
 * The screens layer's debug gallery: each primitive shown alone over the city,
 * for stills (tools/os-stills.ts) and critique. It is reached only through the
 * debug handle's osGallery, by dynamic import, so the normal path never loads
 * it. The os stylesheets it imports are loaded on the normal path too, through
 * main.ts. Each later task adds its own kind.
 *
 * All text is set with textContent.
 */
import './index.css';
import './gallery.css';

import * as THREE from 'three';

import { projectToView } from '../../city/labels.js';
import { contrast, hex, over } from '../contrast.js';
import { createSheet } from '../controls.js';
import { osKey, WEIGHTS, type Weight } from './control.js';
import { scanOnce, typeIn } from './motion.js';
import { dressPanel } from './panel.js';
import { createPins, type OsCity, type PinTarget } from './pins.js';
import { agreementScales, figure, rangefinder, readoutRow, segmentBar } from './readout.js';
import { createTerminal } from './terminal.js';
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

/** A repo the city has no district for: its row is a target, and it gets no pin (Review Focus 2). */
const UNBUILT = 'wren/not-built-yet';

/** The sample city's districts the pins kind prefers, in order: the lock, the grant, the quiet third. */
const PREFER = ['harbor-ledger', 'fieldnotes', 'quarry'];
const shortName = (repo: string): string => repo.split('/').pop() ?? repo;

/**
 * Up to three standing districts for the sample's targets: the preferred sample ones that stand in view, then
 * those whose towers stand well inside the pane: the one nearest its middle, the one farthest from it, then the
 * next nearest. The first takes the lock and the second the grant.
 * Where too few stand in view, the rest come in the city's own order.
 */
function pickDistricts(city: OsCity, paneLeft: number): string[] {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const mid = (paneLeft + w) / 2;
  const seen = { x: 0, y: 0, behind: false };
  const at = new THREE.Vector3();
  const inView: Array<{ repo: string; d: number }> = [];
  const all = city.districts();
  for (const repo of all) {
    const f = city.towerFrame(repo);
    if (!f) continue;
    at.set(f.center.x, f.center.y + f.height / 2, f.center.z);
    projectToView(at, city.camera, w, h, seen);
    if (!seen.behind && seen.x > paneLeft + 80 && seen.x < w - 120 && seen.y > 160 && seen.y < h - 120) inView.push({ repo, d: Math.abs(seen.x - mid) });
  }
  inView.sort((a, b) => a.d - b.d);
  // The sample city's tall tower and a near one, where they stand in view, so the stills hold still between runs.
  const prefer = PREFER.map((name) => inView.find((v) => shortName(v.repo) === name)).filter((v) => v !== undefined);
  const rest = inView.filter((v) => !prefer.includes(v));
  const spread = rest.length >= 2 ? [rest[0], rest[rest.length - 1], ...rest.slice(1, -1)] : rest;
  const order = [...prefer, ...spread].map((v) => v.repo);
  for (const repo of all) if (!order.includes(repo)) order.push(repo);
  return order.slice(0, 3);
}

/**
 * The pins: the dressed panel with six sample rows over the screens framing, and the city's pins beside it.
 * Three rows are targets over two districts: the first takes the lock, the second is the grant, and the
 * fourth shares the grant's district, so its pin reads "02 +1"; and the sixth names a district not built yet,
 * which gets no pin. Every other standing district gets a quiet pin. The first target is locked on until a row
 * is hovered or focused.
 */
function pinsSpecimen(host: HTMLElement, city?: OsCity): () => void {
  host.classList.add('is-panel');
  const sheet = createSheet(host, 'os-sample', 'Saturday 21 November', () => {});
  const panel = dressPanel(sheet);
  panel.head.append(el('p', 'os-sample-since', 'Since yesterday 19:52'));
  const figs = el('p', 'os-sample-figs os-figs');
  for (const [v, k] of [['4', 'wait on you'], ['11', 'merged'], ['963.24', 'credits']]) {
    const f = el('span', 'os-sample-fig');
    f.append(el('span', 'os-sample-v', v), el('span', 'os-sample-k', k));
    figs.append(f);
  }
  panel.head.append(figs);
  sheet.show();

  const [a, b, c] = city ? pickDistricts(city, sheet.root.offsetLeft + sheet.root.offsetWidth) : [];
  const repoA = a ?? 'harbor/ledger';
  const repoB = b ?? 'kumo/cache';
  const repoC = c ?? 'quarry/deploy';
  const short = shortName;
  const rows: Array<{ repo: string; line: string; figs: string[]; target?: Omit<PinTarget, 'n' | 'repo' | 'name'> }> = [
    { repo: repoA, line: `${short(repoA)}: a dependency bump waits on review`, figs: ['#41', '0.66', 'waiting'], target: { id: 'r1', figure: '0.66 cr', tone: 'warn' } },
    { repo: repoB, line: `${short(repoB)}: asks to act here on its own`, figs: ['48 of 50', 'agreed'], target: { id: 'r2', figure: '48 of 50', tone: 'grant' } },
    { repo: repoC, line: `${short(repoC)}: the flaky clock test is fixed`, figs: ['#207', '2.38', 'merged'] },
    { repo: repoB, line: `${short(repoB)}: the audit found two stale keys`, figs: ['#315', '1.14', 'waiting'], target: { id: 'r4', figure: '1.14 cr', tone: 'ask' } },
    { repo: repoC, line: `${short(repoC)}: the deploy script is rewritten`, figs: ['#210', '5.75', 'merged'] },
    { repo: UNBUILT, line: `${short(UNBUILT)}: the first build asks for a tier`, figs: ['#3', '0.00', 'waiting'], target: { id: 'r6', figure: '0.00 cr', tone: 'warn' } },
  ];

  const pins = createPins(host, sheet.root, sheet.body, city);
  const list = el('ol', 'os-sample-rows');
  const targets: PinTarget[] = [];
  let first: { id: string; row: HTMLElement } | null = null;
  for (const [i, r] of rows.entries()) {
    const row = el('li', 'os-sample-row');
    row.dataset.repo = r.repo;
    row.append(el('span', 'os-sample-line', r.line), el('span', 'os-sample-row-figs os-figs', r.figs.join('  ')));
    if (r.target) {
      const t: PinTarget = { ...r.target, n: i + 1, repo: r.repo, name: short(r.repo) };
      targets.push(t);
      row.dataset.target = t.id;
      if (r.repo === UNBUILT) row.dataset.unbuilt = '';
      row.tabIndex = 0;
      row.classList.add('os-focus');
      first ??= { id: t.id, row };
      const lead = first;
      const rest = (): void => pins.setActive(lead.id, lead.row);
      row.addEventListener('pointerenter', () => pins.setActive(t.id, row));
      row.addEventListener('focus', () => pins.setActive(t.id, row));
      row.addEventListener('pointerleave', rest);
      row.addEventListener('blur', rest);
    }
    list.append(row);
  }
  panel.list.append(list);
  panel.setStream(rows.flatMap((r) => [short(r.repo), ...r.figs]));

  pins.setTargets(targets);
  pins.show();
  if (first) pins.setActive(first.id, first.row);
  return () => {
    pins.hide();
    panel.dispose();
  };
}

/** What a run's log says, step by step: a time, the words, and a tone where it passed or failed. */
const RUN_STEPS: Array<[string, string?]> = [
  ['run 41 starts on harbor-ledger, tier standard'],
  ['reading the issue: the nightly export drops rows past midnight UTC'],
  ['cloning harbor-ledger at 3f2a91c'],
  ['installing: 214 packages in 6.2 s'],
  ['reading src/export/nightly.ts (188 lines)'],
  ['reading src/export/window.ts (64 lines)'],
  ['the window is built from local midnight, not UTC'],
  ['running the export tests: 31 of 31 pass', 'ok'],
  ['writing a failing test: rows at 23:59 UTC go missing'],
  ['running it: 1 fails, as it should', 'fail'],
  ['changing window.ts: the day starts at UTC midnight'],
  ['running the export tests: 32 of 32 pass', 'ok'],
  ['running the whole suite: 412 of 412 pass', 'ok'],
  ['typecheck is clean', 'ok'],
  ['the diff: 2 files, 19 lines in, 6 out'],
  ['reviewing its own diff against the issue'],
];

/**
 * 80 lines of a sample run's log, each a time in dim figures and its words, built as nodes with textContent:
 * the terminal is handed nodes, never a string to parse. The times are fixed, so stills compare.
 */
function runLog(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < 80; i++) {
    const [said, tone] = i < RUN_STEPS.length ? RUN_STEPS[i] : [`checking export batch ${i - RUN_STEPS.length + 1} of 64: ${(i * 37) % 900 + 100} rows, all in their day`];
    const s = 6 * 3600 + 40 * 60 + i * 7;
    const at = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    const line = el('div', 'os-terminal-line');
    if (tone) line.dataset.tone = tone;
    line.append(el('span', 'os-terminal-at os-figs', at), el('span', 'os-terminal-said', said));
    out.push(line);
  }
  return out;
}

/**
 * Terminal mode: a look key that opens it, and the terminal open over the city with a sample run's 80-line log.
 * Escape and Close close it and hand focus back to the key; the key opens it again. Unmounting closes it, so the
 * city is never left held. The city is handed in, so it holds still while the terminal is open.
 */
function terminalSpecimen(host: HTMLElement, city?: OsCity): () => void {
  host.classList.add('is-terminal');
  // The city holds still while the terminal stands over it (Task 12).
  const term = createTerminal(document.body, () => term.close(), city);
  const open = (): void => term.open('Run 41 on harbor-ledger: the nightly export', runLog());
  const opener = osKey('Run log', 'look', open, { className: 'os-gallery-opener' });
  opener.dataset.terminalOpener = '';
  host.append(opener);
  opener.focus({ preventScroll: true });
  open();
  return () => {
    term.close();
    term.el.remove();
  };
}

const BUILT: Partial<Record<GalleryKind, (host: HTMLElement, city?: OsCity) => void | (() => void)>> = {
  type: typeSpecimen,
  panel: panelSpecimen,
  controls: controlsSpecimen,
  readouts: readoutsSpecimen,
  pins: pinsSpecimen,
  terminal: terminalSpecimen,
};

/** Shows one kind of the gallery over the city, and returns its unmount. The pins kind stands on `city`. */
export function mountGallery(parent: HTMLElement, kind: GalleryKind, city?: OsCity): () => void {
  const root = el('section', 'os-gallery');
  root.dataset.kind = kind;
  root.setAttribute('aria-label', `Gallery: ${kind}`);
  const build = BUILT[kind];
  // In the page before it is built, so a kind can read where the panel stands (the pins' pane edge).
  parent.append(root);
  const cleanup = build ? build(root, city) : root.append(el('p', 'os-gallery-label', `${kind}: not built yet`));
  return () => {
    cleanup?.();
    root.remove();
  };
}
