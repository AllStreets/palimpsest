/**
 * The morning brief (#/brief, Phase 3 Task 11): his morning page. The day
 * as the title, two sentences of what happened since his last look, and
 * four short ledgers: what waits on him, what happened overnight, what the
 * city recommends, and what changed in the city. Each item is one ruled
 * row: a headline, then a dateline and a sentence with its actions set as
 * text in the same line, as a paper sets a story. Every action works in
 * place and the row keeps what he did ("Posted as a job, 9:14"); Ask why
 * unfolds the reason under the row; the tier opens inline; today's limit
 * opens a one-line field. It reads afresh from the event stream, so a
 * second window sees an action taken in the first.
 *
 * Every title and sentence is engine prose built over model output and the
 * ledger, so it is cleaned and set as text only; the PR link goes to
 * GitHub alone.
 */
import type { AuditView, Brief, BriefAction, BriefItem, FirmView, JobDetail, Settings, Tier } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref, routeHref } from '../router';
import { evidenceRef, tierPicker, verdictOf } from './audit';
import { leadOf, VERDICT_MEANING } from './audit-words';
import { cleanText } from './board';
import { actedLine, actionLabel, agreementOf, auditCounts, briefMeta, briefTitle, capBounds, emptyMorning, grantState, HANDLED_HEAD, itemReadouts, itemSentence, kindWords, leadFigures, sinceLine, usageLine, waitingGroups } from './brief-words';
import { TIER_VALUE, windowNowPct } from '../../../shared/market-rules';
import { agreementLine } from './school-words';
import { WORK_KINDS } from '../../../shared/school-rules';
import { createSheet, el, textButton } from './controls';
import { awardRounds, type Names } from './detail';
import { handoffs } from './handoffs';
import { coalesce, namesOf, refusal, secHead } from './pages';
import './market.css';
import './hologram.css';
import { externalLink } from './external';
import { summaryBlocks, summaryNodes } from './summary-md';

export interface BriefScreen {
  show(): void;
  hide(): void;
  /** The brief the app opened with, and whether this window was the day's first to open it. */
  prime(b: Brief, first: boolean): void;
}

export interface BriefOptions {
  listen(fn: (e: EngineEvent) => void): () => void;
  onDismiss(): void;
  /** Leaves for the city and flies to the floor (or the tower); false when nothing of it stands. */
  flyToFloor(where: { repo: string | null; floorId: string | null; agentId: string | null }): boolean;
  /** Opens the run's page at its diff. */
  openDiff(runId: string): void;
  /** Starts the week's tour in the city (Task 17): true once it walks, false when the week has none to walk. */
  startTour(week: string): Promise<boolean>;
}

const SECTIONS: Array<[keyof Brief['sections'], string]> = [
  ['waiting', 'Waiting on you'],
  ['overnight', 'Overnight'],
  ['recommendations', 'Recommended'],
  ['city', 'In the city'],
];
/** The engine events after which the brief is read again: anything that moves an item or adds one. */
const READ_ON = /^(brief\.action|job\.(changed|proposed|posted)|audit\.(ended|started)|milestone\.reached|repo\.(halted|resumed|connected|disconnected)|run\.ended|merge\.(detected|reverted)|report\.written|autonomy\.(asked|granted|declined|suspended|revoked|acted))$/;
/**
 * Hologram (redesign direction B): each action's weight, by its consequence. Granting the city authority is the
 * heaviest, then spending money, then deciding, and looking is the lightest.
 */
