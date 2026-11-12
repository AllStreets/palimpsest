/**
 * The audit runner (Phase 3 Task 4). Every session is the fake provider
 * (test safety rule 6); gh is never called (a fixture runner serves the one
 * analysis); the clone is a real `git clone` of a temp bare mirror (rule 5)
 * under a temp home with the sandbox off (rule 7); the clock is injected
 * (rule 8). Nothing touches port 4770, his keychain or his transcripts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { realRunner, realSpawner, setRunner, setSpawner, type Spawned } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries } from '../engine/ledger.js';
import { mirrorDir } from '../engine/mirror.js';
import { ALLOWED_ONLY, execTool } from '../engine/market/broker.js';
import { noteSseClients, resetBudget, treasury } from '../engine/market/budget.js';
import { fakeProvider, type FakeScript } from '../engine/market/fake-provider.js';
import type { RunContext } from '../engine/market/install.js';
import type { AuditInput, AuditResult } from '../engine/market/provider.js';
import { resetProviders, setProvider } from '../engine/market/providers.js';
import { verifyReplay } from '../engine/market/replay.js';
import { createScheduler, failInterruptedRuns, INTERRUPTED_RUN, resetRuns, type SchedulerDeps } from '../engine/market/runs.js';
import { checkCommands } from '../engine/audit/schema.js';
import {
  auditLogPath,
  failInterruptedAudits,
  killLiveAudits,
  pickAuditModel,
  queueAudit,
  shouldAutoAudit,
  startQueuedAudit,
  watchAudits,
  WAITING_INTERACTIVE,
  WROTE_CLONE,
} from '../engine/audit/run.js';
import { audit as storedAudit, latestAudit, listAudits, liveAuditIds, saveAudit } from '../engine/audit/store.js';
import { analyze, connect, getRepo, patchRepo } from '../engine/repos.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { AUDIT_ESTIMATE, repoMarketDefaults } from '../shared/market-rules.js';
import type { Audit, CheckResult, Repo, RepoChecks } from '../shared/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time, so the night cap stays out of the way. */
const NOW = new Date(2026, 10, 9, 14, 0, 0).getTime();
const FULL = 'acme/widgets';

let tempDir: string;
let clock = NOW;
const saved: Record<string, string | undefined> = {};
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_SANDBOX'];
let events: Event[] = [];
let unsubscribe: () => void = () => {};

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-audit-run-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  process.env.PALIMPSEST_SANDBOX = 'off';
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  clock = NOW;
  resetRuns();
  resetBudget();
  resetProviders();
  noteSseClients(1, NOW - MIN);
  reading();
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
  // caffeinate never runs under the tests (rule 4); everything else is real.
  setSpawner((cmd, args, opts): Spawned => {
    if (cmd.endsWith('caffeinate')) {
      return { pid: 424242, lines: (async function* () {})(), kill() {}, done: new Promise(() => {}) };
    }
    return realSpawner(cmd, args, opts);
  });
});

