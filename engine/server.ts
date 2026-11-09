import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Repo, RootStyle, Settings } from '../shared/types.js';
import type { Event } from './events.js';
import { emit, subscribe } from './events.js';
import { availableRepos, GhError } from './github.js';
import { paths } from './home.js';
import { record } from './ledger.js';
import { analyze, BAD_NAME, city, connect, disconnect, isValidFullName, listRepos, patchRepo } from './repos.js';
import { getSettings, patchSettings } from './settings.js';
import { realRunner, getRunner, setRunner } from './exec.js';
import { isSampleHome, sampleGh } from './sample.js';
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
}

export interface StartedServer {
  close(): Promise<void>;
  port: number;
}

/** A gh/other failure classified as not-found or a validation failure: maps to a specific HTTP status, not 500. */
class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : String(body));
    this.status = status;
    this.body = body;
  }
}

function readableMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads and parses a JSON request body; an empty body parses as `{}`. Throws HttpError(400) on malformed JSON. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, { error: 'invalid JSON body' });
  }
}

function isValidCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;
}

/** Validates a PATCH /api/settings body, returning the partial patch or null when any present field is invalid. */
function validateSettingsPatch(body: unknown): Partial<Settings> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const patch: Partial<Settings> = {};

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
  return patch;
}

/** Validates a PATCH /api/repos/:owner/:name body, returning the partial patch or null when any present field is invalid. */
function validateRepoPatch(body: unknown): Partial<Pick<Repo, 'pushMode' | 'root'>> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const patch: Partial<Pick<Repo, 'pushMode' | 'root'>> = {};

  if ('pushMode' in b) {
    if (typeof b.pushMode !== 'boolean') return null;
    patch.pushMode = b.pushMode;
  }
  if ('root' in b) {
    if (typeof b.root !== 'string' || !ROOT_STYLES.includes(b.root as RootStyle)) return null;
    patch.root = b.root as RootStyle;
  }
  return patch;
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
  res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
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

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    sseClients.delete(res);
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
): Promise<void> {
  try {
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
      const patch = validateSettingsPatch(body);
      if (patch === null) {
        throw new HttpError(400, { error: 'invalid settings patch' });
      }
      sendJson(res, 200, patchSettings(patch));
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      handleSse(req, res, sseClients);
      return;
    }

    const repoMatch = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+?)(?:\/(connect|disconnect|analyze))?$/);
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

/**
 * Starts the engine's HTTP/SSE server on 127.0.0.1. Without
 * `claudeSettingsPath` the hook routes use claudeSettingsTarget(): the real
 * `~/.claude/settings.json` only for an engine on the default data home, and
 * a 409 on any other home unless PALIMPSEST_CLAUDE_SETTINGS names a file.
 * Tests pass a temp path. An engine on a sample home (tools/sample.ts)
 * answers gh and git from the sample stand-in unless a test installed its own.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const requestedPort = opts.port ?? enginePort();
  const claudeSettingsPath = opts.claudeSettingsPath;
  if (isSampleHome() && getRunner() === realRunner) setRunner(sampleGh());
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
          await handleApi(req, res, pathname, method, claudeSettingsPath, sseClients);
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
        server.close(() => resolveClose());
      }),
  };
}
