/**
 * The local tool loop (Task 10): how Ollama and Anthropic API agents work.
 * The model talks through a ChatTransport; the loop offers seven tools and
 * runs every one through the broker (Task 8): the file tools through
 * execFileTool() under the tool profile (ruling 29), `run` through
 * execTool(). Nothing an agent asks for runs in the engine process and no
 * file the agent names is opened here. Model output is untrusted: every
 * tool call is checked against its schema before anything runs, and a
 * refusal or an invalid call goes back to the model as the tool result.
 * The loop ends on `finish`, on a reply with no tool call, or at the turn,
 * wall or credit cap, or on abort; the run is reaped at the end either way.
 *
 * `runLoop()` is the loop with its prompts, its tool list and its finish as
 * parameters (Phase 3 ruling 13): a work run offers every tool and ends on a
 * summary; a README audit offers the read tools alone, caps each result for
 * a local model, lets `run` accept only the repository's own checks and ends
 * when the model's text is a JSON object.
 */
import { join } from 'node:path';

import { AUDIT_LOOP_TOOLS, firstJsonBlock } from '../audit/schema.js';
import { paths } from '../home.js';
import { DEFAULT_TOOL_MS, execFileTool, execTool, reapRun, type FileOp, type ToolResult } from './broker.js';
import type { RunLogLine, Usage, WorkInput } from './provider.js';
import { realish } from './sandbox.js';
import { planSection } from './quote.js';

/* ------------------------------------------------------------------ */
/* The transport                                                       */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON, or the raw text the model produced (parsed and checked by the loop). */
  arguments: unknown;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  /** `raw` is the transport's own form of the turn (for example thinking blocks), handed back to it unchanged. */
  | { role: 'assistant'; content: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; callId: string; name: string; content: string; isError: boolean };

export interface ToolSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'boolean' | 'integer'; description: string; maxLength?: number; minimum?: number; maximum?: number }>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolSchema;
}

/** Usage of one turn or of the whole loop. `usd` is the API's list-price cost (0 for local models). */
export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  seconds: number;
  usd: number;
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Partial<ChatUsage> }
  | { type: 'raw'; raw: unknown };

