/**
 * The school (Phase 4 Task 30): what the city has learned, each claim with
 * its number, its interval and its n, and a plain sentence wherever there is
 * nothing yet. `#/school` opens the ledger: the nets, the master and his
 * kinds of work with their grants, the arenas, the voyages, the graduates
 * and the training. `#/school/<section>` lands on a section (the
 * observatory's dome opens `#/school/master`); `#/school/nets/<net>`,
 * `#/school/voyages/<id>` and `#/school/graduates/<id>` open a page each.
 * Charts are engraved hairline plates, drawn only from two or more points;
 * with fewer, the sentence stands. Updates from the event stream.
 */
import { SEALED_USES } from '../../../shared/school-rules';
import type { Agreement, ArenaInfo, FirmView, Graduate, Grant, Interval, NetCard, NetVersion, TrainState, VoyageView } from '../../../shared/types';
import { api, type EngineEvent, type NetDetail, type SchoolView } from '../api';
import { placeHref, routeHref, SCHOOL_SECTIONS, type Route } from '../router';
import { cleanText } from './board';
import { ago, createSheet, el, plural } from './controls';
import { svgEl } from './firms';
import { coalesce, keyedSlot, namesOf, secHead, setTrail } from './pages';
import {
  agreementLine,
  diffText,
  downloadLine,
  fixed,
  gateLine,
  grantLine,
  intervalText,
  kindLabel,
  loraLine,
  NET_BIAS,
  NET_LABEL,
  NET_LEARNS,
  netLine,
  SCORE_KEY,
  untrainedWhen,
  sealedLine,
  signed,
  STATUS_WORD,
  trainerLine,
  trainLine,
  voyageLine,
} from './school-words';
import { longDate, shortDate } from './story';
import './market.css';

export type SchoolRoute = Extract<Route, 'school' | 'net' | 'voyage' | 'graduate'>;

export interface SchoolScreen {
  show(route: SchoolRoute, id: string | null): void;
  hide(): void;
}

const SECTION_TITLE: Record<(typeof SCHOOL_SECTIONS)[number], string> = {
  nets: 'The nets',
  master: 'The master',
  arenas: 'Arenas',
  voyages: 'Voyages',
  graduates: 'Graduates',
  training: 'Training',
};

const hm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const when = (iso: string): string => `${shortDate(iso)} ${hm(iso)}`;
const repoShort = (full: string): string => cleanText(full.split('/')[1] ?? full, 60);
/** Seconds as a clerk would note them: "41 s", "12 min", "2 h 10 min". */
function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- the engraved plates

/**
 * An interval on a ruled scale, as a draughtsman marks a tolerance: the
 * score's interval as a bronze segment with its value as a pointer above,
 * a reference interval (the baseline) beneath it in faint ink with its own
 * mark, and, when given, a dashed bronze mark at a threshold.
 */
function ciplate(score: Interval, ref: Interval | null, scale: { min: number; max: number }, opts: { mark?: number; label: string; width?: number } = { label: '' }): SVGSVGElement {
  const w = opts.width ?? 150;
  const svg = svgEl('svg', { width: w + 2, height: 20, viewBox: `-1 0 ${w + 2} 20`, role: 'img', 'aria-label': opts.label }, 'ciplate');
  const x = (v: number): number => r1(((Math.max(scale.min, Math.min(scale.max, v)) - scale.min) / (scale.max - scale.min)) * w);
  const y = 12.5;
  svg.append(svgEl('line', { x1: 0, y1: y, x2: w, y2: y }, 'ciplate-rule'));
  for (let i = 0; i <= 4; i++) {
    const tx = Math.round((w * i) / 4) + 0.5 - (i === 4 ? 1 : 0);
    svg.append(svgEl('line', { x1: tx, y1: y, x2: tx, y2: y + (i % 2 === 0 ? 4 : 2.5) }, 'ciplate-tick'));
  }
  if (opts.mark !== undefined) {
    const mx = x(opts.mark) + 0.5;
    svg.append(svgEl('line', { x1: mx, y1: 2, x2: mx, y2: 18 }, 'ciplate-mark'));
  }
  if (ref) {
    svg.append(svgEl('line', { x1: x(ref.lo), y1: y + 4.5, x2: Math.max(x(ref.hi), x(ref.lo) + 1), y2: y + 4.5 }, 'ciplate-ref'));
    svg.append(svgEl('line', { x1: x(ref.value) + 0.5, y1: y + 2.5, x2: x(ref.value) + 0.5, y2: y + 6.5 }, 'ciplate-ref-mark'));
  }
  const lo = x(score.lo);
  const hi = Math.max(x(score.hi), lo + 1);
  svg.append(svgEl('line', { x1: lo, y1: y, x2: hi, y2: y }, 'ciplate-ci'));
  svg.append(svgEl('path', { d: `M${lo + 0.5} ${y - 3}V${y + 3}M${hi - 0.5} ${y - 3}V${y + 3}` }, 'ciplate-cap'));
  const vx = x(score.value);
  svg.append(svgEl('path', { d: `M${vx - 3} 3H${vx + 3}L${vx} 9Z` }, 'ciplate-pointer'));
  return svg;
}

/** The scale a net's plate is ruled on: from zero to the first tenth above both intervals, never under 0.3. */
function netScale(v: Pick<NetVersion, 'score' | 'baseline'>): { min: number; max: number } {
  const top = Math.max(v.score.hi, v.baseline.hi, 0.25);
  return { min: 0, max: Math.ceil(top * 10 + 1e-9) / 10 };
}

/**
 * A net's versions as a plate: each version a point with its interval as a
 * whisker, the line through the values in bronze, the baseline ruled across
 * in faint dashes, the scale at the left. Drawn only from two or more
 * versions; the caller says so otherwise.
 */
