import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Repo, RepoChecks, RootStyle, Settings } from '../shared/types.js';
import type { Event } from './events.js';
import { emit, subscribe } from './events.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { pushModeRefusal as pushChecksRefusal } from '../shared/market-rules.js';
import { handleMarketApi, scrub, setMarketExtras } from './market/api.js';
import { fakeProvider } from './market/fake-provider.js';
import { setProvider } from './market/providers.js';
import { economyClock, economySites, economyTrips, sampleOllamaUsage } from './market/sample-economy.js';
import { noteSseClients } from './market/budget.js';
import { resumeRepo, updateKeepAwake } from './market/runs.js';
import { availableRepos, GhError } from './github.js';
import { paths } from './home.js';
import { record } from './ledger.js';
import { analyze, BAD_NAME, city, connect, disconnect, getRepo, isValidFullName, LABEL, listRepos, patchRepo, type RepoPatch } from './repos.js';
import { getSettings, patchSettings } from './settings.js';
import { realRunner, getRunner, setRunner, getSpawner, realSpawner, setSpawner } from './exec.js';
import { isSampleHome, sampleGh, sampleSpawner, useSampleFolders } from './sample.js';
import { claudeSettingsTarget, installHook, isStale, latestReading, NO_CLAUDE_SETTINGS, uninstallHook } from './usage.js';

const engineDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(engineDir, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

const ROOT_STYLES: RootStyle[] = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const HEARTBEAT_MS = 15_000;

/** The Vite dev server's port: its page calls the engine through the dev proxy. */
const DEV_PORT = 4771;

/**
 * True when the request was addressed to this engine by its own name and,
 * when a page sent it, came from the engine's own page or the dev server's.
 * A page on any other site, even one whose DNS name has been rebound to
 * 127.0.0.1, names its own host and origin and is refused, so it can neither
 * read the engine's answers nor make it act.
 */
function fromOwnPage(req: IncomingMessage, port: number): boolean {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.host?.toLowerCase();
  if (!host || !own.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const allowed = [...own, `127.0.0.1:${DEV_PORT}`, `localhost:${DEV_PORT}`].map((h) => `http://${h}`);
  return allowed.includes(origin.toLowerCase());
}

/** The engine's usual port. */
export const DEFAULT_PORT = 4770;

/**
 * The port to listen on: PALIMPSEST_PORT when set (so a second engine, such
 * as one serving the sample city, can run beside the installed one), else
 * 4770. A value that is not a whole port number is an error, never a
 * silent fall back.
 */
export function enginePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PALIMPSEST_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > 65535) {
    throw new Error(`PALIMPSEST_PORT must be a port number from 1 to 65535, got "${raw}"`);
  }
  return n;
}

export interface StartServerOptions {
  port?: number;
  /** The Claude settings file the hook routes change. Without it, see claudeSettingsTarget(). */
  claudeSettingsPath?: string;
  /** The keychain file the Anthropic key routes use. Without it, his login keychain (refused under tests). */
  keychain?: string;
}

export interface StartedServer {
  close(): Promise<void>;
  port: number;
}

function readableMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isValidCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;
}

/** A whole number from `lo` to `hi`. */
function intIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

const OLLAMA_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;

