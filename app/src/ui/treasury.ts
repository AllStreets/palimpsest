import type { BudgetWindow, CreditEntry, FirmView, ReportView, SpendPeriod, TreasuryView } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref, routeHref } from '../router';
import { cleanText, githubUrl } from './board';
import { ago, button, checkRadio, createSheet, el, rovingRadios } from './controls';
import { gauge, svgEl } from './firms';
import { coalesce, keyedSlot, namesOf, outLink, refusal, secHead } from './pages';
import { figure, shortDate } from './story';
import { calibrationLine, pauseWords, reportBlocks, resetWords, spendFigure, type ReportBlock, type ReportSpan } from './treasury-words';
import './market.css';

export interface TreasuryScreen {
  show(): void;
  hide(): void;
}

/** Days of reports the picker offers, the newest last. */
const DAYS_SHOWN = 7;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The city's own reviews and design checks, asked for by a key no firm id can take (engine/market/spend.ts). */
const CITY = '~city';
const KIND_WORDS: Record<string, string> = { bid: 'Bid', run: 'Run', review: 'Review', judge: 'Design check' };

/** A percentage of a window: whole when it is whole, else one decimal. */
function pctOf(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}%`;
}

const hm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function dayLabel(day: string): { short: string; date: string } {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y, m - 1, d);
  return { short: WEEKDAY[at.getDay()], date: `${d} ${MONTH[m - 1]}` };
}

/** Why the night cap applies now: the hour, or nobody having had the app open for half an hour. */
function nightNote(now: number): string {
  const h = new Date(now).getHours();
  return h >= 23 || h < 7 ? 'It is night (23:00 to 07:00), so the night cap applies.' : 'The app has not been open for half an hour, so the night cap applies.';
}

// ---------------------------------------------------------------- the ruled meter

const W = 640;
/** Where the scale is ruled, beneath the bar, the city's line and the night line. */
const BASE = 50.5;
const x = (p: number): number => Math.round((Math.max(0, Math.min(100, p)) / 100) * W * 2) / 2;

/** Past this share of the scale a mark's label reads to the left of its mark, so it never runs into the hard stop. */
const LABEL_FLIP_PCT = 60;

/** Where a cap mark's label stands: to the right of its mark, or to the left once the mark sits past LABEL_FLIP_PCT. */
function markLabelAt(pct: number, markX: number, y: number): Record<string, string | number> {
  return pct > LABEL_FLIP_PCT ? { x: markX - 4, y, 'text-anchor': 'end' } : { x: markX + 4, y };
}

/**
 * One window as a ruled meter, drawn as an engineer rules a scale: his plan
 * as the heavy bar (what the last reading said, solid; what the city has
 * spent since, hatched), the city's own share as a bronze line beneath it
 * against its cap, and the hard stop struck through both in rust.
 */
function meterRule(w: BudgetWindow, o: { cap: number | null; capLabel: string; stop: number; label: string; night?: { usedPct: number; capPct: number } }): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: `-12 0 ${W + 24} ${BASE + 22}`, role: 'img', 'aria-label': o.label, preserveAspectRatio: 'xMinYMid meet' }, 'meter-rule');
  const defs = svgEl('defs');
  const pat = svgEl('pattern', { id: `meter-hatch-${o.capLabel.replace(/\W/g, '')}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 4 }, 'meter-hatch-line'));
  defs.append(pat);
  svg.append(defs);
  const used = w.usedPct ?? 0;
  const est = Math.max(used, w.estimatedPct);
  // The bed of the bar, so an empty window still reads as a scale.
  svg.append(svgEl('rect', { x: 0, y: 12, width: W, height: 10 }, 'meter-bed'));
  svg.append(svgEl('rect', { x: 0, y: 12, width: x(used), height: 10 }, 'meter-his'));
  if (est > used + 0.05) svg.append(svgEl('rect', { x: x(used), y: 12, width: Math.max(1, x(est) - x(used)), height: 10, fill: `url(#${pat.id})` }, 'meter-est'));
  // The city's own share, from zero, against its cap.
  svg.append(svgEl('line', { x1: 0, y1: 31.5, x2: W, y2: 31.5 }, 'meter-city-bed'));
  svg.append(svgEl('rect', { x: 0, y: 30, width: Math.max(w.cityPct > 0 ? 1.5 : 0, x(w.cityPct)), height: 3 }, 'meter-city'));
  if (o.cap !== null) {
    const cx = x(o.cap);
    svg.append(svgEl('path', { d: `M${cx} 26.5V36.5` }, 'meter-cap'));
    const ct = svgEl('text', markLabelAt(o.cap, cx, 40.5), 'meter-mark-label');
    ct.textContent = o.capLabel;
    svg.append(ct);
  }
  // Unattended use alone, on a line of its own, against the night cap (it is not the city's total).
  if (o.night) {
    svg.append(svgEl('line', { x1: 0, y1: 39.5, x2: W, y2: 39.5 }, 'meter-night-bed'));
    const seg = svgEl('rect', { x: 0, y: 38, width: Math.max(o.night.usedPct > 0 ? 1.5 : 0, x(o.night.usedPct)), height: 3 }, 'meter-night');
    seg.setAttribute('data-pct', String(o.night.usedPct));
    svg.append(seg);
    const nx = x(o.night.capPct);
    svg.append(svgEl('path', { d: `M${nx} 34.5V44.5` }, 'meter-cap night'));
    const nt = svgEl('text', markLabelAt(o.night.capPct, nx, 43.5), 'meter-mark-label night');
    nt.textContent = `night cap ${pctOf(o.night.capPct)}, unattended use`;
    svg.append(nt);
  }
  // The scale: a tick every tenth, longer at the quarters' halves, figures at the quarters.
  svg.append(svgEl('line', { x1: 0, y1: BASE, x2: W, y2: BASE }, 'meter-base'));
  for (let p = 0; p <= 100; p += 5) {
    const tx = x(p) + (p === 100 ? -0.5 : 0.5);
    const len = p % 50 === 0 ? 6 : p % 10 === 0 ? 4 : 2;
    svg.append(svgEl('line', { x1: tx, y1: BASE, x2: tx, y2: BASE + len }, 'meter-tick'));
    if (p % 25 === 0) {
      const t = svgEl('text', { x: tx, y: BASE + 17, 'text-anchor': p === 0 ? 'start' : p === 100 ? 'end' : 'middle' }, 'meter-num');
      t.textContent = `${p}`;
      svg.append(t);
    }
  }
  // The hard stop, through the bar and the lines beneath it.
  const sx = x(o.stop) + 0.5;
  svg.append(svgEl('path', { d: `M${sx} 7V${BASE}` }, 'meter-stop'));
  const st = svgEl('text', { x: sx - 4, y: 6.5, 'text-anchor': 'end' }, 'meter-mark-label stop');
  st.textContent = `hard stop ${o.stop}%`;
  svg.append(st);
  return svg;
}

