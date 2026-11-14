/**
 * Graduation (Phase 4 Task 27, ruling 25): a trained adapter is raced
 * against its base on the sealed tasks of every arena its data held out,
 * one `sealedRace` per arena and one sealed use each, and graduates only
 * when the paired difference over all those tasks has `lo > 0`.
 *
 * Beagle is real, with its store under the temp school; the arenas are
 * fake ones (no repo, no suite: an answer is right or wrong). Every model
 * call goes through the school's driver to a fake `mlx` backend, so no
 * server and no Python is ever started. The base-alone server of ruling 26
 * is checked against the fake server of the mlx fixtures.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { paths } from '../engine/home.js';
import { query } from '../engine/ledger.js';
import { liveLeaseCount } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import { hire, quarters } from '../engine/market/firms.js';
import { beginHeavy, ensureServer, GraduatesDown, MLX_BASE, serveBase } from '../engine/market/mlx.js';
import type { CompleteInput, CompleteResult, Usage } from '../engine/market/provider.js';
import { setProvider } from '../engine/market/providers.js';
import { verifyReplay } from '../engine/market/replay.js';
import { dailyTick } from '../engine/market/treasury.js';
import { homeOf } from '../engine/market/trips.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { arenaInfo, toBeagleArena } from '../engine/school/arenas.js';
import type { BeagleArena } from '../engine/school/beagle-api.js';
import { closeBeagle, loadBeagle } from '../engine/school/beagle.js';
import { campusOrigin, ensureCampus } from '../engine/school/campus.js';
import { resetGateCache } from '../engine/school/gate.js';
import { askEvaluation, concurrencyMarker, evaluateAdapter, graduate, graduateDue, graduates, loraBaseDir, loraRuns, oneRunAtATime, restoreBeagleConcurrency, type LoraRun } from '../engine/school/lora.js';
import { buildPlanted } from '../engine/school/arenas.js';
import { installRoster } from '../engine/school/roster.js';
import { pairedCi } from '../engine/school/stats.js';
import { startSchool, TRAIN_ORDER } from '../engine/school/tick.js';
import { holdTrain, liveTrains, setGate } from '../engine/school/trainer.js';
import { SEALED_USES } from '../shared/school-rules.js';
import type { ArenaInfo, GateState, Graduate, NetName, Repo, Trip } from '../shared/types.js';
import { FULL, HOUR, setUp, tearDown } from './guild-fixtures.js';
import { installMlx, safetensors, uninstallMlx, baseReady as downloadedBase } from './mlx-fixtures.js';
import { firmWith } from './roster-fixtures.js';

const LORA = 'lora-0000000a';
const LORA_2 = 'lora-0000000b';
const ADAPTER = `mlx:${LORA}`;
const SEALED = ['s1', 's2', 's3'] as const;

let NOW = 0;
let events: Event[] = [];
let unsubscribe: () => void = () => {};
let registered: string[] = [];
/** Who answers right on which sealed task: by model, the task's letter-and-number. */
let right: (model: string, q: string) => boolean = () => false;
/** Runs before an answer; may throw to stand for a call the machine refused. */
let before: (i: CompleteInput, n: number) => Promise<void> = async () => {};
let calls: Array<{ model: string; q: string; runId: string | null }> = [];
let inFlight = 0;
let maxInFlight = 0;

const LOCAL_USAGE: Usage = { weightedTokens: 0, seconds: 2, usd: 0, credits: 0.01 };

