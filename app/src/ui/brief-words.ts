/**
 * The brief's words (Phase 3 Task 11), kept free of the page so the tests
 * can read them: the day as the page's title, the line under it, each
 * action's label, each item's dateline and sentence, what he did with an
 * item and when, the usage line, the bounds of today's limit and the
 * empty morning.
 *
 * Every item's title and text were composed by the engine from the ledger
 * and from model output, so they are only ever cleaned and set as text.
 */
import { TIER_VALUE } from '../../../shared/market-rules.js';
import type { Brief, BriefAction, BriefItem, BudgetWindow } from '../../../shared/types.js';
import { cleanText } from './board.js';
import type { Names } from './detail.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const LABELS: Record<BriefAction, string> = {
  accept: 'Post as a job',
  tier: 'Change the tier',
  dismiss: 'Dismiss',
  why: 'Ask why',
  diff: 'Open the diff',
  fly: 'Fly to the floor',
  retry: 'Retry',
  resume: 'Resume',
  'open-pr': 'Open the PR',
  cap: "Change today's limit",
  audit: 'Audit it',
  tour: 'Walk through the week',
};

/** The label of an action's text button. */
export function actionLabel(a: BriefAction): string {
  return LABELS[a] ?? a;
}

/** The empty morning, said once, quietly. */
export function emptyMorning(): string {
  return 'Nothing waits on you this morning';
}

/** A local day (YYYY-MM-DD) as a date at noon, so no clock change moves it to another day. */
function noonOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
}

