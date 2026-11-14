/**
 * Beagle as a library (Phase 4 ruling 1, Task 4). The only module that
 * imports Beagle: by `import()` of a non-literal specifier, so `tsc` never
 * reads Beagle's TypeScript sources, typed through `beagle-api.ts`.
 *
 * `loadBeagle()` points `BEAGLE_HOME` at `paths().school/beagle`, refuses a
 * home that resolves outside the school (Beagle's own home above all), and
 * installs the city's driver, so no model call Beagle makes ever reaches
 * Beagle's own Claude or Ollama code.
 *
 * `schoolDriver()` is that driver: every call Beagle makes takes a school
 * lease (the caps, his own Claude use, the school's daily Claude allowance,
 * the hard stop and the night cap), runs through the city's own backend
 * (`providerFor(model).complete()`), and is charged `school` to the city
 * (never a firm) under the voyage, `unattended` as of the call's start. A
 * refused lease is Beagle's `LimitError`, so Beagle backs off and then ends
 * the race "Claude usage limit"; the driver's signal aborts the call.
 */
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { ModelRef } from '../../shared/types.js';
import { canonical, paths } from '../home.js';
import { chargesItself } from '../market/anthropic-api.js';
import { acquire, charge, unattended } from '../market/budget.js';
import { spentOn, type CompleteResult } from '../market/provider.js';
import { providerFor } from '../market/providers.js';
import { getSettings } from '../settings.js';
import { BEAGLE_ENTRIES, type BeagleApi, type BeagleDriver } from './beagle-api.js';

/** Credits a school call holds against the caps until its real usage is charged. */
export const SCHOOL_CALL_ESTIMATE = 3;
/** How long a school call waits in the school's queue for a slot before Beagle is told to back off. */
export const SCHOOL_WAIT_MS = 10 * 60_000;
/** A call's time limit when Beagle names none (each backend caps it again at its own limit). */
export const SCHOOL_CALL_MAX_MS = 5 * 60_000;

let loaded: BeagleApi | null = null;
let loading: Promise<BeagleApi> | null = null;
/** The driver of the voyage sailing now (`useDriver`), which a later `loadBeagle()` keeps in place. */
let voyageDriver: BeagleDriver | null = null;

/** Beagle's own default home, which the school never uses. */
function beaglesRealHome(): string {
  return join(homedir(), 'Library', 'Application Support', 'Beagle');
}

/** Refuses a Beagle home that is, or resolves to, Beagle's real home, or that lies outside the school. */
function refuseHome(dir: string, school: string): void {
  const at = canonical(dir);
  const real = canonical(beaglesRealHome());
  if (at === real || at.startsWith(real + sep)) {
    throw new Error(`refused: Beagle's home ${dir} resolves to Beagle's real home (${beaglesRealHome()}), never the school's`);
  }
  if (!at.startsWith(canonical(school) + sep)) {
    throw new Error(`refused: Beagle's home ${dir} resolves outside the school (${school})`);
  }
}

async function importBeagle(): Promise<BeagleApi> {
  const mods = await Promise.all(
    BEAGLE_ENTRIES.map((entry) => {
      // A specifier tsc cannot follow, so it never type checks Beagle's sources (ruling 1).
      const spec = 'beagle/' + entry;
      return import(spec) as Promise<unknown>;
    }),
  );
  return Object.fromEntries(BEAGLE_ENTRIES.map((entry, i) => [entry, mods[i]])) as unknown as BeagleApi;
}

/** Where Beagle itself says its home is now: its `paths.ts` beside its store, read without opening anything. */
async function beaglesHomeNow(): Promise<string> {
  const store = import.meta.resolve('beagle/store');
  const mod = (await import(new URL('./paths.ts', store).href)) as { home: () => string };
  return mod.home();
}

/** The driver `loadBeagle()` installs: no voyage, the designer setting read on each call, no stop of its own. */
const NEVER = new AbortController().signal;
const cityDriver: BeagleDriver = (provider, name, turns, o) =>
  schoolDriver({ voyageId: null, designer: getSettings().school.designer, signal: NEVER })(provider, name, turns, o);

/**
 * Loads Beagle with its home in the school and the city's driver installed.
 * Refuses, before Beagle opens anything, a home that resolves outside
 * `paths().school` or to Beagle's real home, and checks again that Beagle's
 * own `home()` answers the school's folder.
 */
export async function loadBeagle(): Promise<BeagleApi> {
  const school = paths().school;
  const dir = join(school, 'beagle');
  refuseHome(dir, school);
  process.env.BEAGLE_HOME = dir;
  if (!loaded) {
    loading ??= importBeagle().finally(() => {
      loading = null;
    });
    loaded = await loading;
  }
  refuseHome(await beaglesHomeNow(), school);
  loaded.models.setDriver(voyageDriver ?? cityDriver);
  return loaded;
}

