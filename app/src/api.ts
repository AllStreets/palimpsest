import type { District, Repo, Settings, UsageReading } from '../../shared/types';

/** A failed engine call: the HTTP status plus the engine's readable message. */
export class ApiError extends Error {
  status: number;
  kind: string | null;

  constructor(status: number, message: string, kind: string | null) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export type AvailableRepo = Pick<Repo, 'fullName' | 'private' | 'description' | 'language' | 'defaultBranch'>;

export interface Health {
  ok: boolean;
  version: string;
  stopped: boolean;
}

export interface UsageState {
  reading: UsageReading | null;
  stale: boolean;
  hookInstalled: boolean;
}

/** An event from GET /api/events: a repo's connect, analysis steps, result, patch or disconnect, or the kill switch. */
export interface EngineEvent {
  type: string;
  data: unknown;
}

const EVENT_TYPES = [
  'repo.connected',
  'repo.analyzing',
  'repo.analyzed',
  'repo.error',
  'repo.patched',
  'repo.disconnected',
  'engine.stopped',
  'engine.resumed',
];

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-palimpsest'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    // Error bodies are usually JSON from the engine, but a proxy or crash can send plain text.
    let err: { error?: string; kind?: string } = {};
    try {
      err = (text ? JSON.parse(text) : {}) as typeof err;
    } catch {
      err = { error: text.trim() || undefined };
    }
    throw new ApiError(res.status, err.error ?? `${method} ${path} failed with ${res.status}`, err.kind ?? null);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function repoPath(fullName: string, action?: string): string {
  const [owner, name] = fullName.split('/');
  const base = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return action ? `${base}/${action}` : base;
}

/** Client for the engine's routes. Every write sends `x-palimpsest: 1`. */
export const api = {
  health: () => request<Health>('GET', '/api/health'),
  available: () => request<AvailableRepo[]>('GET', '/api/repos/available'),
  repos: () => request<Repo[]>('GET', '/api/repos'),
  city: () => request<District[]>('GET', '/api/city'),
  usage: () => request<UsageState>('GET', '/api/usage'),
  installHook: () => request<{ hookInstalled: boolean }>('POST', '/api/usage/hook/install'),
  uninstallHook: () => request<{ hookInstalled: boolean }>('POST', '/api/usage/hook/uninstall'),
  /** The kill switch: creates (on) or removes (off) the engine's stop file. */
  stop: (on: boolean) => request<{ stopped: boolean }>('POST', '/api/stop', { on }),
  settings: () => request<Settings>('GET', '/api/settings'),
  patchSettings: (patch: Partial<Pick<Settings, 'quality' | 'dayCapPct' | 'nightCapPct'>>) =>
    request<Settings>('PATCH', '/api/settings', patch),
  connect: (fullName: string) => request<Repo>('POST', repoPath(fullName, 'connect')),
  disconnect: (fullName: string) => request<{ ok: boolean }>('POST', repoPath(fullName, 'disconnect')),
  analyze: (fullName: string) => request<{ ok: boolean }>('POST', repoPath(fullName, 'analyze')),
  patchRepo: (fullName: string, patch: Partial<Pick<Repo, 'pushMode' | 'root'>>) =>
    request<Repo>('PATCH', repoPath(fullName), patch),

  /** Subscribes to the engine's event stream. Returns a function that closes it. */
  events(onEvent: (e: EngineEvent) => void): () => void {
    const source = new EventSource('/api/events');
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (msg) => {
        onEvent({ type, data: JSON.parse((msg as MessageEvent<string>).data) as unknown });
      });
    }
    return () => source.close();
  },
};
