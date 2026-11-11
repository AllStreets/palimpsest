import type { Bid, FirmView, Job, JobDetail, Repo, RunView, Tier } from '../../../shared/types';
import { TIER_VALUE } from '../../../shared/market-rules';
import { api, ApiError, type EngineEvent } from '../api';
import { placeHref } from '../router';
import {
  bidOrder,
  boardSections,
  cleanText,
  closesIn,
  eligible,
  excerpt,
  githubUrl,
  LIVE_STAGES,
  money,
  pct,
  progressWords,
  type Section,
  sectionOf,
  stageOf,
} from './board';
import { ago, button, checkRadio, createSheet, el, plural, rovingRadios, textButton } from './controls';
import './market.css';

export interface JobsScreen {
  /** Opens the board; with a job id, scrolls to that job and marks it. */
  show(jobId?: string | null): void;
  hide(): void;
}

interface Detail {
  /** The round the bids belong to (the job's bidsCloseAt when they were read). */
  round: string | null;
  bids: Bid[];
  satOut: JobDetail['satOut'];
  runs: RunView[];
}

const TIERS: Array<[Tier, string]> = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
];

/** How long a bid that just arrived keeps its mark. */
const FRESH_MS = 2400;

/** What one action is called in a refusal: "Accept refused: only a proposed job can be accepted." */
function refusal(what: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError && err.status >= 500) return `${what} failed: ${msg}`;
  return `${what} refused: ${msg.charAt(0).toLowerCase()}${msg.slice(1)}`;
}

const shortName = (fullName: string): string => fullName.split('/')[1] ?? fullName;

/**
 * The job board: the exchange's own ledger. Jobs stand in the sections he
 * reads them in (proposed, bidding, running, waiting on you, done today,
 * failed, halted), bids come in as a ruled list while the round is open,
 * and every change arrives from the event stream without a reload. Every
 * action is a call to the engine, and a refusal says the engine's reason.
 */
