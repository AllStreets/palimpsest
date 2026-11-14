/**
 * Voyages (Phase 4 Task 22, ruling 22): the school breeds agents on one of
 * his repos' arenas over several nights through Beagle. Beagle is real and
 * its store lives under the temp school; the arena is a fake one (no repo,
 * no suite: an answer is right or wrong), and every model call goes through
 * the school's driver to fake Ollama and Claude backends. No real model, no
 * network, no real home.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { paths } from '../engine/home.js';
import { query, record } from '../engine/ledger.js';
import { acquire, creditsFor, liveLeaseCount, schoolClaudeSpent, type Lease } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import type { CompleteInput, CompleteResult, Usage } from '../engine/market/provider.js';
import { providerFor, setProvider } from '../engine/market/providers.js';
import { heavyRunning, serverState } from '../engine/market/mlx.js';
import { verifyReplay } from '../engine/market/replay.js';
import { balances, replayBalances } from '../engine/market/treasury.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { arenaInfo, toBeagleArena } from '../engine/school/arenas.js';
import type { BeagleArena } from '../engine/school/beagle-api.js';
import { closeBeagle, loadBeagle } from '../engine/school/beagle.js';
import { campusOrigin, ensureCampus } from '../engine/school/campus.js';
import { resetGateCache } from '../engine/school/gate.js';
import { schoolOff, startSchool, TURNED_OFF_REASON } from '../engine/school/tick.js';
import { failInterruptedTrains, liveTrains, setGate } from '../engine/school/trainer.js';
import { commission } from '../engine/school/roster.js';
import { pauseStrandedVoyages, sailVoyage, setVoyagePoll, voyages } from '../engine/school/voyages.js';
import { localDay } from '../shared/day.js';
import { COMMISSION, SEALED_USES, VOYAGE } from '../shared/school-rules.js';
import type { ArenaInfo, GateState, Trip, VoyageView } from '../shared/types.js';
import { addAgent, FULL, HOUR, setUp, tearDown } from './guild-fixtures.js';
import { floorOn } from './roster-fixtures.js';
import { completion, GRAD_1, installMlx, uninstallMlx, until } from './mlx-fixtures.js';

const ARENA = 'arena-fake';
const LOCAL = 'ollama:qwen2.5-coder:7b';
const DESIGNER_LOCAL = 'ollama:qwen3-coder:30b';
const TASKS = {
  breeding: ['b1', 'b2', 'b3', 'b4'],
  race: ['r1', 'r2', 'r3'],
  sealed: ['s1', 's2', 's3'],
} as const;
const RACE_RUNS = VOYAGE.population * TASKS.race.length;

let NOW = 0;
let events: Event[] = [];
let unsubscribe: () => void = () => {};
let gateOk: () => boolean = () => true;
let gateReads = 0;
/** Every call the fake backends saw, in order. */
let calls: Array<{ model: string; system: string; user: string; runId: string | null }> = [];
let inFlight = 0;
let maxInFlight = 0;

