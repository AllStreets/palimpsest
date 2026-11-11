/**
 * The job board's view logic (Task 36), kept free of the page so the tests
 * can read it: which section each job stands in, the words for a run's
 * progress and a round's clock, the order the award ranks bids in, and the
 * clean-up every piece of text from GitHub passes before it is shown.
 */
import type { Agent, Bid, FirmView, Job, JobStatus, Repo, RunProgress, RunStage } from '../../../shared/types.js';

export type SectionKey = 'proposed' | 'bidding' | 'running' | 'waiting' | 'done' | 'failed' | 'halted';

export interface Section {
  key: SectionKey;
  title: string;
  jobs: Job[];
  /** Repos whose market is halted (the halted section only). */
  repos: Repo[];
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  proposed: 'Proposed',
  bidding: 'Bidding',
  running: 'Running',
  waiting: 'Waiting on you',
  done: 'Done today',
  failed: 'Failed',
  halted: 'Halted',
};

const ORDER: SectionKey[] = ['proposed', 'bidding', 'running', 'waiting', 'done', 'failed', 'halted'];
const DAY_MS = 86_400_000;
/** How long a failed job stays on the board. */
export const FAILED_DAYS = 7;

/** Two instants on the same local day. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** The section a job stands in now, or null when it has left the board. */
export function sectionOf(j: Job, now: number): SectionKey | null {
  switch (j.status) {
    case 'proposed':
      return 'proposed';
    case 'open':
    case 'bidding':
      return 'bidding';
    case 'awarded':
    case 'running':
    case 'inspecting':
    case 'shipping':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'merged':
    case 'closed':
      return j.closedAt && sameDay(Date.parse(j.closedAt), now) ? 'done' : null;
    case 'failed':
      return !j.closedAt || now - Date.parse(j.closedAt) < FAILED_DAYS * DAY_MS ? 'failed' : null;
    case 'halted':
      return 'halted';
    default:
      return null;
  }
}

const RUNNING_ORDER: JobStatus[] = ['running', 'inspecting', 'shipping', 'awarded'];
const ts = (s: string | null | undefined): number => (s ? Date.parse(s) : 0);

function sortSection(key: SectionKey, jobs: Job[]): Job[] {
  const byPosted = (a: Job, b: Job) => ts(a.postedAt) - ts(b.postedAt) || a.id.localeCompare(b.id);
  switch (key) {
    case 'bidding':
      // Rounds under way first, the soonest to close at the top; then jobs waiting for their round.
      return [...jobs].sort((a, b) => Number(a.status !== 'bidding') - Number(b.status !== 'bidding') || ts(a.bidsCloseAt) - ts(b.bidsCloseAt) || byPosted(a, b));
    case 'running':
      return [...jobs].sort((a, b) => RUNNING_ORDER.indexOf(a.status) - RUNNING_ORDER.indexOf(b.status) || byPosted(a, b));
    case 'done':
    case 'failed':
      return [...jobs].sort((a, b) => ts(b.closedAt) - ts(a.closedAt) || a.id.localeCompare(b.id));
    default:
      return [...jobs].sort(byPosted);
  }
}

/**
 * The board's sections in the order he reads them, each with its jobs; empty
 * sections are left out. `repo` narrows the board to one repo. The halted
 * section also names every halted repo, with or without a job on it.
 */
export function boardSections(jobs: Job[], repos: Repo[], now: number, repo: string | null = null): Section[] {
  const by = new Map<SectionKey, Job[]>();
  for (const j of jobs) {
    if (repo && j.repo !== repo) continue;
    const k = sectionOf(j, now);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), j]);
  }
  const halted = repos.filter((r) => r.halted && (!repo || r.fullName === repo)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const out: Section[] = [];
  for (const key of ORDER) {
    const list = sortSection(key, by.get(key) ?? []);
    const rs = key === 'halted' ? halted : [];
    if (list.length === 0 && rs.length === 0) continue;
    out.push({ key, title: SECTION_TITLES[key], jobs: list, repos: rs });
  }
  return out;
}

