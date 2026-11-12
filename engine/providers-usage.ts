/**
 * What each provider can honestly report about its usage, for Settings.
 * Read only: nothing here writes to another tool's folder, and the Codex
 * reader looks only at session logs, never at `auth.json` or any credential.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderUsage } from '../shared/types.js';
import { openDb } from './db.js';
import { getRunner } from './exec.js';
import { treasury } from './market/budget.js';
import { ollamaListEnv, parseOllamaList } from './market/firms.js';
import { getSettings } from './settings.js';
import { latestReading } from './usage.js';

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Where another CLI keeps its logs: the variable when set, else its own
 * folder in his home. Under `node --test` an unset variable names a folder
 * in the temp dir that does not exist, so no test can ever read his
 * ~/.codex or ~/.gemini, even one that forgets to point the reader at a fixture.
 */
function cliHome(env: NodeJS.ProcessEnv, key: string, folder: string): string {
  const set = env[key];
  if (set) return set;
  if (env.NODE_TEST_CONTEXT) return join(tmpdir(), `palimpsest-tests-never-read-${folder.slice(1)}`, 'absent');
  return join(homedir(), folder);
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return cliHome(env, 'PALIMPSEST_CODEX_HOME', '.codex');
}

export function geminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return cliHome(env, 'PALIMPSEST_GEMINI_HOME', '.gemini');
}

/**
 * What one read of another CLI's logs may take: the newest `files` within
 * the week, and at most `bytes` of each (a Codex log's tail, since its token
 * lines are cumulative; a Gemini chat over the cap is skipped), so Settings
 * never stalls the engine on a long history.
 */
export const READ_CAP = { files: 40, bytes: 2 * 1024 * 1024 };

/** The last `READ_CAP.bytes` of a file as text, from its first whole line; null when it cannot be read. */
function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const len = Math.min(size, READ_CAP.bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Files under `dir` (recursively, bounded depth) whose name satisfies `want`. Missing or unreadable folders give nothing. */
function walk(dir: string, want: (name: string) => boolean, depth = 6): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...walk(p, want, depth - 1));
    else if (e.isFile() && want(e.name)) out.push(p);
  }
  return out;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ Codex

type Json = Record<string, any>;

/** A window's name from its length in minutes: 300 is "5 hours", 10080 is "week"; otherwise the position's default. */
function labelFor(minutes: unknown, fallback: string): string {
  if (typeof minutes !== 'number' || !(minutes > 0)) return fallback;
  if (minutes === 10080) return 'week';
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function windowOf(label: string, w: Json | undefined): ProviderUsage['windows'][number] | null {
  if (!w || typeof w !== 'object') return null;
  return {
    label: labelFor(w.window_minutes, label),
    usedPct: typeof w.used_percent === 'number' ? w.used_percent : null,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null,
  };
}

/** The token_count payload on a Codex log line, whether the line is the payload itself or wraps it. */
function tokenCountOf(line: unknown): Json | null {
  if (!line || typeof line !== 'object') return null;
  const o = line as Json;
  if (o.type === 'token_count') return o;
  if (o.payload && typeof o.payload === 'object' && o.payload.type === 'token_count') return o.payload;
  return null;
}

/** Codex plan windows (5 hours and week) from the newest recent session, and token deltas over all recent sessions. */
export function openaiUsage(now: number = Date.now()): ProviderUsage {
  const base: ProviderUsage = { provider: 'openai', status: 'ready', windows: [], tokens: null, spendUsd: null, detail: '' };
  const root = codexHome();
  if (!existsSync(root)) return { ...base, status: 'not-found', detail: 'Codex CLI not found on this Mac' };

  const isLog = (n: string): boolean => n.endsWith('.jsonl');
  const files = [...walk(join(root, 'sessions'), isLog), ...walk(join(root, 'archived_sessions'), isLog)]
    .map((path) => ({ path, at: mtime(path) }))
    .filter((f) => f.at >= now - WEEK_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, READ_CAP.files);

  const midnight = localMidnight(now);
  let today = 0;
  let week = 0;
  let windows: ProviderUsage['windows'] = [];
  let windowsSeen = false;
  let readAny = false;
  for (const f of files) {
    const text = readTail(f.path);
    if (text === null) continue;
    readAny = true;
    let prevTotal = 0;
    let last: Json | null = null;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: Json;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      const tc = tokenCountOf(line);
      if (!tc) continue;
      last = tc;
      const total = tc.info?.total_token_usage?.total_tokens;
      if (typeof total === 'number') {
        const delta = Math.max(0, total - prevTotal);
        prevTotal = Math.max(prevTotal, total);
        const ts = Date.parse(String(line.timestamp ?? tc.timestamp ?? ''));
        const at = Number.isFinite(ts) ? ts : f.at;
        if (at >= now - WEEK_MS && at <= now) week += delta;
        if (at >= midnight && at <= now) today += delta;
      }
    }
    if (!windowsSeen && last) {
      const rl: Json = last.rate_limits ?? {};
      windows = [windowOf('5 hours', rl.primary), windowOf('week', rl.secondary)].filter((w): w is NonNullable<typeof w> => w !== null);
      windowsSeen = true;
    }
  }
  const detail =
    files.length === 0 ? 'No Codex sessions in the last 7 days' : windows.length ? 'Plan windows from the latest Codex session' : 'No plan windows in the latest Codex session';
  return { ...base, windows, tokens: readAny ? { today, week } : null, detail };
}

