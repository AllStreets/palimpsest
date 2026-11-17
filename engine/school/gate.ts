/**
 * The training gate (Phase 4 ruling 6, Decisions 3 and 4): whether this Mac
 * may train now, read the way macOS 26 says it, and why not when it may not.
 *
 * Both kinds need the school on, the stop file absent, AC power, a power mode
 * other than Low Power (unless `school.allowLowPower`), the local time inside
 * `school.window` (unless "Train now" is live), and no local work live or
 * awarded. `heavy` (LoRA, voyages, arena builds) adds 15 idle minutes (unless
 * "Train now"), nominal thermals and 20 GB free. "Train now" never skips
 * power, power mode, thermals or disk. A probe that cannot be read fails.
 *
 * Every probe goes through the injectable runner, read only, cached 10 s
 * (a failed read 1 s), one call shared by every gate that asks meanwhile.
 */
import { existsSync } from 'node:fs';

import { GATE, inWindow } from '../../shared/school-rules.js';
import { poolOfModel } from '../../shared/market-rules.js';
import type { GateState } from '../../shared/types.js';
import { getRunner } from '../exec.js';
import { home, paths } from '../home.js';
import { bidById } from '../market/bids.js';
import { liveWork } from '../market/budget.js';
import { agent } from '../market/firms.js';
import { listJobs } from '../market/jobs.js';
import { getSettings, patchSettings } from '../settings.js';

export type GateKind = 'light' | 'heavy';
export type Power = GateState['power'];
export type PowerMode = GateState['powerMode'];
export type Thermal = GateState['thermal'];

/** How long one reading of a probe stands. */
export const PROBE_CACHE_MS = 10_000;
/** How long a probe that could not be read stands before it is tried again. */
export const PROBE_FAIL_CACHE_MS = 1_000;
const PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- parsing

/** `pmset -g batt`: its first line says what the Mac draws from. */
export function parseBatt(text: string): Power {
  const first = text.trimStart().split(/\r?\n/)[0] ?? '';
  if (first.startsWith("Now drawing from 'AC Power'")) return 'ac';
  if (first.startsWith("Now drawing from 'Battery Power'")) return 'battery';
  return 'unknown';
}

/**
 * `pmset -g`: the `powermode` under "Currently in use:" (0 Automatic, 1 Low
 * Power, 2 High Power). A missing section or key, or any other value, is null.
 */
export function parsePowerMode(text: string): PowerMode {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'Currently in use:');
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break; // the section's keys are indented; the next heading is not
    const m = /^\s+powermode\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const v = m[1];
    return v === '0' ? 0 : v === '1' ? 1 : v === '2' ? 2 : null;
  }
  return null;
}

const THERM_NOTE = /^Note: No .+ has been recorded\.?$/;
const THERM_LEVEL = /^(?:Thermal|Performance) warning level (?:set to|=|:)\s*(\d+)\.?$/i;

/**
 * `pmset -g therm`: nominal when it says only "Note: No ... has been
 * recorded" or names warning levels of 0; `limited` for any other level;
 * `unknown` for anything it does not recognise (including nothing at all).
 */
export function parseTherm(text: string): Thermal {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 'unknown';
  let limited = false;
  for (const line of lines) {
    if (THERM_NOTE.test(line)) continue;
    const m = THERM_LEVEL.exec(line);
    if (!m) return 'unknown';
    if (Number(m[1]) !== 0) limited = true;
  }
  return limited ? 'limited' : 'nominal';
}

/**
 * `ioreg -c IOHIDSystem`: minutes since his last keystroke or mouse move,
 * the `HIDIdleTime` (nanoseconds) of the IOHIDSystem entry itself. ioreg
 * prints the entry's ancestors and children too, each a `+-o` line with its
 * own properties, so only the lines from that entry's header to the next
 * `+-o` are read; an answer with no header at all is read whole. Null when
 * there is no such entry or it has no idle time.
 */
export function parseIdle(text: string): number | null {
  // An answer with no `+-o` header at all is that entry's properties alone.
  let inEntry = !/^[\s|]*\+-o /m.test(text);
  for (const line of text.split(/\r?\n/)) {
    if (/^[\s|]*\+-o /.test(line)) {
      inEntry = /\+-o IOHIDSystem\b|<class IOHIDSystem[,>]/.test(line);
      continue;
    }
    if (!inEntry) continue;
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(line);
    if (m) return Number(BigInt(m[1]) / 1_000_000n) / 60_000;
  }
  return null;
}

/** `df -k <path>`: the space available, in decimal gigabytes. */
export function parseFreeGB(text: string): number | null {
  for (const line of text.split(/\r?\n/).slice(1)) {
    // blocks, used, available, capacity: the filesystem name before them may hold spaces.
    const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(line);
    if (m) return (Number(m[3]) * 1024) / 1e9;
  }
  return null;
}

// ---------------------------------------------------------------- probes

type Probe = 'batt' | 'g' | 'therm' | 'idle' | 'df';

/** Each probe's reading by when it was asked, held while it is still being read so concurrent gates share one call. */
const cache = new Map<Probe, { at: number; reading: Promise<string | null>; text?: string | null }>();

/** Forgets every cached reading (tests, and "Train now" which must read the power afresh). */
export function resetGateCache(): void {
  cache.clear();
}

