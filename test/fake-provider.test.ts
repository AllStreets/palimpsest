import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { fakeFileName, fakeProvider } from '../engine/market/fake-provider.js';
import type { AuditInput, Provider, RunLogLine, WorkInput } from '../engine/market/provider.js';
import { providerFor, resetProviders, setProvider } from '../engine/market/providers.js';
import type { Agent, Job, Repo, RunProgress } from '../shared/types.js';

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

function auditInput(over: Partial<AuditInput> = {}) {
  const logs: RunLogLine[] = [];
  const input: AuditInput = {
    repo: { fullName: 'acme/widgets', defaultBranch: 'main' } as Repo,
    auditId: 'audit-1',
    dir,
    baseSha: 'a'.repeat(40),
    readme: { path: 'README.md', text: '# Widgets\n\nA widget library.\n\n## Hot reload\n\nEdits show up without a restart.\n' },
    docs: [],
    checks: null,
    model: 'claude:sonnet',
    log: (l) => logs.push(l),
    onProgress: () => {},
    signal: new AbortController().signal,
    caps: { maxTurns: 10, maxMinutes: 5, maxCredits: 40 },
    ...over,
  };
  return { input, logs };
}

test('the default fake audit answers one REAL and one MISSING finding and writes no file', async () => {
  const before = readdirSync(dir);
  const { input } = auditInput();
  const r = await fakeProvider().audit(input);
  assert.equal(r.ended, 'finished');
  assert.equal(r.reason, null);
  assert.ok(r.usage.credits > 0);
  const a = r.answer as { claims: number; findings: Array<Record<string, unknown>> };
  assert.equal(a.claims, 2);
  assert.equal(a.findings.length, 2);
  const [real, missing] = a.findings;
  assert.equal(real.verdict, 'REAL');
  assert.deepEqual((real.evidence as Array<{ file: string; line: number }>)[0], { file: 'README.md', line: 1, note: (real.evidence as Array<{ note: string }>)[0].note });
  assert.equal(real.proposal, null);
  assert.equal(missing.verdict, 'MISSING');
  assert.match((missing.proposal as { title: string }).title, /Hot reload/);
  assert.ok(Array.isArray((missing.proposal as { acceptance: string[] }).acceptance) && (missing.proposal as { acceptance: string[] }).acceptance.length >= 1);
  assert.deepEqual(JSON.parse(r.text), a, 'the text is the answer as JSON');
  assert.deepEqual(readdirSync(dir), before, 'nothing was written');
  // a script replaces it, and no README means no findings
  const scripted = await fakeProvider({ audit: () => ({ answer: { claims: 0, findings: [] }, text: '{}', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, ended: 'crashed', reason: 'scripted' }) }).audit(input);
  assert.equal(scripted.ended, 'crashed');
  const none = await fakeProvider().audit(auditInput({ readme: null }).input);
  assert.deepEqual(none.answer, { claims: 0, findings: [] });
  const ac = new AbortController();
  ac.abort();
  assert.equal((await fakeProvider().audit(auditInput({ signal: ac.signal }).input)).ended, 'aborted');
});
