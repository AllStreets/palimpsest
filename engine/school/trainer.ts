/**
 * The trainer process (Phase 4 ruling 7): `school.py`, started only when the
 * gate holds, fenced in the trainer profile with no network and no key, and
 * charged to the city by the second (ruling 3, Phase 2 ruling 1's local
 * rate at the model's size).
 *
 * While it runs the gate is re-read every `GATE.pollMs` (and the school's
 * own switch with it); the moment either fails the process gets SIGTERM,
 * then SIGKILL `GATE.killGraceMs` later, and the train is paused with the
 * reason and the steps the pause lost (those done since the last save).
 * `pauseAll` does the same for every live train at once (and stops the
 * trains held with `holdTrain`, a voyage's) (the stop file, the
 * school turned off: `schoolOff` in tick.ts). The ledger carries `train.started`, then one of
 * `train.paused` or `train.ended`, each with the whole TrainState.
 *
 * The child's stdout is JSON lines: an object with numeric `step` and `of`
 * is progress, one with numeric `saved` names the last step written to
 * disk; everything else is passed on to `onLine` and kept out of the state.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { localCredits } from '../../shared/credits.js';
import { GATE } from '../../shared/school-rules.js';
import type { GateState, ModelRef, TrainKind, TrainState } from '../../shared/types.js';
import { emit } from '../events.js';
import { getRunner, getSpawner, NEVER_INHERITED, signalGroup, type SpawnLine, type Spawned } from '../exec.js';
import { paths } from '../home.js';
import { record, query } from '../ledger.js';
import { charge, unattended } from '../market/budget.js';
import { wrap } from '../market/sandbox.js';
import { getSettings } from '../settings.js';
import { gateNow, type GateKind } from './gate.js';
import { TRAINER_DIR, trainerEnv, trainerPython } from './trainer-env.js';

export interface StartTrain {
  kind: TrainKind;
  /** Which gate this train needs: `light` for the nets, `heavy` for a LoRA, an arena or a voyage. */
  gate: GateKind;
  /** The one request written to `school.py`'s stdin, as a JSON line. */
  command: object;
  /** The model's size in GB, for the local credit rate. */
  gb: number;
  /** Every line the child writes, in order. */
  onLine: (line: SpawnLine) => void;
  /** The wall clock at the start; defaults to now. */
  now?: number;
  /** The model the credits row names; defaults to the school's base model as `mlx:`. */
  model?: ModelRef;
  /** The `mlx_lm.server` loopback port, when this train serves one (ruling 26). */
  bindPort?: number;
  /** The one loopback port of the download proxy, for `download_base` alone (ruling 25). */
  proxyPort?: number;
  /** Extra variables the caller names explicitly (HF_HOME for a download); any key or token among them is dropped (`safeEnv`). */
  env?: Record<string, string>;
}

/** The reason a train is paused when the trainer's own switch goes off while it runs. */
export const SCHOOL_OFF_REASON = 'the school is off';
/** The reason a train found running in the ledger at engine start is paused. */
export const ENGINE_STOPPED_REASON = 'the engine stopped';
const NOT_SET_UP = 'The trainer is not set up on this Mac';

type Gate = (kind: GateKind, now: number) => Promise<GateState>;
let gateFn: Gate = gateNow;

/** Installs a gate for tests, or `null` to read the real one again. */
export function setGate(fn: Gate | null): void {
  gateFn = fn ?? gateNow;
}

/** The gate as the trainer reads it (the one `setGate` installed, else the real one), for the school tick. */
export function readGate(kind: GateKind, now: number): Promise<GateState> {
  return gateFn(kind, now);
}

