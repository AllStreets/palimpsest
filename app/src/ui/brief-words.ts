/**
 * The brief's words (Phase 3 Task 11), kept free of the page so the tests
 * can read them: the day as the page's title, the line under it, each
 * action's label and weight, each item's place and time, its readouts and
 * its sentence, what he did with an item and when, the usage line, the
 * bounds of today's limit and the empty morning.
 *
 * Screens redesign Task 16 cut the words hard: a row is a headline plus
 * figures, read from the engine's fields (item.figures, Brief.counts) and
 * never parsed out of a sentence; money sits on the key that spends it;
 * the whole sentence (itemSentence) waits behind Why and in the reader's
 * text.
 *
 * Every item's title and text were composed by the engine from the ledger
 * and from model output, so they are only ever cleaned and set as text.
 */
import { creditsText, TIER_VALUE, windowNowPct } from '../../../shared/market-rules.js';
import { AGREE, isBeagle, WORK_KINDS } from '../../../shared/school-rules.js';
import type { Brief, BriefAction, BriefItem, BriefItemKind, BudgetWindow, Grant, WorkKind } from '../../../shared/types.js';
import { cleanText } from './board.js';
import { ACTIONS } from './brief-actions.js';
import type { Names } from './detail.js';
import type { Weight } from './os/control.js';
import type { Readout } from './os/readout-model.js';
import type { Tone } from './os/tokens.js';
import { clock } from './time-words.js';
import { briefHandled } from '../../../shared/brief-rules.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** The label of an action's key: "Post", "Why", read from its row in ACTIONS. */
export function actionLabel(a: BriefAction): string {
  return ACTIONS[a]?.label ?? a;
}

/** The weight of an action's key, by consequence, read from its row in ACTIONS. */
export function weightOf(a: BriefAction): Weight {
  return ACTIONS[a]?.weight ?? 'look';
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

// ---------------------------------------------------------------- the row's figures (screens redesign Task 16)

/** A count or a percent as a figure, or null when it is no number. */
const num = (n: number | null | undefined): string | null => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : null);

/** The firm on the row, by name, quiet: the firm is who, not state. */
function firmOut(item: BriefItem, names: Names): Readout[] {
  const id = item.refs.firmId;
  if (!id) return [];
  const name = cleanText(names.firm(id), 60);
  return name ? [{ v: name, tone: 'quiet' }] : [];
}

/**
 * The row's readouts, in place of a sentence: figures and short keys, read
 * from item.figures and item.refs alone, never from the text. A kind with
 * no numbers shows its state or nothing; no readout is ever empty. The key
 * sums (a proposal's cost, a retry's, an audit's, a resume's) are never
 * readouts: they sit on the key that spends them (keySum).
 */
export function itemReadouts(item: BriefItem, names: Names): Readout[] {
  const f = item.figures;
  const out: Readout[] = [];
  switch (item.kind) {
    case 'merged':
      out.push({ v: 'merged', tone: 'ok' });
      if (f?.kind === 'merged' && f.paid !== null && Number.isFinite(f.paid) && f.paid > 0) out.push({ v: creditsText(f.paid), k: 'cr' });
      out.push(...firmOut(item, names));
      break;
    case 'pr': {
      const n = f?.kind === 'pr' ? num(f.pr) : null;
      if (n) out.push({ v: `#${n}`, k: 'PR' });
      out.push(...firmOut(item, names), { v: 'review', tone: 'warn' });
      break;
    }
    case 'failed': {
      out.push({ v: 'failed', tone: 'fail' });
      const left = f?.kind === 'failed' ? f.attemptsLeft : null;
      if (left !== null && Number.isFinite(left)) out.push(left > 0 ? { v: String(left), k: left === 1 ? 'attempt left' : 'attempts left' } : { v: 'no attempts left', tone: 'quiet' });
      break;
    }
    case 'halt':
      out.push({ v: 'halted', tone: 'fail' });
      break;
    case 'revert':
      out.push({ v: 'reverted', tone: 'fail' });
      if (f?.kind === 'revert' && f.sha) out.push({ v: cleanText(f.sha, 12), k: 'commit' });
      break;
    case 'proposal':
      out.push({ v: item.tier ?? 'normal', k: 'tier' });
      break;
    case 'audit': {
      // The claims are the row's bar; the readout is what the audit asks of him.
      const n = f?.kind === 'audit' ? num(f.jobs) : null;
      if (n) out.push({ v: n, k: f?.kind === 'audit' && f.jobs === 1 ? 'job proposed' : 'jobs proposed' });
      break;
    }
    case 'audit-due':
      out.push({ v: 'never audited', tone: 'warn' });
      break;
    case 'usage':
      if (f?.kind === 'usage') {
        const now = num(f.nowPct);
        const cap = num(f.capPct);
        if (now) out.push({ v: `${now}%`, k: f.window });
        if (cap) out.push({ v: `${cap}%`, k: f.mine ? 'your limit' : 'cap' });
      }
      break;
    case 'autonomy':
      if (f?.kind === 'autonomy') {
        if (num(f.agreed) && num(f.of) && f.of > 0) out.push({ v: `${num(f.agreed)}/${num(f.of)}`, k: 'agreed' });
        if (num(f.here) && num(f.hereOf) && f.hereOf > 0) out.push({ v: `${num(f.here)}/${num(f.hereOf)}`, k: 'here' });
      }
      break;
    case 'tour':
      if (f?.kind === 'tour') {
        const n = num(f.stops);
        if (n && f.stops > 0) out.push({ v: n, k: f.stops === 1 ? 'stop' : 'stops' });
        if (Number.isFinite(f.seconds) && f.seconds > 0) out.push({ v: String(Math.max(1, Math.round(f.seconds / 60))), k: 'min' });
      }
      break;
    // note, stale, milestone, graduate and acted carry no figures: the headline is the news.
  }
  return out.filter((r) => r.v.length > 0);
}

