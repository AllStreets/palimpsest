/**
 * The trainer process (Phase 4 Task 7): started only when the gate holds,
 * fenced in the trainer profile, charged by the second, and stopped with
 * SIGTERM then SIGKILL when the gate closes. Every child is a fake spawner
 * and every gate reading a fake (test safety rule 11: no Python, no pmset);
 * the clock is node's mock timers. Temp home only.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner, type SpawnDone, type Spawned, type SpawnLine, type SpawnOpts, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { trainerProfile } from '../engine/market/sandbox.js';
import { TRAINER_DIR } from '../engine/school/trainer-env.js';
import { failInterruptedTrains, liveTrains, pauseAll, setGate, startTrain, type StartTrain } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { localCredits } from '../shared/credits.js';
import { GATE } from '../shared/school-rules.js';
import type { GateState, SchoolSettings, TrainState } from '../shared/types.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

/** 03:00 local on 12 November 2026: inside the window, and unattended. */
const NIGHT = new Date(2026, 10, 12, 3, 0).getTime();
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN'];

interface Fake {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  kills: string[];
  push(line: string, stream?: 'stdout' | 'stderr'): void;
  end(code: number | null, signal?: string | null): void;
}

let spawned: Fake[];
let gate: GateState;
let gateCalls: Array<{ kind: string; now: number }>;
let saved: Record<string, string | undefined>;

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
    push(line, stream = 'stdout') {
      const w = waiting.shift();
      if (w) w({ value: { stream, line }, done: false });
      else buffered.push({ stream, line });
    },
    end(code, signal = null) {
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

/** A file standing in for the trainer's Python; never run (the spawner is fake, and the real one refuses python in tests). */
function fakePython(): string {
  const p = join(tempDir, 'venv', 'bin', 'python');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '#!/bin/sh\nexit 99\n');
  chmodSync(p, 0o755);
  return p;
}

