/**
 * What the job, run and inspection pages share (Task 37): the sheet with
 * its trail back to the board, section heads, markdown built from text
 * nodes, the small status shapes, and the firm and agent names.
 */
import type { CheckStatus, FirmView } from '../../../shared/types';
import { ApiError } from '../api';
import { placeHref } from '../router';
import { cleanText } from './board';
import { createSheet, el, type Sheet } from './controls';
import type { Block, Inline, Names } from './detail';

export interface DetailSheet extends Sheet {
  trail: HTMLElement;
  title: HTMLElement;
  /** The line under the title: what this is, in a sentence. */
  sub: HTMLElement;
  actions: HTMLElement;
}

/**
 * A detail page: the trail back to the board above the title, the title,
 * a line saying what this is, and a row for its actions. Wider than the
 * board's sheet, since it carries a transcript, a diff and screenshots.
 */
export function detailSheet(parent: HTMLElement, name: string, onDismiss: () => void): DetailSheet {
  const sheet = createSheet(parent, name, '', onDismiss);
  sheet.root.classList.add('detail');
  const head = sheet.root.querySelector<HTMLElement>('.sheet-head')!;
  const title = head.querySelector<HTMLElement>('.sheet-title')!;
  const trail = el('nav', 'detail-trail');
  trail.setAttribute('aria-label', 'Where this is');
  head.insertBefore(trail, title);
  const sub = el('p', 'detail-sub');
  const actions = el('div', 'detail-actions');
  head.append(sub, actions);
  return { ...sheet, trail, title, sub, actions, show: sheet.show, hide: sheet.hide, get shown() { return sheet.shown; } };
}

/** The trail: "Jobs / harbor-ledger #214 / Run", each step but the last a link. */
export function setTrail(trail: HTMLElement, steps: Array<[string, string | null]>): void {
  const key = JSON.stringify(steps);
  if (trail.dataset.key === key) return;
  trail.dataset.key = key;
  trail.replaceChildren();
  steps.forEach(([text, href], i) => {
    if (i > 0) trail.append(el('span', 'detail-trail-sep', '/'));
    if (href) {
      const a = el('a', 'detail-trail-link', text);
      a.href = href;
      trail.append(a);
    } else trail.append(el('span', 'detail-trail-here', text));
  });
}

/** A section's head, ruled as the board's are, with an aside on the right. */
export function secHead(title: string, aside?: string | HTMLElement): HTMLElement {
  const h = el('h2', 'repos-sec');
  h.append(el('span', 'repos-sec-name', title));
  if (aside !== undefined) {
    const a = typeof aside === 'string' ? el('span', 'repos-sec-count', aside) : aside;
    a.classList.add('repos-sec-count');
    h.append(a);
  }
  return h;
}

/** A link that leaves for GitHub. */
export function outLink(className: string, text: string, href: string): HTMLAnchorElement {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export function pageLink(className: string, text: string, route: Parameters<typeof placeHref>[0], id: string): HTMLAnchorElement {
  const a = el('a', className, text);
  a.href = placeHref(route, id);
  return a;
}

/** Inline markdown as nodes: text, emphasis, code, and links that go to GitHub only. */
export function inlineNodes(spans: Inline[]): Node[] {
  return spans.map((s) => {
    switch (s.kind) {
      case 'em':
        return el('em', '', s.text);
      case 'strong':
        return el('strong', '', s.text);
      case 'code':
        return el('code', 'md-code', s.text);
      case 'link':
        return s.href ? outLink('md-link', s.text, s.href) : document.createTextNode(s.text);
      default:
        return document.createTextNode(s.text);
    }
  });
}

/** Markdown blocks as nodes, every piece set as text. */
export function blockNodes(blocks: Block[]): HTMLElement[] {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'heading': {
        const h = el('h3', `md-h md-h${Math.min(b.level, 4)}`);
        h.append(...inlineNodes(b.inline));
        return h;
      }
      case 'list': {
        const l = el(b.ordered ? 'ol' : 'ul', 'md-list');
        for (const item of b.items) {
          const li = el('li');
          li.append(...inlineNodes(item));
          l.append(li);
        }
        return l;
      }
      case 'code':
        return el('pre', 'md-pre', b.text);
      case 'quote': {
        const q = el('blockquote', 'md-quote');
        q.append(...inlineNodes(b.inline));
        return q;
      }
      default: {
        const p = el('p', 'md-p');
        p.append(...inlineNodes(b.inline));
        return p;
      }
    }
  });
}

const STATUS_WORD: Record<CheckStatus, string> = { pass: 'pass', fail: 'fail', skipped: 'skipped', preexisting: 'failing before too' };

/** A status as a word beside a small drawn shape: a filled square, a struck square, an empty one, a half-filled one. */
export function statusMark(status: CheckStatus): HTMLElement {
  const s = el('span', `status status-${status}`);
  const shape = el('i', 'status-shape');
  shape.setAttribute('aria-hidden', 'true');
  s.append(shape, el('span', 'status-word', STATUS_WORD[status] ?? status));
  return s;
}

/** Names from the firms as last read; an id stands in for one not (yet) known. */
export function namesOf(firms: FirmView[]): Names {
  const agents = new Map<string, string>();
  const firmNames = new Map<string, string>();
  for (const f of firms) {
    firmNames.set(f.id, cleanText(f.name, 80));
    for (const a of f.agents) agents.set(a.id, cleanText(a.name, 80));
  }
  return { agent: (id) => agents.get(id) ?? cleanText(id, 80), firm: (id) => firmNames.get(id) ?? cleanText(id, 80) };
}

/** "Kill refused: the run is not live." in the board's words. */
export function refusal(what: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError && err.status >= 500) return `${what} failed: ${msg}`;
  return `${what} refused: ${msg.charAt(0).toLowerCase()}${msg.slice(1)}`;
}

/**
 * Keeps one element per key and rebuilds it only when its content key
 * changes, so live updates touch only what moved and focus and scroll
 * stay where they were.
 */
export function keyedSlot(parent: HTMLElement): (key: string, build: () => HTMLElement | null) => void {
  let cur: { key: string; el: HTMLElement | null } | null = null;
  const anchor = document.createComment('slot');
  parent.append(anchor);
  return (key, build) => {
    if (cur && cur.key === key) return;
    const next = build();
    const hadFocus = cur?.el?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focusClass = hadFocus?.className ?? '';
    if (cur?.el) cur.el.remove();
    if (next) anchor.before(next);
    cur = { key, el: next };
    if (hadFocus && next && focusClass) next.querySelector<HTMLElement>(`.${focusClass.split(' ').filter(Boolean).join('.')}`)?.focus({ preventScroll: true });
  };
}

/** A shortcut that coalesces calls: one in flight, and one more after it if anything asked meanwhile. */
export function coalesce(fn: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const go = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await fn().catch(() => {});
      } while (again);
    } finally {
      running = false;
    }
  };
  return () => void go();
}
