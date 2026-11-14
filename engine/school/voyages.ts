/**
 * Voyages (Phase 4 ruling 22, Task 22): the school breeds agents on one of
 * his repos' arenas through Beagle, over several nights.
 *
 * - One voyage at a time, and one train at a time: a sailing voyage holds a
 *   train of kind `voyage` (`holdTrain`), so the nightly nets wait for it and
 *   it waits for them.
 * - Beagle sails it: `startVoyage` at concurrency 1 with the agents on local
 *   models only (population 8, 4 generations). Generation one is the arena's
 *   seeded local agents. Each later generation is bred by the designer (the
 *   school's designer setting, through the school's driver), which reads the
 *   last generation's race scores and probes its best agents on breeding
 *   tasks only; a breeding task that shares a change with the sealed split
 *   stops the voyage before anything is bred.
 * - A child is kept only when `compareToParents()` puts its paired interval
 *   above zero (`lo > 0`): a child that is not is set aside before the next
 *   breeding, so nothing is bred from it and it is never the champion.
 * - Every model call goes through `schoolDriver` under the voyage, with the
 *   voyage's own AbortSignal, the same one `race()` and `breed()` get: a
 *   gate loss (read after every run and every `GATE.pollMs`), the stop file
 *   (read every `pollMs`), the school switched off (`registerAbort`) or the
 *   engine stopping (`pauseAll`) ends the race at once. Runs cut short are
 *   unscored; the next night calls `race()` again, which skips the runs
 *   already stored, so a voyage resumes run by run.
 * - When the last generation is raced, its best kept agent is raced once by
 *   `sealedRace()` against every seeded local agent on the sealed tasks (one
 *   sealed use of the arena; the tenth spends it). The champion claims a win
 *   only with `lo > 0` against each, on a sealed split that is unspent and
 *   unchanged since the arena was built. Claude agents are never compared,
 *   and the view says so. The use is counted as the sealed race starts; a
 *   pause during it says so in `reason`, and `sealedUsesSpent` counts every
 *   use the voyage spent.
 * - Recorded and emitted: `voyage.started`, `voyage.generation` (each
 *   generation raced, a resume, a pause), `voyage.ended`, each with
 *   `{ voyageId, voyage, repo }`; `voyage.commissioned { voyageId, firmId }`;
 *   `train.started | .paused | .ended { train }`. A voyage's parents go to
 *   the campus when it sails and home when it pauses or ends.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { localDay } from '../../shared/day.js';
import { GATE, SEALED_USES, VOYAGE } from '../../shared/school-rules.js';
import type { ArenaInfo, TrainState, VoyageView } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { creditEntries } from '../market/budget.js';
import { agent as storedAgent } from '../market/firms.js';
import { homeFromSchool, toSchool } from '../market/trips.js';
import { getSettings } from '../settings.js';
import { arenaInfo, listArenas, registerArenas, releaseArenaViews, sealedRefs } from './arenas.js';
import type { BeagleApi, BeagleGenome, BeagleRaceEvent } from './beagle-api.js';
import { loadBeagle, schoolDriver, useDriver } from './beagle.js';
import { ci, pairedCi } from './stats.js';
import { registerAbort, TURNED_OFF_REASON } from './tick.js';
import { holdTrain, liveTrains, readGate } from './trainer.js';

/** The agents of a generation the designer keeps unchanged. */
export const ELITES = 2;
/** Breeding tasks each of the best four agents answers for the designer's evidence: with 15 race tasks, about 500 runs a voyage. */
export const PROBE = 2;
/** Where a child that was not promoted is set aside in Beagle's store (its generation, minus this): out of every later breeding. */
const SET_ASIDE = -1000;
export const STOP_FILE_REASON = 'The stop file is set.';
export const NOT_COMPARED = 'Claude agents were not compared: voyages race local models only.';

/** A voyage that cannot sail now, and why. */
export class VoyageRefused extends Error {
  override name = 'VoyageRefused';
}

let pollMs = 2_000;

/** How often a sailing voyage reads the stop file and the switch (tests); null restores 2 s. */
export function setVoyagePoll(ms: number | null): void {
  pollMs = ms ?? 2_000;
}

