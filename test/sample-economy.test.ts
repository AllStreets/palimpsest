/**
 * The sample economy (Task 21): a fictional, fully scripted market on the
 * sample city, for captures, the UI test and the README. Every gh and
 * `ollama list` call goes to the sample stand-in, no process is spawned and
 * nothing is fetched (test safety rules 2 to 6); the home is a temp dir.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { listAudits } from '../engine/audit/store.js';
import { briefData, briefItems, openBrief } from '../engine/brief.js';
import { openDb } from '../engine/db.js';
import { subscribe } from '../engine/events.js';
import { getRunner, realRunner, realSpawner, setRunner, setSpawner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { query } from '../engine/ledger.js';
import { listAgents, quarters, firm } from '../engine/market/firms.js';
import { bidList } from '../engine/market/bids.js';
import { acceptProposed, CITY_MARKER, listJobs, postManualJob } from '../engine/market/jobs.js';
import { listMilestones, weekTour } from '../engine/market/milestones.js';
import { resetProviders } from '../engine/market/providers.js';
import { verifyReplay } from '../engine/market/replay.js';
import { listRuns, resetRuns } from '../engine/market/runs.js';
import { economyClock, economySites, sampleReading, seedEconomy } from '../engine/market/sample-economy.js';
import { resetShipping } from '../engine/market/ship.js';
import { installTreasury } from '../engine/market/treasury.js';
import { openaiUsage } from '../engine/providers-usage.js';
import { connect, disconnect, earnedFloors, getRepo, listRepos, patchRepo } from '../engine/repos.js';
import { SAMPLE_INSTALLED, SAMPLE_ISSUES, SAMPLE_MARKER, sampleCodexHome, sampleGh, samplePRs } from '../engine/sample.js';
import { proposalKey } from '../shared/market-rules.js';
import type { BriefItemKind, JobStatus, RunLogLine, Silhouette, Trip, Verdict } from '../shared/types.js';
import { seedSample } from '../tools/sample.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
/** A Monday noon in Los Angeles: the morning the brief offers last week's tour. */
const MONDAY = Date.parse('2026-11-09T20:00:00Z');
const H = 'tidewater/harbor-ledger';
const K = 'hoshi/kumo';

/** Runs `fn` with the clock set to Los Angeles, where the local days of the brief and the tour are pinned. */
async function inLosAngeles(fn: () => Promise<void>): Promise<void> {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    await fn();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}
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

/** Sets `full`'s market switch in the store, without the switch's own trigger. */
function setMarket(full: string, on: boolean): void {
  const repo = getRepo(full)!;
  openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...repo, market: on }), full);
}

/** Every audit as `repo trigger status`, sorted. */
function scriptedAudits(): string[] {
  return listAudits().map((a) => `${a.repo} ${a.trigger} ${a.status}`).sort();
}

const FOUR_AUDITS = ['ferro/quarry connect capped', 'hoshi/kumo demand reading', 'lantern/assay-kit demand done', 'tidewater/harbor-ledger demand done'];

/** The founding floor count of `full`'s tower. */
function foundingFloorCount(full: string): string {
  const row = openDb().prepare('SELECT json FROM towers WHERE repo = ?').get(full) as { json: string } | undefined;
  return `${row ? (JSON.parse(row.json) as { floors: unknown[] }).floors.length : 0} floors`;
}

