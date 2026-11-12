/**
 * The market over the engine's API and event stream (Task 20). Every test
 * starts its own engine on an ephemeral port with a temp home (rule 1); no
 * model, gh, Ollama or keychain is reached: the provider is the fake, gh is
 * never called, the keychain is a stand-in file behind a fake `security`,
 * and Ollama's host points at a closed local port.
 */
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit } from '../engine/events.js';
import { realRunner, setRunner, setSpawner, type Spawned } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { openBidding } from '../engine/market/bids.js';
import { fakeDefaults, fakeProvider } from '../engine/market/fake-provider.js';
import { job, postManualJob, proposeHarnessJob, transition } from '../engine/market/jobs.js';
import { setProvider } from '../engine/market/providers.js';
import { createScheduler, haltRepo, run as storedRun } from '../engine/market/runs.js';
import { getRepo } from '../engine/repos.js';
import { startServer, type StartedServer } from '../engine/server.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import type { Bid, Inspection, Job, Run } from '../shared/types.js';
import { FULL, HOUR, PNG, addAgent, addFirm, checks, git, makeRepo, makeRun, noReading, postJob, reading, setUp, tearDown, tempDir, write } from './guild-fixtures.js';

let server: StartedServer | null = null;
let fakeKc = '';

beforeEach(() => {
  setUp('routes');
  // Settings' Ollama probe goes to a closed loopback port, never to a real Ollama.
  patchSettings({ ollamaHost: '127.0.0.1:1' });
  process.env.PALIMPSEST_CODEX_HOME = join(tempDir, 'no-codex');
  process.env.PALIMPSEST_GEMINI_HOME = join(tempDir, 'no-gemini');
  fakeKc = join(tempDir, 'fake.keychain-db');
  writeFileSync(fakeKc, '');
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  delete process.env.PALIMPSEST_CODEX_HOME;
  delete process.env.PALIMPSEST_GEMINI_HOME;
  setRunner(realRunner);
  await tearDown();
});

async function start(): Promise<StartedServer> {
  server = await startServer({ port: 0, claudeSettingsPath: join(tempDir, 'claude-settings.json'), keychain: fakeKc });
  return server;
}

interface Answer {
  status: number;
  text: string;
  json: any;
  type: string;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const s = server ?? (await start());
  const h: Record<string, string> = { ...headers };
  if (method !== 'GET') h['x-palimpsest'] = '1';
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, type: res.headers.get('content-type') ?? '' };
}

const repoOf = () => makeRepo(checks(), { 'README.md': 'widgets\n', 'src/header.ts': 'export const header = 1;\n' });

// ------------------------------------------------------------------ jobs

test('jobs routes post, list and withdraw', async () => {
  repoOf();
  // A write without the header is refused, as everywhere else.
  const s = await start();
  const bare = await fetch(`http://127.0.0.1:${s.port}/api/jobs`, { method: 'POST', body: '{}' });
  assert.equal(bare.status, 403);

  const bad = await call('POST', '/api/jobs', { repo: FULL });
  assert.equal(bad.status, 400, 'a job needs a title');
  assert.equal((await call('POST', '/api/jobs', { repo: '../etc', title: 'x' })).status, 400, 'the repo name is validated');
  assert.equal((await call('POST', '/api/jobs', { repo: FULL, title: 'x', tier: 'huge' })).status, 400);
  assert.equal((await call('POST', '/api/jobs', { repo: 'acme/other', title: 'x' })).status, 404, 'an unconnected repo');

  const made = await call('POST', '/api/jobs', { repo: FULL, title: 'Fix the header', body: 'Change `src/header.ts`.', tier: 'high' });
  assert.equal(made.status, 201);
  assert.equal(made.json.status, 'open');
  assert.equal(made.json.source, 'manual');
  assert.equal(made.json.tier, 'high');

  const list = await call('GET', `/api/jobs?status=open&repo=${encodeURIComponent(FULL)}`);
  assert.deepEqual(list.json.map((j: Job) => j.id), [made.json.id]);
  assert.deepEqual((await call('GET', '/api/jobs?status=failed')).json, []);
  assert.equal((await call('GET', '/api/jobs?status=bogus')).status, 400);
  assert.equal((await call('GET', '/api/jobs?repo=..%2Fx')).status, 400);

  const out = await call('POST', `/api/jobs/${made.json.id}/withdraw`);
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'withdrawn');
  assert.equal(job(made.json.id)?.status, 'withdrawn');
  assert.equal((await call('POST', `/api/jobs/${made.json.id}/withdraw`)).status, 409, 'a withdrawn job cannot be withdrawn again');
  assert.equal((await call('POST', '/api/jobs/job-nope/withdraw')).status, 404);
  assert.ok([400, 404].includes((await call('POST', '/api/jobs/..%2F..%2Fx/withdraw')).status), 'a path-shaped id is refused');
  assert.equal((await call('POST', '/api/jobs/-x/withdraw')).status, 400);
});

test('a failed job with attempts left reposts; one with none does not', async () => {
  repoOf();
  const j = postJob(['**']);
  let cur = openBidding(j, Date.now());
  cur = transition(cur, 'awarded');
  cur = transition(cur, 'failed');
  assert.equal(cur.attempts, 1);
  const again = await call('POST', `/api/jobs/${j.id}/repost`);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'open');
  let spent = openBidding(job(j.id)!, Date.now());
  spent = transition(spent, 'awarded');
  spent = transition(spent, 'failed');
  assert.equal(spent.attempts, 2);
  assert.equal((await call('POST', `/api/jobs/${j.id}/repost`)).status, 409);
  assert.equal((await call('POST', `/api/jobs/${postJob(['**']).id}/repost`)).status, 409, 'an open job is not reposted');
});

test('a proposed job accepts into open, dismisses to withdrawn, and a tier changes only while proposed or open', async () => {
  const repo = repoOf();
  const a = proposeHarnessJob(repo);
  assert.equal(a.status, 'proposed');
  const tiered = await call('PATCH', `/api/jobs/${a.id}`, { tier: 'high' });
  assert.equal(tiered.status, 200);
  assert.equal(tiered.json.tier, 'high');
  assert.equal(tiered.json.value, job(a.id)!.value);
  const accepted = await call('POST', `/api/jobs/${a.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.status, 'open');
  assert.equal((await call('POST', `/api/jobs/${a.id}/accept`)).status, 409, 'only a proposed job accepts');
  assert.equal((await call('POST', `/api/jobs/${a.id}/dismiss`)).status, 409);
  assert.equal((await call('PATCH', `/api/jobs/${a.id}`, { tier: 'low' })).json.tier, 'low', 'open still takes a tier');
  assert.equal((await call('PATCH', `/api/jobs/${a.id}`, { tier: 'enormous' })).status, 400);
  assert.equal((await call('PATCH', `/api/jobs/${a.id}`, {})).status, 400);

  const other = makeRepo(checks(), { 'README.md': 'two\n' }, 'acme/two');
  const c = proposeHarnessJob(other);
  const dismissed = await call('POST', `/api/jobs/${c.id}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.json.status, 'withdrawn');

  const bidding = openBidding(postJob(['**']), Date.now());
  assert.equal((await call('PATCH', `/api/jobs/${bidding.id}`, { tier: 'low' })).status, 409, 'no tier change once bidding');
});