function netplot(versions: Array<Omit<NetVersion, 'path'>>, metric: NetVersion['metric']): SVGSVGElement {
  const vs = [...versions].sort((a, b) => a.version - b.version);
  const W = 640;
  const H = 150;
  const L = 40;
  const top = Math.max(...vs.map((v) => Math.max(v.score.hi, v.baseline.hi)), 0.2);
  const ymax = Math.ceil(top * 10 + 1e-9) / 10;
  const x = (i: number): number => r1(L + ((i + 0.5) / vs.length) * (W - L));
  const y = (v: number): number => r1(10 + (1 - Math.max(0, Math.min(ymax, v)) / ymax) * H);
  const word = metric === 'mae' ? 'error' : 'Brier';
  const first = vs[0];
  const last = vs.at(-1)!;
  const svg = svgEl('svg', { viewBox: `0 0 ${W + 12} ${H + 44}`, role: 'img', preserveAspectRatio: 'xMinYMid meet', 'aria-label': `${word} by version, from ${fixed(first.score.value)} at v${first.version} to ${fixed(last.score.value)} at v${last.version}, each with its 95% interval, against the baseline` }, 'netplot');
  // The scale: a hairline every tenth (every twentieth under 0.3), its figure at the left.
  const step = ymax <= 0.3 ? 0.05 : 0.1;
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    const gy = y(v) + 0.5;
    svg.append(svgEl('line', { x1: L, y1: gy, x2: W, y2: gy }, v === 0 ? 'netplot-rule' : 'netplot-grid'));
    const t = svgEl('text', { x: L - 8, y: gy + 3.5, 'text-anchor': 'end' }, 'netplot-axis');
    t.textContent = fixed(v);
    svg.append(t);
  }
  // The baseline each version was measured against, stepped across the field.
  let d = '';
  vs.forEach((v, i) => {
    const bx = x(i);
    d += `${i === 0 ? 'M' : 'L'}${bx} ${y(v.baseline.value)}`;
  });
  svg.append(svgEl('path', { d }, 'netplot-base'));
  // The scores: the line through them, then each version's whisker and point.
  svg.append(svgEl('path', { d: vs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v.score.value)}`).join('') }, 'netplot-line'));
  vs.forEach((v, i) => {
    const px = x(i);
    svg.append(svgEl('path', { d: `M${px} ${y(v.score.lo)}V${y(v.score.hi)}M${px - 3} ${y(v.score.lo)}H${px + 3}M${px - 3} ${y(v.score.hi)}H${px + 3}` }, 'netplot-whisker'));
    svg.append(svgEl('circle', { cx: px, cy: y(v.score.value), r: 2.8 }, `netplot-point${v.trusted ? ' trusted' : ''}${v.current ? ' current' : ''}`));
    const t = svgEl('text', { x: px, y: H + 26, 'text-anchor': 'middle' }, `netplot-tick-label${v.current ? ' current' : ''}`);
    t.textContent = `v${v.version}`;
    svg.append(t);
  });
  const dates = svgEl('text', { x: L, y: H + 40 }, 'netplot-axis');
  dates.textContent = `${shortDate(first.at)} to ${shortDate(last.at)}`;
  svg.append(dates);
  const key = svgEl('text', { x: W, y: H + 40, 'text-anchor': 'end' }, 'netplot-axis');
  key.textContent = `${word} with its 95% interval; the baseline dashed`;
  svg.append(key);
  return svg;
}

/** The best kept genome of each scored generation, as a plate like a net's; drawn only from two or more. */
function genplot(v: VoyageView): SVGSVGElement {
  const gens: Array<{ g: number; best: VoyageView['scores'][number] }> = [];
  for (let g = 1; g <= v.of; g++) {
    const scored = v.scores.filter((s) => s.generation === g && s.scored !== false);
    if (!scored.length) continue;
    gens.push({ g, best: scored.reduce((a, b) => (b.mean > a.mean ? b : a)) });
  }
  const W = 640;
  const H = 120;
  const L = 40;
  const x = (i: number): number => r1(L + ((i + 0.5) / gens.length) * (W - L));
  const y = (val: number): number => r1(10 + (1 - Math.max(0, Math.min(1, val))) * H);
  const svg = svgEl('svg', { viewBox: `0 0 ${W + 12} ${H + 44}`, role: 'img', preserveAspectRatio: 'xMinYMid meet', 'aria-label': `The best genome of each generation, from ${fixed(gens[0].best.mean)} to ${fixed(gens.at(-1)!.best.mean)}, each with its 95% interval` }, 'genplot netplot');
  for (let val = 0; val <= 1.0001; val += 0.25) {
    const gy = y(val) + 0.5;
    svg.append(svgEl('line', { x1: L, y1: gy, x2: W, y2: gy }, val === 0 ? 'netplot-rule' : 'netplot-grid'));
    const t = svgEl('text', { x: L - 8, y: gy + 3.5, 'text-anchor': 'end' }, 'netplot-axis');
    t.textContent = fixed(val);
    svg.append(t);
  }
  svg.append(svgEl('path', { d: gens.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(p.best.mean)}`).join('') }, 'netplot-line'));
  gens.forEach((p, i) => {
    const px = x(i);
    svg.append(svgEl('path', { d: `M${px} ${y(p.best.lo)}V${y(p.best.hi)}M${px - 3} ${y(p.best.lo)}H${px + 3}M${px - 3} ${y(p.best.hi)}H${px + 3}` }, 'netplot-whisker'));
    svg.append(svgEl('circle', { cx: px, cy: y(p.best.mean), r: 2.8 }, 'genplot-point netplot-point trusted'));
    const t = svgEl('text', { x: px, y: H + 26, 'text-anchor': 'middle' }, 'netplot-tick-label');
    t.textContent = p.g === 1 ? 'seeded' : `gen ${p.g}`;
    svg.append(t);
    const n = svgEl('text', { x: px, y: H + 40, 'text-anchor': 'middle' }, 'netplot-axis');
    n.textContent = cleanText(p.best.name, 24);
    svg.append(n);
  });
  return svg;
}

// ---------------------------------------------------------------- the screen

/**
 * The school's sheet: the ledger of sections at `#/school`, or a net's, a
 * voyage's or a graduate's page, under one title. The campus inspector and
 * the city's school state are the main module's; this reads the school whole.
 */