/** The voyage sailing in this engine now, if any. */
let sailing: { arena: string } | null = null;

const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T>(x: T): T => structuredClone(x);
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const isUnfinished = (v: VoyageView) => v.status === 'sailing' || v.status === 'paused';

// ---------------------------------------------------------------- the tables

/** Every voyage, oldest first. */
export function voyages(): VoyageView[] {
  const rows = openDb().prepare('SELECT json FROM voyages').all() as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as VoyageView).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

export function voyage(id: string): VoyageView | null {
  const row = openDb().prepare('SELECT json FROM voyages WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as VoyageView) : null;
}

/** Whether a voyage is sailing in this engine now. */
export function voyageSailing(): boolean {
  return sailing !== null;
}

/** Writes the view, records it whole under `kind` and emits it for the city. */
function announce(kind: 'voyage.started' | 'voyage.generation' | 'voyage.ended', view: VoyageView, extra: { arena?: ArenaInfo } = {}): void {
  openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(view.id, JSON.stringify(view));
  const data = { voyageId: view.id, voyage: clone(view), repo: view.repo ?? null, ...(extra.arena ? { arena: clone(extra.arena) } : {}) };
  record(kind, data);
  emit(kind, clone(data));
}

function putTrain(kind: 'train.started' | 'train.paused' | 'train.ended', t: TrainState, extra: object = {}): void {
  openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(t.id, t.kind, t.status, JSON.stringify(t));
  const data = { train: clone(t), ...extra };
  record(kind, data);
  emit(kind, clone(data));
}

function putArena(info: ArenaInfo): void {
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
}

function creditsOf(voyageId: string): number {
  return round(creditEntries(voyageId).reduce((n, r) => n + r.credits, 0));
}

// ---------------------------------------------------------------- Beagle's store

type Member = { genome: BeagleGenome; parents: string[] };

function membersAt(b: BeagleApi, voyageId: string, generation: number): Member[] {
  const rows = b.store.open().prepare('SELECT id, parent_ids, body FROM genomes WHERE voyage = ? AND generation = ? ORDER BY rowid').all(voyageId, generation) as Array<{ id: string; parent_ids: string; body: string }>;
  return rows.map((r) => ({ genome: JSON.parse(r.body) as BeagleGenome, parents: (JSON.parse(r.parent_ids) as string[]).filter((p) => p !== r.id) }));
}

function genomeBody(b: BeagleApi, voyageId: string, id: string): BeagleGenome | null {
  const row = b.store.open().prepare('SELECT body FROM genomes WHERE voyage = ? AND id = ? ORDER BY generation DESC LIMIT 1').get(voyageId, id) as { body: string } | undefined;
  return row ? (JSON.parse(row.body) as BeagleGenome) : null;
}

function runsDone(b: BeagleApi, voyageId: string): number {
  return (b.store.open().prepare('SELECT COUNT(*) AS n FROM runs WHERE voyage = ? AND generation >= 0').get(voyageId) as { n: number }).n;
}

function tasksOf(b: BeagleApi, arenaId: string, split: 'breeding' | 'race' | 'sealed'): string[] {
  const rows = b.store.open().prepare('SELECT id FROM tasks WHERE arena = ? AND split = ?').all(b.arenas.dataOf(arenaId), split) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Sets aside, before the designer reads generation `g`, every child of it
 * that was not promoted (no `lo > 0` against its parent): Beagle breeds only
 * from the genomes its store holds at `g`. Starters and kept agents stay.
 */
function setAside(b: BeagleApi, view: VoyageView, g: number): void {
  if (g === 0) return;
  const db = b.store.open();
  for (const m of membersAt(b, view.id, g)) {
    if (m.parents.length === 0) continue; // an elite kept unchanged (its own parent)
    if (view.promoted.some((p) => p.child === m.genome.id)) continue;
    db.prepare('UPDATE genomes SET generation = ? WHERE voyage = ? AND generation = ? AND id = ?').run(SET_ASIDE - g, view.id, g, m.genome.id);
  }
}

/**
 * Why the designer could see part of a sealed answer, or null: every
 * breeding task in Beagle's store must be a breeding task of the arena
 * whose change shares nothing (ref, sha, inner commit) with a sealed one.
 */
function breedingLeak(b: BeagleApi, arenaId: string): string | null {
  const sealed = sealedRefs();
  const ours = new Map(
    (openDb().prepare('SELECT id, split, ref, json FROM arena_tasks WHERE arena = ?').all(arenaId) as Array<{ id: string; split: string; ref: string | null; json: string }>).map((r) => [r.id, r]),
  );
  for (const id of tasksOf(b, arenaId, 'breeding')) {
    const t = ours.get(id);
    if (!t || t.split !== 'breeding') return `Beagle holds a breeding task (${id}) the arena does not, so the designer could see a task outside the breeding split`;
    let truth: { ref?: unknown; sha?: unknown; commits?: unknown } = {};
    try {
      truth = (JSON.parse(t.json) as { truth?: typeof truth }).truth ?? {};
    } catch {
      // nothing more to read
    }
    const refs = [t.ref, truth.ref, truth.sha, ...(Array.isArray(truth.commits) ? truth.commits : [])].filter((x): x is string => typeof x === 'string' && x !== '');
    if (refs.some((r) => sealed.has(r))) return `A breeding task (${id}) shares a change with the sealed split, so the designer could see part of a sealed answer`;
  }
  return null;
}

// ---------------------------------------------------------------- sailing

type Stop = { status: 'paused' | 'capped' | 'failed'; reason: string };

interface Sail {
  b: BeagleApi;
  info: ArenaInfo;
  view: VoyageView;
  ctl: AbortController;
  clock: () => number;
  starters: BeagleGenome[];
  /** The last reason Beagle gave for waiting (a refused lease), to name a stop "Claude usage limit". */
  lastWait: string | null;
  /** The arena, when this night spent one of its sealed uses. */
  arena: ArenaInfo | null;
  /** True from the moment the champion's sealed race starts until it runs to the end. */
  inSealedRace: boolean;
}

const reasonOf = (s: AbortSignal): string => (s.reason instanceof Error ? s.reason.message : String(s.reason ?? 'stopped'));

/** How a race that did not complete stopped. */
function stopOf(s: Sail, reason: string | undefined): Stop {
  if (s.ctl.signal.aborted) return { status: 'paused', reason: reasonOf(s.ctl.signal) };
  if (reason && /reached its \$[\d.]+ cap/.test(reason)) return { status: 'capped', reason: `Beagle's spending cap: ${reason}` };
  return { status: 'paused', reason: s.lastWait ?? reason ?? 'the race stopped' };
}

/** How a thrown error stopped it: the signal or a refused lease pause it; anything else fails it. */
function stopOfError(s: Sail, err: unknown): Stop {
  if (s.ctl.signal.aborted) return { status: 'paused', reason: reasonOf(s.ctl.signal) };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof s.b.models.LimitError || (err instanceof Error && err.name === 'LimitError')) return { status: 'paused', reason: message };
  return { status: 'failed', reason: message };
}

/** Reads the heavy gate; a closed or unreadable gate aborts the voyage with its reason. */
async function checkGate(s: Sail): Promise<void> {
  if (s.ctl.signal.aborted) return;
  try {
    const g = await readGate('heavy', s.clock());
    if (!g.ok && !s.ctl.signal.aborted) s.ctl.abort(g.reason ?? 'the gate closed');
  } catch (err) {
    if (!s.ctl.signal.aborted) s.ctl.abort(`the gate could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The stop file and the switch, read without waiting: either aborts at once. */
function checkNow(s: Sail): boolean {
  if (s.ctl.signal.aborted) return true;
  if (existsSync(paths().stop)) s.ctl.abort(STOP_FILE_REASON);
  else if (!getSettings().school.enabled) s.ctl.abort(TURNED_OFF_REASON);
  return s.ctl.signal.aborted;
}

function onEvent(s: Sail, e: BeagleRaceEvent): void {
  if (e.type === 'waiting') s.lastWait = e.reason;
  if (e.type !== 'run') return;
  s.view.runs.done++;
  if (!checkNow(s)) void checkGate(s);
}

/** Puts `members` into the view as generation `g + 1`, scored from `scores` when given, else zero and unscored. */
function scoreGeneration(view: VoyageView, g: number, members: Member[], scores: Array<{ genome: string; mean: number; lo: number; hi: number }> | null): void {
  const gen = g + 1;
  const ids = new Set(members.map((m) => m.genome.id));
  // a child set aside earlier keeps the scores it raced to
  const setAsideScored = view.scores.filter((x) => x.generation === gen && x.scored !== false && !ids.has(x.genome));
  const rows = members.map((m) => {
    const sc = scores?.find((x) => x.genome === m.genome.id);
    return { genome: m.genome.id, name: m.genome.name, generation: gen, mean: sc?.mean ?? 0, lo: sc?.lo ?? 0, hi: sc?.hi ?? 0, parents: m.parents, scored: scores !== null };
  });
  view.scores = [...view.scores.filter((x) => x.generation !== gen), ...setAsideScored, ...rows];
}

/** Races the generations not yet raced (breeding each from the last); null when the last is raced, else how it stopped. */
async function sailGenerations(s: Sail): Promise<Stop | null> {
  const { b, view, ctl } = s;
  for (let g = 0; g < VOYAGE.generations; g++) {
    // a generation raced on an earlier night is done: its runs are stored and its children compared
    if (view.scores.some((x) => x.generation === g + 1 && x.scored !== false)) continue;
    if (checkNow(s)) return { status: 'paused', reason: reasonOf(ctl.signal) };
    view.generation = g + 1;
    let members = membersAt(b, view.id, g);
    if (members.length === 0) {
      if (g === 0) members = s.starters.slice(0, VOYAGE.population).map((genome) => ({ genome, parents: [] }));
      else {
        setAside(b, view, g - 1);
        const bred = await b.designer.breed(view.id, g - 1, { children: VOYAGE.population - ELITES, elites: ELITES, probe: PROBE, signal: ctl.signal });
        members = bred.next.map((genome) => ({ genome, parents: (bred.parents[genome.id] ?? []).filter((p) => p !== genome.id) }));
      }
    }
    if (!view.scores.some((x) => x.generation === g + 1)) scoreGeneration(view, g, members, null);
    const r = await b.race.race(view.id, g, members.map((m) => m.genome), { baselines: false, signal: ctl.signal, onEvent: (e) => onEvent(s, e) });
    view.runs.done = runsDone(b, view.id);
    if (!r.complete) return stopOf(s, r.reason);
    scoreGeneration(view, g, members, r.scores);
    if (g > 0) {
      for (const c of b.race.compareToParents(view.id, g)) {
        if (c.lo > 0 && !view.promoted.some((p) => p.child === c.child && p.parent === c.parent)) view.promoted.push({ child: c.child, parent: c.parent, diff: c.diff, lo: c.lo, hi: c.hi });
      }
    }
    view.credits = creditsOf(view.id);
    announce('voyage.generation', view);
  }
  return null;
}

/** The best kept agent of the last generation: a starter, a kept elite, or a promoted child. */
function championOf(view: VoyageView): VoyageView['champion'] {
  const last = view.scores.filter((x) => x.generation === VOYAGE.generations && x.scored !== false);
  const kept = last.filter((x) => x.parents.length === 0 || view.promoted.some((p) => p.child === x.genome));
  const best = [...kept].sort((a, z) => z.mean - a.mean || z.hi - a.hi)[0];
  if (!best) return null;
  // the generation it was bred in: the first it raced in
  const born = Math.min(...view.scores.filter((x) => x.genome === best.genome).map((x) => x.generation));
  const first = view.scores.find((x) => x.genome === best.genome && x.generation === born);
  return { genome: best.genome, name: best.name, model: '', generation: born, parents: first?.parents ?? [] };
}

/** The champion's one sealed race against every seeded local agent; null when it ran to the end, else how it stopped. */
async function sealedClaim(s: Sail): Promise<Stop | null> {
  const { b, view, ctl } = s;
  view.champion = championOf(view);
  view.claim = false;
  view.vsLocal = [];
  view.sealed = null;
  view.notCompared = NOT_COMPARED;
  const champ = view.champion;
  if (!champ) {
    view.reason = 'No agent was kept, so the voyage has no champion';
    return null;
  }
  const body = genomeBody(b, view.id, champ.genome);
  if (body) champ.model = body.model;
  const locals = b.arenas.startersFor(s.info.id);
  if (locals.some((l) => l.id === champ.genome)) {
    view.reason = 'The best agent was a seeded agent the city already has, so the voyage makes no champion claim';
    return null;
  }
  const fresh = arenaInfo(s.info.id) ?? s.info;
  if (fresh.status === 'spent' || fresh.sealedUses >= SEALED_USES) {
    view.reason = `The arena's sealed split is spent (${SEALED_USES} sealed uses), so the voyage makes no champion claim`;
    return null;
  }
  if (!body || locals.length === 0) {
    view.reason = locals.length === 0 ? 'No seeded agent runs on a local model to compare the champion with' : 'The champion is missing from Beagle\'s store';
    return null;
  }
  if (checkNow(s)) return { status: 'paused', reason: reasonOf(ctl.signal) };
  // the use is counted before the race starts: once it runs, the sealed tasks may have been shown, whatever stops it
  const uses = fresh.sealedUses + 1;
  s.arena = { ...fresh, sealedUses: uses, status: uses >= SEALED_USES ? 'spent' : fresh.status };
  putArena(s.arena);
  view.sealedUsesSpent = (view.sealedUsesSpent ?? 0) + 1;
  s.inSealedRace = true;
  const r = await b.race.sealedRace(s.info.id, [body, ...locals], { signal: ctl.signal, seed: 1 });
  if (!r.complete) return stopOf(s, r.reason);
  s.inSealedRace = false;
  const mine = r.perTask[champ.genome] ?? {};
  const tasks = Object.keys(mine).sort();
  view.sealed = ci(tasks.map((t) => mine[t]), 1);
  for (const l of locals) {
    const theirs = r.perTask[l.id] ?? {};
    const common = tasks.filter((t) => t in theirs);
    if (common.length === 0) continue;
    const d = pairedCi(common.map((t) => mine[t]), common.map((t) => theirs[t]), 1);
    view.vsLocal.push({ agent: l.id, name: l.name, diff: d.diff, lo: d.lo, hi: d.hi });
  }
  const unchanged = r.hash === fresh.sealedHash;
  const beatsAll = view.vsLocal.length === locals.length && view.vsLocal.every((v) => v.lo > 0);
  view.claim = unchanged && beatsAll;
  view.reason = !unchanged
    ? 'The sealed tasks changed since the arena was built, so the voyage makes no champion claim'
    : beatsAll
      ? null
      : 'The champion did not beat every seeded local agent on the sealed tasks';
  return null;
}

/** The voyage's parents: the agents among its first generation. */
function parentsOf(view: VoyageView) {
  return view.scores
    .filter((x) => x.generation === 1)
    .map((x) => storedAgent(x.genome))
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

/**
 * Sails the voyage on `arenaId` for tonight: the unfinished one there is
 * resumed, else a new one starts (`o.firmId` commissioned it). Resolves
 * when it finishes or stops for the night, with its view. Throws
 * `VoyageRefused` when it cannot sail: the school off, a voyage or another
 * train running, the arena not ready, the heavy gate closed, no seeded
 * local agent, or a breeding task that could show the designer part of a
 * sealed answer.
 */
export async function sailVoyage(arenaId: string, now: number, o: { firmId?: string } = {}): Promise<VoyageView> {
  if (!getSettings().school.enabled) throw new VoyageRefused('The school is off');
  if (sailing) throw new VoyageRefused(`A voyage is already sailing (on ${sailing.arena})`);
  if (liveTrains().length > 0) throw new VoyageRefused('A train is already running');
  const info = arenaInfo(arenaId);
  if (!info) throw new VoyageRefused(`There is no arena ${arenaId}`);
  if (info.status !== 'ready' && info.status !== 'spent') throw new VoyageRefused(`The arena ${arenaId} is ${info.status}, not ready`);
  sailing = { arena: arenaId };
  try {
    const g = await readGate('heavy', now);
    if (!g.ok) throw new VoyageRefused(g.reason ?? 'the gate closed');
    if (!getSettings().school.enabled) throw new VoyageRefused('The school is off');
    return await sail(info, now, o);
  } finally {
    sailing = null;
  }
}

async function sail(info: ArenaInfo, now: number, o: { firmId?: string }): Promise<VoyageView> {
  const b = await loadBeagle();
  if (!b.arenas.arenaIds().includes(info.id)) await registerArenas();
  if (!b.arenas.arenaIds().includes(info.id)) throw new VoyageRefused(`Beagle does not know the arena ${info.id}`);
  const leak = breedingLeak(b, info.id);
  if (leak) throw new VoyageRefused(leak);
  const starters = b.arenas.startersFor(info.id);
  const existing = voyages().find((v) => v.arena === info.id && isUnfinished(v)) ?? null;
  if (!existing && starters.length === 0) throw new VoyageRefused('No seeded agent runs on a local model, so there is no first generation');

  const t0 = Date.now();
  const clock = () => now + (Date.now() - t0);
  const ctl = new AbortController();
  let view: VoyageView;
  if (existing) {
    view = { ...existing, status: 'sailing', reason: null };
  } else {
    const raceTasks = Math.max(1, tasksOf(b, info.id, 'race').length);
    // localAgents: every agent on this Mac; the designer may still be Claude within its daily allowance (Decision 10), which Beagle's localOnly would refuse
    const bv = b.race.startVoyage(info.id, {
      concurrency: VOYAGE.concurrency,
      population: VOYAGE.population,
      generations: VOYAGE.generations,
      raceTasks,
      localAgents: true,
      localOnly: false,
      seed: 1,
    });
    view = {
      id: bv.id,
      arena: info.id,
      status: 'sailing',
      generation: 1,
      of: VOYAGE.generations,
      runs: { done: 0, of: VOYAGE.population * raceTasks * VOYAGE.generations },
      commissionedBy: o.firmId ?? null,
      scores: [],
      promoted: [],
      sealed: null,
      credits: 0,
      startedAt: iso(now),
      endedAt: null,
      repo: info.repo,
      reason: null,
      pausedAt: null,
      champion: null,
      vsLocal: [],
      claim: false,
      notCompared: NOT_COMPARED,
    };
    scoreGeneration(view, 0, starters.slice(0, VOYAGE.population).map((genome) => ({ genome, parents: [] })), null);
  }
  const s: Sail = { b, info, view, ctl, clock, starters, lastWait: null, arena: null, inSealedRace: false };

  const train: TrainState = { id: `train-voyage-${randomUUID().slice(0, 8)}`, kind: 'voyage', status: 'running', reason: null, startedAt: iso(now), endedAt: null, seconds: 0, steps: null, credits: 0 };
  const unhold = holdTrain(train, (reason) => ctl.abort(reason));
  const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
  useDriver(schoolDriver({ voyageId: view.id, designer: getSettings().school.designer, signal: ctl.signal, now: clock }));
  const creditsBefore = creditsOf(view.id);
  let lastGate = Date.now();
  const timer = setInterval(() => {
    if (checkNow(s)) return;
    if (Date.now() - lastGate >= GATE.pollMs) {
      lastGate = Date.now();
      void checkGate(s);
    }
  }, pollMs);
  timer.unref?.();

  let stop: Stop | null = null;
  try {
    putTrain('train.started', train, { voyageId: view.id });
    if (existing) announce('voyage.generation', view);
    else {
      announce('voyage.started', view);
      if (o.firmId) {
        const data = { voyageId: view.id, firmId: o.firmId };
        record('voyage.commissioned', data);
        emit('voyage.commissioned', { ...data });
      }
    }
    for (const a of parentsOf(view)) toSchool(a, clock());
    stop = await sailGenerations(s);
    if (!stop) stop = await sealedClaim(s);
  } catch (err) {
    stop = stopOfError(s, err);
  } finally {
    clearInterval(timer);
    unregister();
    useDriver(null);
  }

  const end = clock();
  view.runs.done = runsDone(b, view.id);
  view.credits = creditsOf(view.id);
  if (stop && s.inSealedRace && s.arena) {
    // say plainly what the cut-short sealed race cost: the use is spent, and a resume races the sealed tasks afresh
    stop.reason = `${stop.reason}. This stopped the champion's sealed race, which had already spent one sealed use of the arena (${s.arena.sealedUses} of ${SEALED_USES}); a resumed voyage races the sealed tasks afresh and spends another`;
  }
  if (stop?.status === 'paused') {
    view.status = 'paused';
    view.reason = stop.reason;
    view.pausedAt = iso(end);
  } else {
    if (stop) {
      view.status = stop.status;
      view.reason = stop.reason;
    } else view.status = 'done';
    view.endedAt = iso(end);
    b.race.finishVoyage(view.id);
  }
  announce(view.status === 'paused' ? 'voyage.generation' : 'voyage.ended', view, s.arena ? { arena: s.arena } : {});

  train.status = view.status === 'paused' ? 'paused' : view.status === 'failed' ? 'failed' : 'done';
  train.reason = view.status === 'done' ? null : (view.reason ?? null);
  train.endedAt = iso(end);
  train.seconds = Math.max(0, Math.round((Date.now() - t0) / 1000));
  train.credits = round(view.credits - creditsBefore);
  if (train.status === 'paused') putTrain('train.paused', train, { reason: train.reason, lost: 0, voyageId: view.id });
  else putTrain('train.ended', train, { voyageId: view.id });
  unhold();

  for (const a of parentsOf(view)) homeFromSchool(storedAgent(a.id) ?? a, end);
  await releaseArenaViews(info.id).catch((err) => console.error('palimpsest: releasing the arena\'s views failed:', err));
  return clone(view);
}

// ---------------------------------------------------------------- the tick's choice

/**
 * The arenas a tick would sail on, in order: unfinished voyages first (a
 * commissioned one first, then the oldest), except one paused today on the
 * school's daily Claude allowance; then ready arenas with no voyage under
 * way, the least recently voyaged first.
 */
export function dueArenas(now: number): string[] {
  const all = voyages();
  const today = localDay(now);
  const open = all
    .filter(isUnfinished)
    .filter((v) => !(v.status === 'paused' && /credits a day/.test(v.reason ?? '') && v.pausedAt && localDay(Date.parse(v.pausedAt)) === today))
    .sort((a, z) => Number(z.commissionedBy !== null) - Number(a.commissionedBy !== null) || a.startedAt.localeCompare(z.startedAt));
  const busy = new Set(all.filter(isUnfinished).map((v) => v.arena));
  const last = (arena: string) => all.filter((v) => v.arena === arena).reduce((m, v) => (v.startedAt > m ? v.startedAt : m), '');
  const fresh = listArenas()
    .filter((a) => a.status === 'ready' && !busy.has(a.id))
    .sort((a, z) => last(a.id).localeCompare(last(z.id)) || a.builtAt.localeCompare(z.builtAt));
  return [...new Set([...open.map((v) => v.arena), ...fresh.map((a) => a.id)])];
}

/**
 * The tick's voyage (ruling 22): with the school on, nothing sailing and the
 * heavy gate holding, sails the first due arena that can sail. Null when
 * none did.
 */
export async function sailDue(now: number): Promise<VoyageView | null> {
  if (!getSettings().school.enabled || sailing) return null;
  const due = dueArenas(now);
  if (due.length === 0) return null;
  const g = await readGate('heavy', now);
  if (!g.ok) return null;
  for (const arenaId of due) {
    try {
      return await sailVoyage(arenaId, now, {});
    } catch (err) {
      if (!(err instanceof VoyageRefused)) throw err;
      console.error(`palimpsest: no voyage on ${arenaId}: ${err.message}`);
    }
  }
  return null;
}
