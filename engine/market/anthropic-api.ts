/**
 * The Anthropic API backend (Task 10, ruling 18), off by default. Agents on
 * `anthropic:<model>` run the same local tool loop as Ollama against
 * `POST https://api.anthropic.com/v1/messages` (streaming) with his own API
 * key. It never runs unless `settings.anthropicApi.enabled` is on with a
 * positive `dailyUsd` and a key is stored; it never touches his Claude login
 * or its keychain item, and never reads ANTHROPIC_API_KEY or any other
 * variable from the engine's environment.
 *
 * The key lives in his login keychain under service KEY_SERVICE, read with
 * `security find-generic-password` through the engine's runner each time a
 * call needs it, and stored by `security -i` with the command on stdin, so
 * it is never on an argv. It goes only into the request header: never into
 * a child environment, a log line, the ledger or an error message.
 *
 * Every API call first acquires an `api` lease (budget.ts), which refuses
 * when today's spend plus what is reserved would pass `dailyUsd`, then
 * charges its real cost (list prices from the API's `usage`) under that
 * lease and releases it in `finally`. The backend charges each call itself
 * (`chargesItself`), so the runner must not charge an API run's usage again.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, sep } from 'node:path';

import { apiCredits, modelFamily, type ModelFamily } from '../../shared/credits.js';
import { AUDIT_CAPS, AUDIT_LOCAL_RESULT } from '../../shared/market-rules.js';
import type { ModelRef } from '../../shared/types.js';
import { AUDIT_PERSONA, auditPrompt, checkCommands } from '../audit/schema.js';
import { getRunner, getSpawner } from '../exec.js';
import { record } from '../ledger.js';
import { getSettings } from '../settings.js';
import { acquire, charge, unattended, type Lease } from './budget.js';
import { planPrompt, reviewPrompt, systemPrompt } from './claude.js';
import { cleanImages, judgeAnswer, judgeText, parseAnswer, planAnswer, PLAN_JSON, reviewAnswer, REVIEW_JSON } from './ollama.js';
import type { AuditInput, AuditResult, JudgeInput, PlanInput, Provider, ReviewInput, Usage } from './provider.js';
import { auditLoopTools, LoopCap, runLoop, runToolLoop, type ChatChunk, type ChatMessage, type ChatTransport, type ChatUsage, type ToolSpec } from './toolloop.js';

export const KEY_SERVICE = 'Palimpsest Anthropic API key';
const KEY_ACCOUNT = 'palimpsest';
const SECURITY = '/usr/bin/security';
export const API_BASE = 'https://api.anthropic.com';
export const API_VERSION = '2023-06-01';

/**
 * List prices in USD per million input and output tokens, per family. Each
 * family carries the highest price among its current models (Opus 4.x,
 * Sonnet 4.6, Haiku 4.5), so the dollar cap errs toward stopping early.
 */
export const API_PRICES: Record<ModelFamily, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
  fable: { input: 10, output: 50 },
};
/** Cache reads and (five-minute) cache writes, as multiples of the input price. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Output tokens per work turn and per plan, review or judge call. */
export const WORK_MAX_TOKENS = 16_000;
export const CALL_MAX_TOKENS = 4_096;
export const CALL_MAX_MS = 5 * 60_000;
/** The judge's model when the city asks this backend to judge. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{8,400}$/;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

/** The list-price cost in USD of one call's usage. Unknown families count as opus. */
export function usdFor(u: { input: number; output: number; cacheRead: number; cacheCreation: number }, model: string): number {
  const p = API_PRICES[modelFamily(model)];
  const usd = (u.input * p.input + u.output * p.output + u.cacheRead * p.input * CACHE_READ_MULTIPLIER + u.cacheCreation * p.input * CACHE_WRITE_MULTIPLIER) / 1e6;
  return Math.round(usd * 1e9) / 1e9;
}

/** The backend charges every call itself; the runner must not charge its returned usage again. */
export const chargesItself = true;

