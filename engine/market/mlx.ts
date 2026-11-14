/**
 * The mlx backend (Phase 4 Task 26, ruling 26): the school's graduates as
 * local models. A graduate `mlx:<name>` is served by one warm
 * `mlx_lm.server --model <base> --adapter-path <dir> --host 127.0.0.1
 * --port <free>`, started by the engine through the spawner, fenced in the
 * trainer profile with exactly one network exception (bind and inbound on
 * that loopback port; no outbound at all), `HF_HUB_OFFLINE=1` and an
 * environment built from nothing (no key, no token). One server at a time:
 * a call for another graduate waits for the calls in flight, stops the
 * running server and starts its own. A server with no call for ten minutes
 * is stopped.
 *
 * Only an adapter `trainedAdapter()` offers is ever served (a trained LoRA
 * whose checkpoint is whole; never a paused, training or failed one), and
 * only over the base the school downloaded on his click. The graduate's
 * LoRA comes from its `graduates` row (Task 27 writes them); `mlx:lora-<id>`
 * names a trained LoRA directly, for graduation's own sealed race. The base
 * alone (`mlx:base`, no `--adapter-path`, the same fence) is served only
 * while a graduation's sealed race holds it (`serveBase`, Task 27), for the
 * base side of that race.
 *
 * The transport is OpenAI's chat completions with tools, unstreamed. The
 * request never names a model or an adapter, so the server answers only
 * with the one it was started with. Qwen's `<tool_call>` tags in the text
 * are read as tool calls when the server leaves them unparsed. Credits are
 * local by seconds (Phase 2 ruling 1) at the base's size, `LORA.gb`; the
 * caller charges them and leases the local pool (`poolOfModel` is `local`).
 */
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { localCredits } from '../../shared/credits.js';
import { AUDIT_CAPS, AUDIT_LOCAL_RESULT } from '../../shared/market-rules.js';
import { LORA } from '../../shared/school-rules.js';
import type { ModelRef } from '../../shared/types.js';
import { AUDIT_PERSONA, auditPrompt, checkCommands } from '../audit/schema.js';
import { openDb } from '../db.js';
import { getRunner, getSpawner, signalGroup, type Spawned } from '../exec.js';
import { paths } from '../home.js';
import { getSettings } from '../settings.js';
import { trainerEnv, trainerPython } from '../school/trainer-env.js';
import { planPrompt, reviewPrompt, systemPrompt } from './claude.js';
import { parseAnswer, planAnswer, PLAN_JSON, reviewAnswer, REVIEW_JSON } from './ollama.js';
import type { AuditInput, AuditResult, CompleteInput, CompleteResult, JudgeInput, PlanInput, Provider, ReviewInput, Usage } from './provider.js';
import { withSpent } from './provider.js';
import { wrap } from './sandbox.js';
import { auditLoopTools, runLoop, runToolLoop, type ChatChunk, type ChatMessage, type ChatTransport, type ToolCall, type ToolSpec } from './toolloop.js';

