/**
 * Held-out scores, the baseline, trust and promotion (Phase 4 Task 12,
 * rulings 11 and 12). The trainer is a fake spawner that writes the weights
 * a test chooses; no Python ever runs.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realSpawner, setSpawner, type SpawnLine, type Spawned, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { query, record } from '../engine/ledger.js';
import type { Row } from '../engine/school/datasets.js';
import { baselineFor, current, evaluate, netCard, skewedKinds, split, trainNet } from '../engine/school/nets.js';
import { setGate } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { encode, FEATURES } from '../shared/net-features.js';
import type { NetWeights } from '../shared/nets.js';
import type { GateState, NetName, NetVersion, WorkKind } from '../shared/types.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

/** 03:00 local on 12 November 2026. */
const NOW = new Date(2026, 10, 12, 3, 0).getTime();
const MIN = 60_000;

interface TrainCommand {
  id: string;
  cmd: string;
  net: NetName;
  rows_path: string;
  out_path: string;
  seed: number;
  version: number;
  features: string[];
}

let commands: TrainCommand[];
/** The rows file as the trainer saw it, per call. */
let rowsSeen: string[];
/** The weights the fake trainer writes for each call. */
let weightsFor: (c: TrainCommand) => NetWeights | string;
let stopped: boolean;
let saved: string | undefined;

const fakeSpawner: Spawner = (_cmd, _args, opts): Spawned => {
  const c = JSON.parse(String(opts.stdin)) as TrainCommand;
  commands.push(c);
  rowsSeen.push(readFileSync(c.rows_path, 'utf8'));
  const w = weightsFor(c);
  writeFileSync(c.out_path, typeof w === 'string' ? w : JSON.stringify(w));
  const lines: SpawnLine[] = [
    { stream: 'stdout', line: JSON.stringify({ id: c.id, step: 300, of: 300 }) },
    { stream: 'stdout', line: JSON.stringify({ id: c.id, saved: 300 }) },
    { stream: 'stdout', line: JSON.stringify({ id: c.id, ok: true, epochs: 300, best_epoch: 120, val_loss: 0.1, rows: { fit: 1, val: 1 }, stopped }) },
  ];
  return {
    pid: 4243,
    lines: (async function* () {
      yield* lines;
    })(),
    kill: () => {},
    done: Promise.resolve({ code: 0, signal: null }),
  };
};