/**
 * The sum on an action's key, as the most it may spend: "60 cr" on a
 * proposal's Post, a failed job's Retry, a recommendation's Audit and a
 * halt's Resume. Only while that action is offered (figures keep the sum
 * after he acts), and never for a sum of 0. Every other key has none.
 */
export function keySum(item: BriefItem, a: BriefAction): string | null {
  const n = keyCredits(item, a);
  return n === null ? null : `${creditsText(n)} cr`;
}

function keyCredits(item: BriefItem, a: BriefAction): number | null {
  if (!item.actions.includes(a)) return null;
  const f = item.figures;
  let n: number | null = null;
  if (a === 'accept' && f?.kind === 'proposal') n = f.cost;
  else if (a === 'retry' && f?.kind === 'failed') n = f.retry;
  else if (a === 'audit' && f?.kind === 'audit-due') n = f.audit;
  else if (a === 'resume' && f?.kind === 'halt') n = f.resume;
  return n !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/** A key's name for the reader, with its sum: "Post, up to 60 credits: Add a test command". */
export function keyAria(item: BriefItem, a: BriefAction, head: string): string {
  const n = keyCredits(item, a);
  return `${actionLabel(a)}${n === null ? '' : `, up to ${creditsText(n)} credits`}: ${head}`;
}

const pad2 = (n: number): string => String(Math.max(0, Math.round(n))).padStart(2, '0');

/** The head's figures, from Brief.counts: what waits (lit when anything does), what merged, what the city spent. */
export function headFigures(b: Brief): Array<{ value: string; label: string; tone?: Tone | 'hot' }> {
  const { waiting, merged, spent } = b.counts;
  return [
    { value: pad2(waiting), label: 'waiting', ...(waiting > 0 ? { tone: 'hot' as const } : {}) },
    { value: pad2(merged), label: 'merged' },
    { value: creditsText(spent), label: 'credits spent' },
  ];
}

const TONE: Partial<Record<BriefItemKind, Tone | 'ask' | 'grant'>> = {
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

/** Each kind's state, the ink of its designator and its pin; quiet for a kind that carries none. */
export function toneOf(kind: BriefItemKind): Tone | 'ask' | 'grant' {
  return TONE[kind] ?? 'quiet';
}

/** A pin's tone: an autonomy item with no grant left to give (only looked at, answered elsewhere) is quiet, as its row is. */
export function pinToneOf(item: BriefItem): Tone | 'ask' | 'grant' {
  return item.kind === 'autonomy' && !item.actions.includes('grant') ? 'quiet' : toneOf(item.kind);
}

/** The most words the stream carries. */
const STREAM_MAX = 24;

/** The stream under the list: the brief's own repo names, figures, PR numbers and states, in its order. */
export function streamWords(b: Brief, names: Names): string[] {
  const { waiting, overnight, recommendations, city } = b.sections;
  return [...waiting, ...overnight, ...recommendations, ...city]
    .flatMap((i) => [i.repo ? shortRepo(i.repo) : '', ...itemReadouts(i, names).map((r) => r.v)])
    .filter((w) => /\w/.test(w))
    .slice(0, STREAM_MAX);
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

/**
 * What he did with the item and when, as a short readout: "Posted 09:14",
 * "Tier low 09:14", "Limit 60% 09:14". Looking (Why, the diff, the floor,
 * the PR) is not acting, so it leaves no line. A cap names the limit he
 * set, when given.
 */
export function actedLine(item: BriefItem, capPct?: number | null): string {
  const a = item.acted;
  if (!a) return '';
  const at = clock(Date.parse(a.at));
  if (a.action === 'tier') return `Tier ${item.tier ?? 'normal'} ${at}`;
  if (a.action === 'cap') return typeof capPct === 'number' ? `Limit ${Math.round(capPct)}% ${at}` : `Limit set ${at}`;
  const done = ACTIONS[a.action]?.done;
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

/**
 * The window the brief covers: "Since 06:40" today, "Since yesterday
 * 06:40", "Since 12 Nov 06:40" before that, and nothing without a time. In
 * a later window the same day it adds ", second look".
 */
export function sinceLine(since: string, today: string, first: boolean): string {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return '';
  const day = localDay(at);
  const back = Math.round((noonOf(today).getTime() - noonOf(day).getTime()) / 86_400_000);
  const d = new Date(at);
  const when = day === today ? '' : back === 1 ? 'yesterday ' : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} `;
  return `Since ${when}${clock(at)}${first ? '' : ', second look'}`;
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

/** Each move's label, as Settings and the district page say it. */
export const MOVE_LABEL: Record<GrantMove, string> = {
  // Settings and the district page keep their long words until their own redesign.
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
