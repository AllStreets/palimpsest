/**
 * The README audit (Phase 3 Task 10): what a README promises against what
 * the code does, read as a ledger of claims. Each claim carries its verdict
 * as a word in small capitals beside a drawn mark (a full square for real,
 * half of one for partial, an empty one for missing, a hatched one for
 * stubbed, a struck one for broken), whether a test stands behind it, its
 * evidence as `file:line` links to GitHub at the commit the audit read, and
 * the job it proposes with Accept, a tier and Dismiss while that job waits
 * on him. The same block stands on the district page and on the audit's own
 * page (#/audits/:id).
 *
 * Every string here was written by a model reading his README, so it is
 * only ever set as text (`cleanText`), and only `evidenceHref` makes links.
 */
import { TIER_VALUE } from '../../../shared/market-rules';
import type { AuditView, Evidence, Finding, FirmView, Job, Tier, Verdict } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { auditStage, canProposeAgain, evidenceHref, evidenceText, leadOf, proposalWord, verdictMark, verdictWord } from './audit-words';
import { cleanText, money } from './board';
import { button, checkRadio, el, rovingRadios, textButton } from './controls';
import type { Names } from './detail';
import { coalesce, detailSheet, keyedSlot, namesOf, refusal, setTrail } from './pages';
import { longDate } from './story';
import './market.css';

export { verdictMark, verdictWord } from './audit-words';

const SVG = 'http://www.w3.org/2000/svg';

/** A square drawn by hand: the corners a little off true, so the marks read as a pen's, not a checkbox's. */
const SQUARE = 'M1.3 1.6 L8.8 1.2 L9.1 8.7 L1.5 9.1 Z';
const DRAWN: Record<ReturnType<typeof verdictMark>, Array<{ d: string; fill?: boolean; thin?: boolean; bold?: boolean }>> = {
  full: [{ d: SQUARE, fill: true }],
  // The left half filled: what stands, beside what does not.
  half: [{ d: SQUARE }, { d: 'M1.3 1.6 L5.1 1.4 L5.3 8.9 L1.5 9.1 Z', fill: true }],
  empty: [{ d: SQUARE }],
  // Fine hatching, as a draughtsman shades a placeholder: three light strokes.
  hatched: [{ d: SQUARE }, { d: 'M1.4 4.6 L4.7 1.4 M1.5 8.2 L8.4 1.3 M4.9 9 L9 5', thin: true }],
  // One firm stroke corner to corner: struck out.
  struck: [{ d: SQUARE }, { d: 'M1.6 8.9 L8.9 1.4', bold: true }],
};

/** The verdict's mark as a small drawn figure; the word beside it says it in letters. */
export function markOf(v: Verdict): SVGSVGElement {
  const mark = verdictMark(v);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `verdict-mark mark-${mark}`);
  svg.setAttribute('viewBox', '0 0 10.4 10.4');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.mark = mark;
  for (const p of DRAWN[mark]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('class', p.fill ? 'mark-fill' : `mark-line${p.thin ? ' thin' : p.bold ? ' bold' : ''}`);
    svg.append(path);
  }
  return svg;
}

/** The verdict: its mark and its word in small capitals. */
export function verdictOf(v: Verdict): HTMLElement {
  const s = el('span', `verdict v-${verdictMark(v)}`);
  s.append(markOf(v), el('span', 'verdict-word', verdictWord(v)));
  return s;
}

/** The evidence as cited, a link to GitHub at the audited commit when it is one, plain text otherwise. */
export function evidenceRef(repo: string, sha: string | null, e: Evidence): HTMLElement {
  const text = cleanText(evidenceText(e), 200);
  const href = e.verified ? evidenceHref(repo, sha, e) : null;
  if (!href) return el('span', `claim-ref${e.verified ? '' : ' unfound'}`, text);
  const a = el('a', 'claim-evidence', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = `${text} at ${sha?.slice(0, 7)}, on GitHub`;
  return a;
}

/** The three tiers as a small radio group, each with what the city would pay. */
export function tierPicker(current: Tier, label: string, onTier: (t: Tier) => void, busy = false): HTMLElement {
  const group = el('span', 'prop-tier');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const t of ['low', 'normal', 'high'] as Tier[]) {
    const b = el('button', 'prop-tier-choice');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.tier = t;
    b.title = `${t.charAt(0).toUpperCase()}${t.slice(1)} tier: the city pays at most ${TIER_VALUE[t]} credits`;
    b.append(el('span', 'prop-tier-name', t), el('span', 'prop-tier-value', money(TIER_VALUE[t])));
    b.addEventListener('click', () => pick(b));
    group.append(b);
  }
  const pick = (b: HTMLElement): void => {
    if (busy) return;
    const t = b.dataset.tier as Tier;
    checkRadio(group, b);
    if (t !== current) onTier(t);
  };
  rovingRadios(group, pick);
  checkRadio(group, group.querySelector(`[data-tier="${current}"]`));
  return group;
}

