/**
 * The mlx backend (Phase 4 Task 26, ruling 26): the school's graduates served
 * by `mlx_lm.server` over the downloaded base, fenced in the trainer profile
 * on one loopback port. Every child is a fake spawner and the server is a
 * fake HTTP server on port 0 (test safety rule 11: no Python, no mlx_lm);
 * nothing here reaches the network. Temp home only.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner, type SpawnDone, type Spawned, type SpawnLine, type SpawnOpts, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { ensureServer, MLX_GB, MLX_IDLE_MS, mlxProvider, serverState, setPortPicker, setServerTimers, stopServer } from '../engine/market/mlx.js';
import type { RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { loraBaseDir } from '../engine/school/lora.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { localCredits } from '../shared/credits.js';
import { poolOfModel } from '../shared/market-rules.js';
import type { Agent, Job, ModelRef, RunProgress } from '../shared/types.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN'];
const GRAD_1: ModelRef = 'mlx:grad-qwen25c7-1';
const GRAD_2: ModelRef = 'mlx:grad-qwen25c7-2';
const LORA_1 = 'lora-0000000a';
const LORA_2 = 'lora-0000000b';

interface Fake {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  kills: string[];
  end(code: number | null, signal?: string | null): void;
}

let spawned: Fake[];
let saved: Record<string, string | undefined>;
let server: Server | null;
let port: number;
let bodies: Array<Record<string, unknown>>;
let replies: Array<{ json: unknown; delayMs?: number }>;
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;

/**
 * A fake spawner for the server, whose child lives until it is killed or
 * ended. Anything else (the broker's file tools in a work loop, node under
 * the tool profile) goes to the real spawner: no Python is ever started.
 */
const fakeSpawner: Spawner = (cmd, args, opts): Spawned => {
  if (![cmd, ...args].includes('mlx_lm.server')) {
    assert.ok(!/python/.test([cmd, ...args].join(' ')), 'no Python under npm test');
    return realSpawner(cmd, args, opts);
  }
  let closed = false;
  let resolveDone!: (d: SpawnDone) => void;
  const done = new Promise<SpawnDone>((r) => {
    resolveDone = r;
  });
  const waiting: Array<(r: IteratorResult<SpawnLine>) => void> = [];
  const f: Fake = {
    cmd,
    args,
    opts,
    kills: [],
    end(code, signal = null) {
      if (closed) return;
      closed = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
      resolveDone({ code, signal });
    },
  };
  spawned.push(f);
  const lines: AsyncIterable<SpawnLine> = {
    [Symbol.asyncIterator]: () => ({
      next: () => (closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiting.push(r))),
    }),
  };
  return {
    pid: 5151,
    lines,
    kill: (sig = 'SIGTERM') => {
      f.kills.push(sig);
      f.end(null, sig);
    },
    done,
  };
};

/** A fake mlx_lm.server: GET /v1/models answers, POST /v1/chat/completions answers the next scripted reply. */
async function fakeServer(): Promise<void> {
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      bodies.push(JSON.parse(b));
      const reply = replies[bodies.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'script ran out' }));
        return;
      }
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json)), reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  port = (server!.address() as { port: number }).port;
}

/** An OpenAI chat completion as mlx_lm.server answers it. */
function completion(message: Record<string, unknown>, finish = 'stop'): unknown {
  return { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '', ...message }, finish_reason: finish }], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } };
}

function fakePython(): string {
  const p = join(tempDir, 'venv', 'bin', 'python');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '#!/bin/sh\nexit 99\n');
  chmodSync(p, 0o755);
  return p;
}

/** A whole safetensors file as mlx-lm writes one. */
function safetensors(n = 4): Buffer {
  const header = JSON.stringify({ __metadata__: { format: 'mlx' }, 'a.lora_a': { dtype: 'F32', shape: [n], data_offsets: [0, 4 * n] } });
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(header)));
  return Buffer.concat([len, Buffer.from(header), Buffer.alloc(4 * n)]);
}

function baseReady(): void {
  mkdirSync(loraBaseDir(), { recursive: true });
  writeFileSync(join(loraBaseDir(), 'config.json'), '{"model_type":"qwen2"}\n');
  patchSettings({ school: { ...getSettings().school, baseModelReady: true } });
}

function adapterDir(id: string): string {
  return join(paths().school, 'lora', 'adapters', id);
}

/** A LoRA's record and its adapter on disk, as lora.ts leaves them. */
function lora(id: string, status: 'trained' | 'paused' | 'failed', createdAt: string): void {
  const runs = join(paths().school, 'ctl', 'lora');
  mkdirSync(runs, { recursive: true });
  mkdirSync(adapterDir(id), { recursive: true });
  writeFileSync(join(adapterDir(id), 'adapters.safetensors'), safetensors());
  const base = getSettings().school.baseModel;
  writeFileSync(
    join(runs, `${id}.json`),
    JSON.stringify({ id, base, status, reason: null, iters: 600, saved: status === 'trained' ? 600 : 230, examples: 120, createdAt, endedAt: createdAt, trains: [], resumes: [], pauses: [], good: 0, torn: [], optimizerReset: false }),
  );
}