export function createJobs(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): JobsScreen {
  const sheet = createSheet(parent, 'jobs', 'Job board', opts.onDismiss);
  const head = sheet.root.querySelector('.sheet-head')!;
  const facts = el('p', 'sheet-facts');
  const filter = el('div', 'jobs-filter');
  filter.setAttribute('role', 'radiogroup');
  filter.setAttribute('aria-label', 'Show jobs on');
  head.append(facts, filter);

  const boardEl = el('div', 'jobs-board');
  const empty = el('p', 'jobs-empty');
  empty.hidden = true;
  const trouble = el('div', 'repos-trouble');
  trouble.hidden = true;
  sheet.body.append(trouble, boardEl, empty);

  // ---------------------------------------------------------------- state

  const jobs = new Map<string, Job>();
  const details = new Map<string, Detail>();
  /** Run id to job id, for the run events. */
  const runJob = new Map<string, string>();
  let repos: Repo[] = [];
  let firms: FirmView[] = [];
  let only: string | null = null;
  let focusId: string | null = null;
  /** The engine's refusal of an action, shown on the row (or repo) it was taken on until the next change. */
  const errors = new Map<string, string>();
  /** Rows asking "Withdraw this job?" */
  const confirming = new Set<string>();
  /** Actions in flight, by row. */
  const busy = new Set<string>();
  /** Bids that arrived while the board was open, marked for a moment. */
  const fresh = new Map<string, number>();
  const rows = new Map<string, { el: HTMLElement; key: string }>();
  let loaded = false;
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const agentName = (id: string): string => firms.flatMap((f) => f.agents).find((a) => a.id === id)?.name ?? id;
  const firmName = (id: string): string => firms.find((f) => f.id === id)?.name ?? id;
  const repoOf = (fullName: string): Repo | undefined => repos.find((r) => r.fullName === fullName);
  const runOf = (j: Job): RunView | null => {
    const d = details.get(j.id);
    if (!d) return null;
    return d.runs.find((r) => r.id === j.runId) ?? d.runs.at(-1) ?? null;
  };

  // ---------------------------------------------------------------- data

  /** Sections whose rows need the job's bids or runs. */
  const NEEDS_DETAIL = new Set(['bidding', 'running', 'waiting', 'done', 'failed', 'halted']);

  const reading = new Map<string, Promise<void>>();
  function readDetail(id: string): Promise<void> {
    const inflight = reading.get(id);
    if (inflight) {
      // One more read after the one in flight, so an event that lands meanwhile is not lost.
      const next = inflight.then(() => readDetail(id));
      return next;
    }
    const p = api
      .job(id)
      .then((d) => {
        jobs.set(id, d.job);
        details.set(id, { round: d.job.bidsCloseAt, bids: d.bids, satOut: d.satOut ?? [], runs: d.runs });
        for (const r of d.runs) runJob.set(r.id, id);
      })
      .catch(() => {})
      .finally(() => {
        reading.delete(id);
        render();
      });
    reading.set(id, p);
    return p;
  }

  async function load(): Promise<void> {
    try {
      const [js, rs, fs] = await Promise.all([api.jobs(), api.repos(), api.firms().catch(() => [] as FirmView[])]);
      jobs.clear();
      for (const j of js) jobs.set(j.id, j);
      repos = rs;
      firms = fs;
      trouble.hidden = true;
    } catch (err) {
      trouble.replaceChildren(el('p', 'repos-trouble-text', `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`), button('jobs-retry', 'Try again', () => void load()));
      trouble.hidden = false;
      return;
    }
    loaded = true;
    render();
    const now = Date.now();
    await Promise.all([...jobs.values()].filter((j) => NEEDS_DETAIL.has(sectionOf(j, now) ?? '')).map((j) => readDetail(j.id)));
    if (focusId) reveal(focusId);
  }

  const readRepos = (): void => {
    void api.repos().then((rs) => {
      repos = rs;
      render();
    }, () => {});
  };
  const readFirms = (): void => {
    void api.firms().then((fs) => {
      firms = fs;
      render();
    }, () => {});
  };

  /**
   * Whether an answer can join the bids already shown: the job is taking bids
   * and its round is the one they were read in. An answer from another round
   * (a repost, a new window) reads the job's bids again instead.
   */
  function inRound(jobId: string, d: Detail): boolean {
    const j = jobs.get(jobId);
    return !!j && j.status === 'bidding' && j.bidsCloseAt === d.round;
  }

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected') {
      void load();
      return;
    }
    const data = (e.data ?? {}) as Record<string, any>;
    switch (e.type) {
      case 'job.posted':
      case 'job.proposed':
      case 'job.changed': {
        const j = data.job as Job | undefined;
        if (!j?.id) return;
        jobs.set(j.id, j);
        errors.delete(j.id);
        confirming.delete(j.id);
        if (NEEDS_DETAIL.has(sectionOf(j, Date.now()) ?? '')) void readDetail(j.id);
        render();
        return;
      }
      case 'job.awarded':
        if (typeof data.jobId === 'string') void readDetail(data.jobId);
        return;
      case 'bid.placed': {
        const b = data.bid as Bid | undefined;
        if (!b?.jobId) return;
        const d = details.get(b.jobId);
        if (!d || !inRound(b.jobId, d)) {
          void readDetail(b.jobId);
          return;
        }
        if (!d.bids.some((x) => x.id === b.id)) d.bids.push(b);
        fresh.set(b.id, Date.now());
        setTimeout(() => {
          fresh.delete(b.id);
          render();
        }, FRESH_MS);
        render();
        return;
      }
      case 'bid.satOut': {
        const s = data.satOut as (JobDetail['satOut'][number] & { jobId: string }) | undefined;
        if (!s?.jobId) return;
        const d = details.get(s.jobId);
        if (!d || !inRound(s.jobId, d)) {
          void readDetail(s.jobId);
          return;
        }
        if (!d.satOut.some((x) => x.agentId === s.agentId)) d.satOut.push({ agentId: s.agentId, firmId: s.firmId, reason: s.reason, at: s.at });
        render();
        return;
      }
      case 'run.started': {
        const r = data.run as RunView | undefined;
        if (r?.jobId) {
          runJob.set(r.id, r.jobId);
          void readDetail(r.jobId);
        }
        return;
      }
      case 'run.stage':
      case 'run.progress': {
        const jobId = runJob.get(data.runId);
        const d = jobId ? details.get(jobId) : undefined;
        const r = d?.runs.find((x) => x.id === data.runId);
        if (!r) return;
        if (e.type === 'run.stage') r.stage = data.stage;
        else r.progress = data.progress;
        render();
        return;
      }
      case 'run.ended':
      case 'inspection.done':
      case 'merge.detected': {
        const runId = data.runId ?? data.inspection?.runId;
        const jobId = data.jobId ?? (runId ? runJob.get(runId) : undefined);
        if (jobId) void readDetail(jobId);
        return;
      }
      case 'repo.halted':
      case 'repo.resumed':
      case 'repo.patched':
      case 'repo.connected':
      case 'repo.disconnected':
      case 'repo.analyzed':
        readRepos();
        return;
      case 'agent.hired':
      case 'agent.retired':
      case 'firm.bankrupt':
      case 'tower.sold':
        readFirms();
        return;
      default:
    }
  }

  // ---------------------------------------------------------------- actions

  async function act(key: string, what: string, call: () => Promise<unknown>, after?: (v: unknown) => void): Promise<void> {
    if (busy.has(key)) return;
    busy.add(key);
    errors.delete(key);
    render();
    try {
      const v = await call();
      after?.(v);
    } catch (err) {
      errors.set(key, refusal(what, err));
    } finally {
      busy.delete(key);
      confirming.delete(key);
      render();
    }
  }

  const takeJob = (v: unknown): void => {
    const j = v as Job | null;
    if (j?.id) {
      jobs.set(j.id, j);
      if (NEEDS_DETAIL.has(sectionOf(j, Date.now()) ?? '')) void readDetail(j.id);
    }
  };

  // ---------------------------------------------------------------- rows

  function jobHead(j: Job): HTMLElement {
    const h = el('div', 'job-head');
    const title = el('a', 'job-title', cleanText(j.title, 160) || 'Untitled');
    title.href = placeHref('job', j.id);
    h.append(title);
    const meta = el('div', 'job-meta');
    const value = el('span', 'job-value');
    value.append(el('span', 'job-num', money(j.value)), document.createTextNode(' credits'));
    value.title = `${j.tier.charAt(0).toUpperCase()}${j.tier.slice(1)} tier: the most the city pays for it`;
    meta.append(value);
    h.append(meta);
    return h;
  }

  function jobLine(j: Job, sec: Section['key']): HTMLElement {
    const line = el('div', 'job-line');
    line.append(el('span', 'job-repo', shortName(j.repo)));
    const url = githubUrl(j.url);
    if (j.source === 'issue' && j.issue !== null) {
      const ref = url ? el('a', 'job-ref', `#${j.issue}`) : el('span', 'job-ref', `#${j.issue}`);
      if (ref instanceof HTMLAnchorElement) {
        ref.href = url!;
        ref.target = '_blank';
        ref.rel = 'noopener';
        ref.title = 'The issue on GitHub';
      }
      line.append(ref);
    }
    const by = j.source === 'issue' ? 'from an issue' : j.source === 'manual' ? 'posted by you' : 'proposed by the city';
    line.append(el('span', 'job-by', `${by}, ${ago(Date.parse(j.postedAt))}`));
    if (sec === 'bidding' || sec === 'running') line.append(withdrawControl(j));
    return line;
  }

  function errorLine(key: string): HTMLElement | null {
    const msg = errors.get(key);
    if (!msg) return null;
    const p = el('p', 'job-error', msg);
    p.setAttribute('role', 'alert');
    return p;
  }

  /** Withdraw, asked once more before it is sent: a running job's work is stopped and lost. */
  function withdrawControl(j: Job): HTMLElement {
    const wrap = el('span', 'job-withdraw');
    if (confirming.has(j.id)) {
      const live = j.status === 'running' || j.status === 'inspecting' || (j.status === 'awarded' && !!j.runId);
      wrap.append(
        el('span', 'job-ask', live ? 'Withdraw it and stop the run?' : 'Withdraw this job?'),
        textButton('job-yes', 'Withdraw', () => void act(j.id, 'Withdraw', () => api.withdrawJob(j.id), takeJob)),
        textButton('job-no', 'Keep it', () => {
          confirming.delete(j.id);
          render();
        }),
      );
    } else {
      wrap.append(
        textButton('job-withdraw-btn', 'Withdraw', () => {
          confirming.add(j.id);
          render();
          rows.get(j.id)?.el.querySelector<HTMLElement>('.job-no')?.focus({ preventScroll: true });
        }),
      );
    }
    return wrap;
  }

  /** The round: who may still answer, as lamps (a filled lamp a bid, a struck one a sit-out), and the clock. */
  function roundLine(j: Job, d: Detail | undefined): HTMLElement {
    const line = el('div', 'round-line');
    if (j.status !== 'bidding') {
      const market = repoOf(j.repo)?.market;
      line.append(el('span', 'round-wait', market === false ? `The market is off on ${shortName(j.repo)}, so no firm bids on it yet.` : 'Waiting for its round to open.'));
      return line;
    }
    const can = eligible(j, firms);
    const bids = d?.bids.length ?? 0;
    const sat = d?.satOut.length ?? 0;
    const total = Math.max(can.length, bids + sat);
    const lamps = el('span', 'round-lamps');
    lamps.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < total; i++) lamps.append(el('i', i < bids ? 'bid' : i < bids + sat ? 'sat' : ''));
    const said = el('span', 'round-said', `${bids + sat} of ${plural(total, 'agent')} answered`);
    const clock = el('span', 'round-clock');
    clock.dataset.close = j.bidsCloseAt ?? '';
    setClock(clock, Date.now());
    line.append(lamps, said, clock);
    return line;
  }

  function bidTable(j: Job, d: Detail): HTMLElement {
    const t = el('table', 'bids');
    const cap = el('caption', 'bids-cap', `Bids on ${cleanText(j.title, 80)}`);
    t.append(cap);
    const thead = el('thead');
    const hr = el('tr');
    for (const [text, cls, tip] of [
      ['Firm', 'c-firm', ''],
      ['Agent', 'c-agent', ''],
      ['Price', 'c-num', 'What the firm asks, in credits'],
      ['Confidence', 'c-num', 'How sure the firm says it is that the work will pass'],
      ["City's estimate", 'c-num', "How often this firm's work of this size has passed"],
      ['EV', 'c-num', 'Expected value: the job’s worth times the calibrated chance of passing, less the price'],
    ] as Array<[string, string, string]>) {
      const th = el('th', cls, text);
      th.scope = 'col';
      if (tip) th.title = tip;
      hr.append(th);
    }
    thead.append(hr);
    const cols = el('colgroup');
    for (const c of ['firm', 'agent', 'price', 'conf', 'est', 'ev']) cols.append(el('col', `col-${c}`));
    t.append(cols);
    const tbody = el('tbody');
    const ranked = bidOrder(d.bids);
    ranked.forEach((b, i) => {
      const tr = el('tr', i === 0 && b.ev > 0 ? 'lead' : '');
      if (fresh.has(b.id)) tr.classList.add('fresh');
      tr.dataset.bid = b.id;
      const firm = el('td', 'c-firm');
      firm.append(el('span', 'bid-lamp'), document.createTextNode(firmName(b.firmId)));
      tr.append(
        firm,
        el('td', 'c-agent', agentName(b.agentId)),
        el('td', 'c-num', money(b.price)),
        el('td', 'c-num', pct(b.confidence)),
        el('td', b.appraisal === null ? 'c-num none' : 'c-num quiet', pct(b.appraisal)),
        el('td', `c-num${b.ev > 0 ? '' : ' neg'}`, money(b.ev)),
      );
      tbody.append(tr);
    });
    t.append(thead, tbody);
    if (ranked.length === 0) {
      const tr = el('tr', 'bids-none');
      const td = el('td', '', 'No bids yet.');
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
    }
    return t;
  }

  function satOutList(d: Detail): HTMLElement | null {
    if (d.satOut.length === 0) return null;
    const ul = el('ul', 'sat-out');
    for (const s of d.satOut) {
      const li = el('li');
      li.append(el('span', 'sat-who', `${agentName(s.agentId)} of ${firmName(s.firmId)}`), document.createTextNode(` sat out: ${cleanText(s.reason, 200)}`));
      ul.append(li);
    }
    return ul;
  }

  function stageTicks(stage: string | null): HTMLElement {
    const ticks = el('span', 'repo-ticks job-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    const at = stage ? LIVE_STAGES.indexOf(stage as (typeof LIVE_STAGES)[number]) : -1;
    LIVE_STAGES.forEach((_, i) => ticks.append(el('i', i <= at ? 'done' : '')));
    return ticks;
  }

  function byLine(r: RunView): string {
    return `${agentName(r.agentId)} of ${firmName(r.firmId)}`;
  }

  function body(sec: Section['key'], j: Job): HTMLElement[] {
    const d = details.get(j.id);
    const r = runOf(j);
    const out: HTMLElement[] = [];
    const actions = el('div', 'job-actions');
    switch (sec) {
      case 'proposed': {
        const ex = excerpt(j.body, 220);
        if (ex) out.push(el('p', 'job-excerpt', ex));
        const accept = button('job-accept', 'Accept', () => void act(j.id, 'Accept', () => api.acceptJob(j.id), takeJob));
        const dismiss = textButton('job-dismiss', 'Dismiss', () => void act(j.id, 'Dismiss', () => api.dismissJob(j.id), takeJob));
        actions.append(accept, dismiss, el('span', 'job-note inline', 'No firm bids on it until you accept it.'));
        break;
      }
      case 'bidding': {
        out.push(roundLine(j, d));
        if (j.status === 'bidding') {
          if (d) out.push(bidTable(j, d));
          const sat = d ? satOutList(d) : null;
          if (sat) out.push(sat);
        }
        break;
      }
      case 'running': {
        const line = el('div', 'run-line');
        line.append(stageTicks(j.status === 'awarded' ? null : (r?.stage ?? null)), el('span', 'run-stage', stageOf(j, j.status === 'awarded' ? null : (r?.stage ?? null))));
        if (r && j.status !== 'awarded') line.append(el('span', 'run-by', byLine(r)));
        out.push(line);
        if (r && j.status !== 'awarded') {
          const p = el('p', 'run-progress');
          p.append(el('span', 'run-counts', progressWords(r.progress)));
          const bid = d?.bids.find((b) => b.id === j.awardedBid);
          p.append(el('span', 'run-spent', `${money(Math.round(r.progress.credits * 100) / 100)}${bid ? ` of ${money(bid.price)}` : ''} credits spent, started ${ago(Date.parse(r.startedAt))}`));
          out.push(p);
        } else if (j.status === 'awarded') {
          const won = d?.bids.find((b) => b.id === j.awardedBid);
          if (won) out.push(el('p', 'job-note', `${agentName(won.agentId)} of ${firmName(won.firmId)} won it at ${money(won.price)} credits. The run starts once a work slot and the site on ${shortName(j.repo)} are free.`));
        }
        break;
      }
      case 'waiting': {
        const p = el('p', 'job-pr');
        const url = githubUrl(r?.prUrl);
        if (r?.prNumber && url) {
          const a = el('a', 'job-pr-link', `Pull request #${r.prNumber}`);
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener';
          p.append(document.createTextNode('Passed inspection. '), a, document.createTextNode(' is open on GitHub: merge or close it there.'));
        } else {
          p.append(document.createTextNode('Passed inspection. Its pull request is open on GitHub: merge or close it there.'));
        }
        out.push(p);
        if (r) out.push(el('p', 'job-note', `Built by ${byLine(r)}.`));
        break;
      }
      case 'done': {
        const when = j.closedAt ? ago(Date.parse(j.closedAt)) : '';
        const text = j.status === 'merged' ? `Merged ${when}${r ? `, built by ${byLine(r)}` : ''}.` : `Closed without merging ${when}. Nothing was paid.`;
        out.push(el('p', `job-done ${j.status}`, text));
        break;
      }
      case 'failed': {
        const why = cleanText(r?.endedReason ?? '', 240);
        out.push(el('p', 'job-failed', why ? `Failed: ${why}` : 'Failed.'));
        const left = 2 - j.attempts;
        out.push(el('p', 'job-note', left > 0 ? `${plural(j.attempts, 'attempt')} of 2 used. The firm that failed it may not bid again.` : 'Both attempts used. The issue is labelled palimpsest:failed.'));
        if (left > 0) actions.append(button('job-repost', 'Repost', () => void act(j.id, 'Repost', () => api.repostJob(j.id), takeJob)));
        break;
      }
      case 'halted': {
        const note = cleanText(j.haltNote ?? '', 240);
        const repoHalted = !!repoOf(j.repo)?.halted;
        out.push(el('p', 'job-note', note || (repoHalted ? `Halted with the market on ${shortName(j.repo)}.` : 'Halted.')));
        if (!repoHalted) actions.append(button('job-resume', 'Resume', () => void act(j.id, 'Resume', () => api.resumeJob(j.id), takeJob)));
        break;
      }
    }
    const err = errorLine(j.id);
    if (err) out.push(err);
    if (actions.childElementCount) out.push(actions);
    return out;
  }

  function jobRow(sec: Section['key'], j: Job): HTMLElement {
    const d = details.get(j.id);
    const r = runOf(j);
    const key = JSON.stringify([
      sec,
      j,
      d?.bids.map((b) => [b.id, fresh.has(b.id)]),
      d?.satOut,
      r ? [r.id, r.stage, r.progress, r.prUrl, r.endedReason, r.agentId] : null,
      errors.get(j.id),
      confirming.has(j.id),
      busy.has(j.id),
      sec === 'bidding' ? eligible(j, firms).length : 0,
      firms.length,
      repoOf(j.repo)?.market,
      repoOf(j.repo)?.halted ? 1 : 0,
      focusId === j.id,
      Math.floor(Date.now() / 60_000),
    ]);
    const cached = rows.get(j.id);
    if (cached && cached.key === key) return cached.el;
    const li = el('li', `job-row ${sec}`);
    li.dataset.job = j.id;
    li.dataset.status = j.status;
    if (focusId === j.id) li.classList.add('focus');
    if (busy.has(j.id)) li.setAttribute('aria-busy', 'true');
    li.append(jobHead(j), jobLine(j, sec), ...body(sec, j));
    // Keep keyboard focus on the same control when the row is rebuilt.
    const had = cached?.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : null;
    if (cached) cached.el.replaceWith(li);
    rows.set(j.id, { el: li, key });
    if (had) li.querySelector<HTMLElement>(`.${had.split(' ').filter(Boolean).join('.')}`)?.focus({ preventScroll: true });
    return li;
  }

  /**
   * Proposals the city made more than once (the same harness job on several
   * repos) stand as one row naming each repo, with Accept and Dismiss per
   * repo; a proposal of its own keeps its own row.
   */
  function proposedRows(list: Job[], live: Set<string>): HTMLElement[] {
    const groups = new Map<string, Job[]>();
    for (const j of list) {
      const k = `${j.source}|${cleanText(j.title, 160)}`;
      groups.set(k, [...(groups.get(k) ?? []), j]);
    }
    return [...groups.entries()].map(([k, js]) => {
      if (js.length === 1) return jobRow('proposed', js[0]);
      live.add(`group:${k}`);
      return proposalGroup(k, js);
    });
  }

  function proposalGroup(k: string, js: Job[]): HTMLElement {
    const key = JSON.stringify([js, js.map((j) => [errors.get(j.id), busy.has(j.id)]), Math.floor(Date.now() / 60_000)]);
    const id = `group:${k}`;
    const cached = rows.get(id);
    if (cached && cached.key === key) return cached.el;
    const first = js[0];
    const li = el('li', 'job-row proposed group');
    li.dataset.group = cleanText(first.title, 160);
    const h = el('div', 'job-head');
    h.append(el('span', 'job-title plain', cleanText(first.title, 160) || 'Untitled'));
    const meta = el('div', 'job-meta');
    const value = el('span', 'job-value');
    value.append(el('span', 'job-num', money(first.value)), document.createTextNode(' credits each'));
    meta.append(value);
    h.append(meta);
    li.append(h);
    li.append(el('div', 'job-line', `proposed by the city for ${plural(js.length, 'repo')}`));
    const ex = excerpt(first.body, 220);
    if (ex) li.append(el('p', 'job-excerpt', ex));
    const ul = el('ul', 'prop-lines');
    for (const j of js) {
      const row = el('li', 'prop-line');
      row.dataset.job = j.id;
      if (busy.has(j.id)) row.setAttribute('aria-busy', 'true');
      const name = el('a', 'prop-repo', shortName(j.repo));
      name.href = placeHref('job', j.id);
      name.title = j.repo;
      row.append(
        name,
        el('span', 'prop-age', ago(Date.parse(j.postedAt))),
        button('job-accept', 'Accept', () => void act(j.id, 'Accept', () => api.acceptJob(j.id), takeJob)),
        textButton('job-dismiss', 'Dismiss', () => void act(j.id, 'Dismiss', () => api.dismissJob(j.id), takeJob)),
      );
      const err = errorLine(j.id);
      if (err) row.append(err);
      ul.append(row);
    }
    li.append(ul, el('p', 'job-note', 'No firm bids on any of them until you accept it for that repo.'));
    const had = cached?.el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const hadJob = had?.closest<HTMLElement>('.prop-line')?.dataset.job;
    const hadClass = had?.className ?? '';
    if (cached) cached.el.replaceWith(li);
    rows.set(id, { el: li, key });
    if (hadJob && hadClass) li.querySelector<HTMLElement>(`.prop-line[data-job="${CSS.escape(hadJob)}"] .${hadClass.split(' ').filter(Boolean).join('.')}`)?.focus({ preventScroll: true });
    return li;
  }

  function haltedRepoRow(r: Repo): HTMLElement {
    const li = el('li', 'job-row halted-repo');
    li.dataset.repo = r.fullName;
    const h = el('div', 'job-head');
    h.append(el('span', 'job-title plain', shortName(r.fullName)), el('span', 'job-meta', r.fullName.split('/')[0]));
    li.append(h);
    const since = r.halted ? ago(Date.parse(r.halted.at)) : '';
    li.append(el('p', 'job-failed', `The market stopped here ${since}. ${cleanText(r.halted?.reason ?? '', 240)}`.trim()));
    li.append(el('p', 'job-note', 'No job on this repo bids or runs until you resume it. A job whose pull request is still open goes back to waiting on you.'));
    const err = errorLine(r.fullName);
    if (err) li.append(err);
    const actions = el('div', 'job-actions');
    actions.append(
      button('repo-resume', 'Resume the market here', () =>
        void act(r.fullName, 'Resume', () => api.resumeRepo(r.fullName), (v) => {
          const next = v as Repo | null;
          if (next?.fullName) repos = repos.map((x) => (x.fullName === next.fullName ? next : x));
          void load();
        }),
      ),
    );
    li.append(actions);
    return li;
  }

  // ---------------------------------------------------------------- render

  const secEls = new Map<string, { wrap: HTMLElement; count: HTMLElement; list: HTMLElement }>();

  function sectionEl(s: Section): { wrap: HTMLElement; count: HTMLElement; list: HTMLElement } {
    let x = secEls.get(s.key);
    if (!x) {
      const wrap = el('section', `jobs-sec sec-${s.key}`);
      wrap.setAttribute('aria-labelledby', `jobs-sec-${s.key}`);
      const h = el('h2', 'repos-sec');
      const name = el('span', 'repos-sec-name', s.title);
      name.id = `jobs-sec-${s.key}`;
      const count = el('span', 'repos-sec-count');
      h.append(name, count);
      wrap.append(h);
      if (s.key === 'bidding') {
        wrap.append(el('p', 'jobs-key', 'A job goes to the bid with the highest expected value (EV): what the job is worth, times the chance it passes as the city reckons it from the firm’s record, less the price.'));
      }
      const list = el('ol', 'job-list');
      wrap.append(list);
      x = { wrap, count, list };
      secEls.set(s.key, x);
    }
    return x;
  }

  function renderFilter(): void {
    const names = [...new Set([...[...jobs.values()].filter((j) => sectionOf(j, Date.now())).map((j) => j.repo), ...repos.filter((r) => r.connected && (r.market || r.halted)).map((r) => r.fullName)])].sort((a, b) =>
      shortName(a).localeCompare(shortName(b)),
    );
    if (only && !names.includes(only)) names.push(only);
    const want = ['', ...names];
    const have = [...filter.querySelectorAll<HTMLElement>('[role="radio"]')].map((b) => b.dataset.repo ?? '');
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      filter.replaceChildren();
      for (const n of want) {
        const b = el('button', 'jobs-pick', n ? shortName(n) : 'All repos');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.repo = n;
        if (n) b.title = n;
        b.addEventListener('click', () => pick(b));
        filter.append(b);
      }
    }
    checkRadio(filter, filter.querySelector<HTMLElement>(`[data-repo="${CSS.escape(only ?? '')}"]`));
    filter.hidden = names.length < 2;
  }

  function pick(b: HTMLElement): void {
    only = b.dataset.repo || null;
    render();
  }
  rovingRadios(filter, pick);

  function render(): void {
    if (!sheet.shown) return;
    renderFilter();
    if (!loaded) return;
    const now = Date.now();
    const sections = boardSections([...jobs.values()], repos, now, only);
    const keep = new Set<HTMLElement>();
    let at = 0;
    const live = new Set<string>();
    for (const s of sections) {
      const x = sectionEl(s);
      const n = s.jobs.length + s.repos.length;
      x.count.textContent = s.key === 'halted' && s.repos.length ? `${plural(s.repos.length, 'repo')}${s.jobs.length ? `, ${plural(s.jobs.length, 'job')}` : ''}` : plural(n, 'job');
      const items = [...s.repos.map((r) => haltedRepoRow(r)), ...(s.key === 'proposed' ? proposedRows(s.jobs, live) : s.jobs.map((j) => jobRow(s.key, j)))];
      for (const j of s.jobs) live.add(j.id);
      items.forEach((item, i) => {
        if (x.list.children[i] !== item) x.list.insertBefore(item, x.list.children[i] ?? null);
      });
      while (x.list.children.length > items.length) x.list.lastElementChild?.remove();
      if (boardEl.children[at] !== x.wrap) boardEl.insertBefore(x.wrap, boardEl.children[at] ?? null);
      keep.add(x.wrap);
      at++;
    }
    for (const c of [...boardEl.children]) if (!keep.has(c as HTMLElement)) c.remove();
    for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);

    const count = (k: string) => sections.find((s) => s.key === k)?.jobs.length ?? 0;
    const taking = sections.find((s) => s.key === 'bidding')?.jobs.filter((j) => j.status === 'bidding').length ?? 0;
    const parts = [
      count('proposed') && `${count('proposed')} proposed`,
      taking && `${taking} taking bids`,
      count('bidding') - taking && `${count('bidding') - taking} waiting for a round`,
      count('running') && `${count('running')} running`,
      count('waiting') && `${count('waiting')} waiting on you`,
    ].filter(Boolean);
    facts.textContent = parts.length ? `${parts.join(', ')}.` : 'Nothing under way.';
    empty.hidden = sections.length > 0;
    empty.textContent = only
      ? `Nothing on ${shortName(only)} today.`
      : 'No jobs yet. Label an issue palimpsest on a connected repo with its market on, or post one below.';
    renderForm();
  }

  let minuteShown = Math.floor(Date.now() / 60_000);
  /** The clocks count down every second without a rebuild; once a minute the rows redraw, so "4 minutes ago" moves on. */
  function tickClocks(): void {
    const now = Date.now();
    for (const c of boardEl.querySelectorAll<HTMLElement>('.round-clock')) setClock(c, now);
    const minute = Math.floor(now / 60_000);
    if (minute !== minuteShown) {
      minuteShown = minute;
      render();
    }
  }

  /** "closes in" in the text face, the minutes and seconds in figures. */
  function setClock(c: HTMLElement, now: number): void {
    const t = closesIn(c.dataset.close || null, now);
    if (c.getAttribute('aria-label') === t) return;
    c.setAttribute('aria-label', t);
    const m = /^closes in (\d+:\d\d)$/.exec(t);
    if (m) c.replaceChildren(el('span', 'round-clock-word', 'closes in '), el('span', 'round-clock-num', m[1]));
    else c.replaceChildren(el('span', 'round-clock-word', t));
  }

  function reveal(id: string): void {
    const row = rows.get(id)?.el;
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- post a job

  const form = el('form', 'post-job');
  form.noValidate = true;
  const formHead = el('h2', 'repos-sec');
  const formName = el('span', 'repos-sec-name', 'Post a job');
  formName.id = 'post-job-title';
  formHead.append(formName);
  form.setAttribute('aria-labelledby', 'post-job-title');

  const field = (label: string, control: HTMLElement, note?: string): HTMLElement => {
    const row = el('label', 'post-row');
    row.append(el('span', 'post-label', label), control);
    if (note) row.append(el('span', 'post-hint', note));
    return row;
  };
  const repoSel = el('select', 'post-repo');
  repoSel.name = 'repo';
  const repoNote = el('span', 'post-hint');
  const repoRow = field('Repo', repoSel);
  repoRow.append(repoNote);
  const titleIn = el('input', 'post-input');
  titleIn.name = 'title';
  titleIn.maxLength = 200;
  titleIn.placeholder = 'What should change, in a line';
  titleIn.autocomplete = 'off';
  const bodyIn = el('textarea', 'post-input post-body');
  bodyIn.name = 'body';
  bodyIn.rows = 4;
  bodyIn.maxLength = 20_000;
  bodyIn.placeholder = 'Where it is, how to tell it is done. Name files in backticks to keep the change inside them.';
  const tierGroup = el('div', 'post-tiers');
  tierGroup.setAttribute('role', 'radiogroup');
  tierGroup.setAttribute('aria-label', 'Tier');
  let tier: Tier = 'normal';
  for (const [t, name] of TIERS) {
    const b = el('button', 'quality-choice post-tier');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.tier = t;
    b.append(el('span', 'quality-mark'), el('span', 'quality-name', name), el('span', 'quality-what', `${TIER_VALUE[t]} credits`));
    b.addEventListener('click', () => chooseTier(b));
    tierGroup.append(b);
  }
  const chooseTier = (b: HTMLElement): void => {
    tier = b.dataset.tier as Tier;
    checkRadio(tierGroup, b);
  };
  rovingRadios(tierGroup, chooseTier);
  checkRadio(tierGroup, tierGroup.querySelector('[data-tier="normal"]'));
  const tierRow = el('div', 'post-row');
  tierRow.append(el('span', 'post-label', 'Tier'), tierGroup, el('span', 'post-hint', 'The most the city pays for it; firms bid at or under it.'));
  const postBtn = el('button', 'btn post-submit', 'Post');
  postBtn.type = 'submit';
  const postSaid = el('p', 'post-said');
  postSaid.setAttribute('aria-live', 'polite');
  const postFoot = el('div', 'post-foot');
  postFoot.append(postBtn, postSaid);
  form.append(formHead, repoRow, field('Title', titleIn), field('Details', bodyIn, 'Optional.'), tierRow, postFoot);
  sheet.body.append(form);

  function renderForm(): void {
    const open = repos.filter((r) => r.connected).sort((a, b) => shortName(a.fullName).localeCompare(shortName(b.fullName)));
    const want = open.map((r) => r.fullName);
    const have = [...repoSel.options].map((o) => o.value);
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      const keep = repoSel.value;
      repoSel.replaceChildren(...open.map((r) => {
        const o = el('option', '', r.fullName);
        o.value = r.fullName;
        return o;
      }));
      if (want.includes(keep)) repoSel.value = keep;
      else if (only && want.includes(only)) repoSel.value = only;
    }
    const r = repoOf(repoSel.value);
    repoNote.textContent = !r ? 'Connect a repo in Repos first.' : r.halted ? 'The market is halted here: the job waits until you resume it.' : !r.market ? 'The market is off here: the job waits until you turn it on.' : '';
    postBtn.disabled = open.length === 0;
  }
  repoSel.addEventListener('change', renderForm);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const repo = repoSel.value;
    const title = titleIn.value.trim();
    if (!repo) {
      postSaid.className = 'post-said err';
      postSaid.textContent = 'Choose a repo.';
      repoSel.focus();
      return;
    }
    if (!title) {
      postSaid.className = 'post-said err';
      postSaid.textContent = 'A job needs a title.';
      titleIn.focus();
      return;
    }
    postBtn.disabled = true;
    postSaid.className = 'post-said';
    postSaid.textContent = 'Posting';
    const bodyText = bodyIn.value.trim();
    api
      .postJob({ repo, title, ...(bodyText ? { body: bodyText } : {}), tier })
      .then((j) => {
        jobs.set(j.id, j);
        titleIn.value = '';
        bodyIn.value = '';
        postSaid.className = 'post-said ok';
        const r = repoOf(repo);
        postSaid.textContent = r?.market && !r.halted ? 'Posted. It opens for bids on the next round.' : 'Posted. It waits on the board until the market runs on this repo.';
        render();
      })
      .catch((err: unknown) => {
        postSaid.className = 'post-said err';
        postSaid.textContent = refusal('Posting', err);
      })
      .finally(() => {
        postBtn.disabled = false;
      });
  });

  // ---------------------------------------------------------------- open and close

  return {
    show(jobId = null) {
      focusId = jobId;
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        timer = setInterval(tickClocks, 1000);
        void load();
      } else {
        render();
        if (jobId) reveal(jobId);
      }
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
      if (timer) clearInterval(timer);
      timer = null;
      loaded = false;
    },
  };
}