function gateState(ok: boolean): GateState {
  return { kind: 'heavy', ok, reason: ok ? null : 'on battery', power: ok ? 'ac' : 'battery', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

/** The fake mlx backend: the adapter and the base answer by `right`, through the school's driver. */
function mlxBackend(): void {
  setProvider(
    'mlx',
    fakeProvider({
      complete: async (i: CompleteInput): Promise<CompleteResult> => {
        const q = /Task (\S+)/.exec(i.turns.map((t) => t.content).join('\n'))?.[1] ?? '?';
        calls.push({ model: i.model, q, runId: i.runId });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await before(i, calls.length);
          await new Promise((r) => setImmediate(r));
          const reply = { action: 'answer', answer: { fix: right(i.model, q) ? 'right' : 'wrong' } };
          return { text: JSON.stringify(reply), json: reply, usage: LOCAL_USAGE };
        } finally {
          inFlight--;
        }
      },
    }),
  );
}

const show = (input: unknown) => `Task ${(input as { q: string }).q}`;

/** A ready arena with four breeding, three race and three sealed tasks, in the school's tables, the ledger and Beagle's store. */
async function fakeArena(id: string, o: { sealedUses?: number; status?: ArenaInfo['status']; tag?: string } = {}): Promise<ArenaInfo> {
  const b = await loadBeagle();
  const splits = { breeding: ['b1', 'b2', 'b3', 'b4'], race: ['r1', 'r2', 'r3'], sealed: [...SEALED] } as const;
  const rows = (Object.entries(splits) as Array<[keyof typeof splits, readonly string[]]>).flatMap(([split, qs]) => qs.map((q) => ({ id: `${id}:${q}`, split, q })));
  const put = openDb().prepare('INSERT OR REPLACE INTO arena_tasks (id, arena, split, ref, json) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) put.run(r.id, id, r.split, null, JSON.stringify({ id: r.id, arena: id, split: r.split, ref: null, input: { q: r.q }, truth: { kind: 'planted', fix: 'right' } }));
  b.store.putArena(id, `${FULL}: planted bugs`);
  b.store.putTasks(id, rows.map((r) => ({ id: r.id, input: { q: r.q, tag: o.tag ?? '' }, truth: { fix: 'right' }, split: r.split })));
  const arena: BeagleArena = {
    ...toBeagleArena({ id, repo: FULL, kind: 'planted' }),
    describe: 'Fix the bug.',
    answer: { type: 'object', required: ['fix'], properties: { fix: { type: 'string' } } },
    tools: [],
    show,
    grade: (a) => ((a as { fix?: string } | null)?.fix === 'right' ? 1 : 0),
    valid: (a) => !!a && typeof a === 'object',
    example: () => '{"fix":"right"}',
    miss: () => 'it answered wrong',
    selfCheck: () => 'Check your answer.',
    brief: show,
    graderTimeoutMs: 5_000,
    maxTurns: 3,
  };
  b.arenas.registerArena(arena);
  registered.push(id);
  const info: ArenaInfo = {
    id,
    repo: FULL,
    kind: 'planted',
    sha: 'a'.repeat(40),
    tasks: { breeding: 4, race: 3, sealed: 3 },
    candidates: 10,
    kept: 10,
    sealedUses: o.sealedUses ?? 0,
    sealedHash: b.race.sealedHash(id),
    builtAt: new Date(NOW - HOUR).toISOString(),
    status: o.status ?? 'ready',
    reason: null,
  };
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
  (await import('../engine/ledger.js')).record('arena.built', { arena: info });
  return info;
}

/** A trained LoRA as lora.ts leaves one, whose data held out the sealed splits named in `sealedArenas` (arena id to its sealed hash then). */
function trainedLora(id: string, sealedArenas: Record<string, string>, createdAt = new Date(NOW - 2 * HOUR).toISOString()): void {
  const dir = join(paths().school, 'lora', 'adapters', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'adapters.safetensors'), safetensors());
  const runs = join(paths().school, 'ctl', 'lora');
  mkdirSync(runs, { recursive: true });
  const run: LoraRun = {
    id,
    base: getSettings().school.baseModel,
    status: 'trained',
    reason: null,
    iters: 600,
    saved: 600,
    examples: 120,
    createdAt,
    endedAt: createdAt,
    trains: [],
    resumes: [],
    pauses: [],
    good: 600,
    torn: [],
    optimizerReset: false,
    sealedArenas,
    evaluations: [],
  };
  writeFileSync(join(runs, `${id}.json`), JSON.stringify(run, null, 2));
}

function runOf(id: string): LoraRun {
  const r = loraRuns().find((x) => x.id === id);
  assert.ok(r, `no record for ${id}`);
  return r;
}

async function sealedVoyages(): Promise<Array<{ id: string; arena: string; sealed_hash: string }>> {
  const b = await loadBeagle();
  return b.store.open().prepare("SELECT id, arena, sealed_hash FROM voyages WHERE status = 'sealed' ORDER BY started_at, id").all() as never;
}

async function runsOf(voyage: string): Promise<Array<{ genome: string; task: string; score: number; generation: number }>> {
  const b = await loadBeagle();
  return b.store.open().prepare('SELECT genome, task, score, generation FROM runs WHERE voyage = ? ORDER BY task, genome').all(voyage) as never;
}

function schoolDiffs(): string[] {
  return verifyReplay().diffs.filter((d) => /^(graduate|arena|train)\b/.test(d));
}

beforeEach(() => {
  setUp('school-graduate');
  process.env.BEAGLE_BACKOFF_MS = '0';
  NOW = Date.now();
  registered = [];
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  right = () => false;
  before = async () => {};
  setGate(async (kind) => ({ ...gateState(true), kind }));
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  downloadedBase();
  mlxBackend();
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  setGate(null);
  resetGateCache();
  try {
    const b = await loadBeagle();
    for (const id of registered) b.arenas.unregisterArena(id);
  } catch {
    // never loaded
  }
  closeBeagle();
  delete process.env.BEAGLE_HOME;
  delete process.env.BEAGLE_BACKOFF_MS;
  await tearDown();
});

// ---------------------------------------------------------------- graduating

test('an adapter whose paired interval is above zero graduates as mlx:grad-qwen25c7-1 with root collegiate', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;

  const g = await graduate(LORA, NOW);
  assert.ok(g, JSON.stringify(runOf(LORA).evaluations));
  assert.equal(g.id, 'grad-qwen25c7-1');
  assert.equal(g.model, 'mlx:grad-qwen25c7-1');
  assert.equal(g.base, 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit');
  assert.equal(g.loraId, LORA);
  assert.equal(g.examples, 120);
  assert.deepEqual(g.arenas, ['arena-a']);
  assert.equal(g.at, new Date(NOW).toISOString());
  assert.equal(g.agentId, null);
  assert.deepEqual(g.sealed, { value: 1, lo: 1, hi: 1, n: 3 });
  assert.deepEqual(g.baseSealed, { value: 0, lo: 0, hi: 0, n: 3 });
  assert.deepEqual(g.vsBase, { diff: 1, lo: 1, hi: 1 });
  assert.ok(g.vsBase.lo > 0);
  assert.deepEqual(graduates(), [g]);

  // recorded and emitted once, in the shape the city folds (task-37: id, model, base, agentId, at, vsBase, examples)
  const made = query({ kind: ['graduate.made'] }).map((e) => e.data as { graduate: Graduate });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].graduate, g);
  const emitted = events.filter((e) => e.type === 'graduate.made').map((e) => (e.data as { graduate: Graduate }).graduate);
  assert.deepEqual(emitted, [g]);
  for (const k of ['id', 'model', 'base', 'agentId', 'at', 'vsBase', 'examples'] as const) assert.ok(k in emitted[0], k);

  // the LoRA's record keeps the evaluation, and a graduated LoRA is not raced again
  const ev = runOf(LORA).evaluations!.at(-1)!;
  assert.equal(ev.status, 'passed');
  assert.equal(ev.graduate, g.id);
  const racesBefore = (await sealedVoyages()).length;
  assert.deepEqual(await graduate(LORA, NOW + 1000), g);
  assert.equal((await sealedVoyages()).length, racesBefore);

  // hired: a roster agent of origin school, on the mlx model, whose tower is collegiate
  firmWith('quill', 1000);
  const uninstall = installRoster({ trusted: () => true });
  try {
    const agent = hire('quill', new Date(NOW));
    assert.ok(agent);
    assert.equal(agent.id, 'grad-qwen25c7-1');
    assert.equal(agent.model, 'mlx:grad-qwen25c7-1');
    assert.equal(agent.lineage.origin, 'school');
    assert.equal(agent.name, 'Ada Quarry');
    assert.match(agent.persona, /1\.00 \[1\.00, 1\.00\]/);
    const tower = quarters().find((q) => q.firmId === 'quill')!.towers.find((t) => t.agentId === agent.id);
    assert.equal(tower?.root, 'collegiate');
    assert.equal(graduates()[0].agentId, 'grad-qwen25c7-1');
  } finally {
    uninstall();
  }

  // a second LoRA that beats its base is the second of its base
  trainedLora(LORA_2, { 'arena-a': a.sealedHash! });
  right = (model) => model === `mlx:${LORA_2}`;
  const g2 = await graduate(LORA_2, NOW + 2000);
  assert.equal(g2?.model, 'mlx:grad-qwen25c7-2');
  assert.deepEqual(schoolDiffs(), []);
});

