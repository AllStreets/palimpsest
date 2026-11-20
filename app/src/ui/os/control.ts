/**
 * The shaped control: every key on the screens in one of four weights, by
 * consequence, lightest to heaviest.
 *
 * - look: a cold ice word. Its reticle shows only when it is aimed at.
 * - decide: a plain word in amber corner ticks.
 * - spend: a lit amber key in a heavier reticle, its sum in its own window.
 *   Posting, retry, resume, audit, today's limit, and a tier change.
 * - grant: the one hot red key, a breathing reticle and a turning seal.
 *
 * The reticle is four child ticks, so each corner moves on its own diagonal
 * by transform alone; the key's own ::after stays free for the .os-focus ring.
 * The sum is set as text. No CSS import, so this runs in node.
 */

export const WEIGHTS = ['look', 'decide', 'spend', 'grant'] as const;
export type Weight = (typeof WEIGHTS)[number];

const SVG = 'http://www.w3.org/2000/svg';

/** The classes of the parts a key is dressed with, so weighing again can take them off. */
const PARTS = ['os-key-ret', 'os-seal', 'os-sum'];

const span = (cls: string, text?: string): HTMLSpanElement => {
  const n = document.createElement('span');
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const svg = (tag: string, attrs: Record<string, string>): SVGElement => {
  const n = document.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Four corner ticks, unseen by the reader. Each tick knows its corner, so it can move on its diagonal. */
function reticle(): HTMLSpanElement {
  const ret = span('os-key-ret');
  ret.setAttribute('aria-hidden', 'true');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const t = span('os-key-tick');
    t.dataset.corner = corner;
    ret.append(t);
  }
  return ret;
}

/** The grant's seal: a ring, a dashed ring that turns, four cross ticks and a centre. */
function seal(): SVGElement {
  const s = svg('svg', { viewBox: '0 0 40 40', class: 'os-seal', 'aria-hidden': 'true', focusable: 'false' });
  s.append(
    svg('circle', { class: 'os-seal-ring', cx: '20', cy: '20', r: '13' }),
    svg('circle', { class: 'os-seal-spin', cx: '20', cy: '20', r: '18' }),
    svg('path', { class: 'os-seal-cross', d: 'M20 2v7M20 31v7M2 20h7M31 20h7' }),
    svg('circle', { class: 'os-seal-dot', cx: '20', cy: '20', r: '3' }),
  );
  return s;
}

/**
 * Dresses an existing button or link as a key of `weight`, in place: its
 * listeners, its words and its own classes stay. `sum` is set as text in an
 * `.os-sum` window at the key's end. Weighing a key again replaces the
 * dressing. Returns the same node.
 */
export function weighKey(node: HTMLElement, weight: Weight, sum?: string): HTMLElement {
  for (const c of [...node.children]) if (PARTS.some((p) => c.classList.contains(p))) c.remove();
  node.classList.add('os-key', 'os-focus');
  node.dataset.weight = weight;
  if (weight === 'grant') node.prepend(seal());
  node.prepend(reticle());
  if (sum) node.append(span('os-sum os-figs', sum));
  return node;
}

/** A new `type="button"` key of `weight`, its label as text, and `sum` in its own window. */
export function osKey(label: string, weight: Weight, onClick: () => void, opts: { sum?: string; className?: string } = {}): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (opts.className) b.className = opts.className;
  b.append(span('os-key-label', label));
  b.addEventListener('click', onClick);
  weighKey(b, weight, opts.sum);
  return b;
}