const WEIGHT: Partial<Record<BriefAction, 'grant' | 'spend' | 'decide'>> = {
  grant: 'grant',
  accept: 'spend',
  retry: 'spend',
  resume: 'spend',
  cap: 'spend',
  audit: 'spend',
  tier: 'decide',
  dismiss: 'decide',
  decline: 'decide',
  revoke: 'decide',
};
const weightOf = (a: BriefAction): string => WEIGHT[a] ?? 'look';
const RANK = ['look', 'decide', 'spend', 'grant'];
/** Each kind's light: the edge of its slip. */
const TONE: Partial<Record<BriefItem['kind'], string>> = {
  merged: 'ok',
  failed: 'fail',
  halt: 'fail',
  revert: 'fail',
  pr: 'warn',
  proposal: 'ask',
  'audit-due': 'warn',
  usage: 'warn',
  stale: 'warn',
  autonomy: 'grant',
};
const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** An arc gauge: a window's use as a lit arc of 270 degrees, the cap as a tick on the ring. */
function gauge(label: string, pct: number | null, cap: number | null): HTMLElement {
  const box = el('div', 'hg-gauge');
  const r = 26;
  const c = 2 * Math.PI * r;
  const sweep = 0.75;
  const ring = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
  const g = svg('g', { transform: 'rotate(135 32 32)' });
  g.append(svg('circle', { class: 'hg-gauge-track', cx: 32, cy: 32, r, 'stroke-dasharray': `${c * sweep} ${c}` }));
  const v = pct === null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
  g.append(svg('circle', { class: 'hg-gauge-value', cx: 32, cy: 32, r, 'stroke-dasharray': `${Math.max(0.01, c * sweep * v)} ${c}` }));
  if (cap !== null) {
    const a = ((135 + 270 * (cap / 100)) * Math.PI) / 180;
    ring.append(svg('line', { class: 'hg-gauge-cap', x1: 32 + Math.cos(a) * 21, y1: 32 + Math.sin(a) * 21, x2: 32 + Math.cos(a) * 31, y2: 32 + Math.sin(a) * 31 }));
  }
  ring.prepend(g);
  const fig = el('span', 'hg-gauge-fig', pct === null ? '?' : String(Math.round(pct)));
  fig.append(el('span', 'hg-unit', '%'));
  box.append(ring, fig, el('span', 'hg-label', label));
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${label} window ${pct === null ? 'not read' : `${Math.round(pct)}%`}${cap === null ? '' : `, limit ${cap}%`}`);
  return box;
}

/** A head figure: a large readout over its short label. */
function figure(value: string, label: string, tone = ''): HTMLElement {
  const box = el('div', `hg-figure${tone ? ` ${tone}` : ''}`);
  box.append(el('span', 'hg-figure-value', value), el('span', 'hg-label', label));
  return box;
}

/** The autonomy ask's evidence as a ring: one tick a decision, the misses dark; the run here beside it. */
function agreementRing(text: string): HTMLElement | null {
  const a = agreementOf(text);
  if (!a) return null;
  const box = el('div', 'hg-agree');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `The master agreed with you on ${a.agreed} of the last ${a.of}${a.here !== null ? `, and on its last ${a.here} here` : ''}`);
  const ring = svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' });
  for (let i = 0; i < a.of; i++) {
    const ang = ((-90 + (360 / a.of) * i) * Math.PI) / 180;
    const on = i < a.agreed;
    ring.append(svg('line', { class: on ? 'on' : 'off', x1: 60 + Math.cos(ang) * 44, y1: 60 + Math.sin(ang) * 44, x2: 60 + Math.cos(ang) * 56, y2: 60 + Math.sin(ang) * 56 }));
  }
  if (a.here !== null) {
    const r = 34;
    ring.append(svg('circle', { class: 'here', cx: 60, cy: 60, r }));
  }
  const core = el('div', 'hg-agree-core');
  const v = el('span', 'hg-agree-value', String(a.agreed));
  v.append(el('span', 'hg-agree-of', `/${a.of}`));
  core.append(v, el('span', 'hg-label', 'agreed'));
  const ringBox = el('div', 'hg-agree-ring');
  ringBox.append(ring, core);
  box.append(ringBox);
  if (a.here !== null) {
    const here = el('div', 'hg-figure');
    here.append(el('span', 'hg-figure-value', `${a.here}/${a.here}`), el('span', 'hg-label', 'on this repo'));
    box.append(here);
  }
  return box;
}

/** An audit's claims as one bar: real, partial, missing, broken. */
function claimsBar(text: string): HTMLElement | null {
  const c = auditCounts(text);
  if (!c) return null;
  const all = c.real + c.partial + c.missing + c.broken;
  if (!all) return null;
  const box = el('div', 'hg-claims');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${c.real} real, ${c.partial} partial, ${c.missing} missing, ${c.broken} broken`);
  const bar = el('div', 'hg-claims-bar');
  const key = el('div', 'hg-claims-key');
  for (const [k, n] of [['real', c.real], ['partial', c.partial], ['missing', c.missing], ['broken', c.broken]] as const) {
    if (!n) continue;
    const seg = el('span', `seg ${k}`);
    seg.style.flexGrow = String(n);
    bar.append(seg);
    const kk = el('span', `hg-claims-k ${k}`);
    kk.append(el('b', '', String(n)), ` ${k}`);
    key.append(kk);
  }
  box.append(bar, key);
  return box;
}

/** The words for a week with fewer than two things to walk through. */
export const NO_TOUR = 'Not enough happened this week for a walk through it.';

/** The headline of a row. Today's limit and the reading are about the plan, so they say so plainly. */
function headOf(item: BriefItem): string {
  if (item.kind === 'usage') return "Today's limit";
  if (item.kind === 'tour') return 'The week in the city';
  return cleanText(item.title, 200) || 'Untitled';
}

const isGithub = (url: string | undefined): url is string => typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);