/** Validates a PATCH /api/settings body, returning the partial patch or null when any present field is invalid. */
function validateSettingsPatch(body: unknown, current: Settings): Partial<Settings> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const patch: Partial<Settings> = {};
  const allowed = new Set(['quality', 'dayCapPct', 'nightCapPct', 'claudeConcurrency', 'localConcurrency', 'bidWindowSec', 'hardStopPct', 'keepAwake', 'ollamaHost', 'anthropicApi']);
  if (Object.keys(b).some((k) => !allowed.has(k))) return null;

  if ('quality' in b) {
    if (b.quality !== 'high' && b.quality !== 'medium') return null;
    patch.quality = b.quality;
  }
  if ('dayCapPct' in b) {
    if (!isValidCap(b.dayCapPct)) return null;
    patch.dayCapPct = b.dayCapPct;
  }
  if ('nightCapPct' in b) {
    if (!isValidCap(b.nightCapPct)) return null;
    patch.nightCapPct = b.nightCapPct;
  }
  if ('claudeConcurrency' in b) {
    if (!intIn(b.claudeConcurrency, 1, 4)) return null;
    patch.claudeConcurrency = b.claudeConcurrency;
  }
  if ('localConcurrency' in b) {
    if (!intIn(b.localConcurrency, 1, 4)) return null;
    patch.localConcurrency = b.localConcurrency;
  }
  if ('bidWindowSec' in b) {
    if (!intIn(b.bidWindowSec, 30, 600)) return null;
    patch.bidWindowSec = b.bidWindowSec;
  }
  if ('hardStopPct' in b) {
    if (!intIn(b.hardStopPct, 50, 95)) return null;
    patch.hardStopPct = b.hardStopPct;
  }
  if ('keepAwake' in b) {
    if (typeof b.keepAwake !== 'boolean') return null;
    patch.keepAwake = b.keepAwake;
  }
  if ('ollamaHost' in b) {
    const m = typeof b.ollamaHost === 'string' ? OLLAMA_HOST.exec(b.ollamaHost) : null;
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return null;
    patch.ollamaHost = b.ollamaHost as string;
  }
  if ('anthropicApi' in b) {
    const a = b.anthropicApi;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return null;
    const o = a as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'enabled' && k !== 'dailyUsd')) return null;
    const next = { ...current.anthropicApi };
    if ('enabled' in o) {
      if (typeof o.enabled !== 'boolean') return null;
      next.enabled = o.enabled;
    }
    if ('dailyUsd' in o) {
      if (typeof o.dailyUsd !== 'number' || !Number.isFinite(o.dailyUsd) || o.dailyUsd < 0 || o.dailyUsd > 100) return null;
      next.dailyUsd = o.dailyUsd;
    }
    patch.anthropicApi = next;
  }
  return patch;
}

const CHECK_COMMANDS = ['test', 'typecheck', 'lint', 'build', 'screenshot', 'install'] as const;
const PREVIEW_KINDS = ['vite', 'next', 'astro', 'static'];
const ECOSYSTEMS = ['npm', 'python', 'rust', 'go'];
const COMMAND_TEXT = /^[^\x00-\x1f\x7f]{1,500}$/;

/** A relative folder that stays inside the repo. */
function isOutDir(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 100 && /^[A-Za-z0-9_./-]+$/.test(v) && !v.startsWith('/') && !v.split('/').includes('..');
}

/** Validates the `checks` part of a repo patch, or null when anything in it is not allowed. */
function validateChecksPatch(v: unknown): Partial<RepoChecks> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const known = new Set<string>([...CHECK_COMMANDS, 'preview', 'shots', 'ecosystems']);
  if (Object.keys(c).some((k) => !known.has(k))) return null;
  const out: Partial<RepoChecks> = {};
  for (const k of CHECK_COMMANDS) {
    if (!(k in c)) continue;
    const x = c[k];
    if (x === null) out[k] = null;
    else if (typeof x === 'string' && COMMAND_TEXT.test(x.trim())) out[k] = x.trim();
    else return null;
  }
  if ('preview' in c) {
    const p = c.preview as Record<string, unknown> | null;
    if (p === null) out.preview = null;
    else if (typeof p === 'object' && !Array.isArray(p) && PREVIEW_KINDS.includes(p.kind as string) && isOutDir(p.outDir)) out.preview = { kind: p.kind as 'vite' | 'next' | 'astro' | 'static', outDir: p.outDir };
    else return null;
  }
  if ('shots' in c) {
    const s = c.shots;
    if (!Array.isArray(s) || s.length > 20 || s.some((r) => typeof r !== 'string' || !/^\/[^\x00-\x1f\x7f\s]{0,199}$/.test(r))) return null;
    out.shots = s as string[];
  }
  if ('ecosystems' in c) {
    const e = c.ecosystems;
    if (!Array.isArray(e) || e.length > 4 || e.some((x) => !ECOSYSTEMS.includes(x as string))) return null;
    out.ecosystems = e as RepoChecks['ecosystems'];
  }
  return out;
}