/** A server with no call for this long is stopped (ruling 26). */
export const MLX_IDLE_MS = 10 * 60_000;
/** How long a server may take to load the base and the adapter before the call fails. */
export const MLX_READY_MS = 3 * 60_000;
/** The size the local credit rate uses: the 4-bit base every graduate is served over. */
export const MLX_GB = LORA.gb;
/** Tokens a reply may run to (mlx_lm.server's own default is far too short to write a file). */
export const MLX_MAX_TOKENS = 4096;
/** Single plan, review, judge and complete calls. */
export const CALL_MAX_MS = 5 * 60_000;
/** Ports the server may never take: the engine's API, the UI's dev server, Ollama. */
const RESERVED_PORTS = new Set([4770, 4771, 11434]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK = '127.0.0.1';

/* ------------------------------------------------------------------ */
/* Which adapter a model is                                            */
/* ------------------------------------------------------------------ */

const LORA_REF = /^mlx:(lora-[0-9a-f]{8})$/;

/** The base model alone, with no adapter: the other side of a graduation's sealed race (ruling 25). */
export const MLX_BASE = 'mlx:base' as ModelRef;
/** What `adapterFor` names the base alone by. */
const BASE_ID = 'base';

/** How many graduation races hold the base-alone server open now (`serveBase`). */
let baseHolds = 0;

/**
 * A graduation's sealed race (Task 27) holds the base alone open to be
 * served until the returned function is called, once. Outside such a hold
 * `mlx:base` is refused: no firm's agent is ever the bare base.
 */
export function serveBase(): () => void {
  baseHolds++;
  let given = false;
  return () => {
    if (given) return;
    given = true;
    baseHolds = Math.max(0, baseHolds - 1);
  };
}

/** What a model is served with: a trained adapter over the base, or (`path` null) the base alone. */
export interface ServedAdapter {
  id: string;
  path: string | null;
  file: string | null;
}

/** The LoRA a graduate was made from, from its `graduates` row; null when no graduate is this model. */
function graduateLora(model: ModelRef): string | null {
  for (const row of openDb().prepare('SELECT json FROM graduates').all() as Array<{ json: string }>) {
    try {
      const g = JSON.parse(row.json) as { model?: unknown; loraId?: unknown };
      if (g.model === model && typeof g.loraId === 'string') return g.loraId;
    } catch {
      // a row that cannot be read names nothing
    }
  }
  return null;
}

/**
 * The adapter `model` is served with, from `trainedAdapter()` alone: the
 * graduate's LoRA, or the LoRA `mlx:lora-<id>` names; `mlx:base` is the
 * base alone, and only while a graduation's race holds it. Throws, with the
 * reason, when there is none or the base is not downloaded.
 */
export async function adapterFor(model: ModelRef): Promise<ServedAdapter> {
  // turning the school off stops the graduates' server: nothing serves one again until it is on
  if (!getSettings().school.enabled) throw new SchoolOff();
  // loaded on use: lora.ts reaches back into the market through history.ts
  const { baseReady, trainedAdapter } = await import('../school/lora.js');
  if (!model.startsWith('mlx:')) throw new Error(`${model} is not an mlx model`);
  if (model === MLX_BASE) {
    if (baseHolds === 0) throw new Error("The base model alone is served only for a graduation's sealed race");
    if (!baseReady()) throw new Error('The base model is not downloaded');
    return { id: BASE_ID, path: null, file: null };
  }
  const loraId = LORA_REF.exec(model)?.[1] ?? graduateLora(model);
  const adapter = loraId ? trainedAdapter(loraId) : null;
  if (!adapter) throw new Error(`${model} has no trained adapter to serve`);
  if (!baseReady()) throw new Error('The base model is not downloaded');
  return adapter;
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

interface Live {
  model: ModelRef;
  adapterId: string;
  port: number;
  url: string;
  child: Spawned;
  inflight: number;
  idle: unknown;
  exited: boolean;
  drained: Array<() => void>;
  /** Aborted when the server is stopped: a call still in flight ends with an error at once. */
  calls: AbortController;
  /** The server's last lines, for a failure's reason. */
  tail: string[];
}

export interface MlxServer {
  model: ModelRef;
  adapterId: string;
  port: number;
  url: string;
}

let current: Live | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier start and stop: one server at a time. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

type PortPicker = () => Promise<number>;

/** A free loopback port the OS hands out, never one the city already uses. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createNetServer();
      s.unref();
      s.on('error', reject);
      s.listen(0, LOOPBACK, () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('no free loopback port for the mlx server');
}

let pickPort: PortPicker = freePort;

/** Installs the port picker, for tests (the fake server's port), or `null` for a free one. */
export function setPortPicker(fn: PortPicker | null): void {
  pickPort = fn ?? freePort;
}

export interface ServerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ServerTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
let timers: ServerTimers = realTimers;

/** Installs the idle timer, for tests, or `null` for the real one. */
export function setServerTimers(t: ServerTimers | null): void {
  timers = t ?? realTimers;
}

type Kill = (pgid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
let killFn: Kill = signalGroup;

/** Installs the group kill `reapStrayServer` uses, for tests, or `null` for the real one. */
export function setServerKill(fn: Kill | null): void {
  killFn = fn ?? signalGroup;
}

/** How long after a stray server's SIGTERM it gets SIGKILL. */
export const STRAY_KILL_GRACE_MS = 10_000;

/** The running server, or null. */
export function serverState(): { model: ModelRef; adapterId: string; port: number; inflight: number } | null {
  return current && !current.exited ? { model: current.model, adapterId: current.adapterId, port: current.port, inflight: current.inflight } : null;
}

function view(l: Live): MlxServer {
  return { model: l.model, adapterId: l.adapterId, port: l.port, url: l.url };
}

function clearIdle(l: Live): void {
  if (l.idle !== null) timers.clear(l.idle);
  l.idle = null;
}

/* The server's pid, kept under the school's ctl (the trainer profile denies the server writing there), so the next engine reaps a server this one left behind. */

/** Where the running server's pid is recorded: `<school>/ctl/mlx-server.json`. */
export function serverPidFile(): string {
  return join(paths().school, 'ctl', 'mlx-server.json');
}

function writePid(l: Live, base: string): void {
  if (l.child.pid === null) return;
  const file = serverPidFile();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: l.child.pid, port: l.port, model: l.model, adapterId: l.adapterId, base, at: new Date().toISOString() }) + '\n');
}

