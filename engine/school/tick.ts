/**
 * The school's nightly retrain and its off switch (Phase 4 Task 13, ruling
 * 12).
 *
 * - `startSchool()` ticks every `TICK_MS`. With the school on, a tick first
 *   asks his permission for every (kind, repo) pair that has earned it
 *   (`askDue`, ruling 17; the asks wait on no gate and no train), then acts
 *   where he granted it (`act`, ruling 18: every act behind `mayAct`, the
 *   switch and the stop file read again between acts). Then it
 *   does nothing more unless no train is live and the light gate holds (AC
 *   power, the window, the stop file; gate.ts). Inside the window the tick
 *   first claims the local slot (`claimLocalForSchool`): no new market local
 *   run starts until the pass ends, a run in flight is waited for and never
 *   killed, and a waiting local award no longer closes the gate, so a market
 *   backlog cannot starve the school. Then it trains, one at a time and in
 *   `TRAIN_ORDER` (appraiser, router, durability, triage, taste, master
 *   last, so the master is trained on the other nets as they stand), every
 *   net that has at least `NEEDS` labels and more of them than its last
 *   version was trained on.
 * - At most once a night: a night runs from noon to noon, named by the
 *   local day it starts on. A net trained tonight (a `net.trained` row whose
 *   `at` falls in it, so a restarted engine knows too), or tried tonight and
 *   thin or failed, is not tried again until the next. A train the gate or
 *   the switch stopped records nothing and is tried again at a later tick
 *   the same night.
 * - After the nets, a tick resumes any arena build a gate loss paused
 *   (`resumeArenas`, each behind the heavy gate); it never starts one.
 *   Then it sails a voyage (`sailDue`, voyages.ts): the unfinished one
 *   first, behind the heavy gate. A sailing voyage holds a train, so the
 *   nets and the voyage never run at once. Last, once the base model is
 *   downloaded and no train is live, the LoRA trains or resumes
 *   (`trainLora`, ruling 24); a refusal or a finished LoRA waits for the
 *   next night, a gate or a pause is tried again at a later tick. Then, at
 *   most once a night and with no train live, a trained adapter is raced
 *   against its base on the sealed tasks and graduates if it wins
 *   (`graduateDue`, ruling 25).
 * - `schoolOff(now)` is the switch going off, from `patchSettings` or
 *   anywhere else: it records `school.enabled { on: false }`, pauses every
 *   live train at once (no poll waited for) and calls every abort registered
 *   with `registerAbort` (a live voyage or arena build, as later tasks add
 *   them). `predict()`, `registerPrediction()` and `act()` read
 *   `school.enabled` on every call, so nothing else needs telling.
 */
import { localDay } from '../../shared/day.js';
import { inWindow } from '../../shared/school-rules.js';
import type { GateState, Grant, NetName } from '../../shared/types.js';
import { record } from '../ledger.js';
import { claimLocalForSchool } from '../market/budget.js';
import { getSettings, setSchoolOffHook } from '../settings.js';
// the asks (ruling 17) and the acts (ruling 18); loading it installs the suspend and revert hooks into decisions.ts
import { act as actDue, askDue } from './autonomy.js';
import { labelCounts, type DatasetDeps } from './datasets.js';
// the market's hooks and distillation's teacher, installed as it loads
import './decisions.js';
import type { GateKind } from './gate.js';
import { NEEDS, trainNet, versions, type TrainNetResult } from './nets.js';
import { liveTrains, pauseAll, readGate } from './trainer.js';

/** Ruling 12's order: the master last. */
export const TRAIN_ORDER: readonly NetName[] = ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master'];
/** How often the school looks at the clock and the gate. */
export const TICK_MS = 10 * 60_000;
/** The reason every live train is paused with when he turns the school off. */
export const TURNED_OFF_REASON = 'the school was turned off';

const HALF_DAY_MS = 12 * 60 * 60_000;

/** The night `t` belongs to: noon to noon, named by the local day it starts on, so a window across midnight is one night. */
export function nightOf(t: number): string {
  return localDay(t - HALF_DAY_MS);
}

// ---------------------------------------------------------------- the off switch

type Abort = () => void;
const aborts = new Set<Abort>();

/**
 * Registers what to stop when the school is turned off (a live voyage's or
 * arena build's AbortController, from the task that starts it); returns the
 * function that unregisters it, to call when that work ends.
 */
export function registerAbort(fn: Abort): () => void {
  const entry: Abort = () => fn();
  aborts.add(entry);
  return () => {
    aborts.delete(entry);
  };
}

/**
 * The school was turned off: recorded, every live train paused now, and
 * every registered voyage or arena build aborted. An abort that throws never
 * stops the others.
 */
