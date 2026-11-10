/**
 * The command broker (ruling 19). No agent gets a shell inside a process
 * that can read his login: the claude CLI reaches commands only through the
 * `mcp__palimpsest__run` MCP tool (broker-mcp.mjs), which forwards each call
 * over loopback with a per-run bearer token to startBroker(); the Ollama and
 * Anthropic tool loops call execTool() and execFileTool() directly. Every
 * command passes forbidden() and then runs under the tool profile with an
 * environment built from nothing, in the run's own directory, which always
 * comes from the run context and never from the request.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSpawner, type Spawned } from '../exec.js';
import { home as dataHomeDir, paths } from '../home.js';
import { record } from '../ledger.js';
import { forbidden } from './guard.js';
import type { RunLogLine } from './provider.js';
import { noteLiveGroup, reapRun } from './reaper.js';
import { childEnv, detectToolchains, realish, registerRunPorts, unregisterRunPorts, wrap, type ProfileInput } from './sandbox.js';

/** The longest a single agent command may run. A request above it is cut to it. */
export const MAX_TOOL_MS = 15 * 60_000;
/** The shortest timeout a command gets. */
export const MIN_TOOL_MS = 1_000;
/** What a command run through the broker gets when the request names no timeout. */
export const DEFAULT_TOOL_MS = 2 * 60_000;
/** Output returned to the caller, per stream. */
export const MAX_RETURN_BYTES = 64 * 1024;
/** Output spooled to the run log per run; past it, each call logs only its first and last SPOOL_EDGE_BYTES. */
export const MAX_SPOOL_BYTES = 20 * 1024 * 1024;
export const SPOOL_EDGE_BYTES = 4 * 1024;
export { protectPids, reapRun, runQuiet } from './reaper.js';

/** Concurrent broker calls per run; more get 429. */
export const MAX_CONCURRENT_CALLS = 4;
/** The file tool's own cap. */
const FILE_TOOL_MS = 60_000;
const MAX_FILE_TOOL_STDOUT = 2 * 1024 * 1024;
const MAX_COMMAND_CHARS = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

export type ToolStage = 'working' | 'install' | 'checks';

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  refused: string | null;
}

export interface ExecToolInput {
  runId: string;
  runRoot: string;
  dir: string;
  command: string;
  timeoutMs: number;
  stage: ToolStage;
  signal: AbortSignal;
  log: (line: RunLogLine) => void;
}

export type FileOp = 'read' | 'write' | 'edit' | 'list' | 'search';

export interface ExecFileToolInput {
  runId: string;
  runRoot: string;
  dir: string;
  op: FileOp;
  args: Record<string, unknown>;
  signal: AbortSignal;
  log: (line: RunLogLine) => void;
  stage?: ToolStage;
}

/* ------------------------------------------------------------------ */
/* Control scripts                                                     */
/* ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));
/** The plain JS files the sandboxed processes run. */
export const CONTROL_SCRIPTS = ['guard-core.mjs', 'guard-hook.mjs', 'file-tool.mjs', 'broker-mcp.mjs'] as const;

/**
 * Copies the control scripts into `<runRoot>/ctl/bin` (read-only), because
 * both profiles deny reads of his home, where this repository lives. The
 * hook, the MCP server and the file tool are always run from there.
 */
export function installControlScripts(runRoot: string): Record<(typeof CONTROL_SCRIPTS)[number], string> {
  const bin = join(runRoot, 'ctl', 'bin');
  mkdirSync(bin, { recursive: true });
  const out = {} as Record<(typeof CONTROL_SCRIPTS)[number], string>;
  for (const name of CONTROL_SCRIPTS) {
    const src = readFileSync(join(HERE, name), 'utf8');
    const dest = join(bin, name);
    let same = false;
    try {
      same = readFileSync(dest, 'utf8') === src;
    } catch {
      same = false;
    }
    if (!same) {
      try {
        unlinkSync(dest);
      } catch {
        // not there yet
      }
      writeFileSync(dest, src, { mode: 0o444 });
      chmodSync(dest, 0o444);
    }
    out[name] = dest;
  }
  return out;
}

/**
 * How the claude CLI starts the run tool's MCP server (for the run's
 * mcp.json, Task 9): node with the server script and the two control file
 * paths. The token is read from its file; it is on no argv.
 */
export function brokerMcpServer(runRoot: string): { command: string; args: string[] } {
  const scripts = installControlScripts(runRoot);
  return { command: process.execPath, args: [scripts['broker-mcp.mjs'], join(runRoot, 'ctl', 'broker.json'), join(runRoot, 'ctl', 'broker.token')] };
}

