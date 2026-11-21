/**
 * The morning brief (#/brief): his morning page, rebuilt on the screens'
 * layer (screens redesign Task 17, the locked Targeting direction). The
 * panel is dressed by os/panel.ts: the head is the near plate, with the day,
 * the since readout, the three head figures and the two rangefinders; the
 * list is the four ledgers over the stream of the brief's own words. Each row
 * is a designator, where and when, the headline and its figures, and its keys
 * weighed by consequence; the whole sentence waits for the reader (.os-sr)
 * and behind Why. The autonomy ask is raised on its own shadow in red
 * brackets, its grant the one red key. While the Brief is open, the city's
 * plates give way to its pins: what waits has a numbered pin over its tower,
 * and the active row (hovered, else focused, else the autonomy ask, else the
 * first) holds the lock and its leader.
 *
 * Every action keeps main's behaviour (brief-actions.ts, held to its fixture),
 * and every title and sentence is engine prose built over model output and the
 * ledger, so it is cleaned and set as text only; a run's summary goes through
 * the safe markdown renderer as nodes. The PR link goes to GitHub alone.
 */
import type { AuditView, Brief, BriefAction, BriefItem, FirmView, JobDetail, Settings, Tier } from '../../../shared/types';
import { creditsText, windowNowPct } from '../../../shared/market-rules';
import { api, type EngineEvent } from '../api';
import { placeHref, routeHref } from '../router';
import { evidenceRef, tierPicker, verdictOf } from './audit';
import { leadOf, VERDICT_MEANING } from './audit-words';
import { cleanText } from './board';
import { EFFECT } from './brief-actions';
import { actedLine, actionLabel, briefMeta, briefTitle, capBounds, emptyMorning, grantState, HANDLED_HEAD, headFigures, itemReadouts, itemSentence, keyAria, keySum, kindWords, pinToneOf, sinceLine, streamWords, toneOf, usageLine, waitingGroups, weightOf } from './brief-words';
import { agreementLine } from './school-words';
import { WORK_KINDS } from '../../../shared/school-rules';
import { createSheet, el, textButton } from './controls';
import { awardRounds, type Names } from './detail';
import { handoffs } from './handoffs';
import { coalesce, namesOf, refusal } from './pages';
import './brief.css';
import { externalLink } from './external';
import { summaryBlocks, summaryNodes } from './summary-md';
import { weighKey } from './os/control';
import { scanOnce, typeIn } from './os/motion';
import { dressPanel } from './os/panel';
import { createPins, type OsCity, type PinTarget } from './os/pins';
import { agreementScales, figure, rangefinder, readoutRow, segmentBar } from './os/readout';

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
  /** The city under the pins (screens redesign Task 10): with it, what waits is pinned over its towers. */
  city?: OsCity;
}

const SECTIONS: Array<[keyof Brief['sections'], string]> = [
  ['waiting', 'Waiting on you'],
  ['overnight', 'Overnight'],
  ['recommendations', 'Recommended'],
  ['city', 'In the city'],
];
/** The engine events after which the brief is read again: anything that moves an item or adds one. */
const READ_ON = /^(brief\.action|job\.(changed|proposed|posted)|audit\.(ended|started)|milestone\.reached|repo\.(halted|resumed|connected|disconnected)|run\.ended|merge\.(detected|reverted)|report\.written|autonomy\.(asked|granted|declined|suspended|revoked|acted))$/;
/** The words for a week with fewer than two things to walk through. */
export const NO_TOUR = 'Not enough happened this week for a walk through it.';

/** The headline of a row. Today's limit and the reading are about the plan, so they say so plainly. */
function headOf(item: BriefItem): string {
  if (item.kind === 'usage') return "Today's limit";
  if (item.kind === 'tour') return 'The week in the city';
  return cleanText(item.title, 200) || 'Untitled';
}

/** The weights in order of consequence, lightest first. */
const WEIGHT_RANK: Record<ReturnType<typeof weightOf>, number> = { look: 0, decide: 1, spend: 2, grant: 3 };

const isGithub = (url: string | undefined): url is string => typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);

