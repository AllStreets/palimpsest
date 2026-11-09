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

/** An event from GET /api/events: `repo.analyzing`, `repo.analyzed`, `repo.error` and later kinds. */
export interface EngineEvent {
  type: string;
  data: unknown;
}

const EVENT_TYPES = ['repo.analyzing', 'repo.analyzed', 'repo.error'];

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-palimpsest'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; kind?: string };
    throw new ApiError(res.status, err.error ?? `${method} ${path} failed with ${res.status}`, err.kind ?? null);
  }
  return data as T;
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
