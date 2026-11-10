import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { award, bidList, collectBid, collectBids, eligibleAgents, firmExamples, openBidding } from '../engine/market/bids.js';
import { acquire, noteSseClients, resetBudget, treasury, type Lease } from '../engine/market/budget.js';
import { fakeDefaults, fakeProvider, type FakeScript } from '../engine/market/fake-provider.js';
import { job, postManualJob, settleJobEffects } from '../engine/market/jobs.js';
import type { PlanInput, Provider, Usage } from '../engine/market/provider.js';
import { resetProviders, setProvider } from '../engine/market/providers.js';
import { patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Agent, Firm, Job, ModelRef, Repo, Tier } from '../shared/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time, so the night cap stays out of the way. */
const NOW = new Date(2026, 10, 9, 14, 0, 0).getTime();
const FULL = 'acme/widgets';

let tempDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS'];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-bids-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetBudget();
  resetProviders();
  noteSseClients(1, NOW - MIN);
  storeRepo();
});

afterEach(async () => {
  await settleJobEffects();
  resetBudget();
  resetProviders();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

function storeRepo(): void {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: 'Widgets for everyone',
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-11-01T00:00:00.000Z',
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
}

/** A fresh reading so Claude is not paused as stale. */
function reading(five = 10): void {
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(NOW / 1000),
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: Math.floor((NOW + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

let slot = 10;
function addFirm(id: string, over: Partial<Firm> = {}): Firm {
  const f: Firm = {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    root: 'roman',
    motto: '',
    slot: slot++,
    balance: 300,
    status: 'active',
    negativeSince: null,
    bankruptAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO firms (id, json) VALUES (?, ?)').run(f.id, JSON.stringify(f));
  return f;
}

function addAgent(id: string, firmId: string, model: ModelRef, over: Partial<Agent> = {}): Agent {
  const a: Agent = {
    id,
    firmId,
    name: `Agent ${id}`,
    model,
    persona: `${id} builds carefully.`,
    temperament: 'careful',
    instructions: 'Do good work.',
    tools: [],
    workflow: { shape: 'single' },
    memory: { examples: 2 },
    lineage: { origin: 'seeded', parents: [], generation: 0, at: '2026-11-01T00:00:00.000Z' },
    silhouette: 'plain',
    maxTurns: 30,
    capability: 'scifi',
    bidsOn: ['low', 'normal', 'high'],
    retired: false,
    retiredReason: null,
    towerIndex: 0,
    ...over,
  };
  if (!openDb().prepare('SELECT id FROM firms WHERE id = ?').get(firmId)) addFirm(firmId);
  openDb().prepare('INSERT OR REPLACE INTO agents (id, firm_id, json) VALUES (?, ?, ?)').run(a.id, a.firmId, JSON.stringify(a));
  return a;
}

function bidding(tier: Tier = 'normal', patch: Partial<Job> = {}, now = NOW): Job {
  const j = postManualJob({ repo: FULL, title: 'Fix the header', body: 'Change `src/header.ts`.', tier });
  if (Object.keys(patch).length > 0) {
    const next = { ...j, ...patch };
    openDb().prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify(next), j.id);
  }
  return openBidding(job(j.id) as Job, now);
}

type Answer = { plan?: unknown; price: unknown; confidence: unknown; usage?: Partial<Usage> };
const usage = (u: Partial<Usage> = {}): Usage => ({ weightedTokens: 600, seconds: 1, usd: 0, credits: 1, ...u });

/** One fake for every backend; `answers` keyed by agent id, a function for anything fancier. */
function script(answers: Record<string, Answer | ((i: PlanInput, s: AbortSignal) => Promise<Answer> | Answer)>): PlanInput[] {
  const seen: PlanInput[] = [];
  const s: FakeScript = {
    plan: async (i, signal) => {
      seen.push(i);
      const a = answers[i.agent.id];
      if (!a) return fakeDefaults.plan(i);
      const r = typeof a === 'function' ? await a(i, signal) : a;
      return { plan: (r.plan ?? 'A plan.') as string, price: r.price as number, confidence: r.confidence as number, usage: usage(r.usage) };
    },
  };
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, fakeProvider(s));
  return seen;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A resolved bid from the ledger: firm `firmId` said `confidence` and passed or failed. */
function history(firmId: string, confidence: number, passed: boolean, n = 4): void {
  for (let k = 0; k < n; k++) {
    const jobId = `old-${firmId}-${k}`;
    record('job.awarded', { jobId, tier: 'normal', chosen: { firmId, confidence } });
    record('run.ended', { run: { jobId, outcome: passed ? 'merged' : 'failed' } });
  }
}

const creditRows = () =>
  (openDb().prepare("SELECT firm_id, kind, amount FROM credits WHERE kind = 'bid'").all() as Array<{ firm_id: string; kind: string; amount: number }>).map((r) => ({ ...r }));

// ---------------------------------------------------------------- tests

test('openBidding opens a window of bidWindowSec and eligibleAgents filters by firm, retirement and tier', () => {
  addAgent('a1', 'alpha', 'ollama:qwen');
  addAgent('a2', 'alpha', 'ollama:qwen', { retired: true, retiredReason: 'model not installed' });
  addAgent('b1', 'beta', 'ollama:qwen', { bidsOn: ['high'] });
  addFirm('gone', { status: 'bankrupt' });
  addAgent('g1', 'gone', 'ollama:qwen');
  const j = bidding('normal');
  assert.equal(j.status, 'bidding');
  assert.equal(j.bidsCloseAt, new Date(NOW + 120_000).toISOString());
  assert.deepEqual(eligibleAgents(j).map((a) => a.id), ['a1']);
});

test('a boastful firm loses to a calibrated one at the same price', async () => {
  history('boast', 0.9, false);
  history('calm', 0.6, true);
  addAgent('boaster', 'boast', 'ollama:qwen');
  addAgent('steady', 'calm', 'ollama:qwen');
  script({ boaster: { price: 30, confidence: 0.95 }, steady: { price: 30, confidence: 0.7 } });
  const j = bidding();
  await collectBids(j, NOW);
  const chosen = award(job(j.id) as Job, NOW + 1);
  assert.equal(chosen?.agentId, 'steady');
  assert.equal(chosen?.calibrated, 0.7);
  assert.equal(chosen?.ev, 12);
  const boast = bidList(j.id).bids.find((b) => b.agentId === 'boaster');
  assert.ok(boast && boast.calibrated < 0.2 && boast.ev < 0);
  assert.equal(job(j.id)?.status, 'awarded');
  assert.equal(job(j.id)?.awardedBid, chosen?.id);
});

test('price above value is clamped to value', async () => {
  addAgent('greedy', 'alpha', 'ollama:qwen');
  addAgent('cheap', 'beta', 'ollama:qwen');
  addAgent('junk', 'gamma', 'ollama:qwen');
  addAgent('words', 'delta', 'ollama:qwen');
  script({
    greedy: { price: 500, confidence: 1.7 },
    cheap: { price: -4, confidence: 0 },
    junk: { price: Number.NaN, confidence: 0.5 },
    words: { plan: { evil: true }, price: '12', confidence: 0.5 },
  });
  const j = bidding();
  await collectBids(j, NOW);
  const { bids, satOut } = bidList(j.id);
  const greedy = bids.find((b) => b.agentId === 'greedy');
  const cheap = bids.find((b) => b.agentId === 'cheap');
  assert.equal(greedy?.price, 60);
  assert.equal(greedy?.confidence, 0.99);
  assert.equal(cheap?.price, 1);
  assert.equal(cheap?.confidence, 0.05);
  // Answers that are not numbers or not text sit out rather than bid.
  assert.deepEqual(satOut.map((s) => s.agentId).sort(), ['junk', 'words']);
  for (const s of satOut) assert.match(s.note, /^sat out: /);
});

test('award waits for the window unless every agent has bid or sat out', async () => {
  addAgent('one', 'alpha', 'ollama:qwen');
  addAgent('two', 'beta', 'ollama:qwen');
  script({ one: { price: 20, confidence: 0.8 }, two: { price: 25, confidence: 0.8 } });
  const j = bidding();
  await collectBid(j, eligibleAgents(j)[0], NOW);
  assert.equal(award(job(j.id) as Job, NOW + 1000), null);
  assert.equal(job(j.id)?.status, 'bidding');
  await collectBid(j, eligibleAgents(j)[1], NOW);
  assert.equal(award(job(j.id) as Job, NOW + 2000)?.agentId, 'one');

  // A second job: only one of two has bid, so the award waits for the close.
  const k = bidding();
  await collectBid(k, eligibleAgents(k)[1], NOW);
  assert.equal(award(job(k.id) as Job, NOW + 119_000), null);
  assert.equal(award(job(k.id) as Job, NOW + 120_000)?.agentId, 'two');
});

test('no positive EV moves the job back to open', async () => {
  addAgent('dear', 'alpha', 'ollama:qwen');
  script({ dear: { price: 60, confidence: 0.6 } });
  const j = bidding();
  await collectBids(j, NOW);
  assert.equal(award(job(j.id) as Job, NOW + 1), null);
  const after = job(j.id) as Job;
  assert.equal(after.status, 'open');
  assert.equal(after.bidsCloseAt, null);
  assert.equal(after.awardedBid, null);
  const awarded = entries().filter((e) => e.kind === 'job.awarded' && (e.data as { jobId: string }).jobId === j.id);
  assert.equal(awarded.length, 1);
  assert.equal((awarded[0].data as { chosen: unknown }).chosen, null);
  // The next round starts clean.
  const again = openBidding(after, NOW + 5 * MIN);
  assert.equal(again.status, 'bidding');
  assert.deepEqual(bidList(j.id).bids, []);
});

test('excluded firms do not bid', async () => {
  addAgent('failed-before', 'alpha', 'ollama:qwen');
  addAgent('fresh', 'beta', 'ollama:qwen');
  const seen = script({});
  const j = bidding('normal', { excludedFirms: ['alpha'] });
  assert.deepEqual(eligibleAgents(j).map((a) => a.id), ['fresh']);
  await collectBids(j, NOW);
  // Asked directly, the excluded agent still does not bid, and no plan call is made for it.
  assert.equal(await collectBid(j, addAgent('failed-before', 'alpha', 'ollama:qwen'), NOW), null);
  assert.deepEqual(seen.map((i) => i.agent.id), ['fresh']);
  assert.deepEqual(bidList(j.id).bids.map((b) => b.agentId), ['fresh']);
  assert.deepEqual(bidList(j.id).satOut, []);
});

test('claude firms sit out while claude is paused and local firms still bid', async () => {
  // No usage reading at all: Claude is paused as stale.
  addAgent('claudia', 'alpha', 'claude:sonnet');
  addAgent('local', 'beta', 'ollama:qwen');
  const seen = script({});
  const j = bidding();
  await collectBids(j, NOW);
  const { bids, satOut } = bidList(j.id);
  assert.deepEqual(bids.map((b) => b.agentId), ['local']);
  assert.equal(satOut.length, 1);
  assert.equal(satOut[0].agentId, 'claudia');
  assert.match(satOut[0].reason, /stale/);
  assert.deepEqual(seen.map((i) => i.agent.id), ['local']);
});

test('a plan call queues while two claude runs are live and still bids before the window closes', async () => {
  reading();
  patchSettings({ bidWindowSec: 2 });
  const runs: Lease[] = [];
  for (let k = 0; k < 2; k++) {
    const r = await acquire('claude:sonnet', 'work', 10, { now: NOW });
    assert.ok(r.ok);
    runs.push(r.lease);
  }
  const gates = { a: deferred(), b: deferred() };
  addAgent('a', 'alpha', 'claude:sonnet');
  addAgent('b', 'beta', 'claude:sonnet');
  addAgent('c', 'gamma', 'claude:sonnet');
  const seen = script({
    a: async () => (await gates.a.promise, { price: 20, confidence: 0.7 }),
    b: async () => (await gates.b.promise, { price: 25, confidence: 0.7 }),
    c: { price: 22, confidence: 0.7 },
  });
  const j = bidding();
  const agents = eligibleAgents(j);
  const pending = agents.map((a) => collectBid(j, a, NOW));
  await new Promise((r) => setTimeout(r, 30));
  // a and b hold both claude plan slots, so c waits in the queue; the run slots never mattered.
  assert.deepEqual(seen.map((i) => i.agent.id), ['a', 'b']);
  gates.a.resolve();
  await pending[0];
  await pending[2];
  assert.deepEqual(seen.map((i) => i.agent.id), ['a', 'b', 'c']);
  gates.b.resolve();
  await Promise.all(pending);
  assert.deepEqual(bidList(j.id).bids.map((b) => b.agentId).sort(), ['a', 'b', 'c']);
  for (const l of runs) l.release();
});

test('a plan call still queued at the close makes the agent sit out', async () => {
  patchSettings({ bidWindowSec: 0.15 });
  const gate = deferred();
  addAgent('first', 'alpha', 'ollama:qwen');
  addAgent('second', 'beta', 'ollama:qwen');
  script({ first: async () => (await gate.promise, { price: 20, confidence: 0.7 }), second: { price: 20, confidence: 0.7 } });
  const j = bidding();
  const [a, b] = eligibleAgents(j);
  const first = collectBid(j, a, NOW);
  const second = await collectBid(j, b, NOW);
  assert.equal(second, null);
  gate.resolve();
  assert.ok(await first);
  const { satOut } = bidList(j.id);
  assert.equal(satOut.length, 1);
  assert.equal(satOut[0].agentId, 'second');
  assert.equal(satOut[0].reason, 'no slot before the window closed');
  assert.equal(satOut[0].note, 'sat out: no slot before the window closed');
});

test('a hard stop aborts a plan call in flight and the agent sits out', async () => {
  reading();
  const started = deferred();
  let aborted = false;
  addAgent('claudia', 'alpha', 'claude:sonnet');
  script({
    claudia: (_i, signal) =>
      new Promise<Answer>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        started.resolve();
      }),
  });
  const j = bidding();
  const pending = collectBid(j, eligibleAgents(j)[0], NOW);
  await started.promise;
  reading(95);
  treasury(NOW);
  assert.equal(await pending, null);
  assert.ok(aborted);
  const { satOut } = bidList(j.id);
  assert.equal(satOut[0].agentId, 'claudia');
  assert.match(satOut[0].reason, /hard/);
  assert.deepEqual(creditRows(), []);
});

test('a vote firm makes n plan calls and bids the median', async () => {
  addAgent('voter', 'sparrow', 'ollama:qwen', { workflow: { shape: 'vote', n: 3 } });
  const answers: Answer[] = [
    { price: 10, confidence: 0.5, plan: 'cheap plan' },
    { price: 40, confidence: 0.9, plan: 'dear plan' },
    { price: 20, confidence: 0.7, plan: 'middle plan' },
  ];
  let k = 0;
  const seen = script({ voter: () => answers[k++] });
  const j = bidding();
  const bid = await collectBid(j, eligibleAgents(j)[0], NOW);
  assert.equal(seen.length, 3);
  assert.equal(bid?.price, 20);
  assert.equal(bid?.confidence, 0.7);
  assert.equal(bid?.plan, 'middle plan');
  // Three calls, one charge for all of them.
  assert.deepEqual(creditRows(), [{ firm_id: 'sparrow', kind: 'bid', amount: 3 }]);
  assert.equal(bid?.cost, 3);
});

test('bid cost is charged to the firm', async () => {
  reading();
  addAgent('claudia', 'alpha', 'claude:sonnet', { memory: { examples: 1 } });
  // 6,000 weighted tokens at the assumed 60,000 per percent is one credit.
  const seen = script({ claudia: { price: 20, confidence: 0.7, usage: { weightedTokens: 6000 } } });
  // A merged job of alpha's, the example its next plan call sees.
  record('job.awarded', { jobId: 'old-1', tier: 'normal', chosen: { firmId: 'alpha', confidence: 0.8 } });
  record('run.ended', { run: { jobId: 'old-1', outcome: 'merged' }, summary: 'Rebuilt the footer.' });
  record('job.changed', { id: 'old-1', from: 'waiting', to: 'merged', job: { id: 'old-1', title: 'Fix the footer' } });
  assert.deepEqual(firmExamples('alpha', 3), ['Fix the footer: Rebuilt the footer.']);
  const j = bidding();
  const bid = await collectBid(j, eligibleAgents(j)[0], NOW);
  assert.equal(bid?.cost, 1);
  assert.deepEqual(creditRows(), [{ firm_id: 'alpha', kind: 'bid', amount: 1 }]);
  assert.deepEqual(seen[0].examples, ['Fix the footer: Rebuilt the footer.']);
  assert.equal(seen[0].persona, 'claudia builds carefully.');
  assert.match(seen[0].repoSummary, /Widgets for everyone/);
  const placed = entries().filter((e) => e.kind === 'bid.placed');
  assert.equal(placed.length, 1);
  assert.deepEqual((placed[0].data as { charged: unknown }).charged, { kind: 'bid', credits: 1, by: 'budget' });

  // An Anthropic API agent's backend charges its own calls, so the bid writes no second row.
  patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
  addAgent('api', 'beta', 'anthropic:claude-sonnet-5-5');
  const api: Provider = { ...fakeProvider({ plan: (i) => ({ ...fakeDefaults.plan(i), usage: usage({ usd: 0.1, credits: 2 }) }) }), kind: 'anthropic' };
  setProvider('anthropic', api);
  const k = bidding();
  const apiBid = await collectBid(k, eligibleAgents(k).find((a) => a.id === 'api') as Agent, NOW);
  assert.equal(apiBid?.cost, 2);
  assert.deepEqual(creditRows(), [{ firm_id: 'alpha', kind: 'bid', amount: 1 }]);
});

test('the award reasoning names every bid considered and every agent that sat out', async () => {
  addAgent('claudia', 'alpha', 'claude:sonnet', { name: 'Claudia Stone' });
  addAgent('olga', 'beta', 'ollama:qwen', { name: 'Olga Brick' });
  addAgent('pim', 'gamma', 'ollama:qwen', { name: 'Pim Glass' });
  script({ olga: { price: 20, confidence: 0.8 }, pim: { price: 30, confidence: 0.8 } });
  const j = bidding();
  await collectBids(j, NOW);
  const chosen = award(job(j.id) as Job, NOW + 1);
  assert.equal(chosen?.agentId, 'olga');
  const e = entries().find((x) => x.kind === 'job.awarded');
  const d = e?.data as { jobId: string; considered: Array<{ agentId: string }>; satOut: Array<{ agentId: string; reason: string }>; chosen: { agentId: string }; why: string };
  assert.equal(d.jobId, j.id);
  assert.deepEqual(d.considered.map((b) => b.agentId).sort(), ['olga', 'pim']);
  assert.deepEqual(d.satOut.map((s) => s.agentId), ['claudia']);
  assert.equal(d.chosen.agentId, 'olga');
  for (const name of ['Claudia Stone', 'Olga Brick', 'Pim Glass']) assert.ok(d.why.includes(name), `${name} missing from: ${d.why}`);
  assert.match(d.why, /stale/);
});

test('an EV tie goes to the lower price', async () => {
  addAgent('x', 'alpha', 'ollama:qwen');
  addAgent('y', 'beta', 'ollama:qwen');
  // New firms: calibrated is confidence * 0.85. x: 0.34 * 60 - 10 = 10.4; y: 0.51 * 60 - 20.2 = 10.4.
  script({ y: { price: 20.2, confidence: 0.6 }, x: { price: 10, confidence: 0.4 } });
  const j = bidding();
  await collectBids(j, NOW);
  const b = bidList(j.id).bids;
  assert.equal(b[0].ev, 10.4);
  assert.equal(b[1].ev, 10.4);
  assert.equal(award(job(j.id) as Job, NOW + 1)?.agentId, 'x');
});
