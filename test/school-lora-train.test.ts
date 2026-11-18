/**
 * LoRA training and the base model download (Phase 4 Task 25, ruling 24).
 * Every child is a fake spawner and every gate reading a fake (test safety
 * rule 11: no Python, no mlx_lm, no download); the download's proxy is a
 * fake egress, so nothing here reaches the network. Temp home only.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realSpawner, setSpawner, type SpawnDone, type Spawned, type SpawnLine, type SpawnOpts, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries } from '../engine/ledger.js';
import { hostAllowed, type Egress } from '../engine/market/egress.js';
import type { LoraData, LoraExample, LoraSkip } from '../engine/school/lora.js';
import {
  adapterIntact,
  downloadBase,
  HF_HOSTS,
  loraBaseDir,
  loraRuns,
  setEgressStarter,
  setLoraDataBuilder,
  stopDownload,
  trainedAdapter,
  trainLora,
} from '../engine/school/lora.js';
import { schoolView } from '../engine/school/api.js';
import { startSchool } from '../engine/school/tick.js';
import { liveTrains, pauseAll, setGate } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { LORA } from '../shared/school-rules.js';
import type { GateState, SchoolSettings } from '../shared/types.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

/** 03:00 local on 12 November 2026: inside the window. */
const NIGHT = new Date(2026, 10, 12, 3, 0).getTime();
const BASE_REPO = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN'];

interface Fake {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  kills: string[];
  push(line: string): void;
  end(code: number | null, signal?: string | null): void;
}

let spawned: Fake[];
let saved: Record<string, string | undefined>;
let built: Array<{ now: number; check: boolean | undefined }>;
let skips: Partial<Record<LoraSkip, number>> = {};
let examples: number;
let stages: Array<{ stage: string; hosts: string[] }>;
let egressClosed: number;

const fakeSpawner: Spawner = (cmd, args, opts): Spawned => {
  const buffered: SpawnLine[] = [];
  const waiting: Array<(r: IteratorResult<SpawnLine>) => void> = [];
  let closed = false;
  let resolveDone!: (d: SpawnDone) => void;
  const done = new Promise<SpawnDone>((r) => {
    resolveDone = r;
  });
  const f: Fake = {
    cmd,
    args,
    opts,
    kills: [],
    push(line) {
      const w = waiting.shift();
      if (w) w({ value: { stream: 'stdout', line }, done: false });
      else buffered.push({ stream: 'stdout', line });
    },
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
      next: () => {
        const l = buffered.shift();
        if (l) return Promise.resolve({ value: l, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => waiting.push(r));
      },
    }),
  };
  return { pid: 4242, lines, kill: (sig = 'SIGTERM') => f.kills.push(sig), done };
};

function ok(): GateState {
  return { kind: 'heavy', ok: true, reason: null, power: 'ac', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

function school(p: Partial<SchoolSettings>): void {
  patchSettings({ school: { ...getSettings().school, ...p } });
}

/** A file standing in for the trainer's Python; never run. */
function fakePython(): string {
  const p = join(tempDir, 'venv', 'bin', 'python');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '#!/bin/sh\nexit 99\n');
  chmodSync(p, 0o755);
  return p;
}

/** A whole safetensors file as mlx-lm writes one: two F32 tensors of `n` values, filled with `fill`. */
function safetensors(n: number, fill = 1): Buffer {
  const header = JSON.stringify({ __metadata__: { format: 'mlx' }, 'a.lora_a': { dtype: 'F32', shape: [n], data_offsets: [0, 4 * n] }, 'a.lora_b': { dtype: 'F32', shape: [n, 1], data_offsets: [4 * n, 8 * n] } });
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(header)));
  const data = Buffer.alloc(8 * n);
  for (let i = 0; i < 2 * n; i++) data.writeFloatLE(fill, 4 * i);
  return Buffer.concat([len, Buffer.from(header), data]);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** The base model as a finished download leaves it: its config on disk and the setting on. */
function baseReady(): void {
  mkdirSync(loraBaseDir(), { recursive: true });
  writeFileSync(join(loraBaseDir(), 'config.json'), '{"model_type":"qwen2"}\n');
  school({ baseModelReady: true });
}