export function createBrief(parent: HTMLElement, opts: BriefOptions): BriefScreen {
  // The palette (Phase 5) goes where the brief's items go: the city's flight to a tower, and the one event stream.
  handoffs.listen = opts.listen;
  handoffs.flyToTower = (repo) => opts.flyToFloor({ repo, floorId: null, agentId: null });
  const sheet = createSheet(parent, 'brief', '', opts.onDismiss);
  // The screens' panel: the brackets, the rail, three panes and the stream. Its show wraps the sheet's, so the
  // sheet is always shown through sheet.show (Task 5).
  const panel = dressPanel(sheet);
  const head = panel.head;
  // Scrolled, the head is ruled off from the rows passing under it.
  sheet.body.addEventListener('scroll', () => {
    const on = sheet.body.scrollTop > 4;
    if ((sheet.root.dataset.scrolled === 'true') !== on) sheet.root.dataset.scrolled = String(on);
  }, { passive: true });
  const title = head.querySelector<HTMLElement>('.sheet-title')!;
  // The day is the page's heading: no kicker over it. The sheet is named for the screen it is.
  sheet.root.setAttribute('aria-label', 'Brief');
  // The head: the since readout in ice, then the figures and the two windows. The rangefinders lead to the treasury.
  const since = el('p', 'brief-since os-figs');
  const readouts = el('div', 'brief-readouts');
  const figs = el('div', 'brief-figs');
  const ranges = el('a', 'brief-ranges os-focus');
  ranges.href = routeHref('treasury');
  readouts.append(figs, ranges);
  head.append(since, readouts);
  // The lead and the usage sentence stay for the reader alone; the head says them as figures.
  const lead = el('p', 'brief-lead os-sr');
  const usage = el('p', 'brief-usage os-sr');
  const empty = el('p', 'brief-empty');
  empty.hidden = true;
  const trouble = el('p', 'brief-trouble');
  trouble.setAttribute('role', 'alert');
  trouble.hidden = true;
  sheet.body.append(trouble, lead, usage, empty);
  const secs = new Map<keyof Brief['sections'], { box: HTMLElement; list: HTMLElement; key: HTMLElement; count: HTMLElement }>();
  for (const [k, name] of SECTIONS) {
    const box = el('section', 'brief-sec');
    box.dataset.sec = k;
    const h = el('h2', 'brief-sec-head');
    h.id = `brief-sec-${k}`;
    const count = el('span', 'brief-sec-count os-figs');
    count.setAttribute('aria-hidden', 'true');
    h.append(el('span', 'brief-sec-name', name), count);
    const list = el('ol', 'brief-list');
    list.setAttribute('aria-labelledby', h.id);
    // What an audit does, for the reader: on the screen the Audit key and its sum say it, and Why says the rest.
    const key = el('p', 'brief-key os-sr');
    key.hidden = true;
    box.append(h, key, list);
    box.hidden = true;
    sheet.body.append(box);
    secs.set(k, { box, list, key, count });
  }
  // Under Waiting on you, what he already settled today stands apart and quieter, after what still needs a click.
  const handledHead = el('h3', 'brief-handled-head', HANDLED_HEAD);
  handledHead.id = 'brief-handled-head';
  const handledList = el('ol', 'brief-list brief-handled');
  handledList.setAttribute('aria-labelledby', handledHead.id);
  handledHead.hidden = true;
  handledList.hidden = true;
  secs.get('waiting')!.box.append(handledHead, handledList);

  // The pins over the city. The Brief stands for the app's life, so the pins' scroll listener and observer on the
  // list stay with it; both only mark a flag while the pins are hidden.
  const pins = createPins(parent, sheet.root, sheet.body, opts.city);
  /** What the pins were last given, so an unchanged brief sets nothing. */
  let pinKey = '';
  let targets: PinTarget[] = [];
  /** The row under the pointer and the row holding focus: the lock follows hover, then focus, then the default. */
  let hoverId: string | null = null;
  let focusId: string | null = null;
  let activeWas: { id: string | null; row: HTMLElement | null } = { id: null, row: null };
  /** Whether the since line types in on the next render: once per open. */
  let typeSince = false;
  let sinceText: string | null = null;
  let sinceStop: (() => void) | null = null;
  let headKey = '';
  /** The stops of the reasons still typing in, all finished at once when the Brief closes. */
  const typing: Array<() => void> = [];

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
          (node) => whyOf.set(item.id, reveal(node)),
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

  /**
   * An action's key, weighed by consequence (os/control.ts): its label in the display face, and its sum in a
   * window at its end while the action is offered. Its name for the reader carries the sum (keyAria).
   */
  function actionNode(item: BriefItem, a: BriefAction): HTMLElement | null {
    const label = actionLabel(a);
    const head = headOf(item);
    const effect = EFFECT[a];
    const words = el('span', 'brief-act-label os-key-label', label);
    if (effect === 'open-pr') {
      if (!isGithub(item.refs.prUrl)) return null;
      // The open is asked for before look() records it, so a re-render the record starts cannot lose the click.
      const link = externalLink(el('a', 'brief-act'), item.refs.prUrl, () => look(item, 'open-pr'));
      link.append(words);
      link.dataset.action = a;
      link.setAttribute('aria-label', `${keyAria(item, a, head)}, on GitHub`);
      return weighKey(link, weightOf(a), keySum(item, a) ?? undefined);
    }
    if (effect === 'diff' && !item.refs.runId) return null;
    const b = el('button', 'brief-act');
    b.type = 'button';
    b.append(words);
    b.addEventListener('click', () => {
      // The action contract (brief-actions.ts): main's switch, by effect, call for call.
      switch (EFFECT[a]) {
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
        case 'act':
          return void act(item, a);
        case 'open-pr':
          // Never a button: Open PR is the link above.
          return;
      }
    });
    b.dataset.action = a;
    b.setAttribute('aria-label', keyAria(item, a, head));
    if (a === 'why') {
      const id = `brief-why-${(whyIds += 1)}`;
      b.setAttribute('aria-expanded', String(whyOpen.has(item.id)));
      b.setAttribute('aria-controls', id);
      b.dataset.controls = id;
    }
    if (a === 'tier') b.setAttribute('aria-expanded', String(tierOpen.has(item.id)));
    if (a === 'cap') b.setAttribute('aria-expanded', String(capOpen));
    if (busy.has(item.id)) b.disabled = true;
    return weighKey(b, weightOf(a), keySum(item, a) ?? undefined);
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

  /** A line of plain text that types itself in: typed unseen by the reader, who reads it whole (.os-sr), its place held. */
  function typedLine(host: HTMLElement, text: string, type: boolean): () => void {
    const typed = el('span', 'brief-typed');
    const hold = el('span', 'os-type-hold');
    hold.setAttribute('aria-hidden', 'true');
    hold.append(el('span', 'os-type-ghost', text), typed);
    host.replaceChildren(el('span', 'os-sr', text), hold);
    if (type) return typeIn(typed, text);
    typed.textContent = text;
    return () => {};
  }

  /**
   * The reason under a row, as it arrives: each plain line types in, and a run's summary (safe markdown, set as
   * nodes) is never typed: it is revealed by a sweep, the scan crossing it once.
   */
  function reveal(node: HTMLElement): HTMLElement {
    for (const p of node.querySelectorAll<HTMLElement>('p.brief-why-text')) typing.push(typedLine(p, p.textContent ?? '', true));
    const summary = node.querySelector<HTMLElement>('.brief-why-summary');
    if (summary) {
      summary.classList.add('brief-sweep');
      summary.addEventListener('animationend', () => summary.classList.remove('brief-sweep'), { once: true });
      requestAnimationFrame(() => scanOnce(summary));
    }
    return node;
  }

  /** The audit's claims as one bar, real to broken, with each count under it. */
  function claimsBar(item: BriefItem): HTMLElement | null {
    const f = item.figures;
    if (f?.kind !== 'audit') return null;
    const parts = [
      { key: 'real', n: f.real },
      { key: 'partial', n: f.partial },
      { key: 'stubbed', n: f.stubbed },
      { key: 'missing', n: f.missing },
      { key: 'broken', n: f.broken },
    ];
    const said = parts.filter((p) => p.n > 0).map((p) => `${p.n} ${p.key}`).join(', ');
    const bar = segmentBar(parts, `Claims in the README: ${said}`);
    bar?.classList.add('brief-claims');
    return bar;
  }

  function row(item: BriefItem, now: number, n: number | null): HTMLElement {
    const li = el('li', `brief-item k-${item.kind}`);
    li.dataset.item = item.id;
    li.dataset.kind = item.kind;
    if (item.repo) li.dataset.repo = item.repo;
    li.dataset.tone = toneOf(item.kind);
    if (item.acted) li.dataset.acted = item.acted.action;
    if (busy.has(item.id)) li.setAttribute('aria-busy', 'true');
    // The designator: the target's number, or a short hairline.
    const des = el('span', 'brief-des os-figs', n === null ? '' : String(n).padStart(2, '0'));
    des.setAttribute('aria-hidden', 'true');
    li.append(des);
    const { where, when } = briefMeta(item, now);
    const ask = item.kind === 'autonomy' && item.actions.includes('grant');
    // Only an open ask is raised in red; an answered one (granted, declined) is an ordinary row.
    li.classList.toggle('is-ask', ask);
    if (where || when || ask) {
      const meta = el('p', 'brief-meta os-figs');
      if (where) meta.append(el('span', 'brief-where', where));
      if (when) meta.append(el('span', 'brief-when', when));
      if (ask) meta.append(el('span', 'brief-grant-tag', 'Grant'));
      li.append(meta);
    }
    li.append(el('h3', 'brief-head', headOf(item)));
    // The whole sentence, for the reader: the screen says it as figures, and in full behind Why.
    li.append(el('p', 'brief-sentence os-sr', itemSentence(item, names)));
    const f = item.figures;
    // The autonomy ask's two scales say its agreement; the same counts as readouts would say it twice.
    const scales = f?.kind === 'autonomy' ? agreementScales(f) : null;
    if (scales) {
      scales.classList.add('brief-scales');
      li.append(scales);
    }
    const claims = claimsBar(item);
    if (claims) li.append(claims);
    const line = el('div', 'brief-line');
    const outs = scales ? null : readoutRow(itemReadouts(item, names));
    if (outs) line.append(outs);
    // Lightest to heaviest, so the key that spends or grants stands at the row's right edge, where the eye ends;
    // of two keys of one weight, the one carrying a sum is the heavier.
    const rank = (a: BriefAction): number => WEIGHT_RANK[weightOf(a)] * 2 + (keySum(item, a) ? 1 : 0);
    const acts = [...item.actions]
      .sort((a, b) => rank(a) - rank(b))
      .map((a) => actionNode(item, a))
      .filter((x): x is HTMLElement => x !== null);
    if (acts.length) {
      const span = el('span', 'brief-acts');
      span.append(...acts);
      line.append(span);
    }
    const did = actedLine(item, item.kind === 'usage' ? brief?.usage.todayCapPct : null);
    if (did) {
      const d = el('span', 'brief-acted os-figs os-focus', did);
      d.tabIndex = -1;
      line.append(d);
    }
    if (line.childElementCount) li.append(line);
    // A row with no figures is one line: its keys stand beside the headline, not under it.
    if (!outs && !scales && !claims) li.classList.add('is-bare');
    if (tierOpen.has(item.id) && item.actions.includes('tier') && item.tier) {
      const pick = tierPicker(item.tier, `Tier for ${headOf(item)}`, (t) => {
        tierOpen.delete(item.id);
        void act(item, 'tier', { tier: t });
      }, busy.has(item.id));
      pick.classList.add('brief-tier');
      for (const r of pick.querySelectorAll<HTMLElement>('[role="radio"]')) r.classList.add('os-focus');
      li.append(pick);
    }
    if (capOpen && item.kind === 'usage' && item.actions.includes('cap')) {
      const cap = capField(item);
      const set = cap.querySelector<HTMLElement>('.brief-cap-set');
      const cancel = cap.querySelector<HTMLElement>('.brief-cap-cancel');
      set?.classList.remove('textbtn');
      cancel?.classList.remove('textbtn');
      if (set) weighKey(set, 'spend');
      if (cancel) weighKey(cancel, 'look');
      // An input draws no ::after, so its focus is an outline of its own (brief.css), not the .os-focus ring.
      cap.querySelector('.brief-cap-input')?.classList.add('os-figs');
      li.append(cap);
    }
    if (whyOpen.has(item.id)) {
      const btn = line.querySelector<HTMLElement>('.brief-act[data-action="why"]');
      const box = el('div', 'brief-why');
      box.id = btn?.dataset.controls ?? `brief-why-${(whyIds += 1)}`;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `Why: ${headOf(item)}`);
      const got = whyOf.get(item.id);
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
    // The lock follows the row under the pointer, then the one holding focus.
    li.addEventListener('pointerenter', () => {
      hoverId = item.id;
      aim();
    });
    li.addEventListener('pointerleave', () => {
      if (hoverId === item.id) hoverId = null;
      aim();
    });
    li.addEventListener('focusin', () => {
      focusId = item.id;
      aim();
    });
    li.addEventListener('focusout', (e) => {
      if (focusId === item.id && !li.contains(e.relatedTarget as Node | null)) focusId = null;
      aim();
    });
    return li;
  }

  /** The item the lock is on: the hovered target, else the focused one, else the autonomy ask, else the first. */
  function activeId(): string | null {
    const has = (id: string | null): id is string => !!id && targets.some((t) => t.id === id);
    if (has(hoverId)) return hoverId;
    if (has(focusId)) return focusId;
    return (targets.find((t) => t.tone === 'grant') ?? targets[0])?.id ?? null;
  }

  /** Puts the lock on the active item and marks its row; nothing is written when neither moved. */
  function aim(): void {
    const id = activeId();
    const r = id ? rows.get(id)?.el ?? null : null;
    if (id === activeWas.id && r === activeWas.row) return;
    activeWas.row?.classList.remove('is-active');
    r?.classList.add('is-active');
    activeWas = { id, row: r };
    pins.setActive(id, r);
  }

  /** The pins' targets: the open waiting items with a district, numbered in list order. */
  function pinTargets(open: BriefItem[]): PinTarget[] {
    const out: PinTarget[] = [];
    for (const item of open) {
      if (!item.repo) continue;
      const first = itemReadouts(item, names)[0];
      // A proposal's tower names what posting it would cost, as its Post key does (ruling: the cost, not the tier).
      const cost = item.figures?.kind === 'proposal' ? keySum(item, 'accept') ?? (Number.isFinite(item.figures.cost) && item.figures.cost > 0 ? `${creditsText(item.figures.cost)} cr` : null) : null;
      out.push({
        id: item.id,
        n: out.length + 1,
        repo: item.repo,
        name: cleanText(item.repo.split('/').pop() ?? item.repo, 80),
        figure: cost ?? (first ? `${first.v}${first.k ? ` ${first.k}` : ''}` : ''),
        tone: pinToneOf(item),
      });
    }
    return out;
  }

  /** The head: the since line, typed in once each time the Brief opens, the three figures and the two windows. */
  function drawHead(b: Brief, first: boolean): void {
    const s = sinceLine(b.since, b.day, first);
    if (s !== sinceText || typeSince) {
      sinceText = s;
      sinceStop?.();
      sinceStop = s ? typedLine(since, s, typeSince) : null;
      if (!s) since.replaceChildren();
      since.hidden = !s;
      typeSince = false;
    }
    const five = windowNowPct(b.usage.fiveHour);
    const seven = windowNowPct(b.usage.sevenDay);
    const fiveCap = b.usage.todayCapPct ?? b.usage.fiveHour.capPct ?? settings.dayCapPct;
    const hf = headFigures(b);
    const key = JSON.stringify([hf, five, seven, fiveCap, b.usage.sevenDay.capPct]);
    if (key === headKey) return;
    headKey = key;
    figs.replaceChildren(...hf.map((x) => figure(x.value, x.label, x.tone)));
    ranges.replaceChildren(rangefinder('five-hour', five, fiveCap), rangefinder('seven-day', seven, b.usage.sevenDay.capPct));
    const over = (five !== null && five >= fiveCap) || (seven !== null && seven >= b.usage.sevenDay.capPct);
    ranges.setAttribute('aria-label', `The treasury: ${usageLine(b.usage, settings.dayCapPct)}${over ? ' Over the limit.' : ''}`);
  }

  // ---------------------------------------------------------------- the page

  /** Sets a list's rows to `items`, reusing each row whose item and state are unchanged, and keeping focus in a row redrawn. */
  function fill(into: HTMLElement, items: BriefItem[], now: number, seen: Set<string>, numbers: Map<string, number>): void {
    const b = brief!;
    const want: HTMLElement[] = [];
    for (const item of items) {
      seen.add(item.id);
      const n = numbers.get(item.id) ?? null;
      const key = JSON.stringify([item, n, busy.has(item.id), errors.get(item.id), quiet.get(item.id), whyOpen.has(item.id), whyOf.get(item.id) === 'reading', tierOpen.has(item.id), item.kind === 'usage' && capOpen, b.usage.todayCapPct, settings, names.firm(item.refs.firmId ?? '')]);
      const had = rows.get(item.id);
      if (had && had.key === key) {
        want.push(had.el);
        continue;
      }
      const focused = had?.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
      const next = row(item, now, n);
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

  function render(): void {
    if (!sheet.shown || !brief) return;
    const b = brief;
    const now = Date.now();
    const t = briefTitle(b.day);
    if (title.textContent !== t) title.textContent = t;
    const leadText = cleanText(b.lead, 600);
    if (lead.textContent !== leadText) lead.textContent = leadText;
    const first = firstHere ?? b.firstOpen;
    sheet.root.dataset.first = String(first);
    drawHead(b, first);
    const usageText = usageLine(b.usage, settings.dayCapPct);
    if (usage.textContent !== usageText) usage.textContent = usageText;
    const items = allItems(b);
    // An empty morning: the one line, and the lead's own sentence for the reader.
    empty.hidden = items.length > 0;
    empty.textContent = `${emptyMorning()}.`;
    const seen = new Set<string>();
    const groups = waitingGroups(b.sections.waiting);
    // The autonomy ask leads what waits: it is the heaviest decision on the page, so it stands first, in its brackets.
    const isAsk = (i: BriefItem): boolean => i.kind === 'autonomy' && i.actions.includes('grant');
    const open = [...groups.open.filter(isAsk), ...groups.open.filter((i) => !isAsk(i))];
    const handled = groups.handled;
    const next = pinTargets(open);
    const numbers = new Map(next.map((x) => [x.id, x.n]));
    for (const [k] of SECTIONS) {
      const s = secs.get(k)!;
      const list = b.sections[k];
      s.box.hidden = list.length === 0;
      const count = String(k === 'waiting' ? open.length : list.length).padStart(2, '0');
      if (s.count.textContent !== count) s.count.textContent = count;
      // What an audit does is said once, under the section that offers it.
      const due = list.some((i) => i.kind === 'audit-due');
      s.key.hidden = !due;
      if (due) s.key.textContent = 'An audit reads a fresh clone in a sandbox and proposes jobs where the README and the code part. Nothing runs until you post one.';
      // Waiting on you: the rows that need a click, then what he settled today in a quieter list of its own.
      if (k === 'waiting') {
        s.list.hidden = open.length === 0;
        handledHead.hidden = handled.length === 0;
        handledList.hidden = handled.length === 0;
        fill(s.list, open, now, seen, numbers);
        fill(handledList, handled, now, seen, numbers);
      } else fill(s.list, list, now, seen, numbers);
    }
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    panel.setStream(streamWords(b, names));
    const key = JSON.stringify(next);
    if (key !== pinKey) {
      pinKey = key;
      targets = next;
      pins.setTargets(next);
    }
    aim();
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
        typeSince = true;
        sheet.show();
        pins.show();
        unlisten = opts.listen(onEvent);
      }
      render();
      read();
    },
    hide() {
      sheet.hide();
      pins.hide();
      unlisten?.();
      unlisten = null;
      sinceStop?.();
      sinceStop = null;
      for (const stop of typing.splice(0)) stop();
      pins.setActive(null, null);
      whyOpen.clear();
      tierOpen.clear();
      capOpen = false;
      quiet.clear();
      errors.clear();
      rows.clear();
      hoverId = null;
      focusId = null;
      activeWas = { id: null, row: null };
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