/* ------------------------------------------------------------------ */
/* The key                                                             */
/* ------------------------------------------------------------------ */

/** Where the key lives: his login keychain by default; tests pass a throwaway keychain file. */
export interface KeychainOptions {
  keychain?: string;
}

/** True under `node --test`: the key functions then touch only a named keychain inside the temp dir. */
function inTestRun(): boolean {
  return !!process.env.NODE_TEST_CONTEXT;
}

/**
 * The keychain file named by `o`, checked to exist: `security` silently
 * falls back to the default (login) keychain when a named one is missing.
 * Null means his login keychain, which is never allowed under tests: there
 * a keychain must be named and its real path must lie inside the temp dir.
 */
function keychainOf(o: KeychainOptions): string | null {
  if (o.keychain === undefined) {
    if (inTestRun()) throw new Error('Under tests the API key functions need a keychain inside the temp dir.');
    return null;
  }
  const k = o.keychain;
  if (typeof k !== 'string' || !isAbsolute(k) || !/\.keychain(-db)?$/.test(k)) throw new Error('The keychain must be an absolute path to a .keychain-db file.');
  let real: string;
  try {
    real = realpathSync(k);
  } catch {
    throw new Error('The keychain file does not exist.');
  }
  if (inTestRun()) {
    const tmp = realpathSync(tmpdir());
    if (!real.startsWith(tmp + sep)) throw new Error('Under tests the keychain must lie inside the temp dir.');
  }
  let file = false;
  try {
    file = statSync(real).isFile();
  } catch {
    file = false;
  }
  if (!file) throw new Error('The keychain file does not exist.');
  return real;
}

