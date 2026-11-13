/**
 * The nightly retrain and the school's off switch (Phase 4 Task 13, ruling
 * 12). The trainer is a fake spawner and the gate a fake; no Python, pmset
 * or port is ever touched.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realSpawner, setSpawner, type SpawnLine, type Spawned, type Spawner } from '../engine/exec.js';
import { query, record } from '../engine/ledger.js';
import type { TrainNetResult } from '../engine/school/nets.js';
import { registerAbort, schoolOff, startSchool, TRAIN_ORDER, TURNED_OFF_REASON } from '../engine/school/tick.js';
import { liveTrains, setGate } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { FEATURES } from '../shared/net-features.js';
import type { NetWeights } from '../shared/nets.js';
import type { GateState, NetName, NetVersion } from '../shared/types.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

/** 03:00 local on 12 November 2026: inside the default window. */
const NOW = new Date(2026, 10, 12, 3, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface Command {
  id: string;
  net: NetName;
  out_path: string;
  version: number;
}

/** Each spawned trainer: its command, the signals it got, and a way to end it. */
interface Child {
  command: Command;
  kills: string[];
  end: () => void;
}

let children: Child[];
/** When true, a trainer runs until it is killed; otherwise it answers at once. */
let hold: boolean;
let gate: GateState;
let gateCalls: number;
let saved: string | undefined;

function weights(c: Command): NetWeights {
  const d = FEATURES[c.net].length;
  return {
    net: c.net,
    version: c.version,
    features: [...FEATURES[c.net]],
    norm: { mean: new Array<number>(d).fill(0), std: new Array<number>(d).fill(1) },
    layers: [
      { W: [new Array<number>(d).fill(0)], b: [0] },
      { W: [[0]], b: [0] },
    ],
    out: c.net === 'appraiser-cost' ? 'linear' : 'sigmoid',
  };
}

const fakeSpawner: Spawner = (_cmd, _args, opts): Spawned => {
  const command = JSON.parse(String(opts.stdin)) as Command;
  let finish!: (r: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (finish = r));
  const child: Child = { command, kills: [], end: () => finish({ code: 0, signal: null }) };
  children.push(child);
  const answer: SpawnLine = { stream: 'stdout', line: JSON.stringify({ id: command.id, ok: true, stopped: false }) };
  if (!hold) {
    writeFileSync(command.out_path, JSON.stringify(weights(command)));
    child.end();
  }
  return {
    pid: 5151,
    lines: (async function* () {
      if (!hold) yield answer;
      await done;
    })(),
    kill: (signal) => {
      child.kills.push(String(signal ?? 'SIGTERM'));
    },
    done,
  };
};

function ok(): GateState {
  return { kind: 'light', ok: true, reason: null, power: 'ac', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  setUp('school-tick');
  saved = process.env.PALIMPSEST_PYTHON;
  const py = join(tempDir, 'venv', 'bin', 'python');
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '#!/bin/sh\nexit 99\n');
  chmodSync(py, 0o755);
  process.env.PALIMPSEST_PYTHON = py;
  children = [];
  hold = false;
  gate = ok();
  gateCalls = 0;
  setSpawner(fakeSpawner);
  setGate(async (kind) => {
    gateCalls += 1;
    return { ...gate, kind };
  });
  patchSettings({ school: { ...getSettings().school, enabled: true } });
});

afterEach(async () => {
  for (const c of children) c.end();
  await flush();
  setGate(null);
  setSpawner(realSpawner);
  if (saved === undefined) delete process.env.PALIMPSEST_PYTHON;
  else process.env.PALIMPSEST_PYTHON = saved;
  await tearDown();
});

/** Records `n` resolved decisions, a minute apart, ending at `end`. */
function decide(n: number, end = NOW, from = 0): void {
  for (let i = from; i < from + n; i++) {
    const yes = i % 2 === 0;
    record('decision.resolved', {
      key: `merge:low:job-${i}`,
      kind: 'merge:low',
      repo: 'acme/widgets',
      jobId: `job-${i}`,
      approved: yes,
      by: yes ? 'merge' : 'close',
      predictionId: i + 1,
      agreed: null,
      inputs: { appraiser: yes ? 0.9 : 0.1 },
      at: new Date(end - (from + n - i) * MIN).toISOString(),
    });
  }
}

