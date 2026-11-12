/**
 * The daily report (Task 18): prose and tables he reads, written to
 * `paths().reports/<day>.md` from the ledger and the credits rows. Temp
 * home only; no model, no gh.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { saveAudit } from '../engine/audit/store.js';
import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { entries, record } from '../engine/ledger.js';
import { charge } from '../engine/market/budget.js';
import { hire, seedFirms } from '../engine/market/firms.js';
import { postManualJob, postProposal, proposeHarnessJob, transition } from '../engine/market/jobs.js';
import { backfillReports, ensureDailyReport, latestReport, latestReportDay, writeDailyReport } from '../engine/market/report.js';
import { createScheduler, haltRepo } from '../engine/market/runs.js';
import { installTreasury } from '../engine/market/treasury.js';
import { patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Bid, Job, Repo, Run } from '../shared/types.js';
import { checks, FULL, setUp, tearDown } from './guild-fixtures.js';

let off: () => void = () => {};
beforeEach(() => {
  setUp('report');
  off = installTreasury();
});
afterEach(async () => {
  off();
  await tearDown();
});

function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addRepo(full: string): Repo {
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

test('the daily report lists the day\'s merges and spend and says what waits on him, including a proposed harness job', () => {
  seedFirms([]);
  const repo = addRepo(FULL);
  addRepo('acme/gears');

  // A job merged today, won by Quickset.
  let merged = postManualJob({ repo: FULL, title: 'Fix the header', body: 'Change `src/header.ts`.', tier: 'normal' });
  merged = transition(merged, 'bidding');
  const bid = bidOn(merged, 'quickset', 'ola-bergstrom', 24);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'] as const) merged = transition(merged, to, to === 'awarded' ? { awardedBid: bid.id } : {});
  record('merge.detected', { jobId: merged.id, runId: 'run-x', repo: FULL, pr: 9, prUrl: `https://github.com/${FULL}/pull/9`, mergeSha: 'c'.repeat(40), size: 'small', withHisChanges: false, at: new Date().toISOString() });

  // A job that failed, and why.
  let failed = postManualJob({ repo: FULL, title: 'Rename the gears', body: 'Rename.', tier: 'low' });
  failed = transition(transition(transition(transition(failed, 'bidding'), 'awarded'), 'running'), 'inspecting');
  record('run.ended', { runId: 'run-f', jobId: failed.id, outcome: 'failed', reason: 'The change failed inspection.', summary: null, run: { id: 'run-f', jobId: failed.id } });
  transition(failed, 'failed');

  // A job waiting on its PR.
  let open = postManualJob({ repo: 'acme/gears', title: 'Tidy the gear table', body: 'Tidy.', tier: 'normal' });
  open = transition(open, 'bidding');
  bidOn(open, 'ashlar-vane', 'ines-ashlar', 30);
  for (const to of ['awarded', 'running', 'inspecting', 'shipping', 'waiting'] as const) open = transition(open, to);
  waitingRun(open, 'ines-ashlar', 'ashlar-vane', 41);

  // Spend: model calls by firm and model, an API call in dollars.
  charge({ runId: null, firmId: 'quickset', model: 'claude:sonnet', kind: 'bid', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 3 });
  charge({ runId: 'run-x', firmId: 'quickset', model: 'claude:sonnet', kind: 'run', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 18.5 });
  charge({ runId: 'run-y', firmId: 'ashlar-vane', model: 'anthropic:claude-haiku-4-5', kind: 'run', usage: { weightedTokens: 0, seconds: 0, usd: 0.42, credits: 8.4 }, unattended: false });
  hire('kiln');

  // His brief: a proposed harness job, a halt, and the notes the city wrote for him.
  const harness = proposeHarnessJob(repo);
  haltRepo('acme/gears', 'A city merge was reverted: Tidy the gear table');
  record('run.note', { runId: 'run-n', jobId: merged.id, repo: FULL, note: 'merged with his changes: 1 commit of his on top of bbbbbbb', at: new Date().toISOString() });
  record('run.note', { runId: 'run-m', jobId: 'job-m', repo: FULL, note: 'merged after Kiln Brothers went bankrupt: nobody was paid 40 credits (the firm is dissolved)', unpaid: 40, at: new Date().toISOString() });
  record('run.note', { runId: 'run-r', jobId: 'job-r', repo: FULL, note: 'needs a reviewer: the third inspection in a row could not reach a verdict', inconclusive: 3, at: new Date().toISOString() });
  record('run.note', { runId: 'run-l', note: 'login refresh host refused: auth.example.com' });
  record('run.note', { runId: 'run-p', jobId: 'job-p', repo: FULL, note: `merge ${'d'.repeat(40)} recorded for push mode`, mergeSha: 'd'.repeat(40), at: new Date().toISOString() });

  const day = localDay();
  const md = writeDailyReport(day);
  const file = join(paths().reports, `${day}.md`);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), md);

  // The day's work.
  assert.match(md, /Fix the header/);
  assert.match(md, /merged/i);
  assert.match(md, /Rename the gears/);
  assert.match(md, /failed inspection/i, 'a failure says why');
  // The spend, by firm and by model, against the caps.
  assert.match(md, /Quickset/);
  assert.match(md, /21\.5/, "Quickset's model spend today");
  assert.match(md, /claude:sonnet/);
  assert.match(md, /cap/i);
  assert.match(md, /\$0\.42/, 'API dollars');
  assert.match(md, /assumed|measured/, 'the calibration');
  assert.match(md, /hired/i);
  // What waits on him.
  assert.ok(md.includes('## Waiting on you'), md);
  const waits = md.slice(md.indexOf('## Waiting on you'), md.indexOf('## Jobs'));
  assert.match(waits, new RegExp(harness.title));
  assert.match(waits, /#41/);
  assert.match(waits, /acme\/gears is halted/);
  assert.match(waits, /\*\*A login refresh was refused\.\*\*/, 'each note has a title line');
  assert.match(waits, /login refresh host refused/);
  // Notes that ask nothing of him, or whose question is answered, are only in the day's history.
  assert.doesNotMatch(waits, /merged with his changes|nobody was paid 40 credits|needs a reviewer/);
  const history = md.slice(md.indexOf('## Notes'));
  assert.ok(md.includes('## Notes'), md);
  assert.match(history, /\*\*Merged with your changes\.\*\* acme\/widgets, "Fix the header"\./);
  assert.match(history, /merged with his changes: 1 commit/);
  assert.match(history, /\*\*Merged after its firm went bankrupt, so nobody was paid\.\*\*/);
  assert.match(history, /nobody was paid 40 credits/);
  assert.match(history, /\*\*Needs a reviewer\.\*\*/);
  assert.doesNotMatch(md, /recorded for push mode/, 'bookkeeping notes are not his');
  // Plain and in his style.
  assert.doesNotMatch(md, /\u2014|\u2013|--/);
  assert.doesNotMatch(md, /\p{Extended_Pictographic}/u);

  const written = entries().filter((e) => e.kind === 'report.written');
  assert.equal(written.length, 1);
  assert.equal((written[0].data as { day: string }).day, day);

  const latest = latestReport();
  assert.ok(latest);
  assert.equal(latest.day, day);
  assert.equal(latest.markdown, md);
  assert.equal(latest.data.jobs.merged.length, 1);
  assert.equal(latest.data.waiting.proposed[0].id, harness.id);
});