test('one spanning zero does not and the reason names the numbers', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  // the adapter wins s1, the base wins s2, both miss s3
  right = (model, q) => (model === ADAPTER ? q === 's1' : q === 's2');

  assert.equal(await graduate(LORA, NOW), null);
  assert.deepEqual(graduates(), []);
  assert.equal(query({ kind: ['graduate.made'] }).length, 0);
  assert.ok(!events.some((e) => e.type === 'graduate.made'));

  const ev = runOf(LORA).evaluations!.at(-1)!;
  const want = pairedCi([1, 0, 0], [0, 1, 0], 1);
  assert.equal(ev.status, 'failed');
  assert.deepEqual(ev.vsBase, want);
  assert.ok(want.lo <= 0 && want.hi > 0, 'the interval spans zero');
  assert.ok(ev.reason?.includes(`${want.diff.toFixed(2)} [${want.lo.toFixed(2)}, ${want.hi.toFixed(2)}]`), ev.reason ?? '');
  assert.match(ev.reason ?? '', /over 3 sealed tasks/);
  assert.match(ev.reason ?? '', /adapter 0\.33 against base 0\.33/);
  assert.equal(ev.graduate, null);
  assert.deepEqual(schoolDiffs(), []);
});

test('only arenas whose sealed tasks its data excluded are used', async () => {
  const a = await fakeArena('arena-a');
  const c = await fakeArena('arena-c');
  // the adapter's data held out arena-a's split as it stands, and arena-c's split before it was rebuilt
  trainedLora(LORA, { 'arena-a': a.sealedHash!, 'arena-c': c.sealedHash! });
  await fakeArena('arena-c', { tag: 'rebuilt' });
  const rebuilt = arenaInfo('arena-c')!;
  assert.notEqual(rebuilt.sealedHash, c.sealedHash);
  // arena-b was built after the data: its sealed tasks were never held out of it
  await fakeArena('arena-b');
  right = (model) => model === ADAPTER;

  const ev = await evaluateAdapter(LORA, NOW);
  assert.equal(ev.status, 'passed');
  assert.deepEqual(ev.arenas.map((x) => x.id), ['arena-a']);
  assert.deepEqual((await sealedVoyages()).map((v) => v.arena), ['arena-a']);
  assert.equal(arenaInfo('arena-a')!.sealedUses, 1);
  assert.equal(arenaInfo('arena-b')!.sealedUses, 0);
  assert.equal(arenaInfo('arena-c')!.sealedUses, 0);
  assert.ok(calls.every((x) => x.q.startsWith('s')), 'only sealed tasks were raced');

  // an adapter with no held-out split anywhere is refused before anything races
  trainedLora(LORA_2, {});
  await assert.rejects(evaluateAdapter(LORA_2, NOW), /held out of its data/);
  assert.equal((await sealedVoyages()).length, 1);
});

