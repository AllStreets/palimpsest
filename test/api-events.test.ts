import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { api } from '../app/src/api.js';
import type { EngineEvent } from '../app/src/api.js';

/** Stands in for the browser's EventSource: the test opens, drops and reopens it by hand. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (msg: { data: string }) => void>();

  constructor(public url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, fn: (msg: { data: string }) => void): void {
    this.listeners.set(type, fn);
  }

  close(): void {
    this.closed = true;
  }

  send(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

const original = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = original;
});

test('after the event stream drops and comes back, a reconnected event says the city and repos may be stale', () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const seen: EngineEvent[] = [];
  const close = api.events((e) => seen.push(e));
  const source = FakeEventSource.last!;

  source.onopen?.();
  assert.deepEqual(seen, [], 'the first open is not a reconnect');

  source.send('repo.connected', { repo: { fullName: 'acme/widgets' } });
  assert.equal(seen.length, 1);

  source.onerror?.();
  source.onerror?.();
  source.onopen?.();
  assert.deepEqual(seen.slice(1), [{ type: 'engine.reconnected', data: null }], 'one reconnect after the stream came back');

  source.onopen?.();
  assert.equal(seen.length, 2, 'an open with no error before it is not another reconnect');

  close();
  assert.equal(source.closed, true);
});

const MARKET_EVENTS = [
  'job.posted', 'job.proposed', 'job.changed', 'job.awarded', 'bid.placed', 'bid.satOut',
  'run.started', 'run.stage', 'run.progress', 'run.log', 'run.ended', 'inspection.done', 'site.changed',
  'floor.laid', 'floor.lit', 'floor.removed', 'floor.scarred', 'merge.detected', 'merge.reverted',
  'repo.halted', 'repo.resumed', 'firm.bankrupt', 'tower.sold', 'agent.hired', 'agent.retired',
  'trip.started', 'trip.ended', 'report.written',
];

test('every market event type reaches the page, and run.stage arrives with its data', () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const seen: EngineEvent[] = [];
  const close = api.events((e) => seen.push(e));
  const source = FakeEventSource.last!;
  for (const type of MARKET_EVENTS) source.send(type, { type });
  assert.deepEqual(seen.map((e) => e.type), MARKET_EVENTS);
  source.send('run.stage', { runId: 'run-1', stage: 'working' });
  assert.deepEqual(seen.at(-1), { type: 'run.stage', data: { runId: 'run-1', stage: 'working' } });
  close();
});

test('the market client calls each route with the right method, path and header', async () => {
  const calls: Array<{ method: string; path: string; header: string | null; body: string | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', path: String(input), header: headers['x-palimpsest'] ?? null, body: (init?.body as string | undefined) ?? null });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await api.jobs({ status: 'open', repo: 'acme/widgets' });
    await api.job('job-1');
    await api.postJob({ repo: 'acme/widgets', title: 'T' });
    await api.withdrawJob('job-1');
    await api.repostJob('job-1');
    await api.acceptJob('job-1');
    await api.dismissJob('job-1');
    await api.resumeJob('job-1');
    await api.setJobTier('job-1', 'high');
    await api.firms();
    await api.firm('alpha');
    await api.agent('a1');
    await api.run('run-1');
    await api.runLog('run-1', 12);
    await api.runDiff('run-1');
    await api.killRun('run-1');
    await api.inspection('insp-1');
    await api.treasury();
    await api.resumeStale();
    await api.report('latest');
    await api.report('2026-11-09');
    await api.providers();
    await api.setApiKey('sk-ant-x');
    await api.removeApiKey();
    await api.quarters();
    await api.live();
    await api.resumeRepo('acme/widgets');
    await api.patchRepo('acme/widgets', { market: true, label: 'city', checks: { test: 'npm test' } });
    await api.patchSettings({ claudeConcurrency: 3, anthropicApi: { dailyUsd: 7 } });
  } finally {
    globalThis.fetch = realFetch;
  }
  const line = (c: (typeof calls)[number]) => `${c.method} ${c.path}${c.header ? ' +h' : ''}`;
  assert.deepEqual(calls.map(line), [
    'GET /api/jobs?status=open&repo=acme%2Fwidgets',
    'GET /api/jobs/job-1',
    'POST /api/jobs +h',
    'POST /api/jobs/job-1/withdraw +h',
    'POST /api/jobs/job-1/repost +h',
    'POST /api/jobs/job-1/accept +h',
    'POST /api/jobs/job-1/dismiss +h',
    'POST /api/jobs/job-1/resume +h',
    'PATCH /api/jobs/job-1 +h',
    'GET /api/firms',
    'GET /api/firms/alpha',
    'GET /api/agents/a1',
    'GET /api/runs/run-1',
    'GET /api/runs/run-1/log?since=12',
    'GET /api/runs/run-1/diff',
    'POST /api/runs/run-1/kill +h',
    'GET /api/inspections/insp-1',
    'GET /api/treasury',
    'POST /api/treasury/resume-stale +h',
    'GET /api/report/latest',
    'GET /api/report/2026-11-09',
    'GET /api/providers',
    'POST /api/providers/anthropic/key +h',
    'DELETE /api/providers/anthropic/key +h',
    'GET /api/quarters',
    'GET /api/live',
    'POST /api/repos/acme/widgets/resume +h',
    'PATCH /api/repos/acme/widgets +h',
    'PATCH /api/settings +h',
  ]);
  assert.equal(calls[8].body, JSON.stringify({ tier: 'high' }));
  assert.equal(calls[22].body, JSON.stringify({ key: 'sk-ant-x' }));
});
