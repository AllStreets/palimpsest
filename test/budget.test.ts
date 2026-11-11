import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { paths } from '../engine/home.js';
import {
  acquire,
  charge,
  JUDGE_ESTIMATE,
  lastSseAt,
  noteSseClients,
  onHardStop,
  PLAN_ESTIMATE,
  registerKeepAwake,
  resetBudget,
  REVIEW_ESTIMATE,
  sseClientCount,
  treasury,
  unattended,
} from '../engine/market/budget.js';
import type { Lease } from '../engine/market/budget.js';
import { localDay } from '../engine/market/report.js';
import { patchSettings } from '../engine/settings.js';
import { openDb } from '../engine/db.js';
import type { ModelRef } from '../shared/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time: daytime, so only the SSE count decides whether the city is attended. */
const NOW = new Date(2026, 10, 9, 14, 0, 0).getTime();

let tempDir: string;
let previousHome: string | undefined;
let previousProjects: string | undefined;
let previousFlag: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  previousProjects = process.env.PALIMPSEST_CLAUDE_PROJECTS;
  previousFlag = process.env.PALIMPSEST_TEST_PROJECTS;
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-budget-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetBudget();
  noteSseClients(1, NOW - MIN);
});

afterEach(() => {
  resetBudget();
  if (previousFlag === undefined) delete process.env.PALIMPSEST_TEST_PROJECTS;
  else process.env.PALIMPSEST_TEST_PROJECTS = previousFlag;
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  if (previousProjects === undefined) delete process.env.PALIMPSEST_CLAUDE_PROJECTS;
  else process.env.PALIMPSEST_CLAUDE_PROJECTS = previousProjects;
  rmSync(tempDir, { recursive: true, force: true });
});