export interface AuditBlockOptions {
  onAccept(jobId: string): void;
  onDismiss(jobId: string): void;
  onTier(jobId: string, tier: Tier): void;
  /** "Propose again" beside a merged or dismissed proposal. */
  onProposeAgain?(jobId: string): void;
  /** Stop beside a live audit. */
  onStop?(auditId: string): void;
  /** Proposals with a request in flight. */
  busy?: ReadonlySet<string>;
  /** The engine's refusal of an action, by job id (or the audit's id for Stop), shown in place. */
  errors?: ReadonlyMap<string, string>;
  /** Every job on the repo as last read, so "Propose again" weighs a newer job on the key from another audit; the audit's own proposals when absent. */
  jobs?: readonly Job[];
  /** False sets the block as the last audit while a new one waits or reads: its lead steps aside. */
  lead?: boolean;
}

/** "Read 11 November 2026 on claude:sonnet at 872bfe8, 23.4 credits charged to the city." */
function colophon(v: AuditView, last = false): HTMLElement {
  const p = el('p', `audit-colophon${last ? ' last' : ''}`);
  const when = v.endedAt ?? v.startedAt;
  const parts: Array<string | Node> = [`${last ? 'The last audit: ' : ''}${v.endedAt ? 'Read' : 'Started'} ${longDate(when)}`];
  if (v.model) parts.push(` on ${cleanText(v.model, 60)}`);
  if (v.baseSha && /^[0-9a-f]{7,40}$/.test(v.baseSha)) {
    parts.push(' at ');
    const sha = el('a', 'audit-sha', v.baseSha.slice(0, 7));
    const [owner, name] = v.repo.split('/');
    sha.href = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name ?? '')}/tree/${v.baseSha}`;
    sha.target = '_blank';
    sha.rel = 'noopener noreferrer';
    sha.title = 'The commit the audit read, on GitHub';
    parts.push(sha);
  }
  if (v.credits > 0) parts.push(`, ${money(Math.round(v.credits * 100) / 100)} credits charged to the city`);
  parts.push(v.trigger === 'connect' ? ". It ran by itself the first time this repo's market was turned on." : '.');
  p.append(...parts);
  return p;
}

/** A finding's proposal: its title, then Accept, a tier and Dismiss while it waits on him, or where its job stands. */
function proposalLine(v: AuditView, f: Finding, opts: AuditBlockOptions): HTMLElement | null {
  const p = f.proposal;
  if (!p) return null;
  const j: Job | null = (p.jobId ? v.proposals.find((x) => x.id === p.jobId) : null) ?? null;
  const box = el('div', 'claim-proposal');
  if (j) {
    box.dataset.job = j.id;
    box.dataset.state = j.status;
    if (opts.busy?.has(j.id)) box.setAttribute('aria-busy', 'true');
  } else box.dataset.state = 'none';
  const head = el('p', 'prop-head');
  head.append(el('span', 'prop-label', 'Proposed'));
  const title = cleanText(j?.title ?? p.title, 160) || 'Untitled';
  if (j) {
    const a = el('a', 'prop-title', title);
    a.href = placeHref('job', j.id);
    head.append(a);
  } else head.append(el('span', 'prop-title', title));
  box.append(head);
  const line = el('div', 'prop-act');
  if (j?.status === 'proposed') {
    const accept = button('prop-accept', 'Accept', () => opts.onAccept(j.id));
    accept.setAttribute('aria-label', `Accept: ${title}`);
    const dismiss = textButton('prop-dismiss', 'Dismiss', () => opts.onDismiss(j.id));
    dismiss.setAttribute('aria-label', `Dismiss: ${title}`);
    line.append(accept, tierPicker(j.tier, `Tier for ${title}`, (t) => opts.onTier(j.id, t), opts.busy?.has(j.id)), dismiss);
    line.append(el('span', 'prop-word', 'waiting on you; no firm bids until you accept it'));
  } else {
    line.append(el('span', 'prop-word', `${proposalWord(j)}${j && j.status !== 'withdrawn' ? `, ${j.tier} tier, ${money(j.value)} credits` : ''}`));
    if (j && opts.onProposeAgain && canProposeAgain(j, [...(opts.jobs ?? []), ...v.proposals])) {
      const again = textButton('prop-again', 'Propose again', () => opts.onProposeAgain!(j.id));
      again.setAttribute('aria-label', `Propose again: ${title}`);
      line.append(again);
    }
  }
  box.append(line);
  const err = j ? opts.errors?.get(j.id) : undefined;
  if (err) {
    const e = el('p', 'job-error', err);
    e.setAttribute('role', 'alert');
    box.append(e);
  }
  return box;
}

/** One claim of the README: the verdict in the margin, the claim, what shows it, and its proposal. */
function claimRow(v: AuditView, f: Finding, opts: AuditBlockOptions): HTMLElement {
  const li = el('li', `claim v-${verdictMark(f.verdict)}${f.unverified ? ' unverified' : ''}`);
  li.dataset.finding = f.id;
  li.dataset.verdict = f.verdict;
  li.append(verdictOf(f.verdict));
  const main = el('div', 'claim-main');
  main.append(el('p', 'claim-text', cleanText(f.claim, 400)));
  const meta = el('p', 'claim-meta');
  meta.append(el('span', `claim-tested${f.tested ? ' yes' : ''}`, f.tested ? 'tested' : 'untested'));
  const refs = el('span', 'claim-refs');
  const shown = f.evidence.slice(0, 3);
  if (f.unverified) refs.append(el('span', 'claim-unfound', 'evidence not found at the commit: '));
  shown.forEach((e, i) => {
    if (i > 0) refs.append(document.createTextNode(', '));
    refs.append(evidenceRef(v.repo, v.baseSha, e));
  });
  if (shown.length) meta.append(refs);
  if (f.source?.line) meta.append(el('span', 'claim-source', `README line ${f.source.line}`));
  main.append(meta);
  // The gaps say what the audit saw; a real claim's evidence speaks for itself.
  if (f.verdict !== 'REAL' || f.unverified) {
    const note = cleanText(f.evidence.find((e) => e.verified && e.note)?.note ?? f.evidence.find((e) => e.note)?.note ?? '', 300);
    // The note as the audit wrote it (it may open with a name from the code, so its case is left alone).
    if (note) main.append(el('p', 'claim-note', note.replace(/[.!?]?$/, '.')));
  }
  const prop = proposalLine(v, f, opts);
  if (prop) main.append(prop);
  li.append(main);
  return li;
}

/**
 * An audit as a block: the lead, then how it was read, then the claims as a
 * ledger in the README's order. A waiting audit shows why it waits; a live
 * one its stage and a Stop. `_names` (the firms' names) is the signature
 * the brief's items share; the block itself names no firm.
 */
export function renderAuditBlock(v: AuditView, _names: Names, opts: AuditBlockOptions): HTMLElement {
  const block = el('div', `audit-block status-${v.status}`);
  block.dataset.audit = v.id;
  block.dataset.status = v.status;
  const stage = auditStage(v);
  if (stage) {
    const line = el('div', 'audit-stage-line');
    line.append(el('p', 'audit-stage', stage));
    if (v.status !== 'waiting' && opts.onStop) line.append(textButton('audit-stop', 'Stop', () => opts.onStop!(v.id)));
    block.append(line);
    const err = opts.errors?.get(v.id);
    if (err) {
      const e = el('p', 'job-error', err);
      e.setAttribute('role', 'alert');
      block.append(e);
    }
    if (v.status === 'waiting') block.append(el('p', 'audit-note', 'It starts when a Claude slot and the caps allow, reads the README at the repo’s head commit and charges what it spends to the city.'));
    return block;
  }
  // While a new audit waits or reads, the last one stands below it without its lead, which the new one is about to replace.
  if (opts.lead !== false) block.append(el('p', 'audit-lead', leadOf(v)));
  block.append(colophon(v, opts.lead === false));
  if (!v.findings.length) return block;
  const list = el('ol', 'audit-claims');
  list.setAttribute('aria-label', `Claims in the README of ${cleanText(v.repo, 120)}`);
  for (const f of v.findings) list.append(claimRow(v, f, opts));
  block.append(list);
  return block;
}

/** Whether an event is about this audit or one of its proposals. */
export function touchesAudit(e: EngineEvent, auditId: string, jobIds: ReadonlySet<string>): boolean {
  const d = (e.data ?? {}) as Record<string, any>;
  const id = d.auditId ?? d.audit?.id ?? null;
  if (id === auditId) return true;
  const j = d.job as Job | undefined;
  return !!j && (jobIds.has(j.id) || j.proposal?.auditId === auditId);
}

// ---------------------------------------------------------------- the audit's own page

export interface AuditPage {
  show(id: string): void;
  hide(): void;
}

/**
 * The audit's own page (#/audits/:id): the same block as the district page
 * shows, under the trail "Repos, <repo>, audit of <date>", with every
 * action in place. Reads afresh on every change to the audit or its jobs.
 */
export function createAuditPage(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): AuditPage {
  const sheet = detailSheet(parent, 'auditpage', opts.onDismiss);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  sheet.body.append(trouble);
  const slot = keyedSlot(sheet.body);
  let id: string | null = null;
  let view: AuditView | null = null;
  let firms: FirmView[] = [];
  let repoJobs: Job[] = [];
  let unlisten: (() => void) | null = null;
  const busy = new Set<string>();
  const errors = new Map<string, string>();

  const read = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const [v, fs] = await Promise.all([api.audit(want), firms.length ? Promise.resolve(firms) : api.firms().catch(() => [] as FirmView[])]);
      const js = await api.jobs({ repo: v.repo }).catch(() => [] as Job[]);
      if (want !== id) return;
      view = v;
      repoJobs = js;
      firms = fs;
      trouble.hidden = true;
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof Error && /unknown audit/.test(err.message) ? 'There is no such audit. It may belong to another city.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  async function act(key: string, what: string, call: () => Promise<unknown>): Promise<void> {
    if (busy.has(key)) return;
    busy.add(key);
    errors.delete(key);
    render();
    try {
      await call();
    } catch (err) {
      errors.set(key, refusal(what, err));
    } finally {
      busy.delete(key);
      render();
      read();
    }
  }

  const actions: AuditBlockOptions = {
    onAccept: (j) => void act(j, 'Accept', () => api.acceptJob(j)),
    onDismiss: (j) => void act(j, 'Dismiss', () => api.dismissJob(j)),
    onTier: (j, t) => void act(j, 'Changing the tier', () => api.setJobTier(j, t)),
    onProposeAgain: (j) => void act(j, 'Propose again', () => api.proposeAgain(j)),
    onStop: (a) => void act(a, 'Stop', () => api.killAudit(a)),
    busy,
    errors,
  };

  function render(): void {
    if (!sheet.shown || !view) return;
    const v = view;
    const [, name] = v.repo.split('/');
    const date = longDate(v.endedAt ?? v.startedAt);
    setTrail(sheet.trail, [
      ['Repos', placeHref('repos')],
      [name ?? v.repo, placeHref('repo', v.repo)],
      [`audit of ${date}`, null],
    ]);
    const title = 'The README against the code';
    if (sheet.title.textContent !== title) sheet.title.textContent = title;
    sheet.sub.textContent = `${cleanText(v.repo, 120)}, ${v.trigger === 'connect' ? 'audited by itself when its market opened' : 'audited on your word'}.`;
    slot(JSON.stringify([v, repoJobs.map((j) => [j.id, j.status, j.key]), [...busy], [...errors]]), () => renderAuditBlock(v, namesOf(firms), { ...actions, jobs: repoJobs }));
  }

  function onEvent(e: EngineEvent): void {
    if (!id) return;
    if (e.type === 'engine.reconnected') return read();
    if (touchesAudit(e, id, new Set(view?.proposals.map((j) => j.id) ?? []))) read();
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        view = null;
        busy.clear();
        errors.clear();
        sheet.title.textContent = '';
        sheet.sub.textContent = '';
        slot('', () => null);
        sheet.body.scrollTop = 0;
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
      }
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
    },
  };
}