test('job detail carries bids, award, sat-out agents and ledger', async () => {
  repoOf();
  const winner = addAgent('a1', 'alpha', 'claude:sonnet');
  addAgent('l1', 'beta', 'ollama:qwen3');
  const posted = postJob(['**']);
  const open = openBidding(posted, Date.now());
  const bid: Bid = {
    id: 'bid-a1',
    jobId: posted.id,
    firmId: winner.firmId,
    agentId: winner.id,
    plan: '1. Read. 2. Change.',
    price: 20,
    confidence: 0.8,
    calibrated: 0.7,
    appraisal: null,
    ev: 20,
    cost: 3,
    at: new Date().toISOString(),
  };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, bid.jobId, JSON.stringify({ round: open.bidsCloseAt, bid }));
  record('job.awarded', { jobId: posted.id, tier: 'normal', considered: [bid], satOut: [{ agentId: 'l1', reason: 'no slot before the window closed' }], chosen: bid, why: `Chose it. Dir is ${paths().runs}/x`, at: new Date().toISOString(), coolOffUntil: null });
  transition(open, 'awarded', { awardedBid: bid.id });

  const d = await call('GET', `/api/jobs/${posted.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.json.job.id, posted.id);
  assert.deepEqual(d.json.bids.map((b: Bid) => b.id), ['bid-a1']);
  assert.equal(d.json.award.chosen.id, 'bid-a1');
  assert.match(d.json.award.why, /Chose it/);
  assert.deepEqual(d.json.award.satOut, [{ agentId: 'l1', reason: 'no slot before the window closed' }]);
  assert.deepEqual(d.json.runs, []);
  assert.deepEqual(d.json.inspections, []);
  assert.ok(d.json.ledger.some((e: { kind: string }) => e.kind === 'job.awarded'));
  assert.ok(d.json.ledger.some((e: { kind: string }) => e.kind === 'job.changed'));
  assert.ok(!d.text.includes(paths().runs), 'no home path leaves the engine');

  const fresh = await call('GET', `/api/jobs/${postJob(['**']).id}`);
  assert.equal(fresh.json.award, null, 'a job never awarded has no award');
  assert.deepEqual(fresh.json.satOut, [], 'a job with no round has no one sitting out');
  assert.equal((await call('GET', '/api/jobs/job-nope')).status, 404);
});

test('job detail names who sat out of the round still taking bids, before any award', async () => {
  repoOf();
  addAgent('l1', 'beta', 'ollama:qwen3');
  const open = openBidding(postJob(['**']), Date.now());
  const s = { jobId: open.id, agentId: 'l1', firmId: 'beta', reason: `no slot; see ${paths().runs}/x`, note: 'sat out: no slot', at: new Date().toISOString() };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run('sat-1', open.id, JSON.stringify({ round: open.bidsCloseAt, satOut: s }));
  // A sit-out from an earlier round is not this round's.
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run('sat-0', open.id, JSON.stringify({ round: '2020-01-01T00:00:00.000Z', satOut: { ...s, agentId: 'old' } }));
  const d = await call('GET', `/api/jobs/${open.id}`);
  assert.equal(d.json.award, null);
  assert.deepEqual(d.json.satOut.map((x: { agentId: string }) => x.agentId), ['l1']);
  assert.equal(d.json.satOut[0].firmId, 'beta');
  assert.match(d.json.satOut[0].reason, /^no slot; see /);
  assert.ok(!d.text.includes(paths().runs), 'the reason is redacted like everything else');
});

// ------------------------------------------------------------------ firms, agents

test('firms list reputations and agents, and a firm carries its jobs and credit rows', async () => {
  const repo = repoOf();
  const a = addAgent('a1', 'alpha', 'claude:sonnet');
  const j = postJob(['**']);
  const { run } = await makeRun(repo, j, a, (dir) => write(dir, 'src/header.ts', 'export const header = 2;\n'));
  openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, 'run', 4, NULL, '{}')").run(new Date().toISOString(), 'alpha', run.id);

  const list = await call('GET', '/api/firms');
  assert.equal(list.status, 200);
  const alpha = list.json.find((f: { id: string }) => f.id === 'alpha');
  assert.ok(alpha.reputation && typeof alpha.reputation.score === 'number');
  assert.deepEqual(alpha.agents.map((x: { id: string }) => x.id), ['a1']);

  const one = await call('GET', '/api/firms/alpha');
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.jobs.map((x: Job) => x.id), [j.id]);
  assert.ok(!('credits' in one.json), 'the raw credit rows are not sent twice: the books carry them');
  assert.equal(one.json.opening, 300, 'the firm opened with its seeded balance');
  assert.equal(one.json.truncated, false);
  // The story its page tells (Task 38): books, rounds, reputation over time and deals, all arrays.
  for (const key of ['books', 'rounds', 'reputationLine', 'deals']) assert.ok(Array.isArray(one.json[key]), `a firm carries its ${key}`);
  assert.equal((await call('GET', '/api/firms/nobody')).status, 404);
});

test('the list, a firm and an agent’s firm read one balance, charges not yet settled included', async () => {
  addAgent('a1', 'alpha', 'claude:sonnet');
  openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'alpha', 'run-x', 'run', 320, NULL, '{}')").run(new Date().toISOString());
  const list = (await call('GET', '/api/firms')).json.find((f: { id: string }) => f.id === 'alpha');
  const one = (await call('GET', '/api/firms/alpha')).json;
  const ag = (await call('GET', '/api/agents/a1')).json;
  assert.equal(list.balance, -20);
  assert.equal(one.balance, -20);
  assert.equal(ag.firm.balance, -20);
  // Below zero by that balance: the hours left count from a negativeSince all three share.
  assert.ok(list.negativeSince && one.negativeSince && ag.firm.negativeSince);
});

test('a firm below zero with no stored negativeSince reads one stable time: the charge that took it there', async () => {
  addAgent('a1', 'alpha', 'claude:sonnet');
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  openDb().prepare("INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, 'alpha', 'run-x', 'run', 320, NULL, '{}')").run(at);
  const first = (await call('GET', '/api/firms')).json.find((f: { id: string }) => f.id === 'alpha');
  await new Promise((r) => setTimeout(r, 20));
  const again = (await call('GET', '/api/firms/alpha')).json;
  const ag = (await call('GET', '/api/agents/a1')).json;
  assert.equal(first.negativeSince, at, 'since the charge, not since the request');
  assert.equal(again.negativeSince, at, 'and the same on the next request');
  assert.equal(ag.firm.negativeSince, at);
});

test('agent detail carries genome and lineage', async () => {
  const repo = repoOf();
  const parent = addAgent('p1', 'alpha', 'claude:sonnet');
  const child = addAgent('c1', 'alpha', 'anthropic:sonnet', { lineage: { origin: 'school', parents: ['p1'], generation: 1, at: '2026-11-02T00:00:00.000Z' }, towerIndex: 1 });
  const j = postJob(['**']);
  await makeRun(repo, j, child, (dir) => write(dir, 'a.txt', 'a\n'));

  const d = await call('GET', '/api/agents/c1');
  assert.equal(d.status, 200);
  assert.equal(d.json.agent.id, 'c1');
  assert.equal(d.json.firm.id, 'alpha');
  assert.equal(d.json.genome.id, 'c1');
  assert.match(d.json.genome.model, /^claude:/, 'an anthropic: agent maps to claude: for Beagle');
  assert.ok(d.json.genome.note);
  assert.equal(d.json.lineage.agent.generation, 1);
  assert.deepEqual(d.json.lineage.parents.map((p: { id: string }) => p.id), ['p1']);
  assert.equal(d.json.runs.length, 1);
  assert.ok(!('dir' in d.json.runs[0]), 'a run dir is never sent');
  assert.equal(d.json.tower?.agentId, 'c1');
  assert.equal(d.json.reputation?.firmId, 'alpha', 'an agent carries its firm’s reputation, for the calibration');
  assert.equal(d.json.towerFirmId, 'alpha', 'its tower stands in its own firm’s root');

  const p = await call('GET', `/api/agents/${parent.id}`);
  assert.deepEqual(p.json.lineage.children.map((c: { id: string }) => c.id), ['c1']);
  assert.equal((await call('GET', '/api/agents/nobody')).status, 404);
});

// ------------------------------------------------------------------ runs, inspections

test('run detail, log, diff and inspection never carry a home path or a raw secret', async () => {
  const repo = repoOf();
  const a = addAgent('a1', 'alpha', 'claude:sonnet');
  const j = postJob(['**']);
  const { run, diff } = await makeRun(repo, j, a, (dir) => write(dir, 'src/header.ts', 'export const header = 2;\n'));
  const runRoot = join(paths().runs, run.id);

  const lines = [
    { at: '2026-11-10T10:00:00.000Z', kind: 'engine', text: 'one' },
    { at: '2026-11-10T10:00:01.000Z', kind: 'tool', text: `cd ${paths().runs}/${run.id}` },
    { at: '2026-11-10T10:00:02.000Z', kind: 'assistant', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' },
    { at: '2026-11-10T10:00:03.000Z', kind: 'result', text: 'four' },
    { at: '2026-11-10T10:00:04.000Z', kind: 'result', text: 'five' },
  ];
  writeFileSync(join(runRoot, 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const all = await call('GET', `/api/runs/${run.id}/log?since=0`);
  assert.equal(all.status, 200);
  assert.equal(all.json.length, 5);
  assert.ok(!all.text.includes(paths().runs), 'the home path is redacted');
  assert.ok(!all.text.includes('ghp_abcdefghij'), 'the token is redacted');
  const rest = await call('GET', `/api/runs/${run.id}/log?since=3`);
  assert.deepEqual(rest.json.map((l: { text: string }) => l.text), ['four', 'five']);
  assert.deepEqual((await call('GET', `/api/runs/${run.id}/log`)).json.length, 5, 'no since means from the start');
  assert.deepEqual((await call('GET', `/api/runs/${run.id}/log?since=9`)).json, []);
  assert.equal((await call('GET', `/api/runs/${run.id}/log?since=-1`)).status, 400);
  assert.equal((await call('GET', `/api/runs/${run.id}/log?since=abc`)).status, 400);
  assert.equal((await call('GET', '/api/runs/run-nope/log')).status, 404);

  const detail = await call('GET', `/api/runs/${run.id}`);
  assert.equal(detail.status, 200);
  assert.ok(!('dir' in detail.json));
  assert.equal(detail.json.job.id, j.id);
  assert.equal(detail.json.inspection, null);

  const patch = await call('GET', `/api/runs/${run.id}/diff`);
  assert.equal(patch.status, 200);
  assert.match(patch.type, /^text\/plain/);
  assert.match(patch.text, /header = 2/);
  assert.equal(patch.text.length, diff.patch.length);
  assert.equal((await call('GET', '/api/runs/run-nope/diff')).status, 404);
  assert.ok([400, 404].includes((await call('GET', '/api/runs/..%2F..%2Fetc/diff')).status));
  assert.equal((await call('GET', '/api/runs/.x/diff')).status, 400);

  // The job detail lists the run's inspection too, once there is one.
  const mkCheck = (name: 'test' | 'build', logPath: string | null) => ({ name, status: 'pass' as const, detail: 'ok', durationMs: 5, logPath, testsRun: null });
  const big = join(runRoot, 'test.log');
  writeFileSync(big, 'a line of the log\n'.repeat(8000));
  const outside = join(tempDir, 'outside.log');
  writeFileSync(outside, 'secret outside the runs');
  mkdirSync(join(runRoot, 'inspection', 'shots'), { recursive: true });
  writeFileSync(join(runRoot, 'inspection', 'shots', 'after-0.png'), PNG);
  const insp: Inspection = {
    id: 'insp-1',
    runId: run.id,
    jobId: j.id,
    repo: FULL,
    reviewerAgentId: null,
    reviewerFirmId: null,
    checks: [mkCheck('test', big), mkCheck('build', outside)],
    passed: true,
    pushable: false,
    design: { before: null, after: 7, diffOnly: false, shots: [{ route: '/about', before: null, after: join(runRoot, 'inspection', 'shots', 'after-0.png') }, { route: '/evil', before: null, after: outside }] },
    cost: 1,
    at: new Date().toISOString(),
  };
  openDb().prepare('INSERT INTO inspections (id, run_id, json) VALUES (?, ?, ?)').run(insp.id, run.id, JSON.stringify(insp));
  openDb().prepare('UPDATE runs SET json = ? WHERE id = ?').run(JSON.stringify({ ...run, inspectionId: insp.id }), run.id);

  const got = await call('GET', `/api/inspections/${insp.id}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.byteLength(got.json.checks[0].log) <= 64 * 1024 && got.json.checks[0].log.length > 60 * 1024, 'a check log is capped at 64 KB');
  assert.ok(!('logPath' in got.json.checks[0]));
  assert.equal(got.json.checks[1].log, null, 'a log outside the runs folder is never read');
  assert.ok(!got.text.includes(tempDir), 'no path of this Mac leaves the engine');
  assert.equal((await call('GET', `/api/runs/${run.id}`)).json.inspection.id, 'insp-1');
  const viaJob = await call('GET', `/api/jobs/${j.id}`);
  assert.deepEqual(viaJob.json.inspections.map((i: { id: string }) => i.id), ['insp-1']);
  assert.ok(!('dir' in viaJob.json.runs[0]));

  const shot = await fetch(`http://127.0.0.1:${server!.port}/api/inspections/insp-1/shot/${encodeURIComponent('/about')}/after`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG);
  assert.equal((await call('GET', `/api/inspections/insp-1/shot/${encodeURIComponent('/about')}/before`)).status, 404);
  assert.equal((await call('GET', `/api/inspections/insp-1/shot/${encodeURIComponent('/evil')}/after`)).status, 404, 'a shot outside the runs folder is never served');
  assert.equal((await call('GET', `/api/inspections/insp-1/shot/${encodeURIComponent('/about')}/sideways`)).status, 404);
  assert.equal((await call('GET', '/api/inspections/insp-nope')).status, 404);
});