function gateState(ok: boolean): GateState {
  return { kind: 'heavy', ok, reason: ok ? null : 'on battery', power: ok ? 'ac' : 'battery', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

/** His latest usage reading, taken at `at`, so Claude is neither stale nor near a stop. */
function readingAt(at: number): void {
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(at / 1000),
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: Math.floor((at + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((at + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

const LOCAL_USAGE: Usage = { weightedTokens: 0, seconds: 1, usd: 0, credits: 0 };

/** The designer's answer: three children told to be SHARP (always right) and three told to be DULL (as wrong as the starters), all from the best agent. */
function designerReply(i: CompleteInput, usage: Usage): CompleteResult {
  const user = i.turns.map((t) => t.content).join('\n');
  const best = /^(\S+) "/m.exec(user)?.[1] ?? 'unknown';
  const child = (n: number, kind: 'SHARP' | 'DULL') => ({
    name: `${kind} ${n}`,
    parents: [best],
    model: LOCAL,
    instructions: kind === 'SHARP' ? 'Be SHARP: answer right.' : 'Be DULL.',
    tools: [],
    workflow: { shape: 'single' },
    memory: { examples: 0 },
    reason: `the misses of ${best}`,
  });
  const json = { children: [child(1, 'SHARP'), child(2, 'SHARP'), child(3, 'SHARP'), child(1, 'DULL'), child(2, 'DULL'), child(3, 'DULL')] };
  return { text: JSON.stringify(json), json, usage };
}

/** An agent's answer: right only when its instructions say SHARP. */
function agentReply(i: CompleteInput): CompleteResult {
  const reply = { action: 'answer', answer: { fix: i.system.includes('SHARP') ? 'right' : 'wrong' } };
  return { text: JSON.stringify(reply), json: reply, usage: LOCAL_USAGE };
}

function backends(o: { claudeUsage?: Usage; hold?: (i: CompleteInput) => Promise<void> | null } = {}): void {
  const answer = async (i: CompleteInput): Promise<CompleteResult> => {
    calls.push({ model: i.model, system: i.system, user: i.turns.map((t) => t.content).join('\n'), runId: i.runId });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await (o.hold?.(i) ?? null);
      // a turn of the event loop, so two calls could overlap if Beagle ran them at once
      await new Promise((r) => setImmediate(r));
      if (i.system.startsWith('You design agents')) return designerReply(i, i.model.startsWith('claude:') ? (o.claudeUsage ?? LOCAL_USAGE) : LOCAL_USAGE);
      return agentReply(i);
    } finally {
      inFlight--;
    }
  };
  setProvider('ollama', fakeProvider({ complete: answer }));
  setProvider('claude', fakeProvider({ complete: answer }));
}

const show = (input: unknown) => `Task ${(input as { q: string }).q}`;

/** A ready arena of ten tasks written into the school's tables and Beagle's store, raced through a fake BeagleArena. */
async function fakeArena(o: { sealedUses?: number; status?: ArenaInfo['status']; breedingRef?: string | null; sealedRef?: string | null } = {}): Promise<ArenaInfo> {
  const b = await loadBeagle();
  const rows = (Object.entries(TASKS) as Array<[keyof typeof TASKS, readonly string[]]>).flatMap(([split, ids]) =>
    ids.map((q) => ({ id: `${ARENA}:${q}`, split, q, ref: split === 'breeding' && q === 'b1' ? (o.breedingRef ?? null) : split === 'sealed' && q === 's1' ? (o.sealedRef ?? null) : null })),
  );
  const put = openDb().prepare('INSERT OR REPLACE INTO arena_tasks (id, arena, split, ref, json) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) {
    const truth = r.ref ? { kind: 'past', ref: r.ref, sha: r.ref, commits: [r.ref] } : { kind: 'planted', fix: 'right' };
    put.run(r.id, ARENA, r.split, r.ref, JSON.stringify({ id: r.id, arena: ARENA, split: r.split, ref: r.ref, input: { q: r.q }, truth }));
  }
  b.store.putArena(ARENA, `${FULL}: planted bugs`);
  b.store.putTasks(ARENA, rows.map((r) => ({ id: r.id, input: { q: r.q }, truth: { fix: 'right' }, split: r.split })));
  const base = toBeagleArena({ id: ARENA, repo: FULL, kind: 'planted' });
  const arena: BeagleArena = {
    ...base,
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
  const info: ArenaInfo = {
    id: ARENA,
    repo: FULL,
    kind: 'planted',
    sha: 'a'.repeat(40),
    tasks: { breeding: TASKS.breeding.length, race: TASKS.race.length, sealed: TASKS.sealed.length },
    candidates: 10,
    kept: 10,
    sealedUses: o.sealedUses ?? 0,
    sealedHash: b.race.sealedHash(ARENA),
    builtAt: new Date(NOW - HOUR).toISOString(),
    status: o.status ?? 'ready',
    reason: null,
  };
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
  // the ledger carries the arena as arenas.ts records it, so the replay agrees
  (await import('../engine/ledger.js')).record('arena.built', { arena: info });
  return info;
}

/** Eight seeded agents on a local model (the voyage's first generation), with their firm. */
function seedLocals(n = VOYAGE.population): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `seed-${i + 1}`;
    addAgent(id, 'quill', LOCAL, { name: `Seed ${i + 1}`, towerIndex: i % 4 });
    ids.push(id);
  }
  return ids;
}

async function runsOf(voyageId: string): Promise<Array<{ id: string; generation: number; genome: string; task: string }>> {
  const b = await loadBeagle();
  return b.store.open().prepare('SELECT id, generation, genome, task FROM runs WHERE voyage = ? ORDER BY at, id').all(voyageId) as never;
}

function ledgerOf(kind: string): Array<Record<string, unknown>> {
  return query({ kind: [kind as never] }).map((e) => e.data as Record<string, unknown>);
}

/** The school's tables (voyages, trains, arenas) replay from the ledger; the fixture's firm and agents are written straight to their tables. */
function assertSchoolReplays(): void {
  const diffs = verifyReplay().diffs.filter((d) => /^(voyage|train|arena)\b/.test(d));
  assert.deepEqual(diffs, []);
}

function storedTrips(): Trip[] {
  return (openDb().prepare("SELECT json FROM trips ORDER BY json_extract(json, '$.startedAt')").all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip);
}

beforeEach(() => {
  setUp('school-voyages');
  process.env.BEAGLE_BACKOFF_MS = '0';
  NOW = Date.now();
  readingAt(NOW);
  ensureCampus();
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  gateOk = () => true;
  gateReads = 0;
  setGate(async (kind) => {
    gateReads++;
    return { ...gateState(gateOk()), kind };
  });
  patchSettings({ school: { ...getSettings().school, enabled: true, designer: DESIGNER_LOCAL } });
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  setVoyagePoll(null);
  setGate(null);
  resetGateCache();
  try {
    (await loadBeagle()).arenas.unregisterArena(ARENA);
  } catch {
    // never registered
  }
  closeBeagle();
  delete process.env.BEAGLE_HOME;
  delete process.env.BEAGLE_BACKOFF_MS;
  await tearDown();
});

// ---------------------------------------------------------------- a whole voyage

test('a voyage of 8 runs 4 generations and records each', async () => {
  const seeds = seedLocals();
  backends();
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);

  assert.equal(view.status, 'done', view.reason ?? '');
  assert.equal(view.generation, VOYAGE.generations);
  assert.equal(view.of, VOYAGE.generations);
  assert.equal(view.arena, ARENA);
  assert.equal(view.repo, FULL);
  assert.deepEqual(view.runs, { done: RACE_RUNS * VOYAGE.generations, of: RACE_RUNS * VOYAGE.generations });
  assert.equal(view.commissionedBy, null);
  assert.ok(view.endedAt);
  // eight genomes raced in each of the four generations
  for (let g = 1; g <= VOYAGE.generations; g++) {
    const gen = view.scores.filter((s) => s.generation === g);
    assert.ok(gen.length >= 2 && gen.length <= VOYAGE.population, `generation ${g} has ${gen.length}`);
  }
  assert.deepEqual(
    view.scores.filter((s) => s.generation === 1).map((s) => s.genome).sort(),
    [...seeds].sort(),
  );
  const runs = await runsOf(view.id);
  assert.equal(runs.length, RACE_RUNS * VOYAGE.generations);
  assert.deepEqual([...new Set(runs.map((r) => r.generation))].sort(), [0, 1, 2, 3]);

  // the ledger: started, one generation entry per generation, ended; each with the whole view and the repo
  const started = ledgerOf('voyage.started');
  const gens = ledgerOf('voyage.generation');
  const ended = ledgerOf('voyage.ended');
  assert.equal(started.length, 1);
  assert.deepEqual(gens.map((d) => (d.voyage as VoyageView).generation), [1, 2, 3, 4]);
  assert.equal(ended.length, 1);
  for (const d of [...started, ...gens, ...ended]) {
    assert.equal(d.voyageId, view.id);
    assert.equal(d.repo, FULL);
    assert.equal((d.voyage as VoyageView).id, view.id);
  }
  assert.deepEqual(ended[0].voyage, view);
  assert.deepEqual(voyages(), [view]);

  // the city's events: the same shape the campus folds
  const types = events.map((e) => e.type).filter((t) => /^(voyage|train)\./.test(t));
  assert.equal(types[0], 'train.started');
  assert.equal(types[1], 'voyage.started');
  assert.equal(types.at(-1), 'train.ended');
  assert.ok(types.includes('voyage.ended'));
  const firstStart = events.find((e) => e.type === 'voyage.started')!.data as { voyage: VoyageView; voyageId: string; repo: string };
  assert.equal(firstStart.voyage.status, 'sailing');
  assert.equal(firstStart.voyage.scores.filter((s) => s.generation === 1).length, VOYAGE.population, 'the population before any is scored');
  const trainStart = events.find((e) => e.type === 'train.started')!.data as { train: { id: string; kind: string } };
  assert.equal(trainStart.train.kind, 'voyage');
  assert.equal(liveTrains().length, 0, 'the voyage holds no train once it ends');

  // every call ran under the voyage, through the school's driver, charged to the city
  assert.ok(calls.every((c) => c.runId === view.id));
  const rows = openDb().prepare("SELECT firm_id, kind FROM credits WHERE run_id = ?").all(view.id) as Array<{ firm_id: string | null; kind: string }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.firm_id === null && r.kind === 'school'));
  assert.equal(liveLeaseCount(), 0);

  assertSchoolReplays();
});

test('a child with lo at or below zero is not promoted', async () => {
  seedLocals();
  backends();
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done', view.reason ?? '');
  const names = new Map(view.scores.map((s) => [s.genome, s.name]));
  assert.ok(view.promoted.length > 0, 'the SHARP children of the starters are promoted');
  for (const p of view.promoted) {
    assert.ok(p.lo > 0, `${p.child} promoted with lo ${p.lo}`);
    assert.match(names.get(p.child) ?? '', /SHARP/);
  }
  // DULL children (no better than their parent: every difference zero, or below) are never promoted
  const dull = view.scores.filter((s) => /DULL/.test(s.name)).map((s) => s.genome);
  assert.ok(dull.length > 0);
  for (const d of dull) assert.ok(!view.promoted.some((p) => p.child === d), `${d} is not promoted`);
  // a SHARP child of a SHARP parent ties it: not promoted either
  const sharpOfSharp = view.scores.filter((s) => /SHARP/.test(s.name) && s.parents.some((p) => /SHARP/.test(names.get(p) ?? '')));
  assert.ok(sharpOfSharp.length > 0);
  for (const s of sharpOfSharp) assert.ok(!view.promoted.some((p) => p.child === s.genome));

  // an unpromoted child is not kept: the next generation is never bred from it, and it is never the champion
  const b = await loadBeagle();
  const parents = (b.store.open().prepare('SELECT parent_ids FROM genomes WHERE voyage = ? AND generation >= 0').all(view.id) as Array<{ parent_ids: string }>).flatMap((r) => JSON.parse(r.parent_ids) as string[]);
  for (const d of dull) assert.ok(!parents.includes(d), `nothing is bred from ${d}`);
  const bred = (b.store.open().prepare('SELECT id FROM genomes WHERE voyage = ? AND generation BETWEEN 1 AND 3').all(view.id) as Array<{ id: string }>).map((r) => r.id);
  assert.ok(view.champion);
  assert.ok(!dull.includes(view.champion.genome));
  assert.match(view.champion.name, /SHARP/);
  assert.ok(bred.includes(view.champion.genome));
});

test('the designer sees only breeding tasks', async () => {
  seedLocals();
  backends();
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done', view.reason ?? '');
  const design = calls.filter((c) => c.system.startsWith('You design agents'));
  assert.equal(design.length, VOYAGE.generations - 1);
  assert.ok(design.every((c) => c.model === DESIGNER_LOCAL), 'the designer setting answers Beagle\'s designer');
  const hidden = [...TASKS.race, ...TASKS.sealed].map((q) => `Task ${q}`);
  for (const c of design) {
    for (const h of hidden) assert.ok(!c.user.includes(h) && !c.system.includes(h), `the designer never sees ${h}`);
  }
  // the starters miss every breeding task they are probed on: the first design is shown those misses
  assert.ok(TASKS.breeding.some((q) => design[0].user.includes(`Task ${q}`)), 'the designer sees the breeding misses');
  // the worked examples every agent is shown come from the breeding split too
  for (const c of calls) for (const s of TASKS.sealed) assert.ok(!c.system.includes(`Task ${s}`), 'no sealed task is a worked example');
});

test('a breeding task that shares a change with the sealed split stops the voyage before anything is bred', async () => {
  seedLocals();
  backends();
  // b1 and s1 come from the same change: showing b1 to the designer would show it part of a sealed answer
  await fakeArena({ breedingRef: 'c'.repeat(40), sealedRef: 'c'.repeat(40) });
  await assert.rejects(sailVoyage(ARENA, NOW), /shares a change with the sealed split/);
  assert.equal(calls.length, 0, 'nothing raced and nothing was bred');
  assert.deepEqual(voyages(), []);
  assert.equal(liveTrains().length, 0);
});

// ---------------------------------------------------------------- nights

test('a gate loss aborts unscored and the next night\'s race skips the stored runs', async () => {
  seedLocals();
  backends();
  await fakeArena();
  // the gate holds for the voyage's start and its first five runs (one model call each), then he unplugs the Mac
  gateOk = () => calls.length < 5;
  const night1 = await sailVoyage(ARENA, NOW);
  assert.equal(night1.status, 'paused');
  assert.equal(night1.reason, 'on battery');
  assert.equal(night1.endedAt, null);
  const stored = await runsOf(night1.id);
  assert.ok(stored.length >= 5 && stored.length < RACE_RUNS, `${stored.length} runs stored`);
  assert.equal(night1.runs.done, stored.length);
  const raceCalls1 = calls.length;
  assert.ok(raceCalls1 >= stored.length && raceCalls1 <= stored.length + 1, 'at most the run under way was cut short, unscored');
  // the pause: the view, the train and the ledger
  const paused = ledgerOf('voyage.generation').at(-1)!.voyage as VoyageView;
  assert.equal(paused.status, 'paused');
  const trainPaused = ledgerOf('train.paused');
  assert.equal(trainPaused.length, 1);
  assert.equal((trainPaused[0].train as { kind: string }).kind, 'voyage');
  assert.equal(liveTrains().length, 0);
  assert.equal(liveLeaseCount(), 0);

  // the next night: the same voyage resumes, and no stored run is run again
  gateOk = () => true;
  calls = [];
  const night2At = NOW + 2 * HOUR;
  readingAt(night2At);
  const night2 = await sailVoyage(ARENA, night2At);
  assert.equal(night2.id, night1.id);
  assert.equal(night2.status, 'done', night2.reason ?? '');
  const firstDesign = calls.findIndex((c) => c.system.startsWith('You design agents'));
  const raced = calls.slice(0, firstDesign).filter((c) => /Task r\d/.test(c.user));
  assert.equal(raced.length, RACE_RUNS - stored.length, 'generation one\'s race ran only the runs not stored');
  const after = await runsOf(night1.id);
  for (const r of stored) assert.ok(after.some((x) => x.id === r.id), 'a stored run is kept as it was');
  assert.equal(after.length, RACE_RUNS * VOYAGE.generations);
  assert.equal(voyages().length, 1);
  assert.equal(ledgerOf('voyage.started').length, 1, 'a resumed voyage is not started again');
});

test('Beagle runs at concurrency 1', async () => {
  seedLocals();
  backends();
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done', view.reason ?? '');
  const b = await loadBeagle();
  const v = b.race.getVoyage(view.id);
  assert.equal(v.settings.concurrency, VOYAGE.concurrency);
  assert.equal(v.settings.population, VOYAGE.population);
  assert.equal(v.settings.generations, VOYAGE.generations);
  assert.equal(v.settings.localAgents, true, 'the agents race on local models only');
  assert.equal(maxInFlight, 1, 'never two model calls at once');
});

// ---------------------------------------------------------------- the champion

test('the champion is compared only with seeded local agents and the view says Claude agents were not compared', async () => {
  const seeds = seedLocals();
  addAgent('seed-claude', 'quill', 'claude:sonnet', { name: 'Seed Claude' });
  addAgent('roster-local', 'quill', LOCAL, { name: 'Roster', lineage: { origin: 'roster', parents: [], generation: 0, at: '2026-11-01T00:00:00.000Z' } });
  backends();
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done', view.reason ?? '');
  assert.ok(view.champion);
  assert.deepEqual(view.vsLocal?.map((v) => v.agent).sort(), [...seeds].sort());
  for (const v of view.vsLocal ?? []) assert.ok(v.lo > 0, `the champion beats ${v.agent}`);
  assert.equal(view.claim, true);
  assert.ok(view.sealed && view.sealed.value === 1);
  assert.match(view.notCompared ?? '', /Claude agents were not compared/);
  // no Claude model ran anywhere in the voyage, the sealed race included
  assert.ok(calls.every((c) => c.model.startsWith('ollama:')));
  // one sealed race, counted as one use of the arena's sealed split, carried whole on voyage.ended
  const b = await loadBeagle();
  const sealedVoyages = b.store.open().prepare("SELECT id FROM voyages WHERE status = 'sealed'").all() as unknown[];
  assert.equal(sealedVoyages.length, 1);
  assert.equal(arenaInfo(ARENA)?.sealedUses, 1);
  const ended = ledgerOf('voyage.ended')[0];
  assert.equal((ended.arena as ArenaInfo).sealedUses, 1);
  assertSchoolReplays();
});

test('a spent arena (10 sealed uses) makes no champion claim', async () => {
  seedLocals();
  backends();
  await fakeArena({ sealedUses: SEALED_USES, status: 'spent' });
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done', view.reason ?? '');
  assert.ok(view.champion, 'the voyage still names its best');
  assert.equal(view.claim, false);
  assert.equal(view.sealed, null);
  assert.deepEqual(view.vsLocal, []);
  assert.match(view.reason ?? '', /sealed split is spent/);
  const b = await loadBeagle();
  assert.equal((b.store.open().prepare("SELECT COUNT(*) AS n FROM voyages WHERE status = 'sealed'").get() as { n: number }).n, 0, 'no sealed race ran');
  assert.equal(arenaInfo(ARENA)?.sealedUses, SEALED_USES);

  // the tenth use spends the arena
  await fakeArena({ sealedUses: SEALED_USES - 1 });
  const last = await sailVoyage(ARENA, NOW + HOUR);
  assert.equal(last.status, 'done');
  assert.equal(last.claim, true);
  assert.equal(arenaInfo(ARENA)?.sealedUses, SEALED_USES);
  assert.equal(arenaInfo(ARENA)?.status, 'spent');
});

// ---------------------------------------------------------------- the school's Claude spend

test('school Claude spend in a voyage stops at the day\'s 30 credits', async () => {
  seedLocals();
  // each design costs 14 credits: two fit in the day's 30, the third is refused
  const per = creditsFor('claude:sonnet', { weightedTokens: 1_000_000, seconds: 0, usd: 0, credits: 0 });
  const claudeUsage: Usage = { weightedTokens: Math.round((14 / per) * 1_000_000), seconds: 30, usd: 0.4, credits: 0 };
  backends({ claudeUsage });
  patchSettings({ school: { ...getSettings().school, designer: 'claude:sonnet' } });
  await fakeArena();
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'paused');
  assert.match(view.reason ?? '', /credits a day/);
  const spent = schoolClaudeSpent(localDay(NOW), NOW + HOUR);
  assert.ok(spent > 20 && spent <= getSettings().school.claudeCreditsPerDay, `the school spent ${spent} on Claude`);
  const design = calls.filter((c) => c.model.startsWith('claude:'));
  assert.equal(design.length, 2, 'two designs, then the allowance refused the third');
  assert.ok(calls.filter((c) => !c.system.startsWith('You design agents')).every((c) => c.model.startsWith('ollama:')), 'the agents race on local models');
  assert.equal(view.generation, 4, 'generation four was being bred');
  // the Claude rows are the city's, under the voyage
  const rows = openDb().prepare("SELECT firm_id, run_id FROM credits WHERE json_extract(json, '$.model') LIKE 'claude:%'").all() as Array<{ firm_id: string | null; run_id: string }>;
  assert.ok(rows.every((r) => r.firm_id === null && r.run_id === view.id));
  assert.ok(view.credits >= spent);
});

// ---------------------------------------------------------------- the switch, the stop file, one train at a time

test('school off ends the race at once, even while a call waits for its lease, and one train runs at a time', async () => {
  seedLocals();
  backends();
  await fakeArena();
  // a market run holds the local model: the voyage's first call waits in the school's queue
  const got = await acquire(LOCAL, 'work', 10);
  assert.ok(got.ok);
  const work: Lease = got.lease;
  const sailing = sailVoyage(ARENA, NOW);
  // wait until the voyage holds its train
  for (let i = 0; i < 200 && liveTrains().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(liveTrains().length, 1);
  assert.equal(liveTrains()[0].kind, 'voyage');
  // one voyage at a time, and nothing else trains while it sails
  await assert.rejects(sailVoyage(ARENA, NOW), /already sailing/);
  const school = startSchool({ intervalMs: 1e9, ask: () => [], act: async () => 0, labels: () => ({}) as never, resume: async () => null, sail: async () => null });
  try {
    const tick = await school.tick(NOW);
    assert.equal(tick.reason, 'a train is already running');
  } finally {
    school.stop();
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0, 'the call is still waiting for the local model');

  const t0 = Date.now();
  schoolOff(NOW);
  const view = await sailing;
  assert.ok(Date.now() - t0 < 2_000, 'the race ended at once');
  assert.equal(view.status, 'paused');
  assert.equal(view.reason, TURNED_OFF_REASON);
  assert.equal(calls.length, 0);
  assert.equal((await runsOf(view.id)).length, 0, 'no run was scored');
  // the late lease is handed back when the market run frees the slot
  work.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(liveLeaseCount(), 0);
  assert.equal(liveTrains().length, 0);
});

test('the stop file ends the race at once', async () => {
  seedLocals();
  backends();
  await fakeArena();
  setVoyagePoll(10);
  const got = await acquire(LOCAL, 'work', 10);
  assert.ok(got.ok);
  const sailing = sailVoyage(ARENA, NOW);
  for (let i = 0; i < 200 && liveTrains().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  writeFileSync(paths().stop, '');
  const view = await sailing;
  assert.equal(view.status, 'paused');
  assert.match(view.reason ?? '', /stop file/);
  got.lease.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(liveLeaseCount(), 0);
});

test('a voyage does not sail while another train runs, or with the school off', async () => {
  seedLocals();
  backends();
  await fakeArena();
  patchSettings({ school: { ...getSettings().school, enabled: false } });
  await assert.rejects(sailVoyage(ARENA, NOW), /school is off/);
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  gateOk = () => false;
  await assert.rejects(sailVoyage(ARENA, NOW), /on battery/);
  assert.equal(voyages().length, 0);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- commissions and trips

/** Quill, the seeds' firm, with `balance` on its books and a floor on the arena's repo: a firm that may commission. */
function quillMayCommission(balance: number): void {
  const f = { id: 'quill', name: 'Quill', root: 'roman', motto: '', slot: 120, balance, status: 'active', negativeSince: null, bankruptAt: null, createdAt: '2026-11-01T00:00:00.000Z' };
  openDb().prepare('INSERT OR REPLACE INTO firms (id, json) VALUES (?, ?)').run(f.id, JSON.stringify(f));
  record('firm.seeded', { firm: f });
  floorOn('seed-1', FULL);
}

const quillRows = () => (openDb().prepare("SELECT kind, amount, run_id FROM credits WHERE firm_id = 'quill' ORDER BY id").all() as Array<{ kind: string; amount: number; run_id: string | null }>).map((r) => ({ ...r }));

test("a commissioned voyage's credits leave the firm only as the fee", async () => {
  seedLocals();
  quillMayCommission(500);
  // the designer is Claude at 3 credits a design; the agents race on the local model
  const per = creditsFor('claude:sonnet', { weightedTokens: 1_000_000, seconds: 0, usd: 0, credits: 0 });
  backends({ claudeUsage: { weightedTokens: Math.round((3 / per) * 1_000_000), seconds: 30, usd: 0.1, credits: 0 } });
  patchSettings({ school: { ...getSettings().school, designer: 'claude:sonnet' } });
  await fakeArena();
  const queued = commission('quill', ARENA, NOW);
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  const view = await sailVoyage(ARENA, NOW + 1000);

  assert.equal(view.status, 'done', view.reason ?? '');
  assert.equal(view.id, queued.id, 'the voyage sails under the id the fee was paid for');
  assert.equal(view.commissionedBy, 'quill');
  assert.ok(calls.some((c) => c.model.startsWith('claude:')) && calls.some((c) => c.model.startsWith('ollama:')), 'Claude and local calls both ran');
  // the firm paid the fee and nothing else
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  assert.deepEqual(quillRows(), [{ kind: 'commission', amount: COMMISSION.fee, run_id: null }]);
  // every credits row of the voyage is the city's
  const rows = openDb().prepare('SELECT firm_id, kind FROM credits WHERE run_id = ?').all(view.id) as Array<{ firm_id: string | null; kind: string }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.firm_id === null && r.kind === 'school'), "a commissioned voyage's spend is the city's");
  assert.ok(view.credits > 0);
  // one voyage.commissioned, at commissioning, with the fee; the voyage's start carries its firm
  const c = ledgerOf('voyage.commissioned');
  assert.equal(c.length, 1);
  assert.equal(c[0].voyageId, view.id);
  assert.equal(c[0].firmId, 'quill');
  assert.equal(c[0].fee, COMMISSION.fee);
  assert.equal(events.filter((e) => e.type === 'voyage.commissioned').length, 1);
  const started = ledgerOf('voyage.started');
  assert.equal(started.length, 1);
  assert.equal((started[0].voyage as VoyageView).id, view.id);
  assert.equal((started[0].voyage as VoyageView).commissionedBy, 'quill');
  assert.equal((started[0].voyage as VoyageView).scores.filter((x) => x.generation === 1).length, VOYAGE.population);
  assert.ok(Date.parse((started[0].voyage as VoyageView).startedAt) >= NOW + 1000, 'it started when it sailed');
  assert.equal(voyages().length, 1);
  assertSchoolReplays();
  assert.deepEqual(replayBalances(query({})).quill, balances().quill);
});

test('a paused commissioned voyage refunds nothing', async () => {
  seedLocals();
  quillMayCommission(500);
  backends();
  await fakeArena();
  const queued = commission('quill', ARENA, NOW);
  gateOk = () => calls.length < 5;
  const night1 = await sailVoyage(ARENA, NOW + 1000);
  assert.equal(night1.id, queued.id);
  assert.equal(night1.status, 'paused');
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  assert.deepEqual(quillRows(), [{ kind: 'commission', amount: COMMISSION.fee, run_id: null }]);

  // it resumes first on the next night and finishes: still nothing back, and never a second commission
  gateOk = () => true;
  const night2At = NOW + 2 * HOUR;
  readingAt(night2At);
  const night2 = await sailVoyage(ARENA, night2At);
  assert.equal(night2.id, queued.id);
  assert.equal(night2.status, 'done', night2.reason ?? '');
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  assert.deepEqual(quillRows(), [{ kind: 'commission', amount: COMMISSION.fee, run_id: null }]);
  assert.equal(ledgerOf('voyage.commissioned').length, 1);
  assert.equal(ledgerOf('voyage.started').length, 1);
  assert.ok(query({ kind: ['credits.moved'] }).every((e) => (e.data as { delta: number }).delta <= 0), 'no credits came back to any firm');
  assertSchoolReplays();
});

test('a commissioned voyage whose engine stopped between Beagle\'s start and its first record sails on the next start, not wedged', async () => {
  seedLocals();
  quillMayCommission(500);
  backends();
  await fakeArena();
  const queued = commission('quill', ARENA, NOW);
  // the last engine started it in Beagle under the commissioned id, then stopped before it stored or recorded anything
  const b = await loadBeagle();
  const bv = b.race.startVoyage(ARENA, { concurrency: VOYAGE.concurrency, population: VOYAGE.population, generations: VOYAGE.generations, raceTasks: TASKS.race.length, localAgents: true, localOnly: false, seed: 1 });
  b.store.open().prepare('UPDATE voyages SET id = ? WHERE id = ?').run(queued.id, bv.id);
  assert.deepEqual(voyages().find((v) => v.id === queued.id)?.scores, [], 'the stored voyage is still queued');

  const view = await sailVoyage(ARENA, NOW + 1000);
  assert.equal(view.id, queued.id);
  assert.equal(view.status, 'done', view.reason ?? '');
  assert.equal((b.store.open().prepare('SELECT COUNT(*) AS n FROM voyages WHERE id = ?').get(queued.id) as { n: number }).n, 1);
  assert.equal(ledgerOf('voyage.started').length, 1);
  assert.equal(ledgerOf('voyage.commissioned').length, 1);
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  assertSchoolReplays();
});

test('parents travel to the campus and home', async () => {
  const seeds = seedLocals();
  backends();
  await fakeArena();
  const campus = campusOrigin();
  assert.ok(campus);
  const view = await sailVoyage(ARENA, NOW);
  assert.equal(view.status, 'done');
  const trips = storedTrips();
  for (const id of seeds) {
    const mine = trips.filter((t) => t.agentId === id);
    const there = mine.find((t) => t.reason === 'school');
    assert.ok(there, `${id} went to school`);
    assert.deepEqual(there.to, campus);
    const home = mine.find((t) => t.reason === 'home');
    assert.ok(home, `${id} went home`);
    assert.deepEqual(home.from, campus);
    assert.ok(Date.parse(home.startedAt) >= Date.parse(there.startedAt));
  }
  const started = events.filter((e) => e.type === 'trip.started').map((e) => (e.data as { trip: Trip }).trip);
  assert.ok(started.some((t) => t.reason === 'school'));
});

test('a pause during the sealed race says the sealed use was spent, and a resume spends another', async () => {
  seedLocals();
  // the first sealed task the champion's race reaches turns the school off
  let stopped = false;
  backends({
    hold: (i) => {
      if (!stopped && i.turns.some((t) => /Task s\d/.test(t.content))) {
        stopped = true;
        schoolOff(NOW);
      }
      return null;
    },
  });
  await fakeArena();
  const paused = await sailVoyage(ARENA, NOW);
  assert.ok(stopped, 'the sealed race was reached');
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason ?? '', new RegExp(`^${TURNED_OFF_REASON}`));
  assert.match(paused.reason ?? '', /stopped the champion's sealed race, which had already spent one sealed use of the arena \(1 of 10\)/);
  assert.equal(paused.sealedUsesSpent, 1);
  assert.equal(paused.claim, false);
  assert.equal(arenaInfo(ARENA)?.sealedUses, 1);
  // the pause carries the arena whole, so the ledger holds the spent use
  const pauseEntry = ledgerOf('voyage.generation').at(-1)!;
  assert.equal((pauseEntry.voyage as VoyageView).status, 'paused');
  assert.equal((pauseEntry.arena as ArenaInfo).sealedUses, 1);
  assertSchoolReplays();

  // the next night: no generation is raced again, the sealed race runs afresh and spends a second use
  calls = [];
  const night2At = NOW + 2 * HOUR;
  readingAt(night2At);
  const done = await sailVoyage(ARENA, night2At);
  assert.equal(done.status, 'done', done.reason ?? '');
  assert.equal(done.claim, true);
  assert.equal(done.sealedUsesSpent, 2);
  assert.equal(arenaInfo(ARENA)?.sealedUses, 2);
  assert.ok(calls.every((c) => /Task s\d/.test(c.user)), 'only the sealed race ran');
  assertSchoolReplays();
});

test('a voyage the engine stopped mid-sail replays clean once the next engine pauses its train', async () => {
  seedLocals();
  backends();
  await fakeArena();
  // the voyage's train as the voyage writes it, never ended: the engine died
  const train = { id: 'train-voyage-dead', kind: 'voyage' as const, status: 'running' as const, reason: null, startedAt: new Date(NOW).toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 };
  openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(train.id, train.kind, train.status, JSON.stringify(train));
  (await import('../engine/ledger.js')).record('train.started', { train, voyageId: 'v-dead' });
  await failInterruptedTrains();
  assertSchoolReplays();
});

test('a voyage left sailing by a crash reads paused, the engine stopped, until the tick resumes it', async () => {
  seedLocals();
  backends();
  await fakeArena();
  gateOk = () => calls.length < 5;
  const night1 = await sailVoyage(ARENA, NOW);
  assert.equal(night1.status, 'paused');
  // as an engine that died mid-sail leaves it: the row and its last entry say sailing
  const stranded: VoyageView = { ...night1, status: 'sailing', reason: null, pausedAt: null };
  openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(stranded.id, JSON.stringify(stranded));
  record('voyage.generation', { voyageId: stranded.id, voyage: stranded, repo: stranded.repo ?? null });

  const moved = pauseStrandedVoyages(NOW + HOUR);
  assert.deepEqual(moved.map((v) => v.id), [night1.id]);
  const v = voyages().find((x) => x.id === night1.id)!;
  assert.equal(v.status, 'paused');
  assert.equal(v.reason, 'the engine stopped');
  assert.equal(v.pausedAt, new Date(NOW + HOUR).toISOString());
  assert.equal((ledgerOf('voyage.generation').at(-1)!.voyage as VoyageView).status, 'paused');
  assertSchoolReplays();
  assert.deepEqual(pauseStrandedVoyages(NOW + HOUR), [], 'nothing else is moved');

  gateOk = () => true;
  readingAt(NOW + 2 * HOUR);
  const night2 = await sailVoyage(ARENA, NOW + 2 * HOUR);
  assert.equal(night2.id, night1.id, 'the tick resumes it');
  assert.equal(night2.status, 'done', night2.reason ?? '');
});

test("a voyage waits for the graduates' calls in flight and stops their server before it sails", async () => {
  const mlx = await installMlx();
  try {
    seedLocals();
    let serverAtFirstCall: ReturnType<typeof serverState> | undefined;
    let downAtFirstCall: string | null = null;
    backends({
      hold: () => {
        if (serverAtFirstCall === undefined) {
          serverAtFirstCall = serverState();
          downAtFirstCall = heavyRunning();
        }
        return null;
      },
    });
    await fakeArena();
    mlx.replies = [{ json: completion({ content: 'done before the voyage' }), delayMs: 300 }];
    const order: string[] = [];
    const call = providerFor(GRAD_1)
      .complete({ model: GRAD_1, system: 'You help.', turns: [{ role: 'user', content: 'hi' }], schema: null, signal: new AbortController().signal, maxMs: 60_000, runId: null })
      .then((r) => {
        order.push(r.text);
        return r;
      });
    await until(() => mlx.bodies.length === 1);
    const view = await sailVoyage(ARENA, NOW);
    order.push('sailed');
    assert.equal(view.status, 'done', view.reason ?? '');
    assert.equal((await call).text, 'done before the voyage');
    assert.deepEqual(order, ['done before the voyage', 'sailed']);
    assert.deepEqual(mlx.spawned[0].kills, ['SIGTERM']);
    assert.equal(serverAtFirstCall, null, 'no graduate server runs while the voyage races');
    assert.equal(downAtFirstCall, 'a voyage', 'and none may start');
    assert.equal(heavyRunning(), null, 'given back when the voyage ends');
  } finally {
    await uninstallMlx();
  }
});
