import { BANKRUPT_HOURS } from '../../../shared/market-rules';
import type { Firm, FirmView, Quarter, Reputation, Silhouette } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { cleanText, money, pct } from './board';
import { button, createSheet, el, plural } from './controls';
import { coalesce, namesOf } from './pages';
import { bankruptIn, figure, floorsBuilt, shortDate, soldTowers } from './story';
import './market.css';

export interface FirmsScreen {
  show(): void;
  hide(): void;
}

// ---------------------------------------------------------------- drawings shared by the firm and agent pages

const SVG = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, className?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (className) e.setAttribute('class', className);
  return e;
}

export { svgEl };

/**
 * A small engraved scale, as on a draughtsman's rule: a hairline with ticks
 * at the quarters, the value laid along it in bronze and a pointer above
 * it. With no record the rule is dotted and carries no pointer.
 */
export function gauge(value: number | null, label: string, opts: { width?: number } = {}): SVGSVGElement {
  const w = opts.width ?? 72;
  const svg = svgEl('svg', { width: w + 2, height: 14, viewBox: `-1 0 ${w + 2} 14`, role: 'img', 'aria-label': `${label}: ${value === null ? 'no record yet' : pct(value)}` }, 'gauge');
  const y = 10.5;
  svg.append(svgEl('line', { x1: 0, y1: y, x2: w, y2: y }, value === null ? 'gauge-rule none' : 'gauge-rule'));
  for (let i = 0; i <= 4; i++) {
    const x = Math.round((w * i) / 4) + 0.5 - (i === 4 ? 1 : 0);
    svg.append(svgEl('line', { x1: x, y1: y, x2: x, y2: y + (i % 2 === 0 ? 3.5 : 2) }, 'gauge-tick'));
  }
  if (value !== null && Number.isFinite(value)) {
    const v = Math.max(0, Math.min(1, value));
    const x = Math.max(0.75, Math.round(v * w * 2) / 2);
    svg.append(svgEl('line', { x1: 0, y1: y, x2: x, y2: y }, 'gauge-fill'));
    svg.append(svgEl('path', { d: `M${x - 3} 3.5H${x + 3}L${x} 9.5Z` }, 'gauge-pointer'));
  }
  return svg;
}

/** The three reputation measures a firm is read by, as the gauges show them. */
export function measures(r: Reputation): Array<{ key: string; label: string; value: number | null; said: string }> {
  return [
    { key: 'pass', label: 'Pass rate', value: r.passRateAll, said: pct(r.passRateAll) },
    { key: 'cal', label: 'Calibration', value: r.brier === null ? null : 1 - r.brier, said: r.brier === null ? 'no record' : pct(1 - r.brier) },
    { key: 'dur', label: 'Durability', value: r.durability, said: pct(r.durability) },
  ];
}

/**
 * The top of an agent's tower as the city builds it, drawn small: a lens
 * twists and swells, a cantilever steps out every few floors, a needle
 * narrows to a spire, a plain tower rises straight.
 */
export function silhouetteGlyph(s: Silhouette, opts: { dark?: boolean } = {}): SVGSVGElement {
  const svg = svgEl('svg', { width: 26, height: 48, viewBox: '0 0 26 48', 'aria-hidden': 'true' }, `silhouette s-${s}${opts.dark ? ' dark' : ''}`);
  const floors = (x0: number, x1: number, from: number, to: number, step = 4): void => {
    for (let y = from; y > to; y -= step) svg.append(svgEl('line', { x1: x0, y1: y + 0.5, x2: x1, y2: y + 0.5 }, 'sil-floor'));
  };
  svg.append(svgEl('line', { x1: 1, y1: 46.5, x2: 25, y2: 46.5 }, 'sil-ground'));
  switch (s) {
    case 'lens':
      svg.append(svgEl('path', { d: 'M8.5 46.5V30C8.5 22 5.5 18 7 11L13 5.5L19 11C20.5 18 17.5 22 17.5 30V46.5Z' }, 'sil-body'));
      floors(9, 17, 42, 30);
      svg.append(svgEl('path', { d: 'M7.5 24C10 22.5 16 22.5 18.5 24M6.6 17C10 15 16 15 19.4 17M7.6 11.5C10 10 16 10 18.4 11.5' }, 'sil-ring'));
      break;
    case 'cantilever':
      svg.append(svgEl('path', { d: 'M7.5 46.5V34.5H9.5V26.5H5.5V18.5H11.5V10.5H8.5V6.5H17.5V18.5H19.5V34.5H17.5V46.5Z' }, 'sil-body'));
      floors(8, 17, 42, 35);
      floors(6, 19, 30, 19, 4);
      svg.append(svgEl('path', { d: 'M5.5 26.5L9.5 30.5M19.5 34.5L17.5 37' }, 'sil-ring'));
      break;
    case 'needle':
      svg.append(svgEl('path', { d: 'M8.5 46.5L10 22L11.5 10H12.5V2.5H13.5V10H14.5L16 22L17.5 46.5Z' }, 'sil-body'));
      floors(9, 17, 42, 22);
      break;
    default:
      svg.append(svgEl('path', { d: 'M7.5 46.5V9.5H18.5V46.5Z' }, 'sil-body'));
      floors(8, 18, 42, 10);
      svg.append(svgEl('path', { d: 'M11 9.5V6.5H15V9.5' }, 'sil-ring'));
  }
  return svg;
}