// ---------------------------------------------------------------- the page

/**
 * The treasury (#/treasury): his plan's five-hour and seven-day windows as
 * two ruled meters, what the city has spent of them and how its own use is
 * measured, why it is paused (with the one action that clears it), what is
 * running now, the spend today and in the last 7 days by firm and by model (each
 * row opening to its credits entries), every firm's balance, and the daily
 * report below with a day picker. Updates from the event stream.
 */
export function createTreasury(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): TreasuryScreen {
  const sheet = createSheet(parent, 'treasury', 'Treasury', opts.onDismiss);
  const head = sheet.root.querySelector('.sheet-head')!;
  const facts = el('p', 'sheet-facts');
  head.append(facts);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  sheet.body.append(trouble);
  // The notice is announced as it comes and goes: a pause, or the line saying the city resumed.
  const pauseHost = el('div', 'treasury-pause-host');
  pauseHost.setAttribute('aria-live', 'polite');
  sheet.body.append(pauseHost);
  const slots = {
    pause: keyedSlot(pauseHost),
    plan: keyedSlot(sheet.body),
    now: keyedSlot(sheet.body),
    spend: keyedSlot(sheet.body),
    report: keyedSlot(sheet.body),
  };

  let t: TreasuryView | null = null;
  let firms: FirmView[] = [];
  let report: ReportView | null = null;
  let day: string | null = null;
  let resumeError = '';
  let resuming = false;
  const open = new Set<string>();
  const entryCache = new Map<string, { at: number; rows: CreditEntry[]; count: number; total: number } | 'loading' | 'failed'>();
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  let reportStale = true;
  const read = coalesce(async () => {
    try {
      [t, firms] = await Promise.all([api.treasury(), api.firms().catch(() => firms)]);
      trouble.hidden = true;
      // The open rows' entries are read again with the rest; the closed ones when next opened.
      for (const key of [...entryCache.keys()]) if (!open.has(key)) entryCache.delete(key);
      for (const key of open) void loadEntries(key, true);
    } catch (err) {
      trouble.textContent = `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
    const want = day ?? t?.reports[0] ?? null;
    if (want && (report?.day !== want || reportStale)) {
      reportStale = false;
      await readReport(want);
    }
  });

  async function readReport(want: string): Promise<void> {
    try {
      const r = await api.report(want);
      if ((day ?? t?.reports[0]) !== want) return;
      report = r;
    } catch {
      report = null;
    }
    render();
  }

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected' || e.type === 'report.written') reportStale = true;
    if (e.type === 'engine.reconnected') return read();
    if (/^(credits\.moved|run\.(started|ended|stage)|bid\.placed|report\.written|settings\.|firm\.)/.test(e.type)) read();
  }

  // ---------------------------------------------------------------- the pause

  function pauseBlock(v: TreasuryView, now: number): HTMLElement | null {
    const p = pauseWords(v.paused, v.reading, now);
    if (!p) {
      if (v.resumedUntil === null) return null;
      const r = el('p', 'treasury-resumed', `Resumed on your say-so until ${hm(v.resumedUntil)}. With no fresh reading, the city counts your own Claude Code use from your transcripts and still stops at the hard stop.`);
      return r;
    }
    const box = el('div', `treasury-pause pause-${p.reason}`);
    box.dataset.reason = p.reason;
    const mark = el('span', 'pause-mark');
    mark.setAttribute('aria-hidden', 'true');
    const words = el('div', 'pause-words');
    words.append(el('p', 'pause-title', p.title), el('p', 'pause-text', p.text));
    box.append(mark, words);
    if (p.action === 'resume') {
      const act = el('div', 'pause-act');
      const b = button('pause-resume', 'Resume anyway', () => void resume());
      b.disabled = resuming;
      act.append(b);
      if (resumeError) act.append(el('p', 'pause-error', resumeError));
      box.append(act);
    } else if (p.action === 'settings') {
      const act = el('div', 'pause-act');
      const a = el('a', 'btn pause-settings', 'Open Settings');
      a.href = routeHref('settings');
      act.append(a);
      box.append(act);
    }
    return box;
  }

  async function resume(): Promise<void> {
    if (resuming) return;
    resuming = true;
    resumeError = '';
    render();
    try {
      t = await api.resumeStale();
    } catch (err) {
      resumeError = refusal('Resume', err);
    } finally {
      resuming = false;
    }
    render();
    // Focus goes to what took the button's place: the line saying until when the city carries on.
    const done = sheet.root.querySelector<HTMLElement>('.treasury-resumed');
    if (done) {
      done.tabIndex = -1;
      done.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- his plan

  function meter(v: TreasuryView, which: 'five' | 'seven', now: number): HTMLElement {
    const w = which === 'five' ? v.fiveHour : v.sevenDay;
    const name = which === 'five' ? 'Five-hour window' : 'Seven-day window';
    const box = el('div', 'meter');
    box.dataset.window = which;
    const fig = el('div', 'meter-fig');
    const reset = w.resetsAt !== null && w.resetsAt * 1000 <= now;
    fig.append(el('span', 'meter-name', name), el('span', `meter-used${reset || w.usedPct === null ? ' unread' : ''}`, w.usedPct === null ? 'unread' : pctOf(w.usedPct)));
    const usedNote = w.usedPct === null ? 'No reading of this window yet.' : reset ? 'It reset after your last reading, and nothing has read it since.' : 'used, at your last reading';
    fig.append(el('span', 'meter-used-note', usedNote));
    const right = el('div', 'meter-draw');
    const head = el('div', 'meter-head');
    head.append(el('span', 'meter-reset', resetWords(w.resetsAt, now)));
    const cap = w.capPct;
    const capLabel = which === 'five' ? `city cap ${pctOf(cap)}` : 'week';
    const label = `${name}: ${w.usedPct === null ? 'unread' : `${pctOf(w.usedPct)} used`} by the last reading, about ${pctOf(w.estimatedPct)} now; the city's share ${pctOf(w.cityPct)}${which === 'five' ? ` against its ${pctOf(cap)} cap` : `, unattended ${pctOf(v.night.usedPct)} against the ${pctOf(v.night.capPct)} night cap`}; hard stop at ${v.hardStopPct}%; ${resetWords(w.resetsAt, now)}.`;
    right.append(head, meterRule(w, which === 'five' ? { cap, capLabel, stop: v.hardStopPct, label } : { cap: null, capLabel, stop: v.hardStopPct, label, night: v.night }));
    const legend = el('p', 'meter-legend');
    const key = (cls: string, text: string): HTMLElement => {
      const k = el('span', 'meter-key');
      const sw = el('i', `meter-swatch ${cls}`);
      sw.setAttribute('aria-hidden', 'true');
      k.append(sw, document.createTextNode(text));
      return k;
    };
    const since = w.estimatedPct - (w.usedPct ?? 0);
    legend.append(
      key('his', `Your plan, about ${pctOf(w.estimatedPct)} now${since >= 0.05 ? ` with ${pctOf(since)} spent since the reading` : ''}`),
      key('city', `The city’s share, ${pctOf(w.cityPct)} of the window${which === 'five' ? `, against its ${pctOf(cap)} cap` : ''}`),
      ...(which === 'seven' ? [key('night', `Unattended, ${pctOf(v.night.usedPct)} of the week, against the ${pctOf(v.night.capPct)} night cap`)] : []),
    );
    right.append(legend);
    box.append(fig, right);
    return box;
  }

  function planBlock(v: TreasuryView, now: number): HTMLElement {
    const sec = el('section', 'treasury-plan');
    sec.append(secHead('Your plan', v.reading ? `read ${ago(v.reading.at, now)}` : 'no reading yet'));
    sec.append(meter(v, 'five', now), meter(v, 'seven', now));
    const cal = el('p', 'calibration-line', calibrationLine(v.calibration));
    sec.append(cal);
    return sec;
  }

  // ---------------------------------------------------------------- now

  function slots_(used: number, max: number, label: string): HTMLElement {
    const s = el('span', 'slots');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', `${label}: ${used} of ${max} in use`);
    const n = Math.max(used, max);
    for (let i = 0; i < n; i++) s.append(el('i', `slot${i < used ? ' busy' : ''}${i >= max ? ' over' : ''}`));
    return s;
  }

  function nowRow(key: string, label: string, value: Node[], aside?: Node): HTMLElement {
    const r = el('div', 'now-row');
    r.dataset.now = key;
    const v = el('div', 'now-val');
    v.append(...value);
    r.append(el('span', 'now-label', label), v);
    const a = el('div', 'now-aside');
    if (aside) a.append(aside);
    r.append(a);
    return r;
  }

  function nowBlock(v: TreasuryView): HTMLElement {
    const sec = el('section', 'treasury-now');
    sec.append(secHead('Now'));
    const c = v.concurrency;
    const conc = el('span', '', `Claude ${c.claude} of ${c.claudeMax}, local ${c.local} of ${c.localMax}, API ${c.api}`);
    const concNote = v.interactiveActive ? [el('span', 'now-note', 'Your own Claude Code is busy, so the city keeps to one Claude run.')] : [];
    const glyphs = el('div', 'now-slots');
    glyphs.append(slots_(c.claude, c.claudeMax, 'Claude'), slots_(c.local, c.localMax, 'Local'));
    sec.append(nowRow('concurrency', 'Running', [conc, ...concNote], glyphs));
    const n = v.night;
    sec.append(
      nowRow(
        'night',
        'Night cap',
        [document.createTextNode(`Unattended Claude use this week is ${pctOf(n.usedPct)} of the ${pctOf(n.capPct)} night cap.`), ...(n.unattended ? [el('span', 'now-note', nightNote(Date.now()))] : [])],
        gauge(n.capPct > 0 ? n.usedPct / n.capPct : 0, 'Night cap used', { width: 96 }),
      ),
    );
    const a = v.api;
    sec.append(
      a.enabled
        ? nowRow('api', 'Anthropic API', [document.createTextNode(`$${a.spentUsdToday.toFixed(2)} of the $${a.dailyUsd.toFixed(2)} daily limit spent today.`)], gauge(a.dailyUsd > 0 ? a.spentUsdToday / a.dailyUsd : 0, 'API dollars today', { width: 96 }))
        : nowRow('api', 'Anthropic API', [document.createTextNode('Off. Firms work only on your plan and on local models.')]),
    );
    const k = v.keepAwake;
    sec.append(
      nowRow('awake', 'Keep awake', [
        document.createTextNode(k.on ? (k.held ? 'Holding the Mac awake while the city works.' : 'On. Nothing is running, so nothing holds the Mac awake.') : 'Off. If the Mac sleeps, the city’s work waits with it.'),
      ]),
    );
    return sec;
  }

  // ---------------------------------------------------------------- spend and balances

  function entryKey(kind: 'firm' | 'model', id: string): string {
    return `${kind}:${id}`;
  }

  async function loadEntries(key: string, quietly = false): Promise<void> {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    // Read again in place: the entries already shown stay until the new ones arrive.
    if (!quietly || !entryCache.has(key)) {
      entryCache.set(key, 'loading');
      render();
    }
    try {
      const r = await api.credits({ period: 'week', ...(kind === 'firm' ? { firm: id } : { model: id }) });
      entryCache.set(key, { at: Date.now(), ...r });
    } catch {
      entryCache.set(key, 'failed');
    }
    render();
  }

  function entriesBlock(key: string, names: ReturnType<typeof namesOf>, byModel: boolean): HTMLElement {
    const box = el('div', 'spend-entries');
    box.id = `entries-${key.replace(/[^a-z0-9]/gi, '-')}`;
    const got = entryCache.get(key);
    if (!got || got === 'loading') {
      box.append(el('p', 'entries-note', 'Reading its entries.'));
      return box;
    }
    if (got === 'failed') {
      box.append(el('p', 'entries-note', 'The engine did not answer for its entries.'));
      return box;
    }
    if (got.rows.length === 0) {
      box.append(el('p', 'entries-note', 'No entries in the last 7 days.'));
      return box;
    }
    const list = el('ol', 'entries');
    for (const r of got.rows) {
      const li = el('li', 'entry');
      const when = new Date(r.at);
      li.append(el('span', 'entry-id', `No. ${r.id}`), el('span', 'entry-when', `${WEEKDAY[when.getDay()]} ${hm(when.getTime())}`));
      const what = el('span', 'entry-what');
      const kind = KIND_WORDS[r.kind] ?? r.kind;
      if (r.runId && r.jobId) {
        const a = el('a', 'entry-run', kind);
        a.href = placeHref('run', r.runId);
        what.append(a);
      } else what.append(document.createTextNode(kind));
      const who = byModel ? (r.firmId && (r.kind === 'bid' || r.kind === 'run') ? names.firm(r.firmId) : 'the city') : cleanText(r.model, 60);
      what.append(el('span', 'entry-who', ` ${byModel ? 'for' : 'on'} ${who}`));
      if (r.unattended) what.append(el('span', 'entry-night', ' unattended'));
      li.append(what, el('span', 'entry-amt', figure(r.credits)));
      list.append(li);
    }
    box.append(list);
    const more = got.count - got.rows.length;
    box.append(el('p', 'entries-note', `${got.count === 1 ? '1 entry' : `${got.count} entries`} in the last 7 days, ${figure(got.total)} credits${more > 0 ? `; the newest ${got.rows.length} are shown` : ''}.`));
    return box;
  }

  function spendRow(key: string, label: HTMLElement | string, today: number, week: number, entries: number, last: HTMLElement, names: ReturnType<typeof namesOf>, byModel: boolean, data: Record<string, string>): HTMLElement[] {
    const r = el('div', 'spend-row');
    r.setAttribute('role', 'row');
    Object.assign(r.dataset, data);
    const first = el('div', 'spend-cell c-name');
    first.setAttribute('role', 'rowheader');
    const isOpen = open.has(key);
    const b = el('button', 'spend-open');
    b.type = 'button';
    b.setAttribute('aria-expanded', String(isOpen));
    const caret = el('i', 'spend-caret');
    caret.setAttribute('aria-hidden', 'true');
    b.append(caret, typeof label === 'string' ? document.createTextNode(label) : label);
    b.title = entries > 0 ? `Open its ${entries === 1 ? 'credits entry' : `${entries} credits entries`} from the last 7 days` : 'No entries in the last 7 days';
    b.disabled = entries === 0;
    b.addEventListener('click', () => {
      if (open.has(key)) open.delete(key);
      else {
        open.add(key);
        if (!entryCache.has(key)) void loadEntries(key);
      }
      render();
      sheet.root.querySelector<HTMLElement>(`.spend-row[data-key="${CSS.escape(key)}"] .spend-open`)?.focus({ preventScroll: true });
    });
    r.dataset.key = key;
    first.append(b);
    const cell = (cls: string, text: string): HTMLElement => {
      const c = el('div', `spend-cell ${cls}`, text);
      c.setAttribute('role', 'cell');
      return c;
    };
    r.append(first, cell('c-fig', spendFigure(today)), cell('c-fig', spendFigure(week)), cell('c-n', entries ? String(entries) : '·'), last);
    if (!isOpen) return [r];
    // The entries sit in a row of their own: one cell spanning the table, named by the row's button.
    const e = entriesBlock(key, names, byModel);
    const wrap = el('div', 'spend-entries-row');
    wrap.setAttribute('role', 'row');
    e.setAttribute('role', 'cell');
    e.setAttribute('aria-colspan', '5');
    wrap.append(e);
    b.setAttribute('aria-controls', e.id);
    return [r, wrap];
  }

  function spendBlock(v: TreasuryView): HTMLElement {
    const names = namesOf(firms);
    const sec = el('section', 'treasury-spend');
    sec.append(secHead('Spend and balances', `${spendFigure(v.spend.today.total)} today, ${spendFigure(v.spend.week.total)} in the last 7 days`));
    const find = (p: SpendPeriod, id: string | null) => p.firms.find((f) => f.firmId === id);

    // By firm: every firm, with its balance from the books.
    const byFirm = el('div', 'spend-table spend-firms');
    byFirm.setAttribute('role', 'table');
    byFirm.setAttribute('aria-label', 'Spend by firm, and balances');
    const th = (cls: string, text: string): HTMLElement => {
      const c = el('span', `spend-th ${cls}`, text);
      c.setAttribute('role', 'columnheader');
      return c;
    };
    const headRow = (cols: Array<[string, string]>): HTMLElement => {
      const h = el('div', 'spend-head');
      h.setAttribute('role', 'row');
      for (const [cls, text] of cols) h.append(th(cls, text));
      return h;
    };
    byFirm.append(headRow([['c-name', 'By firm, credits'], ['c-fig', 'Today'], ['c-fig', 'Last 7 days'], ['c-n', 'Entries'], ['c-fig', 'Balance']]));
    const ids = firms.length ? firms.map((f) => f.id) : Object.keys(v.balances);
    for (const id of ids) {
      const f = firms.find((x) => x.id === id);
      const bal = v.balances[id] ?? f?.balance ?? 0;
      const balCell = el('div', 'spend-cell c-fig');
      balCell.setAttribute('role', 'cell');
      const a = el('a', `spend-bal${bal < 0 ? ' neg' : ''}${f?.status === 'bankrupt' ? ' gone' : ''}`, figure(bal));
      balCell.append(a);
      a.href = placeHref('firm', id);
      a.title = `${names.firm(id)}’s books`;
      const name = el('span', 'spend-name', names.firm(id));
      if (f?.status === 'bankrupt') name.append(el('span', 'spend-gone', f.bankruptAt ? ` bankrupt ${shortDate(f.bankruptAt)}` : ' bankrupt'));
      byFirm.append(...spendRow(entryKey('firm', id), name, find(v.spend.today, id)?.credits ?? 0, find(v.spend.week, id)?.credits ?? 0, find(v.spend.week, id)?.entries ?? 0, balCell, names, false, { firm: id }));
    }
    const city = find(v.spend.week, null);
    if (city) {
      const blank = el('div', 'spend-cell c-fig');
      blank.setAttribute('role', 'cell');
      byFirm.append(...spendRow(entryKey('firm', CITY), el('span', 'spend-name city', 'The city’s reviews and design checks'), find(v.spend.today, null)?.credits ?? 0, city.credits, city.entries, blank, names, false, { firm: CITY }));
    }
    sec.append(byFirm);

    // By model: what each model cost, and a Claude model's share of a five-hour window today.
    const byModel = el('div', 'spend-table spend-models');
    byModel.setAttribute('role', 'table');
    byModel.setAttribute('aria-label', 'Spend by model');
    byModel.append(headRow([['c-name', 'By model, credits'], ['c-fig', 'Today'], ['c-fig', 'Last 7 days'], ['c-n', 'Entries'], ['c-fig', 'Of a window today']]));
    for (const m of v.spend.week.models) {
      const today = v.spend.today.models.find((x) => x.model === m.model);
      const share = el('div', 'spend-cell c-fig spend-share', today?.windowPct != null ? pctOf(today.windowPct) : m.windowPct === null ? (m.usd > 0 || m.model.startsWith('anthropic:') ? `API $${(today?.usd ?? 0).toFixed(2)}` : 'local') : '·');
      share.setAttribute('role', 'cell');
      const label = el('code', 'spend-model', cleanText(m.model, 60));
      byModel.append(...spendRow(entryKey('model', m.model), label, today?.credits ?? 0, m.credits, m.entries, share, names, true, { model: m.model }));
    }
    sec.append(byModel);
    if (v.spend.week.models.length === 0) sec.append(el('p', 'entries-note', 'No model was called in the last 7 days.'));
    sec.append(el('p', 'jobs-key', 'Bids and runs are charged to the firm whose agent made them; reviews and design checks are the city’s own cost. A credit is a tenth of a percent of a five-hour window. Open a row for the entries that make it up.'));
    return sec;
  }

  // ---------------------------------------------------------------- the report

  function spanNodes(spans: ReportSpan[]): Node[] {
    return spans.map((s) => {
      switch (s.kind) {
        case 'break':
          return el('br');
        case 'strong':
          return el('strong', '', s.text);
        case 'em':
          return el('em', '', s.text);
        case 'code':
          return el('code', 'md-code', s.text);
        case 'link': {
          const href = s.href ? githubUrl(s.href) : null;
          return href ? outLink('md-link', s.text, href) : document.createTextNode(s.text);
        }
        default:
          return document.createTextNode(s.text);
      }
    });
  }

  function blockNode(b: ReportBlock): HTMLElement {
    switch (b.kind) {
      case 'heading': {
        const h = el(b.level === 1 ? 'h3' : 'h4', b.level === 1 ? 'report-h1' : 'report-h2');
        h.append(...spanNodes(b.inline));
        return h;
      }
      case 'list': {
        const l = el('ul', 'report-list');
        for (const item of b.items) {
          const li = el('li');
          li.append(...spanNodes(item));
          l.append(li);
        }
        return l;
      }
      case 'table': {
        const wrap = el('div', 'report-table-wrap');
        const tbl = el('table', 'report-table');
        const thead = el('thead');
        const hr = el('tr');
        b.head.forEach((h, i) => {
          const c = el('th', b.numeric[i] ? 'num' : '', h);
          c.scope = 'col';
          hr.append(c);
        });
        thead.append(hr);
        const tbody = el('tbody');
        for (const row of b.rows) {
          const tr = el('tr');
          // Credits in the report's tables are set as the rest of the screen sets money: two decimals.
          row.forEach((cell, i) => tr.append(el('td', b.numeric[i] ? 'num' : /^[\w.-]+\/[\w.-]+$/.test(cell) ? 'repo' : '', b.numeric[i] && /^[\d,]+(?:\.\d+)?$/.test(cell) ? figure(Number(cell.replace(/,/g, ''))) : cell)));
          tbody.append(tr);
        }
        tbl.append(thead, tbody);
        wrap.append(tbl);
        return wrap;
      }
      default: {
        const p = el('p', 'report-p');
        p.append(...spanNodes(b.inline));
        return p;
      }
    }
  }

  function reportBlock(v: TreasuryView): HTMLElement {
    const sec = el('section', 'treasury-report');
    const days = v.reports.slice(0, DAYS_SHOWN).reverse();
    const shown = day ?? v.reports[0] ?? null;
    const picker = el('div', 'report-days');
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'The day’s report');
    let chosen: HTMLElement | null = null;
    for (const d of days) {
      const lab = dayLabel(d);
      const b = el('button', 'report-day');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.day = d;
      b.append(el('span', 'report-day-w', lab.short), el('span', 'report-day-d', lab.date));
      b.addEventListener('click', () => pickDay(d));
      if (d === shown) chosen = b;
      picker.append(b);
    }
    checkRadio(picker, chosen);
    rovingRadios(picker, (r) => pickDay(r.dataset.day!));
    sec.append(secHead('Daily report', v.reports.length ? picker : 'none yet'));
    const body = el('article', 'report');
    if (!shown) body.append(el('p', 'entries-note', 'The first report is written ten minutes after the first full day ends.'));
    else if (!report || report.day !== shown) body.append(el('p', 'entries-note', 'Reading the report.'));
    else {
      let cur: HTMLElement = body;
      for (const b of reportBlocks(report.markdown)) {
        if (b.kind === 'heading' && b.level === 2) {
          cur = el('section', 'report-sec');
          cur.dataset.sec = b.inline.map((s) => s.text).join('').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          body.append(cur);
        }
        cur.append(blockNode(b));
      }
    }
    sec.append(body);
    return sec;
  }

  function pickDay(d: string): void {
    if (day === d || (!day && t?.reports[0] === d && report?.day === d)) {
      day = d;
      return;
    }
    day = d;
    render();
    void readReport(d);
    requestAnimationFrame(() => sheet.root.querySelector<HTMLElement>(`.report-day[data-day="${d}"]`)?.focus({ preventScroll: true }));
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    if (!sheet.shown || !t) return;
    const v = t;
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    facts.textContent = `What the city may spend of your Claude plan, and what it has spent. ${v.paused ? 'It is not starting Claude work now.' : 'It is free to start work.'}`;
    slots.pause(JSON.stringify([v.paused, v.reading, v.resumedUntil, resuming, resumeError, Math.floor(minute / 10)]), () => pauseBlock(v, now));
    slots.plan(JSON.stringify([v.fiveHour, v.sevenDay, v.night, v.hardStopPct, v.calibration, v.reading, minute]), () => planBlock(v, now));
    slots.now(JSON.stringify([v.concurrency, v.night, v.api, v.keepAwake, v.interactiveActive]), () => nowBlock(v));
    slots.spend(JSON.stringify([v.spend, v.balances, firms.map((f) => [f.id, f.name, f.status]), [...open], [...entryCache.entries()].map(([k, e]) => [k, typeof e === 'string' ? e : e.at])]), () => spendBlock(v));
    slots.report(JSON.stringify([v.reports, day, report?.day, report?.markdown.length]), () => reportBlock(v));
  }

  function empty(): void {
    for (const s of Object.values(slots)) s('', () => null);
    facts.textContent = '';
  }

  return {
    show() {
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // Readings arrive with his Claude Code replies and age by the minute; read again every half minute.
        timer = setInterval(read, 30_000);
      }
      render();
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
      if (timer) clearInterval(timer);
      timer = null;
      open.clear();
      entryCache.clear();
      day = null;
      report = null;
      reportStale = true;
      t = null;
      empty();
    },
  };
}