function ok(): GateState {
  return { kind: 'light', ok: true, reason: null, power: 'ac', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

beforeEach(() => {
  setUp('school-nets');
  saved = process.env.PALIMPSEST_PYTHON;
  const py = join(tempDir, 'venv', 'bin', 'python');
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '#!/bin/sh\nexit 99\n');
  chmodSync(py, 0o755);
  process.env.PALIMPSEST_PYTHON = py;
  commands = [];
  rowsSeen = [];
  stopped = false;
  weightsFor = (c) => good(c.version);
  setSpawner(fakeSpawner);
  setGate(async (kind) => ({ ...ok(), kind }));
  patchSettings({ school: { ...getSettings().school, enabled: true } });
});

afterEach(async () => {
  setGate(null);
  setSpawner(realSpawner);
  if (saved === undefined) delete process.env.PALIMPSEST_PYTHON;
  else process.env.PALIMPSEST_PYTHON = saved;
  await tearDown();
});

// ---------------------------------------------------------------- weights

const D = FEATURES.master.length;
const col = (name: string): number => FEATURES.master.indexOf(name);

function master(version: number, hidden: { col: number; w: number; b: number }, head: { w: number; b: number }): NetWeights {
  const w = new Array<number>(D).fill(0);
  if (hidden.col >= 0) w[hidden.col] = hidden.w;
  return {
    net: 'master',
    version,
    features: [...FEATURES.master],
    norm: { mean: new Array<number>(D).fill(0), std: new Array<number>(D).fill(1) },
    layers: [
      { W: [w], b: [hidden.b] },
      { W: [[head.w]], b: [head.b] },
    ],
    out: 'sigmoid',
  };
}

/** Reads the appraiser's input: about 0.98 when it is 0.9, 0.02 when it is 0.1. */
const good = (version: number): NetWeights => master(version, { col: col('appraiser'), w: 20, b: -10 }, { w: 1, b: -4 });
/** Reads the router's input, which is right on 6 of 10 held-out rows and wrong on 4. */
const weak = (version: number): NetWeights => master(version, { col: col('router'), w: 10, b: -5 }, { w: 1, b: -1.6 });
/** Says approve, whatever it sees. */
const always = (version: number, p: number): NetWeights => master(version, { col: -1, w: 0, b: 0 }, { w: 0, b: Math.log(p / (1 - p)) });

// ---------------------------------------------------------------- his decisions

/** Records `n` resolved decisions, a minute apart, oldest first, each with a prediction before it. */
function decide(n: number, approved: (i: number) => boolean, kind: WorkKind = 'merge:low'): void {
  for (let i = 0; i < n; i++) {
    const yes = approved(i);
    const agrees = i % 5 < 3;
    record('decision.resolved', {
      key: `${kind}:job-${i}`,
      kind,
      repo: 'acme/widgets',
      jobId: `job-${i}`,
      approved: yes,
      by: yes ? 'merge' : 'close',
      predictionId: i + 1,
      agreed: null,
      inputs: { appraiser: yes ? 0.9 : 0.1, router: agrees === yes ? 0.8 : 0.2 },
      at: new Date(NOW - (n - i) * MIN).toISOString(),
    });
  }
}

const trained = (net: NetName = 'master'): NetVersion[] =>
  query({ kind: 'net.trained' })
    .map((e) => (e.data as { version: NetVersion }).version)
    .filter((v) => v.net === net);
const promoted = (net: NetName = 'master'): number[] =>
  query({ kind: 'net.promoted' })
    .map((e) => e.data as { net: NetName; version: number })
    .filter((d) => d.net === net)
    .map((d) => d.version);

// ---------------------------------------------------------------- tests

test('a net with 25 labels is thin, says 25 of 40 and names its cause', async () => {
  decide(25, (i) => i % 2 === 0);
  const card = netCard('master', NOW);
  assert.equal(card.status, 'thin');
  assert.equal(card.labels, 25);
  assert.equal(card.needs, 40);
  assert.equal(card.reason, '25 of 40 labels');
  assert.equal(card.cause, '25 of 40 decisions resolved');
  assert.equal(card.current, null);
  assert.deepEqual(card.history, []);

  const r = await trainNet('master', NOW);
  assert.equal(r.status, 'thin');
  assert.equal(r.reason, '25 of 40 labels');
  assert.equal(commands.length, 0, 'nothing is trained on too few labels');
  assert.deepEqual(trained(), []);

  const empty = netCard('durability', NOW);
  assert.equal(empty.status, 'thin');
  assert.equal(empty.reason, '0 of 40 labels');
  assert.equal(empty.cause, 'No city merge has had 30 days yet');
});

test('held-out rows are the newest 20% and never in rows.json', async () => {
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, at: new Date(NOW - (60 - i) * MIN).toISOString(), x: [i], y: i % 2, weight: 1, source: 'real' }));
  const s = split([...rows].reverse());
  assert.deepEqual(
    s.heldOut.map((r) => r.id),
    rows.slice(48).map((r) => r.id),
  );
  assert.deepEqual(
    s.train.map((r) => r.id),
    rows.slice(0, 48).map((r) => r.id),
  );
  assert.equal(split(rows.slice(0, 40)).heldOut.length, 10, 'at least 10 held out');
  assert.equal(split(rows.slice(0, 41)).heldOut.length, 10);
  // a distilled row is never held out (ruling 13)
  const soft: Row = { id: 'soft', at: new Date(NOW).toISOString(), x: [0], y: 0.7, weight: 0.3, source: 'distilled' };
  const withSoft = split([...rows, soft]);
  assert.ok(!withSoft.heldOut.some((r) => r.source === 'distilled'));
  assert.ok(withSoft.train.some((r) => r.id === 'soft'));

  decide(60, (i) => i % 2 === 0);
  const r = await trainNet('master', NOW);
  assert.equal(r.status, 'trained');
  assert.equal(commands.length, 1);
  const c = commands[0];
  assert.equal(c.cmd, 'train_net');
  assert.equal(c.net, 'master');
  assert.equal(c.seed, 1);
  assert.equal(c.version, 1);
  assert.deepEqual(c.features, [...FEATURES.master]);
  assert.equal(c.rows_path, join(paths().school, 'nets', 'master', 'rows.json'));
  assert.equal(c.out_path, join(paths().school, 'nets', 'master', 'v1.json'));
  const sent = rowsSeen[0]
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Row);
  assert.equal(sent.length, 48);
  const ids = sent.map((x) => x.id);
  for (let i = 0; i < 48; i++) assert.ok(ids.includes(`merge:low:job-${i}`));
  for (let i = 48; i < 60; i++) assert.ok(!ids.includes(`merge:low:job-${i}`), `held-out row ${i} reached the trainer`);
  assert.deepEqual(r.version?.rows, { train: 48, heldOut: 12, distilled: 0 });
  assert.equal(r.version?.score.n, 12);
});