function readPid(): { pid: number; base: string } | null {
  try {
    const d = JSON.parse(readFileSync(serverPidFile(), 'utf8')) as { pid?: unknown; base?: unknown };
    return typeof d.pid === 'number' && Number.isInteger(d.pid) && typeof d.base === 'string' ? { pid: d.pid, base: d.base } : null;
  } catch {
    return null;
  }
}

/** Removes the pid file when it still names `pid` (a later server's file is left alone). */
function forgetPid(pid: number | null): void {
  if (pid !== null && readPid()?.pid === pid) rmSync(serverPidFile(), { force: true });
}

/** Whether `pid` is still our `mlx_lm.server` over `base`, by its command line, so a reused pid is never signalled. */
async function isOurServer(pid: number, base: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const r = await getRunner()('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000 });
    return r.code === 0 && r.stdout.includes('mlx_lm.server') && r.stdout.includes(`--model ${base}`);
  } catch {
    return false;
  }
}

/**
 * At engine start: a server the last engine left running (its pid file is
 * still there) gets SIGTERM, and SIGKILL `STRAY_KILL_GRACE_MS` later, but
 * only while its command line is still our `mlx_lm.server` over the
 * school's base; a reused pid is never signalled. The file goes either way.
 * Answers whether a stray was signalled.
 */
export async function reapStrayServer(): Promise<boolean> {
  const rec = readPid();
  if (!rec) {
    rmSync(serverPidFile(), { force: true });
    return false;
  }
  if (current && current.child.pid === rec.pid) return false;
  let hit = false;
  if (await isOurServer(rec.pid, rec.base)) {
    killFn(rec.pid, 'SIGTERM');
    const later = setTimeout(() => killFn(rec.pid, 'SIGKILL'), STRAY_KILL_GRACE_MS);
    later.unref();
    hit = true;
  }
  forgetPid(rec.pid);
  return hit;
}

/**
 * Ends `l`. With `waitForCalls`, first waits for its calls in flight to
 * end; without, they are aborted at once. Then SIGTERM (the spawner
 * escalates to SIGKILL), and waits for it to go.
 */
async function stopLive(l: Live, waitForCalls: boolean): Promise<void> {
  if (waitForCalls && l.inflight > 0) await new Promise<void>((r) => l.drained.push(r));
  clearIdle(l);
  if (current === l) current = null;
  l.calls.abort(new Error('the mlx server was stopped'));
  if (!l.exited) {
    l.child.kill('SIGTERM');
    await l.child.done;
  }
}