/** A firm's balance as the ledger shows it: the number, set in rust below zero, and what being below zero means. */
export function balanceCell(f: Firm, now = Date.now(), opts: { always?: boolean } = {}): HTMLElement {
  const neg = f.balance < 0;
  const cell = el('div', `firm-bal${neg ? ' neg' : ''}${f.status === 'bankrupt' ? ' gone' : ''}`);
  cell.append(el('span', 'firm-bal-num', figure(f.balance)));
  let note = opts.always ? 'credits' : '';
  if (f.status === 'bankrupt') note = f.bankruptAt ? `bankrupt ${shortDate(f.bankruptAt)}` : 'bankrupt';
  else if (neg) {
    const h = bankruptIn(f.negativeSince, now);
    note = h === null ? 'below zero' : h === 0 ? 'bankrupt within the hour' : `bankrupt in ${h} h`;
  }
  if (note) cell.append(el('span', 'firm-bal-note', note));
  if (neg && f.status !== 'bankrupt') cell.title = `Below zero since ${f.negativeSince ? new Date(f.negativeSince).toLocaleString('en-GB') : 'now'}. A firm below zero for ${BANKRUPT_HOURS} hours in a row is bankrupt: its towers go dark and are sold.`;
  return cell;
}

/** A thousands comma for the head's sums. */
export function grouped(n: number): string {
  const [i, d] = money(Math.abs(n)).split('.');
  return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`;
}

// ---------------------------------------------------------------- the list

/**
 * Every firm of the market as a ledger row (#/firms): its name and motto,
 * its balance (set in rust below zero, with the hours it has left), its
 * reputation as three small engraved scales, its people and the floors it
 * has built. A bankrupt firm carries a dark marker and says who bought its
 * towers. Updates from the event stream.
 */
export function createFirms(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): FirmsScreen {
  const sheet = createSheet(parent, 'firms', 'Firms', opts.onDismiss);
  const head = sheet.root.querySelector('.sheet-head')!;
  const facts = el('p', 'sheet-facts');
  head.append(facts);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  const ledger = el('div', 'firm-ledger');
  ledger.setAttribute('role', 'table');
  ledger.setAttribute('aria-label', 'The firms');
  const key = el(
    'p',
    'jobs-key firms-key',
    `Pass rate is the share of a firm’s awarded jobs whose work merged. Calibration is how well its stated confidence matched what happened (one less its Brier score). Durability is the share of its merges never reverted. A firm below zero for ${BANKRUPT_HOURS} hours in a row is bankrupt: its towers go dark, and the richest firm that can afford them buys them.`,
  );
  sheet.body.append(trouble, ledger, key);

  let firms: FirmView[] = [];
  let quarters: Quarter[] = [];
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = coalesce(async () => {
    try {
      [firms, quarters] = await Promise.all([api.firms(), api.quarters().catch(() => quarters)]);
      trouble.hidden = true;
    } catch (err) {
      trouble.textContent = `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected') return read();
    if (/^(credits\.moved|firm\.|agent\.|tower\.|floor\.|job\.awarded|merge\.|run\.ended|inspection\.done)/.test(e.type)) read();
  }

  function headRow(): HTMLElement {
    const r = el('div', 'firm-head');
    r.setAttribute('role', 'row');
    for (const [cls, text] of [
      ['c-name', 'Firm'],
      ['c-g', 'Pass rate'],
      ['c-g', 'Calibration'],
      ['c-g', 'Durability'],
      ['c-n', 'Agents'],
      ['c-n', 'Floors'],
      ['c-bal', 'Balance, credits'],
    ]) {
      const c = el('span', `firm-th ${cls}`, text);
      c.setAttribute('role', 'columnheader');
      r.append(c);
    }
    return r;
  }

  function row(f: FirmView, names: ReturnType<typeof namesOf>, now: number): HTMLElement {
    const gone = f.status === 'bankrupt';
    const r = el('div', `firm-row${gone ? ' bankrupt' : ''}${f.balance < 0 ? ' below' : ''}`);
    r.setAttribute('role', 'row');
    r.dataset.firm = f.id;

    const name = el('div', 'firm-cell c-name');
    name.setAttribute('role', 'cell');
    const line = el('div', 'firm-name-line');
    if (gone) {
      // The dark marker: its quarter's towers as they stood the night it failed, every window out.
      const dark = el('span', 'firm-dark');
      dark.title = 'Bankrupt: its towers went dark';
      dark.append(silhouetteGlyph('plain', { dark: true }));
      line.append(dark);
    }
    const a = el('a', 'firm-name', cleanText(f.name, 80));
    a.href = placeHref('firm', f.id);
    line.append(a);
    name.append(line, el('p', 'firm-motto', cleanText(f.motto, 160)));
    const sold = soldTowers(quarters, f.id);
    if (gone) {
      const t = el('p', 'firm-towers');
      const dark = (quarters.find((q) => q.firmId === f.id)?.towers.length ?? 0) - sold.length;
      const parts = sold.map((s) => `${names.agent(s.agentId)}’s tower bought by ${names.firm(s.buyer)}`);
      if (dark > 0) parts.push(`${plural(dark, 'tower')} dark, for sale`);
      t.textContent = parts.length ? `${parts.join('; ')}.` : 'No towers stood.';
      name.append(t);
    }
    r.append(name);

    for (const m of measures(f.reputation)) {
      const c = el('div', `firm-cell c-g g-${m.key}`);
      c.setAttribute('role', 'cell');
      c.append(el('span', 'firm-g-num', m.said), gauge(m.value, m.label));
      r.append(c);
    }
    const working = f.agents.filter((x) => !x.retired).length;
    const people = el('div', 'firm-cell c-n', String(gone ? f.agents.length : working));
    people.setAttribute('role', 'cell');
    people.title = gone ? `${plural(f.agents.length, 'agent')}, all retired` : `${plural(working, 'working agent')}${f.agents.length > working ? `, ${f.agents.length - working} retired` : ''}`;
    const built = el('div', 'firm-cell c-n', String(floorsBuilt(quarters, f.id)));
    built.setAttribute('role', 'cell');
    built.title = 'Floors its agents built: merged work, and work waiting on your review';
    const bal = balanceCell(f, now);
    bal.classList.add('firm-cell', 'c-bal');
    bal.setAttribute('role', 'cell');
    r.append(people, built, bal);
    return r;
  }

  let lastKey = '';
  function render(): void {
    if (!sheet.shown) return;
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    const k = JSON.stringify([firms, quarters.map((q) => q.towers.map((t) => [t.firmId, t.floors.length])), hour]);
    if (k === lastKey) return;
    lastKey = k;
    const names = namesOf(firms);
    const active = firms.filter((f) => f.status === 'active');
    const gone = firms.length - active.length;
    const held = active.reduce((s, f) => s + f.balance, 0);
    facts.textContent = firms.length ? `${plural(firms.length, 'firm')}: ${active.length} trading${gone ? `, ${gone} bankrupt` : ''}. ${grouped(Math.round(held * 100) / 100)} credits on the trading firms’ books.` : '';
    ledger.replaceChildren(headRow(), ...firms.map((f) => row(f, names, now)));
  }

  return {
    show() {
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // "bankrupt in 31 h" counts down by itself.
        timer = setInterval(render, 60_000);
      }
      lastKey = '';
      render();
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
