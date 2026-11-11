import type { Bid, JobDetail, RunDetail, RunStage } from '../../../shared/types';
import { api, ApiError, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { cleanText, githubUrl, LIVE_STAGES, money } from './board';
import { ago, button, el, plural, textButton } from './controls';
import { blockRanges, clock, type DiffFile, type Entry, parseDiff, Transcript, verdict } from './detail';
import { coalesce, detailSheet, keyedSlot, namesOf, outLink, pageLink, refusal, secHead, setTrail } from './pages';
import './market.css';

export interface RunPage {
  show(id: string): void;
  hide(): void;
}

const shortName = (fullName: string): string => fullName.split('/')[1] ?? fullName;
const LIVE = new Set<RunStage>(['preparing', 'installing', 'working', 'inspecting', 'shipping']);
const STAGE_NAMES: Record<string, string> = { preparing: 'Preparing', installing: 'Installing', working: 'Working', inspecting: 'Inspection', shipping: 'Shipping' };
const STAGE_HELP: Record<string, string> = {
  preparing: 'cloning the repo into its own sandboxed folder',
  installing: 'installing the dependencies, with the network open to the package registry only',
  working: 'the agent reads, edits and runs tests inside the sandbox',
  inspecting: 'the guild runs the checks and another firm reviews the change',
  shipping: 'opening the pull request from the city’s own clean clone',
};
const ENDED: Record<string, string> = { merged: 'merged', failed: 'failed', killed: 'was stopped', capped: 'hit its credit cap', crashed: 'crashed', closed: 'its pull request was closed' };
/** How many entries one block of the transcript holds; blocks far from view are emptied and keep their height. */
const CHUNK = 150;
/** A diff longer than this opens with its files folded. */
const DIFF_OPEN_LINES = 2500;
/** Pages of log read in one go before the page stops and says so. */
const MAX_PAGES = 60;

/** "12:04:31" in local time. */
function hms(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${clock(at)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the transcript's view

/**
 * The transcript as a terminal pane that holds very long logs: entries
 * live in blocks of CHUNK, and a block far outside the pane is emptied to
 * its measured height and filled again as it scrolls near. New lines are
 * appended to the last block, and a call that gains a result redraws only
 * its own row, so a live log never re-renders as a whole.
 */
class LogView {
  readonly pane: HTMLElement;
  private readonly inner: HTMLElement;
  private chunks: Array<{ el: HTMLElement; filled: boolean; height: number }> = [];
  private rows = new Map<number, HTMLElement>();
  private open = new Set<number>();
  private io: IntersectionObserver;
  following = true;
  onUserScroll: () => void = () => {};

  constructor(private t: Transcript) {
    this.pane = el('div', 'run-log');
    this.pane.tabIndex = 0;
    this.pane.setAttribute('role', 'log');
    this.pane.setAttribute('aria-label', 'The run’s transcript');
    this.inner = el('div', 'run-log-inner');
    this.pane.append(this.inner);
    this.io = new IntersectionObserver((seen) => {
      for (const s of seen) {
        const i = Number((s.target as HTMLElement).dataset.chunk);
        if (s.isIntersecting) this.fill(i);
        else if (i < this.chunks.length - 1) this.empty(i);
      }
    }, { root: this.pane, rootMargin: '1200px 0px' });
    // He scrolled up (wheel, keys, the bar): the pane holds still instead of following.
    const user = (): void => {
      requestAnimationFrame(() => {
        const atEnd = this.pane.scrollTop + this.pane.clientHeight >= this.pane.scrollHeight - 24;
        if (!atEnd && this.following) this.onUserScroll();
      });
    };
    this.pane.addEventListener('wheel', user, { passive: true });
    this.pane.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) user();
    });
    this.pane.addEventListener('pointerdown', (e) => {
      // A drag on the pane's own scroll bar.
      if (e.target === this.pane) user();
    });
  }

  reset(t: Transcript): void {
    this.t = t;
    this.io.disconnect();
    this.inner.replaceChildren();
    this.chunks = [];
    this.rows.clear();
    this.open.clear();
  }

  private chunkOf(index: number): number {
    return Math.floor(index / CHUNK);
  }

  private ensureChunk(c: number): void {
    while (this.chunks.length <= c) {
      const div = el('div', 'run-log-chunk');
      div.dataset.chunk = String(this.chunks.length);
      this.inner.append(div);
      this.chunks.push({ el: div, filled: true, height: 0 });
      this.io.observe(div);
    }
  }

  private fill(c: number): void {
    const ch = this.chunks[c];
    if (!ch || ch.filled) return;
    ch.el.style.height = '';
    const from = c * CHUNK;
    const to = Math.min(this.t.entries.length, from + CHUNK);
    for (let i = from; i < to; i++) ch.el.append(this.row(this.t.entries[i]));
    ch.filled = true;
  }

  private empty(c: number): void {
    const ch = this.chunks[c];
    if (!ch || !ch.filled) return;
    ch.height = ch.el.offsetHeight;
    if (!ch.height) return;
    ch.el.style.height = `${ch.height}px`;
    for (let i = c * CHUNK; i < (c + 1) * CHUNK; i++) this.rows.delete(i);
    ch.el.replaceChildren();
    ch.filled = false;
  }

  /** New entries go on the end; calls that gained results redraw in place. */
  apply(added: Entry[], grown: Entry[]): void {
    for (const e of added) {
      const c = this.chunkOf(e.index);
      this.ensureChunk(c);
      if (this.chunks[c].filled) this.chunks[c].el.append(this.row(e));
    }
    for (const e of grown) {
      const old = this.rows.get(e.index);
      if (old) old.replaceWith(this.row(e));
    }
    if (this.following) this.toEnd();
  }

  toEnd(): void {
    this.pane.scrollTop = this.pane.scrollHeight;
  }

  private row(e: Entry): HTMLElement {
    const row = el('div', `log-row k-${e.kind}`);
    row.dataset.i = String(e.index);
    const time = el('span', 'log-time', hms(e.at));
    switch (e.kind) {
      case 'call': {
        if (e.failed) row.classList.add('failed');
        const open = this.open.has(e.index);
        const head = el('button', 'log-call');
        head.type = 'button';
        head.setAttribute('aria-expanded', String(open));
        head.disabled = e.out.length === 0;
        const fold = el('i', 'log-fold');
        fold.setAttribute('aria-hidden', 'true');
        head.append(fold, el('span', 'log-call-text', e.text));
        if (e.out.length && !open) head.append(el('span', 'log-peek', e.out.length === 1 ? e.out[0].split('\n')[0] : `${e.out.length} lines`));
        head.addEventListener('click', () => {
          if (this.open.has(e.index)) this.open.delete(e.index);
          else this.open.add(e.index);
          row.replaceWith(this.row(e));
        });
        row.append(time, head);
        if (open) {
          const out = el('div', 'log-out', e.out.join('\n'));
          row.append(out);
        }
        break;
      }
      case 'refused':
      case 'egress': {
        const word = e.kind === 'refused' ? 'Refused' : e.allowed === true ? 'Allowed' : e.allowed === false ? 'Refused' : 'Network';
        row.classList.add('log-rule');
        if (e.kind === 'egress') row.classList.add(e.allowed === false ? 'no' : 'yes');
        const what = el('span', 'log-rule-what', e.kind === 'egress' && e.allowed !== null ? `${e.what}` : e.what || e.text);
        row.append(time, el('span', 'log-rule-word', e.kind === 'egress' && e.allowed !== null ? `Network ${word.toLowerCase()}` : word), what);
        if (e.reason) row.append(el('span', 'log-rule-why', e.reason));
        break;
      }
      case 'result':
        row.append(time, el('span', 'log-result-word', 'Result'), el('span', 'log-text', e.text));
        break;
      default:
        row.append(time, el('span', 'log-text', e.text));
    }
    this.rows.set(e.index, row);
    return row;
  }
}