/**
 * Installs a voyage's own driver (its voyage, its signal) until it is
 * called again with null, which puts the city's driver back. Unlike
 * `setDriver`, it holds across `loadBeagle()`: an arena build loading
 * Beagle while a voyage sails never takes the voyage's calls off its
 * voyage or its stop.
 */
export function useDriver(d: BeagleDriver | null): void {
  voyageDriver = d;
  loaded?.models.setDriver(d ?? cityDriver);
}

/** Closes Beagle's store (its home may change before the next load). The city's driver stays installed. */
export function closeBeagle(): void {
  loaded?.store.close();
}

/** Resolves with `p`, or rejects as soon as `stop` fires; a value that comes after the stop is handed to `late`. */
function unlessStopped<T>(p: Promise<T>, stop: AbortSignal, late: (v: T) => void): Promise<T> {
  if (stop.aborted) {
    void p.then(late, () => {});
    return Promise.reject(stop.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onStop = () => {
      if (done) return;
      done = true;
      reject(stop.reason);
    };
    stop.addEventListener('abort', onStop, { once: true });
    p.then(
      (v) => {
        stop.removeEventListener('abort', onStop);
        if (done) late(v);
        else {
          done = true;
          resolve(v);
        }
      },
      (e) => {
        stop.removeEventListener('abort', onStop);
        if (!done) {
          done = true;
          reject(e);
        }
      },
    );
  });
}

/** The error a stopped call throws: the signal's own reason, or an AbortError. */
function stopError(s: AbortSignal): Error {
  return s.reason instanceof Error ? s.reason : new DOMException('The school stopped this call.', 'AbortError');
}

/**
 * The driver for one voyage (or graduation): Beagle's designer model becomes
 * `o.designer`; every call leases `acquire(model, 'school', estimate, { waitUntil:
 * now + 10 min })`, runs `providerFor(model).complete()` under the voyage as
 * `runId`, and is charged `school`, `firmId: null`, `unattended: unattended(now)`
 * at its start (the Anthropic API charges itself the same way). A call that
 * fails part way is charged what it spent. A refused lease, or a lease the
 * city stopped mid-call (the hard stop), throws Beagle's `LimitError`; `o.signal`
 * or Beagle's own signal aborts the call.
 */
export function schoolDriver(o: { voyageId: string | null; designer: ModelRef; signal: AbortSignal; now?: () => number }): BeagleDriver {
  const clock = o.now ?? Date.now;
  return async (provider, name, turns, call) => {
    const beagle = loaded;
    if (!beagle) throw new Error('Beagle is not loaded');
    const asked = `${provider}:${name}`;
    const model = (asked === beagle.designer.DESIGNER ? o.designer : asked) as ModelRef;
    const stop = call.signal ? AbortSignal.any([o.signal, call.signal]) : o.signal;
    if (stop.aborted) throw stopError(stop);

    const at = clock();
    const night = unattended(at);
    const got = await unlessStopped(acquire(model, 'school', SCHOOL_CALL_ESTIMATE, { now: at, waitUntil: at + SCHOOL_WAIT_MS }), stop, (late) => {
      if (late.ok) late.lease.release();
    }).catch((e: unknown) => {
      throw stop.aborted ? stopError(stop) : e;
    });
    if (!got.ok) throw new beagle.models.LimitError(got.reason.detail);

    const lease = got.lease;
    const signal = AbortSignal.any([stop, lease.signal]);
    const started = Date.now();
    let selfCharged = false;
    const chargeSchool = (usage: CompleteResult['usage']) => {
      if (!selfCharged) charge({ runId: o.voyageId, firmId: null, model, kind: 'school', usage, unattended: night, lease, at: clock() });
    };
    try {
      const backend = providerFor(model);
      selfCharged = backend.kind === 'anthropic' && chargesItself;
      const system = turns.filter((t) => t.role === 'system').map((t) => t.content).join('\n\n');
      const rest = turns.filter((t): t is { role: 'user' | 'assistant'; content: string } => t.role !== 'system');
      const r = await backend.complete({ model, system, turns: rest, schema: call.schema ?? null, signal, maxMs: call.timeoutMs ?? SCHOOL_CALL_MAX_MS, runId: o.voyageId });
      chargeSchool(r.usage);
      // Beagle reads a shaped answer from the text: the backend's parsed JSON when it has one.
      const text = call.schema && r.json !== null && r.json !== undefined ? JSON.stringify(r.json) : r.text;
      return { text, usd: r.usage.usd, ms: Date.now() - started };
    } catch (err) {
      const spent = spentOn(err);
      if (spent) chargeSchool(spent);
      if (stop.aborted) throw stopError(stop);
      if (lease.signal.aborted) {
        const why = lease.signal.reason instanceof Error ? lease.signal.reason.message : 'the city stopped the call';
        throw new beagle.models.LimitError(`The city stopped this call (${why}).`);
      }
      throw err;
    } finally {
      lease.release();
    }
  };
}
