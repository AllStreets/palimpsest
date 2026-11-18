/**
 * GitHub tarballs a repo's npm lockfile pins (a codeload.github.com tarball,
 * or a github.com archive that redirects there), fetched by the engine
 * before a run's install and handed to npm in the run's own cache.
 *
 * A pinned tarball never changes: the lockfile names its sha512 integrity.
 * So the engine fetches it once, checks every byte against that integrity,
 * keeps it under the data home, and clones it into each run's npm cache at
 * the path npm reads by integrity (`_cacache/content-v2/sha512/..`). npm ci
 * then installs it from the cache without opening a connection for it.
 *
 * Why: npm streams a tarball's body with no time limit of its own. Beagle's
 * is 284 MB, and when GitHub sent it at a trickle (about 150 KB/s, while a
 * fresh connection got 30 MB/s) the install sat on that one connection until
 * its 10 minute limit. Here a download that stalls, or runs past its own
 * limit, is dropped and asked for again on a fresh connection, and one that
 * still fails is named, in a few minutes at most, before npm ever runs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { home } from '../home.js';
import type { RunLogLine } from './provider.js';

/** A tarball the lockfile fetches from GitHub, with the sha512 it must hash to. */
export interface PinnedTarball {
  /** The dependency's name as the lockfile gives it. */
  name: string;
  url: string;
  /** The lockfile's integrity, `sha512-<base64>`. */
  integrity: string;
  /** The sha512 as hex: the store's file name and npm's cache path. */
  hex: string;
}

export type TarballFetch = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;

export interface TarballTiming {
  /** A download that sends nothing for this long is dropped. */
  stallMs: number;
  /** A download still sending after this long is dropped. */
  attemptMs: number;
  /** Downloads tried, each on a fresh connection, before the tarball is named as unfetchable. */
  attempts: number;
}

const DEFAULT_TIMING: TarballTiming = { stallMs: 30_000, attemptMs: 4 * 60_000, attempts: 2 };
const defaultFetch: TarballFetch = (url, init) => fetch(url, init);

let fetchImpl: TarballFetch = defaultFetch;
let timing: TarballTiming = { ...DEFAULT_TIMING };

/** Tests stand in a fetch (null restores the real one and the default timing; a fetch alone keeps the timing). */
export function setTarballFetch(f: TarballFetch | null, t?: Partial<TarballTiming>): void {
  if (f === null) timing = { ...DEFAULT_TIMING };
  fetchImpl = f ?? defaultFetch;
  if (t) timing = { ...timing, ...t };
}

/** A kept tarball no lockfile has asked for in this long is deleted. */
const KEEP_MS = 30 * 86_400_000;
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json'];
const MAX_REDIRECTS = 3;

/** Where the engine keeps the tarballs it fetched: `<data home>/tarballs/<sha512 hex>.tgz`. */
export function tarballStore(): string {
  return join(home(), 'tarballs');
}

/** Where npm looks for content with this sha512 in a cache: what `npm_config_cache` names. */
export function cachePathOf(cacheDir: string, hex: string): string {
  return join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** True for a URL the engine may fetch a tarball from: a codeload tarball, or a github.com archive. */
function onGitHub(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'codeload.github.com') return true;
  return host === 'github.com' && /^\/[^/]+\/[^/]+\/(archive|tarball)\//.test(u.pathname);
}

