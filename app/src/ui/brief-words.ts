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
import { AGREE, isBeagle, WORK_KINDS } from '../../../shared/school-rules.js';
import type { Brief, BriefAction, BriefItem, BudgetWindow, Grant, WorkKind } from '../../../shared/types.js';
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
  // Phase 4: an ask for autonomy, and an act under a grant.
  grant: 'Let the city do this on its own here',
  decline: 'Not yet',
  revoke: 'Take it back',
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
  if (item.kind === 'autonomy' || item.kind === 'acted') {
    text = sayKinds(text);
    if (item.repo) text = text.split(`on its last ${AGREE.repoLast} on ${cleanText(item.repo, 120)}`).join(`on its last ${AGREE.repoLast} here`);
  }
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
  grant: 'Granted',
  decline: `Not yet; quiet for ${AGREE.quietDays} days`,
  revoke: 'Taken back',
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
  const whose = usage.todayCapPct === null ? 'the usual cap' : Math.round(usage.todayCapPct) === Math.round(dayCapPct) ? 'the usual cap, held by you until midnight' : 'set by you until midnight';
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

// ---------------------------------------------------------------- autonomy (Phase 4 Task 31)

const KIND_WORDS: Record<WorkKind, string> = {
  'propose:harness': 'harness proposals',
  'propose:readme-gap': 'README gap proposals',
  'merge:low': 'low-tier merges',
  'merge:normal': 'normal-tier merges',
  'merge:high': 'high-tier merges',
  'merge:ui': 'UI merges',
};

/** A kind of his work in words: "README gap proposals", "low-tier merges". */
export function kindWords(kind: WorkKind): string {
  return KIND_WORDS[kind] ?? kind;
}

const CODES = new RegExp(`\\b(${WORK_KINDS.map((k) => k.replace(/[-:]/g, (c) => `\\${c}`)).join('|')})\\b`, 'g');

/**
 * The engine names a kind by its code ("50 merge:low decisions", "its
 * merge:low grant"); he reads it in words ("50 low-tier merges", "its grant
 * for low-tier merges").
 */
function sayKinds(text: string): string {
  return text
    .replace(new RegExp(`(\\d+) ${CODES.source} decisions`, 'g'), (_, n: string, k: WorkKind) => `${n} ${kindWords(k)}`)
    .replace(new RegExp(`its ${CODES.source} grant`, 'g'), (_, k: WorkKind) => `its grant for ${kindWords(k)}`)
    .replace(CODES, (k) => kindWords(k as WorkKind));
}

/** "3 November", in local time. */
const dayMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** When an ask came, as he would say it: today, yesterday, on Tuesday, on 1 November. */
function askedWhen(ms: number, now: number): string {
  const w = dayWords(ms, localDay(now)).trim();
  if (!w) return 'today';
  if (w === 'yesterday') return w;
  return `on ${w}`;
}

/** What the city has done under a grant: "6 merges", "2 proposals accepted", "none". */
function actedSince(g: Grant): string {
  if (g.acted <= 0) return 'none';
  if (g.kind.startsWith('merge:')) return `${g.acted} merge${g.acted === 1 ? '' : 's'}`;
  return `${g.acted} proposal${g.acted === 1 ? '' : 's'} accepted`;
}

/** His undo, as decisions.ts writes the suspension's reason. */
const UNDO_REASON = 'he undid it';

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A pair's state in a few words, as a ledger sets them: "asked on Tuesday",
 * "granted 3 November, 6 merges since", "revoked by a revert on 8
 * November", "you took it back; quiet until 2 December", "suspended: you
 * undid an accepted proposal". A suspension the school made for its own
 * reason keeps the engine's sentence whole, its kinds said in words.
 */
export function grantState(g: Grant, now: number = Date.now()): string {
  const at = Date.parse(g.at);
  const quiet = g.quietUntil && Date.parse(g.quietUntil) > now ? dayMonth(Date.parse(g.quietUntil)) : null;
  switch (g.state) {
    case 'asked':
      return `asked ${askedWhen(at, now)}`;
    case 'granted':
      return `granted ${dayMonth(at)}, ${actedSince(g)} since`;
    case 'suspended': {
      if (!g.reason) return 'suspended by the school';
      if (g.reason.trim() === UNDO_REASON) return `suspended: ${g.kind.startsWith('propose:') ? 'you undid an accepted proposal' : 'you undid a merge it made'}`;
      return `suspended: ${lowerFirst(sayKinds(cleanText(g.reason, 400)).replace(/\.$/, ''))}`;
    }
    case 'revoked':
      if (g.by === 'revert') return `revoked by a revert on ${dayMonth(at)}`;
      return quiet ? `you took it back; quiet until ${quiet}` : `you took it back on ${dayMonth(at)}`;
    case 'declined':
      return quiet ? `you said not yet; quiet until ${quiet}` : `you said not yet on ${dayMonth(at)}`;
  }
}

export type GrantMove = 'grant' | 'decline' | 'revoke' | 'regrant';

/** Each move's label, the brief's own words for the first three. */
export const MOVE_LABEL: Record<GrantMove, string> = {
  grant: LABELS.grant,
  decline: LABELS.decline,
  revoke: LABELS.revoke,
  regrant: 'Grant it again',
};

/**
 * What a pair offers, and only what the engine accepts (Task 16): an open
 * ask is granted or declined; a granted or suspended pair is taken back; a
 * revoked pair is granted again from Settings alone; a decline waits out
 * its quiet. Beagle is never offered a grant.
 */
export function grantMoves(g: Grant, where: 'settings' | 'district'): GrantMove[] {
  const beagle = isBeagle(g.repo);
  switch (g.state) {
    case 'asked':
      return beagle ? ['decline'] : ['grant', 'decline'];
    case 'granted':
    case 'suspended':
      return ['revoke'];
    case 'revoked':
      return where === 'settings' && !beagle ? ['regrant'] : [];
    case 'declined':
      return [];
  }
}