/** Writes the latest reading as the hook does (seconds). */
function reading(o: { at?: number; five: number; seven?: number; fiveResets?: number; sevenResets?: number }): void {
  const at = o.at ?? NOW;
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(at / 1000),
      rate_limits: {
        five_hour: { used_percentage: o.five, resets_at: o.fiveResets ?? Math.floor((NOW + HOUR) / 1000) },
        seven_day: { used_percentage: o.seven ?? 10, resets_at: o.sevenResets ?? Math.floor((NOW + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

function spend(o: { model?: ModelRef; weighted?: number; usd?: number; credits?: number; at: number; unattended?: boolean }): number {
  return charge({
    runId: 'run-x',
    firmId: 'quickset',
    model: o.model ?? 'claude:opus',
    kind: 'run',
    usage: { weightedTokens: o.weighted ?? 0, seconds: 0, usd: o.usd ?? 0, credits: o.credits ?? 0 },
    unattended: o.unattended ?? false,
    at: o.at,
  });
}

async function lease(model: ModelRef, kind: 'plan' | 'work', now = NOW, waitUntil?: number): Promise<Lease> {
  const r = await acquire(model, kind, PLAN_ESTIMATE, { now, waitUntil });
  if (!r.ok) throw new Error(`expected a lease, got ${JSON.stringify(r.reason)}`);
  return r.lease;
}

function near(a: number, b: number): void {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
}

test('estimate grows with staleness margin', () => {
  reading({ five: 10, seven: 20, fiveResets: Math.floor((NOW + 4 * HOUR) / 1000) });
  // 60,000 weighted tokens is one percent at the assumed rate, and 10 credits.
  assert.equal(spend({ weighted: 60_000, at: NOW + MIN }), 10);

  const t1 = treasury(NOW + HOUR);
  near(t1.fiveHour.estimatedPct, 10 + 1 * 1.1);
  assert.equal(t1.fiveHour.usedPct, 10);
  near(t1.fiveHour.cityPct, 1);
  const t3 = treasury(NOW + 3 * HOUR);
  near(t3.fiveHour.estimatedPct, 10 + 1 * 1.3);
  // Once the window resets, his used share starts again from zero; the city's spend since the reset still counts.
  const t5 = treasury(NOW + 4 * HOUR + MIN);
  assert.equal(t5.fiveHour.usedPct, 0);
  near(t5.fiveHour.estimatedPct, 0);
  assert.ok(t3.sevenDay.estimatedPct > t1.sevenDay.estimatedPct);
  assert.ok(t3.sevenDay.estimatedPct > 20);
  assert.equal(t3.tokensPerPct, 60_000);
  assert.equal(t3.calibrated, false);
});

test('paused stale after five hours and resumes with resumeStaleUntil', async () => {
  reading({ five: 10, fiveResets: Math.floor((NOW + 10 * HOUR) / 1000) });
  const later = NOW + 5 * HOUR + MIN;
  assert.equal(treasury(NOW + HOUR).paused, null);
  assert.equal(treasury(later).paused?.reason, 'stale');

  const refused = await acquire('claude:sonnet', 'plan', PLAN_ESTIMATE, { now: later });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal((refused.reason as { reason: string }).reason, 'stale');
  // Local models ignore staleness.
  const local = await acquire('ollama:qwen3:30b', 'work', 10, { now: later });
  assert.equal(local.ok, true);

  patchSettings({ resumeStaleUntil: later + HOUR });
  assert.equal(treasury(later).paused, null);
  const ok = await acquire('claude:sonnet', 'plan', PLAN_ESTIMATE, { now: later });
  assert.equal(ok.ok, true);
});

test('no reading at all counts as stale', () => {
  assert.equal(treasury(NOW).paused?.reason, 'stale');
  assert.equal(treasury(NOW).fiveHour.usedPct, null);
});

test('cap blocks a plan call that would cross the day cap but allows a local one', async () => {
  reading({ five: 20 });
  // 499 credits (49.9% of the window) spent by the city in this window, before the reading.
  spend({ weighted: 2_994_000, at: NOW - HOUR });
  const t = treasury(NOW);
  near(t.fiveHour.cityPct, 49.9);
  assert.equal(t.fiveHour.capPct, 50);
  assert.equal(t.paused?.reason, 'cap');

  const claude = await acquire('claude:sonnet', 'plan', PLAN_ESTIMATE, { now: NOW });
  assert.equal(claude.ok, false);
  if (!claude.ok) assert.equal((claude.reason as { reason: string }).reason, 'cap');
  const local = await acquire('ollama:qwen3:30b', 'plan', PLAN_ESTIMATE, { now: NOW });
  assert.equal(local.ok, true);
  // A call that still fits passes: 49.9 + 0.1 = 50.
  const small = await acquire('claude:haiku', 'plan', 1, { now: NOW });
  assert.equal(small.ok, true);
});

test('a third concurrent claude run is busy', async () => {
  reading({ five: 10 });
  await lease('claude:opus', 'work');
  await lease('claude:sonnet', 'work');
  const third = await acquire('claude:opus', 'work', 30, { now: NOW });
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal((third.reason as { reason: string }).reason, 'busy');
  // The local pool is separate.
  await lease('ollama:qwen3:30b', 'work');
  const t = treasury(NOW);
  assert.equal(t.concurrency.claude, 2);
  assert.equal(t.concurrency.local, 1);
  assert.equal(t.concurrency.claudeMax, 2);
  assert.equal(t.concurrency.localMax, 1);
});

test('a plan call waits for a plan slot while two claude runs hold the run slots and gets one before the window closes', async () => {
  reading({ five: 10 });
  await lease('claude:opus', 'work');
  await lease('claude:opus', 'work');
  // Plan calls have their own pool of two Claude slots.
  const p1 = await lease('claude:sonnet', 'plan');
  await lease('claude:sonnet', 'plan');

  let settled = false;
  const waiting = acquire('claude:haiku', 'plan', PLAN_ESTIMATE, { now: NOW, waitUntil: NOW + 2000 }).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);

  p1.release();
  const got = await waiting;
  assert.equal(got.ok, true);
});

test('a plan call still queued when the window closes returns busy', async () => {
  reading({ five: 10 });
  await lease('claude:sonnet', 'plan');
  await lease('claude:sonnet', 'plan');
  const started = Date.now();
  const r = await acquire('claude:haiku', 'plan', PLAN_ESTIMATE, { now: NOW, waitUntil: NOW + 50 });
  assert.ok(Date.now() - started >= 40);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const reason = r.reason as { reason: string; detail: string };
    assert.equal(reason.reason, 'busy');
    assert.match(reason.detail, /window closed/);
  }
});

test('a review sub-lease shares its run\'s slot', async () => {
  reading({ five: 10 });
  const run = await lease('claude:opus', 'work');
  await lease('claude:opus', 'work');

  const review = run.sub('review', 'claude:sonnet', REVIEW_ESTIMATE);
  assert.ok(!('ok' in review), 'the review gets a sub-lease even with every run slot taken');
  const judge = run.sub('judge', 'claude:sonnet', JUDGE_ESTIMATE);
  assert.ok(!('ok' in judge));
  assert.equal(treasury(NOW).concurrency.claude, 2);

  // A reviewer in another pool counts there too.
  const localReview = run.sub('review', 'ollama:qwen3:30b', REVIEW_ESTIMATE);
  assert.ok(!('ok' in localReview));
  assert.equal(treasury(NOW).concurrency.local, 1);
  // That pool is now full, so another local run is busy.
  const busy = await acquire('ollama:qwen3:30b', 'work', 10, { now: NOW });
  assert.equal(busy.ok, false);

  // Releasing the run releases its sub-leases.
  run.release();
  const t = treasury(NOW);
  assert.equal(t.concurrency.claude, 1);
  assert.equal(t.concurrency.local, 0);
  assert.equal((review as Lease).signal.aborted, false);
});

test('entering hard aborts a plan call in flight', async () => {
  reading({ five: 50 });
  const plan = await lease('claude:sonnet', 'plan');
  const local = await lease('ollama:qwen3:30b', 'work');
  let fired = 0;
  onHardStop(() => {
    fired += 1;
    assert.equal(plan.signal.aborted, true, 'leases abort before the listeners run');
  });

  assert.equal(treasury(NOW).paused, null);
  reading({ five: 92 });
  assert.equal(treasury(NOW).paused?.reason, 'hard');
  assert.equal(plan.signal.aborted, true);
  assert.equal(local.signal.aborted, false);
  assert.equal(fired, 1);
  treasury(NOW);
  assert.equal(fired, 1, 'fires once on entering, not on every read');
});

test('keep-awake reads the stub until registered', () => {
  reading({ five: 10 });
  assert.deepEqual(treasury(NOW).keepAwake, { on: false, held: false });
  patchSettings({ keepAwake: true });
  assert.deepEqual(treasury(NOW).keepAwake, { on: true, held: false });
  registerKeepAwake(() => ({ on: true, held: true }));
  assert.deepEqual(treasury(NOW).keepAwake, { on: true, held: true });
});

test('hard stop at 90 blocks everything but anthropic and fires onHardStop', async () => {
  patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
  reading({ five: 40, seven: 90 });
  let fired = 0;
  onHardStop(() => {
    fired += 1;
  });
  const t = treasury(NOW);
  assert.equal(t.paused?.reason, 'hard');
  assert.equal(fired, 1);

  for (const model of ['claude:opus', 'ollama:qwen3:30b'] as ModelRef[]) {
    const r = await acquire(model, 'work', 10, { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal((r.reason as { reason: string }).reason, 'hard');
  }
  const api = await acquire('anthropic:claude-sonnet-4-5', 'work', 10, { now: NOW });
  assert.equal(api.ok, true);
  assert.equal(fired, 1);
});

test('interactive activity drops claudeMax to 1', async () => {
  reading({ five: 10 });
  const dir = join(tempDir, 'projects', '-Users-someone-code');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{}\n');

  utimesSync(file, new Date(NOW - 20 * MIN), new Date(NOW - 20 * MIN));
  let t = treasury(NOW);
  assert.equal(t.interactiveActive, false);
  assert.equal(t.concurrency.claudeMax, 2);

  utimesSync(file, new Date(NOW - MIN), new Date(NOW - MIN));
  t = treasury(NOW);
  assert.equal(t.interactiveActive, true);
  assert.equal(t.concurrency.claudeMax, 1);
  await lease('claude:opus', 'work');
  const second = await acquire('claude:opus', 'work', 10, { now: NOW });
  assert.equal(second.ok, false);
});

test('night cap counts only unattended rows', async () => {
  patchSettings({ nightCapPct: 5 });
  reading({ five: 10, seven: 30 });
  // 200 credits unattended this window (20% of a five-hour window, 5 weekly points at the assumed ratio of 0.25).
  spend({ weighted: 1_200_000, at: NOW - HOUR, unattended: true });
  // 1,000 attended credits two days ago, inside the week.
  spend({ weighted: 6_000_000, at: NOW - 48 * HOUR, unattended: false });

  const attended = treasury(NOW);
  near(attended.night.usedPct, 5);
  assert.equal(attended.night.capPct, 5);
  assert.equal(attended.night.unattended, false);
  assert.equal(attended.paused, null);

  noteSseClients(0, NOW - 31 * MIN);
  assert.equal(unattended(NOW), true);
  const away = treasury(NOW);
  assert.equal(away.night.unattended, true);
  assert.equal(away.paused?.reason, 'night');
  const r = await acquire('claude:opus', 'work', 10, { now: NOW });
  assert.equal(r.ok, false);
  const local = await acquire('ollama:qwen3:30b', 'work', 10, { now: NOW });
  assert.equal(local.ok, true);
});

test('unattended by the SSE count and by the clock', () => {
  noteSseClients(1, NOW - 2 * HOUR);
  assert.equal(unattended(NOW), false, 'a client still connected keeps the city attended');
  noteSseClients(0, NOW - 10 * MIN);
  assert.equal(sseClientCount(), 0);
  assert.equal(lastSseAt(), NOW - 10 * MIN);
  assert.equal(unattended(NOW), false, 'within 30 minutes of the last client');
  assert.equal(unattended(NOW + 25 * MIN), true);
  noteSseClients(1, NOW);
  assert.equal(unattended(new Date(2026, 10, 9, 23, 30).getTime()), true, 'night hours');
  assert.equal(unattended(new Date(2026, 10, 10, 6, 59).getTime()), true);
  assert.equal(unattended(new Date(2026, 10, 10, 7, 0).getTime()), false);
});

test('stop file pauses with reason stopped', async () => {
  patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
  reading({ five: 10 });
  const local = await lease('ollama:qwen3:30b', 'work');
  let fired = 0;
  onHardStop(() => {
    fired += 1;
  });
  writeFileSync(paths().stop, '');
  assert.equal(treasury(NOW).paused?.reason, 'stopped');
  assert.equal(fired, 1);
  assert.equal(local.signal.aborted, true, 'stopped aborts local leases too');
  for (const model of ['claude:opus', 'ollama:qwen3:30b', 'anthropic:claude-haiku-4-5'] as ModelRef[]) {
    const r = await acquire(model, 'plan', PLAN_ESTIMATE, { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal((r.reason as { reason: string }).reason, 'stopped');
  }
});

test('anthropic calls stop at the daily dollar cap', async () => {
  patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
  reading({ five: 10 });
  assert.equal(spend({ model: 'anthropic:claude-sonnet-4-5', usd: 5, at: NOW - MIN }), 100);
  const t = treasury(NOW);
  assert.equal(t.api.spentUsdToday, 5);
  assert.equal(t.api.dailyUsd, 5);
  assert.equal(t.api.enabled, true);
  // Dollars never count against his plan windows.
  near(t.fiveHour.cityPct, 0);

  const r = await acquire('anthropic:claude-sonnet-4-5', 'plan', PLAN_ESTIMATE, { now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal((r.reason as { reason: string }).reason, 'cap');
  const claude = await acquire('claude:sonnet', 'plan', PLAN_ESTIMATE, { now: NOW });
  assert.equal(claude.ok, true);
});

test('charge writes a credits row per call kind and sums city spend', () => {
  reading({ five: 10 });
  spend({ weighted: 60_000, at: NOW - MIN });
  spend({ model: 'ollama:qwen3:30b', credits: 2.5, at: NOW - MIN });
  const t = treasury(NOW);
  near(t.citySpent.today, 12.5);
  near(t.citySpent.week, 12.5);
});

test('two concurrent claude calls that together cross the day cap: the second is refused', async () => {
  reading({ five: 20 });
  // 490 credits: 49% of the window.
  spend({ weighted: 2_940_000, at: NOW - HOUR });
  const first = await acquire('claude:opus', 'work', 6, { now: NOW });
  assert.equal(first.ok, true);
  const second = await acquire('claude:sonnet', 'plan', 6, { now: NOW });
  assert.equal(second.ok, false, 'the first call\'s estimate is reserved');
  if (!second.ok) assert.equal((second.reason as { reason: string }).reason, 'cap');
  // A sub-lease reserves too.
  if (first.ok) {
    const review = first.lease.sub('review', 'claude:sonnet', 6);
    assert.ok('ok' in review && review.ok === false);
  }

  // Charging the call through its lease swaps the reservation for the real spend.
  if (first.ok) {
    charge({
      runId: 'r',
      firmId: 'f',
      model: 'claude:opus',
      kind: 'run',
      usage: { weightedTokens: 6_000, seconds: 1, usd: 0, credits: 0 },
      unattended: false,
      at: NOW,
      lease: first.lease,
    });
  }
  // 49% + 0.1% charged + 0.6% asked = 49.7%.
  const third = await acquire('claude:sonnet', 'plan', 6, { now: NOW });
  assert.equal(third.ok, true);
});

test('two concurrent api calls that together cross the dollar cap: the second is refused', async () => {
  patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
  reading({ five: 10 });
  // 60 credits is $3.
  const first = await acquire('anthropic:claude-sonnet-4-5', 'work', 60, { now: NOW });
  assert.equal(first.ok, true);
  const second = await acquire('anthropic:claude-sonnet-4-5', 'work', 60, { now: NOW });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal((second.reason as { reason: string }).reason, 'cap');
  if (first.ok) first.lease.release();
  const third = await acquire('anthropic:claude-sonnet-4-5', 'work', 60, { now: NOW });
  assert.equal(third.ok, true);
});

test('a reading missing a window counts as stale', () => {
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({ at: Math.floor(NOW / 1000), rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor((NOW + HOUR) / 1000) } } }),
  );
  assert.equal(treasury(NOW).paused?.reason, 'stale');
  writeFileSync(join(paths().usage, 'latest.json'), JSON.stringify({ at: Math.floor(NOW / 1000) }));
  assert.equal(treasury(NOW).paused?.reason, 'stale');
});

test('a resumed stale reading still counts his own transcript use toward the hard stop', () => {
  // His last reading is six hours old; its five-hour window reset two hours ago.
  reading({ at: NOW - 6 * HOUR, five: 80, fiveResets: Math.floor((NOW - 2 * HOUR) / 1000) });
  patchSettings({ resumeStaleUntil: NOW + HOUR });
  assert.equal(treasury(NOW).paused, null);

  // Since the reset he has used about 90% of a window on his own.
  const dir = join(tempDir, 'projects', '-Users-someone-code');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - HOUR).toISOString(),
      requestId: 'r',
      message: { id: 'm', model: 'claude-opus-4-1', usage: { input_tokens: 5_400_000, output_tokens: 0 } },
    })}\n`,
  );
  const t = treasury(NOW);
  assert.ok(t.fiveHour.estimatedPct >= 90, `estimated ${t.fiveHour.estimatedPct}`);
  assert.equal(t.paused?.reason, 'hard');
});

test('a resume lasts at most five hours past a stale reading', () => {
  reading({ at: NOW - 11 * HOUR, five: 10, fiveResets: Math.floor((NOW - 7 * HOUR) / 1000) });
  patchSettings({ resumeStaleUntil: NOW + HOUR });
  assert.equal(treasury(NOW).paused?.reason, 'stale');
  reading({ at: NOW - 9 * HOUR, five: 10, fiveResets: Math.floor((NOW - 5 * HOUR) / 1000) });
  assert.equal(treasury(NOW).paused, null);
});

// ---------------------------------------------------------------- Phase 3: the audit's spend and today's cap

/** Pin: `credits.kind` has no CHECK, so the row was always accepted at runtime; the pin holds the type open to 'audit' with a null firm. */
test('charge accepts kind audit with a null firm', () => {
  reading({ five: 10 });
  const credits = charge({
    runId: 'audit-1',
    firmId: null,
    model: 'claude:sonnet',
    kind: 'audit',
    usage: { weightedTokens: 60_000, seconds: 0, usd: 0, credits: 0 },
    unattended: false,
    at: NOW - MIN,
  });
  assert.equal(credits, 10);
  const row = openDb().prepare('SELECT firm_id, run_id, kind, amount FROM credits ORDER BY id DESC LIMIT 1').get() as { firm_id: string | null; run_id: string; kind: string; amount: number };
  assert.deepEqual({ ...row }, { firm_id: null, run_id: 'audit-1', kind: 'audit', amount: 10 });
});

test('an audit charge counts in the five-hour window, the night cap and citySpent', () => {
  reading({ five: 10, seven: 30 });
  const before = treasury(NOW);
  charge({
    runId: 'audit-1',
    firmId: null,
    model: 'claude:sonnet',
    kind: 'audit',
    usage: { weightedTokens: 60_000, seconds: 0, usd: 0, credits: 0 },
    unattended: true,
    at: NOW - MIN,
  });
  const after = treasury(NOW);
  near(after.fiveHour.cityPct - before.fiveHour.cityPct, 1);
  // One window point is a quarter of a weekly point at the assumed ratio.
  near(after.night.usedPct - before.night.usedPct, 0.25);
  near(after.citySpent.today - before.citySpent.today, 10);
  near(after.citySpent.week - before.citySpent.week, 10);
});

test("the treasury honours today's cap", async () => {
  reading({ five: 10 });
  const today = localDay(NOW);
  patchSettings({ dayCapPct: 50, hardStopPct: 90, todayCapPct: { day: today, pct: 20 } });
  // 19.8% of the window spent by the city: well under the 50% day cap, but a 3-credit plan call would cross today's 20%.
  spend({ weighted: 1_188_000, at: NOW - MIN });
  const t = treasury(NOW);
  assert.equal(t.fiveHour.capPct, 20);
  assert.equal(t.paused?.reason, 'cap');
  assert.match(t.paused?.detail ?? '', /the cap is 20%/);
  const refused = await acquire('claude:sonnet', 'work', 10, { now: NOW });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal((refused.reason as { reason: string }).reason, 'cap');

  // Raised above the day cap, for today only.
  patchSettings({ dayCapPct: 15, todayCapPct: { day: today, pct: 70 } });
  const raised = treasury(NOW);
  assert.equal(raised.fiveHour.capPct, 70);
  assert.equal(raised.paused, null);
  const ok = await acquire('claude:sonnet', 'work', 10, { now: NOW });
  assert.equal(ok.ok, true);
  if (ok.ok) ok.lease.release();

  // Yesterday's limit has expired: the day cap stands again.
  patchSettings({ todayCapPct: { day: '2026-11-08', pct: 70 } });
  const expired = treasury(NOW);
  assert.equal(expired.fiveHour.capPct, 15);
  assert.equal(expired.paused?.reason, 'cap');
  assert.match(expired.paused?.detail ?? '', /the cap is 15%/);
});