// ------------------------------------------------------------------ Gemini

/** Token totals from Gemini CLI chat logs; it reports no plan percentages. */
export function geminiUsage(now: number = Date.now()): ProviderUsage {
  const base: ProviderUsage = { provider: 'gemini', status: 'ready', windows: [], tokens: null, spendUsd: null, detail: '' };
  const root = geminiHome();
  if (!existsSync(root)) return { ...base, status: 'not-found', detail: 'Gemini CLI not found on this Mac' };

  const midnight = localMidnight(now);
  let today = 0;
  let week = 0;
  let readAny = false;
  const chats = walk(join(root, 'tmp'), (n) => n.endsWith('.json'), 3)
    .filter((p) => /[\\/]chats[\\/][^\\/]+$/.test(p))
    .map((path) => ({ path, at: mtime(path) }))
    .filter((f) => f.at >= now - WEEK_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, READ_CAP.files);
  for (const { path, at: fileAt } of chats) {
    let doc: Json;
    try {
      // A chat is one JSON document: one over the cap is skipped rather than read whole.
      if (statSync(path).size > READ_CAP.bytes) continue;
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    readAny = true;
    const messages: Json[] = Array.isArray(doc?.messages) ? doc.messages : [];
    for (const m of messages) {
      const total = m?.tokens?.total;
      if (typeof total !== 'number') continue;
      const ts = Date.parse(String(m.timestamp ?? ''));
      const at = Number.isFinite(ts) ? ts : fileAt;
      if (at >= now - WEEK_MS && at <= now) week += total;
      if (at >= midnight && at <= now) today += total;
    }
  }
  return { ...base, tokens: readAny ? { today, week } : null, detail: 'Token counts only; Gemini reports no plan percentages' };
}

// ------------------------------------------------------------------ Ollama, Claude, API, MLX

function creditsSince(fromMs: number, pattern: string, column: 'amount' | 'usd'): number {
  const row = openDb()
    .prepare(
      `SELECT COALESCE(SUM(${column}), 0) AS c FROM credits
       WHERE kind IN ('bid', 'run', 'review', 'judge') AND at >= ? AND json_extract(json, '$.model') LIKE ?`,
    )
    .get(new Date(fromMs).toISOString(), pattern) as { c: number };
  return row.c;
}

/** Local credits spent today and this week on Ollama models. */
function localCredits(now: number): { today: number; week: number } {
  return { today: round(creditsSince(localMidnight(now), 'ollama:%', 'amount')), week: round(creditsSince(now - WEEK_MS, 'ollama:%', 'amount')) };
}

export { parseOllamaList };

/**
 * Whether Ollama answers at the configured host and its installed models,
 * from `ollama list` through the engine's runner with OLLAMA_HOST set to that
 * host (the sample stand-in answers it; under tests the real runner refuses
 * it), and the local credits spent. The two are separate: a database error
 * never reads as "not reachable".
 */
export async function ollamaUsage(now: number = Date.now(), credits: (now: number) => { today: number; week: number } = localCredits): Promise<ProviderUsage> {
  const host = getSettings().ollamaHost;
  const base: ProviderUsage = { provider: 'ollama', status: 'not-found', windows: [], tokens: null, spendUsd: null, detail: '', host };
  let models: string[];
  try {
    const env = ollamaListEnv(host);
    const { stdout, code } = await getRunner()('ollama', ['list'], { timeoutMs: 5000, env });
    if (code !== 0) return { ...base, detail: `Ollama is not reachable at ${host}` };
    models = parseOllamaList(stdout);
  } catch {
    return { ...base, detail: `Ollama is not reachable at ${host}` };
  }
  const count = `${models.length} ${models.length === 1 ? 'model' : 'models'} installed`;
  try {
    const c = credits(now);
    return { ...base, status: 'ready', models, detail: `${count}; local credits ${c.today} today, ${c.week} this week` };
  } catch {
    return { ...base, status: 'ready', models, detail: `${count}; local credits unknown` };
  }
}

/** Claude plan windows from the latest hook reading, and what the city has spent of them. */
export function claudeUsage(now: number = Date.now()): ProviderUsage {
  const r = latestReading();
  const base: ProviderUsage = {
    provider: 'claude',
    status: r ? 'ready' : 'not-found',
    windows: [
      { label: '5 hours', usedPct: r?.fiveHour?.usedPercentage ?? null, resetsAt: r?.fiveHour?.resetsAt ?? null },
      { label: 'week', usedPct: r?.sevenDay?.usedPercentage ?? null, resetsAt: r?.sevenDay?.resetsAt ?? null },
    ],
    tokens: null,
    spendUsd: null,
    detail: r ? '' : 'No Claude usage reading yet',
  };
  // The treasury reads his transcripts for the trend between readings. When that folder cannot be read, the
  // statusline percentages above still hold: the trouble is named apart, and never thrown over the reading.
  let t: ReturnType<typeof treasury>;
  try {
    t = treasury(now);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { ...base, detail: r ? 'The statusline percentages held' : base.detail, trouble: `The transcripts trend could not be read: ${reason}` };
  }
  return { ...base, detail: r ? `The city has spent ${t.citySpent.today} credits today and ${t.citySpent.week} this week` : base.detail };
}

export function anthropicApiUsage(now: number = Date.now()): ProviderUsage {
  const api = getSettings().anthropicApi;
  if (!api.enabled) return { provider: 'anthropic-api', status: 'off', windows: [], tokens: null, spendUsd: null, detail: 'The Anthropic API backend is off' };
  return {
    provider: 'anthropic-api',
    status: 'ready',
    windows: [],
    tokens: null,
    spendUsd: {
      today: round(creditsSince(localMidnight(now), 'anthropic:%', 'usd')),
      week: round(creditsSince(now - WEEK_MS, 'anthropic:%', 'usd')),
    },
    detail: `Daily limit $${api.dailyUsd}`,
  };
}

export function mlxUsage(): ProviderUsage {
  return { provider: 'mlx', status: 'later', windows: [], tokens: null, spendUsd: null, detail: 'arrives with the school' };
}

type Reader = () => ProviderUsage | Promise<ProviderUsage>;

/** How long a read of another CLI's logs stands before Settings reads them again. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: ProviderUsage }>();

/** `read`, answered from the last read of the same folder within the minute. */
function cachedRead(key: () => string, read: () => ProviderUsage): Reader {
  return () => {
    const k = key();
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = read();
    cache.set(k, { at: Date.now(), value });
    return value;
  };
}

/** Forgets every cached read (tests). */
export function resetProviderCache(): void {
  cache.clear();
}

/** Every provider, in the fixed order Settings shows them. A reader that throws shows as unknown with a short reason; it never empties the list. */
export async function providerUsages(overrides: Partial<Record<ProviderUsage['provider'], Reader>> = {}): Promise<ProviderUsage[]> {
  const readers: Array<[ProviderUsage['provider'], Reader]> = [
    ['claude', claudeUsage],
    ['anthropic-api', anthropicApiUsage],
    ['ollama', ollamaUsage],
    ['openai', cachedRead(() => `openai:${codexHome()}`, () => openaiUsage())],
    ['gemini', cachedRead(() => `gemini:${geminiHome()}`, () => geminiUsage())],
    ['mlx', mlxUsage],
  ];
  const out: ProviderUsage[] = [];
  for (const [provider, read] of readers) {
    try {
      out.push(await (overrides[provider] ?? read)());
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 120);
      out.push({ provider, status: 'unknown', windows: [], tokens: null, spendUsd: null, detail: `Could not read usage: ${reason}` });
    }
  }
  return out;
}