test('kill ends a run', async () => {
  const repo = repoOf();
  void repo;
  const a = addAgent('l1', 'gamma', 'ollama:qwen3');
  const posted = postJob(['**']);
  const open = openBidding(posted, Date.now());
  const bid: Bid = { id: 'bid-l1', jobId: posted.id, firmId: 'gamma', agentId: 'l1', plan: 'p', price: 20, confidence: 0.8, calibrated: 0.7, appraisal: null, ev: 20, cost: 3, at: new Date().toISOString() };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, bid.jobId, JSON.stringify({ round: open.bidsCloseAt, bid }));
  record('job.awarded', { jobId: posted.id, tier: 'normal', considered: [bid], satOut: [], chosen: bid, why: 'test', at: new Date().toISOString(), coolOffUntil: null });
  transition(open, 'awarded', { awardedBid: bid.id });
  void a;

  let started: string | null = null;
  setProvider('ollama', fakeProvider({
    work: async (i) => {
      started = i.runId;
      await new Promise<void>((resolve) => i.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { summary: 'stopped', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, ended: 'aborted' as const, reason: 'signal' };
    },
  }));
  const skipped = { name: 'install' as const, status: 'skipped' as const, detail: '', durationMs: 0, logPath: null, testsRun: null };
  const s = createScheduler({
    installDeps: async () => skipped,
    inspect: async (r) => ({ id: `i-${r.id}`, runId: r.id, jobId: r.jobId, repo: r.repo, reviewerAgentId: null, reviewerFirmId: null, checks: [], passed: true, pushable: false, design: null, cost: 0, at: new Date().toISOString() }),
    ship: async (r) => r,
    pollJobs: async () => [],
    quiet: async () => {},
    reap: async () => [],
    preflight: async () => null,
    watchMs: 0,
  });
  await s.tick();
  // Polled against the run's own state with a generous deadline, so a loaded machine never fails it.
  await until(() => !!started);
  assert.ok(started, 'the run started');
  const runId = started as string;

  assert.equal((await call('POST', '/api/runs/run-nope/kill')).status, 404);
  const killed = await call('POST', `/api/runs/${runId}/kill`);
  assert.equal(killed.status, 200);
  assert.deepEqual(killed.json, { ok: true });
  await s.idle();
  assert.equal(storedRun(runId)?.outcome, 'killed');
  assert.equal(job(posted.id)?.status, 'open', 'no attempt spent');
  assert.equal((await call('POST', `/api/runs/${runId}/kill`)).status, 409, 'a run that is not live cannot be killed');
});