/** Validates a PATCH /api/repos/:owner/:name body, returning the partial patch or null when any present field is invalid. */
function validateRepoPatch(body: unknown): RepoPatch | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const patch: RepoPatch = {};
  if (Object.keys(b).some((k) => !['pushMode', 'root', 'market', 'label', 'checks'].includes(k))) return null;

  if ('pushMode' in b) {
    if (typeof b.pushMode !== 'boolean') return null;
    patch.pushMode = b.pushMode;
  }
  if ('root' in b) {
    if (typeof b.root !== 'string' || !ROOT_STYLES.includes(b.root as RootStyle)) return null;
    patch.root = b.root as RootStyle;
  }
  if ('market' in b) {
    if (typeof b.market !== 'boolean') return null;
    patch.market = b.market;
  }
  if ('label' in b) {
    if (typeof b.label !== 'string' || !LABEL.test(b.label)) return null;
    patch.label = b.label;
  }
  if ('checks' in b) {
    const c = validateChecksPatch(b.checks);
    if (c === null) return null;
    patch.checks = c;
  }
  return patch;
}

/**
 * Push mode needs both a test and a build command (ruling 23): the page hides
 * the switch, and the engine refuses it too, whether the patch turns push mode
 * on or takes a command away from a repo that has it on.
 */
function pushModeRefusal(repo: Repo, patch: RepoPatch): string | null {
  if (!('pushMode' in patch) && !patch.checks) return null;
  const pushAfter = patch.pushMode ?? repo.pushMode;
  if (!pushAfter) return null;
  const after = { test: null, build: null, ...repo.checks, ...patch.checks };
  return pushChecksRefusal(after);
}

/** The Claude settings file the hook routes may change: the one given, else claudeSettingsTarget(), else a 409. */
function hookTarget(given: string | undefined): string {
  const target = given ?? claudeSettingsTarget();
  if (target === null) throw new HttpError(409, { error: NO_CLAUDE_SETTINGS });
  return target;
}

function repoExists(fullName: string): boolean {
  return listRepos().some((r) => r.fullName === fullName);
}

/**
 * The kill switch: creates or removes the stop file. A change is recorded in
 * the ledger (`engine.stopped` / `engine.resumed`) and emitted; setting the
 * state it is already in changes nothing. Returns whether the engine is now stopped.
 */
function setStopped(on: boolean): boolean {
  const stop = paths().stop;
  const was = existsSync(stop);
  if (on === was) return on;
  if (on) writeFileSync(stop, `Stopped from Settings at ${new Date().toISOString()}\n`);
  else rmSync(stop, { force: true });
  const kind = on ? 'engine.stopped' : 'engine.resumed';
  record(kind, {});
  emit(kind, { stopped: on });
  return on;
}

/** Sends one SSE event frame. */
function writeSseEvent(res: ServerResponse, e: Event): void {
  res.write(`event: ${e.type}\ndata: ${JSON.stringify(scrub(e.data))}\n\n`);
}

