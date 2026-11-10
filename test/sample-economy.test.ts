/**
 * The sample economy (Task 21): a fictional, fully scripted market on the
 * sample city, for captures, the UI test and the README. Every gh and
 * `ollama list` call goes to the sample stand-in, no process is spawned and
 * nothing is fetched (test safety rules 2 to 6); the home is a temp dir.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe } from '../engine/events.js';
import { getRunner, realRunner, realSpawner, setRunner, setSpawner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { query } from '../engine/ledger.js';
import { listAgents, quarters, firm } from '../engine/market/firms.js';
import { listJobs } from '../engine/market/jobs.js';
import { resetProviders } from '../engine/market/providers.js';
import { verifyReplay } from '../engine/market/replay.js';
import { listRuns, resetRuns } from '../engine/market/runs.js';
import { economyClock, economySites, seedEconomy } from '../engine/market/sample-economy.js';
import { resetShipping } from '../engine/market/ship.js';
import { installTreasury } from '../engine/market/treasury.js';
import { openaiUsage } from '../engine/providers-usage.js';
import { earnedFloors } from '../engine/repos.js';
import { SAMPLE_INSTALLED, SAMPLE_ISSUES, SAMPLE_MARKER, sampleCodexHome, sampleGh, samplePRs } from '../engine/sample.js';
import type { JobStatus, RunLogLine, Silhouette, Trip } from '../shared/types.js';
import { seedSample } from '../tools/sample.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_CODEX_HOME', 'PALIMPSEST_GEMINI_HOME'];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

let tempDir = '';
let calls: Array<{ cmd: string; args: string[]; answered: boolean }> = [];
let spawns = 0;
let fetches = 0;

/** The sample stand-in, with every call it is asked written down. */
function recorded(): Runner {
  const stand = sampleGh();
  return async (cmd, args) => {
    const call = { cmd, args, answered: false };
    calls.push(call);
    const out = await stand(cmd, args);
    call.answered = true;
    return out;
  };
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-economy-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  delete process.env.PALIMPSEST_CODEX_HOME;
  delete process.env.PALIMPSEST_GEMINI_HOME;
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetRuns();
  resetShipping();
  resetProviders();
  samplePRs.reset();
  calls = [];
  spawns = 0;
  fetches = 0;
  setRunner(recorded());
  setSpawner(() => {
    spawns++;
    throw new Error('the sample economy spawned a process');
  });
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error('the sample economy fetched');
  }) as typeof fetch;
});

