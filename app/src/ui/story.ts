/**
 * The view logic of the firm and agent pages (Task 38), kept free of the
 * page so the tests can read it: how long a firm below zero has left, its
 * books folded for reading, the floors it built and the towers sold out of
 * its quarter, a round said in a line, the step line its reputation is
 * drawn as, and an agent's workflow and lineage in words.
 */
import { localDay as dayOf } from '../../../shared/day.js';
import { BANKRUPT_HOURS } from '../../../shared/market-rules.js';
import type { Agent, BookRow, FirmRound, Quarter, WorkflowShape } from '../../../shared/types.js';
import { cleanText, money } from './board.js';

const HOUR = 3_600_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9 November 2026", in local time. */
export function longDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "9 Nov", in local time. */
export function shortDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/** A sum of credits as the books set it: two places, a thousands comma, a true minus. */
export function figure(n: number): string {
  const [i, d] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`;
}

/** Whole hours (rounded up) before a firm below zero since `negativeSince` is bankrupt; null when it is not below zero. */
export function bankruptIn(negativeSince: string | null, now = Date.now()): number | null {
  if (!negativeSince) return null;
  const left = BANKRUPT_HOURS * HOUR - (now - Date.parse(negativeSince));
  return Math.max(0, Math.ceil(left / HOUR));
}

export interface StoryNames {
  agent(id: string): string;
  firm(id: string): string;
  /** A job's title, when known. */
  job(id: string): string | null;
}

/** One line of the books as the page shows it: one movement, or a run of bid costs folded together. */
export interface BookLine {
  at: string;
  kind: string;
  text: string;
  delta: number;
  balance: number;
  /** How many movements the line stands for. */
  count: number;
  jobId: string | null;
  agentId: string | null;
}

const MICRO = 1_000_000;

/** The local calendar day an instant falls on. */
const localDay = (at: string): string => dayOf(Date.parse(at));
const micro = (x: number): number => Math.round(x * MICRO);

function bookText(r: BookRow, count: number, names: StoryNames): string {
  const raw = r.title ?? (r.jobId ? names.job(r.jobId) : null);
  const title = raw ? cleanText(raw, 140) : null;
  switch (r.kind) {
    case 'bid':
      return `Bidding, ${count} ${count === 1 ? 'bid' : 'bids'}`;
    case 'run':
      return title ? `Work on ${title}` : 'Work on a job';
    case 'pay':
      return title ? `Paid for ${title}` : 'Paid for a merged job';
    case 'review-pay':
      return title ? `Review of ${title}` : 'Review fee';
    case 'hire':
      return r.agentId ? `Hired ${names.agent(r.agentId)} from the roster` : 'Hired from the roster';
    case 'pending':
      return 'Work and bids under way, not yet settled';
    case 'sale':
      return r.agentId ? `Bought ${names.agent(r.agentId)}’s tower` : 'Bought a dark tower';
    default:
      return r.kind;
  }
}

/**
 * The books for reading: each run of bid costs in a row folds into one
 * line within a day (summed in micro-credits, carrying the balance its last movement
 * left), every other movement is a line of its own. The balances are the
 * books' own, so the last line ends where the books do. Oldest first, or
 * newest first for the page.
 */
export function bookLines(books: BookRow[], names: StoryNames, opts: { newestFirst?: boolean } = {}): BookLine[] {
  const out: BookLine[] = [];
  let open: { line: BookLine; first: BookRow; sum: number } | null = null;
  for (const r of books) {
    // A fold never crosses midnight, so each day's heading keeps its own bidding.
    if (r.kind === 'bid' && open && localDay(r.at) === localDay(open.first.at)) {
      open.sum += micro(r.delta);
      open.line.count += 1;
      open.line.delta = open.sum / MICRO;
      open.line.balance = r.balance;
      open.line.at = r.at;
      open.line.text = bookText(open.first, open.line.count, names);
      continue;
    }
    const line: BookLine = { at: r.at, kind: r.kind, text: bookText(r, 1, names), delta: r.delta, balance: r.balance, count: 1, jobId: r.jobId, agentId: r.agentId };
    out.push(line);
    open = r.kind === 'bid' ? { line, first: r, sum: micro(r.delta) } : null;
  }
  return opts.newestFirst ? out.reverse() : out;
}

/** Floors a firm's agents built (lit or waiting, never a scar), wherever their towers stand now. */
export function floorsBuilt(quarters: Quarter[], firmId: string): number {
  let n = 0;
  for (const q of quarters) for (const t of q.towers) for (const f of t.floors) if (f.earned?.firmId === firmId && f.earned.state !== 'scar') n++;
  return n;
}

/** The towers of a firm's quarter that another firm bought, with the buyer. */
export function soldTowers(quarters: Quarter[], firmId: string): Array<{ agentId: string; buyer: string }> {
  const q = quarters.find((x) => x.firmId === firmId);
  if (!q) return [];
  return q.towers.filter((t) => t.firmId && t.firmId !== firmId && t.agentId).map((t) => ({ agentId: t.agentId!, buyer: t.firmId! }));
}

const OUTCOME_WORDS: Record<string, string> = {
  merged: 'merged',
  failed: 'failed inspection',
  closed: 'closed without merging',
  killed: 'stopped',
  capped: 'stopped at its cap',
  crashed: 'crashed',
  live: 'at work now',
};

/** A round the firm bid in, as one line. */
export function roundWords(r: FirmRound, names: StoryNames): string {
  if (r.won) {
    const after = r.outcome ? OUTCOME_WORDS[r.outcome] ?? r.outcome : 'not started';
    return `Won at an expected value of ${money(r.bid.ev)}; ${after}.`;
  }
  if (!r.winner) return `Nobody won: no bid was worth its price (this one ${money(r.bid.ev)}).`;
  return `Lost to ${names.firm(r.winner.firmId)}: ${money(r.bid.ev)} against ${money(r.winner.ev)}.`;
}

export interface Box {
  w: number;
  h: number;
  t0: number;
  t1: number;
  v0: number;
  v1: number;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * A step line through `points` (time, value), in an SVG path inside a w by
 * h box: each value holds until the next point, and the last holds to the
 * right edge. Values run up the box (v1 at the top).
 */
export function stepPath(points: Array<{ t: number; v: number }>, box: Box): string {
  if (!points.length) return '';
  const x = (t: number): number => r1(box.t1 === box.t0 ? box.w : ((t - box.t0) / (box.t1 - box.t0)) * box.w);
  const y = (v: number): number => r1(box.v1 === box.v0 ? box.h / 2 : box.h - ((v - box.v0) / (box.v1 - box.v0)) * box.h);
  let d = `M${x(points[0].t)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) d += `H${x(points[i].t)}V${y(points[i].v)}`;
  return x(points.at(-1)!.t) < box.w ? `${d}H${box.w}` : d;
}

/** What a workflow shape means for how the agent works, in a sentence. */
export function workflowWords(shape: WorkflowShape, n?: number): string {
  switch (shape) {
    case 'vote':
      return `Writes ${n === 3 || n === undefined ? 'three' : String(n)} plans for each bid and takes the middle one; does the work in one pass.`;
    case 'self-check':
      return 'Does the work, then checks its own work against the issue before handing it in.';
    case 'plan-then-answer':
      return 'Writes a plan first, then works through it in order.';
    default:
      return 'Reads the job and does the work in one pass.';
  }
}

/** Where the agent came from, in a sentence. */
export function lineageWords(a: Pick<Agent, 'lineage'>): string {
  const when = longDate(a.lineage.at);
  switch (a.lineage.origin) {
    case 'roster':
      return `Hired from the roster on ${when}.`;
    case 'school':
      return `Bred in the school on ${when}, generation ${a.lineage.generation}.`;
    default:
      return `Seeded with the city on ${when}.`;
  }
}
