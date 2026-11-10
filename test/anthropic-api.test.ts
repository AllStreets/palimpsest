/**
 * The Anthropic API backend (Task 10). A fake HTTP server on port 0 stands
 * in for the API base and a fake runner answers `security`; no key is ever
 * read from his keychain and the real API is never called.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import { API_PRICES, KEY_SERVICE, anthropicProvider, apiKey, removeApiKey, setApiKey, usdFor } from '../engine/market/anthropic-api.js';
import { resetBudget } from '../engine/market/budget.js';
import type { RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { apiCredits } from '../shared/credits.js';
import type { Agent, Job, RunProgress } from '../shared/types.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'ANTHROPIC_API_KEY'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let server: Server | null = null;

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
  resetBudget();
});

afterEach(async () => {
  resetBudget();
  setRunner(realRunner);
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** A fake `security`: holds one keychain item in memory. */
function fakeSecurity(initial: string | null = KEY): { calls: string[][]; stored: () => string | null } {
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
  return { calls, stored: () => item };
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
    const p = anthropicProvider({ baseUrl: api.base });
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
    await assert.rejects(anthropicProvider({ baseUrl: api.base }).plan(planInput(), new AbortController().signal), /no API key/);
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
    const plan = await anthropicProvider({ baseUrl: api.base }).plan(planInput(), new AbortController().signal);
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
    const r = await anthropicProvider({ baseUrl: api.base }).work(input);
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
    const r = await anthropicProvider({ baseUrl: api.base }).work(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    assert.equal(r.summary, 'Added it.');
    assert.ok(sec.calls.some((c) => c.join(' ') === `/usr/bin/security find-generic-password -s ${KEY_SERVICE} -w`));
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

  test('setApiKey and removeApiKey go through security and record without the key', async () => {
    const sec = fakeSecurity(null);
    assert.equal(await apiKey(), null);
    await setApiKey(KEY);
    assert.equal(sec.stored(), KEY);
    assert.equal(await apiKey(), KEY);
    const add = sec.calls.find((c) => c[1] === 'add-generic-password')!;
    assert.ok(add.includes('-U'));
    await removeApiKey();
    assert.equal(sec.stored(), null);
    const kinds = entries().map((e) => e.kind);
    assert.ok(kinds.includes('api.key.set'));
    assert.ok(kinds.includes('api.key.removed'));
    assert.doesNotMatch(JSON.stringify(entries()), /TESTKEY/);
    await assert.rejects(setApiKey('-w evil'), /not an Anthropic API key/);
  });

  test('a failing security call never carries the key in its error', async () => {
    setRunner(async () => {
      throw new Error(`security add-generic-password -w ${KEY} timed out`);
    });
    await assert.rejects(setApiKey(KEY), (err: Error) => !err.message.includes('TESTKEY'));
  });

  test('judge sends both images to the API', async () => {
    fakeSecurity();
    const api = await fakeApi([{ blocks: [{ type: 'text', text: JSON.stringify({ before: 4, after: 7, notes: 'Better.' }) }] }]);
    enable();
    const before = Buffer.from('before-png').toString('base64');
    const after = Buffer.from('after-png').toString('base64');
    const r = await anthropicProvider({ baseUrl: api.base }).judge({ bar: 'Hairline rules.', before: [before], after: [after], diff: null }, new AbortController().signal);
    assert.equal(r.after, 7);
    const content = (api.requests[0].body.messages as Array<{ content: Array<{ type: string; source?: { data: string } }> }>)[0].content;
    assert.deepEqual(content.filter((b) => b.type === 'image').map((b) => b.source!.data), [before, after]);
  });

  test('only the real API base or loopback is accepted', () => {
    assert.throws(() => anthropicProvider({ baseUrl: 'https://evil.example.com' }), /base/);
  });
});