// ---------------------------------------------------------------- words

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "14 tool calls, 2 tests run, 1 refused": the run's real counts, the zero ones left out. */
export function progressWords(p: RunProgress): string {
  const parts: string[] = [];
  if (p.toolCalls) parts.push(count(p.toolCalls, 'tool call', 'tool calls'));
  if (p.filesChanged) parts.push(count(p.filesChanged, 'file changed', 'files changed'));
  if (p.testsRun) parts.push(`${p.testsRun} ${p.testsRun === 1 ? 'test' : 'tests'} run`);
  if (p.refusals) parts.push(`${p.refusals} refused`);
  return parts.length ? parts.join(', ') : 'no tool calls yet';
}

/** The round's clock: "closes in 1:24", "closing" once it is past, or when a round has yet to open. */
export function closesIn(closeAt: string | null, now: number): string {
  if (!closeAt) return 'opens for bids on the next round';
  const left = Math.ceil((Date.parse(closeAt) - now) / 1000);
  if (!(left > 0)) return 'closing';
  return `closes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const STAGE_WORDS: Record<RunStage, string> = {
  preparing: 'Preparing',
  installing: 'Installing',
  working: 'Working',
  inspecting: 'With the inspectors',
  shipping: 'Opening the pull request',
  waiting: 'Waiting on you',
  done: 'Done',
};

/** Where a job in the running section has got to. */
export function stageOf(j: Job, stage: RunStage | null): string {
  if (j.status === 'awarded' || !stage) return j.status === 'inspecting' ? STAGE_WORDS.inspecting : j.status === 'shipping' ? STAGE_WORDS.shipping : 'Awarded, waiting for the site';
  return STAGE_WORDS[stage];
}

/** The live stages in order, for the small ticks beside a running job. */
export const LIVE_STAGES: RunStage[] = ['preparing', 'installing', 'working', 'inspecting', 'shipping'];

/** Highest expected value first; ties to the lower price, then the higher calibrated chance, then the earlier bid (the award's own rule). */
export function bidOrder(bids: Bid[]): Bid[] {
  return [...bids].sort((a, b) => b.ev - a.ev || a.price - b.price || b.calibrated - a.calibrated || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Credits: whole numbers bare, anything else to the cent. */
export function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** A chance as a whole percent, or "no record" when the city has none. */
export function pct(x: number | null | undefined): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'no record';
}

// ---------------------------------------------------------------- text from GitHub

/** Control characters (newlines and tabs are folded with the other whitespace). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Characters that hide or reorder text: zero widths, bidi marks, overrides and isolates, the Arabic letter mark, the soft hyphen, the Mongolian vowel separator, the grapheme joiner, word joiners and the byte order mark. */
export const HIDDEN = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Text written on GitHub (titles, bodies) is untrusted: it is only ever set
 * as text, never as markup, and this takes out what could hide or reorder
 * it, folds its whitespace and caps its length.
 */
export function cleanText(s: unknown, max = 200): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(HIDDEN, '').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ---------------------------------------------------------------- the round and links

/** The agents that may answer a job's round, by the market's own rule: working, in an active firm the job has not excluded, bidding on its tier. */
export function eligible(j: Job, firms: FirmView[]): Agent[] {
  const excluded = new Set(j.excludedFirms ?? []);
  return firms.filter((f) => f.status === 'active' && !excluded.has(f.id)).flatMap((f) => f.agents.filter((a) => !a.retired && a.bidsOn.includes(j.tier)));
}

/** A link that may leave the page: https on github.com only, or null. */
export function githubUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !/^https:\/\/github\.com\/\S*$/.test(u)) return null;
  return u;
}

/** The first plain sentence of an issue body: comments, tags, headings and markdown marks taken out. */
export function excerpt(body: unknown, max = 180): string {
  if (typeof body !== 'string') return '';
  const plain = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  for (const raw of plain.split(/\n\s*\n|\n(?=#)/)) {
    const line = raw
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join(' ')
      .replace(/[*_`~>]+/g, '')
      .replace(/^\s*[-+]\s+/, '');
    const t = cleanText(line, max);
    if (t) return t;
  }
  return '';
}
