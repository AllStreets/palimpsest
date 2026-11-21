/**
 * The morning brief (Phase 3 Task 6): items from the ledger since his last
 * look and from the live state, one `brief.opened` a day, his actions
 * recorded as `brief.action`. Temp home only; no model, no gh.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { saveAudit } from '../engine/audit/store.js';
import { actOn, briefData, briefDay, briefSince, openBrief } from '../engine/brief.js';
import { openDb } from '../engine/db.js';
import { entries, record } from '../engine/ledger.js';
import { treasury } from '../engine/market/budget.js';
import { seedFirms } from '../engine/market/firms.js';
import { job as storedJob, postManualJob, postProposal, repost, transition } from '../engine/market/jobs.js';
import { haltRepo } from '../engine/market/runs.js';
import { installTreasury } from '../engine/market/treasury.js';
import { askDue, grantOf, noteActed, noteActResult } from '../engine/school/autonomy.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { localDay } from '../shared/day.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import { AGREE } from '../shared/school-rules.js';
import type { Audit, Bid, Brief, BriefItem, Decision, Grant, Job, Repo, Run, Tour, TourStop, WorkKind } from '../shared/types.js';
import { checks, FULL, HOUR, noReading, setUp, tearDown } from './guild-fixtures.js';
import { agreedDecisions, constant, installNet, netOf } from './school-fixtures.js';
import { paths } from '../engine/home.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let off: () => void = () => {};
beforeEach(() => {
  setUp('brief');
  off = installTreasury();
});
afterEach(async () => {
  off();
  await tearDown();
});

const DAY = 24 * 3_600_000;

function addRepo(full: string, over: Partial<Repo> = {}): Repo {
  const repo: Repo = {
    fullName: full,
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
    checks: checks(),
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

function bidOn(j: Job, firmId: string, agentId: string, price: number): Bid {
  const bid: Bid = { id: `bid-${j.id}`, jobId: j.id, firmId, agentId, plan: 'Read, change, test.', price, confidence: 0.8, calibrated: 0.68, appraisal: null, ev: 10, cost: 2, at: new Date().toISOString() };
  openDb().prepare('INSERT INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(bid.id, bid.jobId, JSON.stringify({ round: 'r', bid }));
  record('bid.placed', { bid, calls: 1, charged: { kind: 'bid', credits: 2, by: 'budget' } });
  record('job.awarded', { jobId: j.id, tier: j.tier, considered: [bid], satOut: [], chosen: bid, why: 'test', at: new Date().toISOString(), coolOffUntil: null });
  return bid;
}

function waitingRun(j: Job, agentId: string, firmId: string, pr: number): Run {
  const r: Run = {
    id: `run-${j.id}`,
    jobId: j.id,
    bidId: `bid-${j.id}`,
    agentId,
    firmId,
    repo: j.repo,
    model: 'claude:sonnet',
    branch: `palimpsest/${j.id}`,
    dir: null,
    baseSha: null,
    headSha: 'b'.repeat(40),
    stage: 'waiting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 1, testsRun: 0, turns: 3, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: new Date().toISOString(),
    endedAt: null,
    prNumber: pr,
    prUrl: `https://github.com/${j.repo}/pull/${pr}`,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    summary: 'Changed it.',
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  record('run.started', { runId: r.id, jobId: j.id, run: r });
  return r;
}

/** A merged job on `repo`, won by Quickset. */
function mergedJob(repo: string, title: string): Job {
  let j = postManualJob({ repo, title, body: 'Change it.', tier: 'normal' });
  j = transition(j, 'bidding');
  const bid = bidOn(j, 'quickset', 'ola-bergstrom', 24);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'] as const) j = transition(j, to, to === 'awarded' ? { awardedBid: bid.id } : {});
  return j;
}

/** A job that failed once, with an attempt left. */
function failedJob(repo: string, title: string): Job {
  let j = postManualJob({ repo, title, body: 'Rename.', tier: 'low' });
  j = transition(transition(transition(transition(j, 'bidding'), 'awarded'), 'running'), 'inspecting');
  record('run.ended', { runId: `run-f-${j.id}`, jobId: j.id, outcome: 'failed', reason: 'The change failed inspection.', summary: null, run: { id: `run-f-${j.id}`, jobId: j.id } });
  return transition(j, 'failed');
}

/** A job waiting on its PR. */
function prJob(repo: string, title: string, pr: number): { job: Job; run: Run } {
  let j = postManualJob({ repo, title, body: 'Tidy.', tier: 'normal' });
  j = transition(j, 'bidding');
  bidOn(j, 'ashlar-vane', 'ines-ashlar', 30);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) j = transition(j, to);
  return { job: j, run: waitingRun(j, 'ines-ashlar', 'ashlar-vane', pr) };
}

/** A done audit of `repo` with one MISSING finding, and the proposal posted from it. */
function auditWithProposal(repo: string): { audit: Audit; job: Job } {
  const claim = 'The CLI exports every report as CSV';
  const audit: Audit = {
    id: 'audit-abc123',
    repo,
    model: 'claude:sonnet',
    trigger: 'demand',
    baseSha: 'a'.repeat(40),
    status: 'done',
    waitingReason: null,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: new Date().toISOString(),
    endedReason: null,
    findings: [
      {
        id: 'f1',
        claim,
        source: { file: 'README.md', line: 12 },
        verdict: 'MISSING',
        tested: false,
        evidence: [{ file: 'src/cli.ts', line: 3, note: 'No export command.', verified: true }],
        unverified: false,
        proposal: { key: `${repo}#abcdef123456`, title: 'Add the CSV export', body: 'Add it.', scope: ['src/**'], acceptance: ['CSV export exists'], tier: 'normal', jobId: null },
      },
    ],
    counts: { REAL: 0, PARTIAL: 0, MISSING: 1, STUBBED: 0, BROKEN: 0 },
    unverified: 0,
    claimsRead: 1,
    credits: 4,
    unattended: false,
    markdownPath: null,
  };
  saveAudit(audit);
  record('audit.ended', { auditId: audit.id, repo, status: 'done', reason: null, audit });
  const job = postProposal({ repo, title: 'Add the CSV export', body: `Claim: ${claim}\n\nAdd it.`, scope: ['src/**'], acceptance: ['CSV export exists'], tier: 'normal', key: `${repo}#abcdef123456`, source: 'proposal', proposal: { auditId: audit.id, findingId: 'f1' } });
  return { audit, job };
}

function allItems(b: Brief): BriefItem[] {
  return [...b.sections.waiting, ...b.sections.overnight, ...b.sections.recommendations, ...b.sections.city];
}

function item(b: Brief, id: string): BriefItem {
  const it = allItems(b).find((x) => x.id === id);
  assert.ok(it, `no item ${id} in ${allItems(b).map((x) => x.id).join(', ')}`);
  return it;
}

/** A ledger row at a chosen time, as the engine would have written it. */
function put(ms: number, kind: string, data: object): void {
  openDb().prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)').run(new Date(ms).toISOString(), kind, JSON.stringify(data));
}