type Kill = (pgid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
let killFn: Kill = signalGroup;

/** Installs the group kill `failInterruptedTrains` uses, for tests, or `null` for the real one. */
export function setKill(fn: Kill | null): void {
  killFn = fn ?? signalGroup;
}

/** Variables a caller's `env` may never add to the child: the keys the engine strips from every child, and anything named like one. */
const STRIPPED_ENV = new Set<string>([...NEVER_INHERITED, 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
const STRIPPED_SUFFIX = /(_API_KEY|_TOKEN|_SECRET)$/;

/** `env` without any key or token, whatever the caller meant. */
export function safeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (STRIPPED_ENV.has(k) || STRIPPED_SUFFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

interface Live {
  state: TrainState;
  gate: GateKind;
  child: Spawned;
  /** The step last written to disk, from the child's `saved` lines. */
  savedStep: number;
  poll: ReturnType<typeof setInterval> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const live = new Map<string, Live>();

function unref(t: { unref?: () => unknown }): void {
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Trains with no process of their own (a voyage races in the engine
 * through Beagle): held here so the school runs one train at a time, and
 * stopped by `pauseAll` like any other.
 */
const held = new Map<string, { state: TrainState; stop: (reason: string) => void }>();

/**
 * Holds `state` as a live train until the returned function is called;
 * `stop(reason)` is how `pauseAll` stops it. The caller keeps `state`
 * current (its status, its credits).
 */
export function holdTrain(state: TrainState, stop: (reason: string) => void): () => void {
  const entry = { state, stop };
  held.set(state.id, entry);
  return () => {
    if (held.get(state.id) === entry) held.delete(state.id);
  };
}

/** Every train that has started and not yet ended, as it stands now (a paused one stays here until its process is gone). */
export function liveTrains(): TrainState[] {
  return [...[...live.values()].map((l) => l.state), ...[...held.values()].map((h) => h.state)].map((t) => ({ ...t, steps: t.steps ? { ...t.steps } : null }));
}

function trainState(id: string, kind: TrainKind, startedAt: number): TrainState {
  return { id, kind, status: 'waiting', reason: null, startedAt: new Date(startedAt).toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 };
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Reads a progress or save line into the state; anything else is left alone. */
function noteLine(l: Live, line: SpawnLine): void {
  if (line.stream !== 'stdout' || !line.line.startsWith('{')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const d = parsed as Record<string, unknown>;
  const step = num(d.step);
  const of = num(d.of);
  const saved = num(d.saved);
  if (step !== null && of !== null) {
    const prev = l.state.steps;
    l.state.steps = { done: step, of, lost: prev?.lost ?? 0, optimizerReset: prev?.optimizerReset ?? false };
  }
  if (saved !== null) l.savedStep = Math.max(l.savedStep, saved);
}

/** Sends SIGTERM now and SIGKILL `GATE.killGraceMs` later; marks the train paused with `reason`. A second call, or one on a train that has ended, changes nothing. */
function pause(l: Live, reason: string): void {
  if (live.get(l.state.id) !== l || l.state.status !== 'running') return;
  l.state.status = 'paused';
  l.state.reason = reason;
  if (l.poll) clearInterval(l.poll);
  l.poll = null;
  l.child.kill('SIGTERM');
  l.killTimer = setTimeout(() => l.child.kill('SIGKILL'), GATE.killGraceMs);
  unref(l.killTimer);
}

/** Pauses every live train with `reason` (the stop file, the school switched off, the engine shutting down). */
export async function pauseAll(reason: string): Promise<void> {
  for (const l of live.values()) pause(l, reason);
  for (const h of [...held.values()]) {
    try {
      h.stop(reason);
    } catch (err) {
      console.error('palimpsest: stopping a train failed:', err);
    }
  }
}

async function pollOnce(l: Live): Promise<void> {
  if (l.state.status !== 'running') return;
  let reason: string | null;
  if (!getSettings().school.enabled) reason = SCHOOL_OFF_REASON;
  else {
    try {
      const g = await gateFn(l.gate, Date.now());
      reason = g.ok ? null : (g.reason ?? 'the gate closed');
    } catch (err) {
      reason = `the gate could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // the train may have ended while the gate was read: nothing is paused or armed then
  if (reason && live.get(l.state.id) === l) pause(l, reason);
}

/**
 * Starts one train. Resolves when its process has ended, with the final
 * state; resolves at once with `waiting` and the gate's reason when the gate
 * does not hold, or `failed` when there is no trainer Python, and in neither
 * case is anything spawned or recorded.
 */
export async function startTrain(o: StartTrain): Promise<TrainState> {
  const asked = o.now ?? Date.now();
  const id = `train-${randomUUID().slice(0, 8)}`;
  const python = trainerPython();
  if (!python) return { ...trainState(id, o.kind, asked), status: 'failed', reason: NOT_SET_UP };
  if (!getSettings().school.enabled) return { ...trainState(id, o.kind, asked), reason: SCHOOL_OFF_REASON };
  const g = await gateFn(o.gate, asked);
  if (!g.ok) return { ...trainState(id, o.kind, asked), reason: g.reason ?? 'the gate closed' };

  // the seconds charged run from here, after the gate answered, not from when the caller asked
  const startedAt = Date.now();
  const state = trainState(id, o.kind, startedAt);
  const school = paths().school;
  const tmp = join(school, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const wasUnattended = unattended(startedAt);
  const model: ModelRef = o.model ?? `mlx:${getSettings().school.baseModel}`;
  const argv = wrap([python, join(TRAINER_DIR, 'school.py')], 'trainer', { school, tmp, bindPort: o.bindPort, proxyPort: o.proxyPort }, (line) =>
    o.onLine({ stream: 'stderr', line: `[palimpsest] ${line}` }),
  );
  const env: Record<string, string> = { ...trainerEnv(), HOME: tmp, TMPDIR: tmp, ...safeEnv(o.env) };
  const child = getSpawner()(argv[0], argv.slice(1), {
    cwd: tmp,
    env,
    clearEnv: true,
    stdin: JSON.stringify(o.command) + '\n',
    killGraceMs: GATE.killGraceMs,
  });

  state.status = 'running';
  const l: Live = { state, gate: o.gate, child, savedStep: 0, poll: null, killTimer: null };
  live.set(id, l);
  // the pid is the process group too (the spawner starts children detached): a restart reaps it by this
  record('train.started', { train: { ...state }, pid: child.pid });
  emit('train.started', { train: { ...state } });

  l.poll = setInterval(() => void pollOnce(l), GATE.pollMs);
  unref(l.poll);

  const reading = (async () => {
    for await (const line of child.lines) {
      noteLine(l, line);
      try {
        o.onLine(line);
      } catch {
        // a listener's failure never stops the train
      }
    }
  })();
  const done = await child.done;
  await reading;

  if (l.poll) clearInterval(l.poll);
  if (l.killTimer) clearTimeout(l.killTimer);
  live.delete(id);

  const endedAt = Date.now();
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const credits = localCredits(seconds, o.gb);
  const paused = l.state.status === 'paused'; // read through the live entry: the poll may have paused it
  state.endedAt = new Date(endedAt).toISOString();
  state.seconds = seconds;
  state.credits = credits;
  if (paused && state.steps) state.steps = { ...state.steps, lost: Math.max(0, state.steps.done - l.savedStep), optimizerReset: true };
  if (!paused) {
    if (done.error) {
      state.status = 'failed';
      state.reason = `the trainer could not start: ${done.error}`;
    } else if (done.code === 0) {
      state.status = 'done';
    } else {
      state.status = 'failed';
      state.reason = done.signal ? `the trainer was killed by ${done.signal}` : `the trainer exited ${done.code}`;
    }
  }
  charge({
    runId: id,
    firmId: null,
    model,
    kind: 'train',
    usage: { weightedTokens: 0, seconds, usd: 0, credits },
    unattended: wasUnattended,
    at: endedAt,
  });
  const entry = paused ? { train: { ...state }, reason: state.reason, lost: state.steps?.lost ?? 0 } : { train: { ...state } };
  record(paused ? 'train.paused' : 'train.ended', entry);
  emit(paused ? 'train.paused' : 'train.ended', entry);
  return { ...state };
}

/** Whether `pid` is still a process running our `school.py` (its command line names it), so a reused pid is never signalled. */
async function isOurTrainer(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const r = await getRunner()('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000 });
    return r.code === 0 && r.stdout.includes(join(TRAINER_DIR, 'school.py'));
  } catch {
    return false;
  }
}

/**
 * At engine start: a train the last engine had running can never report
 * again. If its process group is still alive and still our `school.py`, it
 * gets SIGTERM now and SIGKILL `GATE.killGraceMs` later; then the train is
 * paused in the ledger with `ENGINE_STOPPED_REASON`. Its seconds past the
 * last entry are unknown and go uncharged.
 */
export async function failInterruptedTrains(now: number = Date.now()): Promise<void> {
  const last = new Map<string, { train: TrainState; pid: number | null }>();
  for (const e of query({ kind: ['train.started', 'train.paused', 'train.ended'] })) {
    const d = e.data as { train?: TrainState; pid?: unknown } | null;
    const t = d?.train;
    if (!t || typeof t.id !== 'string') continue;
    const pid = typeof d?.pid === 'number' ? d.pid : (last.get(t.id)?.pid ?? null);
    last.set(t.id, { train: t, pid });
  }
  for (const { train: t, pid } of last.values()) {
    if (t.status !== 'running' && t.status !== 'waiting') continue;
    if (pid !== null && (await isOurTrainer(pid))) {
      killFn(pid, 'SIGTERM');
      const later = setTimeout(() => killFn(pid, 'SIGKILL'), GATE.killGraceMs);
      unref(later);
    }
    const train: TrainState = {
      ...t,
      status: 'paused',
      reason: ENGINE_STOPPED_REASON,
      endedAt: new Date(now).toISOString(),
      steps: t.steps ? { ...t.steps, optimizerReset: true } : null,
    };
    record('train.paused', { train, reason: ENGINE_STOPPED_REASON, lost: train.steps?.lost ?? 0 });
  }
}