/** A dataset of `examples` chats, written where buildLoraData writes, the newest 10% held for validation. */
async function fakeData(now: number, o: { check?: boolean } = {}): Promise<LoraData> {
  built.push({ now, check: o.check });
  const all: LoraExample[] = Array.from({ length: examples }, (_, i) => ({
    repo: 'acme/widgets',
    ref: `commit:${String(i).padStart(40, '0')}`,
    sha: String(i).padStart(40, '0'),
    at: new Date(NIGHT - (examples - i) * 3_600_000).toISOString(),
    tokens: 40,
    messages: [
      { role: 'system', content: 'Reply with JSON only.' },
      { role: 'user', content: `change ${i}` },
      { role: 'assistant', content: '{"action":"answer","answer":{"edits":[]}}' },
    ],
  }));
  const dir = join(paths().school, 'lora', 'data');
  mkdirSync(dir, { recursive: true });
  const nValid = all.length ? Math.max(1, Math.round(all.length * 0.1)) : 0;
  const line = (e: LoraExample) => `${JSON.stringify({ messages: e.messages })}\n`;
  writeFileSync(join(dir, 'train.jsonl'), all.slice(0, all.length - nValid).map(line).join(''));
  writeFileSync(join(dir, 'valid.jsonl'), all.slice(all.length - nValid).map(line).join(''));
  return { examples: all, skipped: { sealed: 0, secret: 0, 'too-large': 0, 'too-long': 0, 'not-unique': 0, 'no-edit': 0, ...skips }, path: join(dir, 'train.jsonl'), validPath: join(dir, 'valid.jsonl'), failed: {} };
}

function fakeEgress(): Egress {
  return {
    port: 54321,
    token: 'tok123',
    setStage(stage, hosts) {
      stages.push({ stage, hosts: [...hosts] });
    },
    onRefused() {
      return () => {};
    },
    async close() {
      egressClosed++;
    },
  };
}

function command(f: Fake): { id: number; cmd: string; args: string[]; start: number; of: number; repo?: string; dir?: string } {
  return JSON.parse(String(f.opts.stdin).trim());
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Ends a lora_train child as school.py would after `step` steps, with `saved` the last step written. */
function finish(f: Fake, step: number, saved: number, o: { stopped?: boolean; ok?: boolean } = {}): void {
  f.push(JSON.stringify({ id: 1, step, of: LORA.iters }));
  f.push(JSON.stringify({ id: 1, saved }));
  if (o.ok === false) f.push(JSON.stringify({ id: 1, ok: false, error: 'MemoryError: out of memory' }));
  else f.push(JSON.stringify({ id: 1, ok: true, step, of: LORA.iters, stopped: o.stopped ?? false, adapter: 'x' }));
  f.end(0);
}

beforeEach(() => {
  setUp('school-lora-train');
  saved = Object.fromEntries(['PALIMPSEST_PYTHON', 'PALIMPSEST_SANDBOX', ...KEYS].map((k) => [k, process.env[k]]));
  process.env.PALIMPSEST_PYTHON = fakePython();
  for (const k of KEYS) process.env[k] = 'secret-value';
  spawned = [];
  built = [];
  examples = LORA.min;
  skips = {};
  stages = [];
  egressClosed = 0;
  setSpawner(fakeSpawner);
  setGate(async (kind) => ({ ...ok(), kind }));
  setLoraDataBuilder(fakeData);
  setEgressStarter(async () => fakeEgress());
  school({ enabled: true });
});

afterEach(async () => {
  await pauseAll('the test ended');
  stopDownload();
  for (const f of spawned) f.end(null, 'SIGKILL');
  await flush();
  setGate(null);
  setLoraDataBuilder(null);
  setEgressStarter(null);
  setSpawner(realSpawner);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await tearDown();
});

test('training is refused until the base is downloaded', async () => {
  const r = await trainLora(NIGHT);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'The base model is not downloaded');
  assert.equal(spawned.length, 0);
  assert.equal(built.length, 0, 'no data is built for a train that cannot run');

  // the setting alone is not enough: the files must be there
  school({ baseModelReady: true });
  const missing = await trainLora(NIGHT);
  assert.equal(missing.status, 'refused');
  assert.equal(missing.reason, 'The base model is not downloaded');
  assert.equal(spawned.length, 0);
  assert.deepEqual(loraRuns(), []);
});

