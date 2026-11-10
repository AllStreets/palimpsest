/**
 * The city treasury (Task 3): what the city may spend of his Claude plan
 * now, and the leases every model call takes before it runs (ruling 28).
 *
 * Windows: his last reading plus what the city has spent since, with a
 * margin that grows by a tenth per hour the reading is stale. Pauses in
 * priority order: stopped (the stop file), hard (either window at the hard
 * stop), stale (no reading for five hours), cap (the city's share of the
 * five-hour window), night (the weekly night cap while unattended).
 *
 * Pools: `claude` and `local` work slots, an unlimited `api` pool bounded
 * by dollars, and a plan pool (two Claude, one local) for bid-time plan
 * calls, which queue FIFO until their bid window closes. Review and judge
 * calls are sub-leases of their run's work lease.
 */
import { existsSync } from 'node:fs';

import { apiCredits, claudeCredits, CREDIT_PCT, pctFor } from '../../shared/credits.js';
import { CREDITS_PER_USD } from '../../shared/market-rules.js';
import type { BudgetWindow, ModelRef, TreasuryState, UsageReading } from '../../shared/types.js';
import { openDb } from '../db.js';
import { paths } from '../home.js';
import { getSettings } from '../settings.js';
import {
  cityWeighted,
  interactiveActive,
  isStale,
  latestReading,
  storedCalibration,
  transcriptTokens,
  weekPerWindowPct,
} from '../usage.js';
import type { Usage } from './provider.js';

/** Credits a bid-time plan call is assumed to cost before it runs. */
export const PLAN_ESTIMATE = 3;
/** Credits a review call is assumed to cost. */
export const REVIEW_ESTIMATE = 5;
/** Credits a design judge call is assumed to cost. */
export const JUDGE_ESTIMATE = 4;
/** Plan calls at a time per pool, independent of the run slots (ruling 28). */
export const PLAN_POOL = { claude: 2, local: 1 } as const;

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;
const UNATTENDED_MS = 30 * MIN_MS;
/** How long past staleness a resume (`resumeStaleUntil`) can carry the city: a resume never outlives a reading by more than this. */
export const MAX_RESUME_MS = 5 * HOUR_MS;
/** How much the city's unmeasured spend is inflated per hour the reading is stale. */
const STALE_MARGIN_PER_HOUR = 0.1;
/** The credits row kinds this module writes: the city's spend on model calls. */
const SPEND_KINDS = ['bid', 'run', 'review', 'judge'] as const;

type Pool = 'claude' | 'local' | 'api';
type Paused = NonNullable<TreasuryState['paused']>;
export type Busy = { reason: 'busy'; detail: string };
export type Refusal = { ok: false; reason: Paused | Busy };