/** The sample layout (unchanged since before Task 9): each repo's founding floor count, and the states of each tower's earned floors in laid order. */
const SAMPLE_LAYOUT: Record<string, string> = {
  'tidewater/harbor-ledger founding': '92 floors',
  'kestrel/fieldnotes founding': '38 floors',
  'lantern/assay-kit founding': '66 floors',
  'ferro/quarry founding': '24 floors',
  'hoshi/kumo founding': '52 floors',
  'alder/blank-slate founding': '0 floors',
  'agent:bruno-kiln': 'lit lit lit lit',
  'agent:corin-hale': 'lit lit lit lit',
  'agent:dagny-hollis': 'lit lit lit',
  'agent:hal-meridian': 'lit lit lit',
  'agent:ines-ashlar': 'lit lit lit lit lit lit lit',
  'agent:juno-pike': 'lit lit lit',
  'agent:mack-quickset': 'lit lit lit lit lit lit lit lit lit',
  'agent:ola-bergstrom': 'lit lit lit lit lit waiting',
  'agent:oskar-kiln': 'lit lit lit lit lit lit',
  'agent:priya-rao': 'lit lit lit lit lit lit lit lit lit lit lit lit',
  'agent:teodor-vane': 'lit lit lit lit',
  'agent:wren-sparrow': 'lit lit lit lit lit lit lit lit',
  'ferro/quarry#founding': 'lit lit scar lit lit lit lit lit lit lit lit lit lit',
  'hoshi/kumo#founding': 'lit lit lit lit lit scar lit lit lit lit lit scar scar lit lit waiting',
  'kestrel/fieldnotes#founding': 'lit lit scar lit lit lit lit',
  'lantern/assay-kit#founding': 'lit lit lit scar lit lit lit lit lit lit lit lit lit lit lit lit lit',
  'tidewater/harbor-ledger#founding': 'lit lit lit lit lit lit lit scar lit lit lit lit lit lit lit lit lit lit lit lit lit lit lit',
};

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
  assert.equal(count('bidding'), 3, 'three jobs open with live bids: two issues and the proposal he accepted');
  assert.equal(count('running'), 1);
  assert.equal(count('inspecting'), 1);
  assert.equal(count('waiting'), 1);
  assert.ok(count('merged') >= 4);

  const proposed = jobs.filter((j) => j.status === 'proposed');
  assert.deepEqual(proposed.filter((j) => j.source === 'harness').map((j) => j.repo), ['lantern/assay-kit'], 'one harness job on the repo with tests and no build');
  assert.deepEqual(proposed.filter((j) => j.source === 'proposal').map((j) => j.repo), [H, H], "two of the harbour audit's proposals still wait for his click");

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

test('the board clock opens accepted and posted jobs, takes bids one at a time and awards once everyone has answered', async () => {
  await seed();
  const off = installTreasury();
  const seen: Array<{ type: string; data: any }> = [];
  const unsubscribe = subscribe((e) => seen.push(e as { type: string; data: any }));
  try {
    const seeded = listJobs({ status: 'bidding' });
    assert.equal(seeded.length, 3, 'three rounds open at the start');
    const before = new Map(seeded.map((j) => [j.id, bidList(j.id).bids.length + bidList(j.id).satOut.length]));
    const harness = listJobs({ status: 'proposed' })[0];
    acceptProposed(harness.id);
    const posted = postManualJob({ repo: harness.repo, title: 'Name the custody export columns in the CSV header', tier: 'low' });
    let t = NOW;
    const clock = economyClock({ now: () => t, speed: 20, board: true });
    const tick = async () => {
      t += 1000;
      clock.tick(1000);
      await clock.idle();
    };
    await tick();
    for (const id of [harness.id, posted.id]) {
      const j = listJobs().find((x) => x.id === id)!;
      assert.equal(j.status, 'bidding', `${j.title} opens for bids on the next tick`);
      // The window is bidWindowSec script seconds: 120 / 20 = 6 wall seconds.
      assert.equal(Date.parse(j.bidsCloseAt!) - t, 6000);
    }
    for (const j of seeded) assert.equal(bidList(j.id).bids.length + bidList(j.id).satOut.length, before.get(j.id)! + 1, 'one more answer on each seeded round');
    const placed = seen.filter((e) => e.type === 'bid.placed');
    assert.ok(placed.length >= 3, `bids arrive live (${placed.length})`);
    // One answer per round per tick at most.
    const perJob = new Map<string, number>();
    for (const e of seen.filter((x) => x.type === 'bid.placed' || x.type === 'bid.satOut')) {
      const id = e.type === 'bid.placed' ? e.data.bid.jobId : e.data.satOut.jobId;
      perJob.set(id, (perJob.get(id) ?? 0) + 1);
    }
    assert.ok([...perJob.values()].every((k) => k === 1), `one answer per round on the first tick (${[...perJob.values()].join(', ')})`);
    for (let i = 0; i < 30 && listJobs({ status: 'bidding' }).length > 0; i++) await tick();
    clock.stop();
    for (const id of [...seeded.map((j) => j.id), harness.id, posted.id]) {
      const j = listJobs().find((x) => x.id === id)!;
      assert.ok(['awarded', 'open'].includes(j.status), `${j.title} was awarded (${j.status})`);
      assert.ok(query({ kind: 'job.awarded', jobId: id }).length >= 1);
    }
    assert.ok(seen.some((e) => e.type === 'run.progress' && e.data.progress.toolCalls > 0), 'a working run reports its progress');
    const v = verifyReplay();
    assert.ok(v.ok, v.diffs.join('\n'));
  } finally {
    unsubscribe();
    off();
  }
});

