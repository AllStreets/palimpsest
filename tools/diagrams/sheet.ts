/**
 * The drawing surface the four diagrams share: an SVG sheet that records
 * every word it sets, so the tests read the same labels the reader sees.
 * Type and colour live in the page's stylesheet (PAGE_CSS), in the app's
 * Newsreader and IBM Plex Sans, on its paper and ink in both themes.
 */

export type LabelKind = 'title' | 'head' | 'node' | 'small' | 'note' | 'figure' | 'code' | 'source';

export interface Label {
  text: string;
  kind: LabelKind;
  /** What the label stands for in the code, e.g. `job:awarded` or `move:running>open`. */
  keys: string[];
}

export type DiagramName = 'machine' | 'floor' | 'sandbox' | 'school';

export interface Diagram {
  name: DiagramName;
  title: string;
  /** The alt text Task 27 places with the image. */
  alt: string;
  width: number;
  height: number;
  labels: Label[];
  svg: string;
}

const CLASS: Record<LabelKind, string> = {
  title: 't-title',
  head: 't-head',
  node: 't-node',
  small: 't-small',
  note: 't-note',
  figure: 't-figure',
  code: 't-code',
  source: 't-source',
};

/** Rough advance widths, in ems, for wrapping; the diagrams leave room either side. */
const EM: Record<LabelKind, number> = { title: 0.46, head: 0.43, node: 0.45, small: 0.45, note: 0.53, figure: 0.53, code: 0.53, source: 0.53 };
const SIZE: Record<LabelKind, number> = { title: 40, head: 19, node: 21, small: 18, note: 14, figure: 13, code: 13, source: 13 };

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface TextOpts {
  kind?: LabelKind;
  anchor?: 'start' | 'middle' | 'end';
  keys?: string[];
  /** Wrap at about this many pixels. */
  wrap?: number;
  lineHeight?: number;
  cls?: string;
  /** `bottom` sets the last line on y, so a wrapped note grows upward. */
  valign?: 'top' | 'bottom';
}

export class Sheet {
  readonly parts: string[] = [];
  readonly labels: Label[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  /** Sets a label; returns the number of lines it took. */
  text(x: number, y: number, text: string, o: TextOpts = {}): number {
    const kind = o.kind ?? 'node';
    this.labels.push({ text, kind, keys: o.keys ?? [] });
    const lines = o.wrap ? wrapText(text, Math.max(4, Math.floor(o.wrap / (EM[kind] * SIZE[kind])))) : [text];
    const lh = o.lineHeight ?? Math.round(SIZE[kind] * 1.35);
    if (o.valign === 'bottom') y -= lh * (lines.length - 1);
    const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
    const keys = o.keys?.length ? ` data-keys="${esc(o.keys.join(' '))}"` : '';
    const cls = [CLASS[kind], o.cls].filter(Boolean).join(' ');
    const body = lines.length === 1 ? esc(lines[0]) : lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(l)}</tspan>`).join('');
    this.parts.push(`<text x="${x}" y="${y}" class="${cls}"${anchor}${keys}>${body}</text>`);
    return lines.length;
  }

  /**
   * A ruled entry: a name set on a hairline of width `w`, its note under the
   * rule. Lines join an entry at either end of its rule. Returns the rule's y
   * and the y below the note.
   */
  entry(x: number, y: number, w: number, name: string, o: { note?: string; keys?: string[]; nameKind?: LabelKind; rule?: string; noteWrap?: number } = {}): { rule: number; bottom: number } {
    this.text(x, y, name, { kind: o.nameKind ?? 'node', keys: o.keys });
    const rule = y + 11;
    this.line(x, rule, x + w, rule, o.rule ?? 'l-strong');
    let bottom = rule;
    if (o.note) {
      const n = this.text(x, rule + 21, o.note, { kind: 'note', wrap: o.noteWrap ?? w, lineHeight: 19 });
      bottom = rule + 21 + 19 * (n - 1);
    }
    return { rule, bottom };
  }

  line(x1: number, y1: number, x2: number, y2: number, cls = 'l-rule'): void {
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`);
  }

  path(d: string, cls = 'l-rule'): void {
    this.parts.push(`<path d="${d}" class="${cls}"/>`);
  }

  dot(cx: number, cy: number, r = 4, cls = 'f-ink', keys: string[] = []): void {
    const k = keys.length ? ` data-keys="${esc(keys.join(' '))}"` : '';
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"${k}/>`);
  }

  /** An open ring: a state the line passes without stopping at. */
  ring(cx: number, cy: number, r = 4.5, cls = 'ring'): void {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"/>`);
  }

  rect(x: number, y: number, w: number, h: number, cls: string): void {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}"/>`);
  }

  /** A small open arrowhead at (x, y) pointing along `angle` degrees (0 is right, 90 is down). */
  arrow(x: number, y: number, angle: number, cls = 'l-ink', size = 6): void {
    const a = (angle * Math.PI) / 180;
    const back = (da: number) => [x - size * Math.cos(a + da), y - size * Math.sin(a + da)].map((n) => n.toFixed(1)).join(',');
    this.parts.push(`<path d="M${back(0.45)} L${x},${y} L${back(-0.45)}" class="${cls} cap"/>`);
  }

  raw(svg: string): void {
    this.parts.push(svg);
  }

  svg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}">${this.parts.join('')}</svg>`;
  }
}