export interface Lease {
  signal: AbortSignal;
  /** A review or judge call under this lease's slot; checks the caps for its own model. */
  sub(kind: 'review' | 'judge', model: ModelRef, estimate: number): Lease | Refusal;
  release(): void;
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function poolOf(model: ModelRef): Pool {
  if (model.startsWith('claude:')) return 'claude';
  if (model.startsWith('anthropic:')) return 'api';
  return 'local';
}

// ---------------------------------------------------------------- SSE clients and unattended (ruling 11)

let sseCount = 0;
let sseLast: number | null = null;

/** The server calls this on every SSE connect and close with the number of clients now connected. */
export function noteSseClients(n: number, now: number = Date.now()): void {
  sseCount = Math.max(0, n);
  sseLast = now;
}

export function sseClientCount(): number {
  return sseCount;
}

/** When a client was last connected (the last connect or close), or null when none has been. */
export function lastSseAt(): number | null {
  return sseLast;
}

/** No app client on the SSE stream for 30 minutes, or local time between 23:00 and 07:00. */
export function unattended(now: number = Date.now()): boolean {
  const hour = new Date(now).getHours();
  if (hour >= 23 || hour < 7) return true;
  if (sseCount > 0) return false;
  return sseLast === null || now - sseLast >= UNATTENDED_MS;
}

// ---------------------------------------------------------------- keep-awake and hard stop hooks

let keepAwakeFn: (() => { on: boolean; held: boolean }) | null = null;

/** Task 13 registers the real keep-awake state here; until then the setting is read and nothing is held. */
export function registerKeepAwake(fn: () => { on: boolean; held: boolean }): void {
  keepAwakeFn = fn;
}

const hardStopListeners: Array<() => void> = [];
let lastHard: 'hard' | 'stopped' | null = null;

/** Called once each time the state enters `hard` or `stopped`, after every affected lease has been aborted. */
export function onHardStop(fn: () => void): void {
  hardStopListeners.push(fn);
}

// ---------------------------------------------------------------- credits

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const KIND_LIST = SPEND_KINDS.map((k) => `'${k}'`).join(', ');

/** Credits the city spent on models matching `pattern` since `fromMs`, optionally only unattended ones. */
function spentCredits(fromMs: number, toMs: number, pattern: string, onlyUnattended = false): number {
  const row = openDb()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS c FROM credits
       WHERE kind IN (${KIND_LIST}) AND at >= ? AND at <= ?
       AND json_extract(json, '$.model') LIKE ?
       ${onlyUnattended ? "AND json_extract(json, '$.unattended') = 1" : ''}`,
    )
    .get(iso(fromMs), iso(toMs), pattern) as { c: number };
  return row.c;
}

function spentUsd(fromMs: number, toMs: number): number {
  const row = openDb()
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS u FROM credits
       WHERE kind IN (${KIND_LIST}) AND at >= ? AND at <= ? AND json_extract(json, '$.model') LIKE 'anthropic:%'`,
    )
    .get(iso(fromMs), iso(toMs)) as { u: number };
  return round(row.u);
}

/** The credits a call's usage comes to on `model`'s pool, at the current calibration. */
export function creditsFor(model: ModelRef, usage: Usage): number {
  const pool = poolOf(model);
  if (pool === 'claude') return claudeCredits(usage.weightedTokens, storedCalibration().value);
  if (pool === 'api') return apiCredits(usage.usd);
  return round(usage.credits);
}

/**
 * Writes one credits row for a model call the city paid for and returns its
 * credits (a positive amount spent): Claude by weighted tokens at the
 * current calibration, local models by the provider's own `usage.credits`,
 * the Anthropic API by dollars. `at` defaults to now.
 */
export function charge(o: {
  runId: string | null;
  firmId: string | null;
  model: ModelRef;
  kind: 'bid' | 'run' | 'review' | 'judge';
  usage: Usage;
  unattended: boolean;
  at?: number;
  /** The lease the call ran under: its reserved estimate is replaced by this real spend. */
  lease?: Lease;
  /** A floor on the credits written, for calls whose real usage is unknown or under-reported (bid plan calls). */
  minCredits?: number;
}): number {
  const at = o.at ?? Date.now();
  const leased = o.lease ? recOf.get(o.lease) : undefined;
  if (leased) leased.reserved = 0;
  const pool = poolOf(o.model);
  const tokensPerPct = storedCalibration().value;
  const credits = Math.max(creditsFor(o.model, o.usage), round(o.minCredits ?? 0));
  const usd = pool === 'api' ? o.usage.usd : null;
  openDb()
    .prepare('INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      iso(at),
      o.firmId,
      o.runId,
      o.kind,
      credits,
      usd,
      JSON.stringify({
        model: o.model,
        pool,
        kind: o.kind,
        usage: o.usage,
        // A floored charge counts as the tokens it stands for, so the window estimates see it too.
        weightedTokens: pool === 'claude' ? Math.max(o.usage.weightedTokens, round(credits * CREDIT_PCT * tokensPerPct)) : 0,
        tokensPerPct: pool === 'claude' ? tokensPerPct : null,
        credits,
        unattended: o.unattended,
      }),
    );
  // A charge can carry a window over the hard stop.
  noteHard(core(at));
  return credits;
}

// ---------------------------------------------------------------- windows

interface Core {
  now: number;
  stopped: boolean;
  hard: boolean;
  stale: boolean;
  reading: UsageReading | null;
  tokensPerPct: number;
  calibrated: boolean;
  samples: number;
  fiveHour: BudgetWindow;
  sevenDay: BudgetWindow;
  nightUsedPct: number;
  weekRatio: number;
  unattended: boolean;
  settings: ReturnType<typeof getSettings>;
}

