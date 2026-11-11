/**
 * The Anthropic API backend (Task 10). A fake HTTP server on port 0 stands
 * in for the API base and a fake runner answers `security`; no key is ever
 * read from his keychain and the real API is never called.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { describeCommand, realRunner, realSpawner, setRunner, setSpawner, type Runner, type Spawned } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import { API_PRICES, KEY_SERVICE, anthropicProvider, apiKey, removeApiKey, setApiKey, usdFor } from '../engine/market/anthropic-api.js';
import { resetBudget } from '../engine/market/budget.js';
import type { AuditInput, RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { apiCredits } from '../shared/credits.js';
import type { Agent, Job, Repo, RunProgress } from '../shared/types.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'ANTHROPIC_API_KEY'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let server: Server | null = null;
let fakeKc: string;

const KEY = 'sk-ant-api03-TESTKEY0123456789abcdefABCDEF_-xyz';

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-anthropic-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  process.env.PALIMPSEST_SANDBOX = 'off';
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ENV-KEY-NEVER-USED';
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  // A stand-in keychain file: the fakes never open it, and real security never sees it.
  fakeKc = join(tempDir, 'fake.keychain-db');
  writeFileSync(fakeKc, '');
  resetBudget();
});

afterEach(async () => {
  resetBudget();
  setRunner(realRunner);
  setSpawner(realSpawner);
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** A fake `security`: holds one keychain item in memory. */
function fakeSecurity(initial: string | null = KEY): { calls: string[][]; stored: () => string | null; set: (v: string | null) => void } {
  let item = initial;
  const calls: string[][] = [];
  const r: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== '/usr/bin/security') throw new Error(`unexpected ${cmd}`);
    const service = args[args.indexOf('-s') + 1];
    if (service !== KEY_SERVICE) return { stdout: '', stderr: 'wrong service', code: 44 };
    if (args[0] === 'find-generic-password') return item ? { stdout: item + '\n', stderr: '', code: 0 } : { stdout: '', stderr: 'not found', code: 44 };
    if (args[0] === 'add-generic-password') {
      item = args[args.indexOf('-w') + 1];
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'delete-generic-password') {
      item = null;
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'unknown', code: 1 };
  };
  setRunner(r);
  return { calls, stored: () => item, set: (v: string | null) => (item = v) };
}

interface ShellSpawn {
  cmd: string;
  args: string[];
  stdin: string;
  env: Record<string, string> | undefined;
  clearEnv: boolean;
}

/** A fake `security -i`: applies add-generic-password lines from stdin to the fake keychain. Anything unexpected lands in `problems`. */
function fakeSecurityShell(sec: { set: (v: string | null) => void }, exitCode = 0): { spawns: ShellSpawn[]; problems: string[] } {
  const spawns: ShellSpawn[] = [];
  const problems: string[] = [];
  setSpawner((cmd, args, opts): Spawned => {
    spawns.push({ cmd, args, stdin: opts.stdin ?? '', env: opts.env, clearEnv: !!opts.clearEnv });
    const m = /-w "([^"]+)"/.exec(opts.stdin ?? '');
    if ([cmd, ...args].join(' ') !== '/usr/bin/security -i') problems.push(`unexpected spawn ${cmd}`);
    else if (!m) problems.push('no -w in the stdin command');
    else if (exitCode === 0) sec.set(m[1]);
    const code = problems.length ? 99 : exitCode;
    return { pid: 1, kill: () => {}, done: Promise.resolve({ code, signal: null }), lines: (async function* () {})() };
  });
  return { spawns, problems };
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };
interface Reply {
  blocks: Block[];
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function sse(reply: Reply, n: number): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const u = reply.usage ?? { input_tokens: 100, output_tokens: 20 };
  let out = ev('message_start', {
    message: { id: `msg_${n}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', usage: { input_tokens: u.input_tokens, output_tokens: 1, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } },
  });
  out += ev('ping', {});
  reply.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(0, 3) } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(3) } });
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${n}_${index}`, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: reply.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: u.output_tokens } });
  out += ev('message_stop', {});
  return out;
}

