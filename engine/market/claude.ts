/**
 * The claude -p backend (Task 9): agent firms work through his own
 * installed, unmodified `claude` CLI on his own login, never API dollars.
 *
 * This module never reads `~/.claude/.credentials.json`, the keychain or
 * any token, and never passes one on. The CLI finds his login itself (it
 * runs `/usr/bin/security`, which the CLI profile allows for that reason).
 * Every child starts from an empty environment (`clearEnv`), so
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 * `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` never reach it, and
 * a call ends unless `system/init` reports `apiKeySource: "none"`.
 *
 * - work(): in the run dir, under the run's CLI profile, with the file tools
 *   and one MCP tool (`mcp__palimpsest__run`, the broker). No Bash: every
 *   command goes through the broker (ruling 19). A PreToolUse hook checks
 *   every file tool and the run tool; `--disallowedTools` and
 *   `permissions.deny` are a second layer should the hook not start.
 * - audit(): the same session over an audit's clone (Phase 3 ruling 13),
 *   with the read tools alone (`Read`, `Glob`, `Grep` and the run tool), the
 *   write tools disallowed, denied and refused by the hook (`--read-only`),
 *   the surveyor's persona as the system prompt, the audit prompt on stdin
 *   and `--json-schema` for the answer. Both run through `drive()`.
 * - plan(), review(), judge(): no tools at all, an empty strict MCP config,
 *   in a scratch root of their own (`<home>/runs/call-<id>`) with their own
 *   egress proxy and CLI profile, removed when the call ends. Nothing of the
 *   repo is on disk; the job, diff and persona go in on stdin and the system
 *   prompt.
 *
 * `--bare` is never used: it reads only `ANTHROPIC_API_KEY` and skips hooks.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { claudeCredits, DEFAULT_TOKENS_PER_PCT, weightedTokens } from '../../shared/credits.js';
import type { RunProgress } from '../../shared/types.js';
import { getSpawner, type Spawned } from '../exec.js';
import { home as dataHomeDir, paths } from '../home.js';
import { storedCalibration } from '../usage.js';
import { brokerMcpServer, enginePort, guardHookCommand, protectPids, reapRun, runQuiet } from './broker.js';
import { CLAUDE_HOSTS, isAnthropicHost, refusedHosts, startEgress } from './egress.js';
import { record } from '../ledger.js';
import { CLI_DISALLOWED_TOOLS, CLI_PERMISSIONS_DENY } from './guard.js';
import { AUDIT_PERSONA, AUDIT_SCHEMA, AUDIT_TOOLS, auditPrompt } from '../audit/schema.js';
import type { AuditInput, AuditResult, JudgeInput, PlanInput, Provider, ReviewInput, RunLogLine, Usage, WorkInput } from './provider.js';
import { CLAUDE_TMP, detectToolchains, proxyUrl, realish, SYSTEM_PATH, wrap, type CliProfileInput } from './sandbox.js';
import { controlFiles } from './worktree.js';
import { diffSection, planSection, quoteAsData } from './quote.js';

/* ------------------------------------------------------------------ */
/* Fixed values                                                        */
/* ------------------------------------------------------------------ */

/** Claude's own file tools a work run gets (`--tools`). */
export const WORK_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;
/** The tools that write: an audit disallows and denies them, and its hook refuses them (Phase 3 ruling 3). */
export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
/** The broker's one MCP tool. */
export const RUN_TOOL = 'mcp__palimpsest__run';
/** The only MCP server a work run may list. */
export const MCP_SERVER = 'palimpsest';
/** Every tool the hook checks: each file tool claude has, and the run tool. */
export const HOOK_MATCHER = 'Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|mcp__palimpsest__run';
/** `permissions.deny` of a plan, review or judge call: there are no tools to hook. */
export const CALL_DENY = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
/**
 * Claude Code's built-in plugins (claude 2.1.319). Every settings file of a
 * city call switches each off (`enabledPlugins: { "<name>@builtin": false }`),
 * so init lists no plugins; a built-in this list misses shows up in init and
 * ends the call (`unexpected plugins`), which is the closed way to fail.
 * The Task 11 smoke run found three enabled by default: agents-md, privacy
 * and plugin-authoring.
 */
export const BUILTIN_PLUGINS: readonly string[] = [
  'cc-plugin-agents-md',
  'cc-plugin-claude-platform',
  'cc-plugin-claude-test',
  'cc-plugin-diff',
  'cc-plugin-easel',
  'cc-plugin-mermaid',
  'cc-plugin-mods-guide',
  'cc-plugin-plugin-authoring',
  'cc-plugin-privacy',
  'cc-plugin-responsive-mode',
  'cc-plugin-sec-default',
  'cc-plugin-telemetry',
  'cc-plugin-tips',
  'cc-plugin-you-should-know',
];
const PLUGINS_OFF: Record<string, false> = Object.fromEntries(BUILTIN_PLUGINS.map((n) => [`${n}@builtin`, false]));
/**
 * Claude Code's own sandbox, a fourth layer in every work run (ruling 19).
 * claude 2.1.319 starts and finishes a work run with it inside the CLI
 * profile (Task 11). It bounds only the Bash tool, which a city run never
 * has, so it is a guard against a later change rather than a wall today;
 * `failIfUnavailable` makes a CLI that cannot sandbox end the run.
 */
