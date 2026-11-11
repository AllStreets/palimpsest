import type {
  AgentDetail,
  CreditEntries,
  District,
  FirmDetail,
  FirmView,
  InspectionView,
  Job,
  JobDetail,
  JobStatus,
  LiveView,
  ManualJobBody,
  ProviderUsage,
  Quarter,
  Repo,
  RepoChecks,
  ReportView,
  RunDetail,
  RunLogLine,
  Settings,
  Tier,
  TreasuryView,
  UsageReading,
} from '../../shared/types.js';

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

/**
 * An event from GET /api/events: a repo's connect, analysis steps, result,
 * patch or disconnect, or the kill switch. One more comes from the client
 * itself: `engine.reconnected`, when the stream comes back after dropping,
 * since anything sent while it was down was missed.
 */
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
  // The market (Task 20): everything the engine emits about jobs, runs, floors, firms and the city.
  'job.posted',
  'job.proposed',
  'job.changed',
  'job.awarded',
  'bid.placed',
  'bid.satOut',
  'run.started',
  'run.stage',
  'run.progress',
  'run.log',
  'run.ended',
  'inspection.done',
  'site.changed',
  'floor.laid',
  'floor.lit',
  'floor.removed',
  'floor.scarred',
  'merge.detected',
  'merge.reverted',
  'repo.halted',
  'repo.resumed',
  'firm.bankrupt',
  'tower.sold',
  'agent.hired',
  'agent.retired',
  'trip.started',
  'trip.ended',
  'report.written',
];

/** What the settings page may change (the engine checks every value again). */
export type SettingsPatch = Partial<
  Pick<Settings, 'quality' | 'dayCapPct' | 'nightCapPct' | 'claudeConcurrency' | 'localConcurrency' | 'bidWindowSec' | 'hardStopPct' | 'keepAwake' | 'ollamaHost'>
> & { anthropicApi?: Partial<Settings['anthropicApi']> };

/** What a repo patch may carry (the engine checks every value again). */
export type RepoPatchBody = Partial<Pick<Repo, 'pushMode' | 'root' | 'market' | 'label'>> & { checks?: Partial<RepoChecks> };

async function request<T>(method: string, path: string, body?: unknown, as: 'json' | 'text' = 'json'): Promise<T> {
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
  if (as === 'text') return text as T;
  return (text ? JSON.parse(text) : null) as T;
}

/** `?a=1&b=2` from the values that are set, or nothing. */
function queryOf(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

const enc = encodeURIComponent;

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
  patchSettings: (patch: SettingsPatch) => request<Settings>('PATCH', '/api/settings', patch),
  connect: (fullName: string) => request<Repo>('POST', repoPath(fullName, 'connect')),
  disconnect: (fullName: string) => request<{ ok: boolean }>('POST', repoPath(fullName, 'disconnect')),
  analyze: (fullName: string) => request<{ ok: boolean }>('POST', repoPath(fullName, 'analyze')),
  patchRepo: (fullName: string, patch: RepoPatchBody) => request<Repo>('PATCH', repoPath(fullName), patch),
  /** Clears a repo's halt and strikes; its halted jobs go back to the board (a waiting one stays waiting). */
  resumeRepo: (fullName: string) => request<Repo>('POST', repoPath(fullName, 'resume')),

  // ------------------------------------------------------------ the market
  jobs: (f: { status?: JobStatus; repo?: string } = {}) => request<Job[]>('GET', `/api/jobs${queryOf(f)}`),
  job: (id: string) => request<JobDetail>('GET', `/api/jobs/${enc(id)}`),
  postJob: (body: ManualJobBody) => request<Job>('POST', '/api/jobs', body),
  withdrawJob: (id: string) => request<Job>('POST', `/api/jobs/${enc(id)}/withdraw`),
  repostJob: (id: string) => request<Job>('POST', `/api/jobs/${enc(id)}/repost`),
  acceptJob: (id: string) => request<Job>('POST', `/api/jobs/${enc(id)}/accept`),
  dismissJob: (id: string) => request<Job>('POST', `/api/jobs/${enc(id)}/dismiss`),
  /** Resumes one halted job (a waiting one goes back to waiting, any other to open). */
  resumeJob: (id: string) => request<Job>('POST', `/api/jobs/${enc(id)}/resume`),
  setJobTier: (id: string, tier: Tier) => request<Job>('PATCH', `/api/jobs/${enc(id)}`, { tier }),
  firms: () => request<FirmView[]>('GET', '/api/firms'),
  firm: (id: string) => request<FirmDetail>('GET', `/api/firms/${enc(id)}`),
  agent: (id: string) => request<AgentDetail>('GET', `/api/agents/${enc(id)}`),
  run: (id: string) => request<RunDetail>('GET', `/api/runs/${enc(id)}`),
  /** The log lines after the first `since` of them. */
  runLog: (id: string, since = 0) => request<RunLogLine[]>('GET', `/api/runs/${enc(id)}/log?since=${since}`),
  runDiff: (id: string) => request<string>('GET', `/api/runs/${enc(id)}/diff`, undefined, 'text'),
  killRun: (id: string) => request<{ ok: boolean }>('POST', `/api/runs/${enc(id)}/kill`),
  inspection: (id: string) => request<InspectionView>('GET', `/api/inspections/${enc(id)}`),
  /** The URL of an inspection's screenshot, for an <img>. */
  shotUrl: (inspectionId: string, route: string, which: 'before' | 'after') => `/api/inspections/${enc(inspectionId)}/shot/${enc(route)}/${which}`,
  treasury: () => request<TreasuryView>('GET', '/api/treasury'),
  resumeStale: () => request<TreasuryView>('POST', '/api/treasury/resume-stale'),
  /** The credits entries behind a row of the treasury's spend tables: a firm's (or 'city') or a model's, today or this week. */
  credits: (q: { period: 'today' | 'week'; firm?: string; model?: string }) => request<CreditEntries>('GET', `/api/treasury/credits${queryOf(q)}`),
  /** A day's report, or the newest with `'latest'`. */
  report: (day: string) => request<ReportView>('GET', `/api/report/${enc(day)}`),
  providers: () => request<ProviderUsage[]>('GET', '/api/providers'),
  /** Stores the Anthropic API key in his keychain; the engine never sends it back. */
  setApiKey: (key: string) => request<{ ok: boolean }>('POST', '/api/providers/anthropic/key', { key }),
  removeApiKey: () => request<{ ok: boolean }>('DELETE', '/api/providers/anthropic/key'),
  quarters: () => request<Quarter[]>('GET', '/api/quarters'),
  live: () => request<LiveView>('GET', '/api/live'),

  /** Subscribes to the engine's event stream. Returns a function that closes it. */
  events(onEvent: (e: EngineEvent) => void): () => void {
    const source = new EventSource('/api/events');
    // EventSource reconnects by itself after an error; events sent meanwhile are lost, so say so once it is back.
    let dropped = false;
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
      if (!dropped) return;
      dropped = false;
      onEvent({ type: 'engine.reconnected', data: null });
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (msg) => {
        onEvent({ type, data: JSON.parse((msg as MessageEvent<string>).data) as unknown });
      });
    }
    return () => source.close();
  },
};