export function schoolOff(now: number = Date.now()): void {
  record('school.enabled', { on: false, at: new Date(now).toISOString() });
  void pauseAll(TURNED_OFF_REASON);
  // the graduates' server (ruling 26) stops too, a call in flight ending with an error
  void stopGraduates(false);
  for (const abort of [...aborts]) {
    try {
      abort();
    } catch (err) {
      console.error('palimpsest: stopping school work failed:', err);
    }
  }
}

/**
 * Stops the graduates' mlx server (ruling 26): at once when the school is
 * turned off, or drained first. A heavy train takes the machine with
 * `takeMachine` (trainer.ts) instead. Loaded on use (the market backend
 * reaches back into the school). Never throws.
 */
export async function stopGraduates(drain: boolean): Promise<void> {
  try {
    await (await import('../market/mlx.js')).stopServer({ drain });
  } catch (err) {
    console.error('palimpsest: the graduates\' server could not be stopped:', err);
  }
}

// patchSettings turning the switch off runs schoolOff, from the moment this module loads
setSchoolOffHook(schoolOff);

// ---------------------------------------------------------------- the nightly retrain

export interface SchoolOptions {
  /** Defaults to `TICK_MS`. */
  intervalMs?: number;
  /** The light gate; defaults to the trainer's (`gateNow`, or what `setGate` installed). */
  gate?: (kind: GateKind, now: number) => Promise<GateState>;
  /** Trains one net; defaults to `trainNet`. */
  train?: (net: NetName, now: number, deps: DatasetDeps) => Promise<TrainNetResult>;
  /** Each net's label count; defaults to `labelCounts`. */
  labels?: (now: number, deps: DatasetDeps) => Record<NetName, number>;
  /** The asks for autonomy; defaults to `askDue`. */
  ask?: (now: number) => Grant[];
  /** The acts under his grants, answering how many went through; defaults to `act`. */
  act?: (now: number | (() => number)) => Promise<number>;
  /** Resumes arena builds a gate loss paused (each behind the heavy gate); defaults to `resumeArenas`. */
  resume?: (now: number) => Promise<unknown>;
  /** Sails tonight's voyage (behind the heavy gate, one at a time, resumed per run); defaults to `sailDue`. */
  sail?: (now: number) => Promise<unknown>;
  /** Trains or resumes the LoRA (behind the heavy gate) once the base model is downloaded; defaults to `trainLora`. */
  lora?: (now: number) => Promise<{ status: string }>;
  /** Scores a trained adapter against its base on a sealed race and graduates it if it wins (ruling 25); defaults to `graduateDue`. */
  graduate?: (now: number) => Promise<unknown>;
  deps?: DatasetDeps;
}

export interface TickResult {
  /** Why nothing was trained, or null when the gate held and the pass ran. */
  reason: string | null;
  night: string | null;
  /** The pairs asked this tick (with the school on, before the gate). */
  asked: Grant[];
  /** How many acts under his grants went through this tick (after the asks, before the gate). */
  acted: number;
  /** The nets that recorded a new version, in order. */
  trained: NetName[];
  /** Every net tried this tick, in order, with what came of it. */
  results: TrainNetResult[];
}

export interface School {
  tick(now?: number): Promise<TickResult>;
  stop(): void;
}

/** The real labels the last recorded version of `net` was trained and scored on, or 0. */
function lastLabels(net: NetName): number {
  const last = versions(net).at(-1);
  return last ? last.rows.train + last.rows.heldOut : 0;
}

function trainedTonight(net: NetName, night: string): boolean {
  return versions(net).some((v) => {
    const t = Date.parse(v.at);
    return Number.isFinite(t) && nightOf(t) === night;
  });
}