export const CLAUDE_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } as const;
/** The broker's tool timeout, in ms, as claude reads it (MCP_TOOL_TIMEOUT). */
export const MCP_TOOL_TIMEOUT_MS = 900_000;
/** After a SIGTERM to the group on a cap or an abort, SIGKILL follows after this. */
export const KILL_AFTER_MS = 5000;
/** Turns a plan, review or judge call may take. */
export const CALL_MAX_TURNS = 3;
/** Wall time a plan, review or judge call may take. */
export const CALL_MAX_MS = 5 * 60_000;
/** The hook's own timeout in claude's settings, in seconds (the hook stops itself at 5 s). */
const HOOK_TIMEOUT_S = 10;
/** Markers of a refusal in a tool result: the hook's and the broker's. */
const REFUSAL_MARKERS = ['Palimpsest refused this call', 'Refused by the city'];
/** Characters of a tool input or result kept in a log line. */
const LOG_CHARS = 2000;
/** Characters of a diff a reviewer is shown. */
const MAX_DIFF_CHARS = 200_000;

export interface ClaudeOptions {
  /** The claude binary. Default: `PALIMPSEST_CLAUDE_BIN`, else the first `claude` on the system path or in `~/.local/bin`. */
  claudeBin?: string;
  /**
   * `--setting-sources` value. `''` loads none of his settings. If Task 11
   * shows the CLI rejects an empty value, it becomes `local`, and a clone
   * carrying `.claude/settings.local.json` is refused.
   */
  settingSources?: '' | 'local';
  /**
   * Plan, review and judge calls pass `--max-turns 3` (default true: the
   * Task 11 smoke run found the flag in claude 2.1.319). Turns are counted
   * either way; false leaves the flag out for a CLI that lacks it.
   */
  maxTurnsFlag?: boolean;
  /**
   * Turn on Claude Code's own sandbox in a work run's settings (default
   * true, ruling 19): the Task 11 smoke run showed the CLI starts and works
   * with it inside the CLI profile. The smoke run's plain call passes false.
   */
  nestedSandbox?: boolean;
  /** Reaps the run and throws if anything of it is left (runQuiet), before claude starts and before each tool turn. */
  quiet?: (runRoot: string) => Promise<void>;
  /** Kills whatever a plan, review or judge call left under its scratch root before the root is removed. Default reapRun. */
  reap?: (root: string) => Promise<unknown>;
  /** Weighted tokens per percent of the five-hour window. Default: the stored calibration. */
  tokensPerPct?: () => number;
  /** SIGKILL delay after the SIGTERM on a cap or an abort. Default KILL_AFTER_MS. */
  killAfterMs?: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();

function clip(s: string, n = LOG_CHARS): string {
  return s.length > n ? s.slice(0, n) + ` [${s.length - n} more]` : s;
}

/** The claude binary to run. */
export function findClaude(): string {
  const fromEnv = process.env.PALIMPSEST_CLAUDE_BIN;
  if (fromEnv) return fromEnv;
  for (const dir of [...SYSTEM_PATH, join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')]) {
    const p = join(dir, 'claude');
    if (existsSync(p)) return p;
  }
  return 'claude';
}

function modelName(model: string): string {
  return model.startsWith('claude:') ? model.slice('claude:'.length) : model;
}

/** Writes a control file read-only (ctl is read-only to both profiles; only the engine writes it). */
function writeCtl(path: string, text: string): void {
  try {
    unlinkSync(path);
  } catch {
    // not there yet
  }
  writeFileSync(path, text, { mode: 0o444 });
  chmodSync(path, 0o444);
}

function readPort(path: string): number | null {
  try {
    const port = (JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** One argv as a /bin/sh command line: every word single-quoted. */
function shellLine(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * The claude child's whole environment (nothing else is inherited): his
 * real home and user name (his login lives there), the system path, the run's ctmp (as
 * TMPDIR and as claude's own CLAUDE_CODE_TMPDIR), the run's egress proxy
 * and two of claude's own switches.
 */
function claudeEnv(runRoot: string, proxyPort: number, proxyToken: string): Record<string, string> {
  const proxy = proxyUrl(proxyPort, proxyToken);
  const user = userInfo().username;
  return {
    HOME: homedir(),
    // claude names his login's keychain item by USER; without it the smoke run (Task 11) got "Not logged in"
    USER: user,
    LOGNAME: user,
    PATH: SYSTEM_PATH.join(':'),
    // claude's own temp dir, which no tool child can read or write; claude makes `claude-<uid>`
    // under CLAUDE_CODE_TMPDIR (default /tmp, outside the CLI profile; Task 11 smoke run)
    TMPDIR: join(realish(runRoot), CLAUDE_TMP) + '/',
    CLAUDE_CODE_TMPDIR: join(realish(runRoot), CLAUDE_TMP),
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

function profileInput(runRoot: string, claudeBin: string, proxyPort: number, brokerPort: number | null, workDir?: string): CliProfileInput {
  return {
    runRoot,
    home: homedir(),
    dataHome: dataHomeDir(),
    enginePort: enginePort(),
    proxyPort,
    toolchains: detectToolchains(),
    claudeBin,
    nodeBin: process.execPath,
    brokerPort,
    ...(workDir ? { workDir } : {}),
  };
}

function defaultTokensPerPct(): number {
  try {
    const v = storedCalibration().value;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TOKENS_PER_PCT;
  } catch {
    return DEFAULT_TOKENS_PER_PCT;
  }
}

/* ------------------------------------------------------------------ */
/* The stream                                                          */
/* ------------------------------------------------------------------ */

type Ended = 'finished' | 'capped' | 'aborted' | 'crashed';

interface SessionSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  runRoot: string;
  model: string;
  /** Tools init may list; anything else ends the call. */
  tools: readonly string[];
  /** MCP servers init may list. */
  mcpServers: readonly string[];
  caps: { maxTurns: number; maxMs: number; maxCredits: number };
  signal: AbortSignal;
  log: (line: RunLogLine) => void;
  onProgress?: (p: Partial<RunProgress>) => void;
  /** Run `quiet(runRoot)` before each tool turn (work only). */
  quiet?: (runRoot: string) => Promise<void>;
  tokensPerPct: number;
  killAfterMs: number;
}

interface SessionOut {
  ended: Ended;
  reason: string | null;
  usage: Usage;
  text: string;
  structured: unknown;
}

interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function sums(u: unknown): TokenSums {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0);
  return { input: n('input_tokens'), output: n('output_tokens'), cacheRead: n('cache_read_input_tokens'), cacheCreation: n('cache_creation_input_tokens') };
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : JSON.stringify(x)));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  return '';
}

/**
 * Runs one claude call to its end and reads its stream-json: checks
 * `system/init`, counts turns, tool calls and refusals, watches the caps
 * and the signal, and returns how it ended with its usage.
 */
async function session(s: SessionSpec): Promise<SessionOut> {
  const started = Date.now();
  const running: TokenSums = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const seenMessages = new Set<string>();
  const files = new Set<string>();
  /** Write and Edit calls by tool_use id, counted as changed files once their result comes back without an error. */
  const pendingWrites = new Map<string, string>();
  const progress: RunProgress = { toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 };
  let model = s.model;
  let initSeen = false;
  let resultLine: Record<string, unknown> | null = null;
  let stopped: { ended: Ended; reason: string } | null = null;
  let quietChain: Promise<void> = Promise.resolve();
  const timers: NodeJS.Timeout[] = [];
  const log = (kind: RunLogLine['kind'], text: string, data?: unknown) => s.log({ at: now(), kind, text, ...(data === undefined ? {} : { data }) });

  if (s.signal.aborted) {
    return { ended: 'aborted', reason: 'signal', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, text: '', structured: null };
  }

  let child: Spawned;
  try {
    child = getSpawner()(s.argv[0], s.argv.slice(1), { cwd: s.cwd, env: s.env, stdin: s.stdin, clearEnv: true });
  } catch (err) {
    const reason = `claude did not start: ${err instanceof Error ? err.message : String(err)}`;
    log('engine', reason);
    return { ended: 'crashed', reason, usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, text: '', structured: null };
  }
  if (child.pid !== null) protectPids(s.runRoot, [child.pid]);

  const stop = (ended: Ended, reason: string) => {
    if (stopped) return;
    stopped = { ended, reason };
    child.kill('SIGTERM');
    timers.push(setTimeout(() => child.kill('SIGKILL'), s.killAfterMs));
    try {
      log('engine', `${ended}: ${reason}`);
    } catch {
      // stop runs from timers and the abort listener too: a failing log must not stop the kill
    }
  };
  const onAbort = () => stop('aborted', 'signal');
  try {
    s.signal.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => stop('capped', `time cap of ${Math.round(s.caps.maxMs / 60_000)} minutes`), s.caps.maxMs));

    const tick = () => {
      progress.weightedTokens = weightedTokens(running, model);
      progress.credits = claudeCredits(progress.weightedTokens, s.tokensPerPct);
      s.onProgress?.({ ...progress });
    };

    const onInit = (e: Record<string, unknown>) => {
      initSeen = true;
      if (typeof e.model === 'string') model = e.model;
      const tools = names(e.tools);
      const servers = names(e.mcp_servers);
      const plugins = names(e.plugins);
      log('system', `init: model ${String(e.model)}, apiKeySource ${String(e.apiKeySource)}, tools ${tools.join(', ') || 'none'}, mcp ${servers.join(', ') || 'none'}, plugins ${plugins.join(', ') || 'none'}`, {
        model: e.model,
        apiKeySource: e.apiKeySource,
        tools,
        mcp_servers: e.mcp_servers,
        plugins: e.plugins,
      });
      if (e.apiKeySource !== 'none') return stop('crashed', 'claude would bill an API key');
      // An init that does not list its tools and MCP servers cannot be checked, so it fails.
      if (!Array.isArray(e.tools) || !Array.isArray(e.mcp_servers)) return stop('crashed', 'unexpected tools');
      if (tools.some((t) => !s.tools.includes(t)) || servers.some((m) => !s.mcpServers.includes(m))) return stop('crashed', 'unexpected tools');
      if (plugins.length) return stop('crashed', 'unexpected plugins');
    };

    const onAssistant = (e: Record<string, unknown>) => {
      const msg = (e.message && typeof e.message === 'object' ? e.message : {}) as Record<string, unknown>;
      const id = typeof msg.id === 'string' ? msg.id : `anon-${seenMessages.size}`;
      const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
      if (!seenMessages.has(id)) {
        seenMessages.add(id);
        progress.turns += 1;
        const u = sums(msg.usage);
        running.input += u.input;
        running.output += u.output;
        running.cacheRead += u.cacheRead;
        running.cacheCreation += u.cacheCreation;
      }
      let usedTool = false;
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') log('assistant', clip(block.text));
        if (block?.type === 'tool_use') {
          usedTool = true;
          progress.toolCalls += 1;
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          if ((block.name === 'Write' || block.name === 'Edit' || block.name === 'MultiEdit') && typeof input.file_path === 'string' && typeof block.id === 'string') {
            pendingWrites.set(block.id, input.file_path);
          }
          log('tool', clip(`${String(block.name)} ${JSON.stringify(input)}`), { id: block.id, name: block.name });
        }
      }
      tick();
      if (progress.turns > s.caps.maxTurns) return stop('capped', `turn cap of ${s.caps.maxTurns}`);
      if (progress.credits > s.caps.maxCredits) return stop('capped', `credit cap of ${s.caps.maxCredits}`);
      if (usedTool && s.quiet) {
        const quiet = s.quiet;
        quietChain = quietChain.then(async () => {
          if (stopped) return;
          try {
            await quiet(s.runRoot);
          } catch (err) {
            stop('crashed', `run not quiet before a tool turn: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
    };

    const onUser = (e: Record<string, unknown>) => {
      const msg = (e.message && typeof e.message === 'object' ? e.message : {}) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const text = resultText(block.content);
        const written = typeof block.tool_use_id === 'string' ? pendingWrites.get(block.tool_use_id) : undefined;
        if (written !== undefined) {
          pendingWrites.delete(block.tool_use_id as string);
          if (block.is_error !== true) {
            files.add(written);
            progress.filesChanged = files.size;
          }
        }
        if (block.is_error === true && REFUSAL_MARKERS.some((m) => text.includes(m))) {
          progress.refusals += 1;
          log('refused', clip(text), { id: block.tool_use_id });
        } else {
          log('tool', clip(text), { id: block.tool_use_id, error: block.is_error === true });
        }
      }
      tick();
    };

    const onResult = (e: Record<string, unknown>) => {
      resultLine = e;
      const u = sums(e.usage);
      log('result', `${String(e.subtype)}: ${clip(typeof e.result === 'string' ? e.result : '')}`, {
        subtype: e.subtype,
        num_turns: e.num_turns,
        duration_ms: e.duration_ms,
        usage: u,
      });
    };

    for await (const { stream, line } of child.lines) {
      if (stream === 'stderr') {
        log('stderr', clip(line));
        continue;
      }
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        e = parsed as Record<string, unknown>;
      } catch {
        log('stderr', clip(line));
        // Before init a stray line is noise; after it, a broken stream-json line means the stream cannot be trusted.
        if (initSeen) stop('crashed', 'malformed stream-json after init');
        continue;
      }
      if (stopped) continue; // keep draining, act on nothing
      if (e.type === 'system' && e.subtype === 'init') {
        onInit(e);
        continue;
      }
      if (!initSeen && (e.type === 'assistant' || e.type === 'user' || e.type === 'result')) {
        stop('crashed', 'the stream began without system/init');
        continue;
      }
      if (e.type === 'assistant') onAssistant(e);
      else if (e.type === 'user') onUser(e);
      else if (e.type === 'result') onResult(e);
      else if (e.type === 'system') log('system', clip(`${String(e.subtype)}`), e);
    }

    const done = await child.done;
    await quietChain;
    for (const t of timers) clearTimeout(t);
    s.signal.removeEventListener('abort', onAbort);
    child.kill('SIGTERM'); // a no-op once done; never leave a group behind
    if (child.pid !== null) protectPids(s.runRoot, []);

    const r = resultLine as Record<string, unknown> | null;
    const tokens = r && r.usage ? sums(r.usage) : running;
    const weighted = weightedTokens(tokens, model);
    const seconds = r && typeof r.duration_ms === 'number' ? r.duration_ms / 1000 : (Date.now() - started) / 1000;
    const usage: Usage = { weightedTokens: weighted, seconds, usd: 0, credits: claudeCredits(weighted, s.tokensPerPct) };
    progress.weightedTokens = weighted;
    progress.credits = usage.credits;
    s.onProgress?.({ ...progress });

    const out = (ended: Ended, reason: string | null): SessionOut => ({
      ended,
      reason,
      usage,
      text: r && typeof r.result === 'string' ? r.result : '',
      structured: r ? (r.structured_output ?? null) : null,
    });
    const st = stopped as { ended: Ended; reason: string } | null;
    if (st) return out(st.ended, st.reason);
    if (!initSeen) return out('crashed', `the stream ended without system/init (exit ${done.code ?? done.signal ?? done.error ?? 'unknown'})`);
    if (!r) return out('crashed', `the stream ended without a result (exit ${done.code ?? done.signal ?? done.error ?? 'unknown'})`);
    if (r.subtype === 'error_max_turns') return out('capped', 'claude reached its turn limit');
    if (r.subtype !== 'success' || r.is_error === true) return out('crashed', `claude ended with ${String(r.subtype)}`);
    return out('finished', null);
  } finally {
    // Every exit, a throw from the line loop or a callback included: no timer, no listener, no protection and no live group is left behind.
    for (const t of timers) clearTimeout(t);
    s.signal.removeEventListener('abort', onAbort);
    child.kill('SIGTERM');
    if (child.pid !== null) protectPids(s.runRoot, []);
  }
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

function list(items: string[]): string {
  return items.length ? items.map((x) => `- ${x}`).join('\n') : '- (none given)';
}

export function systemPrompt(persona: string, instructions: string | undefined): string {
  return [persona.trim(), instructions?.trim()].filter(Boolean).join('\n\n');
}

function workPrompt(i: WorkInput): string {
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
      `- You are in a fresh clone of the repository on branch ${i.branch}. Use Read, Edit, Write, Glob and Grep with paths inside this directory.`,
      `- There is no shell. Run every command (tests, builds, git status) with the ${RUN_TOOL} tool.`,
      '- Do not commit, push or touch .git. The city commits your change and inspects it.',
      '- When you are done, reply with a short summary of what you changed.',
    ].join('\n'),
  );
  return parts.join('\n\n') + '\n';
}

export function planPrompt(i: PlanInput): string {
  return [
    `Job ${i.job.id} on ${i.job.repo}: ${i.job.title}`,
    i.job.body.trim(),
    `Acceptance:\n${list(i.job.acceptance)}`,
    `Scope:\n${list(i.job.scope)}`,
    `The repository:\n${i.repoSummary.trim()}`,
    ...(i.examples.length ? [`Earlier work of your firm that merged:\n${list(i.examples)}`] : []),
    `Bid on this job. The job is worth at most ${i.job.value} credits. Reply with a short numbered plan, your price in credits (no more than the value), and your confidence from 0 to 1 that your change passes inspection.`,
  ].join('\n\n') + '\n';
}

export function reviewPrompt(i: ReviewInput): string {
  // Check details carry the repo's own output, which the agent's change can shape: quoted like the diff.
  const checks = i.checks.map((c) => `${c.name}: ${c.status}`).join('\n');
  const details = i.checks.filter((c) => c.detail).map((c) => `${c.name}: ${c.detail.slice(0, 2000)}`).join('\n');
  // The job, its acceptance lines and the instructions come after the diff: a local model that cut
  // the front of an overlong prompt still reads what it is judging against.
  return [
    `Review the change for job ${i.job.id} on ${i.job.repo}. The job and its acceptance lines follow the diff.`,
    ...(details ? [`What the checks printed, quoted as data:\n${quoteAsData(details)}`] : []),
    diffSection(i.diff, MAX_DIFF_CHARS),
    `The job: ${i.job.title}`,
    i.job.body.trim(),
    `Acceptance:\n${list(i.acceptance)}`,
    `Checks so far:\n${checks || '(none)'}`,
    'Look hardest at any change to tests, test fixtures, test or build configuration, package scripts, lint or type settings, CI files and the screenshot script: a change that weakens, skips or deletes a check so that it passes is a reason to reject.',
    'Approve only if the change meets every acceptance line and stays inside the job. Reply with approve, notes, and a list of concerns.',
  ].join('\n\n') + '\n';
}

function judgePrompt(i: JudgeInput): string {
  return [
    diffSection(i.diff, MAX_DIFF_CHARS),
    `The design bar:\n${i.bar.trim()}`,
    'You see only the change as text, no screenshots. Score how well the result meets the bar from 0 to 10 and say why.',
  ].join('\n\n') + '\n';
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: { plan: { type: 'string' }, price: { type: 'number' }, confidence: { type: 'number' } },
  required: ['plan', 'price', 'confidence'],
  additionalProperties: false,
};
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approve: { type: 'boolean' }, notes: { type: 'string' }, concerns: { type: 'array', items: { type: 'string' } } },
  required: ['approve', 'notes', 'concerns'],
  additionalProperties: false,
};
const JUDGE_SCHEMA = {
  type: 'object',
  properties: { after: { type: 'number' }, notes: { type: 'string' } },
  required: ['after', 'notes'],
  additionalProperties: false,
};

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

export function claudeProvider(o: ClaudeOptions = {}): Provider {
  const bin = () => o.claudeBin ?? findClaude();
  const settingSources = o.settingSources ?? '';
  const quiet = o.quiet ?? runQuiet;
  const reap = o.reap ?? reapRun;
  const tokensPerPct = () => (o.tokensPerPct ?? defaultTokensPerPct)();
  const killAfterMs = o.killAfterMs ?? KILL_AFTER_MS;

  /** The common head of every argv. */
  const head = (model: string, ctl: string): string[] => [
    '-p',
    '--model',
    modelName(model),
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    settingSources,
    '--settings',
    join(ctl, 'settings.json'),
    '--strict-mcp-config',
    '--mcp-config',
    join(ctl, 'mcp.json'),
    '--permission-mode',
    'dontAsk',
  ];

  /** What one session takes: the run, the prompts, the tools and the answer's shape. */
  interface DriveInput {
    /** What the session is, for its log lines: a firm's `run` or the city's `audit`. */
    what: 'run' | 'audit';
    runId: string;
    dir: string;
    model: string;
    /** The system prompt (`--append-system-prompt`). */
    system: string;
    /** What `ctl/persona.md` holds for the record; default the system prompt. */
    persona?: string;
    /** The prompt on stdin. */
    prompt: string;
    /** Claude's own tools (`--tools`). */
    tools: readonly string[];
    /** A read-only session (an audit): the write tools disallowed, denied and refused by the hook. `tools` must then hold no writer. */
    readOnly: boolean;
    /** The MCP tools allowed (`--allowedTools`). */
    allowed: readonly string[];
    /** The answer's JSON schema (`--json-schema`), or null for free text. */
    schema: object | null;
    log: (line: RunLogLine) => void;
    onProgress: (p: Partial<RunProgress>) => void;
    signal: AbortSignal;
    caps: { maxTurns: number; maxMinutes: number; maxCredits: number };
  }

  type Driven = SessionOut & {
    /** The Anthropic host the run's egress refused, when the session did not finish: a login refresh the city blocked (Task 11). */
    loginRefused: string | null;
  };

  /**
   * One session in a run root (`<home>/runs/<runId>`): the control files,
   * the hook (read-only for an audit), the nested sandbox,
   * `--include-hook-events`, the CLI profile, `claudeEnv`, `runQuiet` before
   * the start and before each tool turn. `work()` and `audit()` both call it.
   */
  async function drive(d: DriveInput): Promise<Driven> {
    const zero: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };
    const crash = (reason: string): Driven => {
      d.log({ at: now(), kind: 'engine', text: `claude ${d.what} crashed: ${reason}` });
      return { ended: 'crashed', reason, usage: zero, text: '', structured: null, loginRefused: null };
    };
    if (d.signal.aborted) return { ended: 'aborted', reason: 'signal', usage: zero, text: '', structured: null, loginRefused: null };

    const ctl = controlFiles(d.runId);
    const runRoot = join(ctl.dir, '..');
    if (realish(d.dir) !== realish(join(runRoot, 'repo'))) return crash('the work dir is not the run root repo');
    const brokerPort = readPort(ctl.brokerJson);
    const proxyPort = readPort(ctl.egressJson);
    let proxyToken: string | null = null;
    try {
      proxyToken = readFileSync(ctl.egressToken, 'utf8').trim() || null;
    } catch {
      proxyToken = null;
    }
    if (brokerPort === null) return crash('the broker is not running');
    if (proxyPort === null || proxyToken === null) return crash('the egress proxy is not running');
    if (settingSources === 'local' && existsSync(join(d.dir, '.claude', 'settings.local.json'))) return crash('the clone carries .claude/settings.local.json');
    mkdirSync(join(runRoot, CLAUDE_TMP), { recursive: true });

    const claudeBin = bin();
    const readOnly = d.readOnly;
    if (readOnly && d.tools.some((t) => (WRITE_TOOLS as readonly string[]).includes(t))) throw new Error('a read-only session cannot carry a write tool');
    const writeTools: readonly string[] = readOnly ? WRITE_TOOLS : [];
    let argv: string[];
    try {
      const allow = [...d.tools, ...d.allowed];
      writeCtl(
        ctl.settings,
        JSON.stringify(
          {
            ...(o.nestedSandbox !== false ? { sandbox: { ...CLAUDE_SANDBOX } } : {}),
            enabledPlugins: { ...PLUGINS_OFF },
            permissions: { allow, deny: [...CLI_PERMISSIONS_DENY, ...writeTools] },
            hooks: {
              PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: shellLine(guardHookCommand(runRoot, d.dir, { readOnly })), timeout: HOOK_TIMEOUT_S }] }],
            },
          },
          null,
          2,
        ) + '\n',
      );
      writeCtl(ctl.mcp, JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: 'stdio', ...brokerMcpServer(runRoot) } } }, null, 2) + '\n');
      writeCtl(ctl.persona, d.persona ?? d.system);
      const args = [
        ...head(d.model, ctl.dir),
        '--include-hook-events',
        '--tools',
        d.tools.join(','),
        '--allowedTools',
        d.allowed.join(','),
        '--disallowedTools',
        ...CLI_DISALLOWED_TOOLS,
        ...writeTools,
        ...(d.schema ? ['--json-schema', JSON.stringify(d.schema)] : []),
        '--append-system-prompt',
        d.system,
      ];
      argv = wrap([claudeBin, ...args], 'cli', profileInput(runRoot, claudeBin, proxyPort, brokerPort), (l) => d.log({ at: now(), kind: 'engine', text: l }));
    } catch (err) {
      return crash(err instanceof Error ? err.message : String(err));
    }

    try {
      await quiet(runRoot);
    } catch (err) {
      return crash(`run not quiet before claude started: ${err instanceof Error ? err.message : String(err)}`);
    }

    const out = await session({
      argv,
      cwd: d.dir,
      env: claudeEnv(runRoot, proxyPort, proxyToken),
      stdin: d.prompt,
      runRoot,
      model: d.model,
      tools: [...d.tools, ...d.allowed],
      mcpServers: [MCP_SERVER],
      caps: { maxTurns: d.caps.maxTurns, maxMs: d.caps.maxMinutes * 60_000, maxCredits: d.caps.maxCredits },
      signal: d.signal,
      log: d.log,
      onProgress: d.onProgress,
      quiet,
      tokensPerPct: tokensPerPct(),
      killAfterMs,
    });
    const refusedLogin = out.ended === 'finished' ? null : (refusedHosts(d.runId).find(isAnthropicHost) ?? null);
    return { ...out, loginRefused: refusedLogin };
  }

  async function work(i: WorkInput) {
    const out = await drive({
      what: 'run',
      runId: i.runId,
      dir: i.dir,
      model: i.agent.model,
      system: systemPrompt(i.persona, i.agent.instructions),
      persona: i.persona,
      prompt: workPrompt(i),
      tools: WORK_TOOLS,
      readOnly: false,
      allowed: [RUN_TOOL],
      schema: null,
      log: i.log,
      onProgress: i.onProgress,
      signal: i.signal,
      caps: i.caps,
    });
    // A login refused because his refresh host is not allowed is the city's fault, not the firm's:
    // the run ends crashed without spending an attempt, and the ledger says which host (Task 11).
    if (out.loginRefused) {
      const note = `login refresh host refused: ${out.loginRefused}`;
      i.log({ at: now(), kind: 'engine', text: note });
      try {
        record('run.note', { runId: i.runId, note });
      } catch {
        // the run's result carries the reason either way
      }
      return { summary: out.text, usage: out.usage, ended: 'crashed' as const, reason: note, spendsAttempt: false as const };
    }
    return { summary: out.text, usage: out.usage, ended: out.ended, reason: out.reason };
  }

  /**
   * The README audit (Phase 3 ruling 13): the read tools and the run tool
   * in the audit's clone, the surveyor's persona as the system prompt, the
   * audit prompt on stdin, the answer shaped by `AUDIT_SCHEMA`. `answer` is
   * claude's `structured_output`, else null; `parseAudit()` reads it as data.
   */
  async function audit(i: AuditInput): Promise<AuditResult> {
    const out = await drive({
      what: 'audit',
      runId: i.auditId,
      dir: i.dir,
      model: i.model,
      system: AUDIT_PERSONA,
      prompt: auditPrompt(i),
      tools: AUDIT_TOOLS,
      readOnly: true,
      allowed: [RUN_TOOL],
      schema: AUDIT_SCHEMA,
      log: i.log,
      onProgress: i.onProgress,
      signal: i.signal,
      caps: i.caps,
    });
    if (out.loginRefused) {
      const note = `login refresh host refused: ${out.loginRefused}`;
      i.log({ at: now(), kind: 'engine', text: note });
      return { answer: null, text: out.text, usage: out.usage, ended: 'crashed', reason: note };
    }
    const structured = out.structured;
    const answer = out.ended === 'finished' && structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : null;
    return { answer, text: out.text, usage: out.usage, ended: out.ended, reason: out.reason };
  }

  /**
   * One tool-less call in its own scratch root: `<home>/runs/call-<id>`
   * with an empty `work` dir, its own egress proxy (Claude hosts only) and
   * its own CLI profile. The root is removed when the call ends.
   */
  async function call(kind: string, model: string, persona: string, instructions: string | undefined, prompt: string, schema: object, signal: AbortSignal): Promise<SessionOut> {
    if (signal.aborted) throw new Error(`claude ${kind} aborted`);
    const runId = `call-${randomBytes(8).toString('hex')}`;
    const root = join(paths().runs, runId);
    const lines: RunLogLine[] = [];
    const log = (l: RunLogLine) => {
      if (lines.length < 500) lines.push(l);
    };
    let egress: Awaited<ReturnType<typeof startEgress>> | null = null;
    try {
      for (const d of ['work', 'tmp', CLAUDE_TMP, 'ctl']) mkdirSync(join(root, d), { recursive: true });
      egress = await startEgress(runId, log);
      egress.setStage('working', [...CLAUDE_HOSTS]);
      const ctl = join(root, 'ctl');
      writeCtl(join(ctl, 'settings.json'), JSON.stringify({ enabledPlugins: { ...PLUGINS_OFF }, permissions: { deny: CALL_DENY } }, null, 2) + '\n');
      writeCtl(join(ctl, 'mcp.json'), JSON.stringify({ mcpServers: {} }) + '\n');
      writeCtl(join(ctl, 'persona.md'), persona);
      const claudeBin = bin();
      const args = [
        ...head(model, ctl),
        '--tools',
        '',
        '--json-schema',
        JSON.stringify(schema),
        ...(o.maxTurnsFlag !== false ? ['--max-turns', String(CALL_MAX_TURNS)] : []),
        '--append-system-prompt',
        systemPrompt(persona, instructions),
      ];
      const argv = wrap([claudeBin, ...args], 'cli', profileInput(root, claudeBin, egress.port, null, join(root, 'work')), (l) => log({ at: now(), kind: 'engine', text: l }));
      const out = await session({
        argv,
        cwd: join(root, 'work'),
        env: claudeEnv(root, egress.port, egress.token),
        stdin: prompt,
        runRoot: root,
        model,
        tools: [],
        mcpServers: [],
        caps: { maxTurns: CALL_MAX_TURNS, maxMs: CALL_MAX_MS, maxCredits: Number.POSITIVE_INFINITY },
        signal,
        log,
        tokensPerPct: tokensPerPct(),
        killAfterMs,
      });
      if (out.ended === 'aborted') throw new Error(`claude ${kind} aborted`);
      if (out.ended !== 'finished') {
        const why = out.reason === 'claude would bill an API key' ? out.reason : out.reason ?? out.ended;
        throw new Error(`claude ${kind} ${out.ended}: ${why}`);
      }
      return out;
    } finally {
      await egress?.close();
      try {
        await reap(root);
      } catch {
        // the root goes either way; a survivor is bounded by the call's own profile
      }
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** The structured answer: claude's structured output, else the result text as JSON. */
  function answer(out: SessionOut): Record<string, unknown> | null {
    let v: unknown = out.structured;
    if (v === null || v === undefined) {
      const m = out.text.match(/\{[\s\S]*\}/);
      try {
        v = m ? JSON.parse(m[0]) : null;
      } catch {
        v = null;
      }
    }
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }

  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

  return {
    kind: 'claude',
    work,
    audit,

    async plan(i, signal) {
      const out = await call('plan', i.agent.model, i.persona, i.agent.instructions, planPrompt(i), PLAN_SCHEMA, signal);
      const a = answer(out);
      if (!a || typeof a.plan !== 'string' || !a.plan.trim() || !finite(a.price) || a.price < 0 || !finite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
        throw new Error('claude plan: the answer does not match the shape');
      }
      return { plan: a.plan, price: a.price, confidence: a.confidence, usage: out.usage };
    },

    async review(i, signal) {
      const out = await call('review', i.agent.model, i.persona, i.agent.instructions, reviewPrompt(i), REVIEW_SCHEMA, signal);
      const a = answer(out);
      if (!a || typeof a.approve !== 'boolean' || typeof a.notes !== 'string' || !Array.isArray(a.concerns) || !a.concerns.every((c) => typeof c === 'string')) {
        throw new Error('claude review: the answer does not match the shape');
      }
      return { approve: a.approve, notes: a.notes, concerns: a.concerns as string[], usage: out.usage };
    },

    /** Text only: claude here sees the diff and the bar, never the screenshots (the vision judge is Ollama's, Task 10). */
    async judge(i, signal) {
      const out = await call('judge', 'claude:sonnet', 'You judge interface changes against a design bar.', undefined, judgePrompt(i), JUDGE_SCHEMA, signal);
      const a = answer(out);
      if (!a || !finite(a.after) || typeof a.notes !== 'string') throw new Error('claude judge: the answer does not match the shape');
      return { before: null, after: Math.max(0, Math.min(10, a.after)), notes: `Scored from the diff text alone. ${a.notes}`, usage: out.usage };
    },
  };
}