export function createBrief(parent: HTMLElement, opts: BriefOptions): BriefScreen {
  // The palette (Phase 5) goes where the brief's items go: the city's flight to a tower, and the one event stream.
  handoffs.listen = opts.listen;
  handoffs.flyToTower = (repo) => opts.flyToFloor({ repo, floorId: null, agentId: null });
  // The pane behind the glass: a second sheet set up and to the right, its lit edge showing.
  const planes = el('div', 'hg-planes');
  planes.setAttribute('aria-hidden', 'true');
  planes.append(el('div', 'hg-plane mid'));
  planes.hidden = true;
  parent.append(planes);
  const sheet = createSheet(parent, 'brief', '', opts.onDismiss);
  sheet.root.classList.add('holo');
  const head = sheet.root.querySelector<HTMLElement>('.sheet-head')!;
  // The glass's own light: an emitter along its foot and a sweep down its edge on open, never hit.
  const light = el('div', 'hg-light');
  light.setAttribute('aria-hidden', 'true');
  sheet.root.append(light);
  // Parallax: the planes and the hovered slip follow the pointer at their depths (transform only, on a frame).
  let pending = 0;
  const moveTo = { x: 0, y: 0 };
  const parallaxOn = (): boolean => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const onMove = (e: PointerEvent): void => {
    if (!parallaxOn()) return;
    moveTo.x = (e.clientX / window.innerWidth) * 2 - 1;
    moveTo.y = (e.clientY / window.innerHeight) * 2 - 1;
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const root = document.documentElement.style;
      root.setProperty('--hg-px', moveTo.x.toFixed(3));
      root.setProperty('--hg-py', moveTo.y.toFixed(3));
    });
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  const readouts = el('div', 'hg-readouts');
  head.append(readouts);
  // Scrolled, the head is ruled off from the rows passing under it.
  sheet.body.addEventListener('scroll', () => {
    const on = sheet.body.scrollTop > 4;
    if ((sheet.root.dataset.scrolled === 'true') !== on) sheet.root.dataset.scrolled = String(on);
  }, { passive: true });
  const title = head.querySelector<HTMLElement>('.sheet-title')!;
  // The day is the page's heading: no kicker over it. The sheet is named for the screen it is.
  sheet.root.setAttribute('aria-label', 'Brief');
  // The lead and the colophon open the page and scroll away with it, so the ledgers have the height.
  const lead = el('p', 'brief-lead');
  const empty = el('p', 'brief-empty');
  empty.hidden = true;
  const since = el('p', 'brief-since');
  const usage = el('p', 'brief-usage');
  const usageText = document.createTextNode('');
  const toTreasury = el('a', 'brief-why-link brief-report-link', 'The treasury');
  toTreasury.href = routeHref('treasury');
  // The gauges in the head are the way to the treasury now; this one stays for a screen reader's reading only.
  toTreasury.tabIndex = -1;
  usage.append(usageText, ' ', toTreasury, ' keeps the daily report.');
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  // The figures in the head carry the lead, the window and the usage; the sentences stay for a screen reader.
  for (const p of [lead, since, usage]) p.classList.add('hg-sr');
  sheet.body.append(trouble, lead, empty, since, usage);
  const secs = new Map<keyof Brief['sections'], { box: HTMLElement; list: HTMLElement; key: HTMLElement }>();
  for (const [k, name] of SECTIONS) {
    const box = el('section', 'brief-sec');
    box.dataset.sec = k;
    const list = el('ol', 'brief-list');
    const key = el('p', 'jobs-key brief-key');
    key.hidden = true;
    box.append(secHead(name, ''), key, list);
    box.hidden = true;
    sheet.body.append(box);
    secs.set(k, { box, list, key });
  }
  // Under Waiting on you, what he already settled today stands apart and quieter, after what still needs a click.
  const handledHead = el('h3', 'brief-handled-head', HANDLED_HEAD);
  handledHead.id = 'brief-handled-head';
  const handledList = el('ol', 'brief-list brief-handled');
  handledList.setAttribute('aria-labelledby', handledHead.id);
  handledHead.hidden = true;
  handledList.hidden = true;
  secs.get('waiting')!.box.append(handledHead, handledList);

  let brief: Brief | null = null;
  /** Whether this window made the day's first open (it keeps that, though the engine now says otherwise). */
  let firstHere: boolean | null = null;
  let settings: Pick<Settings, 'dayCapPct' | 'hardStopPct'> = { dayCapPct: 50, hardStopPct: 90 };
  let names: Names = namesOf([]);
  let firms: FirmView[] = [];
  let unlisten: (() => void) | null = null;
  const busy = new Set<string>();
  const errors = new Map<string, string>();
  /** A quiet line under a row, said by the page rather than the engine: the tour to come, a floor gone. */
  const quiet = new Map<string, string>();
  const whyOpen = new Set<string>();
  const tierOpen = new Set<string>();
  let capOpen = false;
  /** Ask why's answer per item, read once: the node to show, or the words while it reads. */
  const whyOf = new Map<string, HTMLElement | 'reading'>();
  const rows = new Map<string, { key: string; el: HTMLElement }>();
  /** Where focus goes after the next render: a row and a selector inside it. */
  let focusNext: { id: string; sel: string } | null = null;
  let whyIds = 0;

  const read = coalesce(async () => {
    try {
      const [b, s, fs] = await Promise.all([api.brief(), api.settings().catch(() => null), firms.length ? Promise.resolve(firms) : api.firms().catch(() => [] as FirmView[])]);
      brief = b;
      if (s) settings = s;
      firms = fs;
      names = namesOf(fs);
      trouble.hidden = true;
    } catch (err) {
      trouble.textContent = `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected' || READ_ON.test(e.type)) read();
  }

  const allItems = (b: Brief): BriefItem[] => [...b.sections.waiting, ...b.sections.overnight, ...b.sections.recommendations, ...b.sections.city];

  /** Takes an item as the engine answered an action, in its place. */
  function replaceItem(next: BriefItem): void {
    if (!brief) return;
    for (const k of Object.keys(brief.sections) as Array<keyof Brief['sections']>) {
      brief.sections[k] = brief.sections[k].map((i) => (i.id === next.id ? next : i));
    }
  }

  // ---------------------------------------------------------------- acting

  async function act(item: BriefItem, action: BriefAction, body: { tier?: Tier; pct?: number } = {}, focusSel = '.brief-acted'): Promise<boolean> {
    if (busy.has(item.id)) return false;
    busy.add(item.id);
    errors.delete(item.id);
    render();
    let ok = false;
    try {
      const r = await api.briefAct(item.id, action, body);
      replaceItem(r.item);
      if (action === 'cap' && typeof body.pct === 'number' && brief) {
        const pct = (r.result as { pct?: number } | null)?.pct ?? body.pct;
        brief.usage = { ...brief.usage, todayCapPct: pct, fiveHour: { ...brief.usage.fiveHour, capPct: pct } };
      }
      focusNext = { id: item.id, sel: focusSel };
      ok = true;
    } catch (err) {
      errors.set(item.id, refusal(actionLabel(action), err));
      focusNext = { id: item.id, sel: `.brief-act[data-action="${action}"]` };
    } finally {
      busy.delete(item.id);
      render();
      read();
    }
    return ok;
  }

  /** Records a look (Ask why, the diff, the floor, the PR, the tour): the ledger keeps it; a refusal changes nothing he sees. */
  function look(item: BriefItem, action: BriefAction): void {
    void api.briefAct(item.id, action).catch(() => {});
  }

  function toggleWhy(item: BriefItem): void {
    if (whyOpen.has(item.id)) whyOpen.delete(item.id);
    else {
      whyOpen.add(item.id);
      look(item, 'why');
      if (!whyOf.has(item.id)) {
        whyOf.set(item.id, 'reading');
        void whyFor(item).then(
          (node) => whyOf.set(item.id, node),
          () => whyOf.set(item.id, el('p', 'brief-why-text', 'The reason could not be read just now.')),
        ).finally(() => {
          rows.delete(item.id);
          render();
        });
      }
    }
    focusNext = { id: item.id, sel: '.brief-act[data-action="why"]' };
    rows.delete(item.id);
    render();
  }

  function fly(item: BriefItem): void {
    look(item, 'fly');
    void (async () => {
      let agentId: string | null = null;
      if (item.refs.milestoneId) {
        const m = (await api.milestones().catch(() => [])).find((x) => x.id === item.refs.milestoneId);
        agentId = m?.agentId ?? null;
      }
      const went = opts.flyToFloor({ repo: item.repo, floorId: item.refs.floorId ?? null, agentId });
      if (!went) {
        quiet.set(item.id, 'That floor no longer stands in the city.');
        rows.delete(item.id);
        render();
      }
    })();
  }

  function tour(item: BriefItem): void {
    const week = brief?.tour?.week ?? item.id.replace(/^tour:/, '');
    // Recorded only once the walk has started; a week with nothing to walk says so under the row.
    void opts.startTour(week).then(
      (walking) => {
        if (walking) {
          void act(item, 'tour');
          return;
        }
        quiet.set(item.id, NO_TOUR);
        focusNext = { id: item.id, sel: '.brief-quiet' };
        rows.delete(item.id);
        render();
      },
      () => {},
    );
  }

  // ---------------------------------------------------------------- Ask why

  /** The reason under a row: the claim and evidence for a proposal, the award and the end for a job, the halt, the audit, the reading. */
  async function whyFor(item: BriefItem): Promise<HTMLElement> {
    const box = el('div', 'brief-why-body');
    const jobId = item.refs.jobId;
    if (item.kind === 'proposal' && item.refs.auditId && jobId) {
      const [d, a] = await Promise.all([api.job(jobId), api.audit(item.refs.auditId)]);
      const f = a.findings.find((x) => x.id === d.job.proposal?.findingId);
      if (f) {
        const claim = el('blockquote', 'why-claim');
        claim.append(el('p', 'why-claim-text', cleanText(f.claim, 400)));
        const where = f.source?.file ? `${cleanText(f.source.file, 120)}${f.source.line ? `, line ${f.source.line}` : ''}` : 'the README';
        claim.append(el('cite', 'why-claim-source', `${cleanText(item.repo ?? '', 120)}, ${where}`));
        const said = el('p', 'why-verdict');
        const meaning = VERDICT_MEANING[f.verdict];
        said.append(verdictOf(f.verdict), el('span', 'why-verdict-text', `${meaning.charAt(0).toUpperCase()}${meaning.slice(1)}${f.tested ? '' : ', and no test covers it'}.`));
        const ev = el('ul', 'why-evidence');
        for (const e of f.evidence.slice(0, 3)) {
          const li = el('li', `why-ev${e.verified ? '' : ' unfound'}`);
          li.append(evidenceRef(item.repo ?? '', a.baseSha, e));
          const note = cleanText(e.note, 300);
          if (note) li.append(el('span', 'why-ev-note', note.replace(/[.!?]?$/, '.')));
          ev.append(li);
        }
        box.append(claim, said, ev);
      } else box.append(el('p', 'brief-why-text', 'The finding behind it is no longer in its audit.'));
      box.append(link('The job and its audit', placeHref('job', jobId)));
      return box;
    }
    if (jobId && ['proposal', 'merged', 'failed', 'pr', 'revert', 'note'].includes(item.kind)) {
      const d: JobDetail = await api.job(jobId);
      if (item.kind === 'proposal') {
        const body = cleanText(d.job.body.replace(/^\[[^\]]*\]\s*/gm, ''), 600);
        box.append(el('p', 'brief-why-text', body || 'No details beyond the title.'));
      }
      const run = d.runs.at(-1);
      if (item.kind === 'failed' && run?.endedReason) box.append(el('p', 'brief-why-text', `The run ended: ${cleanText(run.endedReason, 300).replace(/[.!?]?$/, '.')}`));
      if (item.kind === 'note' || item.kind === 'revert') box.append(el('p', 'brief-why-text', cleanText(item.text, 600)));
      const round = awardRounds(d.ledger, names, d.job.value, false).at(-1);
      if (round) box.append(el('p', 'brief-why-text award', round.prose));
      if ((item.kind === 'pr' || item.kind === 'merged') && run?.summary) {
        // The agent's summary is markdown: set as paragraphs and lists, every piece as text (summary-md.ts).
        const nodes = summaryNodes(summaryBlocks(run.summary, 400));
        if (nodes.length) {
          const q = el('blockquote', 'brief-why-summary');
          q.append(...nodes);
          box.append(q);
        }
      }
      if (!box.childElementCount) box.append(el('p', 'brief-why-text', 'The job has no award on record.'));
      box.append(link("The job's page", placeHref('job', jobId)));
      return box;
    }
    if (item.kind === 'audit' && item.refs.auditId) {
      const a: AuditView = await api.audit(item.refs.auditId);
      box.append(el('p', 'brief-why-text', leadOf(a)), link('The audit', placeHref('audit', a.id)));
      return box;
    }
    if (item.kind === 'halt' && item.repo) {
      box.append(el('p', 'brief-why-text', cleanText(item.text, 600)), link('The district page', placeHref('repo', item.repo)));
      return box;
    }
    if ((item.kind === 'autonomy' || item.kind === 'acted') && item.repo) {
      // The pair: from the ask's id (autonomy:<kind>:<repo>), or the kind the act's line names.
      const kind = WORK_KINDS.find((k) => item.id.startsWith(`autonomy:${k}:`)) ?? WORK_KINDS.find((k) => item.text.includes(` ${k} `));
      const v = await api.school();
      const a = kind ? v.agreements.find((x) => x.kind === kind && x.repo === null) : undefined;
      const g = kind ? v.grants.find((x) => x.kind === kind && x.repo === item.repo) : undefined;
      if (a && kind) box.append(el('p', 'brief-why-text', a.skewed ? agreementLine(a) : `On ${kindWords(kind)}, the master ${agreementLine(a).replace(/^./, (c) => c.toLowerCase())}`));
      if (g) box.append(el('p', 'brief-why-text', `On this repo: ${grantState(g)}.`));
      box.append(el('p', 'brief-why-text', 'The city acts under a grant only when the master is at least 0.90 sure and every check holds; a revert of anything it did takes the grant back.'));
      const more = el('p', 'brief-why-more');
      const toSettings = el('a', 'brief-why-link', 'Every grant, in Settings');
      toSettings.href = routeHref('settings');
      const toRepo = el('a', 'brief-why-link', 'the district page');
      toRepo.href = placeHref('repo', item.repo);
      more.append(toSettings, '; this one also on ', toRepo, '.');
      box.append(more);
      return box;
    }
    if (item.kind === 'stale') {
      const detail = brief?.usage.paused?.detail ? cleanText(brief.usage.paused.detail, 300) : '';
      box.append(el('p', 'brief-why-text', `${detail ? `${detail.replace(/[.!?]?$/, '.')} ` : ''}Without a fresh reading the city cannot see how much of your plan is left, so it starts no Claude work. Local models carry on.`), link('The treasury', routeHref('treasury')));
      return box;
    }
    box.append(el('p', 'brief-why-text', cleanText(item.text, 600)));
    return box;
  }

  function link(text: string, href: string): HTMLElement {
    const p = el('p', 'brief-why-more');
    const a = el('a', 'brief-why-link', text);
    a.href = href;
    p.append(a);
    return p;
  }

  // ---------------------------------------------------------------- a row

  function actionNode(item: BriefItem, a: BriefAction): HTMLElement | null {
    const label = actionLabel(a);
    const head = headOf(item);
    if (a === 'open-pr') {
      if (!isGithub(item.refs.prUrl)) return null;
      // The open is asked for before look() records it, so a re-render the record starts cannot lose the click.
      const link = externalLink(el('a', 'textbtn brief-act', label), item.refs.prUrl, () => look(item, 'open-pr'));
      link.dataset.action = a;
      link.dataset.weight = weightOf(a);
      link.setAttribute('aria-label', `${label}: ${head}, on GitHub`);
      return link;
    }
    if (a === 'diff' && !item.refs.runId) return null;
    const b = textButton('brief-act', label, () => {
      switch (a) {
        case 'why':
          return toggleWhy(item);
        case 'tier':
          if (tierOpen.has(item.id)) tierOpen.delete(item.id);
          else tierOpen.add(item.id);
          focusNext = { id: item.id, sel: tierOpen.has(item.id) ? '.brief-tier [role="radio"][aria-checked="true"]' : '.brief-act[data-action="tier"]' };
          rows.delete(item.id);
          return render();
        case 'cap':
          capOpen = !capOpen;
          focusNext = { id: item.id, sel: capOpen ? '.brief-cap-input' : '.brief-act[data-action="cap"]' };
          rows.delete(item.id);
          return render();
        case 'diff':
          look(item, 'diff');
          return opts.openDiff(item.refs.runId!);
        case 'fly':
          return fly(item);
        case 'tour':
          return tour(item);
        default:
          return void act(item, a);
      }
    });
    b.dataset.action = a;
    b.dataset.weight = weightOf(a);
    b.setAttribute('aria-label', `${label}: ${head}`);
    // A key that spends shows what it may spend, in its own light.
    if (a === 'accept' && item.kind === 'proposal') b.append(el('span', 'hg-cost', `${TIER_VALUE[item.tier ?? 'normal']}`));
    if (a === 'grant') b.prepend(el('span', 'hg-seal'));
    if (a === 'why') {
      const id = `brief-why-${(whyIds += 1)}`;
      b.setAttribute('aria-expanded', String(whyOpen.has(item.id)));
      b.setAttribute('aria-controls', id);
      b.dataset.controls = id;
    }
    if (a === 'tier') b.setAttribute('aria-expanded', String(tierOpen.has(item.id)));
    if (a === 'cap') b.setAttribute('aria-expanded', String(capOpen));
    if (busy.has(item.id)) b.disabled = true;
    return b;
  }

  function capField(item: BriefItem): HTMLElement {
    const { min, max } = capBounds(settings.hardStopPct);
    const form = el('form', 'brief-cap');
    form.setAttribute('aria-label', "Today's limit");
    const label = el('label', 'brief-cap-label', "Today's limit");
    const input = el('input', 'brief-cap-input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = String(Math.round(brief?.usage.todayCapPct ?? brief?.usage.fiveHour.capPct ?? settings.dayCapPct));
    input.id = 'brief-cap-input';
    label.htmlFor = input.id;
    const unit = el('span', 'brief-cap-unit', '%');
    const until = el('span', 'brief-cap-until', 'until midnight');
    const set = el('button', 'textbtn brief-cap-set', 'Set');
    set.type = 'submit';
    const cancel = textButton('brief-cap-cancel', 'Cancel', () => closeCap(item));
    const note = el('span', 'brief-cap-note', `From ${min}% to ${max}%, five points under the hard stop; the usual cap is ${settings.dayCapPct}%.`);
    form.append(label, input, unit, until, set, cancel, note);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pct = Number(input.value);
      if (!Number.isFinite(pct) || input.value.trim() === '') {
        errors.set(item.id, `Today's limit needs a number from ${min} to ${max}.`);
        rows.delete(item.id);
        return render();
      }
      capOpen = false;
      void act(item, 'cap', { pct: Math.min(max, Math.max(min, Math.round(pct))) });
    });
    // Escape puts the field away and stays on the brief.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCap(item);
      }
    });
    return form;
  }

  function closeCap(item: BriefItem): void {
    capOpen = false;
    focusNext = { id: item.id, sel: '.brief-act[data-action="cap"]' };
    rows.delete(item.id);
    render();
  }

  function row(item: BriefItem, now: number): HTMLElement {
    const li = el('li', `brief-item k-${item.kind}`);
    li.dataset.item = item.id;
    li.dataset.kind = item.kind;
    if (item.acted) li.dataset.acted = item.acted.action;
    if (busy.has(item.id)) li.setAttribute('aria-busy', 'true');
    li.dataset.tone = TONE[item.kind] ?? '';
    const m = briefMeta(item, now);
    if (m.where || m.when) {
      const meta = el('p', 'hg-meta');
      if (m.where) meta.append(el('span', 'hg-where', m.where));
      if (m.when) meta.append(el('span', 'hg-when', m.when));
      li.append(meta);
    }
    li.append(el('h3', 'brief-head', headOf(item)));
    if (item.kind === 'autonomy') {
      const ring = agreementRing(item.text);
      if (ring) li.append(ring);
    }
    if (item.kind === 'audit') {
      const bar = claimsBar(item.text);
      if (bar) li.append(bar);
    }
    const line = el('div', 'brief-line');
    const outs = el('p', 'hg-outs');
    // The autonomy ask's ring carries its figures; the row repeats none of them.
    for (const r of item.kind === 'autonomy' && li.querySelector('.hg-agree') ? [] : itemReadouts(item, names)) {
      const o = el('span', `hg-out${r.tone ? ` ${r.tone}` : ''}${r.k ? '' : ' bare'}`);
      o.append(el('span', 'hg-out-v', r.v));
      if (r.k) o.append(el('span', 'hg-out-k', r.k));
      outs.append(o);
    }
    line.append(outs);
    const acts = item.actions.map((a) => actionNode(item, a)).filter((x): x is HTMLElement => x !== null);
    if (acts.length) {
      const span = el('span', 'brief-acts');
      // The heaviest key ends the row, where the eye ends.
      const rank = (n: HTMLElement): number => RANK.indexOf(n.dataset.weight ?? 'look');
      span.append(...acts.sort((x, y) => rank(x) - rank(y)));
      line.append(span);
    }
    const did = actedLine(item, item.kind === 'usage' ? brief?.usage.todayCapPct : null);
    if (did) {
      const d = el('span', 'brief-acted', did);
      d.tabIndex = -1;
      line.append(d);
    }
    if (tierOpen.has(item.id) && item.actions.includes('tier') && item.tier) {
      const pick = tierPicker(item.tier, `Tier for ${headOf(item)}`, (t) => {
        tierOpen.delete(item.id);
        void act(item, 'tier', { tier: t });
      }, busy.has(item.id));
      pick.classList.add('brief-tier');
      line.append(pick);
    }
    li.append(line);
    if (capOpen && item.kind === 'usage' && item.actions.includes('cap')) li.append(capField(item));
    if (whyOpen.has(item.id)) {
      const btn = line.querySelector<HTMLElement>('.brief-act[data-action="why"]');
      const box = el('div', 'brief-why');
      box.id = btn?.dataset.controls ?? `brief-why-${(whyIds += 1)}`;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `Why: ${headOf(item)}`);
      const got = whyOf.get(item.id);
      // The whole sentence, one tap away: the row itself carries only its readouts.
      box.append(el('p', 'brief-why-text hg-said', itemSentence(item, names)));
      box.append(got && got !== 'reading' ? got : el('p', 'brief-why-text reading', 'Reading the reason'));
      li.append(box);
    }
    // the page's own quiet line first; else the school's suggestion (a trusted triage net), never acted on by itself
    const q = quiet.get(item.id) ?? (item.acted ? undefined : item.suggestion);
    if (q) {
      const p = el('p', 'brief-quiet', q);
      p.tabIndex = -1;
      li.append(p);
    }
    const err = errors.get(item.id);
    if (err) {
      const p = el('p', 'brief-error', err);
      p.setAttribute('role', 'alert');
      li.append(p);
    }
    return li;
  }

  // ---------------------------------------------------------------- the page

  /** Sets a list's rows to `items`, reusing each row whose item and state are unchanged, and keeping focus in a row redrawn. */
  function fill(into: HTMLElement, items: BriefItem[], now: number, seen: Set<string>): void {
    const b = brief!;
    const want: HTMLElement[] = [];
    for (const item of items) {
      seen.add(item.id);
      const key = JSON.stringify([item, busy.has(item.id), errors.get(item.id), quiet.get(item.id), whyOpen.has(item.id), whyOf.get(item.id) === 'reading', tierOpen.has(item.id), item.kind === 'usage' && capOpen, b.usage.todayCapPct, settings, names.firm(item.refs.firmId ?? '')]);
      const had = rows.get(item.id);
      if (had && had.key === key) {
        want.push(had.el);
        continue;
      }
      const focused = had?.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      const next = row(item, now);
      if (had) had.el.replaceWith(next);
      rows.set(item.id, { key, el: next });
      want.push(next);
      if (focused && !focusNext) {
        const action = focused.dataset.action;
        const again = action ? next.querySelector<HTMLElement>(`.brief-act[data-action="${action}"]`) : null;
        (again ?? next.querySelector<HTMLElement>('.brief-acted') ?? next.querySelector<HTMLElement>('.brief-act'))?.focus({ preventScroll: true });
      }
    }
    const cur = [...into.children];
    if (cur.length !== want.length || cur.some((c, i) => c !== want[i])) into.replaceChildren(...want);
  }

  function drawReadouts(b: Brief, first: boolean): void {
    const f = leadFigures(b.lead);
    const waiting = waitingGroups(b.sections.waiting).open.length;
    const five = windowNowPct(b.usage.fiveHour);
    const seven = windowNowPct(b.usage.sevenDay);
    const cap = Math.round(b.usage.todayCapPct ?? b.usage.fiveHour.capPct ?? settings.dayCapPct);
    const sinceWords = sinceLine(b.since, b.day, first).replace(/^Since /, '');
    const key = JSON.stringify([waiting, f, five, seven, cap, sinceWords]);
    if (readouts.dataset.key === key) return;
    readouts.dataset.key = key;
    const figs = el('div', 'hg-figures');
    figs.append(
      figure(String(waiting).padStart(2, '0'), 'waiting', waiting ? 'hot' : ''),
      figure(String(f.merged).padStart(2, '0'), 'merged'),
      figure(f.spent ?? '0', 'credits spent'),
    );
    const gauges = el('a', 'hg-gauges');
    gauges.href = routeHref('treasury');
    gauges.setAttribute('aria-label', `${usageLine(b.usage, settings.dayCapPct)} The treasury keeps the daily report.`);
    gauges.append(gauge('5 hour', five, cap), gauge('7 day', seven, null));
    const when = el('p', 'hg-since', `since ${sinceWords}`);
    readouts.replaceChildren(figs, gauges, when);
  }

  function render(): void {
    if (!sheet.shown || !brief) return;
    const b = brief;
    const now = Date.now();
    const t = briefTitle(b.day);
    if (title.textContent !== t) title.textContent = t;
    if (lead.textContent !== b.lead) lead.textContent = cleanText(b.lead, 600);
    const first = firstHere ?? b.firstOpen;
    sheet.root.dataset.first = String(first);
    since.textContent = sinceLine(b.since, b.day, first);
    drawReadouts(b, first);
    usageText.textContent = usageLine(b.usage, settings.dayCapPct);
    const items = allItems(b);
    // An empty morning: the one line takes the lead's place, and the lead's own second sentence follows it quietly.
    empty.hidden = items.length > 0;
    lead.hidden = items.length === 0;
    empty.textContent = `${emptyMorning()}.`;
    const seen = new Set<string>();
    for (const [k] of SECTIONS) {
      const s = secs.get(k)!;
      const list = b.sections[k];
      s.box.hidden = list.length === 0;
      // What an audit does is said once, under the section that offers it.
      const due = list.some((i) => i.kind === 'audit-due');
      s.key.hidden = !due;
      if (due) s.key.textContent = 'Audits check the README against the code. Nothing runs until you post.';
      // Waiting on you: the rows that need a click, then what he settled today in a quieter list of its own.
      if (k === 'waiting') {
        const { open, handled } = waitingGroups(list);
        s.list.hidden = open.length === 0;
        handledHead.hidden = handled.length === 0;
        handledList.hidden = handled.length === 0;
        // The heaviest ask stands first: an offer of authority leads what waits on him (the order of the rest is the engine's).
        fill(s.list, [...open.filter((i) => i.kind === 'autonomy'), ...open.filter((i) => i.kind !== 'autonomy')], now, seen);
        fill(handledList, handled, now, seen);
      } else fill(s.list, list, now, seen);
      const count = s.box.querySelector<HTMLElement>('.repos-sec-count');
      const n = k === 'waiting' ? waitingGroups(list).open.length : list.length;
      if (count) count.textContent = String(n).padStart(2, '0');
    }
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    if (focusNext) {
      const f = focusNext;
      focusNext = null;
      const r = rows.get(f.id)?.el;
      const target = r?.querySelector<HTMLElement>(f.sel) ?? r?.querySelector<HTMLElement>('.brief-acted') ?? r?.querySelector<HTMLElement>('.brief-act');
      target?.focus({ preventScroll: true });
    }
  }

  return {
    show() {
      if (!sheet.shown) {
        sheet.show();
        planes.hidden = false;
        requestAnimationFrame(() => planes.classList.add('open'));
        unlisten = opts.listen(onEvent);
      }
      render();
      read();
    },
    hide() {
      sheet.hide();
      planes.classList.remove('open');
      planes.hidden = true;
      unlisten?.();
      unlisten = null;
      whyOpen.clear();
      tierOpen.clear();
      capOpen = false;
      quiet.clear();
      errors.clear();
      rows.clear();
      for (const s of secs.values()) s.list.replaceChildren();
      handledList.replaceChildren();
    },
    prime(b, first) {
      brief = b;
      firstHere = first;
      render();
    },
  };
}
