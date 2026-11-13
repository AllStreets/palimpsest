/**
 * The school's nightly retrain and its off switch (Phase 4 Task 13, ruling
 * 12).
 *
 * - `startSchool()` ticks every `TICK_MS`. With the school on, a tick first
 *   asks his permission for every (kind, repo) pair that has earned it
 *   (`askDue`, ruling 17; the asks wait on no gate and no train). Then it
 *   does nothing more unless no train is live and the light gate holds (AC
 *   power, the window, the stop file; gate.ts). Then it trains, one at a time and in
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
 * - `schoolOff(now)` is the switch going off, from `patchSettings` or
 *   anywhere else: it records `school.enabled { on: false }`, pauses every
 *   live train at once (no poll waited for) and calls every abort registered
 *   with `registerAbort` (a live voyage or arena build, as later tasks add
 *   them). `predict()`, `registerPrediction()` and `act()` read
 *   `school.enabled` on every call, so nothing else needs telling.
 */
import { localDay } from '../../shared/day.js';
import type { GateState, Grant, NetName } from '../../shared/types.js';
import { record } from '../ledger.js';
import { getSettings, setSchoolOffHook } from '../settings.js';
// the asks (ruling 17); loading it installs the suspend and revert hooks into decisions.ts
import { askDue } from './autonomy.js';
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
  for (const abort of [...aborts]) {
    try {
      abort();
    } catch (err) {
      console.error('palimpsest: stopping school work failed:', err);
    }
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
  deps?: DatasetDeps;
}

export interface TickResult {
  /** Why nothing was trained, or null when the gate held and the pass ran. */
  reason: string | null;
  night: string | null;
  /** The pairs asked this tick (with the school on, before the gate). */
  asked: Grant[];
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
  const deps = o.deps ?? {};
  /** Nets tried tonight that came back thin or failed: not tried again until the next night. */
  const tried = new Set<string>();
  let busy = false;
  let stopped = false;

  const skip = (reason: string, asked: Grant[] = [], night: string | null = null): TickResult => ({ reason, night, asked, trained: [], results: [] });

  async function tick(now: number = Date.now()): Promise<TickResult> {
    if (stopped) return skip('the school tick is stopped');
    if (!getSettings().school.enabled) return skip('the school is off');
    // The asks come first: they wait on no train and no gate, and an ask that fails never stops the retrain.
    let asked: Grant[] = [];
    try {
      asked = ask(now);
    } catch (err) {
      console.error('palimpsest: the school could not ask for autonomy:', err);
    }
    if (busy || liveTrains().length > 0) return skip('a train is already running', asked);
    busy = true;
    try {
      const g = await gate('light', now);
      if (!g.ok) return skip(g.reason ?? 'the gate closed', asked);
      const night = nightOf(now);
      for (const key of tried) if (!key.startsWith(`${night}\n`)) tried.delete(key);
      const counts = labels(now, deps);
      const due = TRAIN_ORDER.filter((net) => {
        const n = counts[net] ?? 0;
        return n >= NEEDS && n > lastLabels(net) && !tried.has(`${night}\n${net}`) && !trainedTonight(net, night);
      });
      const out: TickResult = { reason: null, night, asked, trained: [], results: [] };
      for (const net of due) {
        if (stopped || !getSettings().school.enabled) break;
        const r = await train(net, now, deps);
        out.results.push(r);
        // the gate or the switch stopped it: nothing is recorded, and it is tried again at a later tick tonight
        if (r.status === 'waiting' || r.status === 'stopped') break;
        tried.add(`${night}\n${net}`);
        if (r.status === 'trained') out.trained.push(net);
      }
      return out;
    } finally {
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
      clearInterval(timer);
    },
  };
}