// ---------------------------------------------------------------- the diff's view

/** Diff rows per block; a block far from view is emptied to its height and filled again as it scrolls near. */
const DIFF_BLOCK = 200;
/** A diff row's height before it has been drawn (12 px type at a 1.6 line height). */
const DIFF_ROW_PX = 19.2;

function diffRow(l: DiffFile['lines'][number]): HTMLElement {
  const row = el('div', `diff-line ${l.kind}`);
  row.append(el('span', 'diff-n', l.a !== undefined && l.kind !== 'add' ? String(l.a) : ''), el('span', 'diff-n', l.b !== undefined && l.kind !== 'del' ? String(l.b) : ''), el('span', 'diff-sign', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''), el('span', 'diff-text', l.text));
  return row;
}

/**
 * One file of the diff: its header, and its lines in blocks of DIFF_BLOCK
 * that are drawn only near the view (`root` is the scrolling sheet), so a
 * patch of tens of thousands of lines keeps a few hundred rows in the page.
 */
function diffFile(f: DiffFile, open: boolean, root: HTMLElement): HTMLElement {
  const box = el('section', `diff-file${open ? ' open' : ''}`);
  const head = el('button', 'diff-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const fold = el('i', 'log-fold');
  fold.setAttribute('aria-hidden', 'true');
  const name = el('span', 'diff-path');
  if (f.from) name.append(el('span', 'diff-from', `${f.from} → `));
  name.append(document.createTextNode(f.path || f.from || ''));
  const counts = el('span', 'diff-counts');
  if (f.binary) counts.append(el('span', 'diff-bin', 'binary'));
  else counts.append(el('span', 'diff-add', `+${f.added}`), el('span', 'diff-del', `−${f.removed}`));
  head.append(fold, name, counts);
  box.append(head);
  const body = el('div', 'diff-body');
  const filled = new Set<HTMLElement>();
  const fill = (b: HTMLElement): void => {
    if (filled.has(b)) return;
    const from = Number(b.dataset.from);
    const to = Number(b.dataset.to);
    b.style.height = '';
    for (let i = from; i < to; i++) b.append(diffRow(f.lines[i]));
    filled.add(b);
  };
  const empty = (b: HTMLElement): void => {
    if (!filled.has(b)) return;
    // A folded file measures nothing: it keeps the height it last had.
    const h = b.offsetHeight;
    if (h) b.style.height = `${h}px`;
    b.replaceChildren();
    filled.delete(b);
  };
  let io: IntersectionObserver | null = null;
  const fillBody = (): void => {
    if (io) return;
    io = new IntersectionObserver(
      (seen) => {
        for (const s of seen) {
          if (s.isIntersecting) fill(s.target as HTMLElement);
          else empty(s.target as HTMLElement);
        }
      },
      { root, rootMargin: '1500px 0px' },
    );
    for (const [from, to] of blockRanges(f.lines.length, DIFF_BLOCK)) {
      const b = el('div', 'diff-block');
      b.dataset.from = String(from);
      b.dataset.to = String(to);
      b.style.height = `${(to - from) * DIFF_ROW_PX}px`;
      body.append(b);
      io.observe(b);
    }
  };
  if (open) fillBody();
  head.addEventListener('click', () => {
    const now = !box.classList.contains('open');
    box.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    if (now) fillBody();
  });
  box.append(body);
  return box;
}

// ---------------------------------------------------------------- the page

/**
 * A run's own page (#/runs/:id): where it has got to, its real counts,
 * credits spent against the bid, the live transcript (following the tail
 * while live, with a hold), the diff as a unified patch, and the
 * inspection's verdict. Kill stops a live run.
 */
export function createRunPage(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): RunPage {
  const sheet = detailSheet(parent, 'runpage', opts.onDismiss);
  const body = sheet.body;
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  body.append(trouble);
  const slots = { head: keyedSlot(sheet.actions), gauge: keyedSlot(body), verdict: keyedSlot(body) };

  // The transcript, built once and fed.
  const logSec = el('section', 'detail-sec run-transcript');
  const holdBtn = el('button', 'log-hold');
  holdBtn.type = 'button';
  holdBtn.append(el('i', 'log-hold-box'), document.createTextNode('Hold'));
  holdBtn.title = 'Hold the transcript still while new lines arrive';
  const logState = el('span', 'log-state');
  logState.setAttribute('aria-live', 'polite');
  const logAside = el('span', 'log-aside');
  logAside.append(logState, holdBtn);
  logSec.append(secHead('Transcript', logAside));
  const logKey = el('p', 'log-key');
  for (const [cls, text] of [
    ['k-assistant', 'the agent'],
    ['k-call', 'a tool call, folded with its result'],
    ['k-rule', 'a refusal or a network decision'],
    ['k-stderr', 'errors'],
  ]) {
    const s = el('span', `log-key-item ${cls}`);
    s.append(el('i', 'log-key-swatch'), document.createTextNode(text));
    logKey.append(s);
  }
  logSec.append(logKey);
  let transcript = new Transcript();
  const view = new LogView(transcript);
  const logNote = el('p', 'log-note');
  logNote.hidden = true;
  logSec.append(view.pane, logNote);
  const diffSec = el('section', 'detail-sec run-diff');
  body.append(logSec, diffSec);
  const tail = keyedSlot(body);

  let id: string | null = null;
  let run: RunDetail | null = null;
  let job: JobDetail | null = null;
  let names = namesOf([]);
  let unlisten: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let asking = false;
  let busy = false;
  let error = '';
  let held = false;
  let unseen = 0;
  let diffFor = '';
  let lastPage: string | null = null;

  const live = (): boolean => !!run && run.outcome === null && LIVE.has(run.stage);

  function setHold(on: boolean): void {
    held = on;
    view.following = !on;
    holdBtn.setAttribute('aria-pressed', String(on));
    if (!on) {
      unseen = 0;
      view.toEnd();
    }
    renderLogState();
  }
  holdBtn.addEventListener('click', () => setHold(!held));
  view.onUserScroll = () => setHold(true);

  function renderLogState(): void {
    holdBtn.hidden = !live();
    let text: string;
    if (!run) text = '';
    else if (!live()) text = run.outcome === null ? 'Not working now' : 'The run has ended';
    else if (held) text = unseen ? `Held; ${plural(unseen, 'new line')} below` : 'Held';
    else text = 'Following the live tail';
    logState.textContent = text;
    logSec.classList.toggle('is-live', live());
  }

  /** Reads every log line after the ones already shown, a page at a time. */
  const readLog = coalesce(async () => {
    const want = id;
    if (!want) return;
    for (let page = 0; page < MAX_PAGES; page++) {
      const lines = await api.runLog(want, transcript.lines);
      if (want !== id) return;
      if (!lines.length) break;
      // A log too big to page from its start answers with its newest lines whatever `since` says.
      const first = `${lines[0].at}|${lines[0].text}`;
      if (page > 0 && first === lastPage) {
        logNote.textContent = 'This log is too long to page from its start; it shows its newest lines.';
        logNote.hidden = false;
        break;
      }
      lastPage = first;
      const ch = transcript.push(lines);
      view.apply(ch.added, ch.grown);
      if (held) unseen += lines.length;
      if (lines.length < 2000) break;
    }
    renderLogState();
  });

  const readRun = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const r = await api.run(want);
      if (want !== id) return;
      run = r;
      trouble.hidden = true;
      const [jd, fs] = await Promise.all([api.job(r.jobId).catch(() => null), api.firms().catch(() => [])]);
      if (want !== id) return;
      job = jd;
      if (fs.length) names = namesOf(fs);
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof ApiError && err.status === 404 ? 'There is no such run.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
    void readDiff();
  });

  async function readDiff(): Promise<void> {
    if (!run) return;
    const key = `${run.id}|${run.headSha ?? ''}|${run.stage}`;
    if (key === diffFor) return;
    diffFor = key;
    let text: string | null = null;
    try {
      // The diff is written when the work is committed (the head sha); before that there is nothing to ask for.
      if (run.headSha) text = await api.runDiff(run.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        diffFor = '';
        return;
      }
    }
    if (!run) return;
    const files = text ? parseDiff(text) : [];
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const total = files.reduce((n, f) => n + f.lines.length, 0);
    diffSec.replaceChildren(secHead('The change', files.length ? `${plural(files.length, 'file')}, +${added} −${removed}` : ''));
    if (!files.length) {
      diffSec.append(el('p', 'detail-quiet', live() ? 'No diff yet. The change is committed and shown here when the agent finishes.' : 'This run left no change.'));
      return;
    }
    diffSec.append(el('p', 'jobs-key', 'The change as a unified patch: removed lines marked −, added lines +, with the line numbers before and after. It is the repo’s own code, shown as text.'));
    const wrap = el('div', 'diff');
    for (const f of files) wrap.append(diffFile(f, total <= DIFF_OPEN_LINES || files.length === 1, body));
    diffSec.append(wrap);
  }

  function onEvent(e: EngineEvent): void {
    if (!id) return;
    if (e.type === 'engine.reconnected') {
      readRun();
      readLog();
      return;
    }
    const d = (e.data ?? {}) as Record<string, any>;
    const runId = d.runId ?? d.run?.id ?? d.inspection?.runId ?? null;
    if (runId !== id && !(run && (d.job?.id ?? d.jobId) === run.jobId)) return;
    switch (e.type) {
      case 'run.log':
        readLog();
        return;
      case 'run.progress':
        if (run && d.progress) {
          run.progress = d.progress;
          render();
        }
        return;
      case 'run.stage':
        if (run && typeof d.stage === 'string') {
          run.stage = d.stage as RunStage;
          render();
        }
        readRun();
        readLog();
        return;
      default:
        readRun();
        readLog();
    }
  }

  // ---------------------------------------------------------------- sections

  function bidOf(): Bid | null {
    if (!run || !job) return null;
    const found = job.bids.find((b) => b.id === run!.bidId) ?? (job.award?.chosen?.id === run.bidId ? job.award.chosen : null);
    if (found) return found;
    for (const row of job.ledger) {
      const b = (row.data as { bid?: Bid; chosen?: Bid } | null)?.bid ?? (row.data as { chosen?: Bid } | null)?.chosen;
      if (b && b.id === run.bidId) return b;
    }
    return null;
  }

  function headActions(): HTMLElement | null {
    if (!run) return null;
    const out = el('div', 'detail-actions-wrap');
    const row = el('div', 'detail-actions-row');
    if (busy) row.setAttribute('aria-busy', 'true');
    if (live()) {
      if (asking) {
        row.append(
          el('span', 'detail-ask', 'Stop the run? What it made is thrown away, and the job goes back on the board without spending an attempt.'),
          button('run-kill-yes', 'Stop the run', () => void kill()),
          textButton('run-no', 'Let it work', () => {
            asking = false;
            render();
          }),
        );
      } else {
        row.append(
          button('run-kill', 'Kill', () => {
            asking = true;
            render();
            sheet.actions.querySelector<HTMLElement>('.run-no')?.focus({ preventScroll: true });
          }),
        );
      }
    }
    row.append(pageLink('run-job-link', 'The job', 'job', run.jobId));
    out.append(row);
    if (error) {
      const p = el('p', 'job-error', error);
      p.setAttribute('role', 'alert');
      out.append(p);
    }
    return out;
  }

  async function kill(): Promise<void> {
    if (!run || busy) return;
    busy = true;
    error = '';
    render();
    try {
      await api.killRun(run.id);
    } catch (err) {
      error = refusal('Kill', err);
    } finally {
      busy = false;
      asking = false;
      render();
      readRun();
    }
  }

  function gauge(): HTMLElement {
    const r = run!;
    const sec = el('section', 'detail-sec run-gauge');
    // The stages as a ruled line: where the run has been, where it is, what is left.
    const stages = el('ol', 'run-stages');
    const at = LIVE_STAGES.indexOf(r.stage as (typeof LIVE_STAGES)[number]);
    const past = r.outcome !== null || r.stage === 'waiting' || r.stage === 'done';
    LIVE_STAGES.forEach((s, i) => {
      const li = el('li', `run-stage-step${past || i < at ? ' done' : i === at ? ' now' : ''}`);
      li.append(el('i', 'run-stage-tick'), el('span', 'run-stage-name', STAGE_NAMES[s]));
      if (i === at && live()) li.title = STAGE_HELP[s];
      stages.append(li);
    });
    sec.append(stages);
    if (live() && at >= 0) sec.append(el('p', 'run-stage-help', `${STAGE_NAMES[r.stage]}: ${STAGE_HELP[r.stage]}.`));

    // The real counts, as figures over their words.
    const p = r.progress;
    const figs = el('dl', 'run-figures');
    const fig = (n: string, label: string, cls = ''): void => {
      const d = el('div', `run-fig ${cls}`.trim());
      d.append(el('dt', 'run-fig-label', label), el('dd', 'run-fig-num', n));
      figs.append(d);
    };
    fig(String(p.toolCalls), p.toolCalls === 1 ? 'tool call' : 'tool calls');
    fig(String(p.filesChanged), p.filesChanged === 1 ? 'file changed' : 'files changed');
    fig(String(p.testsRun), p.testsRun === 1 ? 'test run' : 'tests run');
    fig(String(p.turns), p.turns === 1 ? 'turn' : 'turns');
    fig(String(p.refusals), 'refused', p.refusals ? 'refused' : '');

    // Credits so far against the bid, as the last figure with its meter.
    const bid = bidOf();
    const spent = Math.round(p.credits * 100) / 100;
    const credits = el('div', 'run-fig run-fig-credits');
    const num = el('dd', 'run-fig-num');
    num.append(document.createTextNode(money(spent)));
    if (bid) num.append(el('span', 'run-fig-of', ` / ${money(bid.price)}`));
    credits.append(el('dt', 'run-fig-label', bid ? `credits of ${names.firm(r.firmId)}’s bid` : 'credits spent'), num);
    if (bid && bid.price > 0) {
      const bar = el('div', 'run-meter');
      bar.setAttribute('role', 'meter');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(bid.price));
      bar.setAttribute('aria-valuenow', String(spent));
      bar.setAttribute('aria-label', 'Credits spent against the bid');
      const fill = el('i', `run-meter-fill${spent > bid.price ? ' over' : ''}`);
      fill.style.width = `${Math.min(100, (spent / bid.price) * 100)}%`;
      bar.append(fill);
      credits.append(bar);
      credits.title = spent > bid.price ? 'Over its bid: the firm pays the difference from its own books.' : 'What the work has cost so far. The firm is paid its price only if the change merges.';
    }
    figs.append(credits);
    sec.append(figs);
    return sec;
  }

  function verdictSection(): HTMLElement | null {
    const r = run!;
    const i = r.inspection;
    const sec = el('section', 'detail-sec run-verdict');
    sec.append(secHead('Inspection'));
    if (!i) {
      sec.append(el('p', 'detail-quiet', live() ? 'Not inspected yet. When the agent finishes, the guild runs the repo’s checks and another firm reviews the change.' : 'This run was not inspected.'));
      return sec;
    }
    const v = verdict(i);
    const p = el('p', `run-verdict-line ${v.state}`);
    p.append(el('i', 'run-verdict-mark'), el('span', '', v.text));
    sec.append(p, el('p', 'job-attempt-links'));
    const links = sec.lastElementChild as HTMLElement;
    links.append(pageLink('run-insp-link', 'Read the inspection report', 'inspection', i.id));
    const pr = githubUrl(r.prUrl);
    if (pr && r.prNumber) links.append(outLink('job-pr-link', `Pull request #${r.prNumber}`, pr));
    return sec;
  }

  function render(): void {
    if (!sheet.shown || !run) return;
    const r = run;
    const j = r.job;
    setTrail(sheet.trail, [
      ['Jobs', placeHref('jobs')],
      [`${shortName(r.repo)}${j?.issue != null ? ` #${j.issue}` : ''}`, placeHref('job', r.jobId)],
      ['Run', null],
    ]);
    const title = cleanText(j?.title ?? '', 200) || 'A run';
    if (sheet.title.textContent !== title) sheet.title.textContent = title;
    const by = `${names.agent(r.agentId)} of ${names.firm(r.firmId)}, on ${cleanText(r.model, 60)}`;
    let when: string;
    if (r.endedAt && r.outcome) {
      const mins = Math.max(1, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000));
      const span = mins < 90 ? plural(mins, 'minute') : `${Math.round(mins / 60)} hours`;
      when = `It ran for ${span}, ${ago(Date.parse(r.startedAt))}, and ${ENDED[r.outcome] ?? `ended ${r.outcome}`}.`;
    } else when = `It started ${ago(Date.parse(r.startedAt))}.`;
    sheet.sub.title = `On the branch ${cleanText(r.branch, 120)}`;
    sheet.sub.textContent = `${by}. ${when}`;
    sheet.root.dataset.stage = r.stage;
    slots.head(JSON.stringify([r.stage, r.outcome, asking, busy, error]), headActions);
    slots.gauge(JSON.stringify([r.stage, r.outcome, r.progress, !!bidOf(), names.firm(r.firmId)]), gauge);
    tail(JSON.stringify([r.inspection?.id ?? null, r.inspection?.passed, r.prUrl, r.stage, r.outcome]), () => verdictSection());
    renderLogState();
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        run = null;
        job = null;
        error = '';
        asking = false;
        diffFor = '';
        lastPage = null;
        transcript = new Transcript();
        view.reset(transcript);
        logNote.hidden = true;
        diffSec.replaceChildren();
        sheet.title.textContent = '';
        sheet.sub.textContent = '';
        for (const s of Object.values(slots)) s('', () => null);
        tail('', () => null);
        setHold(false);
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
        // Events can be thinned under load: while the run is live, the page also reads on its own every few seconds.
        poll = setInterval(() => {
          if (live()) readLog();
          render();
        }, 3000);
      }
      if (changed) body.scrollTop = 0;
      readRun();
      readLog();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
      if (poll) clearInterval(poll);
      poll = null;
    },
  };
}
