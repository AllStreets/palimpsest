/**
 * A run's summary as its agent wrote it, in markdown, set as the Brief sets
 * prose: paragraphs and bullet lists, with bold, italics and inline code.
 * Nothing else is markup: a heading reads as a bold line, a link keeps its
 * words, and any HTML in it (a tag, an attribute) stays the literal text it
 * is. The nodes are built with createElement and text nodes only, never
 * innerHTML, so the summary, which is model output, can run nothing.
 */
import { inline } from './detail.js';

export type SummarySpan = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };
export type SummaryBlock = { kind: 'para'; spans: SummarySpan[] } | { kind: 'list'; items: SummarySpan[][] };

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** A summary is read whole before it is cut, but never more than this. */
const SOURCE_MAX = 8_000;

function spansOf(src: string): SummarySpan[] {
  const out: SummarySpan[] = [];
  for (const s of spansOfRaw(src)) {
    const last = out.at(-1);
    if (s.kind === 'text' && last?.kind === 'text') last.text += s.text;
    else out.push(s);
  }
  return out;
}

function spansOfRaw(src: string): SummarySpan[] {
  return inline(src).map((s): SummarySpan => {
    if (s.kind === 'link') return { kind: 'text', text: s.text };
    if (s.kind === 'strong' || s.kind === 'em') {
      // Bold around code ("**`tools/commute-check.ts`**") reads as the code; code inside bold words keeps only its words.
      const whole = /^`([^`]+)`$/.exec(s.text);
      if (whole) return { kind: 'code', text: whole[1] };
      return { kind: s.kind, text: s.text.replace(/`([^`]+)`/g, '$1') };
    }
    return { kind: s.kind, text: s.text };
  });
}

/** Cuts the blocks to about `max` characters of visible text, ending the last kept piece with an ellipsis. */
function cut(blocks: SummaryBlock[], max: number): SummaryBlock[] {
  let left = max;
  const out: SummaryBlock[] = [];
  const take = (spans: SummarySpan[]): SummarySpan[] | null => {
    const kept: SummarySpan[] = [];
    for (const s of spans) {
      if (left <= 0) break;
      if (s.text.length <= left) {
        kept.push(s);
        left -= s.text.length;
      } else {
        kept.push({ kind: s.kind, text: `${s.text.slice(0, Math.max(1, left - 1)).trimEnd()}…` });
        left = 0;
      }
    }
    return kept.length ? kept : null;
  };
  for (const b of blocks) {
    if (left <= 0) break;
    if (b.kind === 'para') {
      const spans = take(b.spans);
      if (spans) out.push({ kind: 'para', spans });
    } else {
      const items: SummarySpan[][] = [];
      for (const item of b.items) {
        if (left <= 0) break;
        const spans = take(item);
        if (spans) items.push(spans);
      }
      if (items.length) out.push({ kind: 'list', items });
    }
  }
  return out;
}

/** The summary as paragraphs and lists of spans, at most about `max` characters of text. */
export function summaryBlocks(summary: unknown, max = 600): SummaryBlock[] {
  if (typeof summary !== 'string' || !summary.trim()) return [];
  const lines = summary.slice(0, SOURCE_MAX).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: SummaryBlock[] = [];
  let i = 0;
  const blank = (l: string) => !l.trim() || FENCE.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const spans = spansOf(h[1]).map((s) => (s.kind === 'text' ? { ...s, kind: 'strong' as const } : s));
      if (spans.length) blocks.push({ kind: 'para', spans });
      i++;
      continue;
    }
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && !blank(lines[i]) && !HEADING.test(lines[i])) {
        if (BULLET.test(lines[i])) items.push(lines[i].replace(BULLET, ''));
        else items[items.length - 1] += ` ${lines[i]}`;
        i++;
      }
      const kept = items.map(spansOf).filter((x) => x.length);
      if (kept.length) blocks.push({ kind: 'list', items: kept });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !BULLET.test(lines[i]) && !HEADING.test(lines[i])) para.push(lines[i++]);
    const spans = spansOf(para.join(' '));
    if (spans.length) blocks.push({ kind: 'para', spans });
  }
  return cut(blocks, max);
}

/** What the builder needs of a document: elements and text nodes, nothing that parses. */
export interface NodeMaker {
  createElement(tag: string): HTMLElement;
  createTextNode(text: string): Text;
}

function spanNode(doc: NodeMaker, s: SummarySpan): Node {
  if (s.kind === 'text') return doc.createTextNode(s.text);
  const e = doc.createElement(s.kind);
  if (s.kind === 'code') e.className = 'md-code';
  e.textContent = s.text;
  return e;
}

/** The blocks as nodes: p and ul elements holding strong, em, code and text nodes, every piece set as text. */
export function summaryNodes(blocks: SummaryBlock[], doc: NodeMaker = document): HTMLElement[] {
  return blocks.map((b) => {
    if (b.kind === 'para') {
      const p = doc.createElement('p');
      p.append(...b.spans.map((s) => spanNode(doc, s)));
      return p;
    }
    const ul = doc.createElement('ul');
    ul.className = 'md-list';
    for (const item of b.items) {
      const li = doc.createElement('li');
      li.append(...item.map((s) => spanNode(doc, s)));
      ul.append(li);
    }
    return ul;
  });
}