/** Waits until the server answers `GET /v1/models`; throws if it exits first or takes past MLX_READY_MS. */
async function waitReady(l: Live): Promise<void> {
  const deadline = Date.now() + MLX_READY_MS;
  for (;;) {
    if (l.exited) throw new Error(`mlx_lm.server ended before it was ready${l.tail.length ? `: ${l.tail.slice(-3).join(' | ').slice(0, 500)}` : ''}`);
    try {
      const res = await fetch(`${l.url}/v1/models`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      await res.text();
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`mlx_lm.server did not answer within ${MLX_READY_MS / 1000} s`);
    await sleep(500);
  }
}

/**
 * Whether the port that answered is held by our child and no one else: the
 * pids listening on it (`lsof`) must be exactly the child's. Another
 * process that took the port first would answer the readiness check, and
 * every prompt would go to it.
 */
async function ownsPort(l: Live): Promise<boolean> {
  if (l.child.pid === null) return false;
  try {
    const r = await getRunner()('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${l.port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 10_000 });
    if (r.code !== 0) return false;
    const pids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
    return pids.length > 0 && pids.every((p) => p === l.child.pid);
  } catch {
    return false;
  }
}

/** Starts the server for `model` over `adapter` under the trainer profile, on one loopback port, and waits until it answers. */
async function start(model: ModelRef, adapter: { id: string; path: string | null }): Promise<Live> {
  const python = trainerPython();
  if (!python) throw new Error('The trainer is not set up on this Mac');
  const { loraBaseDir } = await import('../school/lora.js');
  const base = loraBaseDir();
  const port = await pickPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || RESERVED_PORTS.has(port)) throw new Error(`the mlx server may not use port ${port}`);
  const school = paths().school;
  const tmp = join(school, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const tail: string[] = [];
  const argv = wrap(
    // -I: no cwd or user site on the path, no PYTHON* variables; -B: no bytecode written into a venv it borrows
    [python, '-I', '-B', '-m', 'mlx_lm.server', '--model', base, ...(adapter.path === null ? [] : ['--adapter-path', adapter.path]), '--host', LOOPBACK, '--port', String(port)],
    'trainer',
    { school, tmp, bindPort: port, name: 'trainer-serve.sb' },
    (line) => tail.push(`[palimpsest] ${line}`),
  );
  const child = getSpawner()(argv[0], argv.slice(1), {
    cwd: tmp,
    env: { ...trainerEnv(), HOME: tmp, TMPDIR: tmp },
    clearEnv: true,
  });
  const l: Live = { model, adapterId: adapter.id, port, url: `http://${LOOPBACK}:${port}`, child, inflight: 0, idle: null, exited: false, drained: [], calls: new AbortController(), tail };
  writePid(l, base);
  void (async () => {
    for await (const line of child.lines) {
      tail.push(line.line.slice(0, 500));
      if (tail.length > 20) tail.shift();
    }
  })().catch(() => undefined);
  void child.done.then(() => {
    l.exited = true;
    clearIdle(l);
    if (current === l) current = null;
    l.calls.abort(new Error('the mlx server ended'));
    forgetPid(child.pid);
    for (const r of l.drained.splice(0)) r();
  });
  try {
    await waitReady(l);
    if (!(await ownsPort(l))) throw new Error(`port ${port} answered, but not from the mlx server the engine started`);
  } catch (err) {
    await stopLive(l, false);
    throw err;
  }
  return l;
}

/** Thrown when a graduate is asked for while a heavy train holds the machine: the model is unavailable, not broken. */
export class GraduatesDown extends Error {
  readonly unavailable = true;
  constructor(what: string) {
    super(`The school's graduates are not served while ${what} runs`);
    this.name = 'GraduatesDown';
  }
}

/** The reason a graduate is refused while the school is off. */
export const SCHOOL_OFF = 'the school is off';

/** Thrown when a graduate is asked for while the school is off: the model is unavailable, not broken. */
export class SchoolOff extends Error {
  readonly unavailable = true;
  constructor() {
    super(SCHOOL_OFF);
    this.name = 'SchoolOff';
  }
}

/** The heavy trains holding the machine now, oldest first. */
const heavy: string[] = [];

/** What heavy train keeps the graduates down now, or null. */
export function heavyRunning(): string | null {
  return heavy[0] ?? null;
}

/**
 * A heavy train takes the machine (an arena build, a voyage, a LoRA): from
 * now no server starts, the running one lets its calls in flight finish
 * and stops, and a call for a graduate is refused (`GraduatesDown`) until
 * the returned function is called, once, as the train ends.
 */
export async function beginHeavy(what: string): Promise<() => void> {
  const entry = what;
  heavy.push(entry);
  let given = false;
  const giveBack = () => {
    if (given) return;
    given = true;
    const i = heavy.indexOf(entry);
    if (i >= 0) heavy.splice(i, 1);
  };
  try {
    await stopServer({ drain: true });
  } catch (err) {
    giveBack();
    throw err;
  }
  return giveBack;
}

/** The server for `model`, running and counted as in use: the caller must `release` it. */
function acquire(model: ModelRef, signal?: AbortSignal): Promise<Live> {
  return serialized(async () => {
    signal?.throwIfAborted();
    if (!getSettings().school.enabled) throw new SchoolOff();
    if (heavy.length) throw new GraduatesDown(heavy[0]);
    const adapter = await adapterFor(model);
    let l = current && !current.exited ? current : null;
    if (l && (l.model !== model || l.adapterId !== adapter.id)) {
      await stopLive(l, true);
      l = null;
    }
    if (!l) {
      l = await start(model, adapter);
      current = l;
    }
    clearIdle(l);
    l.inflight++;
    return l;
  });
}

function release(l: Live): void {
  l.inflight = Math.max(0, l.inflight - 1);
  if (l.inflight > 0) return;
  for (const r of l.drained.splice(0)) r();
  if (l.exited || current !== l) return;
  clearIdle(l);
  l.idle = timers.set(() => {
    void serialized(async () => {
      if (current === l && l.inflight === 0) await stopLive(l, false);
    });
  }, MLX_IDLE_MS);
}

/**
 * Starts the server for `model` (ruling 26) unless it is already the one
 * running; stops another graduate's server first. Resolves once the server
 * answers, with its idle timer armed.
 */
export async function ensureServer(model: ModelRef, signal?: AbortSignal): Promise<MlxServer> {
  const l = await acquire(model, signal);
  release(l);
  return view(l);
}

/**
 * Stops the running server, if any. With `drain`, its calls in flight end
 * first (before a heavy train takes the machine); without, they end with an
 * error at once (the school turned off, the engine stopping).
 */
export function stopServer(o: { drain?: boolean } = {}): Promise<void> {
  return serialized(async () => {
    if (current) await stopLive(current, o.drain === true);
  });
}

async function withServer<T>(model: ModelRef, signal: AbortSignal, fn: (url: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  const l = await acquire(model, signal);
  try {
    return await fn(l.url, AbortSignal.any([signal, l.calls.signal]));
  } finally {
    release(l);
  }
}

/* ------------------------------------------------------------------ */
/* The transport                                                       */
/* ------------------------------------------------------------------ */

interface OpenAIToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAIReply {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: unknown;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        // a graduate reads text alone: screenshots are never sent
        return { role: 'user', content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) } })) }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.callId, name: m.name, content: m.content };
    }
  });
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function post(url: string, body: object, signal: AbortSignal): Promise<OpenAIReply> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('the mlx server answered with too much');
  if (!res.ok) throw new Error(`the mlx server answered ${res.status}: ${text.slice(0, 500)}`);
  const reply = JSON.parse(text) as OpenAIReply;
  if (reply.error !== undefined) throw new Error(`mlx: ${JSON.stringify(reply.error).slice(0, 500)}`);
  return reply;
}

