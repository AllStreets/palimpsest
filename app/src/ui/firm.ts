import { HIRE_FEE } from '../../../shared/market-rules';
import type { FirmDetail, FirmRound, FirmView, Quarter, ReputationPoint } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { cleanText, money, pct } from './board';
import { button, checkRadio, el, plural, rovingRadios, textButton } from './controls';
import { clock, dayHeading } from './detail';
import { balanceCell, gauge, grouped, measures, silhouetteGlyph, svgEl } from './firms';
import { ERA_NAMES, ROOT_NAMES } from './inspector';
import { coalesce, detailSheet, keyedSlot, pageLink, secHead, setTrail } from './pages';
import { bankruptIn, bookLines, figure, longDate, roundWords, shortDate, stepPath, type StoryNames } from './story';
import './market.css';

export interface FirmPage {
  show(id: string): void;
  hide(): void;
}

export interface FirmPageOptions {
  listen(fn: (e: EngineEvent) => void): () => void;
  onDismiss(): void;
  /** Whether the firm's quarter stands in the city now. */
  quarterStands(firmId: string): boolean;
  /** Closes the page and flies the city to the firm's quarter. */
  flyToQuarter(firmId: string): void;
}

const SHAPE_WORDS: Record<string, string> = { single: 'single pass', 'plan-then-answer': 'plans, then answers', 'self-check': 'checks its own work', vote: 'votes on its plans' };
/** The era bands the reputation line is ruled with: the score each era begins at. */
const ERA_LINES: Array<[number, string]> = [
  [0.8, 'Sci-fi'],
  [0.65, 'Titanium'],
  [0.5, 'Glass'],
  [0.35, 'Brick'],
];
const ROUNDS_SHOWN = 14;
const BOOK_DAYS_SHOWN = 3;

type RoundFilter = 'all' | 'won' | 'lost' | 'none';

/** A signed amount for the books: a true minus, and a plus on money coming in. */
function signed(n: number): string {
  return n < 0 ? `−${(-n).toFixed(2)}` : `+${n.toFixed(2)}`;
}

/**
 * A firm's own page (#/firms/:id), told as its story: where its quarter
 * stands (fly to it), its standing (balance and reputation, with the
 * reputation drawn over time), its people with their models, temperaments
 * and the silhouettes of their towers, every round it bid in (won, or lost
 * with the expected value that lost it), its books as a running balance,
 * and its hires and the towers it bought or lost. Updates from the event stream.
 */