test('a head beating the base rate with hi below zero is trusted and promoted', async () => {
  decide(50, (i) => i % 2 === 0);
  const r = await trainNet('master', NOW);
  assert.equal(r.status, 'trained');
  const v = r.version!;
  assert.equal(v.version, 1);
  assert.equal(v.metric, 'brier');
  assert.ok(v.vsBaseline.hi < 0, `hi ${v.vsBaseline.hi}`);
  assert.ok(v.score.value < v.baseline.value);
  assert.equal(v.baseline.value, 0.25, 'the training rows approve half, so the base rate scores 0.25');
  assert.equal(v.trusted, true);
  assert.equal(v.current, true);
  assert.equal(v.path, join('nets', 'master', 'v1.json'));
  assert.equal(r.promoted, true);
  assert.deepEqual(promoted(), [1]);
  assert.equal(trained().length, 1);
  const cur = current('master');
  assert.equal(cur?.version.version, 1);
  assert.equal(cur?.weights.version, 1);
  const card = netCard('master', NOW);
  assert.equal(card.status, 'trusted');
  assert.equal(card.reason, null);
  assert.equal(card.cause, null);
  assert.equal(card.current?.version, 1);
  assert.ok(!('path' in (card.current ?? {})), 'a card never carries a path');
  assert.deepEqual(
    card.history.map((h) => [h.version, h.trusted]),
    [[1, true]],
  );
});

test('a head whose interval spans zero is not trusted and not promoted over a trusted one', async () => {
  decide(50, (i) => i % 2 === 0);
  // a weak first version is promoted: there is no current to keep
  weightsFor = (c) => weak(c.version);
  const first = await trainNet('master', NOW);
  assert.ok(first.version!.vsBaseline.lo < 0 && first.version!.vsBaseline.hi > 0, JSON.stringify(first.version!.vsBaseline));
  assert.equal(first.version!.trusted, false);
  assert.equal(first.promoted, true);
  assert.equal(netCard('master', NOW).status, 'trained');

  // a trusted one replaces an untrusted current
  weightsFor = (c) => good(c.version);
  const second = await trainNet('master', NOW);
  assert.equal(second.version!.trusted, true);
  assert.equal(second.promoted, true);

  // and a weak one never replaces a trusted current
  weightsFor = (c) => weak(c.version);
  const third = await trainNet('master', NOW);
  assert.equal(third.version!.version, 3);
  assert.equal(third.version!.trusted, false);
  assert.equal(third.version!.current, false);
  assert.equal(third.promoted, false);
  assert.deepEqual(promoted(), [1, 2]);
  assert.equal(current('master')?.version.version, 2);
  const card = netCard('master', NOW);
  assert.equal(card.status, 'trusted');
  assert.equal(card.current?.version, 2);
  assert.deepEqual(
    card.history.map((h) => [h.version, h.trusted]),
    [
      [1, false],
      [2, true],
      [3, false],
    ],
  );
});

test('the master is trusted by Brier against the base rate, with agreement reported beside it', async () => {
  decide(50, (i) => i % 2 === 0);
  const r = await trainNet('master', NOW);
  const v = r.version!;
  assert.equal(v.metric, 'brier');
  assert.equal(v.trusted, true);
  assert.ok(v.agreement, 'agreement is reported');
  assert.equal(v.agreement!.value, 1);
  assert.equal(v.agreement!.n, 10);
  assert.ok(v.score.value < 0.01, `Brier ${v.score.value}`);
  assert.deepEqual(skewedKinds(), [], 'half approved is no skew');
});

test('a master that only says approve on a 97% kind is not trusted and the kind is marked skewed', async () => {
  const no = new Set([13, 57, 91]);
  decide(100, (i) => !no.has(i));
  weightsFor = (c) => always(c.version, 0.99);
  const r = await trainNet('master', NOW);
  const v = r.version!;
  assert.equal(v.rows.heldOut, 20);
  assert.ok(Math.abs(v.baseline.value - 0.0481) < 1e-3, `the base rate's Brier is small: ${v.baseline.value}`);
  assert.equal(v.trusted, false);
  assert.ok(v.vsBaseline.hi >= 0);
  assert.equal(v.agreement!.value, 0.95, 'it agrees 95% of the time, and that is not trust');
  assert.deepEqual(skewedKinds(), ['merge:low']);
  const entry = query({ kind: 'net.trained' }).at(-1)!.data as { skewed: WorkKind[] };
  assert.deepEqual(entry.skewed, ['merge:low']);
});