export interface ChatTransport {
  chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Thrown by a transport when a budget refuses the next call: the loop ends `capped` with its message. */
export class LoopCap extends Error {}

export interface LoopOptions {
  maxTurns: number;
  maxMs: number;
  creditsFor(usage: ChatUsage): number;
  /** Weighted tokens for the result's usage (Claude models through the API); 0 when left out. */
  weightedFor?(usage: ChatUsage): number;
  /** Kills whatever the run left behind (default reapRun). */
  reap?: (runRoot: string) => Promise<number[]>;
}

export type WorkResult = { summary: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null };
/** A loop's result: the work result, plus the parsed JSON object when the finish was `json` (null otherwise or when none came). */
export type LoopResult = WorkResult & { answer: unknown };

/** What `runLoop()` takes: the transport, the run, the prompts, the tools and how it ends. */
export interface LoopInput extends LoopOptions, Pick<WorkInput, 'log' | 'onProgress' | 'signal' | 'caps'> {
  transport: ChatTransport;
  /** The run (or audit) id: its root is `<home>/runs/<runId>` and `dir` must be its `repo` clone. */
  runId: string;
  dir: string;
  system: string;
  user: string;
  tools: ToolSpec[];
  /** `summary`: `finish` or a reply without a tool call ends the loop; `json`: a reply whose text parses as an object ends it, with one retry. */
  finish: 'summary' | 'json';
  /** Characters a tool result may carry to the model (default MAX_RESULT_CHARS; `AUDIT_LOCAL_RESULT` for a local audit). */
  resultCap?: number;
  /** When given, the `run` tool accepts only these command lines (an audit: the repository's own checks). */
  allowedCommands?: readonly string[];
}

/* ------------------------------------------------------------------ */
/* The tools                                                           */
/* ------------------------------------------------------------------ */

const PATH = { type: 'string' as const, description: 'A path relative to the repository root.', maxLength: 4096 };
const MAX_CONTENT = 8 * 1024 * 1024;

export const LOOP_TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a text file in the repository.',
    parameters: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the repository with the given content.',
    parameters: {
      type: 'object',
      properties: { path: PATH, content: { type: 'string', description: 'The whole new content of the file.', maxLength: MAX_CONTENT } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace old_text with new_text in a file. old_text must occur exactly once unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        old_text: { type: 'string', description: 'The exact text to replace.', maxLength: MAX_CONTENT },
        new_text: { type: 'string', description: 'The text to put in its place.', maxLength: MAX_CONTENT },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description: 'List the files in a directory of the repository (default the root).',
    parameters: {
      type: 'object',
      properties: { path: PATH, recursive: { type: 'boolean', description: 'List subdirectories too.' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Search file contents with a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression.', maxLength: 1000 },
        path: PATH,
        glob: { type: 'string', description: 'Only files matching this glob, such as src/**/*.ts.', maxLength: 1000 },
        ignore_case: { type: 'boolean', description: 'Match without regard to case.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    description: 'Run a shell command in the repository (tests, builds, git status). No network except package registries; git push and gh are refused.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line.', maxLength: 64 * 1024 },
        timeout_seconds: { type: 'integer', description: 'How long it may run (default 120, at most 900).', minimum: 1, maximum: 900 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'End the work with a short summary of what you changed.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What you changed and why.', maxLength: 8000 } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map(LOOP_TOOLS.map((t) => [t.name, t]));

/** How an audit's `run` tool describes itself: the declared checks, whole, and nothing else. */
export function auditRunDescription(commands: readonly string[]): string {
  const listed = commands.length ? commands.map((c) => `\`${c}\``).join(', ') : 'none: the repository declares no checks, so nothing can be run';
  return `Run one of the repository's own checks, exactly as listed, in the repository: ${listed}. Any other command is refused.`;
}

/**
 * The tools of a README audit (ruling 3): `AUDIT_LOOP_TOOLS` looked up in
 * `LOOP_TOOLS` by name, with `run` described as the declared checks alone.
 */
export function auditLoopTools(commands: readonly string[]): ToolSpec[] {
  return AUDIT_LOOP_TOOLS.map((name) => {
    const spec = BY_NAME.get(name);
    if (!spec) throw new Error(`no loop tool ${name}`);
    return name === 'run' ? { ...spec, description: auditRunDescription(commands) } : spec;
  });
}

/**
 * Checks a tool call against its tool's schema: a tool among those offered
 * (every loop tool unless `tools` says otherwise), arguments that are a JSON
 * object, only declared keys, every required key, and each value of its
 * declared type and bounds. Returns the arguments or a reason.
 */
export function validateCall(c: ToolCall, tools: ToolSpec[] = LOOP_TOOLS): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const spec = typeof c.name === 'string' ? tools.find((t) => t.name === c.name) : undefined;
  if (!spec) return { ok: false, reason: `there is no tool named ${JSON.stringify(String(c.name).slice(0, 80))}` };
  let args = c.arguments;
  if (typeof args === 'string') {
    try {
      args = args.trim() === '' ? {} : JSON.parse(args);
    } catch {
      return { ok: false, reason: 'the arguments are not valid JSON' };
    }
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'the arguments must be a JSON object' };
  const obj = args as Record<string, unknown>;
  const props = spec.parameters.properties;
  for (const key of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) return { ok: false, reason: `${spec.name} takes no argument ${JSON.stringify(key.slice(0, 80))}` };
  }
  for (const key of spec.parameters.required) {
    if (obj[key] === undefined) return { ok: false, reason: `${spec.name} needs ${key}` };
  }
  for (const [key, p] of Object.entries(props)) {
    const v = obj[key];
    if (v === undefined) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string') return { ok: false, reason: `${key} must be a string` };
      if (p.maxLength !== undefined && v.length > p.maxLength) return { ok: false, reason: `${key} is longer than ${p.maxLength} characters` };
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, reason: `${key} must be true or false` };
    } else {
      if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, reason: `${key} must be a whole number` };
      if ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum)) {
        return { ok: false, reason: `${key} must be between ${p.minimum} and ${p.maximum}` };
      }
    }
  }
  return { ok: true, args: obj };
}

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

function list(items: string[]): string {
  return items.length ? items.map((x) => `- ${x}`).join('\n') : '- (none given)';
}

export function loopSystemPrompt(i: WorkInput): string {
  return [i.persona.trim(), i.agent.instructions?.trim()].filter(Boolean).join('\n\n');
}