export function createFirmPage(parent: HTMLElement, opts: FirmPageOptions): FirmPage {
  const sheet = detailSheet(parent, 'firmpage', opts.onDismiss);
  const body = sheet.body;
  const motto = el('p', 'firm-motto-big');
  sheet.title.after(motto);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  body.append(trouble);
  const slots = {
    head: keyedSlot(sheet.actions),
    standing: keyedSlot(body),
    people: keyedSlot(body),
    rounds: keyedSlot(body),
    books: keyedSlot(body),
    deals: keyedSlot(body),
  };

  let id: string | null = null;
  let detail: FirmDetail | null = null;
  let firms: FirmView[] = [];
  let quarters: Quarter[] = [];
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let filter: RoundFilter = 'all';
  let allRounds = false;
  let allBooks = false;

  const names = (): StoryNames => {
    const agents = new Map(firms.flatMap((f) => f.agents.map((a) => [a.id, cleanText(a.name, 80)] as const)));
    const fs = new Map(firms.map((f) => [f.id, cleanText(f.name, 80)] as const));
    const jobs = new Map<string, string>();
    for (const r of detail?.rounds ?? []) jobs.set(r.jobId, cleanText(r.title, 120));
    for (const j of detail?.jobs ?? []) jobs.set(j.id, cleanText(j.title, 120));
    return { agent: (x) => agents.get(x) ?? cleanText(x, 80), firm: (x) => fs.get(x) ?? cleanText(x, 80), job: (x) => jobs.get(x) ?? null };
  };

  const read = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const [d, fs, qs] = await Promise.all([api.firm(want), api.firms(), api.quarters().catch(() => quarters)]);
      if (want !== id) return;
      detail = d;
      firms = fs;
      quarters = qs;
      trouble.hidden = true;
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof Error && /unknown firm/.test(err.message) ? 'There is no such firm. It may belong to another city.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (!id) return;
    if (e.type === 'engine.reconnected') return read();
    const d = (e.data ?? {}) as Record<string, any>;
    const firmId = d.firmId ?? d.bid?.firmId ?? d.run?.firmId ?? d.agent?.firmId ?? d.chosen?.firmId ?? null;
    if (firmId === id || e.type === 'tower.sold' || e.type === 'job.awarded' || e.type === 'firm.bankrupt' || e.type === 'merge.detected' || e.type === 'merge.reverted') read();
  }

  // ---------------------------------------------------------------- the head

  function headActions(d: FirmDetail): HTMLElement | null {
    if (!opts.quarterStands(d.id)) return null;
    const wrap = el('div', 'detail-actions-wrap');
    const row = el('div', 'detail-actions-row');
    row.append(button('firm-fly', 'Fly to its quarter', () => opts.flyToQuarter(d.id)));
    wrap.append(row);
    return wrap;
  }

  function subLine(d: FirmDetail): string {
    const temperament = d.agents.find((a) => a.lineage.origin === 'seeded')?.temperament ?? d.agents[0]?.temperament ?? '';
    const parts = [`${ROOT_NAMES[d.root]} root${temperament ? `, ${cleanText(temperament, 60)}` : ''}.`, `Founded ${longDate(d.createdAt)}.`];
    if (d.status === 'bankrupt') parts.push(`Bankrupt since ${d.bankruptAt ? longDate(d.bankruptAt) : 'it ran out'}: its agents retired and its towers went dark.`);
    else if (d.balance < 0) {
      const h = bankruptIn(d.negativeSince, Date.now());
      parts.push(`Below zero${h !== null ? `: bankrupt in ${h} h unless it earns its way back` : ''}.`);
    } else parts.push(`Builds in the ${ERA_NAMES[d.reputation.era]} era.`);
    return parts.join(' ');
  }

  // ---------------------------------------------------------------- standing

  function repLine(points: ReputationPoint[], created: string, endedAt: string | null): SVGSVGElement | HTMLElement {
    if (!points.length) return el('p', 'detail-quiet', 'No resolved bids yet, so no line: every measure counts at its middle value until the first job it wins is merged or fails.');
    const W = 520;
    const H = 116;
    const t0 = Date.parse(created) || Date.parse(points[0].at);
    // A dissolved firm's line stops where it went bankrupt.
    const end = endedAt ? Date.parse(endedAt) : Date.now();
    const t1 = Math.max(end, Date.parse(points.at(-1)!.at), t0 + 1);
    const v0 = 0.3;
    const box = { w: W, h: H, t0, t1, v0, v1: 1 };
    const r1 = (x: number): number => Math.round(x * 10) / 10;
    const x = (t: number): number => r1(((t - t0) / (t1 - t0)) * W);
    const y = (v: number): number => r1(H - ((Math.max(v0, v) - v0) / (1 - v0)) * H);
    const svg = svgEl('svg', { viewBox: `-30 -10 ${W + 96} ${H + 36}`, role: 'img', 'aria-label': `Reputation score over time, from ${points[0].score.toFixed(2)} to ${points.at(-1)!.score.toFixed(2)}` }, 'repline');
    const now = points.at(-1)!.score;
    // The era each score earns, ruled across the field and named at the right (unless the line's own figure stands there).
    for (const [v, era] of ERA_LINES) {
      svg.append(svgEl('line', { x1: 0, y1: y(v), x2: W, y2: y(v) }, 'repline-era'));
      if (Math.abs(y(v) - y(now)) < 15) continue;
      const t = svgEl('text', { x: W + 8, y: y(v) + 3.5 }, 'repline-era-name');
      t.textContent = era;
      svg.append(t);
    }
    for (const v of [0.5, 1]) {
      const t = svgEl('text', { x: -8, y: y(v) + 3.5, 'text-anchor': 'end' }, 'repline-axis');
      t.textContent = v.toFixed(1);
      svg.append(t);
    }
    svg.append(svgEl('line', { x1: 0, y1: H + 0.5, x2: W, y2: H + 0.5 }, 'repline-base'));
    // Each resolved bid as a tick on the base: bronze for work that merged, rust for work that failed, a cross for a revert.
    for (const p of points) {
      const px = x(Date.parse(p.at));
      if (p.event === 'revert') svg.append(svgEl('path', { d: `M${px - 2.5} ${H + 3}l5 5m0 -5l-5 5` }, 'repline-tick revert'));
      else svg.append(svgEl('line', { x1: px, y1: H + 2, x2: px, y2: H + 7 }, `repline-tick ${p.event}`));
    }
    for (const [t, anchor, text] of [
      [t0, 'start', shortDate(new Date(t0).toISOString())],
      [t1, 'end', endedAt ? `bankrupt ${shortDate(endedAt)}` : 'now'],
    ] as Array<[number, string, string]>) {
      const tx = svgEl('text', { x: x(t), y: H + 22, 'text-anchor': anchor }, `repline-axis${endedAt && t === t1 ? ' ended' : ''}`);
      tx.textContent = text;
      svg.append(tx);
    }
    // Before its first resolved bid every term counts at its middle: a score of 0.5.
    const pts = [{ t: t0, v: 0.5 }, ...points.map((p) => ({ t: Date.parse(p.at), v: Math.max(v0, p.score) }))];
    svg.append(svgEl('path', { d: stepPath(pts, box) }, 'repline-line'));
    if (endedAt) svg.append(svgEl('line', { x1: W - 0.5, y1: y(now) - 6, x2: W - 0.5, y2: H }, 'repline-end'));
    else svg.append(svgEl('circle', { cx: W, cy: y(now), r: 2.6 }, 'repline-dot'));
    // The score now, and beside it the era it builds in, so no era rule can crowd it out.
    const lbl = svgEl('text', { x: W + 8, y: y(now) + 4 }, 'repline-now');
    lbl.textContent = now.toFixed(2);
    const era = svgEl('tspan', { dx: 5 }, 'repline-era-now');
    era.textContent = ERA_LINES.find(([v]) => now >= v)?.[1] ?? 'Stone';
    lbl.append(era);
    svg.append(lbl);
    return svg;
  }

  function standingSection(d: FirmDetail): HTMLElement {
    const sec = el('section', 'detail-sec firm-standing');
    sec.append(secHead('Standing', `${plural(d.reputation.samples, 'resolved bid')}`));
    const grid = el('div', 'standing-grid');
    const left = el('div', 'standing-books');
    const bal = balanceCell(d, Date.now(), { always: true });
    bal.classList.add('standing-bal');
    left.append(bal);
    const change = Math.round((d.balance - d.opening) * 100) / 100;
    left.append(el('p', 'standing-since', `${change === 0 ? 'Level' : signed(change)} since it opened with ${figure(d.opening)}.`));
    const ms = el('dl', 'standing-measures');
    for (const m of measures(d.reputation)) {
      const row = el('div', `measure m-${m.key}`);
      row.append(el('dt', 'measure-name', m.label), el('dd', 'measure-val', m.said));
      const g = el('dd', 'measure-gauge');
      g.append(gauge(m.value, m.label, { width: 112 }));
      row.append(g);
      ms.append(row);
    }
    left.append(ms);
    left.append(el('p', 'standing-trim', d.reputation.overclaim > 0 ? `Its stated confidence is trimmed by ${pct(d.reputation.overclaim)} before each award: it has claimed more than its record shows.` : 'Its stated confidence is taken as said: its record bears it out.'));
    const right = el('figure', 'standing-line');
    right.append(repLine(d.reputationLine, d.createdAt, d.status === 'bankrupt' ? d.bankruptAt : null));
    const cap = el('figcaption', 'standing-cap', 'Its reputation score after each resolved bid (marked on the base: bronze merged, rust failed), ruled with the era each score builds in. The score is half pass rate, three tenths calibration and a fifth durability.');
    right.append(cap);
    grid.append(left, right);
    sec.append(grid);
    return sec;
  }

  // ---------------------------------------------------------------- people

  function peopleSection(d: FirmDetail): HTMLElement {
    const sec = el('section', 'detail-sec firm-people');
    const working = d.agents.filter((a) => !a.retired).length;
    sec.append(secHead('People', d.status === 'bankrupt' ? 'all retired' : plural(working, 'agent')));
    const towers = new Map(quarters.flatMap((q) => q.towers).filter((t) => t.agentId).map((t) => [t.agentId!, t] as const));
    const n = names();
    const ul = el('ul', 'people');
    for (const a of d.agents) {
      const li = el('li', `person${a.retired ? ' retired' : ''}`);
      li.dataset.agent = a.id;
      const t = towers.get(a.id);
      const glyph = el('div', 'person-glyph');
      glyph.append(silhouetteGlyph(a.silhouette, { dark: a.retired && !(t && t.firmId !== d.id) }));
      glyph.append(el('span', 'person-sil', a.silhouette));
      const main = el('div', 'person-main');
      const top = el('div', 'person-top');
      const name = el('a', 'person-name', cleanText(a.name, 80));
      name.href = placeHref('agent', a.id);
      top.append(name);
      if (a.lineage.origin === 'roster') top.append(el('span', 'person-tag', `hired ${shortDate(a.lineage.at)}`));
      main.append(top, el('p', 'person-line', cleanText(a.persona, 220)));
      const meta = el('p', 'person-meta');
      meta.append(el('span', 'person-model', cleanText(a.model, 60)), el('span', 'person-temper', cleanText(a.temperament, 60)), el('span', 'person-shape', SHAPE_WORDS[a.workflow.shape] ?? a.workflow.shape));
      const floors = t ? t.floors.filter((f) => f.earned?.state !== 'scar').length : 0;
      meta.append(el('span', 'person-floors', plural(floors, 'floor')));
      main.append(meta);
      if (a.retired) {
        const sold = t && t.firmId && t.firmId !== d.id ? `; its tower now stands for ${n.firm(t.firmId)}` : '';
        main.append(el('p', 'person-retired', `Retired: ${cleanText(a.retiredReason ?? 'no reason given', 80)}${sold}.`));
      }
      li.append(glyph, main);
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  // ---------------------------------------------------------------- rounds

  function roundRow(r: FirmRound, n: StoryNames): HTMLElement {
    const cls = r.won ? 'won' : r.winner ? 'lost' : 'none';
    const li = el('li', `round-row ${cls}`);
    li.dataset.job = r.jobId;
    const mark = el('i', 'round-mark');
    mark.setAttribute('aria-hidden', 'true');
    const when = el('time', 'round-when', shortDate(r.at));
    when.dateTime = r.at;
    const what = el('div', 'round-what');
    const title = pageLink('round-title', cleanText(r.title, 140), 'job', r.jobId);
    what.append(title, el('p', 'round-said', roundWords(r, n)));
    const ev = el('div', 'round-ev');
    ev.append(el('span', 'round-ev-ours', money(r.bid.ev)));
    if (!r.won && r.winner) ev.append(el('span', 'round-ev-vs', money(r.winner.ev)));
    ev.title = r.won ? `Its expected value: ${money(r.bid.ev)} on a ${r.value} credit job` : r.winner ? `Its expected value ${money(r.bid.ev)} against the winner’s ${money(r.winner.ev)}` : `Its expected value ${money(r.bid.ev)}: below zero, so not worth taking`;
    li.append(mark, when, what, ev);
    return li;
  }

  function roundsSection(d: FirmDetail): HTMLElement {
    const sec = el('section', 'detail-sec firm-rounds');
    const won = d.rounds.filter((r) => r.won).length;
    // A round nobody won is no loss: no bid in it was worth its price.
    const lost = d.rounds.filter((r) => !r.won && r.winner).length;
    const none = d.rounds.length - won - lost;
    sec.append(secHead('Jobs won and lost', `${won} won, ${lost} lost, ${none} unawarded`));
    sec.append(el('p', 'jobs-key', 'Each round the firm bid in, newest first. The figure on the right is its expected value: the job’s worth times its calibrated chance, less its price. A lost round sets it against the bid that won.'));
    const group = el('div', 'jobs-filter rounds-filter');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Show rounds');
    for (const [k, text] of [
      ['all', `All ${d.rounds.length}`],
      ['won', `Won ${won}`],
      ['lost', `Lost ${lost}`],
      ['none', `Unawarded ${none}`],
    ] as Array<[RoundFilter, string]>) {
      const b = el('button', 'jobs-pick', text);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.filter = k;
      b.addEventListener('click', () => pick(b));
      group.append(b);
    }
    const pick = (b: HTMLElement): void => {
      filter = b.dataset.filter as RoundFilter;
      allRounds = false;
      render();
      body.querySelector<HTMLElement>(`.rounds-filter [data-filter="${filter}"]`)?.focus({ preventScroll: true });
    };
    rovingRadios(group, pick);
    checkRadio(group, group.querySelector(`[data-filter="${filter}"]`));
    sec.append(group);
    const shown = [...d.rounds].reverse().filter((r) => (filter === 'all' ? true : filter === 'won' ? r.won : filter === 'lost' ? !r.won && !!r.winner : !r.winner));
    if (!shown.length) {
      sec.append(el('p', 'detail-quiet', d.rounds.length ? 'None of these.' : 'It has not bid on a job yet.'));
      return sec;
    }
    const n = names();
    const ol = el('ol', 'rounds');
    for (const r of allRounds ? shown : shown.slice(0, ROUNDS_SHOWN)) ol.append(roundRow(r, n));
    sec.append(ol);
    if (!allRounds && shown.length > ROUNDS_SHOWN) {
      sec.append(
        textButton('rounds-more', `Show all ${shown.length}`, () => {
          allRounds = true;
          render();
        }),
      );
    }
    return sec;
  }

  // ---------------------------------------------------------------- books

  function balanceTrace(d: FirmDetail): SVGSVGElement | null {
    if (d.books.length < 2) return null;
    const W = 640;
    const H = 46;
    // The left edge: what it opened with, or, when older movements were left out, where they left it.
    const first = d.books[0];
    const start = d.truncated ? { t: Date.parse(first.at), v: first.balance - first.delta } : { t: Math.min(Date.parse(d.createdAt) || Date.parse(first.at), Date.parse(first.at)), v: d.opening };
    const pts = [start, ...d.books.map((b) => ({ t: Date.parse(b.at), v: b.balance }))];
    const lo = Math.min(0, ...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v), 1);
    const box = { w: W, h: H, t0: pts[0].t, t1: Math.max(pts.at(-1)!.t, pts[0].t + 1), v0: lo, v1: hi };
    const svg = svgEl('svg', { viewBox: `0 -4 ${W} ${H + 8}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Balance from ${money(pts[0].v)} to ${money(pts.at(-1)!.v)} credits` }, 'balance-trace');
    if (lo < 0) {
      const zy = Math.round((H - ((0 - lo) / (hi - lo)) * H) * 10) / 10;
      svg.append(svgEl('line', { x1: 0, y1: zy, x2: W, y2: zy }, 'trace-zero'));
    }
    svg.append(svgEl('path', { d: stepPath(pts, box) }, 'trace-line'));
    return svg;
  }

  function booksSection(d: FirmDetail): HTMLElement {
    const sec = el('section', 'detail-sec firm-books');
    sec.append(secHead('Books', `${grouped(d.balance)} credits`));
    const trace = balanceTrace(d);
    if (trace) sec.append(trace);
    if (d.truncated) sec.append(el('p', 'jobs-key books-truncated', `The newest ${plural(d.books.length, 'movement')} of a longer book; the balances still count every one before them.`));
    sec.append(el('p', 'jobs-key', 'Every credit in and out, newest first, with the balance it left. Bids and work are paid for as the models are called; a merged job pays the winning price; reviewing another firm’s work pays a twentieth of the job.'));
    const lines = bookLines(d.books, names(), { newestFirst: true });
    if (!lines.length) {
      sec.append(el('p', 'detail-quiet', 'Nothing on the books yet beyond what it opened with.'));
      return sec;
    }
    const days: Array<{ heading: string; lines: typeof lines }> = [];
    for (const l of lines) {
      const h = dayHeading(l.at);
      if (days.at(-1)?.heading !== h) days.push({ heading: h, lines: [] });
      days.at(-1)!.lines.push(l);
    }
    const table = el('div', 'books');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', `The books of ${cleanText(d.name, 80)}`);
    const hr = el('div', 'books-head');
    hr.setAttribute('role', 'row');
    for (const [cls, text] of [
      ['books-time', ''],
      ['books-text', 'Entry'],
      ['books-amt', 'In and out'],
      ['books-bal', 'Balance'],
    ]) {
      const c = el('span', cls, text);
      c.setAttribute('role', 'columnheader');
      hr.append(c);
    }
    table.append(hr);
    for (const day of allBooks ? days : days.slice(0, BOOK_DAYS_SHOWN)) {
      const dh = el('div', 'books-day');
      dh.setAttribute('role', 'row');
      const c = el('span', '', day.heading);
      c.setAttribute('role', 'rowheader');
      dh.append(c);
      table.append(dh);
      for (const l of day.lines) {
        const r = el('div', `books-row k-${l.kind}${l.delta < 0 ? ' out' : ' in'}`);
        r.setAttribute('role', 'row');
        const t = el('time', 'books-time', clock(l.at));
        t.dateTime = l.at;
        const text = el('span', 'books-text');
        if (l.jobId && (l.kind === 'pay' || l.kind === 'run' || l.kind === 'review-pay')) text.append(pageLink('books-job', l.text, 'job', l.jobId));
        else if (l.agentId && (l.kind === 'hire' || l.kind === 'sale')) text.append(pageLink('books-job', l.text, 'agent', l.agentId));
        else text.textContent = l.text;
        r.append(t, text, el('span', 'books-amt', signed(l.delta)), el('span', `books-bal${l.balance < 0 ? ' neg' : ''}`, figure(l.balance)));
        for (const c of r.children) c.setAttribute('role', 'cell');
        table.append(r);
      }
    }
    sec.append(table);
    if (!allBooks && days.length > BOOK_DAYS_SHOWN) {
      sec.append(
        textButton('books-more', `Show the whole book, ${plural(days.length, 'day')}`, () => {
          allBooks = true;
          render();
        }),
      );
    }
    return sec;
  }

  // ---------------------------------------------------------------- deals

  function dealsSection(d: FirmDetail): HTMLElement {
    const sec = el('section', 'detail-sec firm-deals');
    sec.append(secHead('Hires and towers'));
    const n = names();
    if (!d.deals.length) {
      sec.append(el('p', 'detail-quiet', d.status === 'bankrupt' ? 'It hired nobody before it failed.' : `No hires yet. A firm hires a specialist for ${HIRE_FEE} credits once it holds more than 400 and has more open jobs than idle agents.`));
      return sec;
    }
    const ul = el('ul', 'deals');
    for (const x of d.deals) {
      const li = el('li', `deal k-${x.kind}`);
      const t = el('time', 'deal-when', shortDate(x.at));
      t.dateTime = x.at;
      const said = el('p', 'deal-said');
      const who = pageLink('deal-agent', n.agent(x.agentId), 'agent', x.agentId);
      const other = x.other ? pageLink('deal-firm', n.firm(x.other), 'firm', x.other) : null;
      if (x.kind === 'hired') said.append('Hired ', who, ` from the roster for ${money(x.price)} credits.`);
      else if (x.kind === 'bought') said.append('Bought ', who, '’s dark tower from ', other ?? 'a bankrupt firm', `, for ${money(x.price)} credits, and re-clad it in its own root.`);
      else said.append('Its tower for ', who, ' was sold to ', other ?? 'another firm', ` for ${money(x.price)} credits; as a dissolved firm it was paid nothing.`);
      li.append(t, said);
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    if (!sheet.shown || !detail) return;
    const d = detail;
    setTrail(sheet.trail, [
      ['Firms', placeHref('firms')],
      [cleanText(d.name, 80), null],
    ]);
    const title = cleanText(d.name, 80);
    if (sheet.title.textContent !== title) sheet.title.textContent = title;
    motto.textContent = cleanText(d.motto, 160);
    sheet.root.dataset.status = d.status;
    sheet.sub.textContent = subLine(d);
    const qkey = JSON.stringify(quarters.map((q) => q.towers.map((t) => [t.agentId, t.firmId, t.floors.length])));
    slots.head(JSON.stringify([d.id, opts.quarterStands(d.id)]), () => headActions(d));
    slots.standing(JSON.stringify([d.balance, d.reputation, d.reputationLine.length, d.books.length, Math.floor(Date.now() / 3_600_000)]), () => standingSection(d));
    slots.people(JSON.stringify([d.agents, qkey, firms.length]), () => peopleSection(d));
    slots.rounds(JSON.stringify([d.rounds.length, d.rounds.at(-1), filter, allRounds, firms.length]), () => roundsSection(d));
    slots.books(JSON.stringify([d.books.length, d.books.at(-1), allBooks, new Date().getDate()]), () => booksSection(d));
    slots.deals(JSON.stringify([d.deals, firms.length]), () => dealsSection(d));
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        detail = null;
        filter = 'all';
        allRounds = false;
        allBooks = false;
        sheet.title.textContent = '';
        sheet.sub.textContent = '';
        motto.textContent = '';
        for (const s of Object.values(slots)) s('', () => null);
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // "bankrupt in N h" counts down by itself, as on the firms list.
        timer = setInterval(render, 60_000);
      }
      if (changed) sheet.body.scrollTop = 0;
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
      if (timer) clearInterval(timer);
      timer = null;
      // Emptied, so reopening never shows the last firm's books before its own arrive.
      id = null;
      detail = null;
      sheet.title.textContent = '';
      sheet.sub.textContent = '';
      motto.textContent = '';
      for (const s of Object.values(slots)) s('', () => null);
    },
  };
}