afterEach(async () => {
  unsubscribe();
  await killLiveAudits('test over');
  resetRuns();
  resetBudget();
  resetProviders();
  setSpawner(realSpawner);
  setRunner(realRunner);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

/** A usage reading taken `ageMs` ago; a fresh one keeps Claude unpaused. */
function reading(five = 10, ageMs = 0): void {
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor((NOW - ageMs) / 1000),
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: Math.floor((NOW + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

const README = ['# Widgets', '', '## Hot reload', '', 'Supports hot reload.', '', '## Export', '', 'Exports CSV.', '', '## Search', '', 'Search is instant.', ''].join('\n');

const FILES: Record<string, string> = {
  'README.md': README,
  'package.json': JSON.stringify({ name: 'widgets', scripts: { test: 'exit 0' } }, null, 2) + '\n',
  'src/index.ts': 'export const widgets = 1;\n',
  'test/index.test.ts': "import { widgets } from '../src/index.js';\nif (widgets !== 1) throw new Error('no');\n",
};

const CHECKS: RepoChecks = { test: 'true', typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: [], install: null, ecosystems: ['npm'], detected: true };

let slot = 0;
/** A connected, analysed repo and its bare mirror where syncMirror would put it. */
function makeRepo(full = FULL, over: Partial<Repo> = {}, files: Record<string, string> = FILES): Repo {
  const repo: Repo = {
    fullName: full,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: 'Widgets for everyone',
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: slot++,
    status: 'ready',
    error: null,
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    checks: CHECKS,
    joinedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'work', full.replace('/', '__'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(tempDir, 'clone', '-q', '--bare', work, mirrorDir(full));
  return repo;
}

const usage = (credits: number) => ({ weightedTokens: credits * 600, seconds: 0, usd: 0, credits });

function useScript(s: FakeScript): void {
  for (const kind of ['claude', 'ollama', 'anthropic'] as const) setProvider(kind, fakeProvider(s));
}

/** An audit session that waits until it is released or aborted; `ignoreSignal` hangs on past a kill, as a stuck session would. */
function heldAudit(o: { ignoreSignal?: boolean; creditsOnAbort?: number } = {}) {
  const started: AuditInput[] = [];
  const gates = new Map<string, () => void>();
  const audit = async (i: AuditInput): Promise<AuditResult> => {
    started.push(i);
    await new Promise<void>((resolve) => {
      gates.set(i.auditId, resolve);
      if (!o.ignoreSignal) i.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { answer: null, text: '', usage: usage(o.creditsOnAbort ?? 0), ended: 'aborted', reason: 'signal' };
  };
  return { started, release: (id: string) => gates.get(id)?.(), audit };
}

/** A finished answer in the schema's shape. */
function answer(findings: unknown[], credits = 2): AuditResult {
  const a = { claims: findings.length, findings };
  return { answer: a, text: JSON.stringify(a), usage: usage(credits), ended: 'finished', reason: null };
}

const skipped: CheckResult = { name: 'install', status: 'skipped', detail: 'Nothing to install.', durationMs: 0, logPath: null, testsRun: null };

type StartOpts = Partial<Parameters<typeof startQueuedAudit>[0]>;
function start(over: StartOpts = {}) {
  return startQueuedAudit({ now: () => clock, preflight: async () => null, quiet: async () => {}, reap: async () => [], installDeps: async () => skipped, ...over });
}

function deps(over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    now: () => clock,
    installDeps: async () => skipped,
    inspect: async () => {
      throw new Error('no inspection in an audit test');
    },
    ship: async () => {
      throw new Error('no shipping in an audit test');
    },
    pollJobs: async () => [],
    quiet: async () => {},
    reap: async () => [],
    preflight: async () => null,
    watchMs: 0,
    ...over,
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const evOf = (type: string) => events.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>);
const creditRows = (auditId: string) =>
  (openDb().prepare('SELECT kind, firm_id, run_id, amount, json FROM credits WHERE run_id = ?').all(auditId) as Array<{ kind: string; firm_id: string | null; run_id: string; amount: number; json: string }>).map((r) => ({
    ...r,
    credits: r.amount,
    model: (JSON.parse(r.json) as { model: string }).model,
  }));

function post(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path: '/run', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${token}` } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** A stored audit row as the last engine would have left it. */
function storedRow(repo: string, status: Audit['status'], id = `audit-${status}`): Audit {
  const a: Audit = {
    id,
    repo,
    model: status === 'waiting' ? null : 'claude:sonnet',
    trigger: 'connect',
    baseSha: null,
    status,
    waitingReason: null,
    startedAt: new Date(NOW - HOUR).toISOString(),
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
  saveAudit(a);
  return a;
}

/** A runner serving one analysis of `fullName` from fixtures: gh never runs. */
function fixtureRunner(fullName: string) {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: fullName, isPrivate: false, description: 'A fixture repo', primaryLanguage: { name: 'TypeScript' }, defaultBranchRef: { name: 'main' } }), stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('fetch')) return { stdout: '', stderr: '', code: 0 };
    if (cmd === 'git' && args.includes('log')) return { stdout: '', stderr: '', code: 0 };
    if (cmd === 'git' && args.includes('ls-tree')) return realRunner(cmd, args);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
    throw new Error(`fixtureRunner: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

function waitForEvent(type: string, ms = 5000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${type}`));
    }, ms);
    const off = subscribe((e) => {
      if (e.type !== type) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });
}

// ---------------------------------------------------------------- the lifecycle

test('a queued audit runs in a fresh clone and ends done with its findings, its page and a credits row of kind audit with no firm that the treasury counts', async () => {
  const seen: { pushUrl: string | null; branch: string | null; files: string[] } = { pushUrl: null, branch: null, files: [] };
  useScript({
    audit: (i) => {
      seen.pushUrl = readFileSync(join(i.dir, '.git', 'config'), 'utf8').match(/pushurl = (.*)/)?.[1] ?? null;
      seen.branch = readFileSync(join(i.dir, '.git', 'HEAD'), 'utf8').trim();
      seen.files = readdirSync(i.dir).sort();
      assert.equal(i.readme?.path, 'README.md');
      assert.equal(i.readme?.text, README);
      assert.deepEqual(i.docs, []);
      assert.equal(i.checks?.test, 'true');
      assert.equal(i.caps.maxCredits, getSettings().auditMaxCredits);
      return answer([
        { claim: 'Supports hot reload', source: { file: 'README.md', line: 5 }, verdict: 'REAL', tested: true, evidence: [{ file: 'test/index.test.ts', line: 1, note: 'the test imports it' }], proposal: null },
        { claim: 'Exports CSV', source: { file: 'README.md', line: 9 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/index.ts', line: 1, note: 'nothing exports' }], proposal: { title: 'Export CSV', body: 'Build the export.', scope: ['src/**'], acceptance: ['a CSV comes out'], tier: 'normal' } },
        { claim: 'Search is instant', source: { file: 'README.md', line: 13 }, verdict: 'PARTIAL', tested: false, evidence: [{ file: 'src/index.ts', line: 1, note: 'there is a search, untimed' }], proposal: null },
      ], 3);
    },
  });
  const repo = makeRepo();
  const before = treasury(clock).citySpent.today;
  const queued = queueAudit(repo, 'demand');
  assert.equal(queued.status, 'waiting');
  assert.equal(queued.repo, FULL);
  assert.equal(evOf('audit.started').length, 1);
  assert.equal(entries().filter((e) => e.kind === 'audit.started').length, 1);

  const ended = await start();
  assert.ok(ended, 'the waiting audit started');
  assert.equal(ended.id, queued.id);
  assert.equal(ended.status, 'done');
  assert.equal(ended.endedReason, null);
  assert.equal(ended.model, 'claude:sonnet');
  assert.match(ended.baseSha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(seen.pushUrl, 'no-push://palimpsest');
  assert.equal(seen.branch, `ref: refs/heads/palimpsest/${queued.id}`);
  assert.deepEqual(seen.files, ['.git', 'README.md', 'package.json', 'src', 'test']);
  assert.equal(ended.findings.length, 3);
  assert.deepEqual(ended.findings.map((f) => f.verdict), ['REAL', 'MISSING', 'PARTIAL']);
  assert.equal(ended.findings[0].tested, true);
  assert.equal(ended.findings[1].proposal?.title, 'Export CSV');
  assert.equal(ended.findings[1].proposal?.key.split('#')[0], FULL);
  assert.deepEqual(ended.counts, { REAL: 1, PARTIAL: 1, MISSING: 1, STUBBED: 0, BROKEN: 0 });
  assert.equal(ended.claimsRead, 3);
  assert.ok(ended.credits > 0);
  assert.deepEqual(storedAudit(queued.id), ended);
  assert.deepEqual(latestAudit(FULL), ended);

  // The page.
  assert.ok(ended.markdownPath && ended.markdownPath.startsWith(join(paths().reports, 'audits')));
  const page = readFileSync(ended.markdownPath as string, 'utf8');
  assert.match(page, /^# acme\/widgets: the README against the code/);
  assert.match(page, /Of 3 claims in the README, 1 is real, 1 partial and 1 missing\./);
  assert.match(page, /Export CSV/);

  // The spend: one credits row of kind audit, no firm, the audit as its run, counted by the treasury as the city's.
  const rows = creditRows(queued.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'audit');
  assert.equal(rows[0].firm_id, null);
  assert.equal(rows[0].model, 'claude:sonnet');
  assert.ok(rows[0].credits > 0);
  assert.ok(treasury(clock).citySpent.today > before);
  assert.equal(treasury(clock).concurrency.claude, 0, 'the lease is released');

  // The root: removed but for the log.
  const root = join(paths().runs, queued.id);
  assert.deepEqual(readdirSync(root), ['log.jsonl']);
  assert.equal(auditLogPath(queued.id), join(root, 'log.jsonl'));
  assert.ok(!existsSync(join(root, 'repo')));
  assert.equal(getRepo(FULL)?.auditedAt, ended.endedAt);
  assert.equal(liveAuditIds().length, 0);

  // The ledger: a stage per step in the shape replay reads, the end whole, and replay agrees with the tables.
  const stages = entries().filter((e) => e.kind === 'audit.stage').map((e) => e.data as { auditId: string; status: string });
  assert.deepEqual(stages.map((s) => s.status), ['preparing', 'installing', 'reading']);
  assert.ok(stages.every((s) => s.auditId === queued.id));
  const endedEntry = entries().filter((e) => e.kind === 'audit.ended').at(-1)?.data as { audit: Audit };
  assert.deepEqual(endedEntry.audit, ended);
  assert.deepEqual(evOf('audit.ended').at(-1)?.audit, ended);
  assert.deepEqual(verifyReplay().diffs, []);
});

test('a fake agent that writes a file in the clone fails the audit with "wrote to its clone"', async () => {
  useScript({
    audit: (i) => {
      writeFileSync(join(i.dir, 'src', 'sneaky.ts'), 'export const x = 1;\n');
      return answer([{ claim: 'Supports hot reload', source: { file: 'README.md', line: 5 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/index.ts', line: 1, note: 'n' }], proposal: { title: 'Build it', body: 'b', scope: ['src/**'], acceptance: ['a'], tier: 'normal' } }]);
    },
  });
  makeRepo();
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'failed');
  assert.match(ended.endedReason ?? '', /wrote to its clone/);
  assert.equal(ended.endedReason, WROTE_CLONE);
  assert.deepEqual(ended.findings, [], 'nothing is proposed from a written clone');
  assert.equal(ended.markdownPath, null);
  assert.ok(ended.credits > 0, 'what it spent is still charged');
  assert.equal(creditRows(ended.id).length, 1);
  assert.equal(getRepo(FULL)?.auditedAt, null);
  assert.ok(!existsSync(join(paths().runs, ended.id, 'repo')));
});

test('evidence citing a file the fake agent did not commit is unverified and proposes nothing', async () => {
  useScript({
    audit: () =>
      answer([
        { claim: 'Exports CSV', source: { file: 'README.md', line: 9 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/ghost.ts', line: 3, note: 'a file that is not in the commit' }], proposal: { title: 'Export CSV', body: 'b', scope: ['src/**'], acceptance: ['a'], tier: 'normal' } },
        { claim: 'Search is instant', source: { file: 'README.md', line: 13 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/index.ts', line: 99, note: 'past the end of the file' }, { file: 'src/index.ts', line: 1, note: 'within it' }], proposal: { title: 'Make search instant', body: 'b', scope: ['src/**'], acceptance: ['a'], tier: 'normal' } },
      ]),
  });
  makeRepo();
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'done');
  const [ghost, search] = ended.findings;
  assert.equal(ghost.unverified, true);
  assert.equal(ghost.proposal, null);
  assert.equal(ghost.evidence[0].verified, false);
  assert.equal(search.unverified, false);
  assert.deepEqual(search.evidence.map((e) => e.verified), [false, true]);
  assert.equal(search.proposal?.title, 'Make search instant');
  assert.equal(ended.unverified, 1);
  assert.match(readFileSync(ended.markdownPath as string, 'utf8'), /unverified/);
});

test('a repo with no README ends done with zero findings and "No README to check"', async () => {
  useScript({});
  const files = { ...FILES };
  delete files['README.md'];
  const repo = makeRepo('acme/bare', {}, files);
  queueAudit(repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'done');
  assert.deepEqual(ended.findings, []);
  assert.equal(ended.claimsRead, 0);
  assert.match(readFileSync(ended.markdownPath as string, 'utf8'), /No README to check\./);
  assert.ok(ended.credits > 0, 'what it spent is charged');
  assert.equal(getRepo('acme/bare')?.auditedAt, ended.endedAt);
});

test('the README and the docs are read from the base commit, any case and docs/**/*.md', async () => {
  const seen: Array<{ path: string; text: string } | null> = [];
  const docs: Array<Array<{ path: string; text: string }>> = [];
  useScript({
    audit: (i) => {
      seen.push(i.readme);
      docs.push(i.docs);
      return answer([]);
    },
  });
  const repo = makeRepo('acme/lower', {}, { 'readme.rst': 'Widgets\n=======\n', 'docs/guide.md': '# Guide\n', 'docs/deep/more.md': '# More\n', 'docs/notes.txt': 'not markdown\n', 'src/index.ts': 'export {};\n' });
  queueAudit(repo, 'demand');
  await start();
  assert.deepEqual(seen, [{ path: 'readme.rst', text: 'Widgets\n=======\n' }]);
  assert.deepEqual(docs, [[{ path: 'docs/deep/more.md', text: '# More\n' }, { path: 'docs/guide.md', text: '# Guide\n' }]]);
});

// ---------------------------------------------------------------- the install stage and the run tool

test('the install stage runs sandboxed before the session only when the checks need dependencies, under the install egress stage', async () => {
  const installs: Array<{ ctx: RunContext; repo: string; stageAtInstall: string | null }> = [];
  const order: string[] = [];
  useScript({
    audit: () => {
      order.push('session');
      return answer([]);
    },
  });
  const installDeps = async (ctx: RunContext, repo: Repo): Promise<CheckResult> => {
    order.push('install');
    installs.push({ ctx, repo: repo.fullName, stageAtInstall: readFileSync(join(ctx.runRoot, 'ctl', 'egress.json'), 'utf8') });
    return { ...skipped, status: 'pass', detail: 'npm ci' };
  };
  const withDeps = makeRepo('acme/deps', { checks: { ...CHECKS, install: 'npm ci' } });
  queueAudit(withDeps, 'demand');
  const a = (await start({ installDeps })) as Audit;
  assert.equal(a.status, 'done');
  assert.deepEqual(order, ['install', 'session']);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].repo, 'acme/deps');
  assert.equal(installs[0].ctx.runId, a.id);
  assert.equal(installs[0].ctx.dir, join(paths().runs, a.id, 'repo'));
  assert.ok(installs[0].ctx.egress, 'the install stage gets the egress proxy to set its own stage');
  assert.ok(!installs[0].ctx.signal.aborted);
  const stages = entries().filter((e) => e.kind === 'audit.stage' && (e.data as { auditId: string }).auditId === a.id).map((e) => (e.data as { status: string }).status);
  assert.deepEqual(stages, ['preparing', 'installing', 'reading']);

  // No install command: nothing to install, the stage is passed through.
  const noInstall = makeRepo('acme/noinstall');
  queueAudit(noInstall, 'demand');
  await start({ installDeps });
  assert.equal(installs.length, 1);
  // An install command but no check to run: installing would serve nothing, so it is skipped too.
  const noChecks = makeRepo('acme/nochecks', { checks: { ...CHECKS, test: null, install: 'npm ci' } });
  queueAudit(noChecks, 'demand');
  await start({ installDeps });
  assert.equal(installs.length, 1);
});

test('an install that fails ends the audit failed and never reaches the session', async () => {
  let sessions = 0;
  useScript({
    audit: () => {
      sessions++;
      return answer([]);
    },
  });
  const repo = makeRepo('acme/deps', { checks: { ...CHECKS, install: 'npm ci' } });
  queueAudit(repo, 'demand');
  const a = (await start({ installDeps: async () => ({ ...skipped, status: 'fail', detail: 'npm ci exited 1' }) })) as Audit;
  assert.equal(a.status, 'failed');
  assert.match(a.endedReason ?? '', /install failed: npm ci exited 1/);
  assert.equal(sessions, 0);
  assert.equal(creditRows(a.id).length, 0);
});

test("the audit's broker accepts only the repo's declared checks and never the install command", async () => {
  const replies: Array<{ command: string; status: number; body: Record<string, unknown> }> = [];
  useScript({
    audit: async (i) => {
      const root = dirname(i.dir);
      const port = (JSON.parse(readFileSync(join(root, 'ctl', 'broker.json'), 'utf8')) as { port: number }).port;
      const token = readFileSync(join(root, 'ctl', 'broker.token'), 'utf8').trim();
      for (const command of ['true', 'npm ci', 'echo nope']) {
        const r = await post(port, token, { command, timeoutMs: 5000 });
        replies.push({ command, status: r.status, body: JSON.parse(r.body) as Record<string, unknown> });
      }
      return answer([]);
    },
  });
  const repo = makeRepo('acme/deps', { checks: { ...CHECKS, install: 'npm ci' } });
  queueAudit(repo, 'demand');
  const a = (await start()) as Audit;
  assert.equal(a.status, 'done');
  assert.equal(replies.length, 3);
  assert.equal(replies[0].body.code, 0, 'the declared test check runs');
  assert.equal(replies[0].body.refused, null);
  assert.match(String(replies[1].body.refused), new RegExp(ALLOWED_ONLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(String(replies[2].body.refused), /"true"/);
  assert.ok(entries().some((e) => e.kind === 'run.refused' && (e.data as { runId: string }).runId === a.id));
});

test('checksPassed vouches for a REAL finding only when the declared test check ran through the run tool and passed', async () => {
  const real = { claim: 'Supports hot reload', source: { file: 'README.md', line: 5 }, verdict: 'REAL', tested: true, evidence: [{ file: 'src/index.ts', line: 1, note: 'the code does it' }], proposal: null };
  const runIt = async (i: AuditInput, command: string) => {
    const r = await execTool({ runId: i.auditId, runRoot: dirname(i.dir), dir: i.dir, command, timeoutMs: 5000, stage: 'working', signal: i.signal, log: i.log, allowedCommands: checkCommands(i.checks) });
    assert.equal(r.refused, null);
    return r;
  };
  // Ran and passed: REAL stands on the check.
  useScript({
    audit: async (i) => {
      await runIt(i, 'true');
      return answer([real]);
    },
  });
  makeRepo('acme/passing');
  queueAudit(getRepo('acme/passing') as Repo, 'demand');
  const passed = (await start()) as Audit;
  assert.equal(passed.status, 'done');
  assert.equal(passed.findings[0].verdict, 'REAL');
  assert.equal(passed.findings[0].tested, true);

  // Ran and failed: no vouching, the finding is PARTIAL and untested.
  useScript({
    audit: async (i) => {
      await runIt(i, 'false');
      return answer([real]);
    },
  });
  makeRepo('acme/failing', { checks: { ...CHECKS, test: 'false' } });
  queueAudit(getRepo('acme/failing') as Repo, 'demand');
  const failed = (await start()) as Audit;
  assert.equal(failed.findings[0].verdict, 'PARTIAL');
  assert.equal(failed.findings[0].tested, false);

  // Never ran: the same.
  useScript({ audit: async () => answer([real]) });
  makeRepo('acme/unrun');
  queueAudit(getRepo('acme/unrun') as Repo, 'demand');
  const unrun = (await start()) as Audit;
  assert.equal(unrun.findings[0].verdict, 'PARTIAL');

  // Another declared check passing (typecheck) is not the test check.
  useScript({
    audit: async (i) => {
      await runIt(i, 'true');
      return answer([real]);
    },
  });
  makeRepo('acme/typecheck', { checks: { ...CHECKS, test: 'false', typecheck: 'true' } });
  queueAudit(getRepo('acme/typecheck') as Repo, 'demand');
  const other = (await start()) as Audit;
  assert.equal(other.findings[0].verdict, 'PARTIAL');
});

// ---------------------------------------------------------------- the kill paths

test('the stop file kills a reading audit within 5 s, leaves the repo unhalted with no strike and counts its spend', async () => {
  const held = heldAudit({ creditsOnAbort: 3 });
  useScript({ audit: held.audit });
  const repo = makeRepo();
  const before = treasury(clock).citySpent.today;
  queueAudit(repo, 'demand');
  const running = start();
  await until(() => held.started.length === 1);
  const id = held.started[0].auditId;
  assert.equal(storedAudit(id)?.status, 'reading');
  assert.deepEqual(liveAuditIds(), [id]);
  writeFileSync(paths().stop, 'stopped by the test\n');
  const t0 = Date.now();
  // The watcher pass the scheduler runs every 2 s.
  createScheduler(deps()).watch();
  const ended = (await running) as Audit;
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(ended.status, 'killed');
  assert.match(ended.endedReason ?? '', /stop file/);
  assert.deepEqual(ended.findings, []);
  assert.equal(ended.markdownPath, null);
  const after = getRepo(FULL) as Repo;
  assert.equal(after.halted, null);
  assert.equal(after.strikes, 0);
  assert.equal(after.auditedAt, null);
  assert.ok(treasury(clock).citySpent.today > before, 'what it spent before the kill counts');
  assert.equal(creditRows(id)[0]?.kind, 'audit');
  assert.equal(treasury(clock).concurrency.claude, 0);
  assert.equal(liveAuditIds().length, 0);
  // Nothing is written against the repo: no halt, no strike, no ledger line of a firm's failure.
  assert.ok(!entries().some((e) => e.kind === 'repo.halted'));
  // It can be run again by hand.
  rmSync(paths().stop);
  assert.equal(queueAudit(getRepo(FULL) as Repo, 'demand').status, 'waiting');
});

test('the credit cap ends the audit capped and the wall deadline ends it capped', async () => {
  useScript({ audit: () => ({ answer: null, text: 'partial', usage: usage(40), ended: 'capped', reason: 'The audit reached its credit cap of 40.' }) });
  makeRepo();
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const capped = (await start()) as Audit;
  assert.equal(capped.status, 'capped');
  assert.match(capped.endedReason ?? '', /credit cap/);
  assert.ok(capped.credits > 0);
  assert.deepEqual(capped.findings, []);

  // A session that hangs on past its kill: the watcher ends it at the wall deadline.
  const held = heldAudit({ ignoreSignal: true });
  useScript({ audit: held.audit });
  const other = makeRepo('acme/slow');
  queueAudit(other, 'demand');
  const running = start({ wallMs: 1000 });
  await until(() => held.started.length === 1);
  watchAudits(clock + 999);
  assert.equal(storedAudit(held.started[0].auditId)?.status, 'reading', 'not yet');
  watchAudits(clock + 1001);
  const walled = (await running) as Audit;
  assert.equal(walled.status, 'capped');
  assert.match(walled.endedReason ?? '', /wall deadline/);
  assert.equal(treasury(clock).concurrency.claude, 0);
  held.release(walled.id);
});

test('scheduler.stop() kills a live audit, and the stop file in a tick does too', async () => {
  const held = heldAudit();
  useScript({ audit: held.audit });
  const repo = makeRepo();
  queueAudit(repo, 'demand');
  const s = createScheduler(deps());
  await s.tick();
  await until(() => held.started.length === 1);
  await s.stop();
  const a = storedAudit(held.started[0].auditId) as Audit;
  assert.equal(a.status, 'killed');
  assert.match(a.endedReason ?? '', /shutting down/);
  assert.equal(liveAuditIds().length, 0);

  const held2 = heldAudit();
  useScript({ audit: held2.audit });
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const s2 = createScheduler(deps());
  await s2.tick();
  await until(() => held2.started.length === 1);
  writeFileSync(paths().stop, 'stopped\n');
  await s2.tick();
  await s2.idle();
  assert.equal(storedAudit(held2.started[0].auditId)?.status, 'killed');
  // While the stop file stands no audit starts; cleared, the next tick starts the queue again.
  useScript({});
  queueAudit(getRepo(FULL) as Repo, 'demand');
  await s2.tick();
  await s2.idle();
  assert.equal(listAudits({ repo: FULL, status: ['waiting'] }).length, 1);
  rmSync(paths().stop);
  await s2.tick();
  await s2.idle();
  assert.equal(listAudits({ repo: FULL, status: ['waiting'] }).length, 0);
  assert.equal(latestAudit(FULL)?.status, 'done');
});

test('an audit left reading when the engine stopped ends crashed at start and a waiting one stays waiting', async () => {
  makeRepo();
  const reading = storedRow(FULL, 'reading');
  const waiting = storedRow('acme/other', 'waiting');
  const installing = storedRow('acme/third', 'installing');
  for (const a of [reading, installing]) {
    mkdirSync(join(paths().runs, a.id, 'repo'), { recursive: true });
    writeFileSync(join(paths().runs, a.id, 'log.jsonl'), '');
  }
  const reaped: string[] = [];
  const ended = await failInterruptedAudits({
    reap: async (root) => {
      reaped.push(root);
      assert.ok(existsSync(join(root, 'repo')), 'reaped before the run dir is removed');
      return [];
    },
  });
  assert.deepEqual(ended.map((a) => a.id).sort(), [installing.id, reading.id].sort());
  assert.deepEqual(reaped.sort(), [join(paths().runs, installing.id), join(paths().runs, reading.id)].sort());
  for (const a of [reading, installing]) {
    const now = storedAudit(a.id) as Audit;
    assert.equal(now.status, 'crashed');
    assert.equal(now.endedReason, INTERRUPTED_RUN);
    assert.ok(now.endedAt);
    assert.deepEqual(readdirSync(join(paths().runs, a.id)), ['log.jsonl']);
  }
  assert.equal(storedAudit(waiting.id)?.status, 'waiting');
  assert.equal(evOf('audit.ended').length, 2);
  assert.equal(getRepo(FULL)?.auditedAt, null);
  // A second start finds nothing to fail, and the waiting one still stands.
  assert.deepEqual(await failInterruptedAudits({ reap: async () => [] }), []);

  // The engine's own start calls it through failInterruptedRuns.
  const again = storedRow(FULL, 'preparing', 'audit-again');
  await failInterruptedRuns({ reap: async () => [] });
  assert.equal(storedAudit(again.id)?.status, 'crashed');
});

// ---------------------------------------------------------------- one at a time, the queue and the model

test('only one audit is live at a time and a repo cannot queue two', async () => {
  const held = heldAudit();
  useScript({ audit: held.audit });
  const a = makeRepo();
  const b = makeRepo('acme/other');
  const first = queueAudit(a, 'demand');
  assert.throws(() => queueAudit(a, 'demand'), /already has an audit waiting or under way/);
  assert.throws(() => queueAudit(a, 'connect'), /already has an audit/);
  const second = queueAudit(b, 'demand');
  const running = start();
  await until(() => held.started.length === 1);
  assert.equal(held.started[0].auditId, first.id, 'the oldest waiting audit goes first');
  assert.equal(await start(), null, 'a second audit does not start while one is live');
  assert.equal(storedAudit(second.id)?.status, 'waiting');
  assert.throws(() => queueAudit(a, 'demand'), /already has an audit/);
  assert.equal(treasury(clock).concurrency.claude, 1, 'an audit holds one Claude slot, never two');
  held.release(first.id);
  await running;
  assert.equal(storedAudit(first.id)?.status, 'crashed', 'a release without an answer is the provider stopping on its own');
  // The first repo may queue again once its audit has ended; the second starts next.
  assert.equal(queueAudit(getRepo(FULL) as Repo, 'demand').status, 'waiting');
  const running2 = start();
  await until(() => held.started.length === 2);
  assert.equal(held.started[1].auditId, second.id);
  held.release(second.id);
  await running2;
});

test('an automatic audit waits while his interactive use is active and starts when it ends; an on-demand one does not wait', async () => {
  useScript({});
  const repo = makeRepo();
  const transcript = join(tempDir, 'projects', 'his-project', 'session.jsonl');
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, '{"type":"user"}\n');
  utimesSync(transcript, NOW / 1000, NOW / 1000);
  const auto = queueAudit(repo, 'connect');
  assert.equal(await start(), null);
  const waiting = storedAudit(auto.id) as Audit;
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingReason, WAITING_INTERACTIVE);
  assert.equal(WAITING_INTERACTIVE, 'waiting for your Claude session to go quiet');
  const stageEntries = entries().filter((e) => e.kind === 'audit.stage');
  assert.deepEqual(stageEntries.map((e) => e.data), [{ auditId: auto.id, status: 'waiting', waitingReason: WAITING_INTERACTIVE }]);
  assert.equal(await start(), null, 'still waiting');
  assert.equal(entries().filter((e) => e.kind === 'audit.stage').length, 1, 'the same reason is not recorded again each tick');
  assert.equal(treasury(clock).concurrency.claude, 0, 'no lease is held while it waits');

  // His session goes quiet: the next tick starts it.
  utimesSync(transcript, (NOW - 20 * MIN) / 1000, (NOW - 20 * MIN) / 1000);
  const ended = (await start()) as Audit;
  assert.equal(ended.id, auto.id);
  assert.equal(ended.status, 'done');
  assert.equal(ended.waitingReason, null);

  // An on-demand audit runs beside his session.
  utimesSync(transcript, NOW / 1000, NOW / 1000);
  const other = makeRepo('acme/other');
  const demand = queueAudit(other, 'demand');
  const ran = (await start()) as Audit;
  assert.equal(ran.id, demand.id);
  assert.equal(ran.status, 'done');
});

test('an on-demand audit runs on a market-off repo while a connect audit is not queued for one', async () => {
  useScript({});
  const off = makeRepo('acme/quiet', { market: false });
  assert.equal(shouldAutoAudit(off, getSettings()), false);
  const a = queueAudit(off, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.id, a.id);
  assert.equal(ended.status, 'done');
  assert.equal(ended.trigger, 'demand');
  // The ruling's four legs.
  const on = makeRepo('acme/loud');
  assert.equal(shouldAutoAudit(on, getSettings()), true);
  assert.equal(shouldAutoAudit({ ...on, status: 'analyzing' }, getSettings()), false);
  assert.equal(shouldAutoAudit(on, { ...getSettings(), auditOnConnect: false }), false);
  queueAudit(on, 'demand');
  assert.equal(shouldAutoAudit(on, getSettings()), false, 'a repo with any audit is never audited by itself');
});

test('turning the market on queues the one automatic audit, and turning it off and on again does not queue a second', () => {
  makeRepo(FULL, { market: false });
  assert.equal(listAudits({ repo: FULL }).length, 0);
  patchRepo(FULL, { market: true });
  const queued = listAudits({ repo: FULL });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, 'waiting');
  assert.equal(queued[0].trigger, 'connect');
  assert.equal(evOf('audit.started').length, 1);
  patchRepo(FULL, { market: false });
  patchRepo(FULL, { market: true });
  assert.equal(listAudits({ repo: FULL }).length, 1);
  // Market on to on, or a patch of something else, never queues.
  patchRepo(FULL, { market: true });
  patchRepo(FULL, { label: 'city' });
  assert.equal(listAudits({ repo: FULL }).length, 1);
  // The setting off: no automatic audit.
  patchSettings({ auditOnConnect: false });
  makeRepo('acme/other', { market: false });
  patchRepo('acme/other', { market: true });
  assert.equal(listAudits({ repo: 'acme/other' }).length, 0);
  patchSettings({ auditOnConnect: true });
  // A repo still analysing is not queued by the switch (its analysis will queue it, ruling 6).
  makeRepo('acme/third', { market: false, status: 'analyzing' });
  patchRepo('acme/third', { market: true });
  assert.equal(listAudits({ repo: 'acme/third' }).length, 0);
});

test('a repo that connects with the market already on is queued by its first analysis', async () => {
  // A repo stored from before with the market on, disconnected, now reconnected: connect() keeps its switch.
  makeRepo(FULL, { market: true, connected: false, status: 'idle', analyzedAt: null, joinedAt: null });
  setRunner(fixtureRunner(FULL));
  const analyzed = waitForEvent('repo.analyzed');
  await connect(FULL);
  await analyzed;
  const queued = listAudits({ repo: FULL });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].trigger, 'connect');
  assert.equal(queued[0].status, 'waiting');
  assert.equal(getRepo(FULL)?.status, 'ready');
  // A re-analysis queues nothing more.
  await analyze(FULL);
  assert.equal(listAudits({ repo: FULL }).length, 1);
  // A market-off repo's analysis queues nothing.
  makeRepo('acme/other', { market: false, connected: false, status: 'idle', analyzedAt: null });
  setRunner(fixtureRunner('acme/other'));
  const analyzed2 = waitForEvent('repo.analyzed');
  await connect('acme/other');
  await analyzed2;
  assert.equal(listAudits({ repo: 'acme/other' }).length, 0);
});

test('a capped audit is not queued again by a re-analysis, a restart or the market switch', async () => {
  makeRepo(FULL, { market: false });
  const capped = storedRow(FULL, 'capped');
  assert.deepEqual(latestAudit(FULL)?.id, capped.id);
  assert.equal(shouldAutoAudit({ ...(getRepo(FULL) as Repo), market: true }, getSettings()), false);
  // The switch.
  patchRepo(FULL, { market: true });
  assert.equal(listAudits({ repo: FULL }).length, 1);
  // A re-analysis.
  setRunner(fixtureRunner(FULL));
  await analyze(FULL);
  assert.equal(getRepo(FULL)?.status, 'ready');
  assert.equal(listAudits({ repo: FULL }).length, 1);
  // A restart.
  await failInterruptedAudits({ reap: async () => [] });
  assert.equal(listAudits({ repo: FULL }).length, 1);
  assert.equal(storedAudit(capped.id)?.status, 'capped');
  // He can still ask for one.
  assert.equal(queueAudit(getRepo(FULL) as Repo, 'demand').status, 'waiting');
});

test('an agent that edits .git/config ends the audit failed with "run dir git config changed"', async () => {
  useScript({
    audit: (i) => {
      appendFileSync(join(i.dir, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n');
      return answer([{ claim: 'Supports hot reload', source: { file: 'README.md', line: 5 }, verdict: 'REAL', tested: true, evidence: [{ file: 'test/index.test.ts', line: 1, note: 'n' }], proposal: null }]);
    },
  });
  makeRepo();
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'failed');
  assert.equal(ended.endedReason, 'run dir git config changed');
  assert.deepEqual(ended.findings, []);
  assert.equal(ended.markdownPath, null);
  assert.ok(!existsSync(join(paths().runs, ended.id, 'repo')));
});

test('auto picks sonnet when Claude is free and the 30b coder when it is paused', () => {
  const installed = ['llama3.1:70b', 'qwen2.5-coder:7b', 'qwen3-coder:30b-a3b', 'mixtral:8x7b'];
  const s = getSettings();
  assert.equal(pickAuditModel(s, installed, clock), 'claude:sonnet');
  // A stale reading pauses Claude: the largest installed coder.
  reading(10, 6 * HOUR);
  assert.equal(pickAuditModel(s, installed, clock), 'ollama:qwen3-coder:30b-a3b');
  // No coder: any installed model by the same rank.
  assert.equal(pickAuditModel(s, ['llama3.1:8b', 'mixtral:8x7b'], clock), 'ollama:mixtral:8x7b');
  // Nothing installed: the audit waits for Claude.
  assert.equal(pickAuditModel(s, [], clock), null);
  // A chosen model is used as it is.
  assert.equal(pickAuditModel({ ...s, auditModel: 'ollama:qwen2.5-coder:7b' }, installed, clock), 'ollama:qwen2.5-coder:7b');
  assert.equal(pickAuditModel({ ...s, auditModel: 'claude:opus' }, [], clock), 'claude:opus');
  reading();
  assert.equal(pickAuditModel(s, [], clock), 'claude:sonnet');
});

test('with nothing to run the audit on, the queued audit waits with the reason and holds no lease', async () => {
  useScript({});
  reading(10, 6 * HOUR);
  const repo = makeRepo();
  const a = queueAudit(repo, 'demand');
  assert.equal(await start({ installed: [] }), null);
  const w = storedAudit(a.id) as Audit;
  assert.equal(w.status, 'waiting');
  assert.match(w.waitingReason ?? '', /waiting for Claude/);
  assert.equal(treasury(clock).concurrency.claude, 0);
  // The preflight refusing keeps it waiting too.
  reading();
  assert.equal(await start({ preflight: async () => 'The sandbox helper is missing.' }), null);
  assert.equal(storedAudit(a.id)?.status, 'waiting');
  // Claude back: a local model installed is not preferred over it.
  const ended = (await start({ installed: ['qwen3-coder:30b-a3b'] })) as Audit;
  assert.equal(ended.model, 'claude:sonnet');
  assert.equal(ended.status, 'done');
  assert.equal(ended.waitingReason, null);
});

test('a local model audit is charged under kind audit to the city and holds the local slot', async () => {
  let seenModel: string | null = null;
  useScript({
    audit: (i) => {
      seenModel = i.model;
      assert.equal(i.caps.maxTurns, 40, 'the local caps');
      return answer([], 2);
    },
  });
  reading(10, 6 * HOUR);
  const repo = makeRepo();
  queueAudit(repo, 'demand');
  const ended = (await start({ installed: ['qwen3-coder:30b-a3b'] })) as Audit;
  assert.equal(ended.status, 'done');
  assert.equal(ended.model, 'ollama:qwen3-coder:30b-a3b');
  assert.equal(seenModel, 'ollama:qwen3-coder:30b-a3b');
  const rows = creditRows(ended.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'audit');
  assert.equal(rows[0].firm_id, null);
  assert.equal(rows[0].credits, 2);
  assert.equal(treasury(clock).concurrency.local, 0);
  assert.ok(!existsSync(join(paths().runs, ended.id, 'ctl', 'broker.json')), 'no broker for a local model');
});

test('the audit never shipped: no ship dir and no push ran', async () => {
  const argv: string[][] = [];
  setRunner(async (cmd, args) => {
    argv.push([cmd, ...args]);
    return { stdout: '', stderr: '', code: 0 };
  });
  let shipDirSeen: boolean | null = null;
  useScript({
    audit: (i) => {
      shipDirSeen = existsSync(join(dirname(i.dir), 'ship'));
      return answer([{ claim: 'Exports CSV', source: { file: 'README.md', line: 9 }, verdict: 'MISSING', tested: false, evidence: [{ file: 'src/index.ts', line: 1, note: 'n' }], proposal: { title: 'Export CSV', body: 'b', scope: ['src/**'], acceptance: ['a'], tier: 'normal' } }]);
    },
  });
  const repo = makeRepo();
  const mirror = mirrorDir(FULL);
  const refsBefore = git(mirror, 'for-each-ref');
  queueAudit(repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'done');
  assert.equal(shipDirSeen, false);
  assert.equal(git(mirror, 'for-each-ref'), refsBefore, 'the mirror has no new branch or commit');
  assert.ok(!argv.some((a) => a.includes('push')), `no push ran: ${JSON.stringify(argv)}`);
  assert.ok(!argv.some((a) => a[0] === 'gh'), 'gh never ran');
  const kinds = new Set(entries().map((e) => e.kind));
  for (const k of ['run.started', 'run.diff', 'pr.opened', 'job.posted']) assert.ok(!kinds.has(k), `no ${k}`);
  assert.equal(AUDIT_ESTIMATE, 20);
});

test('every reason the audit stores is redacted and the log keeps every line', async () => {
  useScript({
    audit: (i) => {
      i.log({ at: new Date().toISOString(), kind: 'assistant', text: `reading ${i.dir}` });
      return { answer: null, text: '', usage: usage(1), ended: 'crashed', reason: `the session crashed in ${i.dir}` };
    },
  });
  makeRepo();
  queueAudit(getRepo(FULL) as Repo, 'demand');
  const ended = (await start()) as Audit;
  assert.equal(ended.status, 'crashed');
  assert.ok(!ended.endedReason?.includes(tempDir), ended.endedReason ?? '');
  assert.match(ended.endedReason ?? '', /the session crashed in/);
  const lines = readFileSync(auditLogPath(ended.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; text: string });
  assert.ok(lines.some((l) => l.kind === 'assistant' && l.text.startsWith('reading ')));
  assert.ok(lines.some((l) => l.kind === 'engine' && /audit ended crashed/.test(l.text)));
  assert.ok(evOf('audit.log').length > 0);
});