test('refused under 100 examples with the count', async () => {
  baseReady();
  examples = 99;
  const r = await trainLora(NIGHT);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, '99 of 100 verified changes');
  assert.equal(spawned.length, 0);
  assert.deepEqual(loraRuns(), []);
  assert.deepEqual(built, [{ now: NIGHT, check: true }], 'the data is built with the gated test checks on');

  examples = 0;
  assert.equal((await trainLora(NIGHT)).reason, '0 of 100 verified changes');
});

test('the argv carries --max-seq-length 4096, the ruling\'s flags, the trainer profile and HF_HUB_OFFLINE', async () => {
  delete process.env.PALIMPSEST_SANDBOX;
  baseReady();
  const p = trainLora(NIGHT);
  await flush();
  assert.equal(spawned.length, 1);
  const f = spawned[0];
  const run = loraRuns()[0];
  assert.ok(run, 'the run is recorded before it trains');
  const dir = join(paths().school, 'lora', 'adapters', run.id);
  const data = join(dir, 'data');

  // the trainer profile wraps school.py
  assert.equal(f.cmd, '/usr/bin/sandbox-exec');
  assert.equal(f.args[0], '-f');
  assert.equal(f.args[1], join(paths().school, 'ctl', 'trainer.sb'));
  assert.ok(f.args[3].endsWith(join('trainer', 'school.py')));

  const c = command(f);
  assert.equal(c.cmd, 'lora_train');
  assert.equal(c.start, 0);
  assert.equal(c.of, 600);
  assert.deepEqual(c.args, [
    '--model', loraBaseDir(),
    '--train',
    '--data', data,
    '--fine-tune-type', 'lora',
    '--num-layers', '16',
    '--batch-size', '2',
    '--iters', '600',
    '--learning-rate', '1e-5',
    '--max-seq-length', '4096',
    '--mask-prompt',
    '--grad-checkpoint',
    '--save-every', '50',
    '--adapter-path', dir,
  ]);

  // the run trains on its own copy of the data, so a resume trains on the same examples
  const train = readFileSync(join(data, 'train.jsonl'), 'utf8').trim().split('\n');
  const valid = readFileSync(join(data, 'valid.jsonl'), 'utf8').trim().split('\n');
  assert.equal(train.length, 90);
  assert.equal(valid.length, 10);
  assert.ok(valid.length >= LORA.batch, 'LORA.min keeps the validation set at least a batch');

  assert.equal(f.opts.env?.HF_HUB_OFFLINE, '1');
  assert.equal(f.opts.clearEnv, true);
  for (const k of [...KEYS, 'HTTPS_PROXY', 'HF_HUB_DISABLE_XET']) assert.equal(f.opts.env?.[k], undefined, k);

  writeFileSync(join(dir, 'adapters.safetensors'), safetensors(16));
  finish(f, 600, 600);
  const r = await p;
  assert.equal(r.status, 'trained');
  assert.equal(r.train?.kind, 'lora');
  assert.equal(r.lora?.saved, 600);
  assert.deepEqual(trainedAdapter(), { id: run.id, path: dir, file: join(dir, 'adapters.safetensors') });
  // a trained adapter is not trained again
  const again = await trainLora(NIGHT + 60_000);
  assert.equal(again.status, 'trained');
  assert.equal(spawned.length, 1);
});