test('a quiet day says so plainly and latestReport is null before any report', () => {
  assert.equal(latestReport(), null);
  const md = writeDailyReport('2026-11-01');
  assert.match(md, /Nothing waits on you\./);
  assert.match(md, /No jobs were posted/);
  assert.doesNotMatch(md, /\u2014|--/);
});

test('a note drops out of what waits on him once answered, and stays in that day\'s history', () => {
  seedFirms([]);
  addRepo(FULL);
  let j = postManualJob({ repo: FULL, title: 'Fix the footer', body: 'Change it.', tier: 'normal' });
  for (const to of ['bidding', 'awarded', 'running', 'inspecting'] as const) j = transition(j, to);
  j = transition(j, 'halted', { haltNote: 'needs a reviewer: the third inspection in a row could not reach a verdict' });
  record('run.note', { runId: 'run-q', jobId: j.id, repo: FULL, note: 'needs a reviewer: the third inspection in a row could not reach a verdict', inconclusive: 3, at: new Date().toISOString() });
  record('run.note', { runId: 'run-w', jobId: j.id, repo: FULL, note: 'merged with changes: the PR head was 1234567, not the inspected 89abcde', at: new Date().toISOString() });
  record('run.note', { runId: 'run-l', note: 'login refresh host refused: auth.example.com' });

  const before = writeDailyReport(localDay());
  const waitsBefore = before.slice(before.indexOf('## Waiting on you'), before.indexOf('## Jobs'));
  assert.match(waitsBefore, /"Fix the footer" on acme\/widgets is halted/);
  assert.match(waitsBefore, /Merged with changes the city did not make/);
  assert.match(waitsBefore, /A login refresh was refused/);

  // He resumes the job, and a later Claude run gets past its login.
  transition(j, 'open', { haltNote: null });
  record('run.ended', { runId: 'run-ok', jobId: 'job-z', outcome: 'merged', reason: null, summary: null, run: { id: 'run-ok', jobId: 'job-z', model: 'claude:sonnet' } });
  const after = writeDailyReport(localDay());
  const waitsAfter = after.slice(after.indexOf('## Waiting on you'), after.indexOf('## Jobs'));
  assert.doesNotMatch(waitsAfter, /is halted|login refresh|Needs a reviewer/);
  assert.match(waitsAfter, /Merged with changes the city did not make/, 'a note with no answer on record stays');
  const history = after.slice(after.indexOf('## Notes'));
  assert.match(history, /\*\*Needs a reviewer\.\*\*[^\n]*\n[^\n]*Answered since\./);
  assert.match(history, /\*\*A login refresh was refused\.\*\*[^\n]*\n[^\n]*Answered since\./);
});