test('without the board the clock places no bids, and without the audit it leaves the reading audit reading', async () => {
  await seed();
  let t = NOW;
  const placed: string[] = [];
  const unsubscribe = subscribe((e) => {
    if (e.type === 'bid.placed') placed.push(e.type);
  });
  const clock = economyClock({ now: () => t, speed: 20, audit: false });
  for (let i = 0; i < 25; i++) {
    t += 1000;
    clock.tick(1000);
    await clock.idle();
  }
  clock.stop();
  unsubscribe();
  assert.deepEqual(placed, []);
  assert.equal(listJobs({ status: 'bidding' }).length, 3);
  assert.equal(listAudits({ repo: K })[0]?.status, 'reading', 'the kumo audit is still reading');
});

test('the economy seeds four audits and their proposals and replays clean', async () => {
  await seed();
  const audits = listAudits();
  assert.equal(audits.length, 4);
  const of = (repo: string) => audits.find((a) => a.repo === repo)!;

  // The harbour audit: 14 claims, every verdict but STUBBED, one finding unverified, four proposals.
  const harbor = of(H);
  assert.equal(harbor.status, 'done');
  assert.equal(harbor.trigger, 'demand');
  assert.equal(harbor.claimsRead, 14);
  assert.equal(harbor.findings.length, 14);
  assert.deepEqual(harbor.counts, { REAL: 8, PARTIAL: 2, MISSING: 3, STUBBED: 0, BROKEN: 1 });
  assert.equal(harbor.unverified, 1);
  assert.equal(harbor.findings.filter((f) => f.unverified).length, 1);
  for (const f of harbor.findings) {
    assert.ok(f.evidence.length >= 1, `${f.id} carries evidence`);
    assert.ok(f.unverified ? f.evidence.every((e) => !e.verified) : f.evidence.some((e) => e.verified), `${f.id}: unverified means nothing cited was found`);
    assert.ok(f.verdict !== 'REAL' || (f.tested && f.evidence.some((e) => e.verified && /test/.test(e.file))), `${f.id}: REAL is backed by a test file`);
    if (f.unverified) assert.equal(f.proposal, null, 'an unverified finding gets no proposal');
  }
  const withProposal = harbor.findings.filter((f) => f.proposal);
  assert.equal(withProposal.length, 4);
  for (const f of withProposal) {
    const j = listJobs().find((x) => x.id === f.proposal!.jobId);
    assert.ok(j, `${f.id} was posted as a job`);
    assert.equal(j.source, 'proposal');
    assert.equal(j.key, proposalKey(H, f.claim));
    assert.ok(j.body.startsWith(CITY_MARKER), 'the body opens with the city marker');
    assert.deepEqual(j.proposal, { auditId: harbor.id, findingId: f.id });
    assert.ok(j.acceptance.length >= 1);
  }
  const statuses = withProposal.map((f) => listJobs().find((x) => x.id === f.proposal!.jobId)!.status).sort();
  assert.deepEqual(statuses, ['bidding', 'proposed', 'proposed', 'withdrawn'], 'one accepted and bidding, one dismissed, two waiting');
  const dismissed = withProposal.map((f) => listJobs().find((x) => x.id === f.proposal!.jobId)!).find((j) => j.status === 'withdrawn')!;
  assert.equal(dismissed.withdrawnBy, 'him');
  assert.ok(harbor.markdownPath && existsSync(harbor.markdownPath), 'the page is on disk');
  const page = readFileSync(harbor.markdownPath!, 'utf8');
  assert.match(page, /Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1 broken\./);
  assert.match(page, /One finding cites nothing found at the base commit and is unverified\./);
  assert.equal(getRepo(H)?.auditedAt, harbor.endedAt);
  assert.ok(harbor.credits > 0);

  // The assay-kit audit: no README to check.
  const assay = of('lantern/assay-kit');
  assert.equal(assay.status, 'done');
  assert.equal(assay.findings.length, 0);
  assert.equal(assay.claimsRead, 0);
  assert.match(readFileSync(assay.markdownPath!, 'utf8'), /No README to check\./);
  assert.equal(getRepo('lantern/assay-kit')?.auditedAt, assay.endedAt);

  // The kumo audit is reading now; the quarry one ran out of credits last week.
  const kumo = of(K);
  assert.equal(kumo.status, 'reading');
  assert.ok(kumo.model && kumo.baseSha, 'a live audit knows its model and base commit');
  assert.equal(kumo.endedAt, null);
  assert.ok(existsSync(join(paths().runs, kumo.id, 'log.jsonl')), 'its log is being written');
  const quarry = of('ferro/quarry');
  assert.equal(quarry.status, 'capped');
  assert.ok(quarry.endedReason);
  assert.ok(quarry.credits >= 40, `a capped audit spent its cap (${quarry.credits})`);
  assert.ok(Date.parse(quarry.startedAt) < NOW - 5 * 24 * 3600_000, 'last week');
  assert.equal(getRepo('ferro/quarry')?.auditedAt, null, 'a capped audit does not date the repo');
  assert.ok(getRepo('kestrel/fieldnotes') && listAudits({ repo: 'kestrel/fieldnotes' }).length === 0, 'fieldnotes was never audited');

  // Every audit's spend is the city's own, under kind audit.
  const spent = openDb().prepare("SELECT COUNT(*) AS n FROM credits WHERE kind = 'audit' AND firm_id IS NULL").get() as { n: number };
  assert.ok(spent.n >= 3, `credits rows of kind audit (${spent.n})`);
  const started = query({ kind: 'audit.started' });
  assert.equal(started.length, 4);
  assert.equal(query({ kind: 'audit.ended' }).length, 3);

  // Milestones, reached by the market's own rules as the floors went up.
  const milestones = listMilestones(NOW);
  const skyline = milestones.filter((m) => m.kind === 'skyline');
  assert.deepEqual(skyline.filter((m) => m.lit).map((m) => m.towerId), [`${H}#founding`], 'the lit spire stands on the harbour tower');
  assert.ok(skyline.some((m) => !m.lit && m.towerId === 'lantern/assay-kit#founding'), 'assay-kit held the spire first and keeps its mast unlit');
  assert.deepEqual(milestones.filter((m) => m.kind === 'founding-skyline').map((m) => [m.towerId, m.lit]), [[`${H}#founding`, false]], 'the founding skyline is the unlit finial');
  const revival = milestones.find((m) => m.kind === 'revival')!;
  assert.equal(revival.repo, 'kestrel/fieldnotes');
  assert.ok(revival.until && Date.parse(revival.until) > NOW, 'the scaffolding lights are still on');
  const ribbons = milestones.filter((m) => m.kind === 'ribbon');
  assert.ok(ribbons.some((m) => m.until === null || Date.parse(m.until) > NOW), 'a ribbon still flies');
  assert.ok(ribbons.some((m) => m.until !== null && Date.parse(m.until) <= NOW), 'and one has come down');
  assert.ok(ribbons.some((m) => m.firmId === 'lodestar' && m.until === firm('lodestar')?.bankruptAt), "Lodestar's came down with the firm");
  assert.ok(milestones.every((m) => query({ kind: 'milestone.reached' }).some((e) => (e.data as { milestone: { id: string } }).milestone.id === m.id)), 'every milestone is in the ledger');

  // Six mornings of briefs and three of his answers, so the triage log has history.
  const opened = query({ kind: 'brief.opened' });
  assert.equal(new Set(opened.map((e) => (e.data as { day: string }).day)).size, 6);
  for (const e of opened) assert.ok(Array.isArray((e.data as { items: string[] }).items), 'each open lists its item ids');
  const actions = query({ kind: 'brief.action' }).map((e) => (e.data as { action: string }).action);
  for (const a of ['accept', 'dismiss', 'cap']) assert.ok(actions.includes(a), `a ${a} action`);

  const v = verifyReplay();
  assert.ok(v.ok, v.diffs.join('\n'));
});