/** Greedy word wrap at `max` characters. */
export function wrapText(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** The page every diagram is set in: the app's fonts, its paper and ink, light or dark by the reader's scheme. */
export const PAGE_CSS = `
@font-face { font-family: 'Newsreader'; src: url('/fonts/newsreader.woff2') format('woff2'); font-style: normal; font-weight: 400 500; }
@font-face { font-family: 'Newsreader'; src: url('/fonts/newsreader-italic.woff2') format('woff2'); font-style: italic; font-weight: 400; }
@font-face { font-family: 'IBM Plex Sans'; src: url('/fonts/plex-sans.woff2') format('woff2'); font-style: normal; font-weight: 400 500; }
:root {
  --paper: #f4efe6;
  --ink: #1f1c18;
  --ink-2: #57514a;
  --ink-3: #8a8277;
  --rule: rgba(31, 28, 24, 0.16);
  --rule-strong: rgba(31, 28, 24, 0.42);
  --accent: #8c5a2b;
  --accent-soft: rgba(140, 90, 43, 0.16);
  --stop: #9a3c22;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0f1014;
    --ink: #ece6da;
    --ink-2: #b9b1a4;
    --ink-3: #847e74;
    --rule: rgba(236, 230, 218, 0.15);
    --rule-strong: rgba(236, 230, 218, 0.4);
    --accent: #c8975f;
    --accent-soft: rgba(200, 151, 95, 0.2);
    --stop: #d9774f;
  }
}
html, body { margin: 0; padding: 0; background: var(--paper); }
svg { display: block; shape-rendering: geometricPrecision; text-rendering: geometricPrecision; }
text { fill: var(--ink); font-kerning: normal; }
.t-title { font: 400 40px 'Newsreader', Georgia, serif; letter-spacing: -0.005em; }
.t-head { font: italic 400 19px 'Newsreader', Georgia, serif; fill: var(--ink-2); }
.t-node { font: 400 21px 'Newsreader', Georgia, serif; }
.t-small { font: 400 18px 'Newsreader', Georgia, serif; }
.t-note { font: 400 14px 'IBM Plex Sans', system-ui, sans-serif; fill: var(--ink-2); }
.t-figure { font: 400 13px 'IBM Plex Sans', system-ui, sans-serif; fill: var(--ink-3); font-variant-numeric: tabular-nums; }
.t-code { font: 400 13.5px 'IBM Plex Sans', system-ui, sans-serif; fill: var(--ink-2); }
.t-source { font: 400 13px 'IBM Plex Sans', system-ui, sans-serif; fill: var(--ink-3); }
.t-accent { fill: var(--accent); }
.halo { paint-order: stroke fill; stroke: var(--paper); stroke-width: 8px; stroke-linejoin: round; }
.t-stop { fill: var(--stop); }
.t-dim { fill: var(--ink-3); }
line, path { fill: none; }
.l-rule { stroke: var(--rule); stroke-width: 1; }
.l-strong { stroke: var(--rule-strong); stroke-width: 1; }
.l-ink { stroke: var(--ink); stroke-width: 1.25; }
.l-accent { stroke: var(--accent); stroke-width: 1.6; }
.l-stop { stroke: var(--stop); stroke-width: 1.25; }
.l-dash { stroke-dasharray: 2 4; }
.cap { stroke-linecap: round; stroke-linejoin: round; }
.f-ink { fill: var(--ink); }
.f-accent { fill: var(--accent); }
.f-soft { fill: var(--accent-soft); }
.f-paper { fill: var(--paper); }
.f-rule { fill: var(--rule); }
.f-stop { fill: var(--stop); }
.ring { fill: var(--paper); stroke: var(--ink); stroke-width: 1.25; }
.ring-accent { fill: var(--paper); stroke: var(--accent); stroke-width: 1.6; }
.l-lit { stroke: var(--paper); stroke-width: 1; opacity: 0.6; }
.slab { fill: none; stroke: var(--ink-2); stroke-width: 1; }
`;

/** The whole page for one diagram. */
export function page(d: Diagram): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>${PAGE_CSS}</style></head><body>${d.svg}</body></html>`;
}
