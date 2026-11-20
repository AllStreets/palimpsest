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
import { TIER_VALUE, windowNowPct } from '../../../shared/market-rules.js';
import { AGREE, isBeagle, WORK_KINDS } from '../../../shared/school-rules.js';
import type { Brief, BriefAction, BriefItem, BudgetWindow, Grant, WorkKind } from '../../../shared/types.js';
import { cleanText } from './board.js';
import type { Names } from './detail.js';
import { clock } from './time-words.js';
import { briefHandled } from '../../../shared/brief-rules.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const LABELS: Record<BriefAction, string> = {
  accept: 'Post',
  tier: 'Tier',
  dismiss: 'Dismiss',
  why: 'Why',
  diff: 'Diff',
  fly: 'Fly there',
  retry: 'Retry',
  resume: 'Resume',
  'open-pr': 'Open PR',
  cap: 'Set limit',
  audit: 'Audit',
  tour: 'Walk the week',
  // Phase 4: an ask for autonomy, and an act under a grant.
  grant: 'Let it act here',
  decline: 'Not yet',
  revoke: 'Take back',
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

/** A clock time as the whole app writes it: 09:14, 18:30 (time-words.ts). */
export { clock };

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
 * Where and when, over the row's headline: { where: 'kumo', when: '18:30' },
 * { where: 'harbor-ledger', when: 'yesterday 18:30' }. The usage, the
 * reading and the tour belong to no repo and are about now, so they carry
 * none; a recommendation to audit is about the repo, not when it connected.
 */
export function briefMeta(item: BriefItem, now: number = Date.now()): { where: string; when: string } {
  if (item.kind === 'usage' || item.kind === 'stale' || item.kind === 'tour') return { where: '', when: '' };
  if (item.kind === 'audit-due') return { where: item.repo ? shortRepo(item.repo) : '', when: '' };
  const at = Date.parse(item.at);
  return { where: item.repo ? shortRepo(item.repo) : 'the city', when: Number.isFinite(at) ? `${dayWords(at, localDay(now))}${clock(at)}` : '' };
}

/** A readout under a headline: a figure, its short unit or label, and a state tone. */
export interface Readout {
  v: string;
  k?: string;
  tone?: 'ok' | 'warn' | 'fail' | 'quiet';
}

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5' };

/** The audit's claims as counts, for its bar: real, partial, missing, broken, and the jobs it proposed. */
export function auditCounts(text: string): { real: number; partial: number; missing: number; broken: number; jobs: number } | null {
  const m = /(\d+) real, (\d+) partial, (\d+) missing and (\d+) broken(?:; (\d+) jobs? proposed)?/.exec(text);
  if (!m) return null;
  return { real: +m[1], partial: +m[2], missing: +m[3], broken: +m[4], jobs: m[5] ? +m[5] : 0 };
}

/** The autonomy ask's evidence: agreed of the last n, and the run here. */
export function agreementOf(text: string): { agreed: number; of: number; here: number | null } | null {
  const all = /agreed with you on (\d+) of the last (\d+)/.exec(text);
  if (!all) return null;
  const here = /on its last (\d+) (?:here|on )/.exec(text);
  return { agreed: +all[1], of: +all[2], here: here ? +here[1] : null };
}

/** The lead's two sentences as figures: what waits, what merged, what the city spent. */
export function leadFigures(lead: string): { waiting: number; merged: number; spent: string | null } {
  const waiting = /(\d+) things? waits? on you/.exec(lead);
  const merged = /(\d+) merged/.exec(lead);
  const spent = /spent ([\d,.]+) credits/.exec(lead);
  return { waiting: waiting ? +waiting[1] : 0, merged: merged ? +merged[1] : 0, spent: spent ? spent[1] : null };
}

/** The first clause of a sentence, cut to a readout's length at a word. */
function clause(text: string, max = 56): string {
  const first = (text.split(/(?<=[.;:])\s/)[0] ?? text).replace(/[.;:]$/, '');
  if (first.length <= max) return first;
  return `${first.slice(0, max).replace(/\s+\S*$/, '')}...`;
}

/**
 * The row's readouts, in place of a sentence: figures and short labels.
 * The whole sentence waits one tap away, under Why.
 */