test('a pause at step 230 resumes with --resume-adapter-file adapters.safetensors and --iters 370 and records optimizerReset', async () => {
  baseReady();
  const first = trainLora(NIGHT);
  await flush();
  const f = spawned[0];
  const run = loraRuns()[0];
  const dir = join(paths().school, 'lora', 'adapters', run.id);
  // what school.py leaves on disk at a save
  writeFileSync(join(dir, 'adapters.safetensors'), safetensors(16));
  f.push(JSON.stringify({ id: 1, step: 200, of: 600 }));
  f.push(JSON.stringify({ id: 1, saved: 200 }));
  f.push(JSON.stringify({ id: 1, step: 230, of: 600 }));
  await flush();
  await pauseAll('on battery');
  assert.deepEqual(f.kills, ['SIGTERM']);
  // school.py writes the step it reached on SIGTERM
  finish(f, 230, 230, { stopped: true });
  const paused = await first;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'on battery');
  assert.equal(paused.train?.steps?.lost, 0);
  assert.equal(paused.lora?.saved, 230);
  assert.equal(loraRuns()[0].status, 'paused');

  const second = trainLora(NIGHT + 86_400_000);
  await flush();
  assert.equal(spawned.length, 2);
  assert.equal(built.length, 1, 'a resume trains on the data it started with');
  const c = command(spawned[1]);
  assert.equal(flag(c.args, '--resume-adapter-file'), join(dir, 'adapters.safetensors'));
  assert.equal(flag(c.args, '--iters'), '370');
  assert.equal(flag(c.args, '--adapter-path'), dir);
  assert.equal(c.start, 230);
  assert.equal(c.of, 600);

  const started = entries().filter((e) => e.kind === 'train.started');
  assert.equal(started.length, 2);
  assert.deepEqual((started[1].data as { lora?: unknown }).lora, { id: run.id, from: 230, iters: 370, optimizerReset: true });
  assert.deepEqual(loraRuns()[0].resumes, [{ at: new Date(NIGHT + 86_400_000).toISOString(), from: 230, iters: 370, optimizerReset: true }]);
  spawned[1].push(JSON.stringify({ id: 1, step: 240, of: 600 }));
  await flush();
  assert.equal(liveTrains()[0].steps?.optimizerReset, true, 'the resumed train says its optimiser restarted');

  finish(spawned[1], 600, 600);
  const done = await second;
  assert.equal(done.status, 'trained');
  assert.equal(done.train?.steps?.optimizerReset, true);
  assert.equal(done.lora?.optimizerReset, true);
});

test('a paused adapter is never evaluated', async () => {
  baseReady();
  const first = trainLora(NIGHT);
  await flush();
  const run = loraRuns()[0];
  const dir = join(paths().school, 'lora', 'adapters', run.id);
  writeFileSync(join(dir, 'adapters.safetensors'), safetensors(16));
  spawned[0].push(JSON.stringify({ id: 1, step: 200, of: 600 }));
  spawned[0].push(JSON.stringify({ id: 1, saved: 200 }));
  spawned[0].push(JSON.stringify({ id: 1, step: 230, of: 600 }));
  await flush();
  await pauseAll('he is back');
  // SIGKILL came before school.py could save: the 30 steps since the last save are lost
  spawned[0].end(null, 'SIGKILL');
  const paused = await first;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.train?.steps?.lost, 30);
  assert.equal(paused.lora?.saved, 200);
  assert.ok(existsSync(join(dir, 'adapters.safetensors')), 'the half-trained adapter is on disk');
  assert.equal(trainedAdapter(), null, 'and is never offered for evaluation');

  // a run that exits 0 but answers an error is not trained either
  const second = trainLora(NIGHT + 86_400_000);
  await flush();
  assert.equal(flag(command(spawned[1]).args, '--iters'), '400');
  finish(spawned[1], 600, 600, { ok: false });
  const failed = await second;
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /MemoryError/);
  assert.equal(trainedAdapter(), null);
});

test('adapterIntact reads the header and checks every tensor against the file length', () => {
  const p = join(tempDir, 'a.safetensors');
  const whole = safetensors(16);
  writeFileSync(p, whole);
  assert.equal(adapterIntact(p), true);
  for (const cut of [whole.length - 1, whole.length - 64, 40, 7, 0]) {
    writeFileSync(p, whole.subarray(0, cut));
    assert.equal(adapterIntact(p), false, `cut at ${cut}`);
  }
  writeFileSync(p, Buffer.concat([whole, Buffer.from([0])]));
  assert.equal(adapterIntact(p), false, 'a byte too many');
  // a header whose sizes do not match its shapes
  const bad = Buffer.from(whole);
  bad.write('[17]', bad.indexOf('[16]'));
  writeFileSync(p, bad);
  assert.equal(adapterIntact(p), false, 'a shape that does not fit its range');
  assert.equal(adapterIntact(join(tempDir, 'missing.safetensors')), false);
});