/** How the claude CLI runs the PreToolUse hook (for the run's settings.json, Task 9). */
export function guardHookCommand(runRoot: string, dir: string): string[] {
  const scripts = installControlScripts(runRoot);
  return [process.execPath, scripts['guard-hook.mjs'], dir, dataHomeDir()];
}

/* ------------------------------------------------------------------ */
/* Spool                                                               */
/* ------------------------------------------------------------------ */

const spool = new Map<string, number>();

/** Bytes of command output a run has spooled to its log. */
export function spoolUsed(runId: string): number {
  return spool.get(runId) ?? 0;
}

/** Tests only: pretends a run has already spooled `bytes`. */
export function setSpoolUsedForTests(runId: string, bytes: number): void {
  spool.set(runId, bytes);
}

/** Forgets a run's spool count when the run ends. */
export function forgetRun(runId: string): void {
  spool.delete(runId);
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

function now(): string {
  return new Date().toISOString();
}

/** The engine's API port (PALIMPSEST_PORT, default 4770): denied to every sandboxed child. */
export function enginePort(): number {
  const raw = process.env.PALIMPSEST_PORT;
  const n = Number(raw);
  return raw && /^\d+$/.test(raw) && n >= 1 && n <= 65535 ? n : 4770;
}

function egressPort(runRoot: string): number {
  try {
    const port = (JSON.parse(readFileSync(join(runRoot, 'ctl', 'egress.json'), 'utf8')) as { port: unknown }).port;
    if (typeof port === 'number' && Number.isInteger(port)) return port;
  } catch {
    // no proxy yet: a closed port, so nothing leaks
  }
  return 9;
}

/** The tool profile's input for a run, from the run context alone. */
function profileFor(runRoot: string): ProfileInput {
  return {
    runRoot,
    home: homedir(),
    dataHome: dataHomeDir(),
    enginePort: enginePort(),
    proxyPort: egressPort(runRoot),
    toolchains: detectToolchains(),
  };
}

/**
 * Checks the run context: the run root is a directory under the data
 * home's runs, and `dir` is one of its clones. Returns a reason or null.
 */
function contextProblem(runRoot: string, dir: string): string | null {
  const runs = realish(paths().runs);
  const root = realish(runRoot);
  if (dirname(root).toLowerCase() !== runs.toLowerCase()) return 'the run context is not a run root';
  const d = realish(dir);
  if (dirname(d) !== root || !['repo', 'ship', 'base'].includes(basename(d))) return 'the run context names no clone of this run';
  if (!existsSync(d)) return 'the run directory does not exist';
  return null;
}

function clampTimeout(requested: number, log: (l: RunLogLine) => void): number {
  if (!Number.isFinite(requested)) {
    log({ at: now(), kind: 'engine', text: `timeoutMs ${String(requested)} is not a number; cut to ${MAX_TOOL_MS} ms` });
    return MAX_TOOL_MS;
  }
  if (requested > MAX_TOOL_MS) {
    log({ at: now(), kind: 'engine', text: `timeoutMs ${requested} cut to ${MAX_TOOL_MS} ms (the cap)` });
    return MAX_TOOL_MS;
  }
  return Math.max(MIN_TOOL_MS, Math.floor(requested));
}

function refuse(o: { runId: string; stage?: string; log: (l: RunLogLine) => void }, what: string, reason: string): ToolResult {
  o.log({ at: now(), kind: 'refused', text: `refused: ${reason}`, data: { what: what.slice(0, 2000), reason } });
  record('run.refused', { runId: o.runId, stage: o.stage ?? null, what: what.slice(0, 2000), reason });
  return { code: null, stdout: '', stderr: '', refused: reason };
}

/** Keeps the first `cap` bytes of a stream for the caller and counts the rest. */
class Capped {
  text = '';
  bytes = 0;
  dropped = 0;
  constructor(private cap: number) {}
  add(line: string) {
    const piece = line + '\n';
    const n = Buffer.byteLength(piece);
    if (this.bytes + n <= this.cap) {
      this.text += piece;
      this.bytes += n;
    } else this.dropped += n;
  }
  value(): string {
    return this.dropped ? `${this.text}[palimpsest] output truncated: ${this.dropped} more bytes not shown\n` : this.text;
  }
}

/**
 * Spools a call's output to the run log while the run's spool is under
 * MAX_SPOOL_BYTES, and after that only the call's first and last
 * SPOOL_EDGE_BYTES with a line saying how much was dropped.
 */
class Spooler {
  /** Bytes this call has logged as it streamed. */
  private head = 0;
  private tail: Array<{ stream: string; line: string; n: number }> = [];
  private tailBytes = 0;
  private dropped = 0;
  constructor(private runId: string, private log: (l: RunLogLine) => void) {}
  add(stream: string, line: string) {
    const n = Buffer.byteLength(line) + 1;
    const used = spoolUsed(this.runId);
    // Bytes are reserved in the run's count line by line, so concurrent calls cannot overrun the cap together.
    if (used + n <= MAX_SPOOL_BYTES || this.head + n <= SPOOL_EDGE_BYTES) {
      spool.set(this.runId, used + n);
      this.head += n;
      this.log({ at: now(), kind: 'tool', text: line, data: { stream } });
      return;
    }
    this.tail.push({ stream, line, n });
    this.tailBytes += n;
    while (this.tailBytes > SPOOL_EDGE_BYTES && this.tail.length) {
      const first = this.tail.shift()!;
      this.tailBytes -= first.n;
      this.dropped += first.n;
    }
  }
  end() {
    if (this.dropped) {
      this.log({ at: now(), kind: 'engine', text: `[palimpsest] ${this.dropped} bytes of output dropped from the run log (the run's ${MAX_SPOOL_BYTES} byte spool is full)` });
    }
    for (const t of this.tail) this.log({ at: now(), kind: 'tool', text: t.line, data: { stream: t.stream } });
    spool.set(this.runId, spoolUsed(this.runId) + this.tailBytes);
  }
}

/** Runs argv under the tool profile with the child environment and collects its output. */
async function runSandboxed(
  o: { runId: string; runRoot: string; dir: string; signal: AbortSignal; log: (l: RunLogLine) => void },
  argv: string[],
  maxMs: number,
  stdin: string | undefined,
  outCap: number,
  spoolIt: boolean,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  const wrapped = wrap(argv, 'tool', profileFor(o.runRoot), (l) => o.log({ at: now(), kind: 'engine', text: l }));
  if (o.signal.aborted) return { code: null, stdout: '', stderr: 'aborted before the command ran\n', timedOut: false, aborted: true };
  const child: Spawned = getSpawner()(wrapped[0], wrapped.slice(1), {
    cwd: o.dir,
    env: childEnv(o.runRoot),
    clearEnv: true,
    maxMs,
    ...(stdin === undefined ? {} : { stdin }),
  });
  noteLiveGroup(o.runRoot, child.pid, true);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill('SIGTERM');
  };
  o.signal.addEventListener('abort', onAbort, { once: true });
  const out = new Capped(outCap);
  const err = new Capped(MAX_RETURN_BYTES);
  const spooler = spoolIt ? new Spooler(o.runId, o.log) : null;
  try {
    for await (const l of child.lines) {
      (l.stream === 'stdout' ? out : err).add(l.line);
      spooler?.add(l.stream, l.line);
    }
    const done = await child.done;
    let stderr = err.value();
    if (done.error) stderr += `[palimpsest] the command could not start: ${done.error}\n`;
    if (done.timedOut) stderr += `[palimpsest] timed out after ${maxMs} ms\n`;
    if (aborted) stderr += '[palimpsest] aborted\n';
    return { code: done.code, stdout: out.value(), stderr, timedOut: !!done.timedOut, aborted };
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    spooler?.end();
    child.kill('SIGTERM');
    noteLiveGroup(o.runRoot, child.pid, false);
    // Whatever the command left behind (a forked, setsid daemon) is killed before the result returns.
    const reaped = await reapRun(o.runRoot);
    if (reaped.length) o.log({ at: now(), kind: 'engine', text: `[palimpsest] killed ${reaped.length} process(es) the command left running: ${reaped.join(', ')}` });
  }
}

