/**
 * The claude -p backend (Task 9). No test runs the real claude: a fake
 * spawner replays recorded stream-json lines (test safety rule 4), and the
 * claude binary named in the argv is a stub that is never executed.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { realSpawner, setSpawner, type SpawnLine, type SpawnOpts, type Spawned } from '../engine/exec.js';
import { CLI_DISALLOWED_TOOLS, CLI_PERMISSIONS_DENY } from '../engine/market/guard.js';
import { BUILTIN_PLUGINS, CALL_DENY, CLAUDE_SANDBOX, HOOK_MATCHER, KILL_AFTER_MS, claudeProvider, type ClaudeOptions } from '../engine/market/claude.js';
import type { RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { startEgress } from '../engine/market/egress.js';
import { entries } from '../engine/ledger.js';
import { protectedPidsOf } from '../engine/market/reaper.js';
import { SANDBOX_EXEC } from '../engine/market/sandbox.js';
import { weightedTokens, claudeCredits } from '../shared/credits.js';
import type { Agent, Job, RunProgress } from '../shared/types.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let claudeBin: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-claude-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  delete process.env.PALIMPSEST_SANDBOX;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-never-used';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test-never-used';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  mkdirSync(join(tempDir, 'bin'), { recursive: true });
  claudeBin = join(tempDir, 'bin', 'claude');
  writeFileSync(claudeBin, '#!/bin/sh\nexit 1\n');
  chmodSync(claudeBin, 0o755);
});

afterEach(() => {
  setSpawner(realSpawner);
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Recorded stream-json                                                */
/* ------------------------------------------------------------------ */

const WORK_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__palimpsest__run'];

function init(over: Record<string, unknown> = {}) {
  return {
    type: 'system',
    subtype: 'init',
    cwd: '/x',
    session_id: 's-1',
    tools: WORK_TOOLS,
    mcp_servers: [{ name: 'palimpsest', status: 'connected' }],
    model: 'claude-sonnet-4-5',
    permissionMode: 'dontAsk',
    apiKeySource: 'none',
    plugins: [],
    ...over,
  };
}

function assistant(id: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) {
  return { type: 'assistant', message: { id, role: 'assistant', model: 'claude-sonnet-4-5', content, usage }, session_id: 's-1' };
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name, input };
}

function toolResult(id: string, text: string, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, session_id: 's-1' };
}

function result(over: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4200,
    num_turns: 3,
    result: 'Added the changelog.',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 },
    ...over,
  };
}

/** A recorded happy work run: init, an edit, a refused command, a run, the result. */
function happyWork(): unknown[] {
  return [
    init(),
    assistant('m1', [{ type: 'text', text: 'I will add the changelog.' }, toolUse('t1', 'Write', { file_path: 'docs/CHANGELOG.md', content: '# Changelog\n' })]),
    toolResult('t1', 'File created successfully'),
    assistant('m2', [toolUse('t2', 'mcp__palimpsest__run', { command: 'git push origin main' })]),
    toolResult('t2', 'Refused by the city: git push is never allowed', true),
    assistant('m3', [toolUse('t3', 'Edit', { file_path: '/Users/x/.claude/settings.json', old_string: 'a', new_string: 'b' })]),
    toolResult('t3', 'PreToolUse:Edit hook error: Palimpsest refused this call: outside the run dir', true),
    assistant('m4', [{ type: 'text', text: 'Done.' }]),
    result(),
  ];
}

/* ------------------------------------------------------------------ */
/* The fake spawner                                                    */
/* ------------------------------------------------------------------ */

interface Call {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  kills: string[];
  /** Control files as they were when claude started. */
  seen: Record<string, string | null>;
  cwdExisted: boolean;
}

/**
 * Replays `events` (objects become JSON lines, strings go out verbatim).
 * With `hang`, the stream stays open after the last line until killed;
 * `stubborn` ignores SIGTERM and dies only on SIGKILL.
 */