// ------------------------------------------------------------------ treasury, reports, providers

test('the treasury counts the runs under way from the runs store, apart from the slots the runner holds', async () => {
  reading();
  const none = await call('GET', '/api/treasury');
  assert.deepEqual(none.json.underWay, { total: 0, claude: 0, local: 0, api: 0 });
  // A run on the books with no end, as the board and the run page see it, whether or not a lease stands behind it.
  const base = { jobId: 'job-x', bidId: 'bid-x', agentId: 'a', firmId: 'f', repo: 'acme/widgets', branch: 'b', dir: null, baseSha: null, headSha: null, stage: 'working', outcome: null, endedReason: null, progress: { turns: 0, toolCalls: 0, filesTouched: 0, linesChanged: 0, refused: 0 }, startedAt: new Date().toISOString(), prNumber: null, prUrl: null, mergeSha: null, inspectionId: null, scar: false, unattended: false };
  const putJob = openDb().prepare('INSERT INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)');
  for (const [id, status] of [['job-x', 'running'], ['job-y', 'inspecting'], ['job-z', 'merged'], ['job-w', 'waiting']]) putJob.run(id, 'acme/widgets', status, JSON.stringify({ id, repo: 'acme/widgets', status, postedAt: new Date().toISOString() }));
  const put = openDb().prepare('INSERT INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)');
  put.run('run-live-1', 'job-x', 'acme/widgets', 'working', JSON.stringify({ ...base, id: 'run-live-1', model: 'claude:sonnet', endedAt: null }));
  put.run('run-live-2', 'job-y', 'acme/widgets', 'working', JSON.stringify({ ...base, id: 'run-live-2', jobId: 'job-y', model: 'ollama:qwen2.5-coder:7b', endedAt: null }));
  put.run('run-done', 'job-z', 'acme/widgets', 'done', JSON.stringify({ ...base, id: 'run-done', jobId: 'job-z', model: 'claude:sonnet', stage: 'done', outcome: 'merged', endedAt: new Date().toISOString() }));
  put.run('run-waits', 'job-w', 'acme/widgets', 'waiting', JSON.stringify({ ...base, id: 'run-waits', jobId: 'job-w', model: 'claude:sonnet', stage: 'waiting', endedAt: null }));
  const t = await call('GET', '/api/treasury');
  assert.equal(t.status, 200, t.text.slice(0, 300));
  assert.deepEqual(t.json.underWay, { total: 2, claude: 1, local: 1, api: 0 }, 'a run whose PR waits on him is not under way');
  assert.equal(t.json.concurrency.claude, 0, 'no lease stands behind a run written to the store, and the slots say so');
});