/** Starts the nightly retrain: `{ tick(), stop() }`. The interval is unref'd, so it never holds the engine open. */
export function startSchool(o: SchoolOptions = {}): School {
  const gate = o.gate ?? readGate;
  const train = o.train ?? trainNet;
  const labels = o.labels ?? labelCounts;
  const ask = o.ask ?? askDue;
  const act = o.act ?? actDue;
  const deps = o.deps ?? {};
  // loaded when first used: arenas.ts registers its builds' aborts here
  const resume = o.resume ?? (async (now: number) => (await import('./arenas.js')).resumeArenas(now));
  // loaded when first used, like the arenas: voyages.ts registers its voyage's abort here
  const sail = o.sail ?? (async (now: number) => (await import('./voyages.js')).sailDue(now));
  // loaded when first used, like the voyages (lora.ts reaches back here through arenas.ts)
  const lora = o.lora ?? (async (now: number) => (await import('./lora.js')).trainLora(now));
  const graduate = o.graduate ?? (async (now: number) => (await import('./lora.js')).graduateDue(now));
  /** Nets tried tonight that came back thin or failed: not tried again until the next night. */
  const tried = new Set<string>();
  let busy = false;
  let stopped = false;
  /** The school's claim on the local slot (inside the window), held across a pass, or to the next tick while a market run ends. */
  let claim: (() => void) | null = null;
  const letGo = (): void => {
    claim?.();
    claim = null;
  };

  const skip = (reason: string, asked: Grant[] = [], acted = 0, night: string | null = null): TickResult => ({ reason, night, asked, acted, trained: [], results: [] });

  async function tick(nowIn?: number): Promise<TickResult> {
    const now = nowIn ?? Date.now();
    if (stopped) return skip('the school tick is stopped');
    if (!getSettings().school.enabled) {
      if (!busy) letGo();
      return skip('the school is off');
    }
    // The asks come first: they wait on no train and no gate, and an ask that fails never stops the retrain.
    let asked: Grant[] = [];
    try {
      asked = ask(now);
    } catch (err) {
      console.error('palimpsest: the school could not ask for autonomy:', err);
    }
    // Then the acts: each behind mayAct, read fresh; an act that throws never stops the retrain.
    let acted = 0;
    try {
      // a live tick gives the acts a clock read afresh per act; a test's fixed `now` is kept as it is
      acted = await act(nowIn === undefined ? Date.now : now);
    } catch (err) {
      console.error('palimpsest: the city could not act under his grants:', err);
    }
    if (busy || liveTrains().length > 0) return skip('a train is already running', asked, acted);
    busy = true;
    // Inside the window the school takes the local slot first: from here no new market local run starts
    // (a run in flight is waited for, never killed) until the pass ends. Outside it the school yields as before.
    letGo();
    if (inWindow(getSettings().school.window, now)) claim = claimLocalForSchool();
    let holdClaim = false;
    try {
      const g = await gate('light', now);
      if (!g.ok) {
        // a market run in flight ends on its own; the slot then waits for the school's next tick
        holdClaim = g.reason === 'a local job is running';
        return skip(g.reason ?? 'the gate closed', asked, acted);
      }
      const night = nightOf(now);
      for (const key of tried) if (!key.startsWith(`${night}\n`)) tried.delete(key);
      const counts = labels(now, deps);
      const due = TRAIN_ORDER.filter((net) => {
        const n = counts[net] ?? 0;
        return n >= NEEDS && n > lastLabels(net) && !tried.has(`${night}\n${net}`) && !trainedTonight(net, night);
      });
      const out: TickResult = { reason: null, night, asked, acted, trained: [], results: [] };
      for (const net of due) {
        if (stopped || !getSettings().school.enabled) break;
        const r = await train(net, now, deps);
        out.results.push(r);
        // the gate or the switch stopped it: nothing is recorded, and it is tried again at a later tick tonight
        if (r.status === 'waiting' || r.status === 'stopped') break;
        tried.add(`${night}\n${net}`);
        if (r.status === 'trained') out.trained.push(net);
      }
      // A paused arena build (never a new one: only his click starts those) goes on with its untried candidates.
      if (!stopped && getSettings().school.enabled) {
        try {
          await resume(now);
        } catch (err) {
          console.error('palimpsest: the school could not resume an arena build:', err);
        }
      }
      // Then a voyage (ruling 22): the unfinished one first, resumed where it stopped. It holds a
      // train while it sails, so later ticks find a train running and train no net meanwhile.
      if (!stopped && getSettings().school.enabled) {
        try {
          await sail(now);
        } catch (err) {
          console.error('palimpsest: the school could not sail a voyage:', err);
        }
      }
      // Last, the LoRA (ruling 24), once he has downloaded the base and nothing else holds a train. A refusal
      // (too few examples), a failure or a finished LoRA is not tried again tonight; a gate or a pause is.
      const loraKey = `${night}\nlora`;
      if (!stopped && getSettings().school.enabled && getSettings().school.baseModelReady && liveTrains().length === 0 && !tried.has(loraKey)) {
        try {
          const r = await lora(now);
          if (r.status !== 'waiting' && r.status !== 'paused') tried.add(loraKey);
        } catch (err) {
          tried.add(loraKey);
          console.error('palimpsest: the school could not train its LoRA:', err);
        }
      }
      // Then a trained adapter's sealed race against its base (ruling 25), once a night: it holds the
      // graduates' server behind the heavy gate, so it runs only when no train is live.
      const gradKey = `${night}\ngraduate`;
      if (!stopped && getSettings().school.enabled && getSettings().school.baseModelReady && liveTrains().length === 0 && !tried.has(gradKey)) {
        tried.add(gradKey);
        try {
          await graduate(now);
        } catch (err) {
          console.error('palimpsest: the school could not score its adapter:', err);
        }
      }
      return out;
    } finally {
      if (!holdClaim || stopped) letGo();
      busy = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch((err) => console.error('palimpsest: the school tick failed:', err));
  }, o.intervalMs ?? TICK_MS);
  timer.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      if (!busy) letGo();
      clearInterval(timer);
    },
  };
}