test('a reconnect still analysing when the economy is seeded, as in ui-test, leaves the four scripted audits', async () => {
  // ui-test's reconnectChecks disconnects the harbour and connects it again, and earnedChecks seeds at once:
  // that analysis must not end inside the history, where the market is on, and queue an audit of its own.
  // Its market starts on, so the analysis would queue that audit even if it ended before the history began.
  await seedSample(NOW);
  setMarket(H, true);
  disconnect(H);
  await connect(H);
  assert.equal(getRepo(H)?.status, 'analyzing');
  await seedEconomy(NOW);
  assert.equal(getRepo(H)?.status, 'ready');
  assert.deepEqual(scriptedAudits(), FOUR_AUDITS);
});

test('a reconnect still analysing when the economy is seeded on the real runner finishes on the sample stand-in', async () => {
  await seedSample(NOW);
  disconnect(H);
  await connect(H);
  // The seed installs the stand-in only when the real runner is in place, as in tools/sample.ts.
  setRunner(realRunner);
  await seedEconomy(NOW);
  assert.equal(getRepo(H)?.status, 'ready', `the analysis ended ${getRepo(H)?.status}: ${getRepo(H)?.error ?? ''}`);
  assert.deepEqual(scriptedAudits(), FOUR_AUDITS);
});