test('a corrupt weights file makes current null and the card names it', async () => {
  decide(50, (i) => i % 2 === 0);
  await trainNet('master', NOW);
  assert.ok(current('master'));
  const file = join(paths().school, 'nets', 'master', 'v1.json');
  writeFileSync(file, '{"net": "master", "layers": [');
  assert.equal(current('master'), null);
  const card = netCard('master', NOW);
  assert.equal(card.current, null);
  assert.notEqual(card.status, 'trusted');
  assert.match(card.reason ?? '', /v1/);
  assert.match(card.reason ?? '', /could not be read/);

  rmSync(file);
  assert.equal(current('master'), null);
  assert.match(netCard('master', NOW).reason ?? '', /v1.*missing/);

  // a trainer that wrote weights the engine refuses records nothing
  weightsFor = () => 'not json';
  const r = await trainNet('master', NOW);
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /could not be read/);
  assert.equal(trained().length, 1);
});

test('a weights file linked to outside the school is refused, read through the link', async () => {
  decide(50, (i) => i % 2 === 0);
  await trainNet('master', NOW);
  const file = join(paths().school, 'nets', 'master', 'v1.json');
  const outside = join(tempDir, 'elsewhere.json');
  writeFileSync(outside, readFileSync(file));
  rmSync(file);
  symlinkSync(outside, file);
  assert.equal(current('master'), null);
  assert.match(netCard('master', NOW).reason ?? '', /outside the school/);
  // a link that stays inside the school is followed
  const inside = join(paths().school, 'nets', 'master', 'kept.json');
  writeFileSync(inside, readFileSync(outside));
  rmSync(file);
  symlinkSync(inside, file);
  assert.ok(current('master'));
});

test('a stopped train records no version and promotes nothing', async () => {
  decide(50, (i) => i % 2 === 0);
  stopped = true;
  const r = await trainNet('master', NOW);
  assert.equal(r.status, 'stopped');
  assert.equal(r.version, null);
  assert.deepEqual(trained(), []);
  assert.deepEqual(promoted(), []);
  assert.equal(current('master'), null);

  stopped = false;
  setGate(async (kind) => ({ ...ok(), kind, ok: false, reason: 'on battery' }));
  const waiting = await trainNet('master', NOW);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.reason, 'on battery');
  assert.deepEqual(trained(), []);
});

test("the appraiser's baseline is the firm's pass rate as of the award", () => {
  const row = (i: number, firm: number | null, y: number): Row => ({
    id: `b${i}`,
    at: new Date(NOW - (100 - i) * MIN).toISOString(),
    x: encode('appraiser-pass', { tier: 'normal', firm_pass_rate: firm }),
    y,
    weight: 1,
    source: 'real',
  });
  // training: 30 of 40 passed
  const train = Array.from({ length: 40 }, (_, i) => row(i, 0.5, i % 4 === 0 ? 0 : 1));
  const heldOut = [row(40, 0.9, 1), row(41, 0.2, 0), row(42, null, 1), row(43, 0.6, 1), row(44, null, 0)];
  assert.deepEqual(baselineFor('appraiser-pass', train, heldOut), [0.9, 0.2, 0.75, 0.6, 0.75], "the firm's rate where it had one, else the base rate");
  assert.deepEqual(baselineFor('router', train, heldOut), [0.75, 0.75, 0.75, 0.75, 0.75], 'the router is held to the base rate');

  const cost = (i: number, y: number): Row => ({ ...row(i, 0.5, 0), x: encode('appraiser-cost', { firm_pass_rate: 0.5 }), y });
  const costTrain = [cost(0, 1), cost(1, 2), cost(2, 3)];
  assert.deepEqual(baselineFor('appraiser-cost', costTrain, [cost(3, 5)]), [2]);

  // evaluate scores the baseline it is given, row by row
  const d = FEATURES['appraiser-pass'].length;
  const constant: NetWeights = {
    net: 'appraiser-pass',
    version: 1,
    features: [...FEATURES['appraiser-pass']],
    norm: { mean: new Array<number>(d).fill(0), std: new Array<number>(d).fill(1) },
    layers: [
      { W: [new Array<number>(d).fill(0)], b: [0] },
      { W: [[0]], b: [0] },
    ],
    out: 'sigmoid',
  };
  const e = evaluate('appraiser-pass', constant, heldOut, baselineFor('appraiser-pass', train, heldOut));
  const want = [0.01, 0.04, 0.0625, 0.16, 0.5625].reduce((a, b) => a + b, 0) / 5;
  assert.ok(Math.abs(e.baseline.value - want) < 1e-12, `${e.baseline.value} against ${want}`);
  assert.equal(e.score.value, 0.25);
  assert.equal(e.metric, 'brier');
  assert.equal(e.agreement, null, 'agreement is the master alone');
  assert.equal(e.baseline.n, 5);
});

