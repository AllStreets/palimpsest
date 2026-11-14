/**
 * Replay (Task 18): the ledger alone rebuilds the market, down to firms,
 * agents and each run's diff. Every model call is the fake provider (test
 * safety rule 6); gh is a fake runner and GitHub is a temp bare repo (rule
 * 5); the home is a temp dir with the sandbox off (rule 7).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { mirrorDir } from '../engine/mirror.js';
import { inspect } from '../engine/guild/inspect.js';
import { charge } from '../engine/market/budget.js';
import { fakeDefaults, fakeProvider } from '../engine/market/fake-provider.js';
import { agent, hire, listAgents, retireAgent, retireFirm, reviveAgents, seedFirms, sellTower } from '../engine/market/firms.js';
import { job as storedJob, postManualJob, proposeHarnessJob } from '../engine/market/jobs.js';
import { setProvider } from '../engine/market/providers.js';
import { createScheduler, listRuns, run as storedRun, type SchedulerDeps } from '../engine/market/runs.js';
import { pollPRs, PR_POLL_MS, resetShipping } from '../engine/market/ship.js';
import { balances, installTreasury, settle } from '../engine/market/treasury.js';
import { replay, verifyReplay } from '../engine/market/replay.js';
import { earnedFloors } from '../engine/repos.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { ArenaInfo, Audit, CheckResult, Decision, Grant, Graduate, Milestone, NetVersion, Prediction, Repo, TrainState, VoyageView } from '../shared/types.js';
import { checks, FULL, git, setUp, tearDown, tempDir } from './guild-fixtures.js';

let prStates = new Map<number, object>();
let offTreasury: () => void = () => {};

const fakeGh: Runner = async (cmd, args, opts) => {
  if (cmd === 'gh') {
    if (args[0] === 'pr' && args[1] === 'create') return { stdout: `https://github.com/${FULL}/pull/12\n`, stderr: '', code: 0 };
    if (args[0] === 'pr' && args[1] === 'view') {
      const s = prStates.get(Number(args[2])) ?? { state: 'OPEN', mergedAt: null, mergeCommit: null, closedAt: null };
      return { stdout: JSON.stringify(s), stderr: '', code: 0 };
    }
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  return realRunner(cmd, args, opts);
};

beforeEach(() => {
  setUp('replay');
  resetShipping();
  prStates = new Map();
  setRunner(fakeGh);
  offTreasury = installTreasury();
});

afterEach(async () => {
  offTreasury();
  setRunner(realRunner);
  await tearDown();
});

/** A connected repo with the market on; GitHub is a temp bare repo the mirror was cloned from. */
function makeRemoteRepo(c = checks()): Repo {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
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
    checks: c,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'origin-work');
  mkdirSync(join(work, 'src'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'widgets\n');
  writeFileSync(join(work, 'src', 'header.ts'), 'export const header = 1;\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  const remote = join(tempDir, 'github', 'acme__widgets.git');
  mkdirSync(join(tempDir, 'github'), { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', work, remote);
  mkdirSync(paths().mirrors, { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', remote, mirrorDir(FULL));
  return repo;
}

const skipped: CheckResult = { name: 'install', status: 'skipped', detail: 'Nothing to install.', durationMs: 0, logPath: null, testsRun: null };

function useFake(): void {
  const p = fakeProvider({ plan: (i) => ({ ...fakeDefaults.plan(i), price: 12, confidence: 0.8 }) });
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, p);
}

function deps(over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    installDeps: async () => skipped,
    inspect,
    ship: undefined as unknown as SchedulerDeps['ship'],
    pollJobs: async () => [],
    quiet: async () => {},
    reap: async () => [],
    preflight: async () => null,
    watchMs: 0,
    ...over,
  };
}

/** Post a job and let the scheduler take it through bids, award and the run, to its waiting PR. */
async function runToWaiting(d: SchedulerDeps) {
  const posted = postManualJob({ repo: FULL, title: 'Fix the header', body: 'Change `src/header.ts` so the header reads 2.', tier: 'normal', scope: ['src/**'] });
  const s = createScheduler(d);
  await s.tick();
  await s.idle();
  await s.tick();
  await s.idle();
  const [r] = listRuns({ jobId: posted.id });
  assert.ok(r, 'a run started');
  return { posted, run: storedRun(r.id)! };
}

test('a full fake run (post, bid, award, install, run, inspect, ship, merge) replays to the stored state', { timeout: 120_000 }, async () => {
  seedFirms([]);
  useFake();
  makeRemoteRepo();
  const d = deps();
  delete (d as Partial<SchedulerDeps>).ship;
  const { posted, run } = await runToWaiting(d);
  assert.equal(run.stage, 'waiting', run.endedReason ?? '');
  assert.equal(run.prNumber, 12);

  prStates.set(12, { state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z', mergeCommit: { oid: 'a'.repeat(40) }, closedAt: '2026-11-10T12:00:00Z', headRefOid: run.headSha, baseRefName: 'main' });
  await pollPRs(Date.now() + PR_POLL_MS);
  settle();
  assert.equal(storedJob(posted.id)?.status, 'merged');

  const v = verifyReplay();
  assert.deepEqual(v.diffs, []);
  assert.equal(v.ok, true);

  const state = replay(entries());
  assert.equal(state.jobs[posted.id].status, 'merged');
  assert.equal(state.runs[run.id].outcome, 'merged');
  assert.equal(state.runs[run.id].mergeSha, 'a'.repeat(40));
  assert.ok(state.inspections[run.inspectionId!]?.passed, 'the inspection is replayed');
  assert.ok(Object.values(state.bids).some((b) => b.id === storedJob(posted.id)?.awardedBid), 'the winning bid is replayed');
  assert.equal(state.floors[`${FULL}#founding`][0].earned?.state, 'lit');
  assert.deepEqual(state.floors[`${FULL}#founding`], earnedFloors(`${FULL}#founding`));
  // The money: the winner was paid and every bid and run cost settled; the ledger agrees with the credits rows.
  const b = balances();
  for (const [firmId, bal] of Object.entries(state.balances)) assert.equal(bal, b[firmId], firmId);
  assert.ok(Object.values(state.firms).some((f) => f.balance > 300), 'the winner holds its pay');
});

test('replay rebuilds firms and agents with nothing in the firms table', () => {
  const t0 = new Date('2026-11-09T10:00:00.000Z');
  seedFirms([], t0);
  reviveAgents(['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b', 'qwen3:1.7b']);
  const hired = hire('quickset', t0);
  assert.ok(hired, 'a specialist was hired');
  retireAgent('priya-rao', 'retired by hand', t0);
  retireFirm('kiln', t0);
  const kilnTower = listAgents('kiln')[0];
  assert.ok(sellTower(kilnTower.id, 'meridian', 30), 'the dark tower sold');
  // Money moves through the treasury: a bid cost settles into the ledger and the books.
  charge({ runId: null, firmId: 'quickset', model: 'claude:haiku', kind: 'bid', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 7.25 });
  settle();
  assert.equal(agent(kilnTower.id)?.firmId, 'kiln');

  const table = (name: 'firms' | 'agents') =>
    Object.fromEntries((openDb().prepare(`SELECT id, json FROM ${name}`).all() as Array<{ id: string; json: string }>).map((r) => [r.id, JSON.parse(r.json)]));
  const firms = table('firms');
  const agents = table('agents');
  assert.ok(Object.values(agents).some((a) => (a as { soldTo?: string }).soldTo === 'meridian'));
  assert.equal(firms.quickset.balance, 300 - 7.25);

  openDb().exec('DELETE FROM firms; DELETE FROM agents;');
  const state = replay(entries());
  assert.deepEqual(state.firms, firms);
  assert.deepEqual(state.agents, agents);

  const v = verifyReplay();
  assert.equal(v.ok, false, 'the tables no longer hold what the ledger says');
  assert.ok(v.diffs.some((x) => /firm quickset/.test(x)), v.diffs.join('\n'));
  assert.ok(v.diffs.some((x) => /agent ines-ashlar/.test(x)), v.diffs.join('\n'));
});

test("replay restores each run's diff hash and files", { timeout: 60_000 }, async () => {
  seedFirms([]);
  useFake();
  const repo = makeRemoteRepo();
  proposeHarnessJob(repo);
  const d = deps({
    inspect: async (r) => ({ id: `insp-${r.id}`, runId: r.id, jobId: r.jobId, repo: r.repo, reviewerAgentId: null, reviewerFirmId: null, checks: [], passed: false, pushable: false, design: null, cost: 0, at: new Date().toISOString() }),
    ship: async () => {
      throw new Error('nothing ships');
    },
  });
  const { run } = await runToWaiting(d);
  assert.equal(run.outcome, 'failed');

  const state = replay(entries());
  const diff = state.diffs[run.id];
  assert.ok(diff, 'the run has a diff');
  assert.deepEqual(diff.files, ['src/header.ts']);
  assert.equal(diff.headSha, run.headSha);
  assert.equal(diff.baseSha, run.baseSha);
  assert.ok(diff.lines > 0);
  const patch = readFileSync(diff.patchPath as string, "utf8");
  assert.equal(diff.sha256, createHash('sha256').update(patch).digest('hex'), 'the hash is the kept patch');
  assert.equal(state.runs[run.id].headSha, run.headSha);
  assert.equal(state.runs[run.id].scar, true);
  assert.equal(state.floors[`${FULL}#founding`][0].earned?.state, 'scar');
  assert.deepEqual(verifyReplay().diffs, []);
});

test('replay rebuilds an audit and a milestone from their entries and verifyReplay compares them', () => {
  const started: Audit = {
    id: 'audit-1',
    repo: FULL,
    model: 'claude:sonnet',
    trigger: 'connect',
    baseSha: 'b'.repeat(40),
    status: 'reading',
    waitingReason: null,
    startedAt: '2026-11-10T08:00:00.000Z',
    endedAt: null,
    endedReason: null,
    findings: [],
    counts: { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 },
    unverified: 0,
    claimsRead: 0,
    credits: 0,
    unattended: false,
    markdownPath: null,
  };
  const ended: Audit = {
    ...started,
    status: 'done',
    endedAt: '2026-11-10T08:09:00.000Z',
    endedReason: null,
    findings: [
      {
        id: 'f1',
        claim: 'Supports hot reload',
        source: { file: 'README.md', line: 12 },
        verdict: 'MISSING',
        tested: false,
        evidence: [{ file: 'src/server.ts', line: 40, note: 'the dev server has no watcher', verified: true }],
        unverified: false,
        proposal: { key: `${FULL}#1299ebc1ff22`, title: 'Add hot reload to the dev server', body: 'Build it.', scope: ['src/**'], acceptance: ['edits reload'], tier: 'normal', jobId: null },
      },
    ],
    counts: { REAL: 0, PARTIAL: 0, MISSING: 1, STUBBED: 0, BROKEN: 0 },
    claimsRead: 1,
    credits: 4.5,
    markdownPath: join(paths().reports, 'audits', 'acme-widgets-audit-1.md'),
  };
  const milestone: Milestone = {
    id: `skyline:${FULL}#founding`,
    kind: 'skyline',
    towerId: `${FULL}#founding`,
    repo: FULL,
    firmId: null,
    agentId: null,
    floorId: `${FULL}#job-1`,
    at: '2026-11-10T09:00:00.000Z',
    until: null,
    lit: true,
    title: 'The skyline',
    detail: 'widgets stands tallest above its datum.',
  };
  record('audit.started', { audit: started });
  record('audit.stage', { auditId: started.id, status: 'reading' });
  record('audit.ended', { audit: ended });
  record('milestone.reached', { milestone });
  record('brief.opened', { day: '2026-11-11', items: ['audit:audit-1', 'milestone:' + milestone.id] });
  record('brief.action', { day: '2026-11-11', itemId: 'audit:audit-1', kind: 'audit', action: 'why', taught: false, at: '2026-11-11T08:00:00.000Z', patch: null });

  const state = replay(entries());
  assert.deepEqual(state.audits[started.id], ended);
  assert.deepEqual(state.milestones[milestone.id], milestone);

  const db = openDb();
  db.prepare('INSERT INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)').run(ended.id, ended.repo, ended.status, ended.startedAt, JSON.stringify(ended));
  db.prepare('INSERT INTO milestones (id, kind, tower_id, at, until, json) VALUES (?, ?, ?, ?, ?, ?)').run(milestone.id, milestone.kind, milestone.towerId, milestone.at, milestone.until, JSON.stringify(milestone));
  const ok = verifyReplay();
  assert.deepEqual(ok.diffs, []);
  assert.equal(ok.ok, true);

  // Dropped rows: the ledger still says they exist.
  db.exec('DELETE FROM audits; DELETE FROM milestones;');
  const dropped = verifyReplay();
  assert.equal(dropped.ok, false);
  assert.ok(dropped.diffs.some((x) => /^audit audit-1: in the ledger but not in the tables/.test(x)), dropped.diffs.join('\n'));
  assert.ok(dropped.diffs.some((x) => /^milestone skyline:.*in the ledger but not in the tables/.test(x)), dropped.diffs.join('\n'));

  // A corrupt row: the tables disagree with the ledger.
  db.prepare('INSERT INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)').run(ended.id, ended.repo, ended.status, ended.startedAt, JSON.stringify({ ...ended, credits: 99 }));
  db.prepare('INSERT INTO milestones (id, kind, tower_id, at, until, json) VALUES (?, ?, ?, ?, ?, ?)').run(milestone.id, milestone.kind, milestone.towerId, milestone.at, milestone.until, JSON.stringify({ ...milestone, lit: false }));
  const corrupt = verifyReplay();
  assert.equal(corrupt.ok, false);
  assert.ok(corrupt.diffs.some((x) => /^audit audit-1: the tables hold/.test(x)), corrupt.diffs.join('\n'));
  assert.ok(corrupt.diffs.some((x) => /^milestone skyline:.*the tables hold/.test(x)), corrupt.diffs.join('\n'));
});

test('replay applies an audit stage only for a known status, and takes the model, base sha and unattended flag it carries', () => {
  const waiting: Audit = {
    id: 'audit-2',
    repo: FULL,
    model: null,
    trigger: 'connect',
    baseSha: null,
    status: 'waiting',
    waitingReason: null,
    startedAt: '2026-11-10T08:00:00.000Z',
    endedAt: null,
    endedReason: null,
    findings: [],
    counts: { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 },
    unverified: 0,
    claimsRead: 0,
    credits: 0,
    unattended: false,
    markdownPath: null,
  };
  record('audit.started', { audit: waiting });
  record('audit.stage', { auditId: waiting.id, status: 'bogus', waitingReason: 'nonsense' });
  assert.equal(replay(entries()).audits[waiting.id].status, 'waiting');
  assert.equal(replay(entries()).audits[waiting.id].waitingReason, null, 'a stage with an unknown status is ignored whole');
  record('audit.stage', { auditId: waiting.id, status: 'preparing', waitingReason: null, model: 'claude:sonnet', unattended: true });
  record('audit.stage', { auditId: waiting.id, status: 'installing', baseSha: 'c'.repeat(40) });
  const a = replay(entries()).audits[waiting.id];
  assert.equal(a.status, 'installing');
  assert.equal(a.model, 'claude:sonnet');
  assert.equal(a.baseSha, 'c'.repeat(40));
  assert.equal(a.unattended, true);
  openDb().prepare('INSERT INTO audits (id, repo, status, started_at, json) VALUES (?, ?, ?, ?, ?)').run(a.id, a.repo, a.status, a.startedAt, JSON.stringify(a));
  assert.deepEqual(verifyReplay().diffs, []);
});

// ---------------------------------------------------------------- Phase 4: the school's tables

test('replay rebuilds each school table and verifyReplay flags a corrupted grant row', () => {
  const iv = (value: number, n = 20) => ({ value, lo: value - 0.05, hi: value + 0.05, n });
  const net = (version: number, trusted: boolean): NetVersion => ({
    net: 'master',
    version,
    at: `2026-11-1${version}T02:00:00.000Z`,
    rows: { train: 40, heldOut: 10, distilled: 0 },
    metric: 'brier',
    score: iv(0.1),
    baseline: iv(0.2),
    vsBaseline: { diff: -0.1, lo: -0.15, hi: trusted ? -0.02 : 0.03 },
    agreement: iv(0.9, 10),
    trusted,
    current: version === 1,
    seconds: 3,
    path: join(paths().school, 'nets', 'master', `v${version}.json`),
  });
  record('school.enabled', { enabled: true, at: '2026-11-10T00:00:00.000Z' });
  // As nets.ts records them: the version whole under `version`, beside `skewed` and `trainId`.
  record('net.trained', { version: net(1, false), skewed: [], trainId: 'train-n1' });
  record('net.trained', { version: net(2, true), skewed: ['propose:harness'], trainId: 'train-n2' });
  record('net.promoted', { net: 'master', version: 2, from: 1, trusted: true, at: '2026-11-12T02:01:00.000Z' });

  const predicted = { key: 'merge:low:job-1', kind: 'merge:low', repo: FULL, jobId: 'job-1', p: 0.93, version: 2, reason: null, at: '2026-11-12T03:00:00.000Z' } as const;
  const predictionId = record('master.predicted', predicted);
  const prediction: Prediction = { id: predictionId, ...predicted };
  const approve: Decision = { key: 'merge:low:job-1', kind: 'merge:low', repo: FULL, jobId: 'job-1', approved: true, by: 'merge', predictionId, agreed: true, at: '2026-11-12T09:00:00.000Z' };
  const revert: Decision = { ...approve, approved: false, by: 'revert', agreed: false, at: '2026-11-13T09:00:00.000Z' };
  record('decision.resolved', approve);
  record('decision.resolved', revert);

  const asked: Grant = { kind: 'merge:low', repo: FULL, state: 'asked', at: '2026-11-12T04:00:00.000Z', by: 'school', rate: iv(0.96, 50), reason: null, acted: 0, quietUntil: null };
  const granted: Grant = { ...asked, state: 'granted', at: '2026-11-12T08:00:00.000Z', by: 'him' };
  const acted: Grant = { ...granted, acted: 1 };
  record('autonomy.asked', { grant: asked });
  record('autonomy.granted', { grant: granted });
  record('autonomy.acted', { kind: 'merge:low', repo: FULL, jobId: 'job-2', key: 'merge:low:job-2', phase: 'before', grant: acted });
  record('autonomy.acted', { kind: 'merge:low', repo: FULL, jobId: 'job-2', key: 'merge:low:job-2', phase: 'after', ok: true });

  const building: ArenaInfo = { id: 'arena-1', repo: FULL, kind: 'planted', sha: 'a'.repeat(40), tasks: { breeding: 0, race: 0, sealed: 0 }, candidates: 0, kept: 0, sealedUses: 0, sealedHash: null, builtAt: '2026-11-12T01:00:00.000Z', status: 'building', reason: null };
  const ready: ArenaInfo = { ...building, tasks: { breeding: 30, race: 12, sealed: 8 }, candidates: 120, kept: 50, sealedHash: 'f'.repeat(64), status: 'ready' };
  record('arena.built', { arena: building });
  record('arena.built', { arena: ready });

  const sailing: VoyageView = { id: 'voyage-1', arena: 'arena-1', status: 'sailing', generation: 0, of: 4, runs: { done: 0, of: 500 }, commissionedBy: 'quickset', scores: [], promoted: [], sealed: null, credits: 0, startedAt: '2026-11-12T01:10:00.000Z', endedAt: null };
  const done: VoyageView = { ...sailing, status: 'done', generation: 4, runs: { done: 500, of: 500 }, sealed: iv(0.7, 8), credits: 42, endedAt: '2026-11-14T05:00:00.000Z' };
  record('voyage.commissioned', { voyageId: 'voyage-1', firmId: 'quickset', fee: 120 });
  record('voyage.started', { voyage: sailing });
  record('voyage.generation', { voyage: { ...sailing, generation: 1, runs: { done: 125, of: 500 } } });
  // A champion's sealed race spends one use of the arena's sealed split.
  record('voyage.ended', { voyage: done, arena: { ...ready, sealedUses: 1 } });

  const running: TrainState = { id: 'train-1', kind: 'lora', status: 'running', reason: null, startedAt: '2026-11-12T01:20:00.000Z', endedAt: null, seconds: 0, steps: { done: 0, of: 600, lost: 0, optimizerReset: false }, credits: 0 };
  const paused: TrainState = { ...running, status: 'paused', reason: 'on battery', seconds: 900, steps: { done: 120, of: 600, lost: 20, optimizerReset: false }, credits: 3 };
  record('train.started', { train: running });
  record('train.paused', { train: paused });

  const graduate: Graduate = { id: 'grad-1', model: 'mlx:grad-qwen25-coder-7b-1', base: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', loraId: 'lora-1', sealed: iv(0.6, 8), baseSealed: iv(0.4, 8), vsBase: { diff: 0.2, lo: 0.05, hi: 0.35 }, examples: 120, arenas: ['arena-1'], at: '2026-11-15T05:00:00.000Z', agentId: null };
  record('graduate.made', { graduate, arenas: [{ ...ready, sealedUses: 2 }] });
  record('merge.followup', { jobId: 'job-1', runId: 'run-1', repo: FULL, floorId: 'f1', mergeSha: 'b'.repeat(40), fixSha: 'c'.repeat(40), files: ['src/a.ts'], at: '2026-11-13T00:00:00.000Z' });

  const state = replay(entries());
  assert.deepEqual(state.nets['master v1'], { ...net(1, false), current: false });
  assert.deepEqual(state.nets['master v2'], { ...net(2, true), current: true });
  assert.deepEqual(state.predictions[prediction.key], prediction);
  assert.deepEqual(state.decisions, [approve, revert]);
  assert.deepEqual(state.grants[`merge:low ${FULL}`], acted);
  assert.deepEqual(state.arenas['arena-1'], { ...ready, sealedUses: 2 });
  assert.deepEqual(state.voyages['voyage-1'], done);
  assert.deepEqual(state.trains['train-1'], paused);
  assert.deepEqual(state.graduates['grad-1'], graduate);

  // The tables as the school's writers keep them.
  const db = openDb();
  const putNet = db.prepare('INSERT INTO nets (net, version, at, current, json) VALUES (?, ?, ?, ?, ?)');
  for (const v of [{ ...net(1, false), current: false }, { ...net(2, true), current: true }]) putNet.run(v.net, v.version, v.at, v.current ? 1 : 0, JSON.stringify(v));
  db.prepare('INSERT INTO predictions (id, key, kind, repo, at, json) VALUES (?, ?, ?, ?, ?, ?)').run(prediction.id, prediction.key, prediction.kind, prediction.repo, prediction.at, JSON.stringify(prediction));
  const putDecision = db.prepare('INSERT INTO decisions (key, at, kind, repo, json) VALUES (?, ?, ?, ?, ?)');
  for (const d of [approve, revert]) putDecision.run(d.key, d.at, d.kind, d.repo, JSON.stringify(d));
  db.prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)').run(acted.kind, acted.repo, acted.state, acted.at, JSON.stringify(acted));
  db.prepare('INSERT INTO arenas (id, repo, json) VALUES (?, ?, ?)').run('arena-1', FULL, JSON.stringify({ ...ready, sealedUses: 2 }));
  db.prepare('INSERT INTO voyages (id, json) VALUES (?, ?)').run(done.id, JSON.stringify(done));
  db.prepare('INSERT INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(paused.id, paused.kind, paused.status, JSON.stringify(paused));
  db.prepare('INSERT INTO graduates (id, json) VALUES (?, ?)').run(graduate.id, JSON.stringify(graduate));
  const ok = verifyReplay();
  assert.deepEqual(ok.diffs, []);
  assert.equal(ok.ok, true);

  // A grant row whose state column says granted while the ledger says he revoked it.
  db.prepare("UPDATE grants SET state = 'revoked' WHERE kind = ? AND repo = ?").run('merge:low', FULL);
  const corrupt = verifyReplay();
  assert.equal(corrupt.ok, false);
  assert.ok(corrupt.diffs.some((x) => x.startsWith(`grant merge:low ${FULL}: the tables hold`)), corrupt.diffs.join('\n'));
  // A grant row the ledger never made, and a net whose current flag moved without a promotion.
  db.prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)').run('merge:high', FULL, 'granted', acted.at, JSON.stringify({ ...acted, kind: 'merge:high' }));
  db.prepare("UPDATE nets SET current = 1 WHERE net = 'master' AND version = 1").run();
  db.prepare('DELETE FROM decisions WHERE at = ?').run(revert.at);
  const worse = verifyReplay();
  assert.ok(worse.diffs.some((x) => x.startsWith(`grant merge:high ${FULL}: in the tables but not in the ledger`)), worse.diffs.join('\n'));
  assert.ok(worse.diffs.some((x) => x.startsWith('net master v1: the tables hold')), worse.diffs.join('\n'));
  assert.ok(worse.diffs.some((x) => x.startsWith('decision merge:low:job-1 #2: in the ledger but not in the tables')), worse.diffs.join('\n'));
});

test("replay rebuilds the nets exactly from nets.ts's own entries, and the nets table agrees", async () => {
  const { constant, installNet } = await import('./school-fixtures.js');
  const { versions } = await import('../engine/school/nets.js');
  installNet(constant('master', 1, 0.6), { trusted: false, at: '2026-11-11T02:00:00.000Z' });
  installNet(constant('master', 2, 0.7), { trusted: true, at: '2026-11-12T02:00:00.000Z' });
  installNet(constant('router', 1, 0.5), { trusted: true, at: '2026-11-12T03:00:00.000Z' });
  const state = replay(entries());
  const want = Object.fromEntries([...versions('master'), ...versions('router')].map((v) => [`${v.net} v${v.version}`, v]));
  assert.deepEqual(state.nets, want, 'every version, the promoted one current');
  assert.equal(state.nets['master v1'].current, false);
  assert.equal(state.nets['master v2'].current, true);
  const ok = verifyReplay();
  assert.deepEqual(ok.diffs, []);
  // A table row whose current drifted from the ledger is caught.
  openDb().prepare("UPDATE nets SET current = 1 WHERE net = 'master' AND version = 1").run();
  assert.ok(verifyReplay().diffs.some((d) => /master v1/.test(d)));
});