test('treasury reports paused reasons, and resume-stale lets a stale reading carry on', async () => {
  noReading();
  const stale = await call('GET', '/api/treasury');
  assert.equal(stale.status, 200);
  assert.equal(stale.json.paused.reason, 'stale');
  assert.equal(typeof stale.json.calibration.tokensPerPct, 'number');
  assert.equal(stale.json.calibration.calibrated, false);
  addFirm('alpha');
  assert.equal(typeof stale.json.balances, 'object');
  assert.equal(typeof (await call('GET', '/api/treasury')).json.balances.alpha, 'number');

  const resumed = await call('POST', '/api/treasury/resume-stale');
  assert.equal(resumed.status, 200);
  assert.ok(getSettings().resumeStaleUntil && getSettings().resumeStaleUntil! > Date.now());
  assert.notEqual(resumed.json.paused?.reason, 'stale');

  reading();
  writeFileSync(paths().stop, 'stop\n');
  assert.equal((await call('GET', '/api/treasury')).json.paused.reason, 'stopped');
});

test('the treasury carries the hard stop, the reading, a resume, the report days and the spend by firm and model, each row reaching its credits entries', async () => {
  addFirm('alpha');
  const put = openDb().prepare('INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  const at = (ms: number) => new Date(ms).toISOString();
  const m = (model: string) => JSON.stringify({ model, pool: model.split(':')[0] === 'anthropic' ? 'api' : model.split(':')[0] });
  put.run(at(now - 60_000), 'alpha', 'run-a', 'run', 4.1, null, m('claude:sonnet'));
  put.run(at(now - 50_000), 'alpha', null, 'bid', 0.2, null, m('claude:sonnet'));
  put.run(at(now - 40_000), 'alpha', 'run-a', 'review', 2, null, m('claude:haiku'));
  put.run(at(now - 3 * 24 * HOUR), 'alpha', 'run-old', 'run', 10, null, m('ollama:qwen2.5-coder:7b'));
  put.run(at(now - 9 * 24 * HOUR), 'alpha', 'run-older', 'run', 99, null, m('claude:opus'));
  put.run(at(now - 30_000), 'alpha', null, 'pay', 50, null, '{}');

  const t = (await call('GET', '/api/treasury')).json;
  assert.equal(t.hardStopPct, 90);
  assert.equal(t.reading.stale, false);
  assert.equal(typeof t.reading.at, 'number');
  assert.equal(t.resumedUntil, null);
  assert.deepEqual(t.reports, []);
  const today = t.spend.today;
  const alphaToday = today.firms.find((f: { firmId: string }) => f.firmId === 'alpha');
  assert.equal(alphaToday.credits, 4.3, 'bids and runs, summed exactly: not the pay, not the review');
  assert.equal(alphaToday.entries, 2);
  const city = today.firms.find((f: { firmId: string | null }) => f.firmId === null);
  assert.equal(city.credits, 2, 'reviews and design checks are the city’s own cost');
  assert.equal(today.total, 6.3);
  const sonnet = today.models.find((x: { model: string }) => x.model === 'claude:sonnet');
  assert.equal(sonnet.credits, 4.3);
  assert.equal(sonnet.windowPct, 0.43);
  assert.equal(t.spend.week.firms.find((f: { firmId: string }) => f.firmId === 'alpha').credits, 14.3, 'the week holds the older run, not the one nine days back');
  assert.equal(t.spend.week.models.find((x: { model: string }) => x.model === 'ollama:qwen2.5-coder:7b').windowPct, null, 'a local model is no share of his window');

  const rows = (await call('GET', '/api/treasury/credits?period=week&firm=alpha')).json;
  assert.deepEqual(rows.rows.map((r: { kind: string }) => r.kind), ['bid', 'run', 'run'], 'its entries, newest first');
  assert.equal(rows.count, 3);
  assert.equal(rows.total, 14.3);
  assert.equal(typeof rows.rows[0].id, 'number');
  assert.equal(rows.rows[1].runId, 'run-a');
  const cityRows = (await call('GET', '/api/treasury/credits?period=today&firm=~city')).json;
  assert.deepEqual(cityRows.rows.map((r: { kind: string; model: string }) => `${r.kind} ${r.model}`), ['review claude:haiku'], 'the city’s own calls are asked for by a key no firm id can take');
  addFirm('city');
  put.run(at(now - 20_000), 'city', 'run-c', 'run', 1.5, null, m('claude:haiku'));
  assert.deepEqual((await call('GET', '/api/treasury/credits?period=today&firm=city')).json.rows.map((r: { firmId: string }) => r.firmId), ['city'], 'a firm named city is its own row, not the city');
  assert.equal((await call('GET', '/api/treasury/credits?period=today&firm=~city')).json.count, 1);
  const byModel = (await call('GET', `/api/treasury/credits?period=today&model=${encodeURIComponent('claude:sonnet')}`)).json;
  assert.equal(byModel.count, 2);
  assert.equal((await call('GET', '/api/treasury/credits?period=year')).status, 400);
  assert.equal((await call('GET', '/api/treasury/credits?period=week&firm=..%2Fx')).status, 400);

  // A stale reading resumed on his say-so says until when.
  noReading();
  assert.equal((await call('GET', '/api/treasury')).json.reading, null);
  const resumed = (await call('POST', '/api/treasury/resume-stale')).json;
  assert.ok(resumed.resumedUntil > now, 'the resume says until when it carries the city');

  mkdirSync(paths().reports, { recursive: true });
  for (const day of ['2026-11-08', '2026-11-09']) {
    writeFileSync(join(paths().reports, `${day}.md`), `# ${day}\n`);
    record('report.written', { day, path: join(paths().reports, `${day}.md`), at: new Date().toISOString(), data: { day } });
  }
  assert.deepEqual((await call('GET', '/api/treasury')).json.reports, ['2026-11-09', '2026-11-08'], 'the days with a report, newest first');
});

test('resume-stale is refused while the reading is fresh, so it can never pre-authorise a later stale pause', async () => {
  reading();
  const r = await call('POST', '/api/treasury/resume-stale');
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'not paused for a stale reading' });
  assert.equal(getSettings().resumeStaleUntil, null, 'nothing was stored');
});