test('each evaluation adds a sealed use, and the eleventh is refused with "sealed set spent"', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;

  for (let n = 1; n <= SEALED_USES; n++) {
    const ev = await evaluateAdapter(LORA, NOW + n);
    assert.equal(ev.status, 'passed');
    assert.equal(ev.arenas[0].uses, n);
    assert.equal(arenaInfo('arena-a')!.sealedUses, n);
  }
  assert.equal(arenaInfo('arena-a')!.status, 'spent');
  await assert.rejects(evaluateAdapter(LORA, NOW + 11), /sealed set spent/);
  await assert.rejects(graduate(LORA, NOW + 12), /sealed set spent/);
  assert.equal(arenaInfo('arena-a')!.sealedUses, SEALED_USES);
  assert.equal((await sealedVoyages()).length, SEALED_USES);
  assert.equal(liveTrains().length, 0);
  // each use is carried whole by its train's entries, so the arena replays
  assert.deepEqual(schoolDiffs(), []);
});

test('Beagle\'s store holds the evaluation\'s runs, and the hash it used is the arena\'s sealedHash', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model, q) => model === ADAPTER || q === 's3';

  const ev = await evaluateAdapter(LORA, NOW);
  const b = await loadBeagle();
  const [v] = await sealedVoyages();
  assert.equal(ev.arenas[0].hash, a.sealedHash);
  assert.equal(ev.arenas[0].hash, b.race.sealedHash('arena-a'));
  assert.equal(v.sealed_hash, a.sealedHash);
  const runs = await runsOf(v.id);
  assert.equal(runs.length, 2 * SEALED.length);
  assert.ok(runs.every((r) => r.generation === -1));
  assert.deepEqual([...new Set(runs.map((r) => r.genome))].sort(), ['base', LORA]);
  assert.deepEqual([...new Set(runs.map((r) => r.task))], SEALED.map((q) => `arena-a:${q}`));
  assert.deepEqual(runs.filter((r) => r.genome === 'base').map((r) => r.score), [0, 0, 1]);
  assert.deepEqual(ev.sealed, { value: 1, lo: 1, hi: 1, n: 3 });
  assert.equal(ev.baseSealed?.value, 1 / 3);

  // the adapter and the base, one call at a time, each through the driver under the LoRA
  assert.deepEqual([...new Set(calls.map((x) => x.model))].sort(), [MLX_BASE, ADAPTER]);
  assert.equal(maxInFlight, 1);
  assert.ok(calls.every((x) => x.runId === LORA));
  // charged as train, to the city, under the LoRA
  const rows = openDb().prepare('SELECT firm_id, kind FROM credits WHERE run_id = ?').all(LORA) as Array<{ firm_id: string | null; kind: string }>;
  assert.equal(rows.length, calls.length);
  assert.ok(rows.every((r) => r.firm_id === null && r.kind === 'train'));
  assert.equal(liveLeaseCount(), 0);
  // held as one train of kind eval while it raced, and gone after
  // the start, then the arena's use as its first call was made, carrying the arena whole
  const started = query({ kind: ['train.started'] }).map((e) => e.data as { train: { id: string; kind: string }; arenas: ArenaInfo[]; sealedUse?: string });
  assert.deepEqual(started.map((d) => d.train.kind), ['eval', 'eval']);
  assert.equal(started[0].train.id, started[1].train.id);
  assert.deepEqual(started[0].arenas, []);
  assert.equal(started[1].sealedUse, 'arena-a');
  assert.equal(started[1].arenas[0].sealedUses, 1);
  const ended = query({ kind: ['train.ended'] }).map((e) => e.data as { train: { kind: string; status: string } });
  assert.deepEqual(ended.map((d) => [d.train.kind, d.train.status]), [['eval', 'done']]);
  assert.equal(liveTrains().length, 0);
  assert.deepEqual(schoolDiffs(), []);
});

