/**
 * The command palette's ranking (Phase 5): one list across everything the
 * city knows, graded prefix, then word start, then substring, then a light
 * fuzzy match, with ties broken by kind and recency. On an empty query the
 * most recent picks rise first. Pure, so the tests need no window.
 */

/** One thing the palette can go to: its kind, its name, one short line of live state, and the way there. */
export interface PaletteEntry {
  /** Unique across kinds: `${kind}:${id}`. Recency is kept by it. */
  key: string;
  kind: string;
  name: string;
  state: string;
  /** Other words it answers to (a repo's short name, a firm's name on its agents), ranked a step under the name. */
  keys?: string[];
  go(): void;
}

/** A pick he made, by the entry's key, newest first. */
export interface RecentPick {
  key: string;
  at: number;
}

/** How many picks are remembered. */
export const RECENT_MAX = 8;

const PREFIX = 4;
const WORD = 3;
const SUBSTRING = 2;
const FUZZY = 1;

const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Where words begin in a folded text: after a space, a hyphen, a slash, a dot or any other separator. */
function wordStarts(text: string): number[] {
  const out: number[] = [];
  let wasLetter = false;
  for (let i = 0; i < text.length; i++) {
    const letter = /[\p{L}\p{N}]/u.test(text[i]);
    if (letter && !wasLetter) out.push(i);
    wasLetter = letter;
  }
  return out;
}

/** A light fuzzy match: the query's letters in order, within a span of three times its length, two letters at least. */
function fuzzy(q: string, text: string): boolean {
  if (q.length < 2) return false;
  const first = text.indexOf(q[0]);
  if (first < 0) return false;
  // Try from each place the first letter stands, so a late start is not missed.
  for (let start = first; start >= 0 && start < text.length; start = text.indexOf(q[0], start + 1)) {
    let i = start;
    let k = 0;
    while (k < q.length && i < text.length) {
      if (text[i] === q[k]) k++;
      i++;
    }
    if (k === q.length && i - start <= q.length * 3) return true;
  }
  return false;
}

function oneWord(q: string, text: string): number {
  if (q === '') return PREFIX;
  if (text.startsWith(q)) return PREFIX;
  if (wordStarts(text).some((i) => text.startsWith(q, i))) return WORD;
  if (text.includes(q)) return SUBSTRING;
  return fuzzy(q, text) ? FUZZY : 0;
}

/**
 * How well a query matches a text: 4 a prefix, 3 the start of a word, 2 a
 * substring, 1 a light fuzzy match, 0 nothing. A query of several words
 * needs every word, in any order, and is graded by the weakest of them.
 */
export function matchTier(query: string, text: string): number {
  const q = fold(query);
  const t = fold(text);
  const whole = oneWord(q, t);
  const words = q.split(' ').filter(Boolean);
  if (words.length < 2) return whole;
  const each = Math.min(...words.map((w) => oneWord(w, t)));
  return Math.max(whole, each);
}

/** An entry's grade: its name as is, its other keys two steps under (a job found by its repo's name sits below the district itself). */
function entryTier(query: string, e: PaletteEntry): number {
  let best = matchTier(query, e.name);
  for (const k of e.keys ?? []) best = Math.max(best, Math.min(SUBSTRING, matchTier(query, k)));
  return best;
}

/**
 * The entries that answer a query, best first: tier, then the kinds in the
 * order their sources are registered (a kind not in the list sorts after
 * the known ones), then the most recent pick first, then the name. An
 * empty query lists the recent picks newest first, then everything by kind
 * in their sources' order.
 */
export function rank(query: string, entries: PaletteEntry[], recent: RecentPick[], kinds: string[]): PaletteEntry[] {
  const q = fold(query);
  const recency = new Map([...recent].sort((a, b) => b.at - a.at).map((r, i) => [r.key, i]));
  const kindOrder = (k: string): number => {
    const i = kinds.indexOf(k);
    return i < 0 ? kinds.length : i;
  };
  const byName = (a: PaletteEntry, b: PaletteEntry): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (q === '') {
    const picked = entries.filter((e) => recency.has(e.key)).sort((a, b) => recency.get(a.key)! - recency.get(b.key)!);
    // Within a kind, the order its source gave (the router's pages in the head's order, the engine's lists as served).
    const rest = entries.filter((e) => !recency.has(e.key)).sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    return [...picked, ...rest];
  }
  const graded = entries.map((e) => ({ e, tier: entryTier(q, e) })).filter((x) => x.tier > 0);
  graded.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    const k = kindOrder(a.e.kind) - kindOrder(b.e.kind);
    if (k !== 0) return k;
    const ra = recency.get(a.e.key) ?? Number.POSITIVE_INFINITY;
    const rb = recency.get(b.e.key) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return byName(a.e, b.e);
  });
  return graded.map((x) => x.e);
}

/** The picks with this one newest, once, capped at RECENT_MAX. */
export function rememberPick(recent: RecentPick[], key: string, at: number, max = RECENT_MAX): RecentPick[] {
  return [{ key, at }, ...recent.filter((r) => r.key !== key)].slice(0, max);
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The empty state's one quiet line: what the city holds. Counts of zero are
 * left out; the first two (a city's districts and floors) are joined with
 * "and" as one measure, the rest follow in pairs.
 */
export function tallyLine(counts: Array<[number, string]>): string {
  const parts = counts.filter(([n]) => n > 0).map(([n, one]) => plural(n, one));
  if (parts.length === 0) return 'The city is empty so far. Connect a repo to raise its first district.';
  const groups: string[] = [];
  for (let i = 0; i < parts.length; i += 2) groups.push(parts.slice(i, i + 2).join(' and '));
  return `The city holds ${groups.join(', ')}.`;
}