test('a seed that throws while it writes the history releases the hold on the automatic audit', async () => {
  const { queueAudit } = await import('../engine/audit/run.js');
  await seedSample(NOW);
  // An audit already waiting on the harbour stops the history at its scripted audit.
  queueAudit(getRepo(H)!, 'demand', NOW - 9 * 86_400_000);
  await assert.rejects(seedEconomy(NOW), /already has an audit waiting or under way/);
  setMarket(K, false);
  patchRepo(K, { market: true });
  assert.deepEqual(
    listAudits({ repo: K }).map((a) => a.trigger),
    ['connect'],
    'the market switch queues its automatic audit again',
  );
});

test('the sample layout holds: every tower keeps its founding and earned floors', async () => {
  await seed();
  const towers = (openDb().prepare('SELECT DISTINCT tower_id AS t FROM earned_floors ORDER BY tower_id').all() as Array<{ t: string }>).map((r) => r.t);
  const layout = Object.fromEntries([
    ...listRepos().map((r) => [`${r.fullName} founding`, foundingFloorCount(r.fullName)] as const),
    ...towers.map((t) => [t, earnedFloors(t).map((f) => f.earned?.state ?? '?').join(' ')] as const),
  ]);
  assert.deepEqual(layout, SAMPLE_LAYOUT);
});

test('seedSample writes the reading sampleReading writes, and clears a latest.json left in the home', async () => {
  mkdirSync(paths().usage, { recursive: true });
  const latest = join(paths().usage, 'latest.json');
  writeFileSync(latest, '{}');
  await seedSample(NOW);
  assert.equal(existsSync(latest), false, 'a latest.json would stand in front of the seeded reading');
  const readings = join(paths().usage, 'readings.jsonl');
  const seeded = readFileSync(readings, 'utf8');
  sampleReading(NOW);
  assert.equal(readFileSync(readings, 'utf8'), seeded);
});