export function loopWorkPrompt(i: WorkInput): string {
  const parts = [
    `Job ${i.job.id} on ${i.job.repo}: ${i.job.title}`,
    i.job.body.trim(),
    `Acceptance:\n${list(i.job.acceptance)}`,
    `Scope (the only paths you may change):\n${list(i.job.scope)}`,
  ];
  if (i.plan) parts.push(planSection(i.plan));
  if (i.examples.length) parts.push(`Earlier work of your firm that merged:\n${list(i.examples)}`);
  parts.push(
    [
      'How to work:',
      `- You are in a fresh clone of the repository on branch ${i.branch}. Use read_file, write_file, edit_file, list_files and search with paths relative to the repository root.`,
      '- Run commands (tests, builds, git status) with the run tool.',
      '- Do not commit, push or touch .git. The city commits your change and inspects it.',
      '- When you are done, call finish with a short summary of what you changed.',
    ].join('\n'),
  );
  return parts.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

const MAX_RESULT_CHARS = 64 * 1024;
/** Text one turn may stream before it is cut. */
export const MAX_TURN_TEXT = 64 * 1024;
/** Tool calls one turn may ask for before it is cut. */
export const MAX_TURN_CALLS = 32;
/** How often a turn in flight is checked against the credit cap. */
const CAP_CHECK_MS = 500;
const LOG_CHARS = 2000;

function now(): string {
  return new Date().toISOString();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s;
}

function emptyUsage(): ChatUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, seconds: 0, usd: 0 };
}

function addUsage(total: ChatUsage, u: Partial<ChatUsage>): void {
  for (const k of Object.keys(total) as Array<keyof ChatUsage>) {
    const v = u[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) total[k] += v;
  }
}

function fileResultText(r: ToolResult & { result: unknown }, cap: number): { content: string; isError: boolean } {
  if (r.refused) return { content: `Refused: ${r.refused}`, isError: true };
  const res = r.result as { ok?: unknown; error?: unknown } | null;
  if (!res || typeof res !== 'object') return { content: clip(`The file tool failed.\n${r.stderr}`, cap), isError: true };
  if (res.ok !== true) return { content: `Error: ${typeof res.error === 'string' ? res.error : 'the file tool failed'}`, isError: true };
  const { ok: _ok, ...rest } = res as Record<string, unknown>;
  const content = typeof rest.content === 'string' && rest.op === 'read' ? (rest.truncated ? `${rest.content}\n[file cut at 256 KB]` : rest.content) : JSON.stringify(rest);
  return { content: clip(content, cap), isError: false };
}

/** What the model is told when a `json` finish got prose: one retry, then the loop ends crashed. */
export const JSON_RETRY = 'Your reply was not a JSON object. Answer only with the JSON object described in the instructions, nothing before or after it.';

/** The keys the audit's answer must carry; a block without both is prose to the loop and takes the retry. */
const ANSWER_KEYS = ['claims', 'findings'] as const;

/** The model's text as the answer object, or null: the whole text, else the first balanced block in it, and only with every answer key. */
function jsonObjectOf(text: string): Record<string, unknown> | null {
  const v = firstJsonBlock(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return ANSWER_KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k)) ? o : null;
}

/**
 * Runs the agent's work: one chat() per turn, each tool call validated and
 * run through the broker. The work loop: every tool, the work prompts, a
 * summary finish. See the file header for the endings.
 */
export async function runToolLoop(transport: ChatTransport, i: WorkInput, o: LoopOptions): Promise<WorkResult> {
  const { answer: _answer, ...r } = await runLoop({
    ...o,
    transport,
    runId: i.runId,
    dir: i.dir,
    system: loopSystemPrompt(i),
    user: loopWorkPrompt(i),
    tools: LOOP_TOOLS,
    finish: 'summary',
    log: i.log,
    onProgress: i.onProgress,
    signal: i.signal,
    caps: i.caps,
  });
  return r;
}

/**
 * The loop with its prompts, its tools and its finish as parameters. With
 * `finish: 'json'` a reply without a tool call ends the loop when its text
 * parses as a JSON object (`answer`); prose gets one retry asking for the
 * object alone, and a second miss ends the loop `crashed`.
 */