function fake(events: unknown[], o: { hang?: boolean; stubborn?: boolean; stderr?: string[]; peek?: (call: Call) => void } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  setSpawner((cmd, args, opts): Spawned => {
    const call: Call = { cmd, args, opts, kills: [], seen: {}, cwdExisted: !!opts.cwd && existsSync(opts.cwd) };
    const ctlIndex = args.indexOf('--settings');
    if (ctlIndex >= 0) {
      const ctl = join(args[ctlIndex + 1], '..');
      for (const f of ['settings.json', 'mcp.json', 'persona.md', 'cli.sb', 'egress.json']) {
        call.seen[f] = existsSync(join(ctl, f)) ? readFileSync(join(ctl, f), 'utf8') : null;
      }
    }
    o.peek?.(call);
    calls.push(call);
    let die!: () => void;
    const dead = new Promise<void>((r) => (die = r));
    let finished = false;
    let resolveDone!: (d: { code: number | null; signal: string | null }) => void;
    const done = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveDone = r));
    async function* lines(): AsyncGenerator<SpawnLine> {
      try {
        for (const l of o.stderr ?? []) yield { stream: 'stderr', line: l };
        for (const e of events) {
          if (finished) return;
          yield { stream: 'stdout', line: typeof e === 'string' ? e : JSON.stringify(e) };
          await new Promise((r) => setImmediate(r));
        }
        if (o.hang) await dead;
      } finally {
        finished = true;
        resolveDone({ code: o.hang ? null : 0, signal: o.hang ? 'SIGTERM' : null });
      }
    }
    return {
      pid: 424242,
      lines: lines(),
      kill(sig = 'SIGTERM') {
        call.kills.push(sig);
        if (sig === 'SIGKILL' || !o.stubborn) {
          finished = true;
          die();
        }
      },
      done,
    };
  });
  return { calls };
}

/** claude's own argv inside the sandbox-exec wrapper. */
function claudeArgs(call: Call): string[] {
  const all = [call.cmd, ...call.args];
  const at = all.indexOf(claudeBin);
  assert.ok(at >= 0, `claude binary not in argv: ${all.join(' ')}`);
  return all.slice(at + 1);
}

function flagValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `missing ${flag}`);
  return args[i + 1];
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    repo: 'acme/widgets',
    source: 'issue',
    issue: 7,
    url: null,
    title: 'Add a changelog',
    body: 'Please add `docs/CHANGELOG.md` with a first entry.',
    scope: ['docs/**'],
    acceptance: ['docs/CHANGELOG.md exists'],
    tier: 'normal',
    value: 60,
    status: 'running',
    attempts: 0,
    postedAt: '2026-11-01T00:00:00.000Z',
    bidsCloseAt: null,
    awardedBid: null,
    runId: 'run-1',
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...over,
  };
}

const agent = { id: 'agent-1', firmId: 'firm-1', name: 'Ada', model: 'claude:sonnet', instructions: 'Keep changes small.', maxTurns: 40 } as unknown as Agent;

/** A run root shaped as the runner leaves it before work(): clone, tmp, ctl, a broker and an egress proxy recorded. */
function makeRun(runId = 'run-1') {
  const runRoot = join(tempDir, 'data', 'runs', runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(runRoot, 'ctl', 'broker.json'), JSON.stringify({ port: 50101 }));
  writeFileSync(join(runRoot, 'ctl', 'egress.json'), JSON.stringify({ port: 50102 }));
  writeFileSync(join(runRoot, 'ctl', 'egress.token'), 'egress-token-1');
  return { runId, runRoot, dir };
}

function workInput(over: Partial<WorkInput> = {}) {
  const run = makeRun(over.runId);
  const logs: RunLogLine[] = [];
  const ticks: Partial<RunProgress>[] = [];
  const input: WorkInput = {
    job: makeJob(),
    agent,
    persona: 'Ada is careful and terse.',
    runId: run.runId,
    dir: run.dir,
    branch: 'palimpsest/job-1',
    plan: null,
    examples: [],
    log: (l) => logs.push(l),
    onProgress: (p) => ticks.push(p),
    signal: new AbortController().signal,
    caps: { maxTurns: 40, maxMinutes: 40, maxCredits: 1000 },
    ...over,
  };
  return { input, logs, ticks, run };
}

function provider(over: ClaudeOptions = {}) {
  const quiets: string[] = [];
  const reaps: Array<{ root: string; existed: boolean }> = [];
  const p = claudeProvider({
    claudeBin,
    tokensPerPct: () => 60_000,
    quiet: async (root) => void quiets.push(root),
    reap: async (root) => void reaps.push({ root, existed: existsSync(root) }),
    ...over,
  });
  return { p, quiets, reaps };
}

const onMac = process.platform === 'darwin';

/* ------------------------------------------------------------------ */
/* work()                                                              */
/* ------------------------------------------------------------------ */