async function fakeApi(replies: Reply[]): Promise<{ base: string; requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown>; url: string }> }> {
  const requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown>; url: string }> = [];
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(b || '{}'), url: req.url ?? '' });
      const reply = replies[requests.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script ran out' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(reply, requests.length));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, requests };
}

function makeJob(): Job {
  return {
    id: 'job-1', repo: 'acme/widgets', source: 'issue', issue: 7, url: null, title: 'Add a changelog',
    body: 'Please add `docs/CHANGELOG.md`.', scope: ['docs/**'], acceptance: ['docs/CHANGELOG.md exists'], tier: 'normal', value: 60,
    status: 'running', attempts: 0, postedAt: '2026-11-01T00:00:00.000Z', bidsCloseAt: null, awardedBid: null, runId: 'run-1',
    floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null,
  };
}
const MODEL = 'anthropic:claude-sonnet-5-5';
const agent = { id: 'agent-api', firmId: 'firm-1', name: 'Vera', model: MODEL, instructions: 'Keep changes small.', maxTurns: 25 } as unknown as Agent;

function workInput(runId: string) {
  const runRoot = join(tempDir, 'data', 'runs', runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const logs: RunLogLine[] = [];
  const ticks: Partial<RunProgress>[] = [];
  const input: WorkInput = {
    job: makeJob(), agent, persona: 'Vera is exact.', runId, dir, branch: 'palimpsest/job-1', plan: null, examples: [],
    log: (l) => logs.push(l), onProgress: (p) => ticks.push(p), signal: new AbortController().signal,
    caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1000 },
  };
  return { input, logs, ticks };
}

function enable(dailyUsd = 5) {
  patchSettings({ anthropicApi: { enabled: true, dailyUsd } });
}

const planInput = () => ({ job: makeJob(), agent, persona: 'Vera', repoSummary: 'A widget library.', examples: [] });
const PLAN_REPLY: Reply = { blocks: [{ type: 'text', text: JSON.stringify({ plan: '1. Add it.', price: 30, confidence: 0.7 }) }] };