/**
 * Runs one agent command: clamps the timeout, refuses through forbidden()
 * (recording `run.refused`, running nothing), else runs `/bin/sh -c` under
 * the tool profile in `dir` with an environment built from nothing.
 */
export async function execTool(o: ExecToolInput): Promise<ToolResult> {
  const timeoutMs = clampTimeout(o.timeoutMs, o.log);
  if (typeof o.command !== 'string' || o.command.length > MAX_COMMAND_CHARS) return refuse(o, String(o.command).slice(0, 200), 'The command is too long or not text.');
  const ctx = contextProblem(o.runRoot, o.dir);
  if (ctx) return refuse(o, o.command, ctx);
  const reason = forbidden(o.command, o.dir, dataHomeDir());
  if (reason) return refuse(o, o.command, reason);

  o.log({ at: now(), kind: 'tool', text: `$ ${o.command}`, data: { stage: o.stage, timeoutMs } });
  const r = await runSandboxed(o, ['/bin/sh', '-c', o.command], timeoutMs, undefined, MAX_RETURN_BYTES, true);
  return { code: r.aborted && r.code === 0 ? null : r.code, stdout: r.stdout, stderr: r.stderr, refused: null };
}

/**
 * Runs one file tool call (ruling 29) through file-tool.mjs under the tool
 * profile, like any command. A refusal by the file tool's own guard is
 * recorded like a command refusal. `result` is the tool's parsed JSON.
 */