describe('work', () => {
  test('argv carries setting sources, strict MCP, the settings file, dontAsk and the tool list, and never --bare', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input, run } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'finished', out.reason ?? '');
    const a = claudeArgs(calls[0]);
    const ctl = join(run.runRoot, 'ctl');
    assert.equal(a[0], '-p');
    assert.equal(flagValue(a, '--model'), 'sonnet');
    assert.equal(flagValue(a, '--output-format'), 'stream-json');
    assert.ok(a.includes('--verbose'));
    assert.ok(a.includes('--no-session-persistence'));
    assert.equal(flagValue(a, '--setting-sources'), '');
    assert.equal(realpathSync(flagValue(a, '--settings')), realpathSync(join(ctl, 'settings.json')));
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(realpathSync(flagValue(a, '--mcp-config')), realpathSync(join(ctl, 'mcp.json')));
    assert.equal(flagValue(a, '--permission-mode'), 'dontAsk');
    assert.equal(flagValue(a, '--tools'), 'Read,Edit,Write,Glob,Grep');
    assert.equal(flagValue(a, '--allowedTools'), 'mcp__palimpsest__run');
    const dis = a.indexOf('--disallowedTools');
    assert.deepEqual(a.slice(dis + 1, dis + 1 + CLI_DISALLOWED_TOOLS.length), [...CLI_DISALLOWED_TOOLS]);
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task']) assert.ok(CLI_DISALLOWED_TOOLS.includes(t));
    assert.equal(flagValue(a, '--append-system-prompt').includes('Ada is careful and terse.'), true);
    assert.ok(!a.includes('--bare'));
    assert.ok(![calls[0].cmd, ...calls[0].args].includes('--bare'));
    assert.equal(realpathSync(calls[0].opts.cwd!), realpathSync(run.dir));
    assert.match(calls[0].opts.stdin ?? '', /Add a changelog/);
    assert.match(calls[0].opts.stdin ?? '', /CHANGELOG/);
    // The persona and the MCP config went to ctl before claude started.
    assert.equal(calls[0].seen['persona.md'], 'Ada is careful and terse.');
    const mcp = JSON.parse(calls[0].seen['mcp.json']!);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['palimpsest']);
    assert.equal(mcp.mcpServers.palimpsest.command, process.execPath);
    assert.ok(mcp.mcpServers.palimpsest.args.some((x: string) => x.endsWith('broker-mcp.mjs')));
    assert.ok(!JSON.stringify(mcp).includes('egress-token-1'));
  });

  test('argv is wrapped in the CLI profile', { skip: !onMac && 'sandbox-exec is macOS only' }, async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input, run } = workInput();
    await p.work(input);
    const c = calls[0];
    assert.equal(c.cmd, SANDBOX_EXEC);
    assert.equal(c.args[0], '-f');
    assert.equal(realpathSync(c.args[1]), realpathSync(join(run.runRoot, 'ctl', 'cli.sb')));
    assert.equal(c.args[2], claudeBin);
    const profile = c.seen['cli.sb']!;
    assert.match(profile, /Palimpsest cli profile/);
    assert.match(profile, /localhost:50102/); // the run's proxy
    assert.match(profile, /localhost:50101/); // the run's broker
    assert.ok(profile.includes(join(realpathSync(run.runRoot), 'repo')));
  });

  test('the child environment has no API key or auth token', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input, run } = workInput();
    await p.work(input);
    const { opts } = calls[0];
    assert.equal(opts.clearEnv, true);
    const env = opts.env ?? {};
    assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_TMPDIR', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LOGNAME', 'MCP_TOOL_TIMEOUT', 'NO_PROXY', 'PATH', 'TMPDIR', 'USER'].sort());
    // claude names his login's keychain account by USER (Task 11: without it claude reports Not logged in)
    assert.equal(env.USER, userInfo().username);
    assert.equal(env.LOGNAME, userInfo().username);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) assert.equal(env[k], undefined, k);
    assert.ok(!Object.values(env).some((v) => v.includes('sk-ant-test') || v.includes('auth-test')));
    assert.equal(env.MCP_TOOL_TIMEOUT, '900000');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
    // claude has its own temp dir, ctmp, which no tool child can write (Task 11)
    assert.equal(realpathSync(env.TMPDIR), realpathSync(join(run.runRoot, 'ctmp')));
    assert.equal(realpathSync(env.CLAUDE_CODE_TMPDIR), realpathSync(join(run.runRoot, 'ctmp')));
    assert.match(env.HTTPS_PROXY, /^http:\/\/palimpsest:egress-token-1@127\.0\.0\.1:50102$/);
    assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  });

  test('init with apiKeySource other than none crashes the run before any tool runs', async () => {
    const events = [init({ apiKeySource: 'ANTHROPIC_API_KEY' }), assistant('m1', [toolUse('t1', 'Write', { file_path: 'x.md', content: 'x' })]), toolResult('t1', 'ok'), result()];
    const { calls } = fake(events, { hang: true });
    const { p, quiets } = provider();
    const { input, ticks } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.equal(out.reason, 'claude would bill an API key');
    assert.ok(calls[0].kills.includes('SIGTERM'));
    assert.ok(!ticks.some((t) => (t.toolCalls ?? 0) > 0), 'no tool call was counted');
    assert.equal(quiets.length, 1, 'only the quiet check before claude started');
  });

  test('init listing Bash or a foreign MCP server crashes the run', async () => {
    for (const bad of [{ tools: [...WORK_TOOLS, 'Bash'] }, { mcp_servers: [{ name: 'palimpsest', status: 'connected' }, { name: 'his-github', status: 'connected' }] }]) {
      const { calls } = fake([init(bad), ...happyWork().slice(1)], { hang: true });
      const { p } = provider();
      const { input } = workInput({ runId: `run-${calls.length}-${Object.keys(bad)[0]}` });
      const out = await p.work(input);
      assert.equal(out.ended, 'crashed');
      assert.equal(out.reason, 'unexpected tools');
      assert.ok(calls[0].kills.includes('SIGTERM'));
    }
  });

  test('the settings file hooks every file tool and the run tool', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input, run } = workInput();
    await p.work(input);
    const settings = JSON.parse(calls[0].seen['settings.json']!);
    assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'hooks', 'permissions', 'sandbox']);
    // Claude Code's built-in plugins are switched off, so init lists no plugins (Task 11 smoke run)
    assert.deepEqual(settings.enabledPlugins, Object.fromEntries(BUILTIN_PLUGINS.map((n) => [`${n}@builtin`, false])));
    assert.ok(BUILTIN_PLUGINS.includes('cc-plugin-agents-md') && BUILTIN_PLUGINS.includes('cc-plugin-privacy') && BUILTIN_PLUGINS.includes('cc-plugin-plugin-authoring'));
    assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse']);
    const [entry] = settings.hooks.PreToolUse;
    assert.equal(entry.matcher, HOOK_MATCHER);
    assert.equal(HOOK_MATCHER, 'Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|mcp__palimpsest__run');
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, 'command');
    const cmd: string = entry.hooks[0].command;
    assert.ok(cmd.includes(process.execPath));
    assert.ok(cmd.includes('guard-hook.mjs'));
    assert.ok(cmd.includes(realpathSync(run.dir)) || cmd.includes(run.dir));
    assert.deepEqual(settings.permissions.allow, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__palimpsest__run']);
    assert.deepEqual(settings.permissions.deny, [...CLI_PERMISSIONS_DENY]);
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent']) assert.ok(settings.permissions.deny.includes(t), t);
  });

  test('work asks claude for its hook events, so the run log shows every hook decision (Task 11)', async () => {
    const { calls } = fake(happyWork());
    const { input } = workInput();
    await provider().p.work(input);
    assert.ok(claudeArgs(calls[0]).includes('--include-hook-events'));
  });

  test("work settings turn on Claude Code's own sandbox as a fourth layer, unless told not to (ruling 19, Task 11)", async () => {
    const nested = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
    assert.deepEqual(CLAUDE_SANDBOX, nested);
    const on = fake(happyWork());
    await provider().p.work(workInput().input);
    const settings = JSON.parse(on.calls[0].seen['settings.json']!);
    assert.deepEqual(settings.sandbox, nested);
    assert.equal(settings.hooks.PreToolUse[0].matcher, HOOK_MATCHER);
    const off = fake(happyWork());
    await provider({ nestedSandbox: false }).p.work(workInput({ runId: 'run-2' }).input);
    assert.equal(JSON.parse(off.calls[0].seen['settings.json']!).sandbox, undefined);
  });

  test('a login refused because a refresh host is not allowed ends crashed, spends no attempt and leaves a ledger note (Task 11 minors)', async () => {
    const { input, run } = workInput();
    const egressLog: RunLogLine[] = [];
    const egress = await startEgress(run.runId, (l) => egressLog.push(l));
    try {
      egress.setStage('working', ['api.anthropic.com']);
      // claude tries to refresh his login at a host the run does not allow
      const status = await new Promise<number>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port: egress.port, method: 'CONNECT', path: 'platform.claude.com:443', headers: { 'proxy-authorization': `Basic ${Buffer.from(`palimpsest:${egress.token}`).toString('base64')}` } });
        req.on('connect', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', () => resolve(0));
        req.end();
      });
      assert.equal(status, 403);
      fake([init(), assistant('m1', [{ type: 'text', text: 'Not logged in · Please run /login' }]), result({ is_error: true, result: 'Not logged in · Please run /login' })]);
      const out = await provider().p.work(input);
      assert.equal(out.ended, 'crashed');
      assert.equal(out.reason, 'login refresh host refused: platform.claude.com');
      assert.equal(out.spendsAttempt, false);
      const notes = entries().filter((e) => e.kind === 'run.note');
      assert.equal(notes.length, 1);
      assert.deepEqual(notes[0].data, { runId: run.runId, note: 'login refresh host refused: platform.claude.com' });
    } finally {
      await egress.close();
    }
  });

  test('a refused host that is not Anthropic, or a run that finishes, leaves the result as it was', async () => {
    const { input, run } = workInput();
    const egress = await startEgress(run.runId, () => {});
    try {
      egress.setStage('working', ['api.anthropic.com']);
      await new Promise<void>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port: egress.port, method: 'CONNECT', path: 'evil.example:443', headers: { 'proxy-authorization': `Basic ${Buffer.from(`palimpsest:${egress.token}`).toString('base64')}` } });
        req.on('connect', (_r, socket) => (socket.destroy(), resolve()));
        req.on('response', () => resolve());
        req.on('error', () => resolve());
        req.end();
      });
      fake(happyWork());
      const out = await provider().p.work(input);
      assert.equal(out.ended, 'finished');
      assert.equal(out.spendsAttempt, undefined);
      assert.deepEqual(entries().filter((e) => e.kind === 'run.note'), []);
    } finally {
      await egress.close();
    }
  });

  test('usage parses from the result line into weighted credits', async () => {
    fake(happyWork());
    const { p } = provider();
    const { input, ticks, logs } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'finished');
    const w = weightedTokens({ input: 1000, output: 200, cacheRead: 5000, cacheCreation: 400 }, 'claude-sonnet-4-5');
    assert.equal(w, 1800);
    assert.equal(out.usage.weightedTokens, w);
    assert.equal(out.usage.credits, claudeCredits(w, 60_000));
    assert.equal(out.usage.usd, 0);
    assert.equal(out.usage.seconds, 4.2);
    assert.equal(out.summary, 'Added the changelog.');
    const last = Object.assign({}, ...ticks) as RunProgress;
    assert.equal(last.toolCalls, 3);
    assert.equal(last.turns, 4);
    assert.equal(last.refusals, 2);
    assert.equal(last.filesChanged, 1);
    assert.equal(last.weightedTokens, w);
    assert.ok(logs.some((l) => l.kind === 'refused' && /git push/.test(l.text)));
    assert.ok(logs.some((l) => l.kind === 'system' && /apiKeySource none/.test(l.text)));
    assert.ok(logs.some((l) => l.kind === 'result'));
  });

  test('a stream without result is crashed and keeps the partial log', async () => {
    const events = [init(), assistant('m1', [{ type: 'text', text: 'Starting the change.' }]), '{"type":"assistant","message":{"id":"m2","content":[{"type":"te'];
    fake(events, { stderr: ['Error: something broke'] });
    const { p } = provider();
    const { input, logs } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.match(out.reason ?? '', /malformed stream-json/);
    assert.ok(logs.some((l) => l.kind === 'assistant' && l.text.includes('Starting the change.')));
    assert.ok(logs.some((l) => l.kind === 'stderr' && l.text.includes('{"type":"assistant"')), 'the truncated line goes to the log as stderr');
    assert.ok(logs.some((l) => l.kind === 'stderr' && l.text.includes('something broke')));
  });

  test('a stream that simply stops after init is crashed for want of a result', async () => {
    fake([init(), assistant('m1', [{ type: 'text', text: 'Starting.' }])]);
    const { p } = provider();
    const { input, logs } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.match(out.reason ?? '', /without a result/);
    assert.ok(logs.some((l) => l.kind === 'assistant' && l.text.includes('Starting.')));
  });

  test('a non-JSON line before init is noise, after init it crashes the run', async () => {
    fake(['claude 2.1.319 starting', ...happyWork()]);
    const { p } = provider();
    const ok = await p.work(workInput().input);
    assert.equal(ok.ended, 'finished', ok.reason ?? '');

    const events = happyWork();
    events.splice(2, 0, 'Segmentation fault: 11');
    const { calls } = fake(events, { hang: true });
    const { input, logs } = workInput({ runId: 'run-2' });
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.equal(out.reason, 'malformed stream-json after init');
    assert.ok(calls[0].kills.includes('SIGTERM'));
    assert.ok(logs.some((l) => l.kind === 'stderr' && l.text.includes('Segmentation fault')));
  });

  test('init without a tools or mcp_servers list crashes the run', async () => {
    for (const drop of ['tools', 'mcp_servers']) {
      const bad = init();
      delete (bad as Record<string, unknown>)[drop];
      const { calls } = fake([bad, ...happyWork().slice(1)], { hang: true });
      const { p } = provider();
      const out = await p.work(workInput({ runId: `run-no-${drop}` }).input);
      assert.equal(out.ended, 'crashed', drop);
      assert.equal(out.reason, 'unexpected tools');
      assert.ok(calls[0].kills.includes('SIGTERM'));
    }
  });

  test('a callback that throws still kills claude and clears its protection', async () => {
    const { calls } = fake(happyWork(), { hang: true });
    const { p } = provider();
    const { input, run } = workInput({
      onProgress: () => {
        throw new Error('progress sink broke');
      },
    });
    let protectedDuring: number[] = [];
    const log = input.log;
    input.log = (l) => {
      if (l.kind === 'system') protectedDuring = protectedPidsOf(run.runRoot);
      log(l);
    };
    await assert.rejects(p.work(input), /progress sink broke/);
    assert.deepEqual(protectedDuring, [424242], 'claude was protected while it ran');
    assert.ok(calls[0].kills.includes('SIGTERM'), 'claude was killed');
    assert.deepEqual(protectedPidsOf(run.runRoot), [], 'the protection is cleared');
  });

  test('a turn cap kills the group and reports capped', async () => {
    const events = [init(), ...[1, 2, 3, 4].map((n) => assistant(`m${n}`, [{ type: 'text', text: `step ${n}` }]))];
    const { calls } = fake(events, { hang: true });
    const { p } = provider();
    const { input } = workInput({ caps: { maxTurns: 2, maxMinutes: 40, maxCredits: 1000 } });
    const out = await p.work(input);
    assert.equal(out.ended, 'capped');
    assert.match(out.reason ?? '', /turn/);
    assert.equal(calls[0].kills[0], 'SIGTERM');
  });

  test('a credit cap kills the group and reports capped', async () => {
    const big = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const events = [init(), assistant('m1', [{ type: 'text', text: 'big' }], big)];
    const { calls } = fake(events, { hang: true });
    const { p } = provider();
    const { input } = workInput({ caps: { maxTurns: 40, maxMinutes: 40, maxCredits: 1 } });
    const out = await p.work(input);
    assert.equal(out.ended, 'capped');
    assert.match(out.reason ?? '', /credit/);
    assert.equal(calls[0].kills[0], 'SIGTERM');
  });

  test('abort kills within five seconds', async () => {
    assert.equal(KILL_AFTER_MS, 5000);
    const { calls } = fake([init(), assistant('m1', [{ type: 'text', text: 'working' }])], { hang: true, stubborn: true });
    const { p } = provider({ killAfterMs: 50 });
    const ac = new AbortController();
    const { input } = workInput({ signal: ac.signal });
    const started = Date.now();
    const pending = p.work(input);
    setTimeout(() => ac.abort(), 20);
    const out = await pending;
    assert.equal(out.ended, 'aborted');
    assert.deepEqual(calls[0].kills.slice(0, 2), ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - started < 5000);
  });

  test('an already aborted signal never starts claude', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const ac = new AbortController();
    ac.abort();
    const { input } = workInput({ signal: ac.signal });
    const out = await p.work(input);
    assert.equal(out.ended, 'aborted');
    assert.equal(calls.length, 0);
  });

  test('the run is quiet before claude starts and before each tool turn', async () => {
    fake(happyWork());
    const { p, quiets } = provider();
    const { input, run } = workInput();
    await p.work(input);
    // once before the start, once per assistant message carrying tool_use (three)
    assert.equal(quiets.length, 4);
    assert.ok(quiets.every((r) => realpathSync(r) === realpathSync(run.runRoot)));
  });

  test('a run that cannot be made quiet crashes', async () => {
    const { calls } = fake(happyWork(), { hang: true });
    let n = 0;
    const { p } = provider({
      quiet: async () => {
        n += 1;
        if (n > 1) throw new Error('run processes still alive: 77');
      },
    });
    const { input } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.match(out.reason ?? '', /still alive/);
    assert.ok(calls[0].kills.includes('SIGTERM'));
  });

  test('a run without its broker or proxy crashes before claude starts', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input, run } = workInput();
    rmSync(join(run.runRoot, 'ctl', 'broker.json'));
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.match(out.reason ?? '', /broker/);
    assert.equal(calls.length, 0);
  });

  test('a dir that is not the run root repo crashes before claude starts', async () => {
    const { calls } = fake(happyWork());
    const { p } = provider();
    const { input } = workInput();
    const out = await p.work({ ...input, dir: tempDir });
    assert.equal(out.ended, 'crashed');
    assert.equal(calls.length, 0);
  });

  test('a stream that starts without init is crashed', async () => {
    fake([assistant('m1', [toolUse('t1', 'Write', { file_path: 'x', content: 'x' })]), result()], { hang: true });
    const { p } = provider();
    const { input } = workInput();
    const out = await p.work(input);
    assert.equal(out.ended, 'crashed');
    assert.match(out.reason ?? '', /init/);
  });

  test('the claude provider is registered for claude: models', () => {
    assert.equal(providerFor('claude:sonnet').kind, 'claude');
  });
});

