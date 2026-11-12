import { legalMove, MAX_ATTEMPTS, TIER_VALUE } from '../../../shared/market-rules';
import type { AuditView, Bid, FirmView, Job, JobDetail, LedgerRow, RunView, Tier } from '../../../shared/types';
import { api, ApiError, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { bidOrder, cleanText, closesIn, githubUrl, money, pct, progressWords, stageOf } from './board';
import { ago, button, checkRadio, el, plural, rovingRadios, textButton } from './controls';
import { acceptanceTicks, awardRounds, issueBlocks, ledgerTrail, type Names, type Round, verdict } from './detail';
import { blockNodes, coalesce, detailSheet, keyedSlot, namesOf, outLink, pageLink, refusal, secHead, setTrail } from './pages';
import { evidenceRef, verdictOf } from './audit';
import { VERDICT_MEANING, whatToBuild } from './audit-words';
import { longDate } from './story';
import './market.css';

export interface JobPage {
  show(id: string): void;
  hide(): void;
}

export interface JobPageOptions {
  listen(fn: (e: EngineEvent) => void): () => void;
  onDismiss(): void;
  /** Whether a floor stands in the city now, so the page can fly to it. */
  floorStands(repo: string, floorId: string): boolean;
  /** Closes the page and flies the city to the floor. */
  flyToFloor(repo: string, floorId: string): void;
}

const shortName = (fullName: string): string => fullName.split('/')[1] ?? fullName;
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
const TIERS: Array<[Tier, string]> = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
];
const LIVE = new Set(['preparing', 'installing', 'working', 'inspecting', 'shipping']);

/** The engine's own rule: a job may be withdrawn unless its pull request is open. */
function withdrawable(j: Job): boolean {
  if (j.status === 'waiting' || (j.status === 'halted' && j.haltedFrom === 'waiting')) return false;
  return legalMove(j.status, 'withdrawn');
}

/** Where the job stands, in a sentence for the head. */
function standing(j: Job, run: RunView | null, names: Names): string {
  const by = run ? `${names.agent(run.agentId)} of ${names.firm(run.firmId)}` : '';
  switch (j.status) {
    case 'proposed':
      return 'Proposed by the city. No firm bids on it until you accept it on the board.';
    case 'open':
      return 'Open, waiting for its round of bids to open.';
    case 'bidding':
      return `Taking bids: ${closesIn(j.bidsCloseAt, Date.now())}.`;
    case 'awarded':
      return `Awarded${by ? ` to ${by}` : ''}. The run starts once a work slot and the site are free.`;
    case 'running':
    {
      const what = run?.stage === 'working' ? 'is working on it in a sandboxed copy of the repo' : run?.stage === 'installing' ? 'is installing the repo’s dependencies' : run?.stage === 'preparing' ? 'is setting up a copy of the repo' : 'is at work';
      return `${by || 'An agent'} ${what}${run ? `, started ${ago(Date.parse(run.startedAt))}` : ''}.`;
    }
    case 'inspecting':
      return `With the inspectors${by ? `: the work of ${by}` : ''}.`;
    case 'shipping':
      return 'Passed inspection; the city is opening its pull request.';
    case 'waiting':
      return 'Passed inspection and waiting on you: merge or close its pull request on GitHub.';
    case 'merged':
      return `Merged${j.closedAt ? ` ${ago(Date.parse(j.closedAt))}` : ''}${by ? `, built by ${by}` : ''}.`;
    case 'closed':
      return 'Closed without merging. Nothing was paid.';
    case 'failed':
      return j.attempts < MAX_ATTEMPTS ? `Failed on ${plural(j.attempts, 'attempt')} of ${MAX_ATTEMPTS}. Repost it to give another firm a go.` : `Failed on both attempts; the issue is labelled palimpsest:failed.`;
    case 'halted':
      return `Halted${j.haltNote ? `: ${cleanText(j.haltNote, 200)}` : '.'}`;
    case 'withdrawn':
      return 'Withdrawn.';
    default:
      return '';
  }
}

/**
 * A job's own page (#/jobs/:id): the issue as it was written, each round of
 * bids with the award said in prose and who sat out, every attempt at the
 * work with its run and inspection, the floor it laid (fly to it), and the
 * ledger trail as a dated list. Withdraw, repost, the tier (while proposed
 * or open) and kill (while running) are actions on the engine; a refusal
 * says the engine's reason. Updates from the event stream.
 */