test('outside text is redacted and plain: tokens, home paths, long dashes, double hyphens and emojis', () => {
  seedFirms([]);
  addRepo(FULL);
  const token = `ghp_${'A1b2C3d4'.repeat(4)}`;
  const hostile = `Fix it \u2014 now -- with \u{1F680}\u{1F44D}\u{1F3FD} ${token} from /Users/someone/secret/notes.txt`;
  let j = postManualJob({ repo: FULL, title: hostile, body: 'x', tier: 'normal' });
  for (const to of ['bidding', 'awarded', 'running', 'inspecting'] as const) j = transition(j, to);
  record('run.ended', { runId: 'run-h', jobId: j.id, outcome: 'failed', reason: `The run crashed \u2013 see /Users/someone/.ssh/id_rsa -- key sk-ant-${'x'.repeat(30)} \u{1F525}`, summary: null, run: { id: 'run-h', jobId: j.id } });
  j = transition(j, 'failed');
  haltRepo(FULL, `Halted \u2014 ${token} \u{1F6D1}`);
  record('run.note', { runId: 'run-h', jobId: j.id, repo: FULL, note: `merged with changes -- ${token} at /Users/someone/x \u{1F600}`, at: new Date().toISOString() });

  const md = writeDailyReport(localDay());
  const stored = JSON.stringify(entries().filter((e) => e.kind === 'report.written').at(-1)?.data);
  for (const [what, text] of [['the page', md], ['the ledger', stored]] as const) {
    assert.ok(!text.includes(token), `${what} holds the token`);
    assert.ok(!text.includes('sk-ant-'), `${what} holds the key`);
    assert.ok(!/\/Users\/someone/.test(text), `${what} holds a home path`);
    assert.doesNotMatch(text, /\u2014|\u2013|--/, `${what} holds a dash`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${what} holds an emoji`);
  }
  assert.match(md, /Fix it, now, with \[redacted\] from \[path\]/);
  assert.match(md, /\[redacted\]/);
});

test('the first Phase 2 start writes no empty reports for the days before the market began', () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
  const put = (ms: number, kind: string, data: object) =>
    openDb().prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)').run(new Date(ms).toISOString(), kind, JSON.stringify(data));
  // Phase 1 days: repos connected and analyzed, the usage hook installed. No market yet.
  put(at(2026, 11, 7, 12), 'repo.connected', { repo: FULL });
  put(at(2026, 11, 8, 12), 'repo.analyzed', { repo: FULL, floors: 3 });
  put(at(2026, 11, 8, 13), 'usage.hook.installed', {});
  const start = at(2026, 11, 10, 0, 10);
  assert.deepEqual(backfillReports(start), [], 'no report for a Phase 1 only day');
  // The market's first entry on day 9: day 9 is reported, the days before it are not.
  put(at(2026, 11, 9, 9), 'firm.seeded', { firmId: 'alpha' });
  assert.deepEqual(backfillReports(start), ['2026-11-09']);
});

test('a day the engine was down across midnight is reported at the next start, and the scheduler picks up from the newest report', async () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
  const put = (ms: number, kind: string, data: object) =>
    openDb().prepare('INSERT INTO ledger (at, kind, json) VALUES (?, ?, ?)').run(new Date(ms).toISOString(), kind, JSON.stringify(data));
  // Day 7 was reported; day 8 the engine ran until 23:50 and stopped; day 9 nothing happened.
  put(at(2026, 11, 7, 12), 'repo.connected', { repo: FULL });
  put(at(2026, 11, 7, 12, 5), 'firm.seeded', { firmId: 'alpha' });
  put(at(2026, 11, 7, 23, 59), 'report.written', { day: '2026-11-07', path: null, data: {} });
  put(at(2026, 11, 8, 23, 50), 'repo.analyzed', { repo: FULL, floors: 3 });
  // The engine starts again on day 10 at 00:10.
  const start = at(2026, 11, 10, 0, 10);
  assert.deepEqual(backfillReports(start), ['2026-11-08']);
  assert.ok(existsSync(join(paths().reports, '2026-11-08.md')));
  assert.deepEqual(backfillReports(start), [], 'a second start writes nothing again');
  assert.equal(latestReportDay(), '2026-11-08');

  // The scheduler seeds its last day from the newest report: its first tick asks for day 8 again, which is already written.
  let clock = start;
  const asked: string[] = [];
  const s = createScheduler({
    now: () => clock,
    lastDay: latestReportDay(),
    installDeps: async () => ({ name: 'install', status: 'skipped', detail: '', durationMs: 0, logPath: null, testsRun: null }),
    inspect: async () => {
      throw new Error('no runs here');
    },
    ship: async () => {
      throw new Error('no runs here');
    },
    pollJobs: async () => [],
    preflight: async () => null,
    watchMs: 0,
    daily: async (day) => {
      asked.push(day);
      ensureDailyReport(day);
    },
  });
  await s.tick();
  // Midnight passes with the engine up: day 10 is reported once.
  clock = at(2026, 11, 11, 0, 5);
  await s.tick();
  await s.stop();
  assert.deepEqual(asked, ['2026-11-08', '2026-11-10']);
  const days = entries().filter((e) => e.kind === 'report.written').map((e) => (e.data as { day: string }).day);
  assert.deepEqual(days, ['2026-11-07', '2026-11-08', '2026-11-10']);
});

test('the balance a report gives each firm is the one every screen reads, charges not yet settled included', async () => {
  const { balances } = await import('../engine/market/treasury.js');
  seedFirms(['qwen2.5-coder:7b'], new Date(Date.now() - 3_600_000));
  // A run cost charged as the model was called and not yet settled into the stored books.
  charge({ runId: 'run-unsettled', firmId: 'quickset', model: 'claude:sonnet', kind: 'run', usage: { weightedTokens: 6000 * 12.5, seconds: 0, usd: 0, credits: 0 }, unattended: false });
  writeDailyReport(localDay());
  const data = latestReport()!.data;
  const row = data.spend.firms.find((f) => f.firmId === 'quickset')!;
  assert.equal(row.balance, Math.round(balances().quickset * 100) / 100);
  assert.notEqual(row.balance, 300, 'not the stored balance the last settle wrote');
});

test("the daily report lists the audit's spend under the city's own calls and names today's cap", () => {
  seedFirms([]);
  addRepo(FULL);
  // An audit the city paid for, and the proposal it made.
  charge({ runId: 'audit-abc123', firmId: null, model: 'claude:sonnet', kind: 'audit', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 4 });
  charge({ runId: 'run-x', firmId: 'quickset', model: 'claude:sonnet', kind: 'run', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 }, unattended: false, minCredits: 6 });
  const claim = 'The CLI exports every report as CSV';
  saveAudit({
    id: 'audit-abc123',
    repo: FULL,
    model: 'claude:sonnet',
    trigger: 'demand',
    baseSha: 'a'.repeat(40),
    status: 'done',
    waitingReason: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    endedReason: null,
    findings: [{ id: 'f1', claim, source: { file: 'README.md', line: 12 }, verdict: 'MISSING', tested: false, evidence: [], unverified: false, proposal: null }],
    counts: { REAL: 0, PARTIAL: 0, MISSING: 1, STUBBED: 0, BROKEN: 0 },
    unverified: 0,
    claimsRead: 1,
    credits: 4,
    unattended: false,
    markdownPath: null,
  });
  postProposal({ repo: FULL, title: 'Add the CSV export', body: 'Add it.', scope: ['src/**'], acceptance: ['CSV export exists'], tier: 'normal', key: `${FULL}#abcdef123456`, source: 'proposal', proposal: { auditId: 'audit-abc123', findingId: 'f1' } });
  // Today's limit, set from the brief.
  const day = localDay();
  patchSettings({ dayCapPct: 20, todayCapPct: { day, pct: 30 } });

  const md = writeDailyReport(day);
  const credits = md.slice(md.indexOf('## Credits'), md.indexOf('## Halts'));
  assert.match(credits, /4 on README audits/, "the audit's spend is its own part of the city's calls");
  assert.match(credits, /Model calls cost 10 credits/);
  assert.match(credits, /Today's limit is 30% of each five-hour window, set by you, in place of the 20% cap/);
  const waits = md.slice(md.indexOf('## Waiting on you'), md.indexOf('## Jobs'));
  assert.match(waits, /Add the CSV export/);
  assert.match(waits, new RegExp(claim), 'a proposal from an audit carries its claim');
  const data = latestReport()!.data;
  assert.equal(data.spend.total.audit, 4);
  assert.equal(data.spend.caps.todayCapPct, 30);
  assert.equal(data.waiting.proposed[0].claim, claim);

  // Without today's limit, the cap line is the plain one.
  patchSettings({ todayCapPct: null });
  const plainMd = writeDailyReport(day);
  assert.doesNotMatch(plainMd, /Today's limit/);
  assert.match(plainMd, /The cap is 20%/);
});