afterEach(() => {
  setRunner(realRunner);
  setSpawner(realSpawner);
  globalThis.fetch = realFetch;
  resetRuns();
  resetShipping();
  samplePRs.reset();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await seedSample(NOW);
  await seedEconomy(NOW);
}

function logOf(runId: string): RunLogLine[] {
  return readFileSync(join(paths().runs, runId, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunLogLine);
}

function trips(): Trip[] {
  return (openDb().prepare('SELECT json FROM trips').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip);
}

test('the economy seeds every job status and replays clean', async () => {
  await seed();
  const jobs = listJobs();
  const count = (s: JobStatus) => jobs.filter((j) => j.status === s).length;
  for (const s of ['proposed', 'open', 'bidding', 'awarded', 'running', 'inspecting', 'waiting', 'merged', 'failed', 'closed', 'halted', 'withdrawn'] as JobStatus[]) {
    assert.ok(count(s) > 0, `a ${s} job`);
  }
  assert.equal(count('bidding'), 2, 'two jobs open with live bids');
  assert.equal(count('running'), 1);
  assert.equal(count('inspecting'), 1);
  assert.equal(count('waiting'), 1);
  assert.ok(count('merged') >= 4);

  const proposed = jobs.filter((j) => j.status === 'proposed');
  assert.deepEqual(proposed.map((j) => [j.source, j.repo]), [['harness', 'lantern/assay-kit']], 'one harness job on the repo with tests and no build');

  // The board's issue jobs are the stand-in's eight issues.
  const issueJobs = jobs.filter((j) => j.source === 'issue');
  assert.equal(issueJobs.length, 8);
  assert.equal(issueJobs.filter((j) => j.repo === 'tidewater/harbor-ledger').length, 3);

  // Live bids, and one firm sitting out.
  const bidRows = (openDb().prepare('SELECT job_id, json FROM bids').all() as Array<{ job_id: string; json: string }>).map((r) => ({ jobId: r.job_id, row: JSON.parse(r.json) as { bid?: unknown; satOut?: { firmId: string } } }));
  for (const j of jobs.filter((x) => x.status === 'bidding')) {
    assert.ok(bidRows.filter((r) => r.jobId === j.id && r.row.bid).length >= 2, `bids on ${j.title}`);
    assert.ok(j.bidsCloseAt && Date.parse(j.bidsCloseAt) > NOW - 60_000, 'a window still open at the seed time');
  }
  const satOut = bidRows.filter((r) => r.row.satOut && jobs.find((j) => j.id === r.jobId)?.status === 'bidding');
  assert.equal(new Set(satOut.map((r) => r.row.satOut!.firmId)).size, 1, 'one firm sits out');

  // The running job's log: 60 lines, two refusals, egress lines.
  const running = listRuns().find((r) => r.outcome === null && r.stage === 'working');
  assert.ok(running);
  const log = logOf(running.id);
  assert.equal(log.length, 60);
  assert.equal(log.filter((l) => l.kind === 'refused').length, 2);
  assert.ok(log.some((l) => l.kind === 'egress'));
  assert.equal(query({ kind: 'run.refused', runId: running.id }).length, 2);

  // The scarred job and the halted repo.
  const failed = jobs.find((j) => j.status === 'failed')!;
  assert.ok(earnedFloors('hoshi/kumo#founding').some((f) => f.earned?.state === 'scar' && f.earned.jobId === failed.id));
  assert.ok(openDb().prepare("SELECT 1 FROM repos WHERE json_extract(json, '$.halted') IS NOT NULL").get(), 'a halted repo');

  // Six firms: the bankrupt sixth's dark tower bought by Quickset and re-clad; one hired specialist.
  assert.equal(firm('lodestar')?.status, 'bankrupt');
  const lodestar = quarters().find((q) => q.firmId === 'lodestar')!;
  assert.equal(lodestar.dark, true);
  assert.equal(lodestar.towers.length, 1);
  assert.equal(lodestar.towers[0].firmId, 'quickset');
  assert.equal(lodestar.towers[0].root, 'chicago');
  assert.equal(lodestar.towers[0].dark, false);
  assert.equal(listAgents().filter((a) => a.lineage.origin === 'roster').length, 1);

  // Agent towers already hold 3 to 14 earned floors, in every silhouette.
  const towers = quarters().flatMap((q) => q.towers);
  assert.equal(towers.length, 12);
  for (const t of towers) assert.ok(t.floors.length >= 3 && t.floors.length <= 14, `${t.agentId} holds ${t.floors.length} floors`);
  assert.deepEqual(new Set(towers.map((t) => t.silhouette)), new Set<Silhouette>(['lens', 'cantilever', 'needle', 'plain']));

  // A week of credits, three daily reports, a Codex fixture home.
  const span = openDb().prepare('SELECT MIN(at) AS a, MAX(at) AS b FROM credits').get() as { a: string; b: string };
  assert.ok(Date.parse(span.b) - Date.parse(span.a) >= 7 * 24 * 3600_000, 'credits rows for a week');
  const reports = query({ kind: 'report.written' });
  assert.equal(reports.length, 3);
  for (const r of reports) assert.ok(existsSync((r.data as { path: string }).path));
  process.env.PALIMPSEST_CODEX_HOME = sampleCodexHome();
  const codex = openaiUsage(NOW);
  assert.equal(codex.status, 'ready');
  assert.equal(codex.windows.length, 2);

  // Trips in flight across every mode, a persona cab among them.
  const live = trips().filter((t) => !t.endedAt);
  assert.deepEqual(new Set(live.flatMap((t) => t.legs.map((l) => l.mode))), new Set(['walk', 'tram', 'rail', 'pod', 'ferry', 'cab']));
  assert.ok(live.every((t) => query({ kind: 'trip.started' }).some((e) => (e.data as { trip: Trip }).trip.id === t.id)), 'every trip is in the ledger');

  // Sites for every run in a live stage.
  assert.deepEqual(new Set(economySites().map((s) => s.stage)), new Set(['framing', 'inspecting']));

  const v = verifyReplay();
  assert.ok(v.ok, v.diffs.join('\n'));
});

test('the clock moves a running job to merged with a lit floor and a trip home', async () => {
  await seed();
  const off = installTreasury();
  const seen: string[] = [];
  const unsubscribe = subscribe((e) => seen.push(e.type));
  try {
    const job = listJobs({ status: 'running' })[0];
    const run = listRuns().find((r) => r.jobId === job.id && r.outcome === null)!;
    let t = NOW;
    const clock = economyClock({ now: () => t, speed: 20 });
    for (let i = 0; i < 45; i++) {
      t += 1000;
      clock.tick(1000);
      await clock.idle();
    }
    clock.stop();

    assert.equal(listJobs().find((j) => j.id === job.id)?.status, 'merged');
    const lit = (towerId: string) => earnedFloors(towerId).find((f) => f.earned?.jobId === job.id)?.earned?.state;
    assert.equal(lit(`${job.repo}#founding`), 'lit');
    assert.equal(lit(`agent:${run.agentId}`), 'lit');
    const home = trips().find((x) => x.agentId === run.agentId && x.reason === 'home' && Date.parse(x.startedAt) >= NOW);
    assert.ok(home, 'a trip home');
    for (const type of ['run.stage', 'site.changed', 'run.log', 'inspection.done', 'floor.laid', 'floor.lit', 'trip.started', 'credits.moved']) {
      assert.ok(seen.includes(type), `a ${type} event`);
    }
    const v = verifyReplay();
    assert.ok(v.ok, v.diffs.join('\n'));
  } finally {
    unsubscribe();
    off();
  }
});

test('the sample stand-in never calls the network', async () => {
  await seed();
  let t = NOW;
  const clock = economyClock({ now: () => t, speed: 20 });
  for (let i = 0; i < 45; i++) {
    t += 1000;
    clock.tick(1000);
    await clock.idle();
  }
  clock.stop();
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((c) => !c.answered).map((c) => `${c.cmd} ${c.args.join(' ')}`), [], 'every call answered by the stand-in');
  assert.ok(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'list'));
  assert.ok(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'));
  assert.ok(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view'));
  assert.notEqual(getRunner(), realRunner);
  assert.equal(spawns, 0, 'no process spawned');
  assert.equal(fetches, 0, 'nothing fetched');

  // The stand-in itself: issues per label, eight in all and three on the harbour repo.
  const gh = sampleGh();
  const list = async (repo: string, label: string) =>
    (JSON.parse((await gh('gh', ['issue', 'list', '-R', repo, '--label', label, '--state', 'open', '--json', 'number'])).stdout) as Array<{ number: number }>).map((i) => i.number);
  assert.deepEqual(await list('tidewater/harbor-ledger', 'palimpsest'), [214]);
  assert.deepEqual(await list('tidewater/harbor-ledger', 'palimpsest:low'), [219]);
  assert.deepEqual(await list('tidewater/harbor-ledger', 'palimpsest:high'), [221]);
  assert.equal(SAMPLE_ISSUES.length, 8);
  assert.equal(SAMPLE_ISSUES.filter((i) => i.repo === 'tidewater/harbor-ledger').length, 3);
  assert.equal(JSON.parse((await gh('gh', ['issue', 'view', '214', '-R', 'tidewater/harbor-ledger', '--json', 'state'])).stdout).state, 'OPEN');
  const created = (await gh('gh', ['pr', 'create', '-R', 'ferro/quarry', '--head=palimpsest/job-x', '--base=main', '--title=T', '--body=B'])).stdout.trim();
  assert.match(created, /^https:\/\/github\.com\/ferro\/quarry\/pull\/\d+$/);
  const n = created.split('/').pop()!;
  assert.equal(JSON.parse((await gh('gh', ['pr', 'view', n, '-R', 'ferro/quarry', '--json', 'state'])).stdout).state, 'OPEN');
  samplePRs.close('ferro/quarry', Number(n));
  assert.equal(JSON.parse((await gh('gh', ['pr', 'view', n, '-R', 'ferro/quarry', '--json', 'state'])).stdout).state, 'CLOSED');
  const models = (await gh('ollama', ['list'])).stdout.split('\n').slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(models, SAMPLE_INSTALLED);
  await assert.rejects(() => gh('gh', ['repo', 'delete', 'ferro/quarry']), /unexpected command/);
  await assert.rejects(() => gh('claude', ['-p', 'hello']), /unexpected command/);
});

test('npx tsx tools/sample.ts <tmp> --economy writes the marker and refuses the real home', () => {
  const user = join(tempDir, 'user');
  const real = join(user, 'Library', 'Application Support', 'Palimpsest');
  mkdirSync(real, { recursive: true });
  const run = (dir: string) =>
    spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'tools/sample.ts', dir, '--economy'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: user, PALIMPSEST_HOME: '', PALIMPSEST_CLAUDE_PROJECTS: '', PALIMPSEST_TEST_PROJECTS: '', NODE_TEST_CONTEXT: '' },
    });
  const refused = run(real);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refusing/);
  assert.equal(existsSync(join(real, 'palimpsest.db')), false);

  const dir = join(tempDir, 'economy');
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, SAMPLE_MARKER)), true);
  assert.match(r.stdout, /jobs/);
  assert.equal(existsSync(join(dir, 'claude-projects')), true, 'its own transcripts folder, never his');
});