test('a graduate commutes from the campus to its quarter when hired', async () => {
  ensureCampus();
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;
  const g = await graduate(LORA, NOW);
  assert.ok(g);

  firmWith('quill', 1000);
  openDb().prepare("INSERT INTO jobs (id, repo, status, json) VALUES ('job-1', ?, 'open', '{}')").run(FULL);
  const uninstall = installRoster({ trusted: () => true });
  events = [];
  try {
    dailyTick(NOW + HOUR);
  } finally {
    uninstall();
  }
  const hired = query({ kind: ['agent.hired'] }).map((e) => (e.data as { agent: { id: string; firmId: string; towerIndex: number } }).agent);
  assert.deepEqual(hired.map((x) => x.id), [g.id]);
  const trips = (openDb().prepare('SELECT json FROM trips WHERE agent_id = ?').all(g.id) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip);
  assert.equal(trips.length, 1);
  assert.deepEqual(trips[0].from, campusOrigin());
  assert.deepEqual(trips[0].to, homeOf(hired[0]));
  assert.equal(trips[0].firmId, 'quill');
  // the city hears of the hire before the trip
  const order = events.map((e) => e.type).filter((t) => t === 'agent.hired' || t === 'trip.started');
  assert.deepEqual(order, ['agent.hired', 'trip.started']);
});