test('a torn adapter resumes from the last whole copy and its step, counting the difference as lost', async () => {
  baseReady();
  const first = trainLora(NIGHT);
  await flush();
  const run = loraRuns()[0];
  const dir = join(paths().school, 'lora', 'adapters', run.id);
  const good = safetensors(16, 2);
  writeFileSync(join(dir, 'adapters.safetensors'), good);
  spawned[0].push(JSON.stringify({ id: 1, step: 200, of: 600 }));
  spawned[0].push(JSON.stringify({ id: 1, saved: 200 }));
  await flush();
  assert.equal(loraRuns()[0].good, 200, 'the whole checkpoint at 200 is copied');
  await pauseAll('on battery');
  // the save at 250 was cut short by the SIGKILL: the file is torn though its saved line came
  writeFileSync(join(dir, 'adapters.safetensors'), safetensors(16, 3).subarray(0, 100));
  spawned[0].push(JSON.stringify({ id: 1, step: 250, of: 600 }));
  spawned[0].push(JSON.stringify({ id: 1, saved: 250 }));
  spawned[0].end(null, 'SIGKILL');
  const paused = await first;
  assert.equal(paused.lora?.saved, 250);
  assert.equal(paused.lora?.good, 200, 'a torn checkpoint never becomes the good copy');

  const second = trainLora(NIGHT + 86_400_000);
  await flush();
  const c = command(spawned[1]);
  assert.equal(c.start, 200);
  assert.equal(flag(c.args, '--iters'), '400');
  assert.equal(flag(c.args, '--resume-adapter-file'), join(dir, 'adapters.safetensors'));
  assert.deepEqual(readFileSync(join(dir, 'adapters.safetensors')), good, 'the last whole copy is put back before the resume');
  assert.deepEqual(loraRuns()[0].torn, [{ at: new Date(NIGHT + 86_400_000).toISOString(), saved: 250, from: 200, lost: 50 }]);
  assert.equal(loraRuns()[0].saved, 200);
  finish(spawned[1], 600, 600);
  assert.equal((await second).status, 'trained');
});

test('the download env has HF_HUB_DISABLE_XET=1 and an empty HF_TOKEN and its proxy allows only the Hugging Face hosts', async () => {
  const p = downloadBase();
  await flush();
  assert.equal(spawned.length, 1);
  const f = spawned[0];
  const c = command(f);
  assert.equal(c.cmd, 'download_base');
  assert.equal(c.repo, BASE_REPO);
  assert.equal(c.dir, loraBaseDir());

  const env = f.opts.env ?? {};
  assert.equal(f.opts.clearEnv, true);
  assert.equal(env.HF_HUB_DISABLE_XET, '1');
  assert.equal(env.HF_TOKEN, '');
  assert.ok(!('HF_HUB_OFFLINE' in env), 'HF_HUB_OFFLINE is unset for the download alone');
  assert.equal(env.HTTPS_PROXY, 'http://palimpsest:tok123@127.0.0.1:54321');
  for (const k of KEYS.filter((k) => k !== 'HF_TOKEN')) assert.equal(env[k], undefined, k);
  assert.ok(env.HF_HOME?.startsWith(paths().school), 'the hub cache is the school, not his');

  assert.deepEqual(HF_HOSTS, ['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co', 'cdn-lfs-eu-1.huggingface.co']);
  assert.deepEqual(stages, [{ stage: 'install', hosts: HF_HOSTS }]);
  for (const host of HF_HOSTS) assert.ok(hostAllowed(host, stages[0].hosts), host);
  for (const host of ['pypi.org', 'api.anthropic.com', 'huggingface.co.evil.example', 'hf.co', 'xethub.hf.co', 'evil.cas-bridge.xethub.hf.co', 'cas-bridge.xethub.hf.co.evil.example', 'cdn.hf.co', 'evil.us.aws.cdn.hf.co', 'us.aws.cdn.hf.co.evil.example']) assert.ok(!hostAllowed(host, stages[0].hosts), host);

  // a second click while it runs starts nothing new
  const twice = downloadBase();
  await flush();
  assert.equal(spawned.length, 1);

  // what snapshot_download leaves, then the answer
  mkdirSync(loraBaseDir(), { recursive: true });
  writeFileSync(join(loraBaseDir(), 'config.json'), '{}\n');
  f.push(JSON.stringify({ id: 1, ok: true, dir: loraBaseDir() }));
  f.end(0);
  const r = await p;
  assert.equal(r.status, 'ready');
  assert.equal((await twice).status, 'ready');
  assert.equal(getSettings().school.baseModelReady, true);
  assert.equal(egressClosed, 1, 'the proxy is closed when the download ends');
  // ready: a later click downloads nothing
  assert.equal((await downloadBase()).status, 'ready');
  assert.equal(spawned.length, 1);
});