/* ------------------------------------------------------------------ */
/* plan() and review()                                                 */
/* ------------------------------------------------------------------ */

function callInit(over: Record<string, unknown> = {}) {
  return init({ tools: [], mcp_servers: [], plugins: [], ...over });
}

const planInput = { job: makeJob(), agent, persona: 'Ada is careful and terse.', repoSummary: 'A TypeScript widget library.', examples: ['Fixed a typo in README.md.'] };

describe('plan and review', () => {
  test('plan uses json schema, no tools, an empty strict MCP config, empty setting sources and no session persistence', async () => {
    const { calls } = fake([callInit(), assistant('m1', [{ type: 'text', text: '{}' }]), result({ structured_output: { plan: '1. Write it.', price: 30, confidence: 0.8 } })]);
    const { p } = provider();
    const out = await p.plan(planInput, new AbortController().signal);
    assert.equal(out.plan, '1. Write it.');
    assert.equal(out.price, 30);
    assert.equal(out.confidence, 0.8);
    assert.equal(out.usage.weightedTokens, 1800);
    const a = claudeArgs(calls[0]);
    assert.equal(a[0], '-p');
    assert.equal(flagValue(a, '--model'), 'sonnet');
    assert.equal(flagValue(a, '--output-format'), 'stream-json');
    assert.ok(a.includes('--verbose'));
    assert.ok(a.includes('--no-session-persistence'));
    assert.equal(flagValue(a, '--setting-sources'), '');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(flagValue(a, '--permission-mode'), 'dontAsk');
    assert.equal(flagValue(a, '--tools'), '');
    const schema = JSON.parse(flagValue(a, '--json-schema'));
    assert.deepEqual(Object.keys(schema.properties).sort(), ['confidence', 'plan', 'price']);
    assert.match(flagValue(a, '--append-system-prompt'), /Ada is careful and terse\./);
    assert.ok(!a.includes('--bare'));
    assert.ok(!a.includes('--allowedTools'));
    assert.equal(flagValue(a, '--max-turns'), '3', 'the smoke run (Task 11) found --max-turns in claude 2.1.319');
    assert.deepEqual(JSON.parse(calls[0].seen['mcp.json']!), { mcpServers: {} });
    assert.deepEqual(JSON.parse(calls[0].seen['settings.json']!), { enabledPlugins: Object.fromEntries(BUILTIN_PLUGINS.map((n) => [`${n}@builtin`, false])), permissions: { deny: CALL_DENY } });
    assert.deepEqual(CALL_DENY, ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent']);
    assert.match(calls[0].opts.stdin ?? '', /Add a changelog/);
    assert.match(calls[0].opts.stdin ?? '', /A TypeScript widget library\./);
    const env = calls[0].opts.env ?? {};
    assert.equal(calls[0].opts.clearEnv, true);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) assert.equal(env[k], undefined, k);
  });

  test('plan passes --max-turns 3 by default and leaves it out when told the CLI lacks it', async () => {
    const { calls } = fake([callInit(), result({ structured_output: { plan: 'p', price: 10, confidence: 0.5 } })]);
    await provider().p.plan(planInput, new AbortController().signal);
    assert.equal(flagValue(claudeArgs(calls[0]), '--max-turns'), '3');
    const second = fake([callInit(), result({ structured_output: { plan: 'p', price: 10, confidence: 0.5 } })]);
    await provider({ maxTurnsFlag: false }).p.plan(planInput, new AbortController().signal);
    assert.ok(!claudeArgs(second.calls[0]).includes('--max-turns'));
  });

  test('plan runs in its own scratch root with its own profile and removes it after', async () => {
    let root = '';
    const { calls } = fake([callInit(), result({ structured_output: { plan: 'p', price: 10, confidence: 0.5 } })], {
      peek: (call) => {
        root = realpathSync(join(call.opts.cwd!, '..'));
      },
    });
    const { p, reaps } = provider();
    await p.plan(planInput, new AbortController().signal);
    const c = calls[0];
    const runs = realpathSync(join(tempDir, 'data', 'runs'));
    assert.equal(realpathSync(join(root, '..')), runs);
    assert.match(root.split('/').pop()!, /^call-/);
    assert.ok(c.cwdExisted, 'the empty work dir existed when claude started');
    assert.equal(c.opts.cwd!.split('/').pop(), 'work');
    if (onMac) {
      assert.equal(c.cmd, SANDBOX_EXEC);
      const profile = c.seen['cli.sb']!;
      assert.ok(profile.includes(`(allow file-write* (subpath "${join(root, 'work')}")`), 'writes go to the work dir');
      const writes = profile.split('\n').filter((l) => l.startsWith('(allow file-write*'));
      assert.ok(!writes.some((l) => l.includes(join(root, 'repo'))), 'a scratch profile writes no repo');
      assert.ok(writes.every((l) => !l.includes(root) || l.includes(join(root, 'work')) || l.includes(join(root, 'tmp')) || l.includes(join(root, 'ctmp'))));
      const egressPort = JSON.parse(c.seen['egress.json']!).port as number;
      assert.match(profile, new RegExp(`allow network-outbound \\(remote ip "localhost:${egressPort}"\\)\\)\\n`));
    }
    const env = c.opts.env ?? {};
    assert.equal(env.TMPDIR, join(root, 'ctmp') + '/');
    assert.match(env.HTTPS_PROXY, /^http:\/\/palimpsest:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    assert.ok(!existsSync(root), 'the scratch root is removed when the call ends');
    assert.deepEqual(reaps, [{ root: realpathSync(join(tempDir, 'data', 'runs')) + '/' + root.split('/').pop(), existed: true }], 'the reaper ran on the scratch root before it was removed');
  });

  test('plan init listing any tool or MCP server crashes the call', async () => {
    for (const bad of [{ tools: ['Bash'] }, { tools: ['Read'] }, { mcp_servers: [{ name: 'palimpsest', status: 'connected' }] }, { plugins: [{ name: 'p', path: '/x' }] }, { apiKeySource: 'ANTHROPIC_API_KEY' }]) {
      let root = '';
      const { calls } = fake([callInit(bad), result({ structured_output: { plan: 'p', price: 10, confidence: 0.5 } })], {
        hang: true,
        peek: (call) => {
          root = join(call.opts.cwd!, '..');
        },
      });
      const { p, reaps } = provider();
      await assert.rejects(p.plan(planInput, new AbortController().signal), bad.apiKeySource ? /API key/ : /unexpected/);
      assert.ok(calls[0].kills.includes('SIGTERM'));
      assert.equal(reaps.length, 1);
      assert.ok(reaps[0].existed);
      assert.ok(!existsSync(root));
    }
  });

  test('plan refuses a result that does not match the shape', async () => {
    fake([callInit(), result({ structured_output: { plan: 'p', price: 'lots', confidence: 2 } })]);
    const { p } = provider();
    await assert.rejects(p.plan(planInput, new AbortController().signal), /shape/);
  });

  test('plan takes the result text as JSON when no structured output is present', async () => {
    fake([callInit(), result({ result: '{"plan":"q","price":12,"confidence":0.6}' })]);
    const { p } = provider();
    const out = await p.plan(planInput, new AbortController().signal);
    assert.equal(out.plan, 'q');
    assert.equal(out.price, 12);
  });

  test('an aborted plan call is killed and rejects', async () => {
    const { calls } = fake([callInit()], { hang: true });
    const { p } = provider();
    const ac = new AbortController();
    const pending = p.plan(planInput, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, /aborted/);
    assert.ok(calls[0].kills.includes('SIGTERM'));
  });

  test('review uses the same locked down call and returns the verdict', async () => {
    const { calls } = fake([callInit(), result({ structured_output: { approve: false, notes: 'Misses the entry.', concerns: ['no first entry'] } })]);
    const { p } = provider();
    const out = await p.review(
      { job: makeJob(), agent, persona: 'Bea reviews strictly.', diff: 'diff --git a/docs/CHANGELOG.md b/docs/CHANGELOG.md\n+# Changelog\n', acceptance: ['has a first entry'], checks: [] },
      new AbortController().signal,
    );
    assert.equal(out.approve, false);
    assert.deepEqual(out.concerns, ['no first entry']);
    const a = claudeArgs(calls[0]);
    assert.equal(flagValue(a, '--tools'), '');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(flagValue(a, '--setting-sources'), '');
    assert.deepEqual(Object.keys(JSON.parse(flagValue(a, '--json-schema')).properties).sort(), ['approve', 'concerns', 'notes']);
    assert.match(calls[0].opts.stdin ?? '', /CHANGELOG/);
    assert.match(flagValue(a, '--append-system-prompt'), /Bea reviews strictly\./);
  });
});