// ---------------------------------------------------------------- the server (ruling 26)

test('the base alone is served only for a sealed race, under the same fence, and never beside a heavy train', async () => {
  const mlx = await installMlx();
  // the fence as it is on his Mac: the profile wraps the server (the fake spawner runs nothing)
  delete process.env.PALIMPSEST_SANDBOX;
  try {
    await assert.rejects(ensureServer(MLX_BASE), /only for a graduation's sealed race/);
    assert.equal(mlx.spawned.length, 0);
    const release = serveBase();
    try {
      await ensureServer(MLX_BASE);
      assert.equal(mlx.spawned.length, 1);
      const argv = [mlx.spawned[0].cmd, ...mlx.spawned[0].args];
      assert.equal(argv[0], '/usr/bin/sandbox-exec');
      const profile = argv[argv.indexOf('-f') + 1];
      assert.equal(profile, join(paths().school, 'ctl', 'trainer-serve.sb'));
      const at = argv.indexOf('mlx_lm.server');
      assert.deepEqual(argv.slice(at + 1), ['--model', loraBaseDir(), '--host', '127.0.0.1', '--port', String(mlx.port)]);
      assert.ok(!argv.includes('--adapter-path'));
      const text = readFileSync(profile, 'utf8');
      assert.match(text, /\(deny network\*\)/);
      assert.equal((text.match(/allow network/g) ?? []).length, 2);
      assert.ok(!/network-outbound/.test(text));
      assert.equal(mlx.spawned[0].opts.clearEnv, true);
      assert.equal(mlx.spawned[0].opts.env?.HF_HUB_OFFLINE, '1');

      // a heavy train takes the machine: the base goes down with it and stays down
      const giveBack = await beginHeavy('an arena build');
      assert.deepEqual(mlx.spawned[0].kills, ['SIGTERM']);
      await assert.rejects(ensureServer(MLX_BASE), (err: unknown) => err instanceof GraduatesDown);
      giveBack();
    } finally {
      release();
    }
    await assert.rejects(ensureServer(MLX_BASE), /only for a graduation's sealed race/);
  } finally {
    await uninstallMlx();
  }
});

test('an evaluation never runs beside a heavy train: refused while one holds the machine, stopped unscored when one takes it', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;

  const giveBack = await beginHeavy('a voyage');
  try {
    await assert.rejects(evaluateAdapter(LORA, NOW), /while a voyage runs/);
  } finally {
    giveBack();
  }
  assert.equal(arenaInfo('arena-a')!.sealedUses, 0, 'a refusal spends nothing');

  // an arena build takes the machine during the race: the refused call is never scored, and the evaluation stops
  let back: (() => void) | null = null;
  before = async (_i, n) => {
    if (n === 2) {
      back = await beginHeavy('an arena build');
      throw new GraduatesDown('an arena build');
    }
  };
  try {
    const ev = await evaluateAdapter(LORA, NOW);
    assert.equal(ev.status, 'stopped');
    assert.match(ev.reason ?? '', /an arena build/);
    assert.match(ev.reason ?? '', /1 of 10 sealed uses/);
    assert.equal(ev.vsBase, null);
    const [v] = await sealedVoyages();
    const runs = await runsOf(v.id);
    assert.equal(runs.length, 1, 'only the call answered before the train was scored');
  } finally {
    (back as (() => void) | null)?.();
  }
  assert.equal(arenaInfo('arena-a')!.sealedUses, 1);
  assert.equal(liveTrains().length, 0);
  const paused = query({ kind: ['train.paused'] }).map((e) => e.data as { train: { kind: string } });
  assert.deepEqual(paused.map((d) => d.train.kind), ['eval']);
  assert.deepEqual(graduates(), []);
  assert.equal(runOf(LORA).evaluations!.at(-1)!.status, 'stopped');
  assert.deepEqual(schoolDiffs(), []);
});

test('the tick scores an adapter after the LoRA, once a night, and not while a train runs', async () => {
  const counts = Object.fromEntries(TRAIN_ORDER.map((n) => [n, 0])) as Record<NetName, number>;
  const tried: number[] = [];
  const order: string[] = [];
  const school = startSchool({
    intervalMs: 1e9,
    ask: () => [],
    act: async () => 0,
    labels: () => counts,
    resume: async () => null,
    sail: async () => null,
    lora: async () => {
      order.push('lora');
      return { status: 'trained' };
    },
    graduate: async (now) => {
      order.push('graduate');
      tried.push(now);
      return null;
    },
  });
  try {
    await school.tick(NOW);
    await school.tick(NOW + 60_000);
    assert.deepEqual(tried, [NOW]);
    assert.deepEqual(order.slice(0, 2), ['lora', 'graduate']);
    // a voyage holds a train: the next night's tick scores nothing while it runs
    const unhold = holdTrain({ id: 'train-voyage-x', kind: 'voyage', status: 'running', reason: null, startedAt: new Date(NOW).toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 }, () => {});
    await school.tick(NOW + 24 * HOUR);
    unhold();
    assert.deepEqual(tried, [NOW]);
    await school.tick(NOW + 24 * HOUR + 60_000);
    assert.deepEqual(tried, [NOW, NOW + 24 * HOUR + 60_000]);
  } finally {
    school.stop();
  }
});

// ---------------------------------------------------------------- fix round 1

test('a sealed use is spent only by a race that began: a stop before the second arena leaves it untouched, and replay equals the table', async () => {
  const a = await fakeArena('arena-a');
  const c = await fakeArena('arena-c');
  trainedLora(LORA, { 'arena-a': a.sealedHash!, 'arena-c': c.sealedHash! });
  right = (model) => model === ADAPTER;
  // the stop file is set during arena-a's last call: its race finishes, and arena-c's never begins
  before = async (_i, n) => {
    if (n === 2 * SEALED.length) writeFileSync(paths().stop, '');
  };
  const ev = await evaluateAdapter(LORA, NOW);
  rmSync(paths().stop, { force: true });
  assert.equal(ev.status, 'stopped');
  assert.match(ev.reason ?? '', /stop file/);
  assert.match(ev.reason ?? '', /arena-a: 1 of 10 sealed uses/);
  assert.doesNotMatch(ev.reason ?? '', /arena-c/);
  assert.equal(arenaInfo('arena-a')!.sealedUses, 1);
  assert.equal(arenaInfo('arena-c')!.sealedUses, 0);
  assert.deepEqual((await sealedVoyages()).map((v) => v.arena), ['arena-a']);
  // the use and its entry were written together
  const uses = query({ kind: ['train.started'] }).map((e) => e.data as { sealedUse?: string; arenas: ArenaInfo[] }).filter((d) => d.sealedUse);
  assert.deepEqual(uses.map((d) => [d.sealedUse, d.arenas[0].sealedUses]), [['arena-a', 1]]);
  assert.deepEqual(schoolDiffs(), []);
});

test('an abort before any call spends nothing', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  writeFileSync(paths().stop, '');
  try {
    const ev = await evaluateAdapter(LORA, NOW);
    assert.equal(ev.status, 'stopped');
    assert.match(ev.reason ?? '', /no sealed use was spent/);
  } finally {
    rmSync(paths().stop, { force: true });
  }
  assert.equal(calls.length, 0);
  assert.equal(arenaInfo('arena-a')!.sealedUses, 0);
  assert.deepEqual(await sealedVoyages(), []);
  assert.deepEqual(schoolDiffs(), []);
});