test('the cost head is scored by mean absolute error', () => {
  const d = FEATURES['appraiser-cost'].length;
  const w: NetWeights = {
    net: 'appraiser-cost',
    version: 1,
    features: [...FEATURES['appraiser-cost']],
    norm: { mean: new Array<number>(d).fill(0), std: new Array<number>(d).fill(1) },
    layers: [
      { W: [new Array<number>(d).fill(0)], b: [0] },
      { W: [[0]], b: [2] },
    ],
    out: 'linear',
  };
  const rows: Row[] = [1, 2, 4].map((y, i) => ({ id: `c${i}`, at: new Date(NOW).toISOString(), x: new Array<number>(d).fill(0), y, weight: 1, source: 'real' }));
  const e = evaluate('appraiser-cost', w, rows, [3, 3, 3]);
  assert.equal(e.metric, 'mae');
  assert.equal(e.score.value, (1 + 0 + 2) / 3);
  assert.equal(e.baseline.value, (2 + 1 + 1) / 3);
});

test('the cost baseline is the median of the training labels, so a head that only beats the mean is not trusted', () => {
  const d = FEATURES['appraiser-cost'].length;
  const at = new Date(NOW).toISOString();
  const row = (i: number, y: number, source: Row['source'] = 'real'): Row => ({ id: `c${i}`, at, x: new Array<number>(d).fill(0), y, weight: source === 'real' ? 1 : 0.3, source });
  // 30 cheap runs and 10 dear ones: the median is 1, the mean 3; a distilled row never moves it
  const train = [...Array.from({ length: 30 }, (_, i) => row(i, 1)), ...Array.from({ length: 10 }, (_, i) => row(30 + i, 9)), row(99, 50, 'distilled')];
  const heldOut = [1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5].map((y, i) => row(100 + i, y));
  assert.deepEqual(baselineFor('appraiser-cost', train, heldOut), new Array(10).fill(1));
  assert.deepEqual(baselineFor('appraiser-cost', [row(0, 1), row(1, 2), row(2, 4), row(3, 10)], [row(4, 0)]), [3], 'an even count takes the mean of the middle two');
  const two: NetWeights = {
    net: 'appraiser-cost',
    version: 1,
    features: [...FEATURES['appraiser-cost']],
    norm: { mean: new Array<number>(d).fill(0), std: new Array<number>(d).fill(1) },
    layers: [
      { W: [new Array<number>(d).fill(0)], b: [0] },
      { W: [[0]], b: [2] },
    ],
    out: 'linear',
  };
  // against the mean (3) this head is better on every row; against the median it is not
  assert.equal(evaluate('appraiser-cost', two, heldOut, new Array(10).fill(3)).trusted, true);
  const e = evaluate('appraiser-cost', two, heldOut, baselineFor('appraiser-cost', train, heldOut));
  assert.equal(e.trusted, false);
});

test('the appraiser is self-selected once it has moved an award', () => {
  assert.equal(netCard('appraiser-pass', NOW).selfSelected, false);
  record('job.awarded', { jobId: 'job-1', tier: 'normal', considered: [], satOut: [], chosen: null, why: '', at: new Date(NOW).toISOString(), coolOffUntil: null, appraiserMoved: true });
  assert.equal(netCard('appraiser-pass', NOW).selfSelected, true);
  assert.equal(netCard('appraiser-cost', NOW).selfSelected, true);
  assert.equal(netCard('router', NOW).selfSelected, false);
  assert.equal(netCard('master', NOW).selfSelected, false);
  assert.ok(existsSync(paths().school));
});