test('reports serve the latest and a named day, and refuse a day that is not a day', async () => {
  assert.equal((await call('GET', '/api/report/latest')).status, 404, 'no report yet');
  mkdirSync(paths().reports, { recursive: true });
  const day = '2026-11-09';
  const file = join(paths().reports, `${day}.md`);
  writeFileSync(file, '# The day\n');
  record('report.written', { day, path: file, at: new Date().toISOString(), data: { day, jobs: [] } });
  const latest = await call('GET', '/api/report/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.day, day);
  assert.equal(latest.json.markdown, '# The day\n');
  assert.ok(!latest.text.includes(paths().reports));
  const named = await call('GET', `/api/report/${day}`);
  assert.equal(named.json.markdown, '# The day\n');
  assert.equal((await call('GET', '/api/report/2026-11-01')).status, 404);
  assert.ok([400, 404].includes((await call('GET', '/api/report/..%2F..%2Fsecret')).status));
  assert.equal((await call('GET', '/api/report/latest-day')).status, 400);
});

test('providers list the six, and quarters and the live view answer', async () => {
  addAgent('a1', 'alpha', 'claude:sonnet');
  const p = await call('GET', '/api/providers');
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.map((x: { provider: string }) => x.provider), ['claude', 'anthropic-api', 'ollama', 'openai', 'gemini', 'mlx']);
  const q = await call('GET', '/api/quarters');
  assert.equal(q.status, 200);
  assert.ok(Array.isArray(q.json));
  assert.deepEqual((await call('GET', '/api/live')).json, { sites: [], trips: [] });
});

test('the api key route never echoes the key, and says only whether one is set', async () => {
  const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOP1234';
  const stdins: string[] = [];
  // A fake keychain in memory: the stand-in file is never opened, and real security never runs.
  let stored: string | null = null;
  setSpawner((_cmd, _args, opts): Spawned => {
    const stdin = String((opts as { stdin?: string }).stdin ?? '');
    stdins.push(stdin);
    const m = / -w "([^"]+)"/.exec(stdin);
    if (m) stored = m[1];
    return { pid: 1, lines: (async function* () {})(), kill() {}, done: Promise.resolve({ code: 0, signal: null }) };
  });
  const runs: string[][] = [];
  setRunner(async (_cmd, args) => {
    runs.push(args);
    // With -w security prints the secret; without it, only the item's attributes (never the key).
    if (args[0] === 'find-generic-password') return stored ? { stdout: args.includes('-w') ? `${stored}\n` : 'keychain: "fake"\nclass: "genp"\n', stderr: '', code: 0 } : { stdout: '', stderr: 'not found', code: 44 };
    if (args[0] === 'delete-generic-password') stored = null;
    return { stdout: '', stderr: '', code: 0 };
  });

  const none = await call('GET', '/api/providers/anthropic/key');
  assert.equal(none.status, 200);
  assert.deepEqual(none.json, { set: false });
  assert.ok(runs.length > 0 && runs.every((a) => a.includes(realpathSync(fakeKc))), 'every keychain call names the stand-in keychain');

  const ok = await call('POST', '/api/providers/anthropic/key', { key: KEY });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.ok(!ok.text.includes(KEY));
  assert.ok(stdins.some((s) => s.includes(KEY)), 'the key reached the keychain command, on stdin');
  assert.ok(!JSON.stringify(entries()).includes(KEY), 'the ledger never holds it');
  assert.ok(entries().some((e) => e.kind === 'api.key.set'));

  const before = runs.length;
  const set = await call('GET', '/api/providers/anthropic/key');
  const asked = runs.slice(before);
  assert.ok(asked.length > 0 && asked.every((a) => a[0] === 'find-generic-password' && !a.includes('-w')), `the GET asks only whether the item exists, never for the secret (${JSON.stringify(asked)})`);
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { set: true }, 'only whether a key is stored, never the key');
  assert.ok(!set.text.includes(KEY) && !set.text.includes('sk-ant'));
  for (const path of ['/api/providers', '/api/settings']) assert.ok(!(await call('GET', path)).text.includes(KEY), `${path} never carries the key`);

  const bad = await call('POST', '/api/providers/anthropic/key', { key: 'not a key sk-ant-' });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes('not a key'));
  assert.equal((await call('POST', '/api/providers/anthropic/key', {})).status, 400);
  assert.equal((await call('POST', '/api/providers/anthropic/key', { key: 5 })).status, 400);

  const gone = await call('DELETE', '/api/providers/anthropic/key');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json, { ok: true });
  assert.ok(runs.some((a) => a[0] === 'delete-generic-password'));
  assert.ok(entries().some((e) => e.kind === 'api.key.removed'));
  assert.deepEqual((await call('GET', '/api/providers/anthropic/key')).json, { set: false }, 'cleared, it reads as not set');
  const gets = runs.filter((a) => a[0] === 'find-generic-password');
  assert.ok(gets.every((a) => !a.includes('-w')), 'no GET ever read the key itself');
});

// ------------------------------------------------------------------ repos and settings

test('repo resume clears a halt, reopens its jobs and leaves a job with an open PR waiting', async () => {
  repoOf();
  const prOpen = postJob(['**']);
  let w = openBidding(prOpen, Date.now());
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) w = transition(w, to);
  const open = postJob(['**']);
  haltRepo(FULL, 'three failed inspections');
  assert.equal(job(prOpen.id)?.status, 'halted');
  assert.equal(job(open.id)?.status, 'halted');
  assert.equal(getRepo(FULL)!.halted?.reason, 'three failed inspections');

  assert.equal((await call('POST', '/api/repos/acme/nothing/resume')).status, 404);
  assert.equal((await call('POST', `/api/repos/${FULL}/resume`)).status, 200);
  assert.equal((await call('POST', `/api/repos/${FULL}/resume`)).status, 409, 'a repo that is not halted');
  haltRepo(FULL, 'three failed inspections');
  assert.equal((await call('POST', '/api/repos/-bad/x/resume')).status, 400);
  const r = await call('POST', `/api/repos/${FULL}/resume`);
  assert.equal(r.status, 200);
  assert.equal(r.json.halted, null);
  assert.equal(r.json.strikes, 0);
  assert.equal(job(prOpen.id)?.status, 'waiting', 'its PR is still open: never re-bid');
  assert.equal(job(open.id)?.status, 'open');
  assert.ok(entries().some((e) => e.kind === 'repo.resumed'));
});