/** The GitHub tarballs pinned with a sha512 in the npm lockfiles at the root of `dir`, without repeats. */
export function pinnedTarballs(dir: string): PinnedTarball[] {
  const out: PinnedTarball[] = [];
  const seen = new Set<string>();
  for (const file of LOCKS) {
    let lock: { packages?: Record<string, Record<string, unknown>> };
    try {
      lock = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
      if (!path || !entry || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') continue;
      if (!onGitHub(entry.resolved)) continue;
      const m = /(?:^|\s)sha512-([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(entry.integrity);
      if (!m) continue;
      const hex = Buffer.from(m[1], 'base64').toString('hex');
      if (hex.length !== 128 || seen.has(hex)) continue;
      seen.add(hex);
      const name = typeof entry.name === 'string' ? entry.name : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ name, url: entry.resolved, integrity: `sha512-${m[1]}`, hex });
    }
  }
  return out;
}

function words(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  const s = Math.round(ms / 100) / 10;
  return `${s} second${s === 1 ? '' : 's'}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function sha512Of(path: string): Promise<string> {
  const h = createHash('sha512');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** One download of `t` into the store, on a fresh connection. Resolves with the bytes it took. */
async function download(t: PinnedTarball, store: string, signal: AbortSignal): Promise<number> {
  const ac = new AbortController();
  let why: string | null = null;
  let bytes = 0;
  const stopWith = (reason: string) => {
    if (why === null) why = reason;
    ac.abort();
  };
  const onRun = () => stopWith('the run ended');
  if (signal.aborted) onRun();
  signal.addEventListener('abort', onRun, { once: true });
  const deadline = setTimeout(() => stopWith(`it was still sending after ${words(timing.attemptMs)} (${mb(bytes)} so far)`), timing.attemptMs);
  let stall = setTimeout(() => stopWith(`it sent nothing for ${words(timing.stallMs)}`), timing.stallMs);
  const tmp = join(store, `.${t.hex.slice(0, 16)}-${randomBytes(6).toString('hex')}.part`);
  let fd: number | null = null;
  try {
    let url = t.url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(url, { signal: ac.signal, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      const next = location ? new URL(location, url).toString() : null;
      if (!next || !onGitHub(next) || hop >= MAX_REDIRECTS) throw new Error(`it redirected to ${next ?? 'nowhere'}, which is not a GitHub tarball`);
      url = next;
    }
    if (!res.ok || !res.body) throw new Error(`it answered ${res.status}`);
    const reader = res.body.getReader();
    ac.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
    const hash = createHash('sha512');
    fd = openSync(tmp, 'w', 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (why !== null) break;
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => stopWith(`it sent nothing for ${words(timing.stallMs)}`), timing.stallMs);
      hash.update(value);
      writeSync(fd, value);
      bytes += value.byteLength;
    }
    closeSync(fd);
    fd = null;
    if (why !== null) throw new Error(why);
    if (hash.digest('hex') !== t.hex) throw new Error(`its ${mb(bytes)} did not match the lockfile's integrity`);
    chmodSync(tmp, 0o444);
    renameSync(tmp, join(store, `${t.hex}.tgz`));
    return bytes;
  } catch (err) {
    if (why !== null) throw new Error(why);
    throw err;
  } finally {
    clearTimeout(deadline);
    clearTimeout(stall);
    signal.removeEventListener('abort', onRun);
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

/** Fills of the store in flight, by sha512: two runs pinning the same tarball wait on one download. */
const inflight = new Map<string, Promise<string | null>>();

/** Makes sure the store holds `t`, checked; resolves with why it could not, or null. */
function ensureKept(t: PinnedTarball, signal: AbortSignal, log: (text: string) => void): Promise<string | null> {
  const running = inflight.get(t.hex);
  if (running) return running;
  const p = (async (): Promise<string | null> => {
    const store = tarballStore();
    mkdirSync(store, { recursive: true });
    const kept = join(store, `${t.hex}.tgz`);
    if (existsSync(kept)) {
      if ((await sha512Of(kept)) === t.hex) {
        log(`${t.name}'s tarball (sha512 ${t.hex.slice(0, 12)}) is already kept by the engine: the install will not fetch it`);
        return null;
      }
      log(`the kept copy of ${t.name}'s tarball no longer matches its integrity; fetching it again`);
      rmSync(kept, { force: true });
    }
    const host = new URL(t.url).hostname;
    let last = 'it was not tried';
    for (let n = 1; n <= timing.attempts; n++) {
      if (signal.aborted) return `${t.name}'s tarball was not fetched: the run ended`;
      const started = Date.now();
      try {
        const bytes = await download(t, store, signal);
        log(`fetched ${t.name}'s tarball from ${host} for the install (${mb(bytes)} in ${words(Math.max(100, Date.now() - started))}), checked against the lockfile's integrity`);
        return null;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        log(`fetching ${t.name}'s tarball from ${host} failed (try ${n} of ${timing.attempts}): ${last}`);
      }
    }
    return `${t.name}'s tarball (${t.url}) could not be fetched: ${last}${timing.attempts > 1 ? ` (tried ${timing.attempts} times, each on a fresh connection)` : ''}`;
  })().finally(() => inflight.delete(t.hex));
  inflight.set(t.hex, p);
  return p;
}

/** Deletes kept tarballs not asked for in KEEP_MS, and partial downloads left by a stopped engine. */
function prune(store: string, keep: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(store);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const full = join(store, name);
    const kept = /^([0-9a-f]{128})\.tgz$/.exec(name);
    const part = /^\.[0-9a-f]{16}-[0-9a-f]{12}\.part$/.test(name);
    if (!kept && !part) continue;
    if (kept && keep.has(kept[1])) continue;
    try {
      const age = now - statSync(full).mtimeMs;
      if (age > (part ? 86_400_000 : KEEP_MS)) rmSync(full, { force: true });
    } catch {
      // gone already
    }
  }
}

/**
 * Before a run's install: every GitHub tarball the lockfiles in `dir` pin is
 * kept by the engine (fetched now if it is not) and cloned into `cacheDir`
 * (the run's `npm_config_cache`). Resolves with why one could not be had,
 * or null. A lockfile with no such pin asks for nothing.
 */
export async function seedTarballs(o: { dir: string; cacheDir: string; signal: AbortSignal; log: (l: RunLogLine) => void }): Promise<{ failed: string | null }> {
  const pinned = pinnedTarballs(o.dir);
  if (!pinned.length) return { failed: null };
  const say = (text: string) => o.log({ at: new Date().toISOString(), kind: 'engine', text: `[palimpsest] ${text}` });
  for (const t of pinned) {
    const failed = await ensureKept(t, o.signal, say);
    if (failed) return { failed };
    const kept = join(tarballStore(), `${t.hex}.tgz`);
    const now = new Date();
    utimesSync(kept, now, now);
    // A clone, never a link: what the run does to its copy never reaches the engine's.
    const dest = cachePathOf(o.cacheDir, t.hex);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    copyFileSync(kept, dest, constants.COPYFILE_FICLONE);
    chmodSync(dest, 0o644);
  }
  prune(tarballStore(), new Set(pinned.map((t) => t.hex)));
  return { failed: null };
}

