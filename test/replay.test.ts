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
import type { Audit, CheckResult, Milestone, Repo } from '../shared/types.js';
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