/** Lets every pending promise chain run (the mock clock leaves setImmediate real). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function trainRows(): Array<{ kind: string; data: { train: TrainState; reason?: string; lost?: number } }> {
  return entries()
    .filter((e) => e.kind.startsWith('train.'))
    .map((e) => ({ kind: e.kind, data: e.data as { train: TrainState; reason?: string; lost?: number } }));
}

function credits(): Array<{ kind: string; amount: number; firm_id: string | null; run_id: string | null; json: string }> {
  return openDb().prepare('SELECT kind, amount, firm_id, run_id, json FROM credits').all() as Array<{ kind: string; amount: number; firm_id: string | null; run_id: string | null; json: string }>;
}

function input(over: Partial<StartTrain> = {}): StartTrain {
  return { kind: 'lora', gate: 'heavy', command: { id: 1, cmd: 'lora_train' }, gb: 4.3, onLine: () => {}, now: NIGHT, ...over };
}

function clock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NIGHT });
}

beforeEach(() => {
  setUp('school-trainer');
  saved = Object.fromEntries(['PALIMPSEST_PYTHON', ...KEYS].map((k) => [k, process.env[k]]));
  process.env.PALIMPSEST_PYTHON = fakePython();
  spawned = [];
  gate = ok();
  gateCalls = [];
  setSpawner(fakeSpawner);
  setGate(async (kind, now) => {
    gateCalls.push({ kind, now });
    return { ...gate, kind };
  });
  school({ enabled: true });
});

afterEach(async () => {
  await pauseAll('the test ended');
  for (const f of spawned) f.end(null, 'SIGKILL');
  await flush();
  setGate(null);
  setSpawner(realSpawner);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await tearDown();
});

test('a train starts only when the gate holds', async (t) => {
  clock(t);
  gate = { ...ok(), ok: false, reason: 'on battery' };
  const refused = await startTrain(input());
  assert.equal(refused.status, 'waiting');
  assert.equal(refused.reason, 'on battery');
  assert.equal(spawned.length, 0);
  assert.deepEqual(trainRows(), []);
  assert.deepEqual(liveTrains(), []);
  assert.deepEqual(gateCalls, [{ kind: 'heavy', now: NIGHT }]);

  gate = ok();
  const p = startTrain(input());
  await flush();
  assert.equal(spawned.length, 1);
  const live = liveTrains();
  assert.equal(live.length, 1);
  assert.equal(live[0].status, 'running');
  assert.equal(live[0].kind, 'lora');
  const started = trainRows();
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, 'train.started');
  assert.equal(started[0].data.train.id, live[0].id);
  assert.equal(started[0].data.train.status, 'running');

  t.mock.timers.tick(5_000);
  spawned[0].end(0);
  const done = await p;
  assert.equal(done.status, 'done');
  assert.equal(done.reason, null);
  assert.equal(done.seconds, 5);
  assert.equal(done.endedAt, new Date(NIGHT + 5_000).toISOString());
  assert.deepEqual(liveTrains(), []);
  const rows = trainRows();
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['train.started', 'train.ended'],
  );
  assert.equal(rows[1].data.train.status, 'done');
});

test('a train without a trainer Python fails before anything starts', async () => {
  delete process.env.PALIMPSEST_PYTHON;
  const r = await startTrain(input());
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'The trainer is not set up on this Mac');
  assert.equal(spawned.length, 0);
  assert.deepEqual(trainRows(), []);
});

test('a failing gate sends SIGTERM within 30 s and SIGKILL 10 s later and pauses with the reason', async (t) => {
  clock(t);
  const lines: string[] = [];
  const p = startTrain(input({ onLine: (l) => lines.push(`${l.stream}:${l.line}`) }));
  await flush();
  const child = spawned[0];
  assert.ok(child);
  child.push(JSON.stringify({ id: 1, step: 3, of: 100 }));
  child.push(JSON.stringify({ id: 1, saved: 3 }));
  child.push(JSON.stringify({ id: 1, step: 7, of: 100 }));
  child.push('a warning', 'stderr');
  await flush();
  assert.equal(liveTrains()[0].steps?.done, 7);

  gate = { ...ok(), ok: false, reason: 'on battery' };
  t.mock.timers.tick(GATE.pollMs - 1);
  await flush();
  assert.deepEqual(child.kills, [], 'nothing is sent before the poll');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(gateCalls.length, 2);
  assert.equal(liveTrains()[0]?.status, 'paused');
  assert.equal(liveTrains()[0]?.reason, 'on battery');

  t.mock.timers.tick(GATE.killGraceMs - 1);
  await flush();
  assert.deepEqual(child.kills, ['SIGTERM'], 'the trainer has the grace to write its last step');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);

  child.end(null, 'SIGKILL');
  const paused = await p;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'on battery');
  assert.equal(paused.seconds, 40);
  assert.deepEqual(paused.steps, { done: 7, of: 100, lost: 4, optimizerReset: true });
  assert.deepEqual(liveTrains(), []);
  const rows = trainRows();
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['train.started', 'train.paused'],
  );
  assert.equal(rows[1].data.reason, 'on battery');
  assert.equal(rows[1].data.lost, 4);
  assert.equal(rows[1].data.train.status, 'paused');
  assert.ok(lines.includes('stdout:{"id":1,"step":7,"of":100}'));
  assert.ok(lines.includes('stderr:a warning'));
});

test('turning the school off pauses a live train', async (t) => {
  clock(t);
  const p = startTrain(input());
  await flush();
  school({ enabled: false });
  t.mock.timers.tick(GATE.pollMs);
  await flush();
  assert.deepEqual(spawned[0].kills, ['SIGTERM']);
  spawned[0].end(0);
  const r = await p;
  assert.equal(r.status, 'paused');
  assert.equal(r.reason, 'the school is off');
  assert.equal(trainRows().at(-1)?.kind, 'train.paused');
});

test('pauseAll pauses every live train with the reason, once', async (t) => {
  clock(t);
  const a = startTrain(input({ kind: 'nets', gate: 'light' }));
  const b = startTrain(input({ kind: 'arena' }));
  await flush();
  assert.equal(liveTrains().length, 2);
  await pauseAll('the city is stopped');
  await pauseAll('the city is stopped');
  assert.deepEqual(spawned.map((s) => s.kills), [['SIGTERM'], ['SIGTERM']]);
  spawned[0].end(0);
  spawned[1].end(0);
  for (const r of await Promise.all([a, b])) {
    assert.equal(r.status, 'paused');
    assert.equal(r.reason, 'the city is stopped');
  }
});

test('a paused train charges its seconds as train credits', async (t) => {
  clock(t);
  const p = startTrain(input({ gb: 4.3 }));
  await flush();
  gate = { ...ok(), ok: false, reason: 'in Low Power mode' };
  t.mock.timers.tick(GATE.pollMs);
  await flush();
  t.mock.timers.tick(GATE.killGraceMs);
  await flush();
  spawned[0].end(null, 'SIGKILL');
  const r = await p;
  const expected = localCredits(40, 4.3);
  assert.equal(r.credits, expected);
  const rows = credits();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'train');
  assert.equal(rows[0].amount, expected);
  assert.equal(rows[0].firm_id, null);
  assert.equal(rows[0].run_id, r.id);
  const json = JSON.parse(rows[0].json) as { model: string; pool: string; usage: { seconds: number }; unattended: boolean };
  assert.ok(json.model.startsWith('mlx:'), json.model);
  assert.equal(json.pool, 'local');
  assert.equal(json.usage.seconds, 40);
  assert.equal(json.unattended, true);
  assert.equal(trainRows().at(-1)?.data.train.credits, expected);
});

test('the argv is wrapped in the trainer profile with HF_HUB_OFFLINE=1 and no API keys', { skip: process.platform !== 'darwin' }, async (t) => {
  clock(t);
  delete process.env.PALIMPSEST_SANDBOX;
  for (const k of KEYS) process.env[k] = 'secret-value';
  const command = { id: 7, cmd: 'lora_train', data: 'x' };
  const p = startTrain(input({ command }));
  await flush();
  const child = spawned[0];
  assert.ok(child);
  const school = paths().school;
  const tmp = join(school, 'tmp');
  const profilePath = join(school, 'ctl', 'trainer.sb');
  assert.equal(child.cmd, '/usr/bin/sandbox-exec');
  assert.deepEqual(child.args, ['-f', profilePath, process.env.PALIMPSEST_PYTHON, join(TRAINER_DIR, 'school.py')]);
  const text = readFileSync(profilePath, 'utf8');
  assert.equal(text, trainerProfile({ school, tmp, home: homedir() }));
  assert.match(text, /\(deny network\*\)/);
  assert.ok(!/allow network/.test(text), 'no port is open for a train');
  assert.equal(child.opts.clearEnv, true);
  assert.equal(child.opts.stdin, JSON.stringify(command) + '\n');
  const env = child.opts.env ?? {};
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.HOME, tmp);
  assert.ok(existsSync(tmp));
  for (const k of KEYS) assert.ok(!(k in env), k);
  for (const v of Object.values(env)) assert.ok(!v.includes('secret-value'));
  assert.equal(child.opts.cwd, tmp);
  child.end(0);
  await p;
});

test('a running train at engine start is paused', async (t) => {
  clock(t);
  const stale: TrainState = { id: 'train-stale', kind: 'lora', status: 'running', reason: null, startedAt: new Date(NIGHT - 3_600_000).toISOString(), endedAt: null, seconds: 0, steps: { done: 120, of: 600, lost: 0, optimizerReset: false }, credits: 0 };
  const finished: TrainState = { ...stale, id: 'train-done', status: 'done', endedAt: new Date(NIGHT - 1_800_000).toISOString(), seconds: 1800 };
  record('train.started', { train: stale });
  record('train.started', { train: { ...finished, status: 'running', endedAt: null, seconds: 0 } });
  record('train.ended', { train: finished });
  failInterruptedTrains();
  const rows = trainRows();
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['train.started', 'train.started', 'train.ended', 'train.paused'],
  );
  const paused = rows[3].data;
  assert.equal(paused.train.id, 'train-stale');
  assert.equal(paused.train.status, 'paused');
  assert.equal(paused.train.reason, 'the engine stopped');
  assert.equal(paused.reason, 'the engine stopped');
  assert.equal(paused.train.endedAt, new Date(NIGHT).toISOString());
  assert.equal(paused.train.steps?.optimizerReset, true);
  // idempotent: a second start finds nothing running
  failInterruptedTrains();
  assert.equal(trainRows().length, 4);
});