function handleSse(req: IncomingMessage, res: ServerResponse, sseClients: Set<ServerResponse>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = subscribe((e) => writeSseEvent(res, e));
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  sseClients.add(res);
  noteSseClients(sseClients.size);

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    sseClients.delete(res);
    noteSseClients(sseClients.size);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * Dispatches one /api/* request. Every handler either returns normally
 * (having written the response) or throws: GhError becomes 502, HttpError
 * becomes its own status, anything else becomes 500.
 */
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  claudeSettingsPath: string | undefined,
  sseClients: Set<ServerResponse>,
  search: URLSearchParams,
  keychain: string | undefined,
): Promise<void> {
  try {
    if (await handleMarketApi(req, res, pathname, method, search, { keychain })) return;

    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, version: VERSION, stopped: existsSync(paths().stop) });
      return;
    }

    if (pathname === '/api/stop' && method === 'POST') {
      const body = await readJsonBody(req);
      const on = (body as { on?: unknown } | null)?.on;
      if (typeof on !== 'boolean') throw new HttpError(400, { error: 'expected { on: boolean }' });
      sendJson(res, 200, { stopped: setStopped(on) });
      return;
    }

    if (pathname === '/api/repos/available' && method === 'GET') {
      sendJson(res, 200, await availableRepos());
      return;
    }

    if (pathname === '/api/repos' && method === 'GET') {
      sendJson(res, 200, listRepos());
      return;
    }

    if (pathname === '/api/city' && method === 'GET') {
      sendJson(res, 200, city());
      return;
    }

    if (pathname === '/api/usage' && method === 'GET') {
      const reading = latestReading();
      sendJson(res, 200, {
        reading,
        stale: reading ? isStale(reading) : false,
        hookInstalled: getSettings().hookInstalled,
      });
      return;
    }

    if (pathname === '/api/usage/hook/install' && method === 'POST') {
      installHook(hookTarget(claudeSettingsPath));
      sendJson(res, 200, { hookInstalled: true });
      return;
    }

    if (pathname === '/api/usage/hook/uninstall' && method === 'POST') {
      uninstallHook(hookTarget(claudeSettingsPath));
      sendJson(res, 200, { hookInstalled: false });
      return;
    }

    if (pathname === '/api/settings' && method === 'GET') {
      sendJson(res, 200, getSettings());
      return;
    }

    if (pathname === '/api/settings' && method === 'PATCH') {
      const body = await readJsonBody(req);
      const patch = validateSettingsPatch(body, getSettings());
      if (patch === null) {
        throw new HttpError(400, { error: 'invalid settings patch' });
      }
      const next = patchSettings(patch);
      if ('keepAwake' in patch) updateKeepAwake();
      sendJson(res, 200, next);
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      handleSse(req, res, sseClients);
      return;
    }

    const repoMatch = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+?)(?:\/(connect|disconnect|analyze|resume))?$/);
    if (repoMatch) {
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const action = repoMatch[3];
      if (!isValidFullName(fullName)) throw new HttpError(400, { error: BAD_NAME });

      if (action === 'connect' && method === 'POST') {
        sendJson(res, 200, await connect(fullName));
        return;
      }

      if (action === 'disconnect' && method === 'POST') {
        if (!repoExists(fullName)) throw new HttpError(404, { error: 'unknown repo' });
        disconnect(fullName);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === 'resume' && method === 'POST') {
        if (!repoExists(fullName)) throw new HttpError(404, { error: 'unknown repo' });
        if (!getRepo(fullName)?.halted) throw new HttpError(409, { error: 'the repo is not halted' });
        sendJson(res, 200, resumeRepo(fullName));
        return;
      }

      if (action === 'analyze' && method === 'POST') {
        if (!repoExists(fullName)) throw new HttpError(404, { error: 'unknown repo' });
        void analyze(fullName).catch((err) => {
          console.error(`analyze(${fullName}) rejected unexpectedly:`, err);
        });
        sendJson(res, 202, { ok: true });
        return;
      }

      if (!action && method === 'PATCH') {
        if (!repoExists(fullName)) throw new HttpError(404, { error: 'unknown repo' });
        const body = await readJsonBody(req);
        const patch = validateRepoPatch(body);
        if (patch === null) {
          throw new HttpError(400, { error: 'invalid repo patch' });
        }
        const refusal = pushModeRefusal(getRepo(fullName) as Repo, patch);
        if (refusal) throw new HttpError(409, { error: refusal });
        sendJson(res, 200, patchRepo(fullName, patch));
        return;
      }
    }

    throw new HttpError(404, { error: 'not found' });
  } catch (err) {
    if (err instanceof GhError) {
      sendJson(res, 502, { error: err.message, kind: err.kind });
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, err.body);
      return;
    }
    sendJson(res, 500, { error: readableMessage(err) });
  }
}