/** Arguments as the model gave them: parsed JSON when they parse, else the raw text for the loop to refuse. */
function args(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const TOOL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** The reply's text and its tool calls: the server's parsed calls, else Qwen's `<tool_call>` tags read out of the text. */
export function readReply(reply: OpenAIReply): { text: string; calls: ToolCall[] } {
  const message = reply.choices?.[0]?.message;
  let text = typeof message?.content === 'string' ? message.content : '';
  const calls: ToolCall[] = [];
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    message.tool_calls.forEach((c: OpenAIToolCall, n: number) => {
      calls.push({ id: typeof c?.id === 'string' && c.id ? c.id : `call_${n}`, name: String(c?.function?.name ?? ''), arguments: args(c?.function?.arguments) });
    });
    return { text, calls };
  }
  let n = 0;
  text = text.replace(TOOL_TAG, (whole, inner: string) => {
    try {
      const v = JSON.parse(inner) as { name?: unknown; arguments?: unknown };
      if (!v || typeof v !== 'object' || typeof v.name !== 'string') return whole;
      calls.push({ id: `call_${n++}`, name: v.name, arguments: args(v.arguments) });
      return '';
    } catch {
      return whole;
    }
  });
  return { text: calls.length ? text.trim() : text, calls };
}

/** The transport the tool loop talks through: one unstreamed chat completion per turn, with the tools. */
export function mlxTransport(model: ModelRef): ChatTransport {
  return {
    async *chat(messages, tools, signal): AsyncGenerator<ChatChunk> {
      const started = Date.now();
      let reply: OpenAIReply;
      try {
        reply = await withServer(model, signal, (url, sig) =>
          post(url, { messages: toOpenAIMessages(messages), ...(tools.length ? { tools: toOpenAITools(tools) } : {}), stream: false, max_tokens: MLX_MAX_TOKENS }, sig),
        );
      } catch (err) {
        // the machine was busy until the call failed: its seconds are charged
        yield { type: 'usage', usage: { seconds: (Date.now() - started) / 1000 } };
        throw err;
      }
      const { text, calls } = readReply(reply);
      if (text) yield { type: 'text', text };
      for (const call of calls) yield { type: 'tool_call', call };
      yield { type: 'usage', usage: { input: num(reply.usage?.prompt_tokens), output: num(reply.usage?.completion_tokens), seconds: (Date.now() - started) / 1000 } };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

function usageOf(seconds: number): Usage {
  return { weightedTokens: 0, seconds: Math.round(seconds * 1000) / 1000, usd: 0, credits: Math.round(localCredits(seconds, MLX_GB) * 1e6) / 1e6 };
}

/** One call with no tools: the reply's text and its seconds, stopped by the signal or after `maxMs`; a failure carries its seconds. */
async function once(model: ModelRef, messages: ChatMessage[], signal: AbortSignal, maxMs: number): Promise<{ text: string; usage: Usage }> {
  signal.throwIfAborted();
  const started = Date.now();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error('the mlx call ran out of time')), Math.max(1, Math.min(maxMs, CALL_MAX_MS)));
  try {
    const reply = await withServer(model, ctl.signal, (url, sig) => post(url, { messages: toOpenAIMessages(messages), stream: false, max_tokens: MLX_MAX_TOKENS }, sig));
    return { text: readReply(reply).text, usage: usageOf((Date.now() - started) / 1000) };
  } catch (err) {
    throw withSpent(err instanceof Error ? err : new Error(String(err)), usageOf((Date.now() - started) / 1000));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function mlxRef(model: string): ModelRef {
  if (!/^mlx:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) throw new Error(`bad mlx model name ${JSON.stringify(model.slice(0, 80))}`);
  return model as ModelRef;
}

export function mlxProvider(): Provider {
  return {
    kind: 'mlx',

    /** One turn for the school: the schema asked for in words and read back; the caller charges the usage. */
    async complete(i: CompleteInput): Promise<CompleteResult> {
      const model = mlxRef(i.model);
      const turns = i.turns.map((t, n) => ({
        role: t.role,
        content: n === i.turns.length - 1 && i.schema ? `${t.content}\n\nAnswer only with a JSON object matching this JSON schema: ${JSON.stringify(i.schema)}` : t.content,
      }));
      const messages: ChatMessage[] = [
        { role: 'system', content: i.system },
        ...turns.map((t): ChatMessage => (t.role === 'user' ? { role: 'user', content: t.content } : { role: 'assistant', content: t.content, toolCalls: [] })),
      ];
      const out = await once(model, messages, i.signal, i.maxMs);
      return { text: out.text, json: i.schema ? parseAnswer(out.text) : null, usage: out.usage };
    },

    async work(i) {
      let model: ModelRef;
      try {
        model = mlxRef(i.agent.model);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        i.log({ at: new Date().toISOString(), kind: 'engine', text: `mlx run crashed: ${reason}` });
        return { summary: '', usage: usageOf(0), ended: 'crashed', reason };
      }
      // the school is off: no graduate is served, so the job goes back to the board unspent
      if (!getSettings().school.enabled) {
        i.log({ at: new Date().toISOString(), kind: 'engine', text: SCHOOL_OFF });
        return { summary: '', usage: usageOf(0), ended: 'crashed', reason: SCHOOL_OFF, spendsAttempt: false };
      }
      // a heavy train holds the machine: the model is unavailable, so the job goes back to the board unspent
      const down = heavyRunning();
      if (down) {
        const reason = new GraduatesDown(down).message;
        i.log({ at: new Date().toISOString(), kind: 'engine', text: reason });
        return { summary: '', usage: usageOf(0), ended: 'crashed', reason, spendsAttempt: false };
      }
      let refused: string | null = null;
      const inner = mlxTransport(model);
      const transport: ChatTransport = {
        async *chat(messages, tools, signal) {
          try {
            yield* inner.chat(messages, tools, signal);
          } catch (err) {
            if (err instanceof GraduatesDown) refused = err.message;
            throw err;
          }
        },
      };
      const r = await runToolLoop(transport, i, {
        maxTurns: i.caps.maxTurns,
        maxMs: i.caps.maxMinutes * 60_000,
        creditsFor: (u) => localCredits(u.seconds, MLX_GB),
      });
      // a train took the machine between turns: unavailable, not the agent's failure
      if (refused !== null && r.ended === 'crashed') return { ...r, reason: refused, spendsAttempt: false as const };
      // the school was turned off mid-run, its server stopped under the call: unavailable too, the firm's attempt kept
      if (r.ended === 'crashed' && !getSettings().school.enabled) return { ...r, reason: SCHOOL_OFF, spendsAttempt: false as const };
      return r;
    },

    /** The README audit on a graduate: the local audit's tools, caps and result size, as on Ollama. */
    async audit(i: AuditInput): Promise<AuditResult> {
      let model: ModelRef;
      try {
        model = mlxRef(i.model);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        i.log({ at: new Date().toISOString(), kind: 'engine', text: `mlx audit crashed: ${reason}` });
        return { answer: null, text: '', usage: usageOf(0), ended: 'crashed', reason };
      }
      const commands = checkCommands(i.checks);
      const r = await runLoop({
        transport: mlxTransport(model),
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
        creditsFor: (u) => localCredits(u.seconds, MLX_GB),
        log: i.log,
        onProgress: i.onProgress,
        signal: i.signal,
        caps: i.caps,
      });
      return { answer: r.answer, text: r.summary, usage: r.usage, ended: r.ended, reason: r.reason };
    },

    async plan(i: PlanInput, signal) {
      const model = mlxRef(i.agent.model);
      const out = await once(model, [{ role: 'system', content: systemPrompt(i.persona, i.agent.instructions) }, { role: 'user', content: `${planPrompt(i)}\n${PLAN_JSON}\n` }], signal, CALL_MAX_MS);
      return { ...planAnswer(parseAnswer(out.text), 'mlx'), usage: out.usage };
    },

    async review(i: ReviewInput, signal) {
      const model = mlxRef(i.agent.model);
      const out = await once(model, [{ role: 'system', content: systemPrompt(i.persona, i.agent.instructions) }, { role: 'user', content: `${reviewPrompt(i)}\n${REVIEW_JSON}\n` }], signal, CALL_MAX_MS);
      return { ...reviewAnswer(parseAnswer(out.text), 'mlx'), usage: out.usage };
    },

    /**
     * Refused: the design judges are fixed models (the vision judge and the
     * text judge, never an `mlx:` one), a judge's input names no graduate to
     * serve, and a graduate cannot see the screenshots it would score.
     */
    async judge(_i: JudgeInput, _signal) {
      throw new Error('mlx judge: a graduate is never a design judge (it cannot see screenshots, and the judge input names no graduate)');
    },
  };
}