test('a single halted job resumes by itself, per ruling 30, and not while its repo is halted', async () => {
  repoOf();
  const a = postJob(['**']);
  const waiting = postJob(['**']);
  let w = openBidding(waiting, Date.now());
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) w = transition(w, to);
  transition(job(a.id)!, 'halted');
  transition(job(waiting.id)!, 'halted');
  openDb().prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify({ ...job(a.id)!, inconclusive: 2, haltNote: 'needs a reviewer' }), a.id);

  const one = await call('POST', `/api/jobs/${a.id}/resume`);
  assert.equal(one.status, 200);
  assert.equal(one.json.status, 'open');
  assert.equal(one.json.inconclusive, 0);
  assert.equal(one.json.haltNote, null);
  const two = await call('POST', `/api/jobs/${waiting.id}/resume`);
  assert.equal(two.json.status, 'waiting');
  assert.equal((await call('POST', `/api/jobs/${a.id}/resume`)).status, 409, 'it is not halted any more');

  haltRepo(FULL, 'reverted merge');
  assert.equal((await call('POST', `/api/jobs/${a.id}/resume`)).status, 409, 'the repo is halted: resume the repo first');
});

test('a repo patch takes market, label and checks, validates them, and refuses push mode without a test and a build command', async () => {
  repoOf();
  const base = `/api/repos/${FULL}`;
  const m = await call('PATCH', base, { market: true, label: 'city' });
  assert.equal(m.status, 200);
  assert.equal(m.json.market, true);
  assert.equal(m.json.label, 'city');
  assert.equal((await call('PATCH', base, { market: 'yes' })).status, 400);
  assert.equal((await call('PATCH', base, { label: 'has space' })).status, 400);
  assert.equal((await call('PATCH', base, { label: 5 })).status, 400);
  assert.equal((await call('PATCH', base, { checks: { rm: 'rf' } })).status, 400, 'an unknown check key');
  assert.equal((await call('PATCH', base, { checks: { test: 5 } })).status, 400);
  assert.equal((await call('PATCH', base, { checks: { test: 'a\nb' } })).status, 400);
  assert.equal((await call('PATCH', base, { checks: { preview: { kind: 'vite', outDir: '../../etc' } } })).status, 400);
  assert.equal((await call('PATCH', base, { checks: { shots: ['about'] } })).status, 400, 'a route starts with a slash');
  assert.equal((await call('PATCH', base, { checks: { shots: ['/a\\b'] } })).status, 400, 'a route holds no backslash');
  assert.equal((await call('PATCH', base, { checks: { shots: ['/\\evil.example'] } })).status, 400, 'nor a backslash that would read as another host');
  assert.equal((await call('PATCH', base, { checks: { ecosystems: ['cobol'] } })).status, 400);

  // Ruling 23, server side too: no push mode while a test or a build command is missing.
  const refused = await call('PATCH', base, { pushMode: true });
  assert.equal(refused.status, 409);
  assert.equal(getRepo(FULL)!.pushMode, false);
  const half = await call('PATCH', base, { pushMode: true, checks: { test: 'npm test' } });
  assert.equal(half.status, 409, 'a test command alone is not enough');
  assert.equal(getRepo(FULL)!.checks?.test ?? null, null, 'a refused patch changes nothing');

  const both = await call('PATCH', base, { checks: { test: 'npm test', build: 'npm run build', preview: { kind: 'vite', outDir: 'dist' }, shots: ['/', '/about'], ecosystems: ['npm'] } });
  assert.equal(both.status, 200);
  assert.equal(both.json.checks.test, 'npm test');
  assert.equal(both.json.checks.detected, false, 'commands set by hand are kept across re-analysis');
  const on = await call('PATCH', base, { pushMode: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.pushMode, true);
  assert.equal((await call('PATCH', base, { checks: { build: null } })).status, 409, 'push mode on: the build command cannot be removed');
  assert.equal((await call('PATCH', base, { pushMode: false, checks: { build: null } })).status, 200);
});

test('settings validate concurrency, the bid window, the hard stop, the API budget and keep awake', async () => {
  const patch = (b: unknown) => call('PATCH', '/api/settings', b);
  for (const bad of [
    { claudeConcurrency: 0 }, { claudeConcurrency: 5 }, { claudeConcurrency: 1.5 }, { claudeConcurrency: '2' },
    { localConcurrency: 0 }, { localConcurrency: 5 },
    { bidWindowSec: 29 }, { bidWindowSec: 601 },
    { hardStopPct: 49 }, { hardStopPct: 96 },
    { anthropicApi: { dailyUsd: -1 } }, { anthropicApi: { dailyUsd: 101 } }, { anthropicApi: { enabled: 'on' } }, { anthropicApi: { other: 1 } }, { anthropicApi: 5 },
    { keepAwake: 'yes' },
    { ollamaHost: 'evil.example:11434' },
    { resumeStaleUntil: 5 },
  ]) {
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(getSettings().claudeConcurrency, 2, 'a refused patch changes nothing');
  const ok = await patch({ claudeConcurrency: 4, localConcurrency: 1, bidWindowSec: 30, hardStopPct: 95, keepAwake: true, anthropicApi: { dailyUsd: 100 }, quality: 'medium' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.claudeConcurrency, 4);
  assert.equal(ok.json.bidWindowSec, 30);
  assert.equal(ok.json.hardStopPct, 95);
  assert.equal(ok.json.keepAwake, true);
  assert.deepEqual(ok.json.anthropicApi, { enabled: false, dailyUsd: 100 }, 'a nested patch keeps the other key');
  const more = await patch({ anthropicApi: { enabled: true }, bidWindowSec: 600, hardStopPct: 50 });
  assert.deepEqual(more.json.anthropicApi, { enabled: true, dailyUsd: 100 });
  assert.equal(more.json.bidWindowSec, 600);
});

// ------------------------------------------------------------------ the event stream and the front door

/** Resolves once `cond` holds, polling every few milliseconds; throws past `ms` (generous, for a loaded machine). */
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the state');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Opens the event stream; once it says it is connected, `onReady` runs; resolves with the text once `done` says stop. */
function listen(s: StartedServer, onReady: () => void, done: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let armed = false;
    let timer: NodeJS.Timeout | null = null;
    const req = httpRequest({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
        if (!armed && text.includes(': connected')) {
          armed = true;
          onReady();
        }
        if (done(text)) {
          if (timer) clearTimeout(timer);
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
    // A generous deadline; on it the stream is closed too, so a missed event never leaves a socket holding the run open.
    timer = setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for the event'));
    }, 30_000);
    timer.unref();
  });
}

test('SSE forwards run.stage and the other market events, without a run dir or a secret', async () => {
  const s = await start();
  const text = await listen(s, () => {
    emit('run.stage', { runId: 'run-1', stage: 'working' });
    emit('run.started', { run: { id: 'run-1', dir: `${paths().runs}/run-1/work`, summary: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    emit('run.log', { runId: 'run-1', line: { at: 'x', kind: 'tool', text: `cd ${paths().runs}/run-1` } });
    emit('firm.bankrupt', { firmId: 'alpha' });
    emit('trip.started', { trip: { id: 't1' } });
    emit('floor.lit', { floor: { id: 'f1' } });
  }, (t) => t.includes('event: floor.lit'));
  assert.match(text, /event: run\.stage\ndata: \{"runId":"run-1","stage":"working"\}/);
  for (const type of ['run.started', 'run.log', 'firm.bankrupt', 'trip.started', 'floor.lit']) assert.ok(text.includes(`event: ${type}\n`), type);
  assert.ok(!text.includes(paths().runs), 'no home path in the stream');
  assert.ok(!text.includes('ghp_abcdefgh'), 'no token in the stream');
  assert.ok(!text.includes('/work'), 'a run dir is dropped');
});

test('the market routes keep the Host, Origin and header checks', async () => {
  const s = await start();
  const raw = (headers: Record<string, string>, method = 'GET', path = '/api/jobs'): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: s.port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await raw({ host: 'evil.example' }), 403, 'a foreign Host is refused (DNS rebinding)');
  assert.equal(await raw({ host: `127.0.0.1:${s.port}`, origin: 'https://evil.example' }), 403, 'a foreign Origin is refused');
  assert.equal(await raw({ host: `127.0.0.1:${s.port}`, origin: 'https://evil.example', 'x-palimpsest': '1' }, 'POST', '/api/runs/x/kill'), 403);
  assert.equal(await raw({ host: `127.0.0.1:${s.port}` }, 'POST', '/api/treasury/resume-stale'), 403, 'a write needs the header');
  assert.equal(await raw({ host: `127.0.0.1:${s.port}` }, 'DELETE', '/api/providers/anthropic/key'), 403);
  assert.equal(await raw({ host: `127.0.0.1:${s.port}` }), 200);
});

test('a request body over 1 MB is refused with 413 before it is buffered', async () => {
  repoOf();
  const big = JSON.stringify({ repo: FULL, title: 'x', body: 'y'.repeat(1024 * 1024 + 10) });
  const s = await start();
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: s.port, path: '/api/jobs', method: 'POST', headers: { host: `127.0.0.1:${s.port}`, 'x-palimpsest': '1', 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'EPIPE' || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
    req.end(big);
  });
  assert.equal(status, 413);
  assert.equal((await call('POST', '/api/jobs', { repo: FULL, title: 'fine' })).status, 201, 'the engine is still serving');
});

test('what reaches the page is redacted without cutting ordinary text: a token and a home path go, "~50%" and a long slug stay', async () => {
  repoOf();
  const slug = 'a-very-long-hyphenated-slug-name-for-a-feature-branch-that-goes-on-and-on';
  const made = await call('POST', '/api/jobs', {
    repo: FULL,
    title: `Raise ~50% of ${slug}`,
    body: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and /Users/someone/secret/file.txt and ~/notes and AbCdEf0123456789AbCdEf0123456789AbCdEf0123 here.',
  });
  assert.equal(made.status, 201);
  const got = await call('GET', `/api/jobs/${made.json.id}`);
  assert.equal(got.json.job.title, `Raise ~50% of ${slug}`);
  assert.ok(!got.text.includes('ghp_abcdefgh'));
  assert.ok(!got.text.includes('/Users/someone'));
  assert.ok(!got.text.includes('~/notes'));
  assert.ok(!got.text.includes('AbCdEf0123456789AbCdEf0123456789'), 'a mixed-case digit run of token length is redacted');
  const list = await call('GET', '/api/jobs');
  assert.ok(!list.text.includes('ghp_abcdefgh'));

  mkdirSync(paths().reports, { recursive: true });
  const file = join(paths().reports, '2026-11-08.md');
  writeFileSync(file, 'Lead\nsk-ant-api03-ABCDEFGHIJKLMNOP1234 in /Users/someone/x\n');
  record('report.written', { day: '2026-11-08', path: file, at: new Date().toISOString(), data: { day: '2026-11-08' } });
  const rep = await call('GET', '/api/report/2026-11-08');
  assert.ok(!rep.text.includes('sk-ant-api03') && !rep.text.includes('/Users/someone'));
  assert.ok(rep.json.markdown.startsWith('Lead\n'), 'line breaks are kept');
});

test('a run log over 16 MB answers its last page of lines, and a diff has home paths taken out but is otherwise raw', async () => {
  const repo = repoOf();
  const a = addAgent('a1', 'alpha', 'claude:sonnet');
  const j = postJob(['**']);
  const { run } = await makeRun(repo, j, a, (dir) => write(dir, 'a.txt', 'a\n'));
  const runRoot = join(paths().runs, run.id);
  const line = JSON.stringify({ at: 'x', kind: 'engine', text: 'z'.repeat(1000) + ' L' });
  const n = Math.ceil((17 * 1024 * 1024) / (line.length + 1));
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(i === n - 1 ? JSON.stringify({ at: 'x', kind: 'engine', text: 'the last line' }) : line);
  writeFileSync(join(runRoot, 'log.jsonl'), lines.join('\n') + '\n');
  const got = await call('GET', `/api/runs/${run.id}/log?since=0`);
  assert.equal(got.status, 200);
  assert.ok(got.json.length > 0 && got.json.length <= 2000);
  assert.equal(got.json.at(-1).text, 'the last line');

  writeFileSync(join(runRoot, 'diff.patch'), `+const home = "${process.env.HOME}/secret";\n+const sha = "0123456789abcdef0123456789abcdef01234567";\n`);
  const d = await call('GET', `/api/runs/${run.id}/diff`);
  assert.ok(!d.text.includes(String(process.env.HOME) + '/secret'));
  assert.ok(d.text.includes('0123456789abcdef0123456789abcdef01234567'), 'code is otherwise raw');
});