/**
 * One window: his used percent from the reading (zero once the window has
 * reset since), plus the city's Claude tokens since then at the calibrated
 * rate, inflated by 10% per hour of staleness.
 */
function windowOf(
  w: { usedPercentage: number; resetsAt: number } | null,
  reading: UsageReading | null,
  lengthMs: number,
  pctPerWindowPct: number,
  capPct: number,
  tokensPerPct: number,
  now: number,
): BudgetWindow {
  const resetsAtMs = w ? w.resetsAt * 1000 : null;
  const live = w !== null && resetsAtMs !== null && resetsAtMs > now;
  const reset = w !== null && !live;
  const windowStart = live ? (resetsAtMs as number) - lengthMs : now - lengthMs;
  const base = live ? w.usedPercentage : 0;
  let since: number;
  if (reading && live) since = reading.at;
  else if (reading && reset) since = Math.max(reading.at, resetsAtMs as number);
  else since = windowStart;
  const hoursStale = reading ? Math.max(0, (now - reading.at) / HOUR_MS) : 0;
  // When the reading cannot speak for his use (none, stale, or its window reset since), count his own
  // transcripts since then, so the hard stop still sees him while a resume carries the city on.
  const blind = !reading || w === null || reset || now - reading.at > FIVE_HOURS_MS;
  const hisTokens = blind ? transcriptTokens(since, now).weighted : 0;
  const cityTokens = cityWeighted(since, now) + hisTokens;
  const estimatedPct = round(base + (cityTokens / tokensPerPct) * pctPerWindowPct * (1 + STALE_MARGIN_PER_HOUR * hoursStale));
  const cityPct = round(pctFor(spentCredits(windowStart, now, 'claude:%')) * pctPerWindowPct);
  return {
    capPct,
    cityPct,
    usedPct: w ? (live ? w.usedPercentage : 0) : null,
    estimatedPct,
    resetsAt: w ? w.resetsAt : null,
  };
}

function core(now: number): Core {
  const settings = getSettings();
  const reading = latestReading();
  const cal = storedCalibration();
  const week = weekPerWindowPct(cal);
  const fiveHour = windowOf(reading?.fiveHour ?? null, reading, FIVE_HOURS_MS, 1, settings.dayCapPct, cal.value, now);
  const sevenDay = windowOf(reading?.sevenDay ?? null, reading, SEVEN_DAYS_MS, week, settings.hardStopPct, cal.value, now);
  const weekStart =
    reading?.sevenDay && reading.sevenDay.resetsAt * 1000 > now ? reading.sevenDay.resetsAt * 1000 - SEVEN_DAYS_MS : now - SEVEN_DAYS_MS;
  const nightUsedPct = round(pctFor(spentCredits(weekStart, now, 'claude:%', true)) * week);
  const resumeUntil = settings.resumeStaleUntil;
  const resumed =
    resumeUntil !== null &&
    resumeUntil > now &&
    (reading ? now - reading.at < FIVE_HOURS_MS + MAX_RESUME_MS : resumeUntil - now <= MAX_RESUME_MS);
  // A reading missing either window cannot be trusted any more than an old one.
  const unreadable = reading === null || reading.fiveHour === null || reading.sevenDay === null || isStale(reading, now);
  const stale = unreadable && !resumed;
  return {
    now,
    stopped: existsSync(paths().stop),
    hard: fiveHour.estimatedPct >= settings.hardStopPct || sevenDay.estimatedPct >= settings.hardStopPct,
    stale,
    reading,
    tokensPerPct: cal.value,
    calibrated: cal.samples > 0,
    samples: cal.samples,
    fiveHour,
    sevenDay,
    nightUsedPct,
    weekRatio: week,
    unattended: unattended(now),
    settings,
  };
}