test('the clock ends the reading audit done with two new proposals and events', async () => {
  await seed();
  const seen: Array<{ type: string; data: any }> = [];
  const unsubscribe = subscribe((e) => seen.push(e as { type: string; data: any }));
  try {
    const before = listJobs({ repo: K, source: 'proposal' }).length;
    let t = NOW;
    const clock = economyClock({ now: () => t, speed: 20 });
    for (let i = 0; i < 25; i++) {
      t += 1000;
      clock.tick(1000);
      await clock.idle();
    }
    clock.stop();
    const kumo = listAudits({ repo: K })[0];
    assert.equal(kumo.status, 'done');
    assert.ok(kumo.endedAt && Date.parse(kumo.endedAt) > NOW);
    for (const v of ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN'] as Verdict[]) assert.ok(kumo.counts[v] > 0, `a ${v} finding`);
    assert.equal(kumo.findings.length, kumo.claimsRead);
    assert.ok(kumo.findings.filter((f) => !f.unverified).every((f) => f.evidence.some((e) => e.verified)));
    assert.ok(kumo.markdownPath && existsSync(kumo.markdownPath));
    assert.match(readFileSync(kumo.markdownPath!, 'utf8'), /stubbed/);
    assert.equal(getRepo(K)?.auditedAt, kumo.endedAt);
    const proposals = listJobs({ repo: K, source: 'proposal' });
    assert.equal(proposals.length, before + 2, 'two proposals posted');
    assert.ok(proposals.every((j) => j.status === 'proposed' && j.proposal?.auditId === kumo.id));
    assert.deepEqual(kumo.findings.filter((f) => f.proposal).map((f) => f.proposal!.jobId).sort(), proposals.map((j) => j.id).sort(), 'each finding names its job');
    for (const type of ['audit.log', 'audit.progress', 'audit.ended', 'job.proposed']) assert.ok(seen.some((e) => e.type === type), `a ${type} event`);
    assert.equal(seen.filter((e) => e.type === 'audit.ended').length, 1);
    assert.ok(openDb().prepare("SELECT 1 FROM credits WHERE kind = 'audit' AND run_id = ?").get(kumo.id), 'the session was charged to the city');
    const v = verifyReplay();
    assert.ok(v.ok, v.diffs.join('\n'));
  } finally {
    unsubscribe();
  }
});

test('with runs off the clock ends the reading audit and leaves every run and job where the seed left it', async () => {
  await seed();
  const runsBefore = JSON.stringify(listRuns().map((r) => [r.id, r.stage, r.outcome]));
  const jobsBefore = JSON.stringify(listJobs().filter((j) => j.source !== 'proposal').map((j) => [j.id, j.status]));
  let t = NOW;
  const clock = economyClock({ now: () => t, speed: 20, runs: false });
  for (let i = 0; i < 25; i++) {
    t += 1000;
    clock.tick(1000);
    await clock.idle();
  }
  clock.stop();
  assert.equal(listAudits({ repo: K })[0]?.status, 'done', 'the kumo audit ended');
  assert.equal(JSON.stringify(listRuns().map((r) => [r.id, r.stage, r.outcome])), runsBefore, 'no run moved');
  assert.equal(JSON.stringify(listJobs().filter((j) => j.source !== 'proposal').map((j) => [j.id, j.status])), jobsBefore, 'no job moved');
});

test("today's brief holds every item kind", async () => {
  await inLosAngeles(async () => {
    await seedSample(MONDAY);
    await seedEconomy(MONDAY);
    const b = openBrief(MONDAY);
    assert.equal(b.firstOpen, true);
    assert.equal(b.due, true);
    const items = briefItems(b);
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ['pr', 'proposal', 'merged', 'failed', 'halt', 'revert', 'note', 'audit', 'audit-due', 'usage', 'tour'] as BriefItemKind[]) {
      assert.ok(kinds.has(k), `a ${k} item (${[...kinds].join(', ')})`);
    }
    assert.ok(!kinds.has('stale'), 'the reading is fresh');
    // His answers of last night stand on their lines.
    const acted = items.filter((i) => i.kind === 'proposal' && i.acted).map((i) => i.acted!.action).sort();
    assert.deepEqual(acted, ['accept', 'dismiss']);
    assert.ok(items.filter((i) => i.kind === 'proposal' && !i.acted && i.actions.includes('accept')).length >= 3, 'the rest still offer accept');
    const usage = items.find((i) => i.kind === 'usage')!;
    assert.match(usage.title, /five-hour window is at 44/);
    assert.deepEqual(usage.actions, ['cap']);
    const failed = items.find((i) => i.kind === 'failed')!;
    assert.match(failed.text, /The run finished without changing anything\./);
    const note = items.find((i) => i.kind === 'note')!;
    assert.match(note.text, /merged with changes/);
    assert.match(items.find((i) => i.kind === 'audit')!.text, /14 claims read/);
    assert.match(items.find((i) => i.kind === 'audit-due')!.title, /was never audited/);
    assert.ok(b.tour && b.tour.stops >= 2, 'the Monday brief offers last week');
    assert.match(b.lead, /README audits/, `the lead counts the audit's spend: ${b.lead}`);
    assert.equal(query({ kind: 'brief.opened' }).length, 7, 'six seeded mornings and this one');
    assert.equal(briefData(MONDAY).firstOpen, false);
  });
});