function command(p: Probe): [string, string[]] {
  switch (p) {
    case 'batt': return ['/usr/bin/pmset', ['-g', 'batt']];
    case 'g': return ['/usr/bin/pmset', ['-g']];
    case 'therm': return ['/usr/bin/pmset', ['-g', 'therm']];
    case 'idle': return ['/usr/sbin/ioreg', ['-c', 'IOHIDSystem']];
    case 'df': return ['/bin/df', ['-k', home()]];
  }
}

/**
 * One probe's output, or null when it could not be read. Cached on the wall
 * clock, since it reads the real Mac: a reading in flight is shared, a good
 * one stands PROBE_CACHE_MS and a failed one PROBE_FAIL_CACHE_MS.
 */
function read(p: Probe): Promise<string | null> {
  const t = Date.now();
  const hit = cache.get(p);
  if (hit && t >= hit.at) {
    if (hit.text === undefined) return hit.reading;
    if (t - hit.at < (hit.text === null ? PROBE_FAIL_CACHE_MS : PROBE_CACHE_MS)) return hit.reading;
  }
  const [cmd, args] = command(p);
  const entry: { at: number; reading: Promise<string | null>; text?: string | null } = { at: t, reading: Promise.resolve(null) };
  entry.reading = (async () => {
    let text: string | null;
    try {
      const r = await getRunner()(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS });
      text = r.code === 0 ? r.stdout : null;
    } catch {
      text = null;
    }
    entry.text = text;
    return text;
  })();
  cache.set(p, entry);
  return entry.reading;
}

async function readPower(): Promise<Power> {
  const t = await read('batt');
  return t === null ? 'unknown' : parseBatt(t);
}

// ---------------------------------------------------------------- the gate

function trainNowLive(until: string | null, now: number): string | null {
  if (!until) return null;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now ? until : null;
}

/** Whether an awarded job's winning bid is a local agent's: it waits for the local slot the trainer would hold. */
function localAwardWaiting(): boolean {
  for (const j of listJobs({ status: ['awarded'] })) {
    const bid = j.awardedBid ? bidById(j.awardedBid) : null;
    const a = bid ? agent(bid.agentId) : null;
    if (a && poolOfModel(a.model) === 'local') return true;
  }
  return false;
}

/** The gate for `kind` at `now`, with every reading and the first reason it fails (null when it holds). */
export async function gateNow(kind: GateKind, now: number): Promise<GateState> {
  const s = getSettings().school;
  // Every probe is read for both kinds, so the light gate's state shows the whole Mac too.
  const [batt, g, therm, idle, disk] = await Promise.all([read('batt'), read('g'), read('therm'), read('idle'), read('df')]);
  const power: Power = batt === null ? 'unknown' : parseBatt(batt);
  const powerMode = g === null ? null : parsePowerMode(g);
  const thermal: Thermal = therm === null ? 'unknown' : parseTherm(therm);
  const idleMin = idle === null ? null : parseIdle(idle);
  const freeGB = disk === null ? null : parseFreeGB(disk);
  const windowNow = inWindow(s.window, now);
  const trainNowUntil = trainNowLive(s.trainNowUntil, now);

  const reasons: Array<() => string | null> = [
    () => (s.enabled ? null : 'the school is off'),
    () => (existsSync(paths().stop) ? 'the city is stopped' : null),
    () => (power === 'ac' ? null : power === 'battery' ? 'on battery' : 'could not read the power source'),
    () => (powerMode === null ? 'could not read the power mode' : powerMode === 1 && !s.allowLowPower ? 'in Low Power mode' : null),
    () => (windowNow || trainNowUntil ? null : 'outside the training window'),
    () => (liveWork('local') > 0 ? 'a local job is running' : null),
    () => (localAwardWaiting() ? 'a local job is waiting' : null),
  ];
  if (kind === 'heavy') {
    reasons.push(
      () => {
        if (trainNowUntil) return null;
        if (idleMin === null) return 'could not read the idle time';
        return idleMin >= s.idleMinutes ? null : `the Mac has been idle ${Math.floor(idleMin)} of ${s.idleMinutes} minutes`;
      },
      () => (thermal === 'nominal' ? null : thermal === 'limited' ? 'the Mac is running warm' : 'could not read the thermal state'),
      () => {
        if (freeGB === null) return 'could not read the free disk space';
        return freeGB >= GATE.minFreeGB ? null : `only ${Math.floor(freeGB)} GB free, the school needs ${GATE.minFreeGB}`;
      },
    );
  }
  let reason: string | null = null;
  for (const r of reasons) {
    reason = r();
    if (reason) break;
  }
  return {
    kind,
    ok: reason === null,
    reason,
    power,
    powerMode,
    idleMin: idleMin === null ? null : Math.floor(idleMin),
    inWindow: windowNow,
    trainNowUntil,
    freeGB: freeGB === null ? null : Math.floor(freeGB),
    thermal,
  };
}

/**
 * "Train now": opens the window (and the idle wait) for 3 hours from `now`.
 * Refused unless the Mac is on AC power, read afresh.
 */
export async function startTrainNow(now: number): Promise<{ ok: true; until: string } | { ok: false; reason: string }> {
  cache.delete('batt');
  const power = await readPower();
  if (power !== 'ac') return { ok: false, reason: power === 'battery' ? 'on battery' : 'could not read the power source' };
  const until = new Date(now + GATE.trainNowHours * 3_600_000).toISOString();
  patchSettings({ school: { ...getSettings().school, trainNowUntil: until } });
  return { ok: true, until };
}

/** Ends "Train now": the window and the idle wait apply again. */
export function stopTrainNow(): void {
  patchSettings({ school: { ...getSettings().school, trainNowUntil: null } });
}