export function itemReadouts(item: BriefItem, names: Names): Readout[] {
  const text = itemSentence(item, names);
  const raw = cleanText(item.text, 600);
  switch (item.kind) {
    case 'proposal':
      return [{ v: item.tier ?? 'normal', k: 'tier' }];
    case 'merged': {
      const m = /and (.+?) was paid ([\d,.]+) credits/.exec(raw);
      return m ? [{ v: 'merged', tone: 'ok' }, { v: m[2], k: 'cr' }, { v: cleanText(m[1], 60), tone: 'quiet' }] : [{ v: 'merged', tone: 'ok' }];
    }
    case 'pr': {
      const n = /PR #(\d+)/.exec(raw);
      const by = / by (.+?) waits/.exec(raw);
      return [...(n ? [{ v: `#${n[1]}`, k: 'PR' }] : []), ...(by ? [{ v: cleanText(by[1], 60), tone: 'quiet' as const }] : []), { v: 'review', tone: 'warn' }];
    }
    case 'failed': {
      if (/for good/.test(raw)) return [{ v: 'failed', tone: 'fail' }, { v: 'no attempts left', tone: 'quiet' }];
      const left = /with (\w+) attempts? left/.exec(raw);
      return [{ v: 'failed', tone: 'fail' }, ...(left ? [{ v: NUMBER_WORDS[left[1]] ?? left[1], k: 'attempt left' }] : [])];
    }
    case 'halt':
      return [{ v: 'halted', tone: 'fail' }];
    case 'revert':
      return [{ v: 'reverted', tone: 'fail' }];
    case 'audit': {
      const c = auditCounts(raw);
      // The claims are the row's bar; the readout is what the audit asks of him.
      return c ? [{ v: String(c.jobs), k: 'jobs proposed' }] : [{ v: clause(text) }];
    }
    case 'audit-due':
      return [{ v: 'never audited', tone: 'warn' }];
    case 'usage': {
      const now = /(\d+(?:\.\d+)?)%/.exec(item.title);
      const cap = /cap is (\d+)%/.exec(raw);
      return [...(now ? [{ v: `${Math.round(Number(now[1]))}%`, k: 'five-hour' }] : []), ...(cap ? [{ v: `${cap[1]}%`, k: 'cap' }] : [])];
    }
    case 'autonomy': {
      const a = agreementOf(raw);
      return a ? [{ v: `${a.agreed}/${a.of}`, k: 'agreed' }, ...(a.here !== null ? [{ v: `${a.here}/${a.here}`, k: 'here' }] : [])] : [{ v: clause(text) }];
    }
    case 'tour':
      return [{ v: clause(text.replace(/^A walk through last week, /, ''), 40) }];
    default:
      return [{ v: clause(text) }];
  }
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
  accept: 'Posted',
  dismiss: 'Dismissed',
  retry: 'Posted again',
  resume: 'Resumed',
  audit: 'Audit queued',
  tour: 'Walked',
  grant: 'Granted',
  decline: `Not yet, quiet ${AGREE.quietDays} days`,
  revoke: 'Taken back',
};

/**
 * What he did with the item and when, as a short readout: "Posted 09:14".
 * Looking (Why, the diff, the floor, the PR) is not acting, so it leaves no
 * line. A cap names the limit he set, when given.
 */
export function actedLine(item: BriefItem, capPct?: number | null): string {
  const a = item.acted;
  if (!a) return '';
  const at = clock(Date.parse(a.at));
  if (a.action === 'tier') return `Tier ${item.tier ?? 'normal'} ${at}`;
  if (a.action === 'cap') return typeof capPct === 'number' ? `Limit ${Math.round(capPct)}% ${at}` : `Limit set ${at}`;
  const done = DONE[a.action];
  return done ? `${done} ${at}` : '';
}

/** A window now, as Settings and the treasury show it too (shared windowNowPct). */
const pctOf = (w: BudgetWindow): number | null => windowNowPct(w);

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

/** The window the brief covers, as a readout: "Since yesterday 06:40", and in a second window ", second look". */
export function sinceLine(since: string, today: string, first: boolean): string {
  const at = Date.parse(since);
  const when = Number.isFinite(at) ? `Since ${dayWords(at, today)}${clock(at)}` : '';
  return first ? when : `${when}, second look`.replace(/^, /, '');
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

/** Each move's label in Settings and on the district page, which keep their longer words until their own redesign. */
export const MOVE_LABEL: Record<GrantMove, string> = {
  grant: 'Let the city do this on its own here',
  decline: 'Not yet',
  revoke: 'Take it back',
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

// ---------------------------------------------------------------- Waiting on you (audit 2026-11-17)

/** The quieter group under Waiting on you: rows he already settled today. */
export const HANDLED_HEAD = 'Handled today';

/** Waiting on you split in two: what still needs a click, in order, then what he settled (posted, dismissed...). */
export function waitingGroups(items: BriefItem[]): { open: BriefItem[]; handled: BriefItem[] } {
  return { open: items.filter((i) => !briefHandled(i)), handled: items.filter((i) => briefHandled(i)) };
}
