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

/** The type specimen: the date, a headline, two rows of figures, every colour, and the focus ring. */
function typeSpecimen(host: HTMLElement): void {
  host.append(el('p', 'os-gallery-label', 'Type and colour'));

  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  host.append(el('h1', 'os-gallery-date', date));
  host.append(el('p', 'os-gallery-head', 'Eleven merged overnight. Six wait on you, and one asks for the city.'));

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
}

const BUILT: Partial<Record<GalleryKind, (host: HTMLElement) => void>> = { type: typeSpecimen };

/** Shows one kind of the gallery over the city, and returns its unmount. */
export function mountGallery(parent: HTMLElement, kind: GalleryKind): () => void {
  const root = el('section', 'os-gallery');
  root.dataset.kind = kind;
  root.setAttribute('aria-label', `Gallery: ${kind}`);
  const build = BUILT[kind];
  if (build) build(root);
  else root.append(el('p', 'os-gallery-label', `${kind}: not built yet`));
  parent.append(root);
  return () => root.remove();
}