/** His usage reading, taken now, with both windows chosen. */
function readingOf(o: { five: number; seven: number }): void {
  const now = Date.now();
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(now / 1000),
      rate_limits: {
        five_hour: { used_percentage: o.five, resets_at: Math.floor((now + HOUR) / 1000) },
        seven_day: { used_percentage: o.seven, resets_at: Math.floor((now + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

function morningOf(ms: number, hour: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime();
}

test('the brief lists what merged, failed and waits since the previous open day, with the actions each offers', () => {
  seedFirms([]);
  addRepo(FULL);
  addRepo('acme/gears');
  const merged = mergedJob(FULL, 'Fix the header');
  const failed = failedJob(FULL, 'Rename the gears');
  const { run } = prJob('acme/gears', 'Tidy the gear table', 41);
  const { job: proposal } = auditWithProposal(FULL);
  haltRepo('acme/gears', 'A city merge was reverted: Tidy the gear table');

  const now = Date.now();
  const b = briefData(now);
  assert.equal(b.day, localDay(now));
  assert.equal(b.day, briefDay(now));
  assert.equal(b.firstOpen, true, 'nothing opened it yet today');

  const m = item(b, `merged:${merged.id}`);
  assert.equal(m.kind, 'merged');
  assert.match(m.title, /Fix the header/);
  assert.ok(m.actions.includes('fly'));
  assert.equal(m.acted, null);

  const f = item(b, `failed:${failed.id}`);
  assert.equal(f.kind, 'failed');
  assert.match(f.text, /failed inspection/i, 'a failure says why');
  assert.deepEqual([...f.actions].sort(), ['dismiss', 'retry', 'why']);

  const pr = item(b, `pr:${run.id}`);
  assert.equal(pr.kind, 'pr');
  assert.match(pr.text, /#41/);
  assert.equal(pr.refs.prUrl, run.prUrl);
  assert.ok(pr.actions.includes('open-pr'));
  assert.ok(b.sections.waiting.some((x) => x.id === pr.id), 'a PR waits on him');

  const p = item(b, `proposal:${proposal.id}`);
  assert.equal(p.kind, 'proposal');
  assert.equal(p.tier, 'normal');
  assert.match(p.text, /CSV/, 'a proposal carries its claim');
  assert.deepEqual([...p.actions].sort(), ['accept', 'dismiss', 'tier', 'why']);
  assert.equal(p.refs.auditId, 'audit-abc123');

  const h = item(b, `halt:acme/gears`);
  assert.equal(h.kind, 'halt');
  assert.deepEqual([...h.actions].sort(), ['resume', 'why']);

  const a = item(b, 'audit:audit-abc123');
  assert.equal(a.kind, 'audit');
  assert.match(a.text, /1 claim/);

  // acme/gears was never audited; acme/widgets was.
  assert.equal(item(b, 'audit-due:acme/gears').kind, 'audit-due');
  assert.deepEqual([...item(b, 'audit-due:acme/gears').actions].sort(), ['audit', 'dismiss']);
  assert.ok(!allItems(b).some((x) => x.id === `audit-due:${FULL}`));

  // The lead says the window in two short sentences of at most three counts: what waits on him, what merged,
  // what the city spent (audit 2026-11-17); the failed run is its own row overnight. No dash, no emoji.
  assert.match(b.lead, /1 merged/);
  assert.match(b.lead, /^\d+ (thing waits|things wait) on you|^Nothing waits on you/, b.lead);
  assert.ok((b.lead.match(/\d+(?:[.,]\d+)*/g) ?? []).length <= 3, `at most three counts: ${b.lead}`);
  assert.equal(b.lead.split(/(?<=\.)\s+/).length, 2, b.lead);
  for (const it of allItems(b)) assert.doesNotMatch(`${it.title} ${it.text}`, /\u2014|\u2013|--|\p{Extended_Pictographic}/u);
  assert.equal(b.usage.todayCapPct, null);
  assert.equal(b.tour, null);
});

test('two briefs the same day carry the same items and the second says firstOpen false', () => {
  seedFirms([]);
  addRepo(FULL);
  mergedJob(FULL, 'Fix the header');
  auditWithProposal(FULL);
  const now = Date.now();
  const first = openBrief(now);
  assert.equal(first.firstOpen, true);
  assert.equal(first.due, true, 'items wait, so the brief opens before the city');
  const second = openBrief(now + 60_000);
  assert.equal(second.firstOpen, false);
  assert.equal(second.due, false);
  assert.deepEqual(allItems(second).map((x) => x.id), allItems(first).map((x) => x.id));
  assert.equal(second.since, first.since);
  const opened = entries().filter((e) => e.kind === 'brief.opened');
  assert.equal(opened.length, 1, 'one brief.opened a day');
  const d = opened[0].data as { day: string; since: string; items: string[] };
  assert.equal(d.day, localDay(now));
  assert.equal(d.since, first.since);
  assert.deepEqual(d.items, allItems(first).map((x) => x.id));
  assert.ok(!entries().some((e) => e.kind === 'brief.action'), 'no per-item seen rows');
});

test('an empty morning still records brief.opened with no items and due false', () => {
  seedFirms([]);
  const now = Date.now();
  const b = openBrief(now);
  assert.equal(b.firstOpen, true);
  assert.equal(b.due, false);
  assert.deepEqual(allItems(b), []);
  assert.match(b.lead, /Nothing/);
  const opened = entries().filter((e) => e.kind === 'brief.opened');
  assert.equal(opened.length, 1);
  assert.deepEqual((opened[0].data as { items: string[] }).items, []);
});

test('his real setup: six repos, every market off, never audited, a stale reading, gives no brief before the city', () => {
  seedFirms([]);
  for (const r of ['ann/one', 'ann/two', 'ann/three', 'ann/four', 'ann/five', 'ann/six']) addRepo(r, { market: false });
  noReading();
  const day1 = morningOf(Date.now(), 8);
  const b1 = briefData(day1);
  assert.ok(!allItems(b1).some((x) => x.kind === 'audit-due'), 'a repo whose market is off is never "audit due"');
  assert.ok(!allItems(b1).some((x) => x.kind === 'stale'), 'a stale reading with every market off waits on nothing');
  assert.equal(b1.due, false, 'no brief opens before the city');
  openBrief(day1);
  assert.equal(briefData(day1 + DAY).due, false, 'nor the morning after');
});

test('a dismissed "audit due" stays dismissed until its market is turned on again, and standing lines never open the brief', () => {
  seedFirms([]);
  addRepo('ann/one');
  addRepo('ann/two');
  const day1 = morningOf(Date.now(), 8);
  const b1 = openBrief(day1);
  assert.ok(item(b1, 'audit-due:ann/one'));
  assert.equal(b1.due, false, 'a recommendation alone does not open the brief before the city');
  actOn('audit-due:ann/one', 'dismiss', {}, day1 + 60_000);
  for (const later of [day1 + DAY, day1 + 3 * DAY, day1 + 10 * DAY]) {
    openBrief(later);
    const b = briefData(later + 60_000);
    assert.ok(!allItems(b).some((x) => x.id === 'audit-due:ann/one'), `still dismissed ${Math.round((later - day1) / DAY)} days on`);
    assert.ok(allItems(b).some((x) => x.id === 'audit-due:ann/two'), 'the other stays offered');
  }
  // Turned off and on again: something changed, so the line returns.
  put(day1 + 11 * DAY, 'repo.patched', { repo: 'ann/one', patch: { market: true } });
  assert.ok(allItems(briefData(day1 + 11 * DAY + 60_000)).some((x) => x.id === 'audit-due:ann/one'), 'offered again once its market is turned on again');
});

test('a stale reading is a brief item only while a market-on repo has work for Claude', () => {
  seedFirms([]);
  addRepo(FULL);
  noReading();
  const now = Date.now();
  assert.ok(!allItems(briefData(now)).some((x) => x.kind === 'stale'), 'market on, but nothing to spend on');
  postManualJob({ repo: FULL, title: 'Tidy the gear table', body: 'Tidy.', tier: 'low' });
  const b = briefData(now);
  assert.equal(item(b, 'stale').kind, 'stale', 'an open job waits on the reading');
  assert.equal(b.due, b.firstOpen, 'and that is worth opening the brief for');
});

test('a passed spire holder is not news in the brief', () => {
  seedFirms([]);
  const now = Date.now();
  const row = (id: string, lit: boolean) => ({ id, kind: 'skyline', towerId: `${id}#founding`, repo: id, firmId: null, agentId: null, floorId: null, at: new Date(now - HOUR).toISOString(), until: null, lit, title: lit ? 'The skyline' : 'Held the skyline', detail: '' });
  const rows = [row('ann/new', true), row('ann/old', false)];
  for (const m of rows) record('milestone.reached', { milestone: m });
  const b = briefData(now, { milestones: () => rows as never });
  assert.ok(allItems(b).some((x) => x.id === 'milestone:ann/new'), 'the new holder is news');
  assert.ok(!allItems(b).some((x) => x.id === 'milestone:ann/old'), 'the old one is not');
});

test("since reaches the previous open day's first open, not the same day's", () => {
  const now = Date.now();
  // No open on record: a day back.
  assert.equal(briefSince(now), new Date(now - DAY).toISOString());
  // Three days ago he opened it twice; yesterday twice; today once already.
  const d3 = now - 3 * DAY;
  const d1 = now - DAY;
  put(morningOf(d3, 8), 'brief.opened', { day: localDay(d3), since: '', items: [] });
  put(morningOf(d3, 21), 'brief.opened', { day: localDay(d3), since: '', items: [] });
  put(morningOf(d1, 9), 'brief.opened', { day: localDay(d1), since: '', items: [] });
  put(morningOf(d1, 22), 'brief.opened', { day: localDay(d1), since: '', items: [] });
  put(morningOf(now, 0) + 60_000, 'brief.opened', { day: localDay(now), since: '', items: [] });
  assert.equal(briefSince(now), new Date(morningOf(d1, 9)).toISOString());
  // A merge before yesterday's first open is not in the window; one after it is.
  seedFirms([]);
  addRepo(FULL);
  const old = postManualJob({ repo: FULL, title: 'Old news', body: 'x', tier: 'normal' });
  put(morningOf(d1, 8), 'job.changed', { id: old.id, from: 'waiting', to: 'merged', job: { ...old, status: 'merged' } });
  const fresh = postManualJob({ repo: FULL, title: 'Fresh news', body: 'x', tier: 'normal' });
  put(morningOf(d1, 10), 'job.changed', { id: fresh.id, from: 'waiting', to: 'merged', job: { ...fresh, status: 'merged' } });
  const b = briefData(now);
  assert.ok(!allItems(b).some((x) => x.id === `merged:${old.id}`));
  assert.ok(allItems(b).some((x) => x.id === `merged:${fresh.id}`));
  assert.equal(b.firstOpen, false);
});

test('accept on a proposal opens it and records a taught action', () => {
  seedFirms([]);
  addRepo(FULL);
  const { job } = auditWithProposal(FULL);
  const now = Date.now();
  openBrief(now);
  const r = actOn(`proposal:${job.id}`, 'accept', {}, now);
  assert.equal(r.item.acted?.action, 'accept');
  assert.equal(storedJob(job.id)?.status, 'open');
  const [a] = entries().filter((e) => e.kind === 'brief.action');
  assert.ok(a);
  const d = a.data as { day: string; itemId: string; kind: string; action: string; taught: boolean };
  assert.equal(d.itemId, `proposal:${job.id}`);
  assert.equal(d.kind, 'proposal');
  assert.equal(d.action, 'accept');
  assert.equal(d.taught, true);
  assert.equal(d.day, localDay(now));
  // The item stays in the brief with its action, and is not offered accept again.
  const after = briefData(now);
  const it = item(after, `proposal:${job.id}`);
  assert.equal(it.acted?.action, 'accept');
  assert.ok(!it.actions.includes('accept'));
});

test('asking why after acting keeps what he did on the item; looking alone leaves the look', () => {
  seedFirms([]);
  addRepo(FULL);
  const { job } = auditWithProposal(FULL);
  const now = Date.now();
  openBrief(now);
  actOn(`proposal:${job.id}`, 'accept', {}, now);
  const r = actOn(`proposal:${job.id}`, 'why', {}, now + 60_000);
  assert.equal(r.item.acted?.action, 'accept', 'the answer to Ask why still carries the accept');
  assert.equal(item(briefData(now + 120_000), `proposal:${job.id}`).acted?.action, 'accept', 'and so does the brief');
  // Both are in the ledger: the look is recorded, it only does not cover the act.
  assert.deepEqual(entries().filter((e) => e.kind === 'brief.action').map((e) => (e.data as { action: string }).action), ['accept', 'why']);
  const { job: other } = auditWithProposal(FULL);
  actOn(`proposal:${other.id}`, 'why', {}, now);
  assert.equal(item(briefData(now + 1000), `proposal:${other.id}`).acted?.action, 'why');
});

test('a look never carries a posted proposal into a later window: only his answer keeps its line', () => {
  seedFirms([]);
  addRepo(FULL, { market: false });
  const { job } = auditWithProposal(FULL);
  const day1 = morningOf(Date.now(), 8);
  openBrief(day1);
  actOn(`proposal:${job.id}`, 'accept', {}, day1 + 60_000);
  // The next window still shows his answer, and he asks why there (his real Nov 19).
  const day2 = day1 + DAY;
  openBrief(day2);
  assert.equal(item(briefData(day2 + 1000), `proposal:${job.id}`).acted?.action, 'accept');
  actOn(`proposal:${job.id}`, 'why', {}, day2 + 60_000);
  // A window later, the look alone must not bring the posted job back as waiting on him.
  const day3 = day2 + DAY;
  openBrief(day3);
  const b = briefData(day3 + 1000);
  assert.ok(!allItems(b).some((x) => x.id === `proposal:${job.id}`), 'a look is not an answer');
  assert.equal(b.counts.waiting, 0);
});

test('dismiss withdraws a proposal by him and is recorded as taught', () => {
  seedFirms([]);
  addRepo(FULL);
  const { job } = auditWithProposal(FULL);
  const now = Date.now();
  actOn(`proposal:${job.id}`, 'dismiss', {}, now);
  const j = storedJob(job.id);
  assert.equal(j?.status, 'withdrawn');
  assert.equal(j?.withdrawnBy, 'him');
  const d = entries().find((e) => e.kind === 'brief.action')?.data as { action: string; taught: boolean };
  assert.deepEqual([d.action, d.taught], ['dismiss', true]);
  // Dismissing a line that is not a proposal only hides it, and is taught as well.
  addRepo('acme/gears');
  const r = actOn('audit-due:acme/gears', 'dismiss', {}, now);
  assert.equal(r.item.acted?.action, 'dismiss');
  const acts = entries().filter((e) => e.kind === 'brief.action');
  assert.equal(acts.length, 2);
  assert.equal((acts[1].data as { taught: boolean }).taught, true);
  assert.equal(item(briefData(now), 'audit-due:acme/gears').acted?.action, 'dismiss');
});

test('tier changes the value and stays', () => {
  seedFirms([]);
  addRepo(FULL);
  const { job } = auditWithProposal(FULL);
  const now = Date.now();
  const before = storedJob(job.id)!;
  const r = actOn(`proposal:${job.id}`, 'tier', { tier: 'high' }, now);
  const after = storedJob(job.id)!;
  assert.equal(after.tier, 'high');
  assert.ok(after.value > before.value, 'the value follows the tier');
  assert.equal(after.status, 'proposed', 'it stays proposed');
  assert.equal(r.item.tier, 'high');
  const it = item(briefData(now), `proposal:${job.id}`);
  assert.equal(it.tier, 'high');
  assert.equal(it.acted?.action, 'tier');
  assert.ok(it.actions.includes('accept'), 'he can still accept it');
  const d = entries().find((e) => e.kind === 'brief.action')?.data as { taught: boolean; patch: { tier: string } };
  assert.equal(d.taught, true);
  assert.equal(d.patch.tier, 'high');
  assert.throws(() => actOn(`proposal:${job.id}`, 'tier', {}, now), /tier/);
});

test("cap sets today's limit above the day cap, clamps it and the treasury reports it", () => {
  seedFirms([]);
  patchSettings({ dayCapPct: 20, hardStopPct: 90 });
  const now = Date.now();
  const b = briefData(now);
  assert.equal(item(b, 'usage').kind, 'usage', 'a window at 10% is within 10 points of a 20% cap');
  assert.deepEqual(item(b, 'usage').actions, ['cap']);
  assert.ok(b.sections.recommendations.some((x) => x.id === 'usage'));

  assert.equal(treasury(now).todayCapPct, null, 'no limit of his yet');

  // Raised above the day cap, for today.
  const r = actOn('usage', 'cap', { pct: 25 }, now);
  assert.equal(r.item.acted?.action, 'cap');
  assert.deepEqual(getSettings().todayCapPct, { day: localDay(now), pct: 25 });
  assert.equal(treasury(now).fiveHour.capPct, 25);
  assert.deepEqual(treasury(now).todayCapPct, { day: localDay(now), pct: 25 }, 'the treasury names it as his');
  assert.equal(briefData(now).usage.todayCapPct, 25);
  assert.equal(briefData(now).usage.fiveHour.capPct, 25);

  // With the limit raised, the window is no longer near it, but the line stays while his limit holds, so he can lower it again.
  const kept = item(briefData(now), 'usage');
  assert.deepEqual(kept.actions, ['cap']);
  assert.equal(kept.acted?.action, 'cap');

  // Clamped under the hard stop.
  actOn('usage', 'cap', { pct: 99 }, now);
  assert.deepEqual(getSettings().todayCapPct, { day: localDay(now), pct: 85 });
  assert.equal(treasury(now).fiveHour.capPct, 85);
  assert.deepEqual(treasury(now).todayCapPct, { day: localDay(now), pct: 85 });
  // And no lower than 5.
  actOn('usage', 'cap', { pct: 1 }, now);
  assert.equal(getSettings().todayCapPct?.pct, 5);
  assert.throws(() => actOn('usage', 'cap', {}, now), /pct/);
  const acts = entries().filter((e) => e.kind === 'brief.action');
  assert.equal(acts.length, 3);
  assert.ok(acts.every((e) => (e.data as { taught: boolean }).taught));
  assert.deepEqual(acts.map((e) => (e.data as { patch: { pct: number } }).patch.pct), [25, 85, 5], 'the patch keeps the clamped value');

  // A window well under the cap offers nothing.
  patchSettings({ dayCapPct: 50, todayCapPct: null });
  assert.ok(!allItems(briefData(now)).some((x) => x.id === 'usage'));
  // Yesterday's limit has expired: no line for it.
  patchSettings({ todayCapPct: { day: localDay(now - DAY), pct: 25 } });
  assert.equal(treasury(now).todayCapPct, null);
  assert.ok(!allItems(briefData(now)).some((x) => x.id === 'usage'));
});

test('the usage line offers cap only when the five-hour window is the trigger', () => {
  seedFirms([]);
  patchSettings({ dayCapPct: 50, hardStopPct: 90 });
  const now = Date.now();
  // The seven-day window near the hard stop, the five-hour one far from its cap: the line says so and offers no cap.
  readingOf({ five: 10, seven: 85 });
  const weekly = item(briefData(now), 'usage');
  assert.match(weekly.title, /seven-day/);
  assert.deepEqual(weekly.actions, []);
  assert.throws(() => actOn('usage', 'cap', { pct: 60 }, now), /does not offer cap/);
  // The five-hour window near its cap: today's limit is the lever.
  readingOf({ five: 45, seven: 10 });
  const daily = item(briefData(now), 'usage');
  assert.match(daily.title, /five-hour/);
  assert.deepEqual(daily.actions, ['cap']);
});

test("the window's numbers step by calendar day across a change to summer time", () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // Clocks went forward on Sunday 8 March 2026. He last opened the app late on the Friday.
    const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
    put(at(2026, 3, 6, 23, 30), 'brief.opened', { day: '2026-03-06', since: '', items: [] });
    const report = (day: string, all: number) => put(at(...(day.split('-').map(Number) as [number, number, number]), 23, 59), 'report.written', { day, path: null, data: { day, jobs: { merged: [], failed: [] }, spend: { total: { all } } } });
    report('2026-03-06', 1);
    report('2026-03-07', 2);
    report('2026-03-08', 4);
    const now = at(2026, 3, 9, 9);
    const b = briefData(now);
    assert.equal(b.since, new Date(at(2026, 3, 6, 23, 30)).toISOString());
    assert.match(b.lead, /spent 7 credits/, `the 23-hour day is counted: ${b.lead}`);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('retry reposts a failed job with an attempt left through the same path as the board', () => {
  seedFirms([]);
  addRepo(FULL);
  const failed = failedJob(FULL, 'Rename the gears');
  const now = Date.now();
  const r = actOn(`failed:${failed.id}`, 'retry', {}, now);
  assert.equal(storedJob(failed.id)?.status, 'open');
  assert.equal(r.item.acted?.action, 'retry');
  assert.ok(!r.item.actions.includes('retry'));
  const d = entries().find((e) => e.kind === 'brief.action')?.data as { taught: boolean };
  assert.equal(d.taught, true);
  // The job is open now, so the line in a fresh brief offers no retry.
  assert.ok(!item(briefData(now), `failed:${failed.id}`).actions.includes('retry'));
  assert.throws(() => repost(failed.id), /not failed|is open/);
});

test('an action the item does not offer is refused', () => {
  seedFirms([]);
  addRepo(FULL);
  addRepo('acme/gears');
  const { job } = auditWithProposal(FULL);
  const { run } = prJob('acme/gears', 'Tidy the gear table', 41);
  const now = Date.now();
  assert.throws(() => actOn(`proposal:${job.id}`, 'resume', {}, now), /does not offer resume/);
  assert.throws(() => actOn(`pr:${run.id}`, 'accept', {}, now), /does not offer accept/);
  assert.throws(() => actOn('halt:acme/gears', 'resume', {}, now), /no brief item/);
  assert.equal(storedJob(job.id)?.status, 'proposed');
  assert.ok(!entries().some((e) => e.kind === 'brief.action'), 'a refused action is not recorded');
});

test('an item acted on carries its action and a PR item stays until its PR closes', () => {
  seedFirms([]);
  addRepo(FULL);
  const { job, run } = prJob(FULL, 'Tidy the gear table', 41);
  const now = Date.now();
  openBrief(now);
  const r = actOn(`pr:${run.id}`, 'open-pr', {}, now);
  assert.equal(r.item.acted?.action, 'open-pr');
  const d = entries().find((e) => e.kind === 'brief.action')?.data as { taught: boolean; action: string };
  assert.equal(d.taught, false, 'opening the PR teaches nothing');
  const again = item(briefData(now + 60_000), `pr:${run.id}`);
  assert.equal(again.acted?.action, 'open-pr');
  assert.ok(again.actions.includes('open-pr'), 'he can open it again');
  // The PR merges: the item leaves.
  openDb().prepare('UPDATE runs SET stage = ?, json = ? WHERE id = ?').run('done', JSON.stringify({ ...run, stage: 'done', outcome: 'merged' }), run.id);
  transition(job, 'merged');
  const after = briefData(now + 120_000);
  assert.ok(!allItems(after).some((x) => x.id === `pr:${run.id}`));
  assert.ok(allItems(after).some((x) => x.id === `merged:${job.id}`));
});

test('a halted repo appears with Resume, and resume clears it', () => {
  seedFirms([]);
  addRepo('acme/gears');
  haltRepo('acme/gears', 'A city merge was reverted: Tidy the gear table');
  const now = Date.now();
  const h = item(briefData(now), 'halt:acme/gears');
  assert.match(h.text, /reverted/);
  assert.ok(h.actions.includes('resume'));
  assert.ok(briefData(now).sections.waiting.some((x) => x.id === h.id));
  const r = actOn('halt:acme/gears', 'resume', {}, now);
  assert.equal(r.item.acted?.action, 'resume');
  assert.ok(!allItems(briefData(now)).some((x) => x.id === 'halt:acme/gears'));
  assert.ok(entries().some((e) => e.kind === 'repo.resumed'));
  const d = entries().find((e) => e.kind === 'brief.action')?.data as { taught: boolean };
  assert.equal(d.taught, false);
});

test('every value in the brief is redacted, the PR link and the pause included', () => {
  seedFirms([]);
  addRepo(FULL);
  const token = `ghp_${'A1b2C3d4'.repeat(4)}`;
  haltRepo(FULL, `Halted \u2014 ${token} at /Users/someone/.ssh/id_rsa`);
  const { run } = prJob(FULL, 'Tidy the gear table', 41);
  openDb().prepare('UPDATE runs SET json = ? WHERE id = ?').run(JSON.stringify({ ...run, prUrl: `https://github.com/${FULL}/pull/41?token=${token}` }), run.id);
  // Work waiting for Claude on another market-on repo, so the stale reading is an item.
  addRepo('acme/gears');
  postManualJob({ repo: 'acme/gears', title: 'Oil the gears', body: 'Oil.', tier: 'low' });
  noReading();
  const b = briefData(Date.now());
  const text = JSON.stringify(b);
  assert.ok(!text.includes(token));
  assert.ok(!text.includes('/Users/someone'));
  assert.match(item(b, `halt:${FULL}`).text, /\[redacted\]/);
  assert.match(item(b, `pr:${run.id}`).refs.prUrl ?? '', /^https:\/\/github\.com\/acme\/widgets\/pull\/41\?token=\[redacted\]$/);
  assert.equal(b.usage.paused?.reason, 'stale');
  assert.equal(b.usage.paused?.detail, 'No usage reading yet.');
  assert.equal(item(b, 'stale').kind, 'stale');
});

test("the Monday tour counts its real stops, not the exchange's two ends", () => {
  seedFirms([]);
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (((8 - d.getDay()) % 7) || 7), 8).getTime();
  const stop = (kind: TourStop['kind']): TourStop => ({ kind, towerId: null, repo: null, floorId: null, agentId: null, firmId: null, title: kind, caption: kind, at: new Date(monday - DAY).toISOString(), dwell: 6, glide: 4 });
  const tour: Tour = { week: '2026-11-09', from: '', to: new Date(monday - HOUR).toISOString(), stops: [stop('exchange'), stop('merged'), stop('scar'), stop('ribbon'), stop('exchange')], seconds: 46 };
  const b = briefData(monday, { tour: () => tour, milestones: () => [] });
  const it = item(b, 'tour:2026-11-09');
  assert.match(it.text, /3 stops in about 46 seconds/);
  assert.equal(b.tour?.stops, 3);
});

test('a look after a dismiss keeps the dismiss on the item', () => {
  seedFirms([]);
  addRepo(FULL);
  const merged = mergedJob(FULL, 'Fix the header');
  const now = Date.now();
  const id = `merged:${merged.id}`;
  actOn(id, 'dismiss', {}, now);
  const r = actOn(id, 'fly', {}, now + 1000);
  assert.equal(r.item.acted?.action, 'dismiss');
  assert.equal(item(briefData(now + 2000), id).acted?.action, 'dismiss');
});

test("a limit of his equal to the usual cap says so plainly", () => {
  seedFirms([]);
  patchSettings({ dayCapPct: 20, hardStopPct: 90 });
  const now = Date.now();
  actOn('usage', 'cap', { pct: 20 }, now);
  assert.match(item(briefData(now), 'usage').text, /^Today's limit is 20%, the usual cap, held by you until midnight\./);
});

// ---------------------------------------------------------------- triage at work (Phase 4 Task 14)

test('triage reorders recommendations only when trusted and the school is on, and never sets a tier', () => {
  seedFirms([]);
  addRepo('ann/old', { connectedAt: '2026-09-01T00:00:00.000Z' });
  addRepo('ann/new', { connectedAt: '2026-10-25T00:00:00.000Z' });
  const p = postProposal({ repo: 'ann/old', title: 'Add the CSV export', body: 'Add it.', scope: ['src/**'], acceptance: ['CSV export exists'], tier: 'low', key: 'ann/old#csv', source: 'proposal', proposal: null });
  const now = morningOf(Date.now(), 8);
  const recs = (b: Brief) => b.sections.recommendations.map((x) => x.id);
  const phase3 = recs(briefData(now));
  assert.deepEqual(phase3, ['audit-due:ann/old', 'audit-due:ann/new'], 'by time, oldest first');
  // A triage net that prefers fresh items and the high tier.
  const fresh = (v: number) => netOf('triage', v, [{ w: { hours_since_at: 0.001 }, head: -1 }, { w: { 'tier=high': 5 }, head: 1 }], 0);
  const suggestion = (b: Brief) => item(b, `proposal:${p.id}`)?.suggestion ?? null;

  installNet(fresh(1), { trusted: false });
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  assert.deepEqual(recs(briefData(now)), phase3, 'an untrusted triage changes nothing');
  assert.equal(suggestion(briefData(now)), null);

  installNet(fresh(2));
  const b = briefData(now);
  assert.deepEqual(recs(b), ['audit-due:ann/new', 'audit-due:ann/old'], 'trusted and on: the fresher first');
  assert.match(String(suggestion(b)), /high/);
  assert.equal(item(b, `proposal:${p.id}`)?.tier, 'low', 'the tier stays his');
  assert.equal(storedJob(p.id)?.tier, 'low');
  assert.deepEqual(b.sections.waiting.map((x) => x.id), briefData(now).sections.waiting.map((x) => x.id));

  patchSettings({ school: { ...getSettings().school, enabled: false } });
  assert.deepEqual(recs(briefData(now)), phase3, 'the school off: Phase 3 again');
  assert.equal(suggestion(briefData(now)), null);
});

test('an ask for autonomy waits on him, an act is news with revoke, and grant, decline and revoke are taught', () => {
  seedFirms([]);
  const repo = addRepo(FULL, { checks: checks({ test: 'npm test', build: 'npm run build' }) });
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  const now = Date.now();
  installNet(constant('master', 1, 0.95), { at: new Date(now - HOUR).toISOString() });
  // 50 of his accepted README proposals, each guessed approve: the kind is eligible and the repo passes its test
  agreedDecisions('propose:readme-gap', repo.fullName, 50, now - 50 * HOUR);
  assert.equal(askDue(now).length, 1);
  let b = briefData(now);
  const ask = item(b, `autonomy:propose:readme-gap:${FULL}`)!;
  assert.ok(ask, 'the ask is a waiting line');
  assert.ok(b.sections.waiting.includes(ask));
  assert.deepEqual(ask.actions, ['grant', 'decline', 'why']);
  assert.equal(ask.repo, FULL);
  assert.ok(b.due);
  const taught = () => (entries().filter((e) => e.kind === 'brief.action').at(-1)!.data as { action: string; taught: boolean });
  // decline is taught and silences; the line stays with his answer on it
  actOn(ask.id, 'decline', {}, now);
  assert.deepEqual(taught(), { ...taught(), action: 'decline', taught: true });
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'declined');
  b = briefData(now + 60_000);
  assert.equal(item(b, ask.id)?.acted?.action, 'decline');
  assert.deepEqual(item(b, ask.id)?.actions, ['why']);
  // another kind asked and granted, then the city acts under it: an overnight line with revoke
  agreedDecisions('propose:harness', repo.fullName, 50, now - 50 * HOUR);
  askDue(now + 60_000);
  const r = actOn(`autonomy:propose:harness:${FULL}`, 'grant', {}, now + 60_000);
  assert.deepEqual(taught(), { ...taught(), action: 'grant', taught: true });
  assert.deepEqual(r.item.actions, ['why']);
  assert.equal(grantOf('propose:harness', FULL)?.state, 'granted');
  const job = postManualJob({ repo: FULL, title: 'Add a baseline test and build harness', body: 'Add it.', tier: 'low' });
  noteActed('propose:harness', FULL, job.id, now + 120_000);
  noteActResult('propose:harness', FULL, job.id, { ok: true, reason: null }, now + 121_000);
  b = briefData(now + 180_000);
  const acted = b.sections.overnight.find((i) => i.kind === 'acted')!;
  assert.ok(acted, 'the act is news from the night');
  assert.equal(acted.refs.jobId, job.id);
  assert.match(acted.text, /accepted the proposal "Add a baseline test and build harness" on acme\/widgets on its own, under its propose:harness grant\./);
  assert.deepEqual(acted.actions, ['revoke', 'why']);
  const revoked = actOn(acted.id, 'revoke', {}, now + 180_000);
  assert.deepEqual(taught(), { ...taught(), action: 'revoke', taught: true });
  assert.deepEqual(revoked.item.actions, ['why']);
  assert.equal(grantOf('propose:harness', FULL)?.state, 'revoked');
  assert.equal(grantOf('propose:harness', FULL)?.by, 'him');
  // an action the ask does not offer once answered is refused, and the pair stays as he left it
  assert.throws(() => actOn(ask.id, 'grant', {}, now + 240_000), /does not offer grant/);
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'declined');
});

test('a merge the city made on its own is one overnight item that keeps the payment and the "on its own" fact', () => {
  seedFirms([]);
  const repo = addRepo(FULL, { checks: checks({ test: 'npm test', build: 'npm run build' }) });
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  const now = Date.now();
  installNet(constant('master', 1, 0.95), { at: new Date(now - HOUR).toISOString() });
  agreedDecisions('merge:low', repo.fullName, 50, now - 50 * HOUR);
  assert.equal(askDue(now).length, 1);
  actOn(`autonomy:merge:low:${FULL}`, 'grant', {}, now);
  const job = mergedJob(FULL, 'Fix the header');
  noteActed('merge:low', FULL, job.id, now + 1000);
  noteActResult('merge:low', FULL, job.id, { ok: true, reason: null }, now + 2000);
  const b = briefData(now + 60_000);
  const same = allItems(b).filter((i) => i.refs.jobId === job.id);
  assert.equal(same.length, 1, 'one item for the one merge');
  assert.equal(same[0].kind, 'acted');
  assert.match(same[0].text, /^The city merged "Fix the header" on acme\/widgets on its own, under its merge:low grant, and .+ was paid 24 credits\.$/);
  assert.ok(same[0].actions.includes('revoke') && same[0].actions.includes('fly') && same[0].actions.includes('diff'));
  assert.equal(same[0].refs.firmId, 'quickset');
});

// ---------------------------------------------------------------- figures (screens redesign Task 15)

/** A finished audit of `repo` with the given verdict counts; `jobs` of its findings carry a posted proposal. */
function doneAudit(id: string, repo: string, counts: Audit['counts'], jobs: number): Audit {
  const verdicts = (Object.entries(counts) as Array<[Audit['counts'] extends Record<infer V, number> ? V : never, number]>).flatMap(([v, n]) => Array.from({ length: n }, () => v));
  const audit: Audit = {
    id,
    repo,
    model: 'claude:sonnet',
    trigger: 'demand',
    baseSha: 'a'.repeat(40),
    status: 'done',
    waitingReason: null,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: new Date().toISOString(),
    endedReason: null,
    findings: verdicts.map((verdict, i) => ({
      id: `${id}-f${i}`,
      claim: `Claim ${i}`,
      source: { file: 'README.md', line: i + 1 },
      verdict,
      tested: false,
      evidence: [],
      unverified: false,
      proposal: i < jobs ? { key: `${repo}#${id}${i}`, title: `Fix claim ${i}`, body: 'Fix it.', scope: ['src/**'], acceptance: ['It works'], tier: 'normal', jobId: `job-${id}-${i}` } : null,
    })),
    counts,
    unverified: 0,
    claimsRead: verdicts.length,
    credits: 4,
    unattended: false,
    markdownPath: null,
  };
  saveAudit(audit);
  record('audit.ended', { auditId: audit.id, repo, status: 'done', reason: null, audit });
  return audit;
}

/** Most kinds at once: merged, failed, pr, proposal, two audits done and one not, a halt, a revert, a note, audit-due and usage. */
function everyKind(): { merged: Job; failed: Job; run: Run; proposal: Job; reopened: Job } {
  seedFirms([]);
  patchSettings({ dayCapPct: 50, hardStopPct: 90 });
  addRepo(FULL);
  addRepo('acme/gears');
  addRepo('acme/bolts', { market: false });
  addRepo('acme/nuts', { market: false });
  addRepo('acme/new');
  const merged = mergedJob(FULL, 'Fix the header');
  const failed = failedJob(FULL, 'Rename the gears');
  const { run } = prJob('acme/gears', 'Tidy the gear table', 41);
  const reopened = postManualJob({ repo: 'acme/gears', title: 'Oil the gears', body: 'Oil.', tier: 'high' });
  const { job: proposal } = auditWithProposal(FULL);
  doneAudit('audit-stub', 'acme/bolts', { REAL: 2, PARTIAL: 1, MISSING: 1, STUBBED: 1, BROKEN: 1 }, 1);
  const failedAudit: Audit = { ...doneAudit('audit-fail', 'acme/nuts', { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 }, 0), status: 'failed', endedReason: 'The clone could not be read' };
  saveAudit(failedAudit);
  haltRepo('acme/gears', 'A city merge was reverted: Tidy the gear table');
  record('merge.reverted', { repo: FULL, jobId: merged.id, mergeSha: 'c0ffee1234567890abcdef' });
  record('run.note', { repo: FULL, note: 'The tests took eleven minutes' });
  readingOf({ five: 45, seven: 10 });
  return { merged, failed, run, proposal, reopened };
}

test("every kind's sentence stays word for word beside its figures", () => {
  const { merged, failed, run, proposal } = everyKind();
  const b = briefData(Date.now());
  const text = (id: string) => item(b, id).text;
  const title = (id: string) => item(b, id).title;
  assert.equal(text(`merged:${merged.id}`), 'Merged, and Quickset was paid 24 credits.');
  assert.equal(text(`failed:${failed.id}`), 'Failed, with one attempt left. The change failed inspection.');
  assert.equal(text(`pr:${run.id}`), 'PR #41 on acme/gears by Ashlar & Vane waits for your review.');
  assert.equal(text(`proposal:${proposal.id}`), 'The README says "The CLI exports every report as CSV", and the code does not do it yet.');
  assert.equal(text('audit:audit-abc123'), '1 claim read: 1 missing.');
  assert.equal(text('audit:audit-stub'), '6 claims read: 2 real, 1 partial, 1 missing, 1 stubbed and 1 broken; 1 job proposed.');
  assert.equal(text('audit:audit-fail'), 'The audit ended failed: The clone could not be read.');
  assert.equal(text('halt:acme/gears'), 'A city merge was reverted: Tidy the gear table. The market there stays off until you resume it.');
  const revert = allItems(b).find((i) => i.kind === 'revert')!;
  assert.equal(revert.text, 'A merge of "Fix the header" on acme/widgets was reverted (c0ffee1). The market there is halted until you resume it.');
  assert.equal(allItems(b).find((i) => i.kind === 'note')!.text, 'The tests took eleven minutes.');
  assert.equal(text('audit-due:acme/new'), 'Its README has not been checked against its code. An audit reads the clone in a sandbox and proposes jobs for what is missing; nothing runs until you accept one.');
  assert.equal(title('usage'), 'The five-hour window is at 45%');
  assert.equal(text('usage'), 'The cap is 50%. The city pauses at the cap; you can change today\'s limit here, for today only.');
  assert.equal(b.lead, '3 things wait on you; 1 merged since yesterday. The city made no model calls.');
});

test('each item carries the figures its sentence says, as fields', () => {
  const { merged, failed, run, proposal, reopened } = everyKind();
  const b = briefData(Date.now());
  assert.deepEqual(item(b, `merged:${merged.id}`).figures, { kind: 'merged', paid: 24 });
  // One attempt used of two: one left, and Retry would post it again at its value.
  assert.deepEqual(item(b, `failed:${failed.id}`).figures, { kind: 'failed', attemptsLeft: 1, retry: storedJob(failed.id)!.value });
  assert.deepEqual(item(b, `pr:${run.id}`).figures, { kind: 'pr', pr: 41 });
  assert.deepEqual(item(b, `proposal:${proposal.id}`).figures, { kind: 'proposal', cost: 60 });
  assert.deepEqual(item(b, 'audit:audit-abc123').figures, { kind: 'audit', real: 0, partial: 0, missing: 1, stubbed: 0, broken: 0, claims: 1, jobs: 0 });
  const stub = item(b, 'audit:audit-stub').figures;
  assert.deepEqual(stub, { kind: 'audit', real: 2, partial: 1, missing: 1, stubbed: 1, broken: 1, claims: 6, jobs: 1 });
  assert.ok(stub?.kind === 'audit');
  assert.equal(stub.real + stub.partial + stub.missing + stub.stubbed + stub.broken, stub.claims, 'the verdicts sum to the claims read');
  // Review Focus 1: an audit that did not finish has no figures, not zeros.
  assert.equal(item(b, 'audit:audit-fail').figures, null);
  // Resume reopens the job halted from open (it is bid on again, up to its value); the PR halted from waiting spends nothing.
  assert.deepEqual(item(b, 'halt:acme/gears').figures, { kind: 'halt', resume: reopened.value });
  assert.equal(reopened.value, 150);
  assert.deepEqual(allItems(b).find((i) => i.kind === 'revert')!.figures, { kind: 'revert', sha: 'c0ffee1' });
  assert.deepEqual(item(b, 'audit-due:acme/new').figures, { kind: 'audit-due', audit: getSettings().auditMaxCredits });
  const usage = item(b, 'usage');
  assert.deepEqual(usage.figures, { kind: 'usage', window: 'five-hour', nowPct: 45, capPct: 50, mine: false });
  assert.ok(usage.figures?.kind === 'usage');
  assert.equal(usage.figures.nowPct, Math.round(Number(/(\d+(?:\.\d+)?)%/.exec(usage.title)![1])));
  // Kinds with no numbers carry null, never an empty object.
  assert.equal(allItems(b).find((i) => i.kind === 'note')!.figures, null);
  for (const it of allItems(b)) assert.ok(it.figures === null || typeof it.figures === 'object', it.id);
});

test("the brief's counts are the lead's numbers", () => {
  everyKind();
  const b = briefData(Date.now());
  const open = b.sections.waiting.filter((i) => !i.acted).length;
  assert.equal(b.counts.waiting, open);
  assert.equal(b.counts.waiting, 3);
  assert.equal(b.counts.merged, Number(/(\d+) merged/.exec(b.lead)![1]));
  assert.equal(b.counts.spent, 0);
  // Acting on a waiting item takes it off the count, as it does the lead's.
  const pr = b.sections.waiting.find((i) => i.kind === 'pr')!;
  actOn(pr.id, 'open-pr', {}, Date.now());
  const after = briefData(Date.now());
  assert.match(after.lead, new RegExp(`^${after.counts.waiting} things? waits? on you`));
});

test("a proposal's cost follows the tier in force, and the item tier returns carries it", () => {
  seedFirms([]);
  addRepo(FULL);
  const { job } = auditWithProposal(FULL);
  const id = `proposal:${job.id}`;
  const now = Date.now();
  actOn(id, 'tier', { tier: 'high' }, now);
  assert.deepEqual(item(briefData(now), id).figures, { kind: 'proposal', cost: 150 });
  const r = actOn(id, 'tier', { tier: 'low' }, now + 1000);
  assert.deepEqual(r.item.figures, { kind: 'proposal', cost: 20 });
  assert.deepEqual(item(briefData(now + 2000), id).figures, { kind: 'proposal', cost: 20 });
});

test("a limit of his shows as his cap in the usage figures", () => {
  seedFirms([]);
  patchSettings({ dayCapPct: 20, hardStopPct: 90 });
  readingOf({ five: 12, seven: 10 });
  const now = Date.now();
  actOn('usage', 'cap', { pct: 30 }, now);
  assert.deepEqual(item(briefData(now), 'usage').figures, { kind: 'usage', window: 'five-hour', nowPct: 12, capPct: 30, mine: true });
  readingOf({ five: 10, seven: 85 });
  patchSettings({ todayCapPct: null, dayCapPct: 50 });
  assert.deepEqual(item(briefData(now), 'usage').figures, { kind: 'usage', window: 'seven-day', nowPct: 85, capPct: 90, mine: false });
});

test('the tour carries its real stops and seconds', () => {
  seedFirms([]);
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (((8 - d.getDay()) % 7) || 7), 8).getTime();
  const stop = (kind: TourStop['kind']): TourStop => ({ kind, towerId: null, repo: null, floorId: null, agentId: null, firmId: null, title: kind, caption: kind, at: new Date(monday - DAY).toISOString(), dwell: 6, glide: 4 });
  const tour: Tour = { week: '2026-11-09', from: '', to: new Date(monday - HOUR).toISOString(), stops: [stop('exchange'), stop('merged'), stop('scar'), stop('exchange')], seconds: 31.6 };
  const it = item(briefData(monday, { tour: () => tour, milestones: () => [] }), 'tour:2026-11-09');
  assert.equal(it.text, 'A walk through last week, 2 stops in about 32 seconds. Escape ends it.');
  assert.deepEqual(it.figures, { kind: 'tour', stops: 2, seconds: 32 });
});

/** One of his decisions on `repo`, straight into the table, with the master agreeing or not. */
function decisionRow(kind: WorkKind, repo: string, i: number, agreed: boolean | null, at: number): void {
  const d: Decision = { key: `${kind}#${repo}#${i}`, kind, repo, jobId: `job-${repo.replace('/', '-')}-${i}`, approved: true, by: 'accept', predictionId: agreed === null ? null : i, agreed, at: new Date(at).toISOString() };
  openDb().prepare('INSERT INTO decisions (key, at, kind, repo, json) VALUES (?, ?, ?, ?, ?)').run(d.key, d.at, kind, repo, JSON.stringify(d));
}

/** An open ask on (kind, repo), as askDue writes it, with the pooled rate it was asked on. */
function askRow(kind: WorkKind, repo: string, rate: { value: number; n: number }, at: number): void {
  const g: Grant = { kind, repo, state: 'asked', at: new Date(at).toISOString(), by: 'school', rate: { ...rate, lo: rate.value - 0.05, hi: Math.min(1, rate.value + 0.05) }, reason: null, acted: 0, quietUntil: null };
  openDb().prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)').run(g.kind, g.repo, g.state, g.at, JSON.stringify(g));
}

test("the autonomy ask's figures count this repo's own last decisions, not a constant", () => {
  seedFirms([]);
  addRepo(FULL);
  addRepo('acme/few');
  addRepo('acme/none');
  const kind: WorkKind = 'propose:readme-gap';
  const now = Date.now();
  let t = now - 100 * HOUR;
  // On FULL, twelve decisions: the oldest against (outside the last ten), one against within them, and one with no prediction (never counted).
  for (let i = 0; i < 12; i++) decisionRow(kind, FULL, i, i !== 0 && i !== 5, (t += HOUR));
  decisionRow(kind, FULL, 99, null, (t += HOUR));
  // On acme/few, four: three agreed. On acme/none, none.
  for (let i = 0; i < 4; i++) decisionRow(kind, 'acme/few', i, i !== 2, (t += HOUR));
  askRow(kind, FULL, { value: 0.96, n: 50 }, now - HOUR);
  askRow(kind, 'acme/few', { value: 0.96, n: 50 }, now - HOUR);
  askRow(kind, 'acme/none', { value: 0.96, n: 50 }, now - HOUR);
  const b = briefData(now);
  const ask = (repo: string) => item(b, `autonomy:${kind}:${repo}`);
  assert.deepEqual(ask(FULL).figures, { kind: 'autonomy', agreed: 48, of: 50, here: 9, hereOf: 10 });
  assert.deepEqual(ask('acme/few').figures, { kind: 'autonomy', agreed: 48, of: 50, here: 3, hereOf: 4 });
  assert.deepEqual(ask('acme/none').figures, { kind: 'autonomy', agreed: 48, of: 50, here: 0, hereOf: 0 });
  // The sentence is as it was, word for word.
  assert.equal(
    ask('acme/few').text,
    `The master has agreed with you on 48 of the last 50 ${kind} decisions, and on its last ${AGREE.repoLast} on acme/few. If you grant it, the city acts there without you when every check holds; each act appears here, and you can revoke it at any time. Declining keeps it quiet for ${AGREE.quietDays} days.`,
  );
});

test('kinds with no numbers carry null figures', () => {
  seedFirms([]);
  addRepo(FULL, { market: false });
  record('run.note', { repo: FULL, note: 'A note' });
  const b = briefData(Date.now());
  for (const it of allItems(b)) assert.equal(it.figures, null, it.id);
  assert.ok(allItems(b).length > 0);
});