/** Why a call on `pool` costing `estimate` credits may not start now, or null. */
function gate(pool: Pool, estimate: number, c: Core): Paused | null {
  if (c.stopped) return { reason: 'stopped', detail: 'The stop switch is on.' };
  if (pool === 'api') {
    const api = c.settings.anthropicApi;
    if (!api.enabled) return { reason: 'cap', detail: 'The Anthropic API backend is off.' };
    const spent = spentUsd(localMidnight(c.now), c.now);
    if (spent + (reservedCredits('api') + estimate) / CREDITS_PER_USD > api.dailyUsd + 1e-9) {
      return { reason: 'cap', detail: `API spend today is $${spent.toFixed(2)} of the $${api.dailyUsd} daily limit.` };
    }
    return null;
  }
  if (c.hard) {
    return {
      reason: 'hard',
      detail: `A window is estimated at ${Math.max(c.fiveHour.estimatedPct, c.sevenDay.estimatedPct).toFixed(1)}%, at or above the ${c.settings.hardStopPct}% hard stop.`,
    };
  }
  if (pool === 'local') return null;
  if (c.stale) {
    return {
      reason: 'stale',
      detail: c.reading ? 'The last usage reading is more than five hours old.' : 'No usage reading yet.',
    };
  }
  const reserved = reservedCredits('claude');
  if (c.fiveHour.cityPct + CREDIT_PCT * (reserved + estimate) > c.settings.dayCapPct + 1e-9) {
    return {
      reason: 'cap',
      detail: `The city has spent ${c.fiveHour.cityPct.toFixed(1)}% of this window; the cap is ${c.settings.dayCapPct}%.`,
    };
  }
  if (c.unattended && c.nightUsedPct + pctFor(reserved) * c.weekRatio >= c.settings.nightCapPct - 1e-9) {
    return {
      reason: 'night',
      detail: `Unattended Claude use this week is ${c.nightUsedPct.toFixed(1)}% of the ${c.settings.nightCapPct}% night cap.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- leases

interface LeaseRec {
  pool: Pool;
  kind: 'plan' | 'work' | 'review' | 'judge';
  /** Whether this lease holds a work slot in its pool (a work lease, or a sub-lease in another pool than its run). */
  holdsWork: boolean;
  controller: AbortController;
  children: Set<LeaseRec>;
  parent: LeaseRec | null;
  released: boolean;
  /** Credits held against the caps until the call is charged or released. */
  reserved: number;
  /** The injected clock at grant, and the wall clock then, so later checks advance the injected clock. */
  now0: number;
  real0: number;
}

interface Waiter {
  pool: Pool;
  estimate: number;
  waitUntil: number;
  now0: number;
  real0: number;
  timer: NodeJS.Timeout;
  resolve: (r: { ok: true; lease: Lease } | Refusal) => void;
}

const live = new Set<LeaseRec>();
const recOf = new WeakMap<Lease, LeaseRec>();

/** Credits reserved by live leases on `pool`: calls granted but not yet charged. */
function reservedCredits(pool: Pool): number {
  let n = 0;
  for (const r of live) if (r.pool === pool) n += r.reserved;
  return n;
}
const queues: Record<Pool, Waiter[]> = { claude: [], local: [], api: [] };

function clockOf(x: { now0: number; real0: number }): number {
  return x.now0 + (Date.now() - x.real0);
}

function workCount(pool: Pool): number {
  let n = 0;
  for (const r of live) if (r.pool === pool && r.holdsWork) n++;
  return n;
}

function planCount(pool: Pool): number {
  let n = 0;
  for (const r of live) if (r.pool === pool && r.kind === 'plan') n++;
  return n;
}

function workMax(pool: Pool, c: Core, now: number): number {
  if (pool === 'claude') return interactiveActive(now) ? 1 : c.settings.claudeConcurrency;
  if (pool === 'local') return c.settings.localConcurrency;
  return Number.POSITIVE_INFINITY;
}

function planMax(pool: Pool): number {
  if (pool === 'api') return Number.POSITIVE_INFINITY;
  return PLAN_POOL[pool];
}

function release(rec: LeaseRec): void {
  if (rec.released) return;
  rec.released = true;
  live.delete(rec);
  for (const child of rec.children) release(child);
  rec.parent?.children.delete(rec);
  if (rec.kind === 'plan') drain(rec.pool);
}

function grant(rec: LeaseRec): Lease {
  live.add(rec);
  const lease: Lease = {
    signal: rec.controller.signal,
    sub: (kind, model, estimate) => sub(rec, kind, model, estimate),
    release: () => release(rec),
  };
  recOf.set(lease, rec);
  return lease;
}

function newRec(
  pool: Pool,
  kind: LeaseRec['kind'],
  holdsWork: boolean,
  now: number,
  parent: LeaseRec | null,
  estimate: number,
): LeaseRec {
  return {
    pool,
    kind,
    holdsWork,
    controller: new AbortController(),
    children: new Set(),
    parent,
    released: false,
    reserved: Math.max(0, estimate),
    now0: now,
    real0: Date.now(),
  };
}

/** The pool a run's slot lives in: the root work lease's pool. */
function rootPool(rec: LeaseRec): Pool {
  let r = rec;
  while (r.parent) r = r.parent;
  return r.pool;
}

function sub(parent: LeaseRec, kind: 'review' | 'judge', model: ModelRef, estimate: number): Lease | Refusal {
  if (parent.released) return { ok: false, reason: { reason: 'busy', detail: 'The run lease was already released.' } };
  const now = clockOf(parent);
  const c = core(now);
  noteHard(c);
  const pool = poolOf(model);
  const paused = gate(pool, estimate, c);
  if (paused) return { ok: false, reason: paused };
  const otherPool = pool !== rootPool(parent);
  if (otherPool && workCount(pool) >= workMax(pool, c, now)) {
    return { ok: false, reason: { reason: 'busy', detail: `Every ${pool} slot is taken.` } };
  }
  const rec = newRec(pool, kind, otherPool, now, parent, estimate);
  parent.children.add(rec);
  // A sub-lease ends with its run.
  if (parent.controller.signal.aborted) rec.controller.abort(parent.controller.signal.reason);
  else parent.controller.signal.addEventListener('abort', () => rec.controller.abort(parent.controller.signal.reason), { once: true });
  return grant(rec);
}

/** Grants queued plan calls in FIFO order while their pool has a free plan slot. */
function drain(pool: Pool): void {
  const q = queues[pool];
  while (q.length > 0 && planCount(pool) < planMax(pool)) {
    const w = q.shift() as Waiter;
    clearTimeout(w.timer);
    const now = clockOf(w);
    const c = core(now);
    noteHard(c);
    const paused = gate(pool, w.estimate, c);
    if (paused) {
      w.resolve({ ok: false, reason: paused });
      continue;
    }
    w.resolve({ ok: true, lease: grant(newRec(pool, 'plan', false, now, null, w.estimate)) });
  }
}

/** Aborts the leases a hard stop or the stop switch ends, refuses their queued calls, then tells the listeners. */
function noteHard(c: Core): void {
  const state = c.stopped ? 'stopped' : c.hard ? 'hard' : null;
  if (state === lastHard) return;
  lastHard = state;
  if (state === null) return;
  const affected = (pool: Pool): boolean => state === 'stopped' || pool === 'claude';
  for (const rec of live) {
    if (affected(rec.pool) && !rec.controller.signal.aborted) rec.controller.abort(new Error(`budget: ${state}`));
  }
  const reason: Paused =
    state === 'stopped'
      ? { reason: 'stopped', detail: 'The stop switch is on.' }
      : { reason: 'hard', detail: `A window reached the ${c.settings.hardStopPct}% hard stop.` };
  for (const pool of Object.keys(queues) as Pool[]) {
    if (!affected(pool)) continue;
    for (const w of queues[pool].splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, reason });
    }
  }
  for (const fn of hardStopListeners) {
    try {
      fn();
    } catch {
      // One listener's failure must not keep the others from running.
    }
  }
}

/**
 * Asks for a lease before a model call (ruling 28). Claude models obey every
 * pause; local models obey `stopped` and `hard`; `anthropic:` models obey
 * `stopped` and the dollar cap. A `work` lease is `busy` at once when its
 * pool is full. A `plan` lease waits in its pool's FIFO queue until a slot
 * frees or `waitUntil` passes, then is `busy`.
 */
export function acquire(
  model: ModelRef,
  kind: 'plan' | 'work',
  estimate: number,
  opts: { now?: number; waitUntil?: number } = {},
): Promise<{ ok: true; lease: Lease } | Refusal> {
  const now = opts.now ?? Date.now();
  const c = core(now);
  noteHard(c);
  const pool = poolOf(model);
  const paused = gate(pool, estimate, c);
  if (paused) return Promise.resolve({ ok: false, reason: paused });

  if (kind === 'work') {
    if (workCount(pool) >= workMax(pool, c, now)) {
      return Promise.resolve({ ok: false, reason: { reason: 'busy', detail: `Every ${pool} run slot is taken.` } });
    }
    return Promise.resolve({ ok: true, lease: grant(newRec(pool, 'work', true, now, null, estimate)) });
  }

  if (queues[pool].length === 0 && planCount(pool) < planMax(pool)) {
    return Promise.resolve({ ok: true, lease: grant(newRec(pool, 'plan', false, now, null, estimate)) });
  }
  const waitUntil = opts.waitUntil;
  if (waitUntil === undefined || waitUntil <= now) {
    return Promise.resolve({ ok: false, reason: { reason: 'busy', detail: 'No plan slot before the window closed.' } });
  }
  return new Promise((resolve) => {
    const w: Waiter = {
      pool,
      estimate,
      waitUntil,
      now0: now,
      real0: Date.now(),
      resolve,
      timer: setTimeout(() => {
        const i = queues[pool].indexOf(w);
        if (i >= 0) queues[pool].splice(i, 1);
        resolve({ ok: false, reason: { reason: 'busy', detail: 'No plan slot before the window closed.' } });
      }, waitUntil - now),
    };
    queues[pool].push(w);
  });
}

/**
 * Aborts a lease and every sub-lease under it (the runner's kill: the stop
 * file, him, a halt). The slot stays held until the holder releases it.
 */
export function abortLease(lease: Lease, reason: Error): void {
  const rec = recOf.get(lease);
  if (rec && !rec.controller.signal.aborted) rec.controller.abort(reason);
}

/**
 * Aborts every live lease (runs, plan, review and judge calls) and refuses
 * every queued plan call: the engine is shutting down.
 */
export function abortAllLeases(reason: Error): void {
  for (const rec of live) if (!rec.controller.signal.aborted) rec.controller.abort(reason);
  for (const pool of Object.keys(queues) as Pool[]) {
    for (const w of queues[pool].splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, reason: { reason: 'stopped', detail: reason.message } });
    }
  }
}

/** Leases live now (runs, plan calls and sub-leases), for keep-awake. */
export function liveLeaseCount(): number {
  return live.size;
}

// ---------------------------------------------------------------- the treasury

/** The treasury as the screen and the scheduler see it. Entering `hard` or `stopped` here aborts leases and fires `onHardStop`. */
export function treasury(now: number = Date.now()): TreasuryState {
  const c = core(now);
  noteHard(c);
  const active = interactiveActive(now);
  const paused = gate('claude', PLAN_ESTIMATE, c);
  const api = c.settings.anthropicApi;
  const keepAwake = keepAwakeFn ? keepAwakeFn() : { on: c.settings.keepAwake, held: false };
  return {
    tokensPerPct: c.tokensPerPct,
    calibrated: c.calibrated,
    samples: c.samples,
    fiveHour: c.fiveHour,
    sevenDay: c.sevenDay,
    night: { capPct: c.settings.nightCapPct, usedPct: c.nightUsedPct, unattended: c.unattended },
    interactiveActive: active,
    paused,
    concurrency: {
      claude: workCount('claude'),
      local: workCount('local'),
      api: workCount('api'),
      claudeMax: active ? 1 : c.settings.claudeConcurrency,
      localMax: c.settings.localConcurrency,
    },
    api: { enabled: api.enabled, spentUsdToday: spentUsd(localMidnight(now), now), dailyUsd: api.dailyUsd },
    keepAwake,
    citySpent: {
      today: round(spentCredits(localMidnight(now), now, '%')),
      week: round(spentCredits(now - SEVEN_DAYS_MS, now, '%')),
    },
  };
}

/** Clears every lease, queue, listener and counter. For tests. */
export function resetBudget(): void {
  for (const pool of Object.keys(queues) as Pool[]) {
    for (const w of queues[pool].splice(0)) clearTimeout(w.timer);
  }
  live.clear();
  hardStopListeners.length = 0;
  lastHard = null;
  keepAwakeFn = null;
  sseCount = 0;
  sseLast = null;
}