/** A word for a `security -i` command line: double-quoted, with backslashes and quotes escaped. */
function quoted(word: string): string {
  if (/[\n\r\0]/.test(word)) throw new Error('A keychain argument cannot hold a line break.');
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The stored API key, or null. Read through `security` (the runner returns
 * its stdout and logs nothing); never from the environment.
 */
export async function apiKey(o: KeychainOptions = {}): Promise<string | null> {
  const kc = keychainOf(o);
  try {
    const { stdout, code } = await getRunner()(SECURITY, ['find-generic-password', '-s', KEY_SERVICE, '-w', ...(kc ? [kc] : [])], { timeoutMs: 15_000 });
    if (code !== 0) return null;
    const key = stdout.trim();
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Whether a key is stored, without reading it: `find-generic-password`
 * without -w prints only the item's attributes, so the secret never leaves
 * the keychain to answer a yes or no.
 */
export async function apiKeyStored(o: KeychainOptions = {}): Promise<boolean> {
  const kc = keychainOf(o);
  try {
    const { code } = await getRunner()(SECURITY, ['find-generic-password', '-s', KEY_SERVICE, ...(kc ? [kc] : [])], { timeoutMs: 15_000 });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Stores the key (Settings), replacing any earlier one. The key never goes
 * on an argv: the command is fed to `security -i` on stdin, and nothing
 * security prints is kept. Records `api.key.set`, never the key.
 */
export async function setApiKey(key: string, o: KeychainOptions = {}): Promise<void> {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('That is not an Anthropic API key.');
  const kc = keychainOf(o);
  const line = ['add-generic-password', '-U', '-a', quoted(KEY_ACCOUNT), '-s', quoted(KEY_SERVICE), '-w', quoted(key), ...(kc ? [quoted(kc)] : [])].join(' ') + '\n';
  let problem: string | null = null;
  try {
    const child = getSpawner()(SECURITY, ['-i'], {
      stdin: line,
      clearEnv: true,
      env: { HOME: homedir(), USER: userInfo().username, PATH: '/usr/bin:/bin' },
      maxMs: 15_000,
    });
    // Drained and dropped: nothing security prints is logged or returned.
    for await (const _ of child.lines) void _;
    const done = await child.done;
    if (done.error) problem = `security could not start: ${done.error}`;
    else if (done.timedOut) problem = 'security timed out';
    else if (done.code !== 0) problem = `security exited ${done.code ?? done.signal}`;
  } catch (err) {
    // The cause is kept (a spawner's own error says what went wrong), with the key scrubbed out.
    problem = scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err), key);
  }
  if (problem) throw new Error(`The keychain did not store the key: ${problem}`);
  record('api.key.set', { service: KEY_SERVICE });
}

/** Removes the key. Records `api.key.removed`. */
export async function removeApiKey(o: KeychainOptions = {}): Promise<void> {
  const kc = keychainOf(o);
  try {
    await getRunner()(SECURITY, ['delete-generic-password', '-a', KEY_ACCOUNT, '-s', KEY_SERVICE, ...(kc ? [kc] : [])], { timeoutMs: 15_000 });
  } catch {
    throw new Error('The keychain did not remove the key.');
  }
  record('api.key.removed', { service: KEY_SERVICE });
}

/* ------------------------------------------------------------------ */
/* One call                                                            */
/* ------------------------------------------------------------------ */

type Block = Record<string, unknown> & { type: string };

interface CallResult {
  blocks: Block[];
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  usd: number;
  seconds: number;
  stopReason: string | null;
}

class Off extends Error {}

function scrub(text: string, key: string | null): string {
  return key ? text.split(key).join('[key]') : text;
}

function apiModel(ref: string): string {
  const name = ref.startsWith('anthropic:') ? ref.slice('anthropic:'.length) : ref;
  if (!/^claude-[a-z0-9.-]{1,80}$/.test(name)) throw new Error(`bad Anthropic model name ${JSON.stringify(name.slice(0, 80))}`);
  return name;
}

/** Reads the SSE body into content blocks, emitting text and tool calls as they complete. */
async function readStream(res: Response, onChunk: (c: ChatChunk) => void): Promise<Omit<CallResult, 'usd' | 'seconds'>> {
  const blocks: Block[] = [];
  const partial = new Map<number, string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let stopReason: string | null = null;
  let stopped = false;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const handle = (data: Record<string, unknown>) => {
    switch (data.type) {
      case 'message_start': {
        const u = ((data.message as Record<string, unknown>)?.usage ?? {}) as Record<string, unknown>;
        usage.input = n(u.input_tokens);
        usage.cacheRead = n(u.cache_read_input_tokens);
        usage.cacheCreation = n(u.cache_creation_input_tokens);
        usage.output = n(u.output_tokens);
        break;
      }
      case 'content_block_start': {
        const idx = Number(data.index);
        const b = { ...(data.content_block as Block) };
        blocks[idx] = b;
        if (b.type === 'tool_use') partial.set(idx, '');
        break;
      }
      case 'content_block_delta': {
        const idx = Number(data.index);
        const b = blocks[idx];
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (!b) throw new Error('a delta for a block that never started');
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text = String(b.text ?? '') + d.text;
          onChunk({ type: 'text', text: d.text });
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          partial.set(idx, (partial.get(idx) ?? '') + d.partial_json);
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking = String(b.thinking ?? '') + d.thinking;
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature = d.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const idx = Number(data.index);
        const b = blocks[idx];
        if (b?.type === 'tool_use') {
          const raw = partial.get(idx) ?? '';
          let input: unknown = raw;
          try {
            input = raw.trim() === '' ? {} : JSON.parse(raw);
          } catch {
            input = raw; // the loop refuses it as invalid JSON
          }
          b.input = input && typeof input === 'object' ? input : {};
          onChunk({ type: 'tool_call', call: { id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: input } });
        }
        break;
      }
      case 'message_delta': {
        const u = (data.usage ?? {}) as Record<string, unknown>;
        if (u.output_tokens !== undefined) usage.output = n(u.output_tokens);
        const d = (data.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === 'string') stopReason = d.stop_reason;
        break;
      }
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        const e = (data.error ?? {}) as Record<string, unknown>;
        throw new Error(`the API stream failed: ${String(e.type ?? '')} ${String(e.message ?? '').slice(0, 300)}`);
      }
      default:
        break;
    }
  };

  if (!res.body) throw new Error('the API answered with no body');
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true }).replace(/\r\n/g, '\n');
      if (buf.length > MAX_EVENT_BYTES) throw new Error('the API sent an event that is too long');
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) handle(JSON.parse(data) as Record<string, unknown>);
      }
    }
  } catch (err) {
    // Usage seen so far is still charged by the caller.
    (err as { partialUsage?: unknown }).partialUsage = usage;
    throw err;
  }
  if (!stopped) {
    const err = new Error('the API stream ended before message_stop');
    (err as { partialUsage?: unknown }).partialUsage = usage;
    throw err;
  }
  return { blocks: blocks.filter(Boolean), usage, stopReason };
}

