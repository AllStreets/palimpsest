/**
 * The Ollama backend (Task 10). Work runs the local tool loop over
 * `POST http://<ollamaHost>/api/chat` with `stream: true`; plan and review
 * are single calls with `format: 'json'`; the design judge sends the
 * before and after screenshots to the installed vision model
 * (`qwen2.5vl:7b*`) and scores the diff text alone only when no image
 * exists (ruling 13). Credits come from seconds and model size (ruling 1),
 * the size from `ollama show` once per model.
 *
 * These calls are the engine's own and are not sandboxed (the engine is
 * trusted); everything the agent asks for runs through the broker under the
 * tool profile (toolloop.ts). Ollama is reached only on loopback.
 */
import { localCredits } from '../../shared/credits.js';
import { getRunner } from '../exec.js';
import { getSettings } from '../settings.js';
import { planPrompt, reviewPrompt, systemPrompt } from './claude.js';
import { installedModels, resolveModel } from './firms.js';
import { diffSection } from './quote.js';
import type { JudgeInput, PlanInput, Provider, ReviewInput, Usage } from './provider.js';
import { runToolLoop, type ChatChunk, type ChatMessage, type ChatTransport, type ToolSpec } from './toolloop.js';

/** The vision model the design judge uses, by prefix. */
export const VISION_MODEL_PREFIX = 'qwen2.5vl:7b';
/** Single plan, review and judge calls. */
export const CALL_MAX_MS = 5 * 60_000;
/** A streamed line longer than this ends the call. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CHARS = 100_000;
/** Assumed when `ollama show` gives nothing usable: errs high, so credits err high. */
const FALLBACK_GB = 20;

/* ------------------------------------------------------------------ */
/* Host and model size                                                 */
/* ------------------------------------------------------------------ */

/** The Ollama base URL from settings, refused unless it is a loopback host and port. */
export function ollamaBase(): string {
  const host = getSettings().ollamaHost;
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(String(host));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`ollamaHost ${JSON.stringify(host)} is not a loopback host and port`);
  return `http://${m[1]}:${m[2]}`;
}

/** Bits per weight for a quantization name: Q4_K_M 4.5, Q8_0 8.5, MXFP4 4.25, F16 16. Null when unknown. */
function bitsFor(q: string): number | null {
  const u = q.toUpperCase();
  if (u === 'MXFP4') return 4.25;
  if (u === 'F16' || u === 'BF16') return 16;
  if (u === 'F32') return 32;
  const m = /^I?Q(\d)/.exec(u);
  return m ? Number(m[1]) + 0.5 : null;
}

/** The model's size in GB from `ollama show` output (parameters times bits per weight), or null. */
export function modelGBFromShow(text: string): number | null {
  const p = /^\s*parameters\s+([\d.]+)\s*([BM])\b/im.exec(text);
  const q = /^\s*quantization\s+(\S+)/im.exec(text);
  if (!p) return null;
  const params = Number(p[1]) * (p[2].toUpperCase() === 'M' ? 0.001 : 1);
  const bits = q ? bitsFor(q[1]) : null;
  if (!Number.isFinite(params) || params <= 0) return null;
  return (params * (bits ?? 4.5)) / 8;
}

const sizes = new Map<string, Promise<number>>();

/** For tests: forgets the cached model sizes. */
export function resetOllamaCache(): void {
  sizes.clear();
}

/** The model's size in GB, from `ollama show` once per model. */
export function modelGB(model: string): Promise<number> {
  let p = sizes.get(model);
  if (!p) {
    p = (async () => {
      try {
        const { stdout, code } = await getRunner()('ollama', ['show', model], { timeoutMs: 15_000 });
        return (code === 0 ? modelGBFromShow(stdout) : null) ?? FALLBACK_GB;
      } catch {
        return FALLBACK_GB;
      }
    })();
    sizes.set(model, p);
  }
  return p;
}

function modelName(ref: string): string {
  const name = ref.startsWith('ollama:') ? ref.slice('ollama:'.length) : ref;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(name)) throw new Error(`bad Ollama model name ${JSON.stringify(name.slice(0, 80))}`);
  return name;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

interface OllamaLine {
  message?: { content?: unknown; tool_calls?: unknown };
  done?: boolean;
  total_duration?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

async function post(body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${ollamaBase()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`ollama answered ${res.status}: ${text}`);
  }
  return res;
}

/** Reads an NDJSON body line by line. */
async function* ndjson(res: Response): AsyncGenerator<OllamaLine> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    if (buf.length > MAX_LINE_BYTES) throw new Error('ollama sent a line that is too long');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as OllamaLine;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield JSON.parse(buf.trim()) as OllamaLine;
}

function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content, ...(m.images?.length ? { images: m.images } : {}) };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}),
        };
      case 'tool':
        return { role: 'tool', content: m.content, tool_name: m.name };
    }
  });
}

function toOllamaTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** The streaming transport the tool loop talks through. */
export function ollamaTransport(model: string): ChatTransport {
  return {
    async *chat(messages, tools, signal): AsyncGenerator<ChatChunk> {
      const started = Date.now();
      const res = await post({ model, messages: toOllamaMessages(messages), tools: toOllamaTools(tools), stream: true }, signal);
      let n = 0;
      let doneSeen = false;
      for await (const line of ndjson(res)) {
        if (line.error !== undefined) throw new Error(`ollama: ${String(line.error).slice(0, 500)}`);
        const content = line.message?.content;
        if (typeof content === 'string' && content) yield { type: 'text', text: content };
        const calls = line.message?.tool_calls;
        if (Array.isArray(calls)) {
          for (const c of calls) {
            const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
            const id = (c as { id?: unknown })?.id;
            yield { type: 'tool_call', call: { id: typeof id === 'string' ? id : `t${n++}`, name: String(fn?.name ?? ''), arguments: fn?.arguments } };
          }
        }
        if (line.done) {
          doneSeen = true;
          const ns = num(line.total_duration);
          yield { type: 'usage', usage: { input: num(line.prompt_eval_count), output: num(line.eval_count), seconds: ns ? ns / 1e9 : (Date.now() - started) / 1000 } };
        }
      }
      if (!doneSeen) {
        yield { type: 'usage', usage: { seconds: (Date.now() - started) / 1000 } };
        throw new Error('ollama ended the stream before done');
      }
    },
  };
}

/** One non-streaming call with `format: 'json'`: the parsed answer and its seconds. */
/** The context window review and judge calls ask for: the whole diff must fit, never Ollama's small default. */
export const REVIEW_NUM_CTX = 32_768;

/** Tokens below num_ctx a prompt must stay under: at or past it, Ollama may have cut the front. */
export const CONTEXT_MARGIN = 512;

/** Characters a token for the densest text (CJK, minified code, base64): the length guard before a call. */
export const CHARS_PER_TOKEN_DENSE = 1.5;

/**
 * A review or judge call whose prompt filled the context: Ollama silently
 * drops the front of a prompt longer than `num_ctx`, so the answer may not
 * have read the change. Never a pass: the inspection is inconclusive.
 */