export async function runLoop(i: LoopInput): Promise<LoopResult> {
  const o = i;
  const resultCap = Math.max(1, Math.min(i.resultCap ?? MAX_RESULT_CHARS, MAX_RESULT_CHARS));
  const total = emptyUsage();
  const usage = (): Usage => ({
    weightedTokens: o.weightedFor ? o.weightedFor(total) : 0,
    seconds: Math.round(total.seconds * 1000) / 1000,
    usd: Math.round(total.usd * 1e6) / 1e6,
    credits: Math.round(o.creditsFor(total) * 1e6) / 1e6,
  });
  const end = (ended: WorkResult['ended'], reason: string | null, summary = '', answer: unknown = null): LoopResult => {
    i.log({ at: now(), kind: ended === 'finished' ? 'result' : 'engine', text: ended === 'finished' ? clip(summary, LOG_CHARS) : `the loop ended ${ended}: ${reason}` });
    return { summary, usage: usage(), ended, reason, answer };
  };

  const runRoot = join(paths().runs, i.runId);
  if (realish(i.dir) !== realish(join(runRoot, 'repo'))) return end('crashed', 'the work dir is not the run root repo');
  if (i.signal.aborted) return end('aborted', 'signal');

  // One controller for the turn in flight and every command: the caller's abort, the wall cap or a cap below.
  const ctl = new AbortController();
  let why: 'signal' | 'time' | null = null;
  const onAbort = () => {
    why ??= 'signal';
    ctl.abort();
  };
  i.signal.addEventListener('abort', onAbort, { once: true });
  const maxMs = Math.min(o.maxMs, i.caps.maxMinutes * 60_000);
  const timer = setTimeout(() => {
    why ??= 'time';
    ctl.abort();
  }, Math.max(1, maxMs));
  const maxTurns = Math.min(o.maxTurns, i.caps.maxTurns);
  const log = (l: RunLogLine) => i.log(l);
  const stopped = (): LoopResult | null =>
    why === 'signal' ? end('aborted', 'signal') : why === 'time' ? end('capped', `wall time cap of ${Math.round(maxMs / 1000)} s reached`) : null;

  const progress = { turns: 0, toolCalls: 0, refusals: 0, filesChanged: 0, testsRun: 0 };
  const changed = new Set<string>();
  const messages: ChatMessage[] = [
    { role: 'system', content: i.system },
    { role: 'user', content: i.user },
  ];
  const tick = () => i.onProgress({ ...progress, credits: usage().credits });
  let jsonRetried = false;

  try {
    for (;;) {
      const halted = stopped();
      if (halted) return halted;
      if (progress.turns >= maxTurns) return end('capped', `turn cap of ${maxTurns} reached`);

      let text = '';
      let raw: unknown;
      const calls: ToolCall[] = [];
      const turnUsage = emptyUsage();
      const turnStart = Date.now();
      // The turn has its own controller, so an overflow or a credit cap can stop it mid-stream.
      const turnCtl = new AbortController();
      const onLoopAbort = () => turnCtl.abort();
      ctl.signal.addEventListener('abort', onLoopAbort, { once: true });
      let cut: string | null = null;
      let capHit = false;
      const elapsed = () => (Date.now() - turnStart) / 1000;
      /** Credits so far, counting the turn's wall time until the model reports its own seconds. */
      const provisional = () => {
        const t = { ...total };
        addUsage(t, turnUsage);
        if (!turnUsage.seconds) t.seconds += elapsed();
        return o.creditsFor(t);
      };
      const checkCap = () => {
        if (!capHit && !cut && provisional() > i.caps.maxCredits) {
          capHit = true;
          turnCtl.abort();
        }
      };
      const capTimer = setInterval(checkCap, CAP_CHECK_MS);
      capTimer.unref();
      let failure: unknown = null;
      try {
        for await (const chunk of i.transport.chat(messages, i.tools, turnCtl.signal)) {
          if (chunk.type === 'usage') addUsage(turnUsage, chunk.usage);
          // After a cut or a cap the rest of the turn is drained and dropped.
          if (cut || capHit) continue;
          if (chunk.type === 'text') {
            text += chunk.text;
            if (text.length > MAX_TURN_TEXT) cut = `it passed ${MAX_TURN_TEXT} characters of text`;
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk.call);
            if (calls.length > MAX_TURN_CALLS) cut = `it asked for more than ${MAX_TURN_CALLS} tool calls`;
          } else if (chunk.type === 'raw') raw = chunk.raw;
          if (cut) turnCtl.abort();
          else checkCap();
        }
      } catch (err) {
        failure = err;
      } finally {
        clearInterval(capTimer);
        ctl.signal.removeEventListener('abort', onLoopAbort);
      }
      if (!turnUsage.seconds) turnUsage.seconds = elapsed();
      addUsage(total, turnUsage);
      const s = stopped();
      if (s) return s;
      if (capHit) return end('capped', `credit cap of ${i.caps.maxCredits} reached during a turn`);
      if (failure !== null && !cut) {
        if (failure instanceof LoopCap) return end('capped', failure.message);
        return end('crashed', `the model call failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      progress.turns += 1;
      if (text.trim()) log({ at: now(), kind: 'assistant', text: clip(text, LOG_CHARS) });
      tick();
      if (usage().credits > i.caps.maxCredits) return end('capped', `credit cap of ${i.caps.maxCredits} reached`);
      if (cut) {
        log({ at: now(), kind: 'refused', text: `turn cut: ${cut}` });
        progress.refusals += 1;
        messages.push({ role: 'assistant', content: text.slice(0, MAX_TURN_TEXT) || '(cut off)', toolCalls: [] });
        messages.push({
          role: 'user',
          content: `Your last reply was cut off because ${cut} in one turn. None of its tool calls ran. Make at most ${MAX_TURN_CALLS} tool calls per turn and keep your text short.`,
        });
        continue;
      }
      if (calls.length === 0) {
        if (i.finish === 'summary') return end('finished', null, text.trim());
        const answer = jsonObjectOf(text);
        if (answer) return end('finished', null, text.trim(), answer);
        if (jsonRetried) return end('crashed', 'the answer was not a JSON object, after one retry');
        jsonRetried = true;
        log({ at: now(), kind: 'engine', text: 'the reply was not a JSON object; asking once more' });
        messages.push({ role: 'assistant', content: text || '(empty)', toolCalls: [] });
        messages.push({ role: 'user', content: JSON_RETRY });
        continue;
      }

      // Ids come from the model: make them unique so results pair with their calls.
      const seenIds = new Set<string>();
      for (const [n, c] of calls.entries()) {
        if (typeof c.id !== 'string' || !c.id || seenIds.has(c.id)) c.id = `call-${progress.turns}-${n}`;
        seenIds.add(c.id);
      }
      messages.push({ role: 'assistant', content: text, toolCalls: calls, ...(raw === undefined ? {} : { raw }) });

      for (const c of calls) {
        progress.toolCalls += 1;
        const v = validateCall(c, i.tools);
        if (!v.ok) {
          log({ at: now(), kind: 'refused', text: `invalid tool call ${String(c.name).slice(0, 80)}: ${v.reason}` });
          progress.refusals += 1;
          messages.push({ role: 'tool', callId: c.id, name: String(c.name), content: `Invalid tool call: ${v.reason}. Nothing ran.`, isError: true });
          continue;
        }
        const args = v.args;
        if (c.name === 'finish') {
          tick();
          return end('finished', null, String(args.summary).trim());
        }
        const halted3 = stopped();
        if (halted3) return halted3;
        if (usage().credits > i.caps.maxCredits) return end('capped', `credit cap of ${i.caps.maxCredits} reached`);
        const base = { runId: i.runId, runRoot, dir: i.dir, signal: ctl.signal, log, stage: 'working' as const };
        let content: string;
        let isError: boolean;
        if (c.name === 'run') {
          const timeoutMs = typeof args.timeout_seconds === 'number' ? args.timeout_seconds * 1000 : DEFAULT_TOOL_MS;
          const r = await execTool({ ...base, command: args.command as string, timeoutMs, ...(i.allowedCommands ? { allowedCommands: i.allowedCommands } : {}) });
          if (r.refused) {
            content = `Refused: ${r.refused}`;
            isError = true;
          } else {
            content = clip(`exit ${r.code === null ? 'none' : r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`, resultCap);
            isError = r.code !== 0;
          }
        } else {
          const { op, fileArgs } = fileCall(c.name, args);
          const r = await execFileTool({ ...base, op, args: fileArgs });
          ({ content, isError } = fileResultText(r, resultCap));
          if (!r.refused && !isError && (op === 'write' || op === 'edit')) changed.add(String(fileArgs.path));
        }
        if (content.startsWith('Refused:')) progress.refusals += 1;
        progress.filesChanged = changed.size;
        messages.push({ role: 'tool', callId: c.id, name: c.name, content, isError });
        tick();
      }
    }
  } finally {
    clearTimeout(timer);
    i.signal.removeEventListener('abort', onAbort);
    ctl.abort();
    try {
      const reaped = await (o.reap ?? reapRun)(runRoot);
      if (reaped.length) i.log({ at: now(), kind: 'engine', text: `[palimpsest] killed ${reaped.length} process(es) left at the end of the run` });
    } catch (err) {
      i.log({ at: now(), kind: 'engine', text: `[palimpsest] the final reap failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

/** The file tool operation and its arguments for a validated call. */
function fileCall(name: string, a: Record<string, unknown>): { op: FileOp; fileArgs: Record<string, unknown> } {
  const keep = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (name) {
    case 'read_file':
      return { op: 'read', fileArgs: { path: a.path } };
    case 'write_file':
      return { op: 'write', fileArgs: { path: a.path, content: a.content } };
    case 'edit_file':
      return { op: 'edit', fileArgs: keep({ path: a.path, old: a.old_text, new: a.new_text, all: a.replace_all }) };
    case 'list_files':
      return { op: 'list', fileArgs: keep({ path: a.path, recursive: a.recursive }) };
    case 'search':
      return { op: 'search', fileArgs: keep({ pattern: a.pattern, path: a.path, glob: a.glob, ignoreCase: a.ignore_case }) };
    default:
      throw new Error(`no file tool ${name}`);
  }
}