/** Serves `paths().dist` statically, rejecting any path that would resolve outside it, with an index.html SPA fallback. */
function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const dist = paths().dist;
  if (!existsSync(dist)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('UI not built: run npm run build');
    return;
  }

  const distResolved = resolve(dist);
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const requested = resolve(distResolved, relPath);
  const withinDist = requested === distResolved || requested.startsWith(distResolved + sep);

  let filePath: string | null = null;
  if (withinDist && existsSync(requested) && statSync(requested).isFile()) {
    filePath = requested;
  }

  if (!filePath) {
    const indexPath = join(distResolved, 'index.html');
    filePath = existsSync(indexPath) ? indexPath : null;
  }

  if (!filePath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/** How fast the sample economy's clock runs: script seconds per wall second. */
function sampleSpeed(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PALIMPSEST_SAMPLE_SPEED ?? 20);
  return Number.isFinite(n) && n > 0 && n <= 600 ? n : 20;
}

/**
 * An engine on a sample home (tools/sample.ts) reaches nothing real: gh,
 * git and `ollama list` go to the sample stand-in, no child process starts,
 * every model backend is the scripted fake provider, the budget and Settings
 * read the sample home's own folders, and the live view carries the sample
 * economy's sites and trips. With PALIMPSEST_SAMPLE_ECONOMY=live the
 * economy's clock ticks once a second. A test that installed its own runner
 * or spawner keeps it. Returns what undoes the clock.
 */
function enterSampleMode(): () => void {
  if (getRunner() === realRunner) setRunner(sampleGh());
  if (getSpawner() === realSpawner) setSpawner(sampleSpawner);
  useSampleFolders();
  const fake = fakeProvider();
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, fake);
  setMarketExtras({ sites: economySites, trips: economyTrips, providers: { ollama: () => sampleOllamaUsage() } });
  if (process.env.PALIMPSEST_SAMPLE_ECONOMY !== 'live') return () => setMarketExtras({});
  const clock = economyClock({ now: () => Date.now(), speed: sampleSpeed() });
  const timer = setInterval(() => clock.tick(1000), 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
    clock.stop();
    setMarketExtras({});
  };
}

/**
 * Starts the engine's HTTP/SSE server on 127.0.0.1. Without
 * `claudeSettingsPath` the hook routes use claudeSettingsTarget(): the real
 * `~/.claude/settings.json` only for an engine on the default data home, and
 * a 409 on any other home unless PALIMPSEST_CLAUDE_SETTINGS names a file.
 * Tests pass a temp path. An engine on a sample home (tools/sample.ts)
 * reaches nothing real (enterSampleMode).
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const requestedPort = opts.port ?? enginePort();
  const claudeSettingsPath = opts.claudeSettingsPath;
  const stopSample = isSampleHome() ? enterSampleMode() : () => {};
  const sseClients = new Set<ServerResponse>();

  let listeningPort = requestedPort;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!fromOwnPage(req, listeningPort)) {
          sendJson(res, 403, { error: 'This engine only answers its own page on 127.0.0.1 or localhost.' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = decodeURIComponent(url.pathname);
        const method = req.method ?? 'GET';

        if (pathname.startsWith('/api/')) {
          if (method !== 'GET' && method !== 'HEAD' && req.headers['x-palimpsest'] !== '1') {
            sendJson(res, 403, { error: 'missing x-palimpsest header' });
            return;
          }
          await handleApi(req, res, pathname, method, claudeSettingsPath, sseClients, url.searchParams, opts.keychain);
          return;
        }

        serveStatic(req, res, pathname);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: readableMessage(err) });
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, '127.0.0.1', () => resolveListen());
  });

  const actualPort = (server.address() as AddressInfo).port;
  listeningPort = actualPort;

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const client of sseClients) {
          client.end();
        }
        sseClients.clear();
        noteSseClients(0);
        stopSample();
        server.close(() => resolveClose());
      }),
  };
}