test('after two stopped races the tick stops retrying until he asks', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;
  writeFileSync(paths().stop, '');
  assert.equal(await graduateDue(NOW), null);
  assert.equal(await graduateDue(NOW + 1), null);
  assert.equal(runOf(LORA).evaluations!.length, 2);
  rmSync(paths().stop, { force: true });
  // the third night: not raced, and the record says why in plain words
  assert.equal(await graduateDue(NOW + 2), null);
  assert.equal(runOf(LORA).evaluations!.length, 2);
  assert.match(runOf(LORA).evaluationHeld ?? '', /stopped 2 times before it finished.*until he asks/);
  assert.equal(await graduateDue(NOW + 3), null);
  assert.equal(calls.length, 0);
  // he asks: it is raced again, and graduates
  askEvaluation(LORA, NOW + 4);
  assert.equal(runOf(LORA).evaluationHeld, null);
  const g = await graduateDue(NOW + 5);
  assert.equal(g?.model, 'mlx:grad-qwen25c7-1');
});

test('an arena build click is refused while a graduation race runs', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  right = (model) => model === ADAPTER;
  let clicked: ArenaInfo | null = null;
  before = async (_i, n) => {
    if (n === 1) clicked = await buildPlanted({ fullName: FULL } as Repo, NOW);
  };
  const ev = await evaluateAdapter(LORA, NOW);
  assert.equal(ev.status, 'passed');
  const got = clicked as ArenaInfo | null;
  assert.equal(got?.status, 'failed');
  assert.equal(got?.reason, 'A graduation race is running; build the arena once it ends');
  assert.equal(query({ kind: ['arena.built'] }).length, 1, 'only the fixture\'s arena was recorded');
});

test('Beagle\'s concurrency a race set aside is put back after it, and at engine start after a crash', async () => {
  const a = await fakeArena('arena-a');
  trainedLora(LORA, { 'arena-a': a.sealedHash! });
  const b = await loadBeagle();
  const setting = () => (b.store.open().prepare("SELECT value FROM settings WHERE key = 'concurrency'").get() as { value: string } | undefined)?.value ?? null;
  b.store.open().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrency', '3')").run();
  await evaluateAdapter(LORA, NOW);
  assert.equal(setting(), '3');
  assert.equal(existsSync(concurrencyMarker()), false);

  // an engine that stopped mid-race never ran its restore
  oneRunAtATime(b);
  assert.equal(setting(), '1');
  assert.equal(existsSync(concurrencyMarker()), true);
  assert.equal(await restoreBeagleConcurrency(), true);
  assert.equal(setting(), '3');
  assert.equal(existsSync(concurrencyMarker()), false);
  assert.equal(await restoreBeagleConcurrency(), false);
});