describe('anthropic api', () => {
  test('is registered for anthropic: models', () => {
    assert.equal(providerFor(MODEL).kind, 'anthropic');
  });

  test('settings fill anthropicApi defaults key by key', () => {
    patchSettings({ anthropicApi: { enabled: true } as never });
    assert.deepEqual(getSettings().anthropicApi, { enabled: true, dailyUsd: 5 });
  });

  test('the backend refuses while disabled', async () => {
    const sec = fakeSecurity();
    const api = await fakeApi([PLAN_REPLY]);
    const p = anthropicProvider({ baseUrl: api.base, keychain: fakeKc });
    const { input } = workInput('run-off');
    const r = await p.work(input);
    assert.equal(r.ended, 'crashed');
    assert.match(r.reason ?? '', /off/);
    await assert.rejects(p.plan(planInput(), new AbortController().signal), /off/);
    await assert.rejects(p.review({ job: makeJob(), agent, persona: 'V', diff: '+x', acceptance: [], checks: [] }, new AbortController().signal), /off/);
    patchSettings({ anthropicApi: { enabled: true, dailyUsd: 0 } });
    await assert.rejects(p.plan(planInput(), new AbortController().signal), /off|daily/);
    assert.equal(sec.calls.length, 0, 'the key is never read while the backend is off');
    assert.equal(api.requests.length, 0);
  });

  test('the backend refuses without a key and never falls back to ANTHROPIC_API_KEY', async () => {
    fakeSecurity(null);
    const api = await fakeApi([PLAN_REPLY]);
    enable();
    await assert.rejects(anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).plan(planInput(), new AbortController().signal), /no API key/);
    assert.equal(api.requests.length, 0);
  });

  test('usage converts to dollars and credits', async () => {
    const m = 1_000_000;
    const sonnet = API_PRICES.sonnet;
    assert.ok(Math.abs(usdFor({ input: m, output: m, cacheRead: m, cacheCreation: m }, 'claude-sonnet-5-5') - (sonnet.input + sonnet.output + sonnet.input * 0.1 + sonnet.input * 1.25)) < 1e-9);
    assert.equal(usdFor({ input: m, output: 0, cacheRead: 0, cacheCreation: 0 }, 'claude-mystery-9'), API_PRICES.opus.input);

    fakeSecurity();
    const api = await fakeApi([{ ...PLAN_REPLY, usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 4000 } }]);
    enable();
    const plan = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).plan(planInput(), new AbortController().signal);
    const usd = usdFor({ input: 2000, output: 1000, cacheRead: 10_000, cacheCreation: 4000 }, 'claude-sonnet-5-5');
    assert.equal(plan.price, 30);
    assert.equal(plan.usage.usd, usd);
    assert.equal(plan.usage.credits, apiCredits(usd));
    const rows = openDb().prepare('SELECT kind, amount, usd, firm_id FROM credits').all() as Array<{ kind: string; amount: number; usd: number; firm_id: string }>;
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: 'bid', amount: apiCredits(usd), usd, firm_id: 'firm-1' }]);
    assert.equal(api.requests[0].body.stream, true);
    assert.equal(api.requests[0].body.model, 'claude-sonnet-5-5');
  });

  test('the daily dollar cap stops the next call', async () => {
    fakeSecurity();
    const api = await fakeApi([
      { blocks: [{ type: 'tool_use', name: 'list_files', input: {} }], usage: { input_tokens: 100_000, output_tokens: 50_000 } },
      { blocks: [{ type: 'tool_use', name: 'finish', input: { summary: 'never' } }] },
    ]);
    enable(1);
    const { input } = workInput('run-cap');
    const r = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).work(input);
    assert.equal(r.ended, 'capped');
    assert.match(r.reason ?? '', /daily/);
    assert.equal(api.requests.length, 1);
    const spent = (openDb().prepare('SELECT SUM(usd) AS u FROM credits').get() as { u: number }).u;
    assert.ok(spent > 1);
    assert.equal(r.usage.usd, spent);
  });

  test('the key is read through security and never appears in the log', async () => {
    const sec = fakeSecurity();
    const api = await fakeApi([
      { blocks: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', name: 'run', input: { command: 'echo "key=${ANTHROPIC_API_KEY:-none}"' } }] },
      { blocks: [{ type: 'tool_use', name: 'finish', input: { summary: 'Added it.' } }] },
    ]);
    enable();
    const { input, logs } = workInput('run-key');
    const r = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).work(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    assert.equal(r.summary, 'Added it.');
    assert.ok(sec.calls.some((c) => c.join(' ') === `/usr/bin/security find-generic-password -s ${KEY_SERVICE} -w ${fakeKc}`));
    for (const req of api.requests) {
      assert.equal(req.headers['x-api-key'], KEY);
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.url, '/v1/messages');
      assert.doesNotMatch(JSON.stringify(req.body), /TESTKEY/);
    }
    // The tool result went back to the model in the API's own shape, and the command saw no key.
    const second = api.requests[1].body.messages as Array<{ role: string; content: unknown }>;
    const results = second.at(-1)!.content as Array<{ type: string; tool_use_id: string; content: string }>;
    assert.equal(results[0].type, 'tool_result');
    assert.equal(results[0].tool_use_id, 'toolu_1_1');
    assert.match(results[0].content, /key=none/);
    const everything = JSON.stringify(logs) + JSON.stringify(entries()) + JSON.stringify(openDb().prepare('SELECT * FROM credits').all());
    assert.doesNotMatch(everything, /TESTKEY/);
    assert.doesNotMatch(everything, /ENV-KEY/);
  });

  test('setApiKey feeds security -i on stdin, removeApiKey deletes, and both record without the key', async () => {
    const sec = fakeSecurity(null);
    const shell = fakeSecurityShell(sec);
    const kc = { keychain: fakeKc };
    assert.equal(await apiKey(kc), null);
    await setApiKey(KEY, kc);
    assert.deepEqual(shell.problems, []);
    assert.equal(sec.stored(), KEY);
    assert.equal(await apiKey(kc), KEY);
    assert.equal(shell.spawns.length, 1);
    assert.deepEqual([shell.spawns[0].cmd, ...shell.spawns[0].args], ['/usr/bin/security', '-i']);
    assert.equal(shell.spawns[0].stdin, `add-generic-password -U -a "palimpsest" -s "Palimpsest Anthropic API key" -w "${KEY}" "${fakeKc}"\n`);
    assert.equal(shell.spawns[0].clearEnv, true);
    assert.doesNotMatch(JSON.stringify(shell.spawns.map((x) => [x.cmd, ...x.args, x.env])), /TESTKEY/);
    assert.doesNotMatch(JSON.stringify(sec.calls), /TESTKEY/);
    await removeApiKey(kc);
    assert.equal(sec.stored(), null);
    const kinds = entries().map((e) => e.kind);
    assert.ok(kinds.includes('api.key.set'));
    assert.ok(kinds.includes('api.key.removed'));
    assert.doesNotMatch(JSON.stringify(entries()), /TESTKEY/);
    await assert.rejects(setApiKey('-w evil', kc), /not an Anthropic API key/);
    await assert.rejects(setApiKey('sk-ant-abc" -w "x', kc), /not an Anthropic API key/);
  });

  test('under tests the key functions refuse without a temp keychain and run no security', async () => {
    const sec = fakeSecurity(KEY);
    const shell = fakeSecurityShell(sec);
    const outside = join(tempDir, 'outside.keychain-db');
    symlinkSync('/etc/hosts', outside);
    for (const o of [{}, { keychain: outside }, { keychain: 'relative.keychain-db' }, { keychain: join(tempDir, 'fake.txt') }]) {
      await assert.rejects(apiKey(o), /temp dir|absolute path/);
      await assert.rejects(setApiKey(KEY, o), /temp dir|absolute path/);
      await assert.rejects(removeApiKey(o), /temp dir|absolute path/);
    }
    // The provider asks for the key the same way.
    patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
    await assert.rejects(anthropicProvider({ baseUrl: 'http://127.0.0.1:9' }).plan(planInput(), new AbortController().signal), /temp dir/);
    assert.equal(sec.calls.length, 0);
    assert.equal(shell.spawns.length, 0);
    assert.equal(sec.stored(), KEY);
  });

  test('a failing security call never carries the key in its error, and keeps its cause', async () => {
    setSpawner(() => {
      throw new Error(`spawn refused for -w ${KEY}`);
    });
    await assert.rejects(setApiKey(KEY, { keychain: fakeKc }), (err: Error) => !err.message.includes('TESTKEY') && /did not store the key: Error: spawn refused for -w \[key\]/.test(err.message));
    fakeSecurityShell(fakeSecurity(null), 44);
    await assert.rejects(setApiKey(KEY, { keychain: fakeKc }), /security exited 44/);
    // The real runner and spawner never print a security argv either.
    await assert.rejects(realRunner('/usr/bin/security', ['add-generic-password', '-w', KEY]), (err: Error) => !err.message.includes('TESTKEY'));
    assert.throws(() => realSpawner('/bin/sh', ['-c', `security add-generic-password -w ${KEY}`], {}), (err: Error) => !err.message.includes('TESTKEY'));
    assert.equal(describeCommand('/usr/bin/security', ['find-generic-password', '-w', 'x']), '/usr/bin/security find-generic-password [arguments hidden]');
  });

  test('a named keychain that does not exist is refused before security runs', async () => {
    const sec = fakeSecurity(null);
    const shell = fakeSecurityShell(sec);
    await assert.rejects(setApiKey(KEY, { keychain: join(tempDir, 'missing.keychain-db') }), /does not exist/);
    await assert.rejects(apiKey({ keychain: join(tempDir, 'missing.keychain-db') }), /does not exist/);
    assert.equal(shell.spawns.length, 0);
    assert.equal(sec.calls.length, 0);
  });

  // Real security, only with PALIMPSEST_REAL_SECURITY_TEST=1 and only against a keychain this test makes in the temp dir.
  test('the key round-trips through a throwaway keychain, never on an argv and never echoed', { skip: process.env.PALIMPSEST_REAL_SECURITY_TEST !== '1' || process.platform !== 'darwin' }, async () => {
    const tmp = realpathSync(tmpdir());
    const kc = join(tempDir, 'throwaway.keychain-db');
    assert.ok(kc.startsWith(tmp + '/'), 'the throwaway keychain lies inside the temp dir');
    const savedList = execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    /** Every security call of the test but the restore below: refuses any keychain path outside the temp dir. */
    const realSecurity = (args: string[], stdin?: string): string => {
      const paths = [...args, ...(stdin ? [...stdin.matchAll(/"([^"]+\.keychain(?:-db)?)"/g)].map((m) => m[1]) : [])].filter((a) => /\.keychain(-db)?$/.test(a));
      for (const p of paths) {
        if (!realpathSync(join(p, '..')).startsWith(tmp + '/')) throw new Error(`refused: ${p} lies outside the temp dir`);
      }
      return execFileSync('/usr/bin/security', args, { encoding: 'utf8', ...(stdin === undefined ? {} : { input: stdin }) });
    };
    /** Puts back the user search list exactly as read before the keychain was made; the only call that names a path outside the temp dir. */
    const restoreList = () => execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...savedList]);
    const problems: string[] = [];
    try {
      realSecurity(['create-keychain', '-p', 'throwaway', kc]);
      realSecurity(['unlock-keychain', '-p', 'throwaway', kc]);
      const argvs: string[][] = [];
      const output: string[] = [];
      setSpawner((cmd, args, opts): Spawned => {
        argvs.push([cmd, ...args]);
        const fail = (why: string): Spawned => {
          problems.push(why);
          return { pid: null, kill: () => {}, done: Promise.resolve({ code: 99, signal: null }), lines: (async function* () {})() };
        };
        if ([cmd, ...args].join(' ') !== '/usr/bin/security -i') return fail(`unexpected spawn ${cmd}`);
        if (!opts.stdin?.endsWith(`"${kc}"\n`)) return fail('a stdin command that does not name the throwaway keychain');
        let out: string;
        try {
          out = realSecurity(args, opts.stdin);
        } catch (err) {
          return fail(`security -i failed: ${(err as Error).message.split('\n')[0]}`);
        }
        output.push(out);
        return { pid: null, kill: () => {}, done: Promise.resolve({ code: 0, signal: null }), lines: (async function* () {})() };
      });
      setRunner(async (cmd, args) => {
        argvs.push([cmd, ...args]);
        if (args.at(-1) !== kc) {
          problems.push(`a runner call that does not name the throwaway keychain: ${args[0]}`);
          return { stdout: '', stderr: '', code: 99 };
        }
        try {
          return { stdout: realSecurity(args), stderr: '', code: 0 };
        } catch (err) {
          return { stdout: '', stderr: '', code: Number((err as { status?: unknown }).status) || 1 };
        }
      });
      assert.equal(await apiKey({ keychain: kc }), null);
      await setApiKey(KEY, { keychain: kc });
      assert.equal(await apiKey({ keychain: kc }), KEY);
      const next = 'sk-ant-api03-SECONDKEY0123456789';
      await setApiKey(next, { keychain: kc });
      assert.equal(await apiKey({ keychain: kc }), next);
      await removeApiKey({ keychain: kc });
      assert.equal(await apiKey({ keychain: kc }), null);
      assert.deepEqual(problems, []);
      assert.doesNotMatch(JSON.stringify(argvs), /TESTKEY|SECONDKEY/);
      assert.doesNotMatch(output.join(''), /TESTKEY|SECONDKEY/);
    } finally {
      try {
        realSecurity(['delete-keychain', kc]);
      } finally {
        restoreList();
      }
    }
  });

  test('judge sends both images to the API', async () => {
    fakeSecurity();
    const api = await fakeApi([{ blocks: [{ type: 'text', text: JSON.stringify({ before: 4, after: 7, notes: 'Better.' }) }] }]);
    enable();
    const before = Buffer.from('before-png').toString('base64');
    const after = Buffer.from('after-png').toString('base64');
    const r = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).judge({ bar: 'Hairline rules.', before: [before], after: [after], diff: null }, new AbortController().signal);
    assert.equal(r.after, 7);
    const content = (api.requests[0].body.messages as Array<{ content: Array<{ type: string; source?: { data: string } }> }>)[0].content;
    assert.deepEqual(content.filter((b) => b.type === 'image').map((b) => b.source!.data), [before, after]);
  });

  test('only the real API base or loopback is accepted', () => {
    assert.throws(() => anthropicProvider({ baseUrl: 'https://evil.example.com' }), /base/);
  });
});