test("the week tour walks last week's skyline, revival, ribbons and scars between the exchange's ends", async () => {
  await inLosAngeles(async () => {
    await seedSample(MONDAY);
    await seedEconomy(MONDAY);
    const tour = weekTour('2026-11-02');
    assert.ok(tour, 'a tour');
    assert.equal(tour.week, '2026-11-02');
    assert.equal(tour.stops.length, 10, 'eight stops between the two ends of the exchange');
    assert.equal(tour.stops[0].kind, 'exchange');
    assert.equal(tour.stops.at(-1)!.kind, 'exchange');
    const kinds = new Set<string>(tour.stops.slice(1, -1).map((s) => s.kind));
    for (const k of ['skyline', 'revival', 'ribbon', 'scar']) assert.ok(kinds.has(k), `a ${k} stop (${[...kinds].join(', ')})`);
    for (const s of tour.stops.slice(1, -1)) {
      assert.match(s.caption, /, (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
      assert.equal(s.dwell, 6);
      assert.equal(s.glide, 4);
    }
    assert.equal(Math.round(tour.seconds), 90);
    assert.ok(tour.stops.slice(1, -1).every((s, i, xs) => i === 0 || xs[i - 1].at <= s.at), 'in time order');
  });
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

test('the economy reads his plan as measured, and has a stale reading to pause on', async () => {
  const { storedCalibration } = await import('../engine/usage.js');
  const { treasury } = await import('../engine/market/budget.js');
  const { latestReport } = await import('../engine/market/report.js');
  const { sampleReading } = await import('../engine/market/sample-economy.js');
  await seed();
  const cal = storedCalibration();
  assert.equal(cal.value, 58_000, '1% of the window is about 58,000 weighted tokens');
  assert.equal(cal.samples, 14, 'measured from 14 pairs');
  assert.match(latestReport()!.markdown, /about 58,000 weighted tokens, measured from 14 pairs/, 'the reports say so too');
  const fresh = treasury(NOW);
  assert.equal(fresh.fiveHour.usedPct, 44);
  assert.equal(fresh.sevenDay.usedPct, 21);
  assert.notEqual(fresh.paused?.reason, 'stale');

  sampleReading(NOW, { stale: true });
  const stale = treasury(NOW);
  assert.equal(stale.paused?.reason, 'stale', 'six hours without a reading pauses Claude work');
  assert.equal(stale.sevenDay.usedPct, 21, 'the week has not reset since');
  sampleReading(NOW);
  assert.notEqual(treasury(NOW).paused?.reason, 'stale', 'and a fresh one carries on');
});