/** The page's title: "Tuesday 11 November". */
export function briefTitle(day: string): string {
  const d = noonOf(day);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A clock time as he reads it: 9:14, 18:30. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** When, relative to `today`: "", "yesterday ", "Monday ", or "3 November ". */
function dayWords(ms: number, today: string): string {
  const day = localDay(ms);
  if (day === today) return '';
  const t = noonOf(today).getTime();
  const back = Math.round((t - noonOf(day).getTime()) / 86_400_000);
  if (back === 1) return 'yesterday ';
  const d = new Date(ms);
  if (back > 1 && back < 7) return `${WEEKDAYS[d.getDay()]} `;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} `;
}

/** The repo's short name: harbor-ledger for tidewater/harbor-ledger. */
const shortRepo = (repo: string): string => cleanText(repo.split('/').pop() ?? repo, 80);

/**
 * The row's dateline, as a paper sets the place and time before a story:
 * "kumo, 18:30", "harbor-ledger, yesterday 18:30". The usage, the reading
 * and the tour belong to no repo and are about now, so they carry none.
 */
export function dateline(item: BriefItem, now: number = Date.now()): string {
  if (item.kind === 'usage' || item.kind === 'stale' || item.kind === 'tour') return '';
  // A recommendation to audit is about the repo, not about when it connected.
  if (item.kind === 'audit-due') return item.repo ? shortRepo(item.repo) : '';
  const at = Date.parse(item.at);
  const when = Number.isFinite(at) ? `${dayWords(at, localDay(now))}${clock(at)}` : '';
  const where = item.repo ? shortRepo(item.repo) : 'the city';
  return when ? `${where}, ${when}` : where;
}

const sentenceEnd = (s: string): string => (!s || /[.!?)"]$/.test(s) ? s : `${s}.`);
/** Percentages with decimals, as the engine writes them, said to the whole percent. */
const wholePcts = (s: string): string => s.replace(/(\d+\.\d+)%/g, (_, n: string) => `${Math.round(Number(n))}%`);

/**
 * The item's sentence, set after its dateline and before its actions. It
 * never names the repo again, since the dateline does. A proposal says its
 * tier and what the city would pay; the claim behind it waits under Ask why.
 */
export function itemSentence(item: BriefItem, names: Names): string {
  void names;
  let text = cleanText(item.text, 600);
  if (item.repo) {
    const repo = cleanText(item.repo, 120);
    text = text.split(` on ${repo}`).join('');
  }
  switch (item.kind) {
    case 'proposal': {
      const tier = item.tier ?? 'normal';
      const from = item.refs.auditId ? 'Proposed from its README audit' : sentenceEnd(text).replace(/\.$/, '');
      // Once he answered it, the price is no longer the news: the row says what he did.
      if (item.acted && item.acted.action !== 'tier' && item.acted.action !== 'why') return `${from}.`;
      const pays = `at the ${tier} tier the city pays at most ${TIER_VALUE[tier]} credits`;
      return item.refs.auditId ? `${from}; ${pays}.` : `${from}. ${pays.charAt(0).toUpperCase()}${pays.slice(1)}.`;
    }
    case 'usage':
      return `${sentenceEnd(wholePcts(cleanText(item.title, 200)))} ${wholePcts(text)}`.trim();
    case 'audit-due':
      // The first sentence: what an audit does is said once, under the section.
      return sentenceEnd(text.split(/(?<=\.)\s/)[0] ?? text);
    default:
      return sentenceEnd(text.charAt(0).toUpperCase() + text.slice(1));
  }
}

const DONE: Partial<Record<BriefAction, string>> = {
  accept: 'Posted as a job',
  dismiss: 'Dismissed',
  retry: 'Posted again',
  resume: 'Resumed',
  audit: 'Audit queued',
  tour: 'Walked through the week',
};

/**
 * What he did with the item and when, in quiet words: "Posted as a job,
 * 9:14". Looking (Ask why, the diff, the floor, the PR) is not acting, so
 * it leaves no line. A cap names the limit he set, when given.
 */
export function actedLine(item: BriefItem, capPct?: number | null): string {
  const a = item.acted;
  if (!a) return '';
  const at = clock(Date.parse(a.at));
  if (a.action === 'tier') return `Tier set to ${item.tier ?? 'normal'}, ${at}`;
  if (a.action === 'cap') return typeof capPct === 'number' ? `Today's limit set to ${Math.round(capPct)}% by you, ${at}` : `Today's limit set by you, ${at}`;
  const done = DONE[a.action];
  return done ? `${done}, ${at}` : '';
}

const pctOf = (w: BudgetWindow): number | null => (w.usedPct === null && w.estimatedPct <= 0 ? null : Math.round(Math.max(w.estimatedPct, w.usedPct ?? 0)));

/**
 * Both windows and today's limit, in one sentence: "The five-hour window
 * stands at 45% against today's limit of 50%, the usual cap; the seven-day
 * window at 21%." When he set the limit, it says so and until when.
 */
export function usageLine(usage: Brief['usage'], dayCapPct: number): string {
  const five = pctOf(usage.fiveHour);
  const seven = pctOf(usage.sevenDay);
  const limit = Math.round(usage.todayCapPct ?? usage.fiveHour.capPct ?? dayCapPct);
  const whose = usage.todayCapPct !== null ? 'set by you until midnight' : 'the usual cap';
  if (five === null && seven === null) return `No reading of your plan yet; today's limit is ${limit}%, ${whose}.`;
  return `The five-hour window stands at ${five ?? 0}% against today's limit of ${limit}%, ${whose}; the seven-day window at ${seven ?? 0}%.`;
}

/** What today's limit may be set to: from 5% up to five points under the hard stop (ruling 10). */
export function capBounds(hardStopPct: number): { min: number; max: number } {
  return { min: 5, max: Math.max(5, hardStopPct - 5) };
}

/** The line under the title: where the window starts, and, in a second window, that he has looked already. */
export function sinceLine(since: string, today: string, first: boolean): string {
  const at = Date.parse(since);
  const when = Number.isFinite(at) ? `Since ${dayWords(at, today) || 'this morning '}at ${clock(at)}.` : '';
  return first ? when : `${when} You have opened it once already today.`.trim();
}