export function createSchool(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): SchoolScreen {
  const sheet = createSheet(parent, 'school', 'School', opts.onDismiss);
  const head = sheet.root.querySelector<HTMLElement>('.sheet-head')!;
  const title = head.querySelector<HTMLElement>('.sheet-title')!;
  const trail = el('nav', 'detail-trail');
  trail.setAttribute('aria-label', 'Where this is');
  trail.hidden = true;
  head.insertBefore(trail, title);
  const sub = el('p', 'detail-sub school-sub');
  head.append(sub);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  sheet.body.append(trouble);
  const slots = {
    nets: keyedSlot(sheet.body),
    master: keyedSlot(sheet.body),
    arenas: keyedSlot(sheet.body),
    voyages: keyedSlot(sheet.body),
    graduates: keyedSlot(sheet.body),
    training: keyedSlot(sheet.body),
    page: keyedSlot(sheet.body),
  };

  let route: SchoolRoute = 'school';
  let id: string | null = null;
  let view: SchoolView | null = null;
  let firms: FirmView[] = [];
  let net: NetDetail | null = null;
  let netWanted: string | null = null;
  let scrollTo: string | null = null;
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = coalesce(async () => {
    const wantRoute = route;
    const wantId = id;
    try {
      const [v, fs] = await Promise.all([api.school(), api.firms().catch(() => firms)]);
      view = v;
      firms = fs;
      trouble.hidden = true;
      if (wantRoute === 'net' && wantId) {
        netWanted = wantId;
        try {
          const d = await api.net(wantId as NetDetail['net']);
          if (netWanted === wantId) net = d;
        } catch (err) {
          if (netWanted === wantId) {
            net = null;
            trouble.textContent = err instanceof Error && /unknown net/.test(err.message) ? 'There is no such net.' : `The engine did not answer for the net. ${err instanceof Error ? err.message : String(err)}`;
            trouble.hidden = false;
          }
        }
      }
    } catch (err) {
      trouble.textContent = `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected') return read();
    if (/^(train\.|net\.|voyage\.|graduate\.|arena\.|autonomy\.|settings\.|agent\.|firm\.)/.test(e.type)) read();
  }

  // ---------------------------------------------------------------- shared rows

  const names = () => namesOf(firms);

  function table(cls: string, label: string, cols: Array<[string, string]>): HTMLElement {
    const t = el('div', `school-table ${cls}`);
    t.setAttribute('role', 'table');
    t.setAttribute('aria-label', label);
    const h = el('div', 'school-head');
    h.setAttribute('role', 'row');
    for (const [c, text] of cols) {
      const th = el('span', `school-th ${c}`, text);
      th.setAttribute('role', 'columnheader');
      h.append(th);
    }
    t.append(h);
    return t;
  }

  function cell(cls: string, ...nodes: Array<Node | string>): HTMLElement {
    const c = el('div', `school-cell ${cls}`);
    c.setAttribute('role', 'cell');
    c.append(...nodes);
    return c;
  }

  function row(cls: string, data: Record<string, string>): HTMLElement {
    const r = el('div', `school-row ${cls}`);
    r.setAttribute('role', 'row');
    Object.assign(r.dataset, data);
    return r;
  }

  /** What stands in an empty section: one sentence saying why, never a blank. */
  const empty = (text: string): HTMLElement => el('p', 'school-empty', text);

  /** A score with its interval and n, as a cell: the figure, then the interval small beneath. */
  function scoreCell(cls: string, i: Interval, metric: NetVersion['metric']): HTMLElement {
    const c = cell(cls);
    c.append(el('span', 'net-score', `${metric === 'mae' ? 'Error' : 'Brier'} ${fixed(i.value)}`), el('span', 'net-ci', `${fixed(i.lo)} to ${fixed(i.hi)}, ${i.n} rows`));
    return c;
  }

  // ---------------------------------------------------------------- the nets

  function netsSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'nets';
    sec.id = 'school-nets';
    const trusted = v.nets.filter((n) => n.status === 'trusted').length;
    sec.append(secHead('The nets', trusted ? `${trusted} of ${v.nets.length} trusted` : 'none trusted yet'));
    const t = table('net-ledger', 'The nets', [
      ['c-name', 'Net'],
      ['c-score', 'Score, held out'],
      ['c-plate', 'Against its baseline'],
      ['c-n', 'Labels'],
    ]);
    for (const n of v.nets) t.append(netRow(n, v));
    sec.append(t);
    // What the scores mean, said before the ledger that shows them, so the first number read is not jargon.
    t.before(el('p', 'jobs-key school-score-key', SCORE_KEY));
    return sec;
  }

  function netRow(n: NetCard, v: SchoolView): HTMLElement {
    const r = row('net-row', { net: n.net, status: n.status });
    const name = cell('c-name');
    const a = el('a', 'net-name', NET_LABEL[n.net] ?? n.net);
    a.href = placeHref('net', n.net);
    const line = el('div', 'net-name-line');
    line.append(a, el('span', `net-status s-${n.status}`, STATUS_WORD[n.status]));
    name.append(line, el('p', 'net-learns', `Learns ${NET_LEARNS[n.net] ?? ''}.`), el('p', 'net-line', untrainedWhen(n, v.settings, v.gate.light)));
    if (n.selfSelected) name.append(el('p', 'net-self', 'Partly self-selected: since the appraiser began moving awards, its rows are the bids it chose.'));
    const bias = NET_BIAS[n.net];
    if (bias) name.append(el('p', 'net-self net-bias', bias));
    r.append(name);
    const cur = n.current;
    if (cur) {
      r.append(scoreCell('c-score', cur.score, cur.metric));
      const plate = cell('c-plate', ciplate(cur.score, cur.baseline, netScale(cur), { label: `${intervalText(cur.score, cur.metric)}; baseline ${fixed(cur.baseline.value)}, ${fixed(cur.baseline.lo)} to ${fixed(cur.baseline.hi)}` }));
      plate.append(el('span', 'net-base', `baseline ${fixed(cur.baseline.value)}; ${cur.vsBaseline.hi < 0 ? `${fixed(Math.abs(cur.vsBaseline.diff))} better` : 'not clearly better'}`));
      r.append(plate);
    } else {
      r.append(cell('c-score', el('span', 'net-none', n.status === 'thin' ? 'no score: thin' : 'no score yet')), cell('c-plate'));
    }
    const labels = cell('c-n', String(n.labels));
    labels.title = `${plural(n.labels, 'label')}; ${n.needs} needed to train`;
    r.append(labels);
    return r;
  }

  // ---------------------------------------------------------------- the master

  function masterSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'master';
    sec.id = 'school-master';
    const m = v.nets.find((n) => n.net === 'master');
    const cur = m?.current ?? null;
    sec.append(secHead('The master', m ? (cur ? `v${cur.version}, ${m.status === 'trusted' ? 'trusted' : 'not trusted'}` : STATUS_WORD[m.status]) : undefined));
    const card = el('div', 'master-card');
    if (m && cur) {
      const fig = el('div', 'master-fig');
      fig.append(el('span', 'master-name', `Brier, v${cur.version}`), el('span', 'master-num net-score', fixed(cur.score.value)), el('span', 'master-note', `against a baseline of ${fixed(cur.baseline.value)}`));
      const words = el('div', 'master-words');
      words.append(el('p', 'master-line', netLine(m)));
      if (cur.agreement) words.append(el('p', 'master-line', `${intervalText(cur.agreement, 'agreement')}: how often its call at even odds matched yours, reported beside its Brier, never instead.`));
      words.append(el('p', 'master-key', 'The master predicts what you will decide before you do, and is scored only against what you then did; the city’s own acts never count. Trusted, it lets the school offer you autonomy, one kind of work on one repo at a time.'));
      card.append(fig, words);
    } else if (m) {
      const words = el('div', 'master-words wide');
      words.append(el('p', 'master-line', m.status === 'thin' ? `The master is thin: ${netLine(m)}` : `The master is ${STATUS_WORD[m.status]}. ${netLine(m)}`));
      words.append(el('p', 'master-key', 'The master predicts what you will decide before you do, and is scored only against what you then did. Until it is trusted, no kind of work is offered for autonomy.'));
      card.append(words);
    } else card.append(el('p', 'master-line', 'The engine listed no master.'));
    sec.append(card);

    // His kinds of work: how often the master agreed with him on each, and whether that is enough.
    const kinds = table('kinds', 'Agreement by kind of work', [
      ['c-name', 'Kind of work'],
      ['c-plate', 'Agreement, against 95%'],
      ['c-n', 'Agreed'],
    ]);
    for (const a of v.agreements) kinds.append(kindRow(a));
    sec.append(kinds);

    // Autonomy: every pair asked, granted, suspended, taken back or declined, in the engine's own words.
    const grants = el('div', 'grants');
    grants.append(el('h3', 'school-h3', 'Autonomy'));
    if (v.grants.length === 0) {
      const trusted = m?.status === 'trusted';
      grants.append(empty(trusted ? 'No autonomy has been asked for yet: no kind of work has reached 50 agreed decisions at 95% on a repo with a test command.' : 'No autonomy has been asked for yet. The school asks only once the master is trusted and has agreed with you on 50 decisions of a kind at 95%.'));
    } else {
      const t = table('grant-ledger', 'Autonomy by kind and repo', [
        ['c-name', 'Kind of work, repo'],
        ['c-state', 'State'],
      ]);
      for (const g of v.grants) t.append(grantRow(g));
      grants.append(t);
    }
    sec.append(grants);
    sec.append(el('p', 'jobs-key', 'Autonomy is offered one kind of work on one repo at a time, after the master has agreed with you on 50 of that kind at 95%, the last ten on that repo too, and the repo has a test command. The city then acts only where the master is at least 90% sure, and the grant is suspended as soon as the agreement falls short, or taken back by your revert.'));
    return sec;
  }

  function kindRow(a: Agreement): HTMLElement {
    const r = row('kind-row', { kind: a.kind });
    const name = cell('c-name');
    name.append(el('span', 'kind-name', kindLabel(a.kind)), el('p', 'kind-line', agreementLine(a)));
    r.append(name);
    if (a.rate && !a.skewed) r.append(cell('c-plate', ciplate(a.rate, null, { min: 0, max: 1 }, { mark: 0.95, label: `${intervalText(a.rate, 'agreement')}; the mark at 0.95` })));
    else r.append(cell('c-plate'));
    r.append(cell('c-n', a.rows ? `${a.agreed} of ${a.rows}` : '·'));
    return r;
  }

  const GRANT_STATE: Record<Grant['state'], string> = { asked: 'asked', granted: 'granted', suspended: 'suspended', revoked: 'taken back', declined: 'declined' };

  function grantRow(g: Grant): HTMLElement {
    const r = row('grant-row', { kind: g.kind, repo: g.repo, state: g.state });
    const name = cell('c-name');
    const line = el('div', 'grant-name-line');
    const repo = el('a', 'grant-repo', cleanText(g.repo, 80));
    repo.href = placeHref('repo', g.repo);
    line.append(el('span', 'kind-name', kindLabel(g.kind)), el('span', 'grant-on', ' on '), repo);
    name.append(line, el('p', 'grant-line', grantLine(g)));
    r.append(name, cell('c-state', el('span', `grant-state g-${g.state}`, GRANT_STATE[g.state])));
    return r;
  }

  // ---------------------------------------------------------------- arenas

  const ARENA_KIND: Record<ArenaInfo['kind'], string> = { planted: 'planted bugs', past: 'past changes' };
  const ARENA_STATUS: Record<ArenaInfo['status'], string> = { building: 'building', paused: 'paused', ready: 'ready', failed: 'failed', spent: 'spent' };

  function arenasSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'arenas';
    sec.id = 'school-arenas';
    sec.append(secHead('Arenas', v.arenas.length ? plural(v.arenas.length, 'arena') : 'none'));
    if (v.arenas.length === 0) sec.append(empty('No arena. An arena is built only on your click, on the district page of a repo with the market on and a test command; none has been asked for.'));
    else {
      const t = table('arena-ledger', 'The arenas', [
        ['c-name', 'Arena'],
        ['c-state', 'State'],
      ]);
      for (const a of v.arenas) t.append(arenaRow(a));
      sec.append(t);
    }
    if (v.arenaRefusals.length) {
      const list = el('ul', 'arena-refusals');
      for (const r of v.arenaRefusals) {
        const li = el('li', 'arena-refusal');
        li.append(el('span', 'refusal-when', `Refused ${ago(Date.parse(r.at))}: `), el('span', 'refusal-what', `an arena of ${ARENA_KIND[r.kind] ?? r.kind} on ${cleanText(r.repo, 80)}. `), el('span', 'refusal-why', /[.!?]$/.test(r.reason) ? r.reason : `${r.reason}.`));
        list.append(li);
      }
      sec.append(list);
    }
    sec.append(el('p', 'jobs-key', `An arena is a set of tasks cut from one of your repos: bugs planted in it, or changes it has already seen. Each is checked by running the repo’s own suite in the sandbox. Its sealed tasks are kept for claims alone and may be used ${SEALED_USES} times before they are spent.`));
    return sec;
  }

  function arenaRow(a: ArenaInfo): HTMLElement {
    const r = row('arena-row', { arena: a.id, status: a.status });
    const name = cell('c-name');
    const line = el('div', 'grant-name-line');
    const repo = el('a', 'grant-repo', cleanText(a.repo, 80));
    repo.href = placeHref('repo', a.repo);
    line.append(repo, el('span', 'arena-kind', `, ${ARENA_KIND[a.kind] ?? a.kind}`));
    const t = a.tasks;
    name.append(line, el('p', 'arena-line', `${t.breeding} breeding, ${t.race} race and ${t.sealed} sealed tasks; ${a.kept} of ${plural(a.candidates, 'candidate')} kept; ${sealedLine(a)}.`));
    name.append(el('p', 'arena-when', `Built ${longDate(a.builtAt)} at ${cleanText(a.sha, 12).slice(0, 7)}.`));
    r.append(name);
    const state = cell('c-state', el('span', `grant-state g-${a.status}`, ARENA_STATUS[a.status] ?? a.status));
    if (a.reason) state.append(el('span', 'arena-reason', a.reason));
    r.append(state);
    return r;
  }

  // ---------------------------------------------------------------- voyages

  const voyageName = (v: VoyageView): string => `Voyage on ${repoShort(v.repo ?? v.arena)}`;

  function voyagesSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'voyages';
    sec.id = 'school-voyages';
    const sailing = v.voyages.filter((x) => x.status === 'sailing').length;
    sec.append(secHead('Voyages', v.voyages.length ? `${plural(v.voyages.length, 'voyage')}${sailing ? `, ${sailing} sailing` : ''}` : 'none'));
    if (v.voyages.length === 0) sec.append(empty(v.arenas.length ? 'No voyage has sailed. The school sails one on an arena on its next night that the gate allows, or a firm commissions one.' : 'No voyage has sailed. A voyage breeds agents on an arena, and there is no arena yet.'));
    else {
      const t = table('voyage-ledger', 'The voyages', [
        ['c-name', 'Voyage'],
        ['c-when', 'Sailed'],
      ]);
      for (const x of [...v.voyages].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) t.append(voyageRow(x));
      sec.append(t);
    }
    sec.append(el('p', 'jobs-key', 'A voyage breeds agents on an arena through Beagle: the seeded local agents first, then eight children a generation, each raced on the arena’s tasks. Its champion claims only what it beat on the sealed tasks, and only local models race; Claude agents are never compared.'));
    return sec;
  }

  function voyageRow(v: VoyageView): HTMLElement {
    const r = row('voyage-row', { voyage: v.id, status: v.queued ? 'queued' : v.status });
    const name = cell('c-name');
    const a = el('a', 'voyage-name', voyageName(v));
    a.href = placeHref('voyage', v.id);
    const line = el('div', 'net-name-line');
    line.append(a);
    if (v.commissionedBy) line.append(el('span', 'voyage-by', `commissioned by ${names().firm(v.commissionedBy)}`));
    name.append(line, el('p', 'voyage-line', voyageLine(v)));
    r.append(name);
    const whenCell = cell('c-when');
    whenCell.append(el('span', 'voyage-when', v.queued ? 'not yet' : shortDate(v.startedAt)));
    if (v.endedAt) whenCell.append(el('span', 'voyage-when-note', `to ${shortDate(v.endedAt)}`));
    else if (!v.queued) whenCell.append(el('span', 'voyage-when-note', `${v.runs.done} of ${v.runs.of} runs`));
    r.append(whenCell);
    return r;
  }

  // ---------------------------------------------------------------- graduates

  function graduateName(g: Graduate): string {
    return g.agentId ? names().agent(g.agentId) : cleanText(g.id, 40);
  }
  function hiredBy(g: Graduate): string | null {
    if (!g.agentId) return null;
    const f = firms.find((x) => x.agents.some((a) => a.id === g.agentId));
    return f ? cleanText(f.name, 80) : null;
  }

  function graduatesSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'graduates';
    sec.id = 'school-graduates';
    sec.append(secHead('Graduates', v.graduates.length ? plural(v.graduates.length, 'graduate') : 'none'));
    const lora = el('div', 'lora-card');
    lora.append(el('p', 'lora-line', loraLine(v.lora)), el('p', 'lora-base', downloadLine(v.lora, cleanText(v.settings.baseModel, 60))));
    sec.append(lora);
    if (v.graduates.length === 0) sec.append(empty('No LoRA has graduated. One trains once 100 verified changes are in and the base model is downloaded, and graduates only by beating its base on a sealed race.'));
    else {
      const t = table('graduate-ledger', 'The graduates', [
        ['c-name', 'Graduate'],
        ['c-when', 'Graduated'],
      ]);
      for (const g of v.graduates) t.append(graduateRow(g));
      sec.append(t);
    }
    sec.append(el('p', 'jobs-key', 'A graduate is a LoRA on the base model, trained from changes that survived in your repos, that beat its base on a sealed race. It joins the roster as an agent on the local backend, and a firm may hire it.'));
    return sec;
  }

  function graduateRow(g: Graduate): HTMLElement {
    const r = row('graduate-row', { graduate: g.id });
    const name = cell('c-name');
    const a = el('a', 'voyage-name', graduateName(g));
    a.href = placeHref('graduate', g.id);
    const line = el('div', 'net-name-line');
    line.append(a);
    const firm = hiredBy(g);
    line.append(el('span', 'voyage-by', firm ? `hired by ${firm}` : 'on the roster, not yet hired'));
    name.append(line);
    name.append(el('p', 'graduate-diff', `Beat its base by ${diffText(g.vsBase)} on the sealed race.`));
    name.append(el('p', 'graduate-sealed-line', `${intervalText(g.sealed, 'sealed')}, against the base’s ${fixed(g.baseSealed.value)}; from ${plural(g.examples, 'verified example')}.`));
    r.append(name, cell('c-when', shortDate(g.at)));
    return r;
  }

  // ---------------------------------------------------------------- training

  function trainingSection(v: SchoolView): HTMLElement {
    const sec = el('section', 'school-sec');
    sec.dataset.sec = 'training';
    sec.id = 'school-training';
    const running = v.trains.filter((t) => t.status === 'running').length;
    sec.append(secHead('Training', running ? `${plural(running, 'train')} running` : v.settings.enabled ? 'nothing running' : 'the school is off'));
    const gate = el('div', 'gate-card');
    if (!v.settings.enabled) {
      const off = el('p', 'gate-off');
      off.append(document.createTextNode('The school is off: nothing trains, no voyage sails and the master makes no prediction. '));
      const a = el('a', 'gate-settings', 'Turn it on in Settings');
      a.href = routeHref('settings');
      off.append(a, document.createTextNode('.'));
      gate.append(off);
    }
    const gateRow = (cls: string, g: SchoolView['gate']['heavy'], scope: string): HTMLElement => {
      const r = el('div', 'gate-row');
      r.append(el('p', `gate-line${cls}`, gateLine(g, v.settings.window)), el('span', 'gate-scope', scope));
      return r;
    };
    gate.append(gateRow('', v.gate.heavy, 'the LoRA, arenas and voyages'));
    if (v.gate.light.ok !== v.gate.heavy.ok || v.gate.light.reason !== v.gate.heavy.reason) gate.append(gateRow(' light', v.gate.light, 'the nets'));
    gate.append(el('p', 'trainer-line', trainerLine(v.trainer)));
    const w = v.settings.window;
    gate.append(el('p', 'gate-settings-line', `Window ${w.from} to ${w.to}, after ${plural(v.settings.idleMinutes, 'minute')} idle, on power${v.settings.allowLowPower ? ', Low Power allowed' : ''}; ${v.settings.claudeCreditsPerDay} Claude credits a day for the school’s own asks.`));
    sec.append(gate);
    if (v.trains.length === 0) sec.append(empty(v.settings.enabled ? 'No train has run yet. The nets train on the school’s next night that the gate allows, once one has enough labels.' : 'No train has run yet; none will while the school is off.'));
    else {
      const t = table('train-ledger', 'Recent trains', [
        ['c-name', 'Train'],
        ['c-when', 'Started'],
        ['c-fig', 'Credits'],
      ]);
      for (const x of v.trains) t.append(trainRow(x));
      sec.append(t);
    }
    sec.append(el('p', 'jobs-key', 'Training runs in its own sandbox only when the gate holds: on power, idle, inside the window, cool, with disk, and no local job waiting. It yields to real work and resumes from its last checkpoint; a LoRA that pauses loses the steps since, and its optimizer starts afresh.'));
    return sec;
  }

  function trainRow(t: TrainState): HTMLElement {
    const r = row('train-row', { train: t.id, kind: t.kind, status: t.status });
    const name = cell('c-name');
    name.append(el('p', 'train-line', trainLine(t)));
    r.append(name);
    const w = cell('c-when');
    w.append(el('span', 'voyage-when', when(t.startedAt)), el('span', 'voyage-when-note', t.endedAt ? duration(t.seconds) : t.status === 'running' ? 'running' : duration(t.seconds)));
    r.append(w, cell('c-fig', t.credits ? t.credits.toFixed(2) : '·'));
    return r;
  }

  // ---------------------------------------------------------------- a net's page

  function netPage(d: NetDetail): HTMLElement {
    const page = el('div', 'school-page net-page');
    const sec = el('section', 'school-sec');
    sec.append(secHead('Versions', d.history.length ? plural(d.history.length, 'version') : 'none'));
    const versions = d.versions ?? [];
    if (versions.length >= 2) sec.append(netplot(versions, versions[0].metric));
    else sec.append(el('p', 'netplot-none', versions.length === 1 ? 'One version so far; a plate needs two.' : d.status === 'thin' ? `Not trained yet: ${netLine(d)}` : 'Not trained yet.'));
    if (versions.length) {
      const t = table('version-ledger', 'Every version', [
        ['c-v', 'Version'],
        ['c-score', 'Score, held out'],
        ['c-plate', 'Against its baseline'],
        ['c-rows', 'Rows'],
      ]);
      for (const v of [...versions].sort((a, b) => b.version - a.version)) {
        const r = row('version-row', { version: String(v.version), trusted: String(v.trusted) });
        const vc = cell('c-v');
        vc.append(el('span', 'version-num', `v${v.version}`), el('span', 'version-when', `${shortDate(v.at)} ${hm(v.at)}${v.current ? ', current' : ''}`), el('span', `version-trust ${v.trusted ? 'yes' : 'no'}`, v.trusted ? 'trusted' : 'not trusted'));
        r.append(vc, scoreCell('c-score', v.score, v.metric));
        const plate = cell('c-plate', ciplate(v.score, v.baseline, netScale(v), { label: `${intervalText(v.score, v.metric)}; baseline ${fixed(v.baseline.value)}` }));
        plate.append(el('span', 'net-base', `baseline ${fixed(v.baseline.value)}; difference ${signed(v.vsBaseline.diff)}, ${signed(v.vsBaseline.lo)} to ${signed(v.vsBaseline.hi)}`));
        r.append(plate);
        r.append(cell('c-rows', el('span', 'version-rows', `${v.rows.train} train, ${v.rows.heldOut} held out${v.rows.distilled ? `, ${v.rows.distilled} distilled` : ''}`), el('span', 'version-secs', `${duration(v.seconds)} to train`)));
        t.append(r);
      }
      sec.append(t);
    }
    page.append(sec);
    if (d.net === 'master' && d.current?.agreement) {
      const ag = el('section', 'school-sec');
      ag.append(secHead('Agreement'));
      ag.append(el('p', 'master-line', `${intervalText(d.current.agreement, 'agreement')}, reported beside its Brier, never instead.`));
      page.append(ag);
    }
    return page;
  }

  // ---------------------------------------------------------------- a voyage's page

  function voyagePage(v: VoyageView, arena: ArenaInfo | null): HTMLElement {
    const page = el('div', 'school-page voyage-page');
    const n = names();
    const gens = el('section', 'school-sec');
    const scoredGens = new Set(v.scores.filter((s) => s.scored !== false).map((s) => s.generation)).size;
    gens.append(secHead('Generations', v.queued ? 'none yet' : `${v.generation} of ${v.of}`));
    if (scoredGens >= 2) gens.append(genplot(v));
    else if (!v.queued) gens.append(el('p', 'netplot-none', scoredGens === 1 ? 'One generation scored so far; a plate needs two.' : 'No generation has been scored yet.'));
    if (v.scores.length === 0) gens.append(empty(v.queued ? `${voyageLine(v)} Its first generation is the seeded local agents.` : 'No genome has raced yet.'));
    for (let g = 1; g <= Math.max(v.of, v.generation); g++) {
      const rows = v.scores.filter((s) => s.generation === g);
      if (!rows.length) continue;
      const box = el('div', 'voyage-gen');
      box.dataset.generation = String(g);
      box.append(el('h3', 'school-h3', g === 1 ? 'Generation 1, the seeded local agents' : `Generation ${g}, ${rows.length} ${rows.length === 1 ? 'child' : 'children'} bred`));
      const t = table('genome-ledger', `Generation ${g}`, [
        ['c-name', 'Genome'],
        ['c-score', 'Mean score, 95% interval'],
      ]);
      for (const s of [...rows].sort((a, b) => b.mean - a.mean)) {
        const r = row('genome-row', { genome: s.genome, scored: String(s.scored !== false) });
        const name = cell('c-name');
        name.append(el('span', 'genome-name', cleanText(s.name, 60)));
        if (s.parents.length) name.append(el('span', 'genome-parents', ` bred from ${s.parents.map((p) => cleanText(v.scores.find((x) => x.genome === p)?.name ?? n.agent(p), 40)).join(' and ')}`));
        const promoted = v.promoted.find((p) => p.child === s.genome);
        if (promoted) name.append(el('p', 'genome-promoted', `Beat its parent by ${diffText(promoted)}; kept.`));
        r.append(name);
        if (s.scored === false) r.append(cell('c-score', el('span', 'net-none', 'racing now')));
        else {
          const c = cell('c-score');
          c.append(el('span', 'net-score', fixed(s.mean)), el('span', 'net-ci', `${fixed(s.lo)} to ${fixed(s.hi)}`));
          r.append(c);
        }
        t.append(r);
      }
      box.append(t);
      gens.append(box);
    }
    page.append(gens);

    const champ = el('section', 'school-sec voyage-champion-sec');
    champ.append(secHead('Champion', v.champion ? cleanText(v.champion.name, 40) : 'none'));
    if (!v.champion) champ.append(empty(v.status === 'done' || v.status === 'failed' || v.status === 'capped' ? `No champion was kept${v.reason ? `: ${v.reason.charAt(0).toLowerCase()}${v.reason.slice(1)}` : ''}.` : 'The champion is named when the voyage ends: the best kept genome of its last generation.'));
    else {
      const c = el('div', 'voyage-champion');
      c.append(el('p', 'master-line', `${cleanText(v.champion.name, 60)}, generation ${v.champion.generation}, on ${cleanText(v.champion.model, 60)}.`));
      if (v.sealed) c.append(el('p', 'master-line', `${intervalText(v.sealed, 'sealed')}.`));
      c.append(el('p', 'master-line', v.claim ? 'It beat every seeded local agent on an unspent sealed split, so its claim stands.' : v.reason ? `It makes no claim: ${v.reason.charAt(0).toLowerCase()}${v.reason.slice(1)}${/[.!?]$/.test(v.reason) ? '' : '.'}` : 'It makes no claim yet.'));
      if (v.vsLocal?.length) {
        const t = table('vslocal-ledger', 'Against each seeded local agent', [
          ['c-name', 'Against'],
          ['c-score', 'Difference, 95% interval'],
        ]);
        for (const x of v.vsLocal) {
          const r = row('vslocal-row', { agent: x.agent });
          const sc = cell('c-score');
          sc.append(el('span', `net-score ${x.lo > 0 ? 'better' : 'unclear'}`, signed(x.diff)), el('span', 'net-ci', `${signed(x.lo)} to ${signed(x.hi)}`));
          r.append(cell('c-name', cleanText(x.name, 60)), sc);
          t.append(r);
        }
        c.append(t);
      }
      if (v.notCompared) c.append(el('p', 'jobs-key', v.notCompared));
      champ.append(c);
    }
    page.append(champ);

    const about = el('section', 'school-sec');
    about.append(secHead('Arena and cost'));
    const bits: string[] = [];
    if (arena) bits.push(`Raced on the ${ARENA_KIND[arena.kind]} arena on ${cleanText(arena.repo, 80)}: ${arena.tasks.race} race tasks, ${arena.tasks.sealed} sealed; ${sealedLine(arena)}.`);
    else bits.push(`Raced on arena ${cleanText(v.arena, 60)}.`);
    if (v.sealedUsesSpent) bits.push(`This voyage spent ${plural(v.sealedUsesSpent, 'sealed use')}.`);
    bits.push(`${v.credits.toFixed(2)} credits of local model time${v.commissionedBy ? `, commissioned by ${n.firm(v.commissionedBy)}` : ''}.`);
    bits.push(v.queued ? 'Not yet sailed.' : `Sailed from ${longDate(v.startedAt)}${v.endedAt ? ` to ${longDate(v.endedAt)}` : ''}.`);
    about.append(el('p', 'master-line', bits.join(' ')));
    page.append(about);
    return page;
  }

  // ---------------------------------------------------------------- a graduate's page

  function graduatePage(g: Graduate): HTMLElement {
    const page = el('div', 'school-page graduate-page');
    const sec = el('section', 'school-sec');
    sec.append(secHead('The sealed race', `${plural(g.sealed.n, 'sealed task')}`));
    const sealed = el('div', 'graduate-sealed');
    const its = el('div', 'graduate-score');
    its.append(el('span', 'master-name', 'The graduate'), el('span', 'master-num', fixed(g.sealed.value)), el('span', 'master-note', `${intervalText(g.sealed, 'sealed')}`));
    const base = el('div', 'graduate-score base');
    base.append(el('span', 'master-name', 'Its base'), el('span', 'master-num', fixed(g.baseSealed.value)), el('span', 'master-note', `${intervalText(g.baseSealed, 'sealed')}`));
    sealed.append(its, base);
    sec.append(sealed);
    sec.append(el('p', 'graduate-diff master-line', `Beat its base by ${diffText(g.vsBase)} on the sealed race, so it graduated.`));
    sec.append(el('p', 'jobs-key', 'The race is run outside any voyage, on an arena’s sealed tasks, the graduate and its base on the same tasks; a LoRA graduates only when the whole interval of the difference lies above zero.'));
    page.append(sec);
    const about = el('section', 'school-sec');
    about.append(secHead('Lineage'));
    const firm = hiredBy(g);
    const p = el('p', 'master-line');
    p.append(document.createTextNode(`A LoRA (${cleanText(g.loraId, 40)}) on ${cleanText(g.base, 60)}, trained from ${plural(g.examples, 'verified change')} in your repos, graduated ${longDate(g.at)}. Served as ${cleanText(g.model, 60)}. `));
    if (g.agentId) {
      const a = el('a', 'grant-repo', `${names().agent(g.agentId)}, on the roster`);
      a.href = placeHref('agent', g.agentId);
      p.append(document.createTextNode(firm ? `Hired by ${firm} as ` : 'Stands as '), a, document.createTextNode('.'));
    } else p.append(document.createTextNode('Not yet on the roster.'));
    about.append(p);
    if (g.arenas.length) about.append(el('p', 'master-line', `Raced on ${g.arenas.map((a) => cleanText(a, 60)).join(', ')}.`));
    page.append(about);
    return page;
  }

  // ---------------------------------------------------------------- render

  function facts(v: SchoolView): string {
    const trusted = v.nets.filter((n) => n.status === 'trusted').length;
    const state = v.settings.enabled ? `The school is on; ${trusted ? `${trusted} of ${v.nets.length} nets are trusted` : 'no net is trusted yet'}${v.graduates.length ? `, ${plural(v.graduates.length, 'graduate')}` : ''}.` : 'The school is off: nothing trains and nothing is offered.';
    return `What the city has learned from your decisions and its own work, each claim with its number. ${state}`;
  }

  function clearSections(): void {
    for (const k of ['nets', 'master', 'arenas', 'voyages', 'graduates', 'training'] as const) slots[k]('', () => null);
  }

  function render(): void {
    if (!sheet.shown) return;
    sheet.root.dataset.page = route;
    const v = view;
    if (route === 'school') {
      trail.hidden = true;
      title.textContent = 'School';
      slots.page('', () => null);
      if (!v) {
        sub.textContent = '';
        return;
      }
      sub.textContent = facts(v);
      const minute = Math.floor(Date.now() / 60_000);
      slots.nets(JSON.stringify(v.nets), () => netsSection(v));
      slots.master(JSON.stringify([v.nets.find((n) => n.net === 'master'), v.agreements, v.grants, Math.floor(minute / 10)]), () => masterSection(v));
      slots.arenas(JSON.stringify([v.arenas, v.arenaRefusals, minute]), () => arenasSection(v));
      slots.voyages(JSON.stringify([v.voyages, v.arenas.length, firms.map((f) => [f.id, f.name])]), () => voyagesSection(v));
      slots.graduates(JSON.stringify([v.graduates, v.lora, v.settings.baseModel, firms.map((f) => [f.id, f.name, f.agents.map((a) => [a.id, a.name])])]), () => graduatesSection(v));
      slots.training(JSON.stringify([v.trains, v.gate, v.trainer, v.settings]), () => trainingSection(v));
      if (scrollTo) {
        const want = scrollTo;
        scrollTo = null;
        requestAnimationFrame(() => {
          const sec = sheet.body.querySelector<HTMLElement>(`.school-sec[data-sec="${want}"]`);
          if (!sec) return;
          sheet.body.scrollTop += sec.getBoundingClientRect().top - sheet.body.getBoundingClientRect().top;
        });
      }
      return;
    }
    clearSections();
    trail.hidden = false;
    if (route === 'net') {
      const card = v?.nets.find((n) => n.net === id) ?? null;
      const d = net && net.net === id ? net : null;
      const label = id && Object.hasOwn(NET_LABEL, id) ? NET_LABEL[id as keyof typeof NET_LABEL] : cleanText(id ?? '', 40);
      setTrail(trail, [
        ['School', routeHref('school')],
        ['The nets', placeHref('school', 'nets')],
        [label, null],
      ]);
      title.textContent = label;
      const c = d ?? card;
      sub.textContent = c ? `${netLine(c)} It learns ${NET_LEARNS[c.net]}.${c.selfSelected ? ' Its rows are partly self-selected: since the appraiser began moving awards, they are the bids it chose.' : ''}${NET_BIAS[c.net] ? ` ${NET_BIAS[c.net]}` : ''}` : '';
      if (d) slots.page(JSON.stringify(d), () => netPage(d));
      else if (card && !trouble.hidden) slots.page('', () => null);
      else if (card) slots.page(JSON.stringify(['card', card]), () => netPage({ ...card, versions: [] }));
      else slots.page('', () => null);
      return;
    }
    if (route === 'voyage') {
      const vv = v?.voyages.find((x) => x.id === id) ?? null;
      setTrail(trail, [
        ['School', routeHref('school')],
        ['Voyages', placeHref('school', 'voyages')],
        [vv ? voyageName(vv) : 'Voyage', null],
      ]);
      title.textContent = vv ? voyageName(vv) : 'Voyage';
      if (!vv) {
        sub.textContent = v ? 'There is no such voyage. It may belong to another city.' : '';
        slots.page('', () => null);
        return;
      }
      sub.textContent = voyageLine(vv);
      const arena = v?.arenas.find((a) => a.id === vv.arena) ?? null;
      slots.page(JSON.stringify([vv, arena, firms.map((f) => [f.id, f.name])]), () => voyagePage(vv, arena));
      return;
    }
    const g = v?.graduates.find((x) => x.id === id) ?? null;
    setTrail(trail, [
      ['School', routeHref('school')],
      ['Graduates', placeHref('school', 'graduates')],
      [g ? graduateName(g) : 'Graduate', null],
    ]);
    title.textContent = g ? graduateName(g) : 'Graduate';
    if (!g) {
      sub.textContent = v ? 'There is no such graduate. It may belong to another city.' : '';
      slots.page('', () => null);
      return;
    }
    const firm = hiredBy(g);
    sub.textContent = `A graduate of the school: a LoRA on ${cleanText(g.base, 60)} that beat its base by ${signed(g.vsBase.diff)} on the sealed race${firm ? `, hired by ${firm}` : ''}.`;
    slots.page(JSON.stringify([g, firms.map((f) => [f.id, f.name, f.agents.map((a) => [a.id, a.name])])]), () => graduatePage(g));
  }

  return {
    show(r, wanted) {
      const changed = r !== route || wanted !== id;
      route = r;
      id = wanted;
      if (r === 'school') scrollTo = wanted && (SCHOOL_SECTIONS as readonly string[]).includes(wanted) ? wanted : null;
      if (r !== 'net') {
        net = null;
        netWanted = null;
      } else if (net && net.net !== wanted) net = null;
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // "Refused 3 minutes ago" and "Asked 14 hours ago" age by the minute.
        timer = setInterval(render, 60_000);
      } else if (changed) sheet.body.scrollTop = 0;
      if (changed) trouble.hidden = true;
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