export async function execFileTool(o: ExecFileToolInput): Promise<ToolResult & { result: unknown }> {
  const what = `file-tool ${String(o.op)} ${JSON.stringify(o.args).slice(0, 300)}`;
  if (!['read', 'write', 'edit', 'list', 'search'].includes(o.op)) return { ...refuse(o, what, 'unknown file operation'), result: null };
  const ctx = contextProblem(o.runRoot, o.dir);
  if (ctx) return { ...refuse(o, what, ctx), result: null };
  const scripts = installControlScripts(o.runRoot);
  o.log({ at: now(), kind: 'tool', text: `file ${o.op} ${typeof o.args.path === 'string' ? o.args.path : ''}`.trim() });
  const r = await runSandboxed(o, [process.execPath, scripts['file-tool.mjs'], o.dir, o.op, '-'], FILE_TOOL_MS, JSON.stringify(o.args), MAX_FILE_TOOL_STDOUT, false);
  let result: unknown = null;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    result = null;
  }
  const refusedReason = result && typeof result === 'object' && typeof (result as { refused?: unknown }).refused === 'string' ? (result as { refused: string }).refused : null;
  if (refusedReason) {
    refuse(o, what, refusedReason);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, refused: refusedReason, result };
  }
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, refused: null, result };
}

/* ------------------------------------------------------------------ */
/* The loopback broker                                                 */
/* ------------------------------------------------------------------ */

export interface BrokerContext {
  runRoot: string;
  dir: string;
  log: (line: RunLogLine) => void;
  signal: AbortSignal;
  /** The run's current stage (default `working`). */
  stage?: () => ToolStage;
}

export interface Broker {
  port: number;
  close(): Promise<void>;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = header.match(/^Bearer\s+(\S+)$/);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Starts the run's broker on 127.0.0.1:0. Writes a fresh token to
 * `<ctl>/broker.token` (mode 0400) and the port to `<ctl>/broker.json`,
 * registers the port so profiles written for other runs deny it, and
 * answers `POST /run { command, timeoutMs }` carrying this run's bearer
 * token with execTool()'s result. Anything else gets 401, 404 or 400.
 */
export async function startBroker(runId: string, ctx: BrokerContext): Promise<Broker> {
  const ctl = join(ctx.runRoot, 'ctl');
  mkdirSync(ctl, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const tokenPath = join(ctl, 'broker.token');
  try {
    unlinkSync(tokenPath);
  } catch {
    // first start
  }
  writeFileSync(tokenPath, token, { mode: 0o400 });
  chmodSync(tokenPath, 0o400);
  installControlScripts(ctx.runRoot);

  const note = (text: string) => ctx.log({ at: now(), kind: 'refused', text: `broker: ${text}` });
  let inFlight = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin !== undefined) {
      note('request from a web page refused');
      send(res, 403, { error: 'forbidden' });
      req.resume();
      return;
    }
    if (!bearerOk(req.headers.authorization, token)) {
      note(`request without this run's token refused (${req.method} ${req.url})`);
      send(res, 401, { error: 'unauthorized' });
      req.resume();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') {
      send(res, 404, { error: 'not found' });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        send(res, 413, { error: 'request too large' });
        return;
      }
      let body: { command?: unknown; timeoutMs?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(res, 400, { error: 'bad json' });
        return;
      }
      if (typeof body !== 'object' || body === null || typeof body.command !== 'string') {
        send(res, 400, { error: 'command must be a string' });
        return;
      }
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : DEFAULT_TOOL_MS;
      if (inFlight >= MAX_CONCURRENT_CALLS) {
        note(`more than ${MAX_CONCURRENT_CALLS} commands at once refused`);
        send(res, 429, { error: `at most ${MAX_CONCURRENT_CALLS} commands run at once` });
        return;
      }
      inFlight += 1;
      execTool({
        runId,
        runRoot: ctx.runRoot,
        dir: ctx.dir,
        command: body.command,
        timeoutMs,
        stage: ctx.stage?.() ?? 'working',
        signal: ctx.signal,
        log: ctx.log,
      })
        .then(
          (r) => send(res, 200, r),
          (err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          inFlight -= 1;
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  writeFileSync(join(ctl, 'broker.json'), JSON.stringify({ port }) + '\n');
  registerRunPorts(runId, [port]);

  return {
    port,
    async close() {
      unregisterRunPorts(runId, [port]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(tokenPath);
      } catch {
        // already gone
      }
    },
  };
}