export class TooLargeError extends Error {
  readonly tooLarge = true;
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

async function jsonCall(
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  numCtx?: number,
  what = 'call',
): Promise<{ answer: Record<string, unknown> | null; seconds: number }> {
  // A prompt that cannot fit is refused unsent: dense text (CJK, minified, base64) runs near
  // 1.5 characters a token, and Ollama would silently cut its front.
  if (numCtx) {
    const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    if (chars / CHARS_PER_TOKEN_DENSE > numCtx - CONTEXT_MARGIN) {
      throw new TooLargeError(`ollama ${what}: the prompt is ${chars} characters, more than the ${numCtx} token context can surely hold; the change is too large to review.`);
    }
  }
  const started = Date.now();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) ctl.abort();
  const timer = setTimeout(() => ctl.abort(), CALL_MAX_MS);
  try {
    const res = await post({ model, messages: toOllamaMessages(messages), stream: false, format: 'json', ...(numCtx ? { options: { num_ctx: numCtx } } : {}) }, ctl.signal);
    const text = await res.text();
    if (text.length > MAX_LINE_BYTES) throw new Error('ollama answered with too much');
    const body = JSON.parse(text) as OllamaLine;
    if (body.error !== undefined) throw new Error(`ollama: ${String(body.error).slice(0, 500)}`);
    const ns = num(body.total_duration);
    const read = num(body.prompt_eval_count);
    if (numCtx && read === 0) {
      throw new TooLargeError(`ollama ${what}: Ollama did not say how much of the prompt it read, so it may have cut its front; the change is too large to review.`);
    }
    if (numCtx && read >= numCtx - CONTEXT_MARGIN) {
      throw new TooLargeError(`ollama ${what}: the prompt filled ${read} of the ${numCtx} token context, so Ollama may have cut its front; the change is too large to review.`);
    }
    return { answer: parseAnswer(body.message?.content), seconds: ns ? ns / 1e9 : (Date.now() - started) / 1000 };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/* ------------------------------------------------------------------ */
/* Answers (shared with the Anthropic backend)                         */
/* ------------------------------------------------------------------ */

/** A model's JSON answer: the text as JSON, else the first {...} in it; null unless an object. */
export function parseAnswer(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;
  let v: unknown = null;
  try {
    v = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    try {
      v = m ? JSON.parse(m[0]) : null;
    } catch {
      v = null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function planAnswer(a: Record<string, unknown> | null, who: string): { plan: string; price: number; confidence: number } {
  if (!a || typeof a.plan !== 'string' || !a.plan.trim() || !finite(a.price) || a.price < 0 || !finite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    throw new Error(`${who} plan: the answer does not match the shape`);
  }
  return { plan: a.plan, price: a.price, confidence: a.confidence };
}

export function reviewAnswer(a: Record<string, unknown> | null, who: string): { approve: boolean; notes: string; concerns: string[] } {
  if (!a || typeof a.approve !== 'boolean' || typeof a.notes !== 'string' || !Array.isArray(a.concerns) || !a.concerns.every((c) => typeof c === 'string')) {
    throw new Error(`${who} review: the answer does not match the shape`);
  }
  return { approve: a.approve, notes: a.notes, concerns: a.concerns as string[] };
}

export function judgeAnswer(a: Record<string, unknown> | null, who: string, hasBefore: boolean): { before: number | null; after: number; notes: string } {
  if (!a || !finite(a.after) || typeof a.notes !== 'string' || (a.before !== undefined && a.before !== null && !finite(a.before))) {
    throw new Error(`${who} judge: the answer does not match the shape`);
  }
  const clamp = (x: number) => Math.max(0, Math.min(10, x));
  return { before: hasBefore && finite(a.before) ? clamp(a.before) : null, after: clamp(a.after), notes: a.notes };
}

export const PLAN_JSON = 'Answer only with a JSON object: {"plan": string, "price": number, "confidence": number}.';
export const REVIEW_JSON = 'Answer only with a JSON object: {"approve": boolean, "notes": string, "concerns": string[]}.';

/** Screenshots as bare base64, refused unless each is base64. */
export function cleanImages(list: string[]): string[] {
  return list.map((s) => {
    const bare = String(s).replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');
    if (!bare || bare.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) throw new Error('a screenshot is not base64');
    return bare;
  });
}

/** The judge's prompt: with screenshots, or the diff text alone (ruling 13). */
export function judgeText(i: JudgeInput, before: number, after: number): string {
  const diff = diffSection(i.diff, MAX_DIFF_CHARS);
  // The bar and the instructions come after the diff: were the front of the prompt ever cut, they survive.
  if (before + after === 0) {
    return [
      diff,
      `The design bar:\n${i.bar.trim()}`,
      'There are no screenshots: you see only the change as text. Score how well the result meets the bar from 0 to 10.',
      'Answer only with a JSON object: {"after": number, "notes": string}.',
    ].join('\n\n');
  }
  return [
    diff,
    `The design bar:\n${i.bar.trim()}`,
    `You get ${before + after} screenshots: the first ${before} show the interface before the change, the last ${after} after it.`,
    `Score each side from 0 to 10 against the bar.${before ? '' : ' There is no before screenshot: set before to null.'}`,
    'Answer only with a JSON object: {"before": number | null, "after": number, "notes": string}.',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

function usageOf(seconds: number, gb: number): Usage {
  return { weightedTokens: 0, seconds: Math.round(seconds * 1000) / 1000, usd: 0, credits: Math.round(localCredits(seconds, gb) * 1e6) / 1e6 };
}

export function ollamaProvider(): Provider {
  return {
    kind: 'ollama',

    async audit() {
      throw new Error('not implemented');
    },

    async work(i) {
      const zero: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };
      let model: string;
      try {
        ollamaBase();
        model = modelName(i.agent.model);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        i.log({ at: new Date().toISOString(), kind: 'engine', text: `ollama run crashed: ${reason}` });
        return { summary: '', usage: zero, ended: 'crashed', reason };
      }
      const gb = await modelGB(model);
      return runToolLoop(ollamaTransport(model), i, {
        maxTurns: i.caps.maxTurns,
        maxMs: i.caps.maxMinutes * 60_000,
        creditsFor: (u) => localCredits(u.seconds, gb),
      });
    },

    async plan(i: PlanInput, signal) {
      const model = modelName(i.agent.model);
      const gb = await modelGB(model);
      const out = await jsonCall(model, [{ role: 'system', content: systemPrompt(i.persona, i.agent.instructions) }, { role: 'user', content: `${planPrompt(i)}\n${PLAN_JSON}\n` }], signal);
      return { ...planAnswer(out.answer, 'ollama'), usage: usageOf(out.seconds, gb) };
    },

    async review(i: ReviewInput, signal) {
      const model = modelName(i.agent.model);
      const gb = await modelGB(model);
      const out = await jsonCall(model, [{ role: 'system', content: systemPrompt(i.persona, i.agent.instructions) }, { role: 'user', content: `${reviewPrompt(i)}\n${REVIEW_JSON}\n` }], signal, REVIEW_NUM_CTX, 'review');
      return { ...reviewAnswer(out.answer, 'ollama'), usage: usageOf(out.seconds, gb) };
    },

    async judge(i: JudgeInput, signal) {
      const before = cleanImages(i.before);
      const after = cleanImages(i.after);
      const model = resolveModel(VISION_MODEL_PREFIX, await installedModels());
      if (!model) throw new Error(`ollama judge: no vision model ${VISION_MODEL_PREFIX} is installed`);
      const gb = await modelGB(model);
      const images = [...before, ...after];
      const out = await jsonCall(
        model,
        [
          { role: 'system', content: 'You judge interface changes against a design bar.' },
          { role: 'user', content: judgeText(i, before.length, after.length), ...(images.length ? { images } : {}) },
        ],
        signal,
        REVIEW_NUM_CTX,
        'judge',
      );
      const a = judgeAnswer(out.answer, 'ollama', before.length > 0);
      const notes = images.length ? a.notes : `Scored from the diff text alone, with no screenshot to see. ${a.notes}`;
      return { ...a, notes, usage: usageOf(out.seconds, gb) };
    },
  };
}