test('the hire does not depend on the seed time: the same books and one specialist at any hour', async () => {
  const books: string[] = [];
  for (const at of [NOW, NOW + 13 * 3600_000 + 17 * 60_000 + 5_123]) {
    process.env.PALIMPSEST_HOME = join(tempDir, `home-${at}`);
    resetShipping();
    samplePRs.reset();
    await seedSample(at);
    await seedEconomy(at);
    assert.equal(listAgents().filter((a) => a.lineage.origin === 'roster').length, 1);
    const hire = query({ kind: 'agent.hired' })[0];
    const tick = hire.at;
    // Every firm's books just before the tick: only Quickset can hire, by a wide margin.
    const before = (id: string) => 300 + query({ kind: 'credits.moved', to: tick }).filter((e) => (e.data as { firmId: string }).firmId === id).reduce((s, e) => s + (e.data as { delta: number }).delta, 0);
    for (const f of ['ashlar-vane', 'meridian', 'kiln', 'sparrow']) assert.ok(before(f) < 340, `${f} holds ${before(f)} at the tick`);
    assert.ok(before('quickset') > 520, `quickset holds ${before('quickset')}`);
    books.push(JSON.stringify(Object.fromEntries(listAgents().map((a) => [a.id, earnedFloors(`agent:${a.id}`).length]))) + JSON.stringify(quarters().map((q) => q.firmId)));
    books.push(JSON.stringify(Object.fromEntries((openDb().prepare('SELECT id, json FROM firms').all() as Array<{ id: string; json: string }>).map((r) => [r.id, JSON.parse(r.json).balance]))));
  }
  assert.equal(books[0], books[2], 'the same floors');
  assert.equal(books[1], books[3], 'the same balances');
});
