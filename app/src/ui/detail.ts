/**
 * The view logic of the job, run and inspection pages (Task 37), kept free
 * of the page so the tests can read it: the run's log folded into a
 * transcript, the diff split by file, the issue body as markdown blocks,
 * the award told in prose, the ledger as dated sentences and the
 * inspection's verdict line.
 *
 * Everything a run produces (its log, its diff) and everything written on
 * GitHub is untrusted: it is cleaned and redacted here and the pages only
 * ever set it as text.
 */
import { TIER_VALUE } from '../../../shared/market-rules.js';
import type { Bid, CheckName, InspectionView, LedgerRow, RunLogLine, Tier } from '../../../shared/types.js';
import { bidOrder, cleanText, githubUrl, HIDDEN, money, pct } from './board.js';

export interface Names {
  agent(id: string): string;
  firm(id: string): string;
}

// ---------------------------------------------------------------- untrusted text

/** Terminal escapes: colours and cursor moves (CSI), and titles and links (OSC). */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
/** Control characters other than the tab and the newline. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** The longest single log line or diff line the page holds. */
const LINE_MAX = 20_000;

/** A line from a run as text the page may hold: no escapes, no hidden or control characters, tabs and newlines kept. */
export function cleanLog(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(HIDDEN, '');
  return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t;
}

/** A home folder on this Mac or another machine, as the start of a path. */
const HOME = /\/(?:Users|home)\/[^/\s'"`)\]]+|\/var\/root(?=\/|\b)/g;
/** Token shapes that are always secret, wherever they stand. */
const TOKENS: RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:xox[abposr]-|glpat-)[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g,
];
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/g;

function redactCommon(s: string): string {
  let t = s.replace(HOME, '~');
  for (const re of TOKENS) t = t.replace(re, '[redacted]');
  return t.replace(BEARER, '$1 [redacted]');
}

/**
 * A log line with this Mac's paths and anything shaped like a token taken
 * out (the engine has redacted it already; this is the page's own guard).
 * A long run of mixed letters and digits counts as a token; a bare sha does not.
 */
export function redactLog(s: string): string {
  return redactCommon(s).replace(/[A-Za-z0-9+_/]{40,}={0,2}/g, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m));
}

/** A diff line: homes and known token shapes only, so the code's own long names survive. */
export function redactDiff(s: string): string {
  return redactCommon(s);
}

// ---------------------------------------------------------------- the transcript

export type EntryKind = 'system' | 'engine' | 'assistant' | 'call' | 'output' | 'refused' | 'egress' | 'stderr' | 'result';

export interface Entry {
  index: number;
  kind: EntryKind;
  at: string;
  text: string;
  /** A call's results, in the order they came. */
  out: string[];
  /** A call whose result was an error. */
  failed: boolean;
  /** A refusal or a network decision: what was asked, and why it was answered as it was. */
  what?: string;
  reason?: string;
  /** A network decision: allowed, refused, or (a stage's list) neither. */
  allowed?: boolean | null;
}

export interface Change {
  added: Entry[];
  grown: Entry[];
}

/** A tool line that is a call, when it carries no data saying so. */
const CALL = /^(?:\$ |(?:run|read_file|write_file|edit_file|list_files|glob|grep|search|Read|Edit|Write|MultiEdit|Glob|Grep|LS|mcp__[\w-]+)(?:\s|$)|file (?:read|write|edit|list|search)\b)/;

