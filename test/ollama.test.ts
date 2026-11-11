/**
 * The Ollama backend (Task 10). A fake HTTP server on port 0 stands in for
 * Ollama (settings.ollamaHost points at it) and a fake runner answers
 * `ollama list` and `ollama show`; no real model is ever called.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { modelGBFromShow, ollamaProvider, resetOllamaCache, REVIEW_NUM_CTX } from '../engine/market/ollama.js';
import type { AuditInput, RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { patchSettings } from '../engine/settings.js';
import { localCredits } from '../shared/credits.js';
import type { Agent, Job, Repo, RunProgress } from '../shared/types.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let server: Server | null = null;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-ollama-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  process.env.PALIMPSEST_SANDBOX = 'off';
  resetOllamaCache();
});

afterEach(async () => {
  setRunner(realRunner);
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const SHOW_7B = `  Model
    architecture        qwen2
    parameters          7.6B
    context length      32768
    embedding length    3584
    quantization        Q4_K_M

  Capabilities
    completion
    tools
`;

const LIST = `NAME                          ID              SIZE      MODIFIED
qwen2.5-coder:7b              2b0496514337    4.7 GB    3 weeks ago
qwen2.5vl:7b-q4_K_M           5ced39dfa4ba    6.0 GB    3 weeks ago
`;

function fakeRunner(): { calls: string[][] } {
  const calls: string[][] = [];
  const r: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'ollama') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'show') return { stdout: SHOW_7B, stderr: '', code: 0 };
    if (args[0] === 'list') return { stdout: LIST, stderr: '', code: 0 };
    return { stdout: '', stderr: 'no', code: 1 };
  };
  setRunner(r);
  return { calls };
}

type Reply = { stream: unknown[] } | { json: unknown };

/** A fake Ollama: answers each POST /api/chat with the next scripted reply and keeps every request body. */
async function fakeOllama(replies: Reply[]): Promise<{ bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      bodies.push(JSON.parse(b));
      const reply = replies[bodies.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'script ran out' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if ('json' in reply) res.end(JSON.stringify(reply.json));
      else res.end(reply.stream.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as { port: number }).port;
  patchSettings({ ollamaHost: `127.0.0.1:${port}` });
  return { bodies };
}

const MODEL = 'qwen2.5-coder:7b';
const msg = (content: string, extra: Record<string, unknown> = {}) => ({ model: MODEL, message: { role: 'assistant', content, ...extra }, done: false });
const done = (seconds: number) => ({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, total_duration: seconds * 1e9, prompt_eval_count: 300, eval_count: 40 });
const toolCall = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

function makeJob(): Job {
  return {
    id: 'job-1', repo: 'acme/widgets', source: 'issue', issue: 7, url: null, title: 'Add a changelog',
    body: 'Please add `docs/CHANGELOG.md`.', scope: ['docs/**'], acceptance: ['docs/CHANGELOG.md exists'], tier: 'normal', value: 60,
    status: 'running', attempts: 0, postedAt: '2026-11-01T00:00:00.000Z', bidsCloseAt: null, awardedBid: null, runId: 'run-1',
    floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null,
  };
}
const agent = { id: 'agent-1', firmId: 'firm-1', name: 'Wren', model: `ollama:${MODEL}`, instructions: 'Keep changes small.', maxTurns: 25 } as unknown as Agent;

function workInput(runId: string) {
  const runRoot = join(tempDir, 'data', 'runs', runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const logs: RunLogLine[] = [];
  const ticks: Partial<RunProgress>[] = [];
  const input: WorkInput = {
    job: makeJob(), agent, persona: 'Wren is quick.', runId, dir, branch: 'palimpsest/job-1', plan: null, examples: [],
    log: (l) => logs.push(l), onProgress: (p) => ticks.push(p), signal: new AbortController().signal,
    caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1000 },
  };
  return { input, logs, ticks, dir };
}

const GB_7B = (7.6 * 4.5) / 8;

describe('ollama', () => {
  test('is registered for ollama: models', () => {
    assert.equal(providerFor('ollama:qwen3:1.7b').kind, 'ollama');
  });

  test('model size comes from ollama show', () => {
    assert.equal(modelGBFromShow(SHOW_7B), GB_7B);
    assert.equal(modelGBFromShow('  Model\n    parameters 20.9B\n    quantization MXFP4\n'), (20.9 * 4.25) / 8);
    assert.equal(modelGBFromShow('  Model\n    parameters 1.7B\n    quantization F16\n'), (1.7 * 16) / 8);
    assert.equal(modelGBFromShow('garbage'), null);
  });

  test('streams a tool call and its result', async () => {
    fakeRunner();
    const { bodies } = await fakeOllama([
      { stream: [msg('Let me look.'), msg('', { tool_calls: [toolCall('read_file', { path: 'src/a.ts' })] }), done(2)] },
      { stream: [msg('', { tool_calls: [toolCall('write_file', { path: 'docs/CHANGELOG.md', content: '# Changelog\n' })] }), done(1)] },
      { stream: [msg('', { tool_calls: [toolCall('finish', { summary: 'Added the changelog.' })] }), done(1)] },
    ]);
    const { input, dir } = workInput('run-stream');
    const r = await ollamaProvider().work(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    assert.equal(r.summary, 'Added the changelog.');
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].stream, true);
    assert.equal(bodies[0].model, MODEL);
    assert.deepEqual(((bodies[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name).sort(), ['edit_file', 'finish', 'list_files', 'read_file', 'run', 'search', 'write_file']);
    const second = bodies[1].messages as Array<Record<string, unknown>>;
    const assistantTurn = second.find((m) => m.role === 'assistant') as { tool_calls: Array<{ function: { name: string; arguments: unknown } }> };
    assert.equal(assistantTurn.tool_calls[0].function.name, 'read_file');
    assert.deepEqual(assistantTurn.tool_calls[0].function.arguments, { path: 'src/a.ts' });
    const toolMsg = second.find((m) => m.role === 'tool') as { content: string; tool_name: string };
    assert.equal(toolMsg.tool_name, 'read_file');
    assert.match(toolMsg.content, /export const a = 1/);
    assert.equal(readFileSync(join(dir, 'docs', 'CHANGELOG.md'), 'utf8'), '# Changelog\n');
  });

  test('an Ollama turn with too many tool calls is cut and the model is told', async () => {
    fakeRunner();
    const calls = Array.from({ length: 33 }, (_, n) => toolCall('write_file', { path: `f${n}.md`, content: 'x' }));
    const { bodies } = await fakeOllama([
      { stream: [msg('', { tool_calls: calls }), done(1)] },
      { stream: [msg('', { tool_calls: [toolCall('finish', { summary: 'ok' })] }), done(1)] },
    ]);
    const { input, dir } = workInput('run-many');
    const r = await ollamaProvider().work(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    const last = (bodies[1].messages as Array<{ role: string; content: string }>).at(-1)!;
    assert.equal(last.role, 'user');
    assert.match(last.content, /more than 32 tool calls/);
    assert.throws(() => readFileSync(join(dir, 'f0.md')));
  });

  test('credits come from seconds and model size', async () => {
    const { calls } = fakeRunner();
    await fakeOllama([
      { stream: [msg('', { tool_calls: [toolCall('list_files', {})] }), done(30)] },
      { stream: [msg('', { tool_calls: [toolCall('finish', { summary: 'ok' })] }), done(12)] },
      { json: { model: MODEL, message: { role: 'assistant', content: JSON.stringify({ plan: '1. Add it.', price: 30, confidence: 0.6 }) }, done: true, total_duration: 5e9 } },
    ]);
    const { input } = workInput('run-credits');
    const p = ollamaProvider();
    const r = await p.work(input);
    assert.equal(r.usage.seconds, 42);
    assert.equal(r.usage.usd, 0);
    assert.equal(r.usage.credits, Math.round(localCredits(42, GB_7B) * 1e6) / 1e6);
    const plan = await p.plan({ job: makeJob(), agent, persona: 'Wren', repoSummary: 'A widget library.', examples: [] }, new AbortController().signal);
    assert.equal(plan.price, 30);
    assert.equal(plan.usage.seconds, 5);
    assert.equal(plan.usage.credits, Math.round(localCredits(5, GB_7B) * 1e6) / 1e6);
    // `ollama show` once per model, cached.
    assert.equal(calls.filter((c) => c[1] === 'show').length, 1);
    assert.deepEqual(calls.find((c) => c[1] === 'show'), ['ollama', 'show', MODEL]);
  });

  test('plan and review are single json calls and a bad shape is refused', async () => {
    fakeRunner();
    const { bodies } = await fakeOllama([
      { json: { message: { role: 'assistant', content: JSON.stringify({ approve: true, notes: 'Fine.', concerns: [] }) }, done: true, total_duration: 1e9, prompt_eval_count: 300 } },
      { json: { message: { role: 'assistant', content: JSON.stringify({ plan: 'x', price: 'lots', confidence: 2 }) }, done: true, total_duration: 1e9 } },
    ]);
    const p = ollamaProvider();
    const review = await p.review({ job: makeJob(), agent, persona: 'Wren', diff: '+x', acceptance: [], checks: [] }, new AbortController().signal);
    assert.equal(review.approve, true);
    assert.equal(bodies[0].format, 'json');
    assert.equal(bodies[0].stream, false);
    // A review reads the whole diff: a 32k context, not Ollama's small default.
    assert.equal((bodies[0].options as { num_ctx?: number } | undefined)?.num_ctx, 32768);
    await assert.rejects(p.plan({ job: makeJob(), agent, persona: 'Wren', repoSummary: '', examples: [] }, new AbortController().signal), /shape/);
  });

  test('judge sends both images', async () => {
    const { calls } = fakeRunner();
    const { bodies } = await fakeOllama([
      { json: { message: { role: 'assistant', content: JSON.stringify({ before: 5, after: 8, notes: 'Calmer.' }) }, done: true, total_duration: 3e9, prompt_eval_count: 300 } },
    ]);
    const before = Buffer.from('before-png').toString('base64');
    const after = Buffer.from('after-png').toString('base64');
    const r = await ollamaProvider().judge({ bar: 'Hairline rules, no glow.', before: [before], after: [`data:image/png;base64,${after}`], diff: '+x' }, new AbortController().signal);
    assert.equal(r.before, 5);
    assert.equal(r.after, 8);
    assert.equal(bodies[0].model, 'qwen2.5vl:7b-q4_K_M');
    assert.equal((bodies[0].options as { num_ctx?: number } | undefined)?.num_ctx, 32768);
    const images = (bodies[0].messages as Array<{ images?: string[] }>).flatMap((m) => m.images ?? []);
    assert.deepEqual(images, [before, after]);
    assert.ok(calls.some((c) => c[1] === 'list'));
  });

  test('judge falls back to the diff text only when no image exists', async () => {
    fakeRunner();
    const { bodies } = await fakeOllama([{ json: { message: { role: 'assistant', content: JSON.stringify({ after: 6, notes: 'Plain.' }) }, done: true, total_duration: 1e9, prompt_eval_count: 300 } }]);
    const r = await ollamaProvider().judge({ bar: 'Hairline rules.', before: [], after: [], diff: '+<div class="glow">' }, new AbortController().signal);
    assert.equal(r.before, null);
    assert.equal(r.after, 6);
    assert.match(r.notes, /diff text alone/);
    const m = bodies[0].messages as Array<{ content: string; images?: string[] }>;
    assert.ok(m.every((x) => !x.images || x.images.length === 0));
    assert.ok(m.some((x) => x.content.includes('glow')));
  });

  test('a review or judge whose prompt filled the context is too large, never a pass', async () => {
    fakeRunner();
    // Ollama cuts the front of a prompt that overflows num_ctx and says nothing but the count it read.
    const full = { prompt_eval_count: 32_768 - 100, total_duration: 2e9, done: true };
    await fakeOllama([
      { json: { message: { role: 'assistant', content: JSON.stringify({ approve: true, notes: 'Fine.', concerns: [] }) }, ...full } },
      { json: { message: { role: 'assistant', content: JSON.stringify({ before: 5, after: 9, notes: 'Lovely.' }) }, ...full } },
      { json: { message: { role: 'assistant', content: JSON.stringify({ approve: true, notes: 'Fine.', concerns: [] }) }, done: true, total_duration: 1e9, prompt_eval_count: 32_768 - 600 } },
    ]);
    const p = ollamaProvider();
    const { TooLargeError } = await import('../engine/market/ollama.js');
    const rv = p.review({ job: makeJob(), agent, persona: 'Wren', diff: '+x', acceptance: [], checks: [] }, new AbortController().signal);
    await assert.rejects(rv, (err: unknown) => err instanceof TooLargeError && /too large to review/.test((err as Error).message));
    const png = Buffer.from('png').toString('base64');
    await assert.rejects(p.judge({ bar: 'x', before: [png], after: [png], diff: '+x' }, new AbortController().signal), TooLargeError);
    // Below the margin the answer stands.
    const ok = await p.review({ job: makeJob(), agent, persona: 'Wren', diff: '+x', acceptance: [], checks: [] }, new AbortController().signal);
    assert.equal(ok.approve, true);
  });

  test('a review or judge with no prompt count is too large, and an overlong prompt is refused before any call', async () => {
    fakeRunner();
    const { bodies } = await fakeOllama([
      { json: { message: { role: 'assistant', content: JSON.stringify({ approve: true, notes: 'Fine.', concerns: [] }) }, done: true, total_duration: 1e9 } },
      { json: { message: { role: 'assistant', content: JSON.stringify({ before: 5, after: 9, notes: 'Lovely.' }) }, done: true, total_duration: 1e9, prompt_eval_count: 0 } },
    ]);
    const p = ollamaProvider();
    const { TooLargeError } = await import('../engine/market/ollama.js');
    const input = (diff: string) => ({ job: makeJob(), agent, persona: 'Wren', diff, acceptance: [], checks: [] });
    // Ollama said nothing about how much it read: never taken as fitting.
    await assert.rejects(p.review(input('+x'), new AbortController().signal), (e: unknown) => e instanceof TooLargeError && /too large to review/.test((e as Error).message));
    const png = Buffer.from('png').toString('base64');
    await assert.rejects(p.judge({ bar: 'x', before: [png], after: [png], diff: '+x' }, new AbortController().signal), TooLargeError);
    assert.equal(bodies.length, 2);
    // Dense text whose characters over 1.5 pass num_ctx minus the margin is refused unsent, whatever Ollama would say.
    const dense = '+' + '\u6f22'.repeat(50_000);
    await assert.rejects(p.review(input(dense), new AbortController().signal), TooLargeError);
    await assert.rejects(p.judge({ bar: 'x', before: [], after: [], diff: dense }, new AbortController().signal), TooLargeError);
    assert.equal(bodies.length, 2, 'no call was made for an overlong prompt');
  });

  test('the acceptance lines and the instructions come after the diff', async () => {
    const { reviewPrompt } = await import('../engine/market/claude.js');
    const { judgeText } = await import('../engine/market/ollama.js');
    const prompt = reviewPrompt({ job: makeJob(), agent, persona: 'Wren', diff: '+PADDING', acceptance: ['the changelog has an entry'], checks: [] });
    const at = (s: string) => prompt.indexOf(s);
    assert.ok(at('PADDING') > 0);
    assert.ok(at('the changelog has an entry') > at('PADDING'), 'acceptance after the diff');
    assert.ok(at('Approve only if') > at('PADDING'), 'instructions after the diff');
    const judge = judgeText({ bar: 'Hairline rules.', before: [], after: [], diff: '+PADDING' }, 0, 0);
    assert.ok(judge.indexOf('Hairline rules.') > judge.indexOf('PADDING'), 'the bar after the diff');
  });

  test('judge refuses an image that is not base64', async () => {
    fakeRunner();
    await fakeOllama([]);
    await assert.rejects(ollamaProvider().judge({ bar: 'x', before: [], after: ['not base64!'], diff: null }, new AbortController().signal), /base64/);
  });

  test('refuses an ollamaHost that is not loopback', async () => {
    fakeRunner();
    patchSettings({ ollamaHost: 'example.com:11434' });
    const { input } = workInput('run-host');
    const r = await ollamaProvider().work(input);
    assert.equal(r.ended, 'crashed');
    assert.match(r.reason ?? '', /loopback/);
  });
});

/* ------------------------------------------------------------------ */
/* audit() (Phase 3)                                                   */
/* ------------------------------------------------------------------ */

const AUDIT_ANSWER = { claims: 1, findings: [{ claim: 'Supports hot reload', source: { file: 'README.md', line: 3 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/a.ts', line: 1, note: 'no watcher' }], proposal: null }] };

function auditInput(auditId: string) {
  const { dir, logs, ticks } = workInput(auditId);
  const input: AuditInput = {
    repo: { fullName: 'acme/widgets', defaultBranch: 'main' } as Repo,
    auditId,
    dir,
    baseSha: 'b'.repeat(40),
    readme: { path: 'README.md', text: '# Widgets\n\nSupports hot reload.\n' },
    docs: [],
    checks: { test: 'echo tested', typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: [], install: null, ecosystems: ['npm'], detected: true },
    model: `ollama:${MODEL}`,
    log: (l) => logs.push(l),
    onProgress: (p) => ticks.push(p),
    signal: new AbortController().signal,
    caps: { maxTurns: 40, maxMinutes: 25, maxCredits: 40 },
  };
  return { input, logs, dir };
}

describe('ollama audit', () => {
  test('audit runs the read-only loop with num_ctx, the four read tools, the local caps and a JSON finish', async () => {
    fakeRunner();
    const { bodies } = await fakeOllama([
      { stream: [msg('', { tool_calls: [toolCall('read_file', { path: 'src/a.ts' }), toolCall('write_file', { path: 'src/b.ts', content: 'x' }), toolCall('run', { command: 'echo nope' })] }), done(2)] },
      { stream: [msg(JSON.stringify(AUDIT_ANSWER)), done(1)] },
    ]);
    const { input, dir } = auditInput('audit-ollama');
    const r = await ollamaProvider().audit(input);
    assert.equal(r.ended, 'finished', r.reason ?? '');
    assert.deepEqual(r.answer, AUDIT_ANSWER);
    assert.equal(r.usage.seconds, 3);
    assert.equal(r.usage.credits, Math.round(localCredits(3, GB_7B) * 1e6) / 1e6);
    assert.equal(bodies.length, 2);
    assert.deepEqual((bodies[0].options as { num_ctx: number }).num_ctx, REVIEW_NUM_CTX);
    assert.deepEqual((bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name), ['read_file', 'list_files', 'search', 'run']);
    const first = bodies[0].messages as Array<{ role: string; content: string }>;
    assert.match(first[0].content, /change nothing/i);
    assert.match(first[1].content, /Supports hot reload\./);
    assert.match(first[1].content, /echo tested/);
    const tools = (bodies[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool');
    assert.equal(tools.length, 3);
    assert.match(tools[0].content, /export const a = 1/);
    assert.match(tools[1].content, /no tool named/);
    assert.match(tools[2].content, /^Refused:.*own checks/);
    assert.ok(!existsSync(join(dir, 'src', 'b.ts')));
  });
});
