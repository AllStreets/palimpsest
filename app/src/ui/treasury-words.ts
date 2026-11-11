/**
 * The treasury screen's view logic (Task 39), kept free of the page so the
 * tests can read it: the calibration line, a pause said in plain words with
 * the one action that clears it, when a window resets, a spend figure, and
 * the daily report's Markdown read into blocks the page builds from text
 * nodes only (its tables included).
 */
import type { TreasuryView } from '../../../shared/types.js';
import { githubUrl } from './board.js';
import { inline, type Inline } from './detail.js';
import { figure } from './story.js';

const HOUR = 3_600_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const grouped = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * The Now block's Running row. `runs` counts the runs under way on the books,
 * the same runs the job board and the run pages show; `slots` says what the
 * runner holds for them, which the sample economy's runs never take.
 */
export function runningWords(u: TreasuryView['underWay'], c: TreasuryView['concurrency']): { runs: string; slots: string } {
  const by = [u.claude && `Claude ${u.claude}`, u.local && `local ${u.local}`, u.api && `API ${u.api}`].filter(Boolean).join(', ');
  const runs = u.total === 0 ? 'No run under way.' : `${u.total} ${u.total === 1 ? 'run' : 'runs'} under way: ${by}.`;
  const slots = `Slots the runner holds: Claude ${c.claude} of ${c.claudeMax}, local ${c.local} of ${c.localMax}, API ${c.api}.`;
  return { runs, slots };
}

/** "1% of the window is about 58,000 weighted tokens, measured from 14 pairs." or the assumed figure. */
export function calibrationLine(c: TreasuryView['calibration']): string {
  if (!c.calibrated || c.samples <= 0) return `1% of the window is assumed to be about ${grouped(c.tokensPerPct)} weighted tokens until two readings measure it.`;
  return `1% of the window is about ${grouped(c.tokensPerPct)} weighted tokens, measured from ${c.samples} ${c.samples === 1 ? 'pair' : 'pairs'}.`;
}

export interface PauseWords {
  reason: NonNullable<TreasuryView['paused']>['reason'];
  title: string;
  text: string;
  /** The one action that clears it: resume past a stale reading, or open Settings to turn the stop switch off. */
  action: 'resume' | 'settings' | null;
}

/** Whole hours, rounded down, said as a number of hours. */
function hoursOld(ms: number): string {
  const h = Math.max(0, Math.floor(ms / HOUR));
  return h === 1 ? '1 hour' : `${h} hours`;
}

/** Why the city is not starting Claude work, in plain words, and what clears it; null when it is not paused. */
export function pauseWords(paused: TreasuryView['paused'], reading: TreasuryView['reading'], now: number): PauseWords | null {
  if (!paused) return null;
  const detail = paused.detail.trim();
  switch (paused.reason) {
    case 'stale':
      return {
        reason: 'stale',
        title: reading ? `Paused: your last usage reading is ${hoursOld(now - reading.at)} old` : 'Paused: no usage reading yet',
        text: `Without a fresh reading the city cannot see how much of your plan is left, so it starts no Claude work. Local models carry on. A reading arrives with your next Claude Code reply; or resume anyway, for up to five hours, and the city counts your own use from your transcripts meanwhile.`,
        action: 'resume',
      };
    case 'stopped':
      return { reason: 'stopped', title: 'Stopped: the stop switch is on', text: 'No model call starts and every live run was ended. Turn the switch off in Settings to let the city work again.', action: 'settings' };
    case 'hard':
      return { reason: 'hard', title: 'Paused at the hard stop', text: `${detail} Claude work waits until the window resets; local models wait too.`, action: null };
    case 'cap':
      return { reason: 'cap', title: 'Paused: the city has reached its cap', text: `${detail} It starts again as the window moves on.`, action: null };
    case 'night':
      return { reason: 'night', title: 'Paused for the night', text: `${detail} It carries on when you are back, or when the week resets.`, action: null };
    default:
      return { reason: paused.reason, title: 'Paused', text: detail, action: null };
  }
}

const hm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** When a window resets, from its `resetsAt` in seconds: "resets at 17:20", "resets tomorrow at 09:05", "resets Friday at 09:00". */
export function resetWords(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'no reset time on record';
  const at = new Date(resetsAt * 1000);
  if (at.getTime() <= now) return `reset at ${hm(at)}, after the last reading`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / (24 * HOUR));
  if (days === 0) return `resets at ${hm(at)}`;
  if (days === 1) return `resets tomorrow at ${hm(at)}`;
  return `resets ${WEEKDAYS[at.getDay()]} at ${hm(at)}`;
}

/** A spend figure: two decimals with a thousands comma, and nothing set as a quiet dot. */
export function spendFigure(n: number): string {
  return Math.abs(n) < 0.005 ? '·' : figure(n);
}

// ---------------------------------------------------------------- the report

export type ReportSpan = Inline | { kind: 'break'; text: '' };

export type ReportBlock =
  | { kind: 'heading'; level: number; inline: ReportSpan[] }
  | { kind: 'para'; inline: ReportSpan[] }
  | { kind: 'list'; items: ReportSpan[][] }
  | { kind: 'table'; head: string[]; rows: string[][]; numeric: boolean[] };

const URL = /https:\/\/github\.com\/[^\s)]+/g;
const NUMERIC = /^[−-]?[\d,]+(?:\.\d+)?%?$|^\$[\d,]+(?:\.\d+)?$|^·$/;

/** Text as the page may set it: tags taken out, then inline Markdown with a bare GitHub address made a link. */
function spans(src: string): ReportSpan[] {
  const out: ReportSpan[] = [];
  for (const s of inline(src.replace(/<[^>]*>/g, ' '))) {
    if (s.kind !== 'text') {
      out.push(s);
      continue;
    }
    let at = 0;
    for (const m of s.text.matchAll(URL)) {
      const href = githubUrl(m[0]);
      if (!href) continue;
      if (m.index > at) out.push({ kind: 'text', text: s.text.slice(at, m.index) });
      out.push({ kind: 'link', text: m[0].replace(/^https:\/\/github\.com\//, ''), href });
      at = m.index + m[0].length;
    }
    if (at < s.text.length) out.push({ kind: 'text', text: s.text.slice(at) });
  }
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/<[^>]*>/g, ''));

/** The daily report's Markdown (written by the engine, its outside text already plain) as blocks. */
export function reportBlocks(md: string): ReportBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: ReportBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, inline: spans(h[2]) });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      const [head = [], ...body] = rows;
      const numeric = head.map((_, c) => c > 0 && body.length > 0 && body.every((r) => NUMERIC.test(r[c] ?? '')));
      out.push({ kind: 'table', head, rows: body, numeric });
      continue;
    }
    if (/^- /.test(line)) {
      const items: ReportSpan[][] = [];
      while (i < lines.length && (/^- /.test(lines[i]) || (/^ {2}\S/.test(lines[i]) && items.length))) {
        if (/^- /.test(lines[i])) items.push(spans(lines[i].slice(2)));
        else items[items.length - 1].push({ kind: 'break', text: '' }, ...spans(lines[i].trim()));
        i++;
      }
      out.push({ kind: 'list', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|- |\s*\|)/.test(lines[i])) para.push(lines[i++]);
    const inl = spans(para.join(' '));
    if (inl.length) out.push({ kind: 'para', inline: inl });
  }
  return out;
}