function dataOf(l: RunLogLine): Record<string, unknown> {
  return l.data && typeof l.data === 'object' && !Array.isArray(l.data) ? (l.data as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** "what: why", "refused: why", or "what refused, why" as a refusal's two halves. */
function refusalParts(text: string, data: Record<string, unknown>): { what: string; reason: string } {
  const w = str(data.what);
  const r = str(data.reason);
  if (w !== null && r !== null) return { what: cleanLog(redactLog(w)).split('\n')[0], reason: r };
  if (/^refused:\s*/.test(text)) return { what: '', reason: text.replace(/^refused:\s*/, '') };
  const m = /^(.*?):?\s(refused\b.*)$/s.exec(text);
  if (m && m[1]) return { what: m[1], reason: m[2] };
  const at = text.indexOf(': ');
  if (at > 0) return { what: text.slice(0, at), reason: text.slice(at + 2) };
  return { what: text, reason: '' };
}

/** "allowed CONNECT host:443 (install)", "refused host:443: why", or a stage's list. */
function egressParts(text: string, data: Record<string, unknown>): { allowed: boolean | null; what: string; reason: string } {
  const host = str(data.host);
  const allowed = typeof data.allowed === 'boolean' ? data.allowed : /^allowed\b/.test(text) ? true : /^refused\b/.test(text) ? false : null;
  if (allowed === null) return { allowed, what: text, reason: '' };
  const m = /^(?:allowed|refused)\s+(?:[A-Z]+\s+)?(\S+?)(?::\s+(.*)|\s+\((.*)\))?$/.exec(text);
  const what = host !== null ? `${host}${typeof data.port === 'number' ? `:${data.port}` : ''}` : m ? m[1] : text;
  const reason = str(data.reason) || (m ? (m[2] ?? '') : '');
  return { allowed, what, reason: allowed ? (m?.[3] ?? '') : reason || (m?.[3] ?? '') };
}

/**
 * A run's log as he reads it: each tool call folded with its results,
 * refusals and network decisions as lines of their own. Lines are pushed
 * as they arrive (paged by `since`, then live); each push says which
 * entries are new and which calls grew, so the page touches only those.
 */
export class Transcript {
  readonly entries: Entry[] = [];
  /** How many log lines have been read, for the next `since`. */
  lines = 0;
  private byId = new Map<string, Entry>();
  /** The call that results without an id belong to, until something else is said. */
  private open: Entry | null = null;

  push(lines: RunLogLine[]): Change {
    const added: Entry[] = [];
    const grown = new Set<Entry>();
    for (const l of lines) {
      this.lines++;
      const data = dataOf(l);
      const text = cleanLog(redactLog(String(l.text ?? '')));
      const at = typeof l.at === 'string' ? l.at : '';
      const add = (e: Omit<Entry, 'index' | 'out' | 'failed'> & Partial<Pick<Entry, 'failed'>>): Entry => {
        const entry: Entry = { index: this.entries.length, out: [], failed: false, ...e };
        this.entries.push(entry);
        added.push(entry);
        return entry;
      };
      switch (l.kind) {
        case 'tool': {
          const id = str(data.id);
          const isCall = str(data.name) !== null || (!('stream' in data) && !(id && this.byId.has(id)) && CALL.test(text));
          if (isCall) {
            const e = add({ kind: 'call', at, text });
            if (id) this.byId.set(id, e);
            this.open = e;
            break;
          }
          const owner = (id && this.byId.get(id)) || this.open;
          if (owner) {
            owner.out.push(text);
            if (data.error === true) owner.failed = true;
            if (!added.includes(owner)) grown.add(owner);
          } else add({ kind: 'output', at, text });
          break;
        }
        case 'refused': {
          const { what, reason } = refusalParts(text, data);
          add({ kind: 'refused', at, text, what, reason: cleanLog(redactLog(reason)) });
          break;
        }
        case 'egress': {
          const { allowed, what, reason } = egressParts(text, data);
          add({ kind: 'egress', at, text, allowed, what, reason: cleanLog(redactLog(reason)) });
          break;
        }
        case 'assistant':
        case 'result':
          this.open = null;
          add({ kind: l.kind, at, text });
          break;
        case 'stderr':
        case 'system':
        case 'engine':
          add({ kind: l.kind, at, text });
          break;
        default:
          add({ kind: 'engine', at, text });
      }
    }
    return { added, grown: [...grown] };
  }

  /** What the transcript holds so far, counted. */
  counts(): { calls: number; refused: number; stderr: number } {
    let calls = 0;
    let refused = 0;
    let stderr = 0;
    for (const e of this.entries) {
      if (e.kind === 'call') calls++;
      else if (e.kind === 'refused' || (e.kind === 'egress' && e.allowed === false)) refused++;
      else if (e.kind === 'stderr') stderr++;
    }
    return { calls, refused, stderr };
  }
}

// ---------------------------------------------------------------- the diff

export interface DiffLine {
  kind: 'hunk' | 'same' | 'add' | 'del' | 'note';
  text: string;
  /** The line's number before (same, del) and after (same, add). */
  a?: number;
  b?: number;
}

export interface DiffFile {
  path: string;
  /** The old path of a renamed file. */
  from: string | null;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

const unquote = (p: string): string => p.replace(/^"(.*)"$/, '$1');
const side = (p: string): string => unquote(p).replace(/^[ab]\//, '');

/** A unified patch as files, each with its hunks and its added and removed counts. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f = null as DiffFile | null;
  let a = 0;
  let b = 0;
  const start = (path: string, from: string | null): DiffFile => {
    const next: DiffFile = { path, from, added: 0, removed: 0, binary: false, lines: [] };
    files.push(next);
    return next;
  };
  for (const raw of text.split('\n')) {
    const line = redactDiff(cleanLog(raw));
    const git = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line);
    if (git) {
      const x = side(git[1]);
      const y = side(git[2]);
      f = start(y, x !== y ? x : null);
      continue;
    }
    if (line.startsWith('--- ') && (!f || f.lines.length > 0)) {
      const p = line.slice(4).trim();
      f = start(p === '/dev/null' ? '' : side(p), null);
      continue;
    }
    if (!f) continue;
    const cur: DiffFile = f;
    if (line.startsWith('+++ ') && cur.lines.length === 0) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') cur.path = side(p);
      continue;
    }
    if (line.startsWith('--- ') && cur.lines.length === 0) {
      if (!cur.path) cur.path = side(line.slice(4).trim());
      continue;
    }
    if (/^Binary files .* differ$/.test(line)) {
      cur.binary = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      cur.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (cur.lines.length === 0) continue; // the header: index, modes, similarity, renames
    if (line.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: line.slice(1), b: b++ });
      cur.added++;
    } else if (line.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: line.slice(1), a: a++ });
      cur.removed++;
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'same', text: line.slice(1), a: a++, b: b++ });
    } else if (line.startsWith('\\')) {
      cur.lines.push({ kind: 'note', text: line.slice(1).trim() });
    }
  }
  return files.filter((x) => x.path || x.from);
}

// ---------------------------------------------------------------- the issue as markdown

export type InlineKind = 'text' | 'em' | 'strong' | 'code' | 'link';
export interface Inline {
  kind: InlineKind;
  text: string;
  /** A link's address: https on github.com only. */
  href?: string;
}

export type Block =
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; inline: Inline[] };

const SCOPE_HEADING = /^\s*(?:#{1,6}\s*scope\s*:?|scope\s*:)\s*(.*)$/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const BODY_MAX = 20_000;

/** Folds whitespace and takes out what hides or reorders text, without a length cap. */
function plain(s: string): string {
  return s.replace(HIDDEN, '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ');
}

/** Inline markdown: code, strong, emphasis and links; a link off GitHub keeps only its words. */
export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: InlineKind, text: string, href?: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (kind === 'text' && last?.kind === 'text') last.text += text;
    else out.push(href ? { kind, text, href } : { kind, text });
  };
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  const s = plain(src);
  while ((m = re.exec(s))) {
    push('text', s.slice(at, m.index));
    if (m[1] !== undefined) push('code', m[1]);
    else if (m[2] !== undefined || m[3] !== undefined) push('strong', m[2] ?? m[3]);
    else if (m[4] !== undefined || m[5] !== undefined) push('em', m[4] ?? m[5]);
    else if (m[6] !== undefined) push('text', m[6]);
    else {
      const href = githubUrl(m[9]);
      if (href) push('link', m[8], href);
      else push('text', m[8]);
    }
    at = m.index + m[0].length;
  }
  push('text', s.slice(at));
  // Trim the run's outer whitespace.
  if (out[0]?.kind === 'text') out[0].text = out[0].text.replace(/^\s+/, '');
  const last = out.at(-1);
  if (last?.kind === 'text') last.text = last.text.replace(/\s+$/, '');
  return out.filter((x) => x.text !== '');
}

/** The body's lines without its scope section and its checklist, which the page shows on their own. */
function withoutScopeAndChecklist(lines: string[]): string[] {
  const out: string[] = [];
  let inScope = false;
  let seenItem = false;
  for (const line of lines) {
    if (CHECKBOX.test(line)) {
      inScope = false;
      continue;
    }
    if (SCOPE_HEADING.test(line)) {
      inScope = true;
      seenItem = !!SCOPE_HEADING.exec(line)![1].trim();
      continue;
    }
    if (inScope) {
      if (!line.trim()) {
        if (seenItem) inScope = false;
        continue;
      }
      if (/^\s*#/.test(line) || !BULLET.test(line)) inScope = false;
      else {
        seenItem = true;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * An issue body (untrusted, from GitHub) as blocks of markdown the page
 * builds with text nodes only: comments and tags are dropped, and the
 * scope and the checklist are left to their own sections.
 */
export function issueBlocks(body: unknown): Block[] {
  if (typeof body !== 'string' || !body.trim()) return [];
  const src = body.slice(0, BODY_MAX).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/\r\n?/g, '\n');
  const lines = withoutScopeAndChecklist(src.split('\n'));
  const blocks: Block[] = [];
  let i = 0;
  const strip = (s: string) => s.replace(/<[^>]*>/g, ' ');
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(cleanLog(lines[i++]));
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const inl = inline(strip(h[2]));
      if (inl.length) blocks.push({ kind: 'heading', level: h[1].length, inline: inl });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      const inl = inline(strip(q.join(' ')));
      if (inl.length) blocks.push({ kind: 'quote', inline: inl });
      continue;
    }
    if (BULLET.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && lines[i].trim()) {
        if (BULLET.test(lines[i])) items.push(inline(strip(lines[i].replace(BULLET, ''))));
        else if (items.length) items[items.length - 1].push(...inline(` ${strip(lines[i])}`));
        i++;
      }
      const kept = items.filter((x) => x.length);
      if (kept.length) blocks.push({ kind: 'list', ordered, items: kept });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && !/^\s*(#{1,6}\s|>|```|~~~)/.test(lines[i])) para.push(lines[i++]);
    const inl = inline(strip(para.join(' ')));
    if (inl.length) blocks.push({ kind: 'para', inline: inl });
  }
  return blocks;
}

/** The checklist items of an issue body with whether each is ticked there, matched to the job's acceptance. */
export function acceptanceTicks(body: unknown, acceptance: string[]): Array<{ text: string; ticked: boolean }> {
  const ticked = new Set<string>();
  if (typeof body === 'string') {
    for (const l of body.split(/\r?\n/)) {
      const m = /^\s*[-*+]\s+\[[xX]\]\s+(.+?)\s*$/.exec(l);
      if (m) ticked.add(m[1]);
    }
  }
  return acceptance.map((a) => ({ text: cleanText(a, 400), ticked: ticked.has(a) }));
}

// ---------------------------------------------------------------- the award

export interface Round {
  number: number;
  at: string;
  /** Every bid the round considered, in the award's order. */
  bids: Bid[];
  chosen: Bid | null;
  satOut: Array<{ agentId: string; firmId: string | null; reason: string }>;
  prose: string;
}

/** A chance as the award states it: two places at most, trailing zeros dropped. */
const dec = (x: number): string => String(Math.round(x * 100) / 100);

function isBid(x: unknown): x is Bid {
  const b = x as Bid;
  return !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.firmId === 'string' && typeof b.price === 'number' && typeof b.ev === 'number';
}

/**
 * Each bidding round the job went through, from its ledger: the bids it
 * weighed, who sat out, and the award in a sentence a newcomer can follow.
 */
export function awardRounds(ledger: LedgerRow[], names: Names, value: number, underWay = true): Round[] {
  const rounds: Round[] = [];
  let since: Bid[] = [];
  const awards = ledger.filter((r) => r.kind === 'job.awarded');
  for (const row of ledger) {
    if (row.kind === 'bid.placed') {
      const b = (row.data as { bid?: unknown })?.bid;
      if (isBid(b)) since.push(b);
      continue;
    }
    if (row.kind !== 'job.awarded') continue;
    const d = (row.data ?? {}) as { considered?: unknown; chosen?: unknown; satOut?: unknown; tier?: unknown };
    const considered = Array.isArray(d.considered) ? d.considered.filter(isBid) : since;
    const bids = bidOrder(considered.length ? considered : since);
    const chosen = isBid(d.chosen) ? d.chosen : null;
    const satOut = Array.isArray(d.satOut)
      ? (d.satOut as Array<Record<string, unknown>>).map((s) => ({
          agentId: String(s.agentId ?? ''),
          firmId: typeof s.firmId === 'string' ? s.firmId : null,
          reason: cleanText(s.reason, 240),
        }))
      : [];
    const worth = typeof d.tier === 'string' && d.tier in TIER_VALUE ? TIER_VALUE[d.tier as Tier] : value;
    const last = underWay && row === awards.at(-1);
    rounds.push({ number: rounds.length + 1, at: row.at, bids, chosen, satOut, prose: awardProse(chosen, bids, names, worth, last) });
    since = [];
  }
  return rounds;
}

function awardProse(chosen: Bid | null, bids: Bid[], names: Names, worth: number, current: boolean): string {
  if (!chosen) return bids.length ? 'No bid was worth taking at its price, so the job went back on the board.' : 'No firm bid in this round, so the job went back on the board.';
  const firm = names.firm(chosen.firmId);
  const chance = dec(chosen.calibrated) === dec(chosen.confidence) ? `calibrated ${dec(chosen.calibrated)}, as stated` : `calibrated ${dec(chosen.calibrated)} against a stated ${dec(chosen.confidence)}`;
  const parts = [`${firm} won at ${money(chosen.price)} credits: ${chance}, an expected value of ${money(chosen.ev)} on a ${worth} credit job.`];
  parts.push(`${names.agent(chosen.agentId)} ${current ? 'does' : 'did'} the work.`);
  const next = bids.find((b) => b.id !== chosen.id);
  if (next) parts.push(`Next best was ${names.firm(next.firmId)} at ${money(next.price)} credits (expected value ${money(next.ev)}).`);
  else parts.push('It was the only bid.');
  return parts.join(' ');
}

// ---------------------------------------------------------------- the ledger trail

export interface TrailDay {
  day: string;
  heading: string;
  rows: Array<{ id: number; at: string; time: string; kind: string; text: string }>;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Today", "Yesterday", or "Wednesday 4 November". */
export function dayHeading(at: string, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  if (localDay(d) === localDay(today)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (localDay(d) === localDay(y)) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "14:05" in local time. */
export function clock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATUS_WORDS: Partial<Record<string, string>> = {
  bidding: 'Opened for bids.',
  awarded: 'Awarded.',
  running: 'Work began.',
  inspecting: 'Sent to the inspectors.',
  shipping: 'Passed; shipping.',
  waiting: 'Waiting on your review.',
  merged: 'Merged.',
  failed: 'Marked failed.',
  closed: 'Closed without merging.',
  halted: 'Halted.',
  withdrawn: 'Withdrawn.',
};

function sentence(row: LedgerRow, names: Names): string {
  const d = (row.data ?? {}) as Record<string, any>;
  const t = (v: unknown, max = 200) => cleanText(v, max);
  switch (row.kind) {
    case 'job.posted': {
      const j = d.job ?? {};
      if (j.source === 'issue' && typeof j.issue === 'number') return `Posted from issue #${j.issue}.`;
      return j.source === 'harness' ? 'Proposed by the city.' : 'Posted by you.';
    }
    case 'job.proposed':
      return 'Proposed by the city.';
    case 'job.changed': {
      if (d.from === d.to) return d.job?.tier ? `Tier set to ${t(d.job.tier)}, worth ${money(Number(d.job.value) || 0)} credits.` : 'Changed.';
      if (d.to === 'open') return d.from === 'failed' ? 'Reposted.' : d.from === 'proposed' ? 'Accepted.' : d.from === 'halted' ? 'Resumed.' : 'Back on the board.';
      return STATUS_WORDS[String(d.to)] ?? `Moved from ${t(d.from)} to ${t(d.to)}.`;
    }
    case 'bid.placed': {
      const b = d.bid;
      return isBid(b) ? `${names.firm(b.firmId)} bid ${money(b.price)} credits, ${pct(b.confidence)} sure.` : 'A bid was placed.';
    }
    case 'job.awarded':
      return isBid(d.chosen) ? `Awarded to ${names.firm(d.chosen.firmId)} at ${money(d.chosen.price)} credits.` : 'No bid won; back on the board.';
    case 'run.started': {
      const r = d.run ?? {};
      return r.agentId ? `${names.agent(String(r.agentId))} of ${names.firm(String(r.firmId))} started the run.` : 'The run started.';
    }
    case 'run.stage':
      return d.stage === 'waiting' ? 'The run is waiting on you.' : d.stage === 'done' ? 'The run finished.' : `The run started ${t(d.stage, 40)}.`;
    case 'run.refused':
      return `Refused: ${t(d.what, 120)}${d.reason ? ` (${t(d.reason, 160)})` : ''}.`;
    case 'run.diff': {
      const files = Array.isArray(d.files) ? d.files.length : 0;
      return `The change: ${files} ${files === 1 ? 'file' : 'files'}, ${Number(d.lines) || 0} lines.`;
    }
    case 'check.done':
      return `Check ${t(d.check?.name, 40)}: ${t(d.check?.status, 40)}.`;
    case 'inspection.done':
      return `Inspected. ${t(d.summary, 240)}`.trim();
    case 'run.ended': {
      const head = RUN_ENDED[String(d.outcome)] ?? `The run ended ${t(d.outcome, 40)}`;
      const why = d.reason ? t(d.reason, 200).replace(/\.$/, '') : '';
      return why ? `${head}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.` : `${head}.`;
    }
    case 'credits.moved': {
      const amount = money(Math.round((Number(d.amount) || 0) * 100) / 100);
      if (d.kind === 'pay') return `${names.firm(String(d.to))} was paid ${amount} credits.`;
      if (d.kind === 'review-pay') return `${names.firm(String(d.to))} was paid ${amount} credits for the review.`;
      return `${amount} credits moved (${t(d.kind, 40)}).`;
    }
    case 'pr.opened':
      return `Pull request #${Number(d.number) || 0} opened.`;
    case 'pushed':
      return 'Pushed to the default branch.';
    case 'merge.detected':
      return `Merged${d.pr ? ` as pull request #${Number(d.pr)}` : ''}.`;
    case 'merge.reverted':
      return 'The merge was reverted.';
    case 'floor.laid':
      return String(d.towerId ?? '').startsWith('agent:') ? `A floor laid on ${names.agent(String(d.towerId).slice(6))}'s tower.` : 'A floor laid on the job site.';
    case 'floor.lit':
      return String(d.towerId ?? '').startsWith('agent:') ? `The floor on ${names.agent(String(d.towerId).slice(6))}'s tower lit.` : 'The floor on the job site lit.';
    case 'floor.scarred':
      return 'A scar floor laid on the job site.';
    case 'floor.removed':
      return 'The floor came down.';
    case 'trip.started':
      return d.trip?.agentId ? `${names.agent(String(d.trip.agentId))} set off.` : 'A trip began.';
    case 'trip.ended':
      return 'A trip ended.';
    case 'run.note':
      return t(d.text ?? d.note, 240) || 'A note.';
    default:
      return t(row.kind, 60);
  }
}

const RUN_ENDED: Record<string, string> = {
  merged: 'The run ended; the change merged',
  failed: 'The run failed',
  killed: 'The run was stopped',
  capped: 'The run hit its credit cap',
  crashed: 'The run crashed',
  closed: 'The run ended; its pull request was closed',
};

/** Rows another row already says better: the award says who won, the job's own moves say when work began. */
function repeats(row: LedgerRow): boolean {
  const d = (row.data ?? {}) as Record<string, unknown>;
  if (row.kind === 'job.changed') return d.from !== d.to && d.to === 'awarded';
  if (row.kind === 'run.stage') return d.stage === 'preparing' || d.stage === 'working' || d.stage === 'inspecting';
  return false;
}

/** A run of checks as one line: "Checks passed: install, test; failed: review." */
function checksLine(rows: LedgerRow[]): string {
  const by: Record<string, string[]> = {};
  for (const r of rows) {
    const c = ((r.data ?? {}) as { check?: { name?: unknown; status?: unknown } }).check ?? {};
    const status = cleanText(c.status, 20) || 'done';
    (by[status] ??= []).push(cleanText(c.name, 40));
  }
  const order = ['pass', 'fail', 'preexisting', 'skipped'];
  const word: Record<string, string> = { pass: 'passed', fail: 'failed', preexisting: 'failing before too', skipped: 'skipped' };
  const keys = Object.keys(by).sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9));
  return `Checks ${keys.map((k) => `${word[k] ?? k}: ${by[k].join(', ')}`).join('; ')}.`;
}

/** The job's ledger as days of plain sentences, oldest first; a run of checks reads as one line. */
export function ledgerTrail(rows: LedgerRow[], names: Names, now = Date.now()): TrailDay[] {
  const days: TrailDay[] = [];
  const kept = rows.filter((r) => !repeats(r));
  for (let i = 0; i < kept.length; i++) {
    const row = kept[i];
    const d = new Date(row.at);
    if (Number.isNaN(d.getTime())) continue;
    const day = localDay(d);
    let cur = days.at(-1);
    if (!cur || cur.day !== day) {
      cur = { day, heading: dayHeading(row.at, now), rows: [] };
      days.push(cur);
    }
    if (row.kind === 'check.done') {
      const run: LedgerRow[] = [row];
      while (kept[i + 1]?.kind === 'check.done' && localDay(new Date(kept[i + 1].at)) === day) run.push(kept[++i]);
      const last = run.at(-1)!;
      cur.rows.push({ id: last.id, at: last.at, time: clock(last.at), kind: row.kind, text: checksLine(run) });
      continue;
    }
    cur.rows.push({ id: row.id, at: row.at, time: clock(row.at), kind: row.kind, text: sentence(row, names) });
  }
  return days;
}

// ---------------------------------------------------------------- the inspection

export const CHECK_WORDS: Record<CheckName, { name: string; what: string }> = {
  install: { name: 'Install', what: 'The dependencies install cleanly.' },
  test: { name: 'Tests', what: "The repo's own tests pass, and none that passed before fails." },
  typecheck: { name: 'Type check', what: 'The types check.' },
  lint: { name: 'Lint', what: "The repo's linter is clean." },
  build: { name: 'Build', what: 'The project builds.' },
  scope: { name: 'Scope', what: "Every changed file is inside the job's scope." },
  review: { name: 'Review', what: 'An agent from another firm read the change against the issue.' },
  design: { name: 'Design', what: 'A vision judge scored the screens before and after.' },
};

export interface Verdict {
  state: 'pass' | 'fail' | 'inconclusive';
  text: string;
}

/** "Passed; pushable", "Failed: test, scope", or why no verdict could be reached. */
export function verdict(i: InspectionView): Verdict {
  if (i.inconclusive) return { state: 'inconclusive', text: `Inconclusive: ${cleanText(i.inconclusive, 200)}` };
  if (i.passed) return { state: 'pass', text: i.pushable ? 'Passed; pushable' : 'Passed; opens a pull request, not pushable' };
  const failed = i.checks.filter((c) => c.status === 'fail').map((c) => c.name);
  return { state: 'fail', text: failed.length ? `Failed: ${failed.join(', ')}` : 'Failed' };
}

/** A check's duration: "3 ms", "42 s", "1 min 12 s". */
export function duration(ms: number): string {
  if (!(ms > 0)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}