/* ------------------------------------------------------------------ */
/* audit() (Phase 3)                                                   */
/* ------------------------------------------------------------------ */

const AUDIT_ANSWER = { claims: 1, findings: [{ claim: 'Supports hot reload', source: { file: 'README.md', line: 3 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/a.ts', line: 1, note: 'no watcher' }], proposal: null }] };

function auditInput(auditId: string) {
  const { input: w, logs, ticks } = workInput(auditId);
  const input: AuditInput = {
    repo: { fullName: 'acme/widgets', defaultBranch: 'main' } as Repo,
    auditId,
    dir: w.dir,
    baseSha: 'b'.repeat(40),
    readme: { path: 'README.md', text: '# Widgets\n\nSupports hot reload.\n' },
    docs: [],
    checks: null,
    model: MODEL,
    log: (l) => logs.push(l),
    onProgress: (p) => ticks.push(p),
    signal: new AbortController().signal,
    caps: { maxTurns: 40, maxMinutes: 25, maxCredits: 40 },
  };
  return { input, logs };
}

describe('anthropic api audit', () => {
  test('audit runs the read-only loop and charges kind audit under the city, never a firm', async () => {
    fakeSecurity();
    const api = await fakeApi([
      { blocks: [{ type: 'tool_use', name: 'read_file', input: { path: 'src/a.ts' } }, { type: 'tool_use', name: 'edit_file', input: { path: 'src/a.ts', old_text: '1', new_text: '2' } }] },
      { blocks: [{ type: 'text', text: JSON.stringify(AUDIT_ANSWER) }] },
    ]);
    enable();
    const { input } = auditInput('audit-api');
    const r = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).audit(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    assert.deepEqual(r.answer, AUDIT_ANSWER);
    assert.ok(r.usage.usd > 0);
    assert.equal(api.requests.length, 2);
    assert.deepEqual((api.requests[0].body.tools as Array<{ name: string }>).map((t) => t.name), ['read_file', 'list_files', 'search', 'run']);
    assert.match(String(api.requests[0].body.system), /change nothing/i);
    const results = (api.requests[1].body.messages as Array<{ role: string; content: Array<{ type: string; content?: string; is_error?: boolean }> }>).at(-1)!.content;
    assert.equal(results.length, 2);
    assert.match(results[0].content ?? '', /export const a = 1/);
    assert.match(results[1].content ?? '', /no tool named/);
    const rows = openDb().prepare('SELECT kind, firm_id, run_id FROM credits').all() as Array<{ kind: string; firm_id: string | null; run_id: string | null }>;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual({ ...row }, { kind: 'audit', firm_id: null, run_id: 'audit-api' });
  });

  test('an audit while the backend is off is crashed with the reason and calls nothing', async () => {
    const sec = fakeSecurity();
    const api = await fakeApi([]);
    const r = await anthropicProvider({ baseUrl: api.base, keychain: fakeKc }).audit(auditInput('audit-off').input);
    assert.equal(r.ended, 'crashed');
    assert.match(r.reason ?? '', /off/);
    assert.equal(api.requests.length, 0);
    assert.equal(sec.calls.length, 0);
  });
});
