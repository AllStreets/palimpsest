/**
 * The mlx backend (Phase 4 Task 26, ruling 26): the school's graduates served
 * by `mlx_lm.server` over the downloaded base, fenced in the trainer profile
 * on one loopback port. Every server child is a fake (mlx-fixtures.ts) and
 * the server is a fake HTTP server on port 0 (test safety rule 11: no
 * Python, no mlx_lm); nothing here reaches the network. Temp home only.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { paths } from '../engine/home.js';
import { beginHeavy, ensureServer, GraduatesDown, heavyRunning, MLX_GB, MLX_IDLE_MS, mlxProvider, reapStrayServer, serverPidFile, serverState, STRAY_KILL_GRACE_MS } from '../engine/market/mlx.js';
import type { RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor } from '../engine/market/providers.js';
import { loraBaseDir } from '../engine/school/lora.js';
import { schoolOff, startSchool } from '../engine/school/tick.js';
import { setGate, startTrain } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { localCredits } from '../shared/credits.js';
import { poolOfModel } from '../shared/market-rules.js';
import type { Agent, GateState, Job, ModelRef, RunProgress } from '../shared/types.js';
import { setUp, tearDown } from './guild-fixtures.js';
import { adapterDir, completion, fakeTrainer, GRAD_1, GRAD_2, graduate, installMlx, KEYS, lora, LORA_1, LORA_2, safetensors, SERVER_PID, uninstallMlx, until, type Mlx } from './mlx-fixtures.js';

let m: Mlx;
let spawned: Mlx['spawned'];
let bodies: Mlx['bodies'];
let timers: Mlx['timers'];
let port: number;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function complete(model: ModelRef, text = 'hello', signal = new AbortController().signal): ReturnType<ReturnType<typeof mlxProvider>['complete']> {
  return mlxProvider().complete({ model, system: 'You help.', turns: [{ role: 'user', content: text }], schema: null, signal, maxMs: 60_000, runId: null });
}

beforeEach(async () => {
  setUp('mlx-provider');
  m = await installMlx();
  ({ spawned, bodies, timers, port } = m);
});

afterEach(async () => {
  setGate(null);
  await uninstallMlx();
  await tearDown();
});

// ---------------------------------------------------------------- fix round 1

function okGate(kind: 'light' | 'heavy'): GateState {
  return { kind, ok: true, reason: null, power: 'ac', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

test('turning the school off stops the server, a call in flight ending with an error', async () => {
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  m.replies = [{ json: completion({ content: 'never' }), delayMs: 30_000 }];
  const call = complete(GRAD_1);
  await until(() => bodies.length === 1);
  schoolOff();
  await assert.rejects(call, /stopped|abort/i);
  assert.deepEqual(spawned[0].kills, ['SIGTERM']);
  assert.equal(serverState(), null);
});

function workInput(runId: string): WorkInput {
  const runRoot = join(paths().runs, runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const job = { id: 'job-1', repo: 'acme/widgets', source: 'issue', issue: 7, url: null, title: 'Add a changelog', body: 'Please add docs/CHANGELOG.md.', scope: ['docs/**'], acceptance: ['docs/CHANGELOG.md exists'], tier: 'normal', value: 60, status: 'running', attempts: 0, postedAt: '2026-11-01T00:00:00.000Z', bidsCloseAt: null, awardedBid: null, runId, floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null } as unknown as Job;
  const agent = { id: 'grad-1', firmId: 'firm-1', name: 'Ada Quarry', model: GRAD_1, instructions: 'Keep changes small.', maxTurns: 25 } as unknown as Agent;
  return {
    job, agent, persona: 'Ada is careful.', runId, dir, branch: 'palimpsest/job-1', plan: null, examples: [],
    log: () => {}, onProgress: (_p: Partial<RunProgress>) => {}, signal: new AbortController().signal,
    caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1000 },
  };
}

test('a tick that starts no train leaves a serving graduate alone', async () => {
  patchSettings({ school: { ...getSettings().school, enabled: true, baseModelReady: true } });
  await ensureServer(GRAD_1);
  const school = startSchool({
    intervalMs: 3_600_000,
    gate: async (kind) => okGate(kind as 'light'),
    labels: () => ({}) as never,
    ask: () => [],
    act: async () => 0,
    // nothing paused to resume, no voyage due, the LoRA refused: no train starts
    resume: async () => [],
    sail: async () => null,
    lora: async () => ({ status: 'refused' }),
  });
  try {
    const r = await school.tick(Date.now());
    assert.equal(r.reason, null);
  } finally {
    school.stop();
  }
  assert.deepEqual(spawned[0].kills, [], 'the server kept running');
  assert.equal(serverState()?.model, GRAD_1);
  assert.equal(heavyRunning(), null);
});

test('a heavy train waits for the calls in flight, stops the server and keeps it down while it runs', async () => {
  m.replies = [{ json: completion({ content: 'finished first' }), delayMs: 300 }, { json: completion({ content: 'after the train' }) }];
  const order: string[] = [];
  const call = complete(GRAD_1).then((r) => {
    order.push(`call ${r.text}`);
    return r;
  });
  await until(() => bodies.length === 1);
  const giveBack = await beginHeavy('a lora train');
  order.push('train');
  assert.equal((await call).text, 'finished first', 'the call in flight was not cut');
  assert.deepEqual(order, ['call finished first', 'train']);
  assert.deepEqual(spawned[0].kills, ['SIGTERM']);
  assert.equal(serverState(), null);

  // while it runs: refused in plain words, nothing started
  assert.equal(heavyRunning(), 'a lora train');
  await assert.rejects(ensureServer(GRAD_1), (err: Error) => err instanceof GraduatesDown && err.message === "The school's graduates are not served while a lora train runs");
  await assert.rejects(complete(GRAD_1), /not served while a lora train runs/);
  // a market run on a graduate: the model is unavailable, the job goes back to the board unspent
  const w = await mlxProvider().work(workInput('run-down'));
  assert.equal(w.ended, 'crashed');
  assert.equal(w.spendsAttempt, false);
  assert.match(w.reason ?? '', /not served while a lora train runs/);
  assert.equal(spawned.length, 1);

  giveBack();
  giveBack();
  assert.equal(heavyRunning(), null);
  assert.equal((await complete(GRAD_1)).text, 'after the train');
  assert.equal(spawned.length, 2);
});

test('a run whose next turn finds a train holding the machine goes back to the board unspent', async () => {
  m.replies = [{ json: completion({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] }, 'tool_calls'), delayMs: 300 }];
  const run = mlxProvider().work(workInput('run-between'));
  await until(() => bodies.length === 1);
  const giveBack = await beginHeavy('a voyage');
  try {
    const r = await run;
    assert.equal(r.ended, 'crashed');
    assert.equal(r.spendsAttempt, false);
    assert.equal(r.reason, "The school's graduates are not served while a voyage runs");
    assert.equal(bodies.length, 1, 'the first turn finished; the second never reached a server');
  } finally {
    giveBack();
  }
});

test('a heavy startTrain takes the machine only once its gate holds, and gives it back when the train ends', async () => {
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  await ensureServer(GRAD_1);
  // a closed gate starts nothing: the server is left alone
  setGate(async (kind) => ({ ...okGate(kind as 'heavy'), ok: false, reason: 'on battery' }));
  const waiting = await startTrain({ kind: 'lora', gate: 'heavy', command: { cmd: 'sleep' }, gb: 4.3, onLine: () => {} });
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(spawned[0].kills, []);
  assert.equal(serverState()?.model, GRAD_1);

  // an open gate: the server stops before the trainer spawns, and stays down until it ends
  setGate(async (kind) => okGate(kind as 'heavy'));
  let serverAtSpawn: ReturnType<typeof serverState> | undefined;
  let downAtSpawn: string | null = null;
  const trainer = fakeTrainer(() => {
    serverAtSpawn = serverState();
    downAtSpawn = heavyRunning();
  });
  const train = startTrain({ kind: 'lora', gate: 'heavy', command: { cmd: 'sleep' }, gb: 4.3, onLine: () => {} });
  await until(() => trainer.started);
  assert.equal(serverAtSpawn, null);
  assert.equal(downAtSpawn, 'a lora train');
  assert.deepEqual(spawned[0].kills, ['SIGTERM']);
  await assert.rejects(ensureServer(GRAD_1), GraduatesDown);
  trainer.end();
  assert.equal((await train).status, 'done');
  assert.equal(heavyRunning(), null);

  // a light train (the nets) never touches the server
  await ensureServer(GRAD_1);
  const light = fakeTrainer(() => {});
  const nets = startTrain({ kind: 'nets', gate: 'light', command: { cmd: 'sleep' }, gb: 0.01, onLine: () => {} });
  await until(() => light.started);
  assert.equal(serverState()?.model, GRAD_1);
  assert.equal(heavyRunning(), null);
  light.end();
  await nets;
});

test("the server's pid is kept under ctl while it runs and gone when it stops", async () => {
  await ensureServer(GRAD_1);
  const rec = JSON.parse(readFileSync(serverPidFile(), 'utf8')) as { pid: number; base: string; port: number };
  assert.equal(serverPidFile(), join(paths().school, 'ctl', 'mlx-server.json'));
  assert.equal(rec.pid, SERVER_PID);
  assert.equal(rec.base, loraBaseDir());
  assert.equal(rec.port, port);
  spawned[0].end(null, 'SIGTERM');
  await until(() => !existsSync(serverPidFile()));
});

test('a stray server left by the last engine is killed only while its command line is still ours', async () => {
  const write = (pid: number) => {
    mkdirSync(join(serverPidFile(), '..'), { recursive: true });
    writeFileSync(serverPidFile(), JSON.stringify({ pid, port: 50123, model: GRAD_1, adapterId: LORA_1, base: loraBaseDir(), at: '2026-11-12T03:00:00.000Z' }));
  };
  // ours: SIGTERM to the group now, SIGKILL after the grace
  write(7001);
  m.ps.set(7001, `/venv/bin/python -I -B -m mlx_lm.server --model ${loraBaseDir()} --adapter-path ${adapterDir(LORA_1)} --host 127.0.0.1 --port 50123`);
  assert.equal(await reapStrayServer(), true);
  assert.deepEqual(m.kills, [{ pid: 7001, signal: 'SIGTERM' }]);
  assert.equal(STRAY_KILL_GRACE_MS, 10_000);
  assert.equal(existsSync(serverPidFile()), false);

  // a reused pid running something else is never signalled
  m.kills.length = 0;
  write(7002);
  m.ps.set(7002, '/usr/bin/vim notes.txt');
  assert.equal(await reapStrayServer(), false);
  // an mlx_lm.server over another base is not ours either
  write(7003);
  m.ps.set(7003, '/x/python -m mlx_lm.server --model /elsewhere/base --port 1');
  assert.equal(await reapStrayServer(), false);
  // a pid that is gone
  write(7004);
  assert.equal(await reapStrayServer(), false);
  assert.deepEqual(m.kills, []);
  assert.equal(existsSync(serverPidFile()), false);
  // no file: nothing looked up
  const before = m.runs.length;
  assert.equal(await reapStrayServer(), false);
  assert.equal(m.runs.length, before);
});

test('a port that answers but is not held by our child is never trusted', async () => {
  m.listeners = [SERVER_PID, 9999];
  await assert.rejects(ensureServer(GRAD_1), /not from the mlx server the engine started/);
  assert.deepEqual(spawned[0].kills, ['SIGTERM']);
  m.listeners = [9999];
  await assert.rejects(ensureServer(GRAD_1), /not from the mlx server/);
  m.listeners = [SERVER_PID];
  await ensureServer(GRAD_1);
  const lsof = m.runs.filter((r) => r[0] === '/usr/sbin/lsof').at(-1)!;
  assert.deepEqual(lsof, ['/usr/sbin/lsof', '-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
});

// ---------------------------------------------------------------- the backend

test('providerFor mlx returns the mlx backend', () => {
  assert.equal(providerFor(GRAD_1).kind, 'mlx');
  assert.equal(poolOfModel(GRAD_1), 'local');
});

test("a work loop's tool call round-trips", async () => {
  m.replies = [
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
  m.replies = [{ json: completion({ content: 'one' }) }, { json: completion({ content: 'two' }) }, { json: completion({ content: 'three' }) }];
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
  m.replies = [{ json: completion({ content: 'first' }) }, { json: completion({ content: 'second' }) }];
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
  m.replies = [{ json: completion({ content: 'slow' }), delayMs: 250 }];
  const r = await complete(GRAD_1);
  assert.equal(r.usage.usd, 0);
  assert.equal(r.usage.weightedTokens, 0);
  assert.ok(r.usage.seconds >= 0.25, `seconds ${r.usage.seconds}`);
  assert.equal(r.usage.credits, Math.round(localCredits(r.usage.seconds, MLX_GB) * 1e6) / 1e6);
  assert.equal(MLX_GB, 4.3);
});