/** A version of `net` trained on `labels` real rows at `at`. */
function trainedVersion(net: NetName, labels: number, at: number, version = 1): void {
  const v = { net, version, at: new Date(at).toISOString(), rows: { train: labels - 10, heldOut: 10, distilled: 0 }, trusted: false, path: `nets/${net}/v${version}.json` } as unknown as NetVersion;
  record('net.trained', { version: v, skewed: [] });
}

/** A trainNet stand-in that refuses to be run twice at once. */
function fakeTrain(order: NetName[], status: TrainNetResult['status'] = 'trained') {
  let inFlight = 0;
  return async (net: NetName): Promise<TrainNetResult> => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'one train at a time');
    order.push(net);
    await flush();
    inFlight -= 1;
    return { net, status, reason: null, version: null, promoted: false, train: null };
  };
}

const offs = (): number => query({ kind: 'school.enabled' }).filter((e) => (e.data as { on: boolean }).on === false).length;

const all = (n: number): Record<NetName, number> => Object.fromEntries(TRAIN_ORDER.map((k) => [k, n])) as Record<NetName, number>;

// ---------------------------------------------------------------- tests

test('the tick retrains only nets with new labels, master last', async () => {
  // taste last trained on 42 labels and has 42 still; triage on 40 and has 45; durability is thin
  trainedVersion('taste', 42, NOW - 3 * DAY);
  trainedVersion('triage', 40, NOW - 3 * DAY);
  const order: NetName[] = [];
  const school = startSchool({ train: fakeTrain(order), labels: () => ({ ...all(50), durability: 12, taste: 42, triage: 45, master: 60 }) });
  try {
    const r = await school.tick(NOW);
    assert.equal(r.reason, null);
    assert.deepEqual(order, ['appraiser-pass', 'appraiser-cost', 'router', 'triage', 'master']);
    assert.deepEqual(r.trained, order);
    assert.deepEqual(TRAIN_ORDER, ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master']);
  } finally {
    school.stop();
  }

  // the real trainer, end to end: the master alone has labels, so it alone is trained
  decide(50);
  const real = startSchool();
  try {
    const r = await real.tick(NOW);
    assert.deepEqual(r.trained, ['master']);
    assert.deepEqual(
      children.map((c) => c.command.net),
      ['master'],
    );
    assert.equal(query({ kind: 'net.trained' }).filter((e) => (e.data as { version: NetVersion }).version.net === 'master').length, 1);
  } finally {
    real.stop();
  }
});

test('not outside the window or on battery', async () => {
  decide(50);
  const school = startSchool();
  try {
    gate = { ...ok(), ok: false, inWindow: false, reason: 'outside the training window' };
    const outside = await school.tick(NOW + 12 * 60 * MIN);
    assert.equal(outside.reason, 'outside the training window');
    gate = { ...ok(), ok: false, power: 'battery', reason: 'on battery' };
    const battery = await school.tick(NOW);
    assert.equal(battery.reason, 'on battery');
    assert.equal(children.length, 0, 'nothing is spawned');
    assert.deepEqual(query({ kind: 'net.trained' }), []);

    // the switch is read before the gate
    patchSettings({ school: { ...getSettings().school, enabled: false } });
    gate = ok();
    const calls = gateCalls;
    const off = await school.tick(NOW);
    assert.equal(off.reason, 'the school is off');
    assert.equal(gateCalls, calls);
    assert.equal(children.length, 0);
  } finally {
    school.stop();
  }
});

test('once a night', async () => {
  const order: NetName[] = [];
  let counts = { ...all(0), master: 50 };
  const school = startSchool({ train: fakeTrain(order), labels: () => counts });
  try {
    await school.tick(NOW);
    assert.deepEqual(order, ['master']);
    // ten more of his decisions later that night: still not again tonight
    counts = { ...counts, master: 60 };
    const again = await school.tick(NOW + 60 * MIN);
    assert.deepEqual(order, ['master']);
    assert.deepEqual(again.trained, []);
    // the next night it is
    await school.tick(NOW + DAY);
    assert.deepEqual(order, ['master', 'master']);
  } finally {
    school.stop();
  }

  // a net already trained tonight, as the ledger says, is not trained again by a fresh engine
  const fresh: NetName[] = [];
  trainedVersion('triage', 40, NOW + DAY - 30 * MIN, 2);
  const restarted = startSchool({ train: fakeTrain(fresh), labels: () => ({ ...all(0), triage: 50 }) });
  try {
    await restarted.tick(NOW + DAY);
    assert.deepEqual(fresh, []);
  } finally {
    restarted.stop();
  }

  // a train the gate stopped is tried again later the same night
  const stopped: NetName[] = [];
  const retry = startSchool({ train: fakeTrain(stopped, 'stopped'), labels: () => ({ ...all(0), taste: 50 }) });
  try {
    await retry.tick(NOW);
    await retry.tick(NOW + 30 * MIN);
    assert.deepEqual(stopped, ['taste', 'taste']);
  } finally {
    retry.stop();
  }
});

test('a tick while a train runs starts nothing', async () => {
  decide(50);
  hold = true;
  const school = startSchool();
  try {
    const first = school.tick(NOW);
    await flush();
    assert.equal(liveTrains().length, 1);
    const second = await school.tick(NOW);
    assert.equal(second.reason, 'a train is already running');
    assert.equal(children.length, 1);
    writeFileSync(children[0].command.out_path, JSON.stringify(weights(children[0].command)));
    children[0].end();
    await first;
  } finally {
    school.stop();
  }
});

test('turning the school off pauses a live retrain at once', async () => {
  decide(50);
  hold = true;
  const aborted: string[] = [];
  const unregister = registerAbort(() => aborted.push('voyage'));
  const school = startSchool();
  try {
    const pass = school.tick(NOW);
    await flush();
    assert.equal(liveTrains().length, 1);
    assert.deepEqual(children[0].kills, []);

    // his switch, through settings: no poll is waited for
    patchSettings({ school: { ...getSettings().school, enabled: false } });
    assert.deepEqual(children[0].kills, ['SIGTERM']);
    assert.deepEqual(aborted, ['voyage'], 'a live voyage or arena build is aborted too');
    const off = query({ kind: 'school.enabled' }).at(-1)?.data as { on: boolean; at: string };
    assert.equal(off.on, false);

    children[0].end();
    const r = await pass;
    assert.deepEqual(r.trained, []);
    assert.equal(r.results[0]?.status, 'stopped');
    assert.equal(r.results[0]?.reason, TURNED_OFF_REASON);
    const paused = query({ kind: 'train.paused' }).at(-1)?.data as { reason: string };
    assert.equal(paused.reason, 'the school was turned off');
    assert.deepEqual(query({ kind: 'net.trained' }), [], 'a stopped train records no version');

    // a second switch-off with the school already off changes nothing
    patchSettings({ school: { ...getSettings().school, enabled: false } });
    assert.equal(offs(), 1);
    assert.deepEqual(aborted, ['voyage']);

    // schoolOff on its own does the same, and an unregistered abort is never called again
    unregister();
    schoolOff(NOW);
    assert.deepEqual(aborted, ['voyage']);
    assert.equal(offs(), 2);
    // turning it on is recorded too
    patchSettings({ school: { ...getSettings().school, enabled: true } });
    assert.equal((query({ kind: 'school.enabled' }).at(-1)?.data as { on: boolean }).on, true);
  } finally {
    unregister();
    school.stop();
  }
});

test('a stopped school ticks no more', async () => {
  decide(50);
  const school = startSchool();
  school.stop();
  const r = await school.tick(NOW);
  assert.equal(r.reason, 'the school tick is stopped');
  assert.equal(children.length, 0);
});
