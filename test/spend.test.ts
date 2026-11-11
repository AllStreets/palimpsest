/**
 * The spend tables (Task 39, Phase 3 Task 1): the city's model calls by firm
 * and by model, and the entries behind a row. An audit is the city's own
 * call, beside its reviews and design checks.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { paths } from '../engine/home.js';
import { charge, resetBudget } from '../engine/market/budget.js';
import { CITY_KEY, creditEntries, dayStart, spendBetween } from '../engine/market/spend.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
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
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-spend-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetBudget();
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(NOW / 1000),
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: Math.floor((NOW + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
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

const usage = (weightedTokens: number) => ({ weightedTokens, seconds: 0, usd: 0, credits: 0 });

test("the spend tables show an audit charge under the city's own calls", () => {
  // 60,000 weighted tokens is one window point at the assumed rate, and 10 credits.
  charge({ runId: 'audit-1', firmId: null, model: 'claude:sonnet', kind: 'audit', usage: usage(60_000), unattended: false, at: NOW - MIN });
  charge({ runId: 'run-1', firmId: 'quickset', model: 'claude:opus', kind: 'run', usage: usage(120_000), unattended: false, at: NOW - 2 * MIN });

  const p = spendBetween(dayStart(NOW), NOW);
  assert.equal(p.total, 30);
  const city = p.firms.find((f) => f.firmId === null);
  assert.deepEqual(city, { firmId: null, credits: 10, usd: 0, entries: 1 });
  const quickset = p.firms.find((f) => f.firmId === 'quickset');
  assert.deepEqual(quickset, { firmId: 'quickset', credits: 20, usd: 0, entries: 1 });
  const sonnet = p.models.find((m) => m.model === 'claude:sonnet');
  assert.deepEqual(sonnet, { model: 'claude:sonnet', credits: 10, usd: 0, entries: 1, windowPct: 1 });

  const e = creditEntries({ fromMs: dayStart(NOW), toMs: NOW, firm: CITY_KEY });
  assert.equal(e.count, 1);
  assert.equal(e.total, 10);
  assert.equal(e.rows[0].kind, 'audit');
  assert.equal(e.rows[0].runId, 'audit-1');
  assert.equal(e.rows[0].firmId, null);
  assert.equal(e.rows[0].jobId, null);
  assert.equal(e.rows[0].model, 'claude:sonnet');
  // The firm's own row does not carry the audit.
  const q = creditEntries({ fromMs: dayStart(NOW), toMs: NOW, firm: 'quickset' });
  assert.deepEqual(q.rows.map((r) => r.kind), ['run']);
});