test('a failed download leaves the base not ready and says why', async () => {
  const p = downloadBase();
  await flush();
  spawned[0].push(JSON.stringify({ id: 1, ok: false, error: 'HTTPError: 403 Forbidden' }));
  spawned[0].end(0);
  const r = await p;
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /403/);
  assert.equal(getSettings().school.baseModelReady, false);
  assert.equal(egressClosed, 1);
});

test('only the download command\'s profile carries the proxy port; lora_train\'s has no outbound allow', async () => {
  delete process.env.PALIMPSEST_SANDBOX;
  const d = downloadBase();
  await flush();
  const dl = spawned[0];
  assert.equal(dl.cmd, '/usr/bin/sandbox-exec');
  const dlProfile = readFileSync(dl.args[1], 'utf8');
  assert.match(dlProfile, /\(allow network-outbound \(remote ip "localhost:54321"\)\)/);
  assert.equal(dlProfile.match(/allow network/g)?.length, 1, 'one outbound allow and no bind');
  mkdirSync(loraBaseDir(), { recursive: true });
  writeFileSync(join(loraBaseDir(), 'config.json'), '{}\n');
  dl.push(JSON.stringify({ id: 1, ok: true }));
  dl.end(0);
  assert.equal((await d).status, 'ready');

  const t = trainLora(NIGHT);
  await flush();
  const tr = spawned[1];
  assert.notEqual(tr.args[1], dl.args[1], 'the two profiles are separate files, so neither launch reads the other\'s');
  const trProfile = readFileSync(tr.args[1], 'utf8');
  assert.match(trProfile, /\(deny network\*\)/);
  assert.doesNotMatch(trProfile, /network-outbound/);
  assert.doesNotMatch(trProfile, /allow network/);
  assert.equal(tr.opts.env?.HTTPS_PROXY, undefined);
  finish(tr, 600, 600);
  assert.equal((await t).status, 'trained');
});

test('the nightly tick trains a LoRA once the base is ready, and tries a refused one once a night', async () => {
  const calls: number[] = [];
  let answer: { status: string } = { status: 'refused' };
  const s = startSchool({
    intervalMs: 3_600_000,
    gate: async (kind) => ({ ...ok(), kind }),
    labels: () => ({ 'appraiser-pass': 0, 'appraiser-cost': 0, router: 0, durability: 0, triage: 0, taste: 0, master: 0 }),
    ask: () => [],
    act: async () => 0,
    resume: async () => null,
    sail: async () => null,
    lora: async (now) => {
      calls.push(now);
      return answer;
    },
  });
  try {
    await s.tick(NIGHT);
    assert.deepEqual(calls, [], 'no base, no try');
    baseReady();
    await s.tick(NIGHT + 600_000);
    assert.deepEqual(calls, [NIGHT + 600_000]);
    await s.tick(NIGHT + 1_200_000);
    assert.equal(calls.length, 1, 'a refusal is not tried again tonight');
    await s.tick(NIGHT + 86_400_000);
    assert.equal(calls.length, 2, 'the next night tries again');
    answer = { status: 'paused' };
    await s.tick(NIGHT + 86_400_000 + 600_000);
    assert.equal(calls.length, 2, 'the refusal holds for that night');
    await s.tick(NIGHT + 2 * 86_400_000);
    await s.tick(NIGHT + 2 * 86_400_000 + 600_000);
    assert.equal(calls.length, 4, 'a paused LoRA is resumed at a later tick the same night');
  } finally {
    s.stop();
  }
});

test('the school view counts the examples trainLora would use, from the same build, and says when it was read', async () => {
  baseReady();
  examples = 25;
  skips = { 'no-edit': 50, 'not-unique': 22 };
  const now = NIGHT;
  const r = await trainLora(now);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, '25 of 100 verified changes');
  const l = (await schoolView(now)).lora;
  assert.equal(l.examples, 25, 'the screen counts what the trainer counts');
  assert.equal(l.verified, 97);
  assert.equal(l.skipped['no-edit'], 50);
  assert.equal(l.skipped['not-unique'], 22);
  assert.equal(l.readAt, new Date(now).toISOString());
  assert.equal(l.stale, true, 'no connected repo has 97 verified changes now, so the stored count is older than the history');
});

test('before any build the view has no read time and counts no examples', async () => {
  const l = (await schoolView(NIGHT)).lora;
  assert.equal(l.examples, 0);
  assert.equal(l.readAt, null);
  assert.equal(l.verified, null);
});