export function createJobPage(parent: HTMLElement, opts: JobPageOptions): JobPage {
  const sheet = detailSheet(parent, 'jobpage', opts.onDismiss);
  const body = sheet.body;
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  body.append(trouble);
  const slots = {
    head: keyedSlot(sheet.actions),
    why: keyedSlot(body),
    issue: keyedSlot(body),
    terms: keyedSlot(body),
    bids: keyedSlot(body),
    work: keyedSlot(body),
    floor: keyedSlot(body),
    ledger: keyedSlot(body),
  };

  let id: string | null = null;
  let detail: JobDetail | null = null;
  /** The audit a proposal came from, for the claim behind it. */
  let audit: AuditView | null = null;
  let firms: FirmView[] = [];
  let names: Names = namesOf([]);
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let error = '';
  let asking: 'withdraw' | 'kill' | null = null;
  let busy = false;

  const liveRun = (): RunView | null => detail?.runs.find((r) => r.outcome === null && LIVE.has(r.stage)) ?? null;
  const currentRun = (): RunView | null => (detail ? (detail.runs.find((r) => r.id === detail!.job.runId) ?? detail.runs.at(-1) ?? null) : null);

  const read = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const [d, fs] = await Promise.all([api.job(want), firms.length ? Promise.resolve(firms) : api.firms().catch(() => [] as FirmView[])]);
      const auditId = d.job.proposal?.auditId ?? null;
      const a = auditId ? await api.audit(auditId).catch(() => (audit?.id === auditId ? audit : null)) : null;
      if (want !== id) return;
      detail = d;
      audit = a;
      firms = fs;
      names = namesOf(fs);
      trouble.hidden = true;
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof Error && /unknown job/.test(err.message) ? 'There is no such job. It may belong to another city.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (!id) return;
    if (e.type === 'engine.reconnected') return read();
    const d = (e.data ?? {}) as Record<string, any>;
    const runIds = new Set(detail?.runs.map((r) => r.id) ?? []);
    const jobId = d.job?.id ?? d.jobId ?? d.bid?.jobId ?? d.satOut?.jobId ?? d.run?.jobId ?? d.inspection?.jobId ?? d.site?.jobId ?? null;
    const runId = d.runId ?? d.run?.id ?? d.inspection?.runId ?? null;
    if (e.type === 'run.log') return;
    if (e.type === 'run.progress' && runIds.has(runId) && detail) {
      // Counts only: the work section redraws its line without a read.
      const r = detail.runs.find((x) => x.id === runId);
      if (r && d.progress) r.progress = d.progress;
      render();
      return;
    }
    if (jobId === id || (runId && runIds.has(runId))) read();
    else if (e.type === 'agent.hired' || e.type === 'firm.bankrupt' || e.type === 'tower.sold') {
      firms = [];
      read();
    }
  }

  async function act(what: string, call: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    render();
    try {
      await call();
    } catch (err) {
      error = refusal(what, err);
    } finally {
      busy = false;
      asking = null;
      render();
      read();
    }
  }

  // ---------------------------------------------------------------- the head

  function headActions(j: Job): HTMLElement | null {
    const wrap = el('div', 'detail-actions-row');
    if (busy) wrap.setAttribute('aria-busy', 'true');
    const live = liveRun();
    if (asking === 'withdraw') {
      wrap.append(
        el('span', 'detail-ask', live ? 'Withdraw it and stop the run? The work so far is thrown away.' : 'Withdraw this job? It leaves the board.'),
        button('job-yes', 'Withdraw', () => void act('Withdraw', () => api.withdrawJob(j.id))),
        textButton('job-no', 'Keep it', () => {
          asking = null;
          render();
        }),
      );
    } else if (asking === 'kill' && live) {
      wrap.append(
        el('span', 'detail-ask', 'Stop the run? What it made is thrown away, and the job goes back on the board without spending an attempt.'),
        button('job-kill-yes', 'Stop the run', () => void act('Kill', () => api.killRun(live.id))),
        textButton('job-no', 'Let it work', () => {
          asking = null;
          render();
        }),
      );
    } else {
      if (live) {
        wrap.append(
          button('job-kill', 'Kill the run', () => {
            asking = 'kill';
            render();
            sheet.actions.querySelector<HTMLElement>('.job-no')?.focus({ preventScroll: true });
          }),
        );
      }
      if (j.status === 'failed' && j.attempts < MAX_ATTEMPTS) wrap.append(button('job-repost', 'Repost', () => void act('Repost', () => api.repostJob(j.id))));
      if (j.status === 'proposed' || j.status === 'open') wrap.append(tierControl(j));
      if (withdrawable(j)) {
        wrap.append(
          textButton('job-withdraw-act', 'Withdraw', () => {
            asking = 'withdraw';
            render();
            sheet.actions.querySelector<HTMLElement>('.job-no')?.focus({ preventScroll: true });
          }),
        );
      }
    }
    const out = el('div', 'detail-actions-wrap');
    if (wrap.childElementCount) out.append(wrap);
    if (error) {
      const p = el('p', 'job-error', error);
      p.setAttribute('role', 'alert');
      out.append(p);
    }
    return out.childElementCount ? out : null;
  }

  function tierControl(j: Job): HTMLElement {
    const box = el('div', 'job-tier');
    box.append(el('span', 'job-tier-label', 'Tier'));
    const group = el('div', 'post-tiers job-tiers');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Tier');
    for (const [t, name] of TIERS) {
      const b = el('button', 'quality-choice post-tier');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.tier = t;
      b.append(el('span', 'quality-mark'), el('span', 'quality-name', name), el('span', 'quality-what', `${TIER_VALUE[t]} credits`));
      b.addEventListener('click', () => choose(b));
      group.append(b);
    }
    const choose = (b: HTMLElement): void => {
      const t = b.dataset.tier as Tier;
      if (t === j.tier) return;
      checkRadio(group, b);
      void act('Changing the tier', () => api.setJobTier(j.id, t));
    };
    rovingRadios(group, choose);
    checkRadio(group, group.querySelector(`[data-tier="${j.tier}"]`));
    box.append(group);
    return box;
  }

  // ---------------------------------------------------------------- the issue

  function issueSection(j: Job): HTMLElement {
    const sec = el('section', 'detail-sec job-issue');
    const url = githubUrl(j.url);
    const aside = j.source === 'issue' && j.issue !== null ? (url ? outLink('job-issue-link', `Issue #${j.issue} on GitHub`, url) : el('span', 'job-issue-link', `Issue #${j.issue}`)) : j.source === 'manual' ? 'posted by you' : 'proposed by the city';
    // A proposal's body opens with its claim and evidence, which "Why the city proposes this" sets above; here, what to build.
    const build = j.proposal ? whatToBuild(j.body) : null;
    sec.append(secHead(build ? 'What to build' : 'The issue', aside));
    if (build?.again) sec.append(el('p', 'job-again', 'Proposed again: the merge did not close it.'));
    const blocks = issueBlocks(build ? build.text : j.body);
    const prose = el('div', 'md');
    if (blocks.length) prose.append(...blockNodes(blocks));
    else prose.append(el('p', 'md-p quiet', 'No details beyond the title.'));
    sec.append(prose);
    return sec;
  }

  // ---------------------------------------------------------------- why the city proposes it

  function whySection(j: Job, a: AuditView | null): HTMLElement | null {
    const p = j.proposal;
    if (!p) return null;
    const sec = el('section', 'detail-sec job-why');
    const still = j.status === 'proposed' || j.status === 'open';
    const link = el('a', 'why-audit-link', a ? `README audit of ${longDate(a.endedAt ?? a.startedAt)}` : 'its README audit');
    link.href = placeHref('audit', p.auditId);
    sec.append(secHead(still ? 'Why the city proposes this' : 'Why the city proposed this', link));
    const f = a?.findings.find((x) => x.id === p.findingId);
    if (!a || !f) {
      sec.append(el('p', 'detail-quiet', a ? 'The finding behind it is no longer in its audit.' : 'The audit behind it could not be read.'));
      return sec;
    }
    const claim = el('blockquote', 'why-claim');
    claim.append(el('p', 'why-claim-text', cleanText(f.claim, 400)));
    const where = f.source?.file ? `${cleanText(f.source.file, 120)}${f.source.line ? `, line ${f.source.line}` : ''}` : 'the README';
    claim.append(el('cite', 'why-claim-source', `${cleanText(j.repo, 120)}, ${where}`));
    sec.append(claim);
    const said = el('p', 'why-verdict');
    const meaning = VERDICT_MEANING[f.verdict];
    said.append(verdictOf(f.verdict), el('span', 'why-verdict-text', `${meaning.charAt(0).toUpperCase()}${meaning.slice(1)}${f.tested ? '' : ', and no test covers it'}.`));
    sec.append(said);
    const ev = el('ul', 'why-evidence');
    for (const e of f.evidence.slice(0, 3)) {
      const li = el('li', `why-ev${e.verified ? '' : ' unfound'}`);
      li.append(evidenceRef(j.repo, a.baseSha, e));
      const note = cleanText(e.note, 300);
      if (note) li.append(el('span', 'why-ev-note', note.replace(/[.!?]?$/, '.')));
      if (!e.verified) li.append(el('span', 'why-ev-note', 'Not found at the commit.'));
      ev.append(li);
    }
    sec.append(ev);
    return sec;
  }

  // ---------------------------------------------------------------- scope and acceptance

  /**
   * The scope and the checklist. While the job is proposed or open each is
   * a list he can edit in place, one glob or line a row; Save sends both
   * through the engine, which refuses a denied glob with its reason, shown
   * here as it says it. Read only once bidding opens.
   */
  function termsSection(j: Job): HTMLElement {
    const editable = j.status === 'proposed' || j.status === 'open';
    if (editable) return termsEditor(j);
    const terms = el('div', 'job-terms');
    const scope = el('div', 'job-term');
    scope.append(el('h3', 'job-term-head', 'Scope'), el('p', 'job-term-note', 'The files the change may touch. Anything else fails the scope check.'));
    const globs = el('ul', 'job-globs');
    for (const g of j.scope.length ? j.scope : ['**']) globs.append(el('li', 'job-glob', g === '**' ? '** (the whole repo)' : cleanText(g, 200)));
    scope.append(globs);
    const done = el('div', 'job-term');
    done.append(el('h3', 'job-term-head', 'Done when'), el('p', 'job-term-note', 'What the reviewer checks the change against.'));
    const list = el('ul', 'job-checklist');
    for (const a of acceptanceTicks(j.body, j.acceptance)) {
      const li = el('li', a.ticked ? 'ticked' : '');
      const box = el('i', 'job-box');
      box.setAttribute('aria-hidden', 'true');
      li.append(box, el('span', '', a.text));
      list.append(li);
    }
    done.append(list);
    terms.append(scope, done);
    return terms;
  }

  function termsEditor(j: Job): HTMLElement {
    const terms = el('div', 'job-terms editable');
    type Kind = 'scope' | 'acceptance';
    const saved: Record<Kind, string[]> = { scope: j.scope.length ? [...j.scope] : ['**'], acceptance: [...j.acceptance] };
    const lists: Record<Kind, string[]> = { scope: [...saved.scope], acceptance: [...saved.acceptance] };
    const uls = {} as Record<Kind, HTMLUListElement>;
    const adds = {} as Record<Kind, HTMLInputElement>;
    const foot = el('div', 'terms-foot');
    const save = button('terms-save', 'Save', () => void commit());
    const discard = textButton('terms-discard', 'Discard', () => {
      lists.scope = [...saved.scope];
      lists.acceptance = [...saved.acceptance];
      why.textContent = '';
      draw('scope');
      draw('acceptance');
      sync();
    });
    const why = el('p', 'terms-why');
    why.id = `terms-why-${j.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    why.setAttribute('aria-live', 'polite');
    foot.append(save, discard, why);
    let saving = false;

    const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);
    const fit = (t: HTMLTextAreaElement): void => {
      t.style.height = 'auto';
      t.style.height = `${t.scrollHeight}px`;
    };
    const dirty = (): boolean => JSON.stringify(clean(lists.scope)) !== JSON.stringify(saved.scope) || JSON.stringify(clean(lists.acceptance)) !== JSON.stringify(saved.acceptance);
    function sync(): void {
      const d = dirty();
      foot.hidden = !d && !why.textContent;
      save.hidden = !d;
      discard.hidden = !d;
      save.disabled = saving;
    }

    function draw(kind: Kind): void {
      const ul = uls[kind];
      ul.replaceChildren();
      lists[kind].forEach((v, i) => {
        const li = el('li', kind === 'scope' ? 'job-glob' : 'job-line-item');
        if (kind === 'acceptance') {
          const box = el('i', 'job-box');
          box.setAttribute('aria-hidden', 'true');
          li.append(box);
        }
        // A glob is one short line; a line of what done means wraps, and grows with what he writes.
        const input = kind === 'scope' ? el('input', 'term-input mono-field') : el('textarea', 'term-input term-line');
        if (input instanceof HTMLTextAreaElement) {
          input.rows = 1;
          requestAnimationFrame(() => fit(input));
        }
        input.value = v;
        input.dataset.list = kind;
        input.spellcheck = kind === 'acceptance';
        input.autocomplete = 'off';
        input.maxLength = kind === 'scope' ? 200 : 400;
        input.setAttribute('aria-label', kind === 'scope' ? `Glob ${i + 1} of the scope` : `Line ${i + 1} of what done means`);
        input.addEventListener('input', () => {
          if (input instanceof HTMLTextAreaElement) {
            input.value = input.value.replace(/\n/g, ' ');
            fit(input);
          }
          lists[kind][i] = input.value;
          li.classList.remove('refused');
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
          sync();
        });
        input.addEventListener('keydown', (e: Event) => {
          if ((e as KeyboardEvent).key === 'Enter') {
            e.preventDefault();
            if (dirty()) void commit();
          }
        });
        const x = textButton('term-remove', 'Remove', () => {
          lists[kind].splice(i, 1);
          draw(kind);
          sync();
          adds[kind].focus({ preventScroll: true });
        });
        x.setAttribute('aria-label', `Remove ${v || 'this line'}`);
        li.append(input, x);
        if (kind === 'scope' && v.trim() === '**') li.append(el('span', 'term-hint', 'the whole repo'));
        ul.append(li);
      });
    }

    function column(kind: Kind, title: string, note: string, placeholder: string): HTMLElement {
      const col = el('div', 'job-term');
      col.append(el('h3', 'job-term-head', title), el('p', 'job-term-note', note));
      const ul = el('ul', kind === 'scope' ? 'job-globs' : 'job-checklist');
      ul.setAttribute('aria-label', title);
      uls[kind] = ul;
      const add = el('input', `term-add${kind === 'scope' ? ' mono-field' : ''}`);
      add.dataset.list = kind;
      add.placeholder = placeholder;
      add.autocomplete = 'off';
      add.spellcheck = kind === 'acceptance';
      add.maxLength = kind === 'scope' ? 200 : 400;
      add.setAttribute('aria-label', kind === 'scope' ? 'Add a glob to the scope' : 'Add a line to what done means');
      add.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = add.value.trim();
          if (!v) {
            if (dirty()) void commit();
            return;
          }
          if (!lists[kind].map((x) => x.trim()).includes(v)) lists[kind].push(v);
          add.value = '';
          draw(kind);
          sync();
        } else if (e.key === 'Escape' && add.value) {
          e.preventDefault();
          e.stopPropagation();
          add.value = '';
        }
      });
      adds[kind] = add;
      const addRow = el('div', 'term-add-row');
      addRow.append(add);
      col.append(ul, addRow);
      draw(kind);
      return col;
    }

    async function commit(): Promise<void> {
      if (saving || !dirty()) return;
      saving = true;
      why.textContent = '';
      sync();
      try {
        const next = await api.setJobScope(j.id, { scope: clean(lists.scope), acceptance: clean(lists.acceptance) });
        if (detail && detail.job.id === next.id) detail = { ...detail, job: next };
        saving = false;
        render();
        // The editor is rebuilt from what was stored; the hand goes back to where the next glob is written.
        body.querySelector<HTMLElement>('.term-add[data-list="scope"]')?.focus({ preventScroll: true });
      } catch (err) {
        saving = false;
        const msg = err instanceof Error ? err.message : String(err);
        // The engine's reason, as it says it: "scope refused: **/.env is denied by .env".
        const reason = msg.replace(/^scope refused: /, '');
        why.textContent = err instanceof ApiError && err.status < 500 ? `Not saved: ${reason}` : `Saving failed: ${msg}`;
        for (const li of uls.scope.querySelectorAll<HTMLElement>('li')) {
          const input = li.querySelector<HTMLInputElement>('input');
          const bad = !!input && !!input.value.trim() && reason.startsWith(`${input.value.trim()} `);
          li.classList.toggle('refused', bad);
          if (bad) {
            input!.setAttribute('aria-invalid', 'true');
            input!.setAttribute('aria-describedby', why.id);
          } else {
            input?.removeAttribute('aria-invalid');
            input?.removeAttribute('aria-describedby');
          }
        }
        sync();
      }
    }

    terms.append(
      column('scope', 'Scope', 'The files the change may touch, one glob a row. Anything else fails the scope check. It can change until bidding opens.', 'Add a glob, such as src/export/**'),
      column('acceptance', 'Done when', 'What the reviewer checks the change against, one line a row.', 'Add a line'),
    );
    terms.append(foot);
    sync();
    return terms;
  }

  // ---------------------------------------------------------------- the bids

  function bidTable(bids: Bid[], chosen: string | null, caption: string): HTMLElement {
    const t = el('table', 'bids job-bids');
    t.append(el('caption', 'bids-cap', caption));
    const cols = el('colgroup');
    for (const c of ['firm', 'agent', 'price', 'conf', 'cal', 'ev']) cols.append(el('col', `col-${c}`));
    t.append(cols);
    const thead = el('thead');
    const hr = el('tr');
    for (const [text, cls, tip] of [
      ['Firm', 'c-firm', ''],
      ['Agent', 'c-agent', ''],
      ['Price', 'c-num', 'What the firm asked, in credits'],
      ['Stated', 'c-num', 'How sure the firm said it was that the work would pass'],
      ['Calibrated', 'c-num', "The stated chance, trimmed by how far the firm's past bids overclaimed"],
      ['EV', 'c-num', 'Expected value: the job’s worth times the calibrated chance, less the price'],
    ] as Array<[string, string, string]>) {
      const th = el('th', cls, text);
      th.scope = 'col';
      if (tip) th.title = tip;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const b of bidOrder(bids)) {
      const tr = el('tr', b.id === chosen ? 'lead' : '');
      tr.dataset.bid = b.id;
      const firm = el('td', 'c-firm');
      firm.append(el('span', 'bid-lamp'), document.createTextNode(names.firm(b.firmId)));
      tr.append(firm, el('td', 'c-agent', names.agent(b.agentId)), el('td', 'c-num', money(b.price)), el('td', 'c-num', pct(b.confidence)), el('td', 'c-num', pct(b.calibrated)), el('td', `c-num${b.ev > 0 ? '' : ' neg'}`, money(b.ev)));
      const plan = cleanText(b.plan, 600);
      if (plan) tr.title = `${names.agent(b.agentId)}'s plan: ${plan}`;
      tbody.append(tr);
    }
    if (!bids.length) {
      const tr = el('tr', 'bids-none');
      const td = el('td', '', 'No bids.');
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
    }
    t.append(thead, tbody);
    return t;
  }

  function satOutList(list: Array<{ agentId: string; firmId: string | null; reason: string }>): HTMLElement | null {
    if (!list.length) return null;
    const ul = el('ul', 'sat-out');
    for (const s of list) {
      const li = el('li');
      const fid = s.firmId ?? firms.find((f) => f.agents.some((a) => a.id === s.agentId))?.id ?? null;
      const who = fid ? `${names.agent(s.agentId)} of ${names.firm(fid)}` : names.agent(s.agentId);
      li.append(el('span', 'sat-who', who), document.createTextNode(` sat out: ${cleanText(s.reason, 240) || 'no reason given'}.`.replace(/\.\.$/, '.')));
      ul.append(li);
    }
    return ul;
  }

  function roundBlock(r: Round, total: number, j: Job): HTMLElement {
    const box = el('div', 'job-round');
    box.dataset.round = String(r.number);
    const when = `${new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}, ${new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    if (total > 1) box.append(el('h3', 'job-round-head', `${ORDINAL[r.number - 1] ?? `Round ${r.number}`} round, ${when}`));
    const prose = el('p', 'job-award', r.prose);
    box.append(prose);
    // What happened to the winner's work, when the ledger says.
    const run = r.chosen ? detail?.runs.find((x) => x.bidId === r.chosen!.id) : undefined;
    if (run?.outcome && run.outcome !== 'merged') {
      const insp = detail?.inspections.find((i) => i.runId === run.id);
      const said = run.outcome === 'failed' ? (insp ? `The work failed inspection (${verdict(insp).text.replace(/^Failed: /, '')}), so the job came back to the board without that firm.` : 'The work failed, so the job came back to the board without that firm.') : run.outcome === 'killed' ? 'The run was stopped, so the job came back to the board.' : run.outcome === 'closed' ? 'Its pull request was closed without merging.' : `The run ended ${run.outcome}.`;
      box.append(el('p', 'job-award-after', said));
    }
    box.append(bidTable(r.bids, r.chosen?.id ?? null, `Bids in round ${r.number} on ${cleanText(j.title, 80)}`));
    const sat = satOutList(r.satOut);
    if (sat) box.append(sat);
    return box;
  }

  function bidsSection(j: Job, d: JobDetail): HTMLElement {
    const sec = el('section', 'detail-sec job-bidding');
    const rounds = awardRounds(d.ledger, names, j.value, ['awarded', 'running', 'inspecting', 'shipping'].includes(j.status));
    const live = j.status === 'bidding';
    sec.append(secHead('Bids', live ? el('span', 'job-clock', closesIn(j.bidsCloseAt, Date.now())) : rounds.length > 1 ? `${rounds.length} rounds` : ''));
    sec.append(el('p', 'jobs-key', 'The job goes to the bid with the highest expected value: what the job is worth, times the chance it passes as the city reckons it from the firm’s record, less the price. A firm that claimed more than its record shows is trimmed to its calibrated chance.'));
    for (const r of rounds) sec.append(roundBlock(r, rounds.length + (live ? 1 : 0), j));
    if (live) {
      const box = el('div', 'job-round live');
      if (rounds.length) box.append(el('h3', 'job-round-head', 'This round, still open'));
      const lead = bidOrder(d.bids)[0];
      box.append(el('p', 'job-award', d.bids.length ? `${plural(d.bids.length, 'bid')} so far. ${lead && lead.ev > 0 ? `${names.firm(lead.firmId)} leads at ${money(lead.price)} credits, an expected value of ${money(lead.ev)}.` : 'None is worth taking at its price yet.'}` : 'No bids yet. Each eligible agent answers once: a bid, or a reason it sits out.'));
      box.append(bidTable(d.bids, lead && lead.ev > 0 ? lead.id : null, `Bids so far on ${cleanText(j.title, 80)}`));
      const sat = satOutList(d.satOut.map((s) => ({ agentId: s.agentId, firmId: s.firmId, reason: s.reason })));
      if (sat) box.append(sat);
      sec.append(box);
    }
    if (!rounds.length && !live) sec.append(el('p', 'detail-quiet', j.status === 'proposed' ? 'No round yet: firms bid once you accept it.' : 'No round yet: it opens for bids on the next round.'));
    return sec;
  }

  // ---------------------------------------------------------------- the work

  function attemptRow(r: RunView, n: number, total: number): HTMLElement {
    const li = el('li', `job-attempt ${r.outcome ?? 'live'}`);
    li.dataset.run = r.id;
    const head = el('div', 'job-attempt-head');
    head.append(el('span', 'job-attempt-n', total > 1 ? `${ORDINAL[n] ?? `Attempt ${n + 1}`} attempt` : 'The run'), el('span', 'job-attempt-by', `${names.agent(r.agentId)} of ${names.firm(r.firmId)}, on ${cleanText(r.model, 60)}`));
    li.append(head);
    const insp = detail?.inspections.find((i) => i.id === r.inspectionId) ?? detail?.inspections.filter((i) => i.runId === r.id).at(-1);
    let said: string;
    if (r.outcome === null) said = `${stageOf(detail!.job, r.stage)}, started ${ago(Date.parse(r.startedAt))}. ${progressWords(r.progress)}.`;
    else if (r.outcome === 'merged') said = `Merged${r.endedAt ? ` ${ago(Date.parse(r.endedAt))}` : ''}.`;
    else if (r.outcome === 'failed') said = insp ? `Failed inspection: ${verdict(insp).text.replace(/^Failed: /, '')}.` : `Failed${r.endedReason ? `: ${cleanText(r.endedReason, 200)}` : '.'}`;
    else said = `Ended ${r.outcome}${r.endedReason ? `: ${cleanText(r.endedReason, 200)}` : '.'}`;
    li.append(el('p', 'job-attempt-said', said.replace(/\.\.$/, '.')));
    const summary = cleanText(r.summary ?? '', 400);
    if (summary && r.outcome !== null) li.append(el('p', 'job-attempt-summary', summary));
    const links = el('p', 'job-attempt-links');
    links.append(pageLink('job-run-link', r.outcome === null ? 'Watch the run' : 'Open the run', 'run', r.id));
    if (insp) links.append(pageLink('job-insp-link', 'Inspection report', 'inspection', insp.id));
    const pr = githubUrl(r.prUrl);
    if (pr && r.prNumber) links.append(outLink('job-pr-link', `Pull request #${r.prNumber}`, pr));
    li.append(links);
    return li;
  }

  function workSection(d: JobDetail): HTMLElement {
    const sec = el('section', 'detail-sec job-work');
    sec.append(secHead('The work', d.runs.length > 1 ? `${d.runs.length} attempts` : ''));
    if (!d.runs.length) {
      sec.append(el('p', 'detail-quiet', d.job.status === 'awarded' ? 'Awarded; the run starts once a work slot and the site are free.' : 'No run yet. The winning firm’s agent works in its own sandboxed copy of the repo.'));
      return sec;
    }
    const ol = el('ol', 'job-attempts');
    d.runs.forEach((r, i) => ol.append(attemptRow(r, i, d.runs.length)));
    sec.append(ol);
    return sec;
  }

  // ---------------------------------------------------------------- the floor

  interface FloorFact {
    id: string;
    state: 'waiting' | 'lit' | 'scar' | 'removed';
    at: string;
  }

  /** The floors this job laid on its repo's tower, with where each stands now, from the ledger. */
  function floorsOf(rows: LedgerRow[]): FloorFact[] {
    const by = new Map<string, FloorFact>();
    for (const row of rows) {
      const d = (row.data ?? {}) as Record<string, any>;
      const tower = String(d.towerId ?? '');
      if (tower.startsWith('agent:')) continue;
      const fid = String(d.floor?.id ?? d.floorId ?? '');
      if (!fid) continue;
      if (row.kind === 'floor.laid') by.set(fid, { id: fid, state: d.floor?.earned?.state === 'lit' ? 'lit' : 'waiting', at: row.at });
      else if (row.kind === 'floor.lit') by.set(fid, { id: fid, state: 'lit', at: row.at });
      else if (row.kind === 'floor.scarred') by.set(fid, { id: fid, state: 'scar', at: row.at });
      else if (row.kind === 'floor.removed') by.set(fid, { id: fid, state: 'removed', at: row.at });
    }
    return [...by.values()];
  }

  const FLOOR_WORDS: Record<FloorFact['state'], string> = {
    lit: 'A lit floor: the merged work, standing above the datum line.',
    waiting: 'A floor waiting on your review, unlit until the pull request merges.',
    scar: 'A scar floor: the failed attempt, kept in the tower where it happened.',
    removed: 'The floor came down: the pull request was closed or the merge reverted.',
  };

  function floorSection(j: Job, d: JobDetail): HTMLElement {
    const sec = el('section', 'detail-sec job-floor');
    sec.append(secHead('The floor', shortName(j.repo)));
    const floors = floorsOf(d.ledger);
    if (!floors.length) {
      sec.append(el('p', 'detail-quiet', `No floor yet. Work that passes inspection lays a floor on ${shortName(j.repo)}'s tower; a failed inspection leaves a scar.`));
      return sec;
    }
    const ul = el('ul', 'job-floors');
    for (const f of floors) {
      const li = el('li', `job-floor-row ${f.state}`);
      li.dataset.floor = f.id;
      const mark = el('i', 'job-floor-mark');
      mark.setAttribute('aria-hidden', 'true');
      li.append(mark, el('span', 'job-floor-said', FLOOR_WORDS[f.state]));
      if (f.state !== 'removed' && opts.floorStands(j.repo, f.id)) li.append(button('job-fly', 'Fly to it', () => opts.flyToFloor(j.repo, f.id)));
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  // ---------------------------------------------------------------- the ledger

  function ledgerSection(d: JobDetail): HTMLElement {
    const sec = el('section', 'detail-sec job-ledger');
    sec.append(secHead('Ledger', plural(d.ledger.length, 'entry').replace('entrys', 'entries')));
    sec.append(el('p', 'jobs-key', 'Every step the market took on this job, as the city recorded it. The ledger is append-only and can be replayed.'));
    for (const day of ledgerTrail(d.ledger, names)) {
      const block = el('div', 'trail-day');
      block.append(el('h3', 'trail-head', day.heading));
      const ol = el('ol', 'trail');
      for (const r of day.rows) {
        const li = el('li', `trail-row k-${r.kind.replace(/[^a-z]/g, '-')}`);
        const t = el('time', 'trail-time', r.time);
        t.dateTime = r.at;
        li.append(t, el('span', 'trail-text', r.text));
        ol.append(li);
      }
      block.append(ol);
      sec.append(block);
    }
    return sec;
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    if (!sheet.shown || !detail) return;
    const d = detail;
    const j = d.job;
    const run = currentRun();
    setTrail(sheet.trail, [
      ['Jobs', placeHref('jobs')],
      [`${shortName(j.repo)}${j.issue !== null ? ` #${j.issue}` : ''}`, null],
    ]);
    const title = cleanText(j.title, 200) || 'Untitled';
    if (sheet.title.textContent !== title) sheet.title.textContent = title;
    sheet.root.dataset.status = j.status;
    sheet.sub.textContent = `${standing(j, run, names)} Worth ${money(j.value)} credits, ${j.tier} tier.`;
    const minute = Math.floor(Date.now() / 60_000);
    slots.head(JSON.stringify([j.status, j.tier, j.attempts, j.haltedFrom, asking, busy, error, liveRun()?.id ?? null]), () => headActions(j));
    slots.why(JSON.stringify([j.proposal ?? null, j.status === 'proposed' || j.status === 'open', audit?.id ?? null, audit?.findings.find((f) => f.id === j.proposal?.findingId) ?? null]), () => whySection(j, audit));
    slots.issue(JSON.stringify([j.title, j.body, j.url, j.issue, j.source]), () => issueSection(j));
    slots.terms(JSON.stringify([j.id, j.status === 'proposed' || j.status === 'open', j.scope, j.acceptance, j.status === 'proposed' || j.status === 'open' ? '' : j.body]), () => termsSection(j));
    slots.bids(JSON.stringify([j.status, j.bidsCloseAt, d.bids, d.satOut, d.ledger.filter((r) => r.kind === 'job.awarded' || r.kind === 'bid.placed').length, d.runs.map((r) => r.outcome), firms.length]), () => bidsSection(j, d));
    const clockEl = body.querySelector<HTMLElement>('.job-clock');
    if (clockEl) clockEl.textContent = closesIn(j.bidsCloseAt, Date.now());
    slots.work(JSON.stringify([d.runs, d.inspections.map((i) => i.id), firms.length, minute]), () => workSection(d));
    slots.floor(JSON.stringify([d.ledger.filter((r) => r.kind.startsWith('floor.')).map((r) => r.id), j.floorId]), () => floorSection(j, d));
    slots.ledger(JSON.stringify([d.ledger.length, d.ledger.at(-1)?.id, firms.length, new Date().getDate()]), () => ledgerSection(d));
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        detail = null;
        audit = null;
        error = '';
        asking = null;
        sheet.title.textContent = '';
        sheet.sub.textContent = '';
        for (const s of Object.values(slots)) s('', () => null);
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // The clock of an open round and the ages ("started 4 minutes ago") move on by themselves.
        timer = setInterval(render, 1000);
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
    },
  };
}