export interface AnthropicOptions {
  /** The API base: the real one, or a loopback stand-in for tests. */
  baseUrl?: string;
  /** The keychain holding the key: his login keychain by default; tests name one in the temp dir. */
  keychain?: string;
}

export function anthropicProvider(o: AnthropicOptions = {}): Provider {
  const base = (o.baseUrl ?? API_BASE).replace(/\/+$/, '');
  if (base !== API_BASE && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) throw new Error(`the API base ${JSON.stringify(base)} is not allowed`);

  /** Refuses unless the backend is on with a daily limit; then the key, or a refusal. Reads no key while off. */
  async function ready(): Promise<string> {
    const s = getSettings().anthropicApi;
    if (!s.enabled) throw new Off('The Anthropic API backend is off.');
    if (!(typeof s.dailyUsd === 'number' && s.dailyUsd > 0)) throw new Off('The Anthropic API backend is off: no daily dollar limit is set.');
    const key = await apiKey(o.keychain === undefined ? {} : { keychain: o.keychain });
    if (!key) throw new Off('The Anthropic API backend has no API key stored.');
    return key;
  }

  /**
   * One streaming call under its own `api` lease: acquire (the dollar cap),
   * post, read, charge the real cost under the lease, release in finally.
   */
  async function call(
    ref: ModelRef,
    body: Record<string, unknown>,
    ctx: { kind: 'bid' | 'run' | 'review' | 'judge' | 'audit'; runId: string | null; firmId: string | null },
    signal: AbortSignal,
    onChunk: (c: ChatChunk) => void = () => {},
  ): Promise<CallResult> {
    const key = await ready();
    const model = String(body.model);
    const p = API_PRICES[modelFamily(model)];
    // Reserve the most this call can cost: its input (about 3 characters a token) and its full output allowance.
    const estUsd = ((JSON.stringify(body).length / 3) * p.input + Number(body.max_tokens) * p.output) / 1e6;
    const got = await acquire(ref, 'plan', apiCredits(estUsd));
    if (!got.ok) {
      if (got.reason.reason === 'stopped') throw new Error('The stop switch is on.');
      throw new LoopCap(got.reason.detail);
    }
    const lease: Lease = got.lease;
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal.addEventListener('abort', abort, { once: true });
    lease.signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || lease.signal.aborted) ctl.abort();
    const started = Date.now();
    let usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let charged = false;
    const chargeNow = () => {
      if (charged) return 0;
      charged = true;
      const usd = usdFor(usage, model);
      if (usd > 0) {
        const u: Usage = { weightedTokens: 0, seconds: (Date.now() - started) / 1000, usd, credits: apiCredits(usd) };
        charge({ runId: ctx.runId, firmId: ctx.firmId, model: ref, kind: ctx.kind, usage: u, unattended: unattended(), lease });
      }
      return usd;
    };
    try {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
          body: JSON.stringify(body),
          signal: ctl.signal,
          redirect: 'error',
        });
      } catch (err) {
        throw new Error(scrub(`the API could not be reached: ${err instanceof Error ? err.message : String(err)}`, key));
      }
      if (!res.ok) {
        const text = scrub((await res.text().catch(() => '')).slice(0, 500), key);
        throw new Error(`the API answered ${res.status}: ${text}`);
      }
      try {
        const out = await readStream(res, onChunk);
        usage = out.usage;
        const usd = chargeNow();
        return { ...out, usd, seconds: (Date.now() - started) / 1000 };
      } catch (err) {
        const partialUsage = (err as { partialUsage?: typeof usage }).partialUsage;
        if (partialUsage) usage = partialUsage;
        const usd = chargeNow();
        const e = new Error(scrub(err instanceof Error ? err.message : String(err), key));
        // What the cut-off call cost, so the loop counts it too.
        (e as { spent?: Partial<ChatUsage> }).spent = { ...usage, usd, seconds: (Date.now() - started) / 1000 };
        throw e;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      lease.release();
    }
  }

  function toApiMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        out.push({
          role: 'user',
          content: [...(m.images ?? []).map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })), { type: 'text', text: m.content }],
        });
      } else if (m.role === 'assistant') {
        // The API's own blocks go back unchanged (thinking blocks included); else they are rebuilt.
        const raw = Array.isArray(m.raw) ? (m.raw as unknown[]) : null;
        out.push({
          role: 'assistant',
          content: raw ?? [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} }))],
        });
      } else {
        const result = { type: 'tool_result', tool_use_id: m.callId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
        const last = out.at(-1);
        // Every result of one turn goes back in a single user message.
        if (last && last.role === 'user' && last.content.every((b) => (b as Block).type === 'tool_result')) last.content.push(result);
        else out.push({ role: 'user', content: [result] });
      }
    }
    return { system, messages: out };
  }

  /** The loop's transport: `kind` is what each turn is charged as (`run` for a firm's work, `audit` for the city's audit with no firm). */
  function transport(ref: ModelRef, runId: string, firmId: string | null, kind: 'run' | 'audit' = 'run'): ChatTransport {
    const model = apiModel(ref);
    return {
      async *chat(messages, tools: ToolSpec[], signal) {
        const { system, messages: msgs } = toApiMessages(messages);
        const body = {
          model,
          max_tokens: WORK_MAX_TOKENS,
          stream: true,
          system,
          messages: msgs,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        };
        const chunks: ChatChunk[] = [];
        let res: CallResult;
        try {
          res = await call(ref, body, { kind, runId, firmId }, signal, (c) => chunks.push(c));
        } catch (err) {
          for (const c of chunks) yield c;
          const spent = (err as { spent?: Partial<ChatUsage> }).spent;
          if (spent) yield { type: 'usage', usage: spent };
          throw err;
        }
        for (const c of chunks) yield c;
        // A tool call whose input max_tokens cut off arrives as raw text, and the loop refuses it as invalid JSON.
        yield { type: 'raw', raw: res.blocks };
        yield { type: 'usage', usage: { ...res.usage, usd: res.usd, seconds: res.seconds } satisfies Partial<ChatUsage> };
        if (res.stopReason === 'refusal') throw new Error('the model declined the request');
      },
    };
  }

  /** A single call with no tools: the text answer and its usage. */
  async function single(ref: ModelRef, system: string, content: unknown[], ctx: { kind: 'bid' | 'review' | 'judge'; firmId: string | null }, signal: AbortSignal) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) ctl.abort();
    const timer = setTimeout(() => ctl.abort(), CALL_MAX_MS);
    try {
      const body = { model: apiModel(ref), max_tokens: CALL_MAX_TOKENS, stream: true, system, messages: [{ role: 'user', content }] };
      const res = await call(ref, body, { kind: ctx.kind, runId: null, firmId: ctx.firmId }, ctl.signal);
      const text = res.blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
      const usage: Usage = { weightedTokens: 0, seconds: Math.round(res.seconds * 1000) / 1000, usd: res.usd, credits: apiCredits(res.usd) };
      return { answer: parseAnswer(text), usage };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    kind: 'anthropic',

    /**
     * The README audit (Phase 3 ruling 13) through the API: the read tools
     * alone, `run` limited to the repository's own checks, each result cut
     * to AUDIT_LOCAL_RESULT, the local caps, every turn charged as `audit`
     * under the city (no firm) and the model's JSON object as the answer.
     */
    async audit(i: AuditInput): Promise<AuditResult> {
      const zero: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };
      try {
        apiModel(i.model);
        await ready();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        i.log({ at: new Date().toISOString(), kind: 'engine', text: `api audit refused: ${reason}` });
        return { answer: null, text: '', usage: zero, ended: 'crashed', reason };
      }
      const commands = checkCommands(i.checks);
      const r = await runLoop({
        transport: transport(i.model, i.auditId, null, 'audit'),
        runId: i.auditId,
        dir: i.dir,
        system: AUDIT_PERSONA,
        user: auditPrompt(i),
        tools: auditLoopTools(commands),
        finish: 'json',
        resultCap: AUDIT_LOCAL_RESULT,
        allowedCommands: commands,
        maxTurns: Math.min(i.caps.maxTurns, AUDIT_CAPS.local.maxTurns),
        maxMs: Math.min(i.caps.maxMinutes, AUDIT_CAPS.local.maxMinutes) * 60_000,
        creditsFor: (u) => apiCredits(u.usd),
        log: i.log,
        onProgress: i.onProgress,
        signal: i.signal,
        caps: i.caps,
      });
      return { answer: r.answer, text: r.summary, usage: r.usage, ended: r.ended, reason: r.reason };
    },

    async work(i) {
      const zero: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };
      try {
        apiModel(i.agent.model);
        await ready();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        i.log({ at: new Date().toISOString(), kind: 'engine', text: `api run refused: ${reason}` });
        return { summary: '', usage: zero, ended: 'crashed', reason };
      }
      return runToolLoop(transport(i.agent.model, i.runId, i.agent.firmId), i, {
        maxTurns: i.caps.maxTurns,
        maxMs: i.caps.maxMinutes * 60_000,
        creditsFor: (u) => apiCredits(u.usd),
      });
    },

    async plan(i: PlanInput, signal) {
      const out = await single(i.agent.model, systemPrompt(i.persona, i.agent.instructions), [{ type: 'text', text: `${planPrompt(i)}\n${PLAN_JSON}\n` }], { kind: 'bid', firmId: i.agent.firmId }, signal);
      return { ...planAnswer(out.answer, 'anthropic'), usage: out.usage };
    },

    async review(i: ReviewInput, signal) {
      const out = await single(i.agent.model, systemPrompt(i.persona, i.agent.instructions), [{ type: 'text', text: `${reviewPrompt(i)}\n${REVIEW_JSON}\n` }], { kind: 'review', firmId: i.agent.firmId }, signal);
      return { ...reviewAnswer(out.answer, 'anthropic'), usage: out.usage };
    },

    async judge(i: JudgeInput, signal) {
      const before = cleanImages(i.before);
      const after = cleanImages(i.after);
      const images = [...before, ...after].map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }));
      const out = await single(
        `anthropic:${JUDGE_MODEL}`,
        'You judge interface changes against a design bar.',
        [...images, { type: 'text', text: judgeText(i, before.length, after.length) }],
        { kind: 'judge', firmId: null },
        signal,
      );
      const a = judgeAnswer(out.answer, 'anthropic', before.length > 0);
      const notes = images.length ? a.notes : `Scored from the diff text alone, with no screenshot to see. ${a.notes}`;
      return { ...a, notes, usage: out.usage };
    },
  };
}