/** A graduate row as Task 27 writes it. */
function graduate(model: ModelRef, loraId: string): void {
  const g = { id: model.slice(4), model, base: getSettings().school.baseModel, loraId, sealed: { mean: 0.6, lo: 0.5, hi: 0.7 }, baseSealed: { mean: 0.4, lo: 0.3, hi: 0.5 }, vsBase: { diff: 0.2, lo: 0.1, hi: 0.3 }, examples: 120, arenas: [], at: '2026-11-12T03:00:00.000Z', agentId: null };
  openDb().prepare('INSERT OR REPLACE INTO graduates (id, json) VALUES (?, ?)').run(g.id, JSON.stringify(g));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function complete(model: ModelRef, text = 'hello'): ReturnType<ReturnType<typeof mlxProvider>['complete']> {
  return mlxProvider().complete({ model, system: 'You help.', turns: [{ role: 'user', content: text }], schema: null, signal: new AbortController().signal, maxMs: 60_000, runId: null });
}

beforeEach(async () => {
  setUp('mlx-provider');
  saved = Object.fromEntries(['PALIMPSEST_PYTHON', ...KEYS].map((k) => [k, process.env[k]]));
  process.env.PALIMPSEST_PYTHON = fakePython();
  for (const k of KEYS) process.env[k] = 'secret-value';
  spawned = [];
  bodies = [];
  replies = [];
  timers = [];
  server = null;
  await fakeServer();
  setSpawner(fakeSpawner);
  setPortPicker(async () => port);
  setServerTimers({
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clear: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  baseReady();
  lora(LORA_1, 'trained', '2026-11-10T03:00:00.000Z');
  lora(LORA_2, 'trained', '2026-11-11T03:00:00.000Z');
  graduate(GRAD_1, LORA_1);
  graduate(GRAD_2, LORA_2);
});

afterEach(async () => {
  await stopServer();
  setPortPicker(null);
  setServerTimers(null);
  setSpawner(realSpawner);
  server?.closeAllConnections();
  if (server) await new Promise((r) => server!.close(r));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await tearDown();
});

test('providerFor mlx returns the mlx backend', () => {
  assert.equal(providerFor(GRAD_1).kind, 'mlx');
  assert.equal(poolOfModel(GRAD_1), 'local');
});

test("a work loop's tool call round-trips", async () => {
  replies = [
    { json: completion({ content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] }, 'tool_calls') },
    // Qwen's own tag in the text, when the server left it unparsed
    { json: completion({ content: '<tool_call>\n{"name": "write_file", "arguments": {"path": "docs/CHANGELOG.md", "content": "# Changelog\\n"}}\n</tool_call>' }) },
    { json: completion({ tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'finish', arguments: '{"summary":"Added the changelog."}' } }] }, 'tool_calls') },
  ];
  const runId = 'run-mlx';
  const runRoot = join(paths().runs, runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const logs: RunLogLine[] = [];
  const job = { id: 'job-1', repo: 'acme/widgets', source: 'issue', issue: 7, url: null, title: 'Add a changelog', body: 'Please add docs/CHANGELOG.md.', scope: ['docs/**'], acceptance: ['docs/CHANGELOG.md exists'], tier: 'normal', value: 60, status: 'running', attempts: 0, postedAt: '2026-11-01T00:00:00.000Z', bidsCloseAt: null, awardedBid: null, runId, floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null } as unknown as Job;
  const agent = { id: 'grad-1', firmId: 'firm-1', name: 'Ada Quarry', model: GRAD_1, instructions: 'Keep changes small.', maxTurns: 25 } as unknown as Agent;
  const input: WorkInput = {
    job, agent, persona: 'Ada is careful.', runId, dir, branch: 'palimpsest/job-1', plan: null, examples: [],
    log: (l) => logs.push(l), onProgress: (_p: Partial<RunProgress>) => {}, signal: new AbortController().signal,
    caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1000 },
  };
  const r = await mlxProvider().work(input);
  assert.equal(r.ended, 'finished', r.reason ?? '');
  assert.equal(r.summary, 'Added the changelog.');
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].stream, false);
  assert.equal('model' in bodies[0], false, 'the request never names a model: the server serves only the one it was started with');
  assert.equal('adapters' in bodies[0], false);
  assert.deepEqual(((bodies[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name).sort(), ['edit_file', 'finish', 'list_files', 'read_file', 'run', 'search', 'write_file']);
  const second = bodies[1].messages as Array<Record<string, unknown>>;
  const asked = second.find((m) => m.role === 'assistant') as { tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  assert.equal(asked.tool_calls[0].id, 'call_1');
  assert.equal(asked.tool_calls[0].type, 'function');
  assert.equal(asked.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(asked.tool_calls[0].function.arguments), { path: 'src/a.ts' });
  const answered = second.find((m) => m.role === 'tool') as { tool_call_id: string; content: string };
  assert.equal(answered.tool_call_id, 'call_1');
  assert.match(answered.content, /export const a = 1/);
  assert.equal(readFileSync(join(dir, 'docs', 'CHANGELOG.md'), 'utf8'), '# Changelog\n');
  assert.equal(spawned.length, 1, 'one server for the whole loop');
});

test('the server starts once under the profile with loopback bind only and stops after 10 idle minutes', async () => {
  delete process.env.PALIMPSEST_SANDBOX;
  replies = [{ json: completion({ content: 'one' }) }, { json: completion({ content: 'two' }) }, { json: completion({ content: 'three' }) }];
  assert.equal((await complete(GRAD_1)).text, 'one');
  assert.equal((await complete(GRAD_1)).text, 'two');
  assert.equal(spawned.length, 1, 'started once');

  const f = spawned[0];
  const profile = join(paths().school, 'ctl', 'trainer-serve.sb');
  assert.deepEqual([f.cmd, ...f.args.slice(0, 2)], ['/usr/bin/sandbox-exec', '-f', profile]);
  const argv = f.args.slice(2);
  assert.equal(argv[0], process.env.PALIMPSEST_PYTHON);
  assert.deepEqual(argv.slice(1, 5), ['-I', '-B', '-m', 'mlx_lm.server']);
  assert.equal(flag(argv, '--model'), loraBaseDir());
  assert.equal(flag(argv, '--adapter-path'), adapterDir(LORA_1));
  assert.equal(flag(argv, '--host'), '127.0.0.1');
  assert.equal(flag(argv, '--port'), String(port));

  const text = readFileSync(profile, 'utf8');
  assert.match(text, /\(deny network\*\)/);
  assert.ok(text.includes(`(allow network-bind (local ip "localhost:${port}"))`));
  assert.ok(text.includes(`(allow network-inbound (local ip "localhost:${port}"))`));
  assert.equal((text.match(/\(allow network/g) ?? []).length, 2, 'bind and inbound on that port only');
  assert.doesNotMatch(text, /network-outbound/);
  // a train's own profile is another file: it never carries the server's port
  assert.doesNotMatch(readFileSyncOr(join(paths().school, 'ctl', 'trainer.sb')), new RegExp(String(port)));

  assert.equal(f.opts.clearEnv, true);
  const env = f.opts.env ?? {};
  assert.equal(env.HF_HUB_OFFLINE, '1');
  for (const k of KEYS) assert.equal(env[k], undefined, `${k} never reaches the server`);
  assert.equal(env.HOME, join(paths().school, 'tmp'));

  // idle: armed after each call at exactly ten minutes, re-armed by the next call
  const live = timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, MLX_IDLE_MS);
  assert.equal(MLX_IDLE_MS, 10 * 60_000);
  assert.equal(timers.length, 2, 'one timer per call, the first cleared by the second');
  assert.deepEqual(f.kills, []);
  live[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(serverState(), null);

  // the next call starts it again
  assert.equal((await complete(GRAD_1)).text, 'three');
  assert.equal(spawned.length, 2);
});

function readFileSyncOr(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

test('a second graduate stops the first server', async () => {
  replies = [{ json: completion({ content: 'first' }) }, { json: completion({ content: 'second' }) }];
  await complete(GRAD_1);
  assert.equal(serverState()?.model, GRAD_1);
  await complete(GRAD_2);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].kills, ['SIGTERM'], 'one server at a time');
  assert.equal(flag(spawned[1].args, '--adapter-path'), adapterDir(LORA_2));
  assert.equal(serverState()?.model, GRAD_2);
  assert.ok(timers.filter((t) => !t.cleared).length === 1, "the first server's idle timer went with it");
});

test('only a trained, whole adapter over the downloaded base is ever served', async () => {
  lora('lora-0000000c', 'paused', '2026-11-12T03:00:00.000Z');
  lora('lora-0000000d', 'failed', '2026-11-12T04:00:00.000Z');
  graduate('mlx:grad-paused', 'lora-0000000c');
  graduate('mlx:grad-failed', 'lora-0000000d');
  await assert.rejects(ensureServer('mlx:grad-paused'), /no trained adapter/);
  await assert.rejects(ensureServer('mlx:grad-failed'), /no trained adapter/);
  await assert.rejects(ensureServer('mlx:grad-unknown'), /no trained adapter/);
  // a torn adapter is not whole
  writeFileSync(join(adapterDir(LORA_1), 'adapters.safetensors'), safetensors().subarray(0, 20));
  await assert.rejects(ensureServer(GRAD_1), /no trained adapter/);
  // no base, no server
  patchSettings({ school: { ...getSettings().school, baseModelReady: false } });
  await assert.rejects(ensureServer(GRAD_2), /base model is not downloaded/);
  assert.equal(spawned.length, 0);
});

test('credits are local by seconds', async () => {
  replies = [{ json: completion({ content: 'slow' }), delayMs: 250 }];
  const r = await complete(GRAD_1);
  assert.equal(r.usage.usd, 0);
  assert.equal(r.usage.weightedTokens, 0);
  assert.ok(r.usage.seconds >= 0.25, `seconds ${r.usage.seconds}`);
  assert.equal(r.usage.credits, Math.round(localCredits(r.usage.seconds, MLX_GB) * 1e6) / 1e6);
  assert.equal(MLX_GB, 4.3);
});
