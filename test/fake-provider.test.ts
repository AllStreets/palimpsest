import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { fakeFileName, fakeProvider } from '../engine/market/fake-provider.js';
import type { Provider, RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor, resetProviders, setProvider } from '../engine/market/providers.js';
import type { Agent, Job, RunProgress } from '../shared/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'palimpsest-fake-provider-test-'));
});

afterEach(() => {
  resetProviders();
  rmSync(dir, { recursive: true, force: true });
});

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    repo: 'acme/widgets',
    source: 'issue',
    issue: 7,
    url: null,
    title: 'Add a changelog',
    body: 'Please add `docs/CHANGELOG.md` with a first entry.',
    scope: [],
    acceptance: [],
    tier: 'normal',
    value: 10,
    status: 'running',
    attempts: 0,
    postedAt: '2026-11-01T00:00:00.000Z',
    bidsCloseAt: null,
    awardedBid: null,
    runId: 'run-1',
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...over,
  };
}

const agent = { id: 'agent-1', firmId: 'firm-1', name: 'Ada', model: 'claude:sonnet' } as unknown as Agent;

function workInput(over: Partial<WorkInput> = {}) {
  const logs: RunLogLine[] = [];
  const ticks: Partial<RunProgress>[] = [];
  const input: WorkInput = {
    job: makeJob(),
    agent,
    persona: 'careful',
    runId: 'run-1',
    dir,
    branch: 'palimpsest/job-1',
    plan: null,
    examples: [],
    log: (l) => logs.push(l),
    onProgress: (p) => ticks.push(p),
    signal: new AbortController().signal,
    caps: { maxTurns: 10, maxMinutes: 5, maxCredits: 50 },
    ...over,
  };
  return { input, logs, ticks };
}

test('fake provider plans at 60% of value with confidence 0.7', async () => {
  const p = fakeProvider();
  assert.equal(p.kind, 'fake');
  const r = await p.plan({ job: makeJob({ value: 10 }), agent, persona: 'x', repoSummary: '', examples: [] }, new AbortController().signal);
  assert.equal(r.price, 6);
  assert.equal(r.confidence, 0.7);
  assert.ok(r.plan.length > 0);
  assert.equal(r.usage.usd, 0);
});

test('fake provider writes its file, logs and finishes', async () => {
  const { input, logs, ticks } = workInput();
  const r = await fakeProvider().work(input);
  assert.equal(r.ended, 'finished');
  assert.equal(r.reason, null);
  const file = join(dir, 'docs', 'CHANGELOG.md');
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /Add a changelog/);
  assert.ok(logs.length >= 3);
  assert.ok(logs.every((l) => typeof l.at === 'string' && l.text.length > 0));
  assert.ok(ticks.length >= 2);
  assert.ok(ticks.some((t) => t.filesChanged === 1));
});

test('fake provider ends aborted when the signal fires', async () => {
  const ac = new AbortController();
  const { input, ticks } = workInput({ signal: ac.signal, onProgress: (p) => { ticks.push(p); ac.abort(); } });
  const r = await fakeProvider().work(input);
  assert.equal(r.ended, 'aborted');
  assert.equal(ticks.length, 1);
  assert.ok(!existsSync(join(dir, 'docs', 'CHANGELOG.md')), 'no file written after the abort');
});

test('fake provider ends aborted at once when the signal already fired', async () => {
  const ac = new AbortController();
  ac.abort();
  const { input, ticks } = workInput({ signal: ac.signal });
  const r = await fakeProvider().work(input);
  assert.equal(r.ended, 'aborted');
  assert.equal(ticks.length, 0);
});

test('fake provider approves reviews and judges after 7', async () => {
  const p = fakeProvider();
  const rv = await p.review({ job: makeJob(), agent, persona: 'x', diff: '', acceptance: [], checks: [] }, new AbortController().signal);
  assert.equal(rv.approve, true);
  assert.deepEqual(rv.concerns, []);
  const j = await p.judge({ bar: 'b', before: [], after: [], diff: null }, new AbortController().signal);
  assert.equal(j.after, 7);
});

test('a script overrides one method and keeps the other defaults', async () => {
  const p = fakeProvider({ review: () => ({ approve: false, notes: 'no', concerns: ['scope'], usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 } }) });
  const rv = await p.review({ job: makeJob(), agent, persona: 'x', diff: '', acceptance: [], checks: [] }, new AbortController().signal);
  assert.equal(rv.approve, false);
  const j = await p.judge({ bar: 'b', before: [], after: [], diff: null }, new AbortController().signal);
  assert.equal(j.after, 7);
});

test('the file name comes from the body and never leaves the run dir', () => {
  assert.equal(fakeFileName(makeJob({ body: 'Write `notes/todo.txt` please' })), 'notes/todo.txt');
  assert.equal(fakeFileName(makeJob({ body: 'Fix the README.md typo' })), 'README.md');
  assert.equal(fakeFileName(makeJob({ body: 'Write `../../etc/passwd.txt`' })), 'PALIMPSEST.md');
  assert.equal(fakeFileName(makeJob({ body: 'Write `/etc/hosts.txt`' })), 'PALIMPSEST.md');
  assert.equal(fakeFileName(makeJob({ body: 'Write `.git/config.txt`' })), 'PALIMPSEST.md');
  assert.equal(fakeFileName(makeJob({ body: 'nothing named here' })), 'PALIMPSEST.md');
});

test('providerFor routes by prefix and setProvider overrides', () => {
  const claude: Provider = { ...fakeProvider(), kind: 'claude' };
  const ollama: Provider = { ...fakeProvider(), kind: 'ollama' };
  const anthropic: Provider = { ...fakeProvider(), kind: 'anthropic' };
  assert.equal(providerFor('claude:sonnet').kind, 'claude', 'the claude -p backend is registered (Task 9)');
  assert.notEqual(providerFor('claude:sonnet'), claude);
  setProvider('claude', claude);
  setProvider('ollama', ollama);
  setProvider('anthropic', anthropic);
  assert.equal(providerFor('claude:sonnet'), claude);
  assert.equal(providerFor('ollama:qwen2.5-coder:7b'), ollama);
  assert.equal(providerFor('anthropic:claude-sonnet-4'), anthropic);
  assert.throws(() => providerFor('mlx:anything'), /no provider/);

  const fake = fakeProvider();
  setProvider('claude', fake);
  assert.equal(providerFor('claude:opus'), fake);
  resetProviders();
  assert.notEqual(providerFor('claude:opus'), fake);
  assert.equal(providerFor('claude:opus').kind, 'claude');
});
