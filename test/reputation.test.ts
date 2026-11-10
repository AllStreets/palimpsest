import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { record } from '../engine/ledger.js';
import { agent, seedFirms } from '../engine/market/firms.js';
import { eraFor, reputation } from '../engine/market/reputation.js';
import type { Bid } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-reputation-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  seedFirms(['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b', 'qwen3:1.7b']);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function bid(jobId: string, firmId: string, agentId: string, confidence: number): Bid {
  return {
    id: `bid-${jobId}-${firmId}`,
    jobId,
    firmId,
    agentId,
    plan: 'Read the failing test, fix the parser, add a case.',
    price: 20,
    confidence,
    calibrated: confidence,
    appraisal: null,
    ev: 10,
    cost: 1,
    at: '2026-11-10T09:00:00.000Z',
  };
}

test('reputation of a new firm has null rates and era from capability', () => {
  const r = reputation('meridian');
  assert.equal(r.firmId, 'meridian');
  assert.deepEqual(r.passRate, { small: null, medium: null, large: null });
  assert.equal(r.passRateAll, null);
  assert.equal(r.brier, null);
  assert.equal(r.durability, null);
  assert.equal(r.samples, 0);
  assert.equal(r.overclaim, 0.15);
  assert.equal(r.score, 0.5);
  // Every unknown term counts at 0.5, which is glass for an opus firm.
  assert.equal(r.era, 'glass');
  // A 1.7B agent can climb no higher than brick, whatever its firm's score.
  assert.equal(eraFor(agent('juno-pike')!), 'brick');
  assert.equal(eraFor(agent('hal-meridian')!), 'glass');
});

test('reputation after three merges and one scar has passRate 0.75 and a Brier score', () => {
  const firmId = 'ashlar-vane';
  for (const [i, size] of (['small', 'small', 'medium', 'medium'] as const).entries()) {
    const jobId = `job-${i}`;
    record('job.awarded', { jobId, chosen: bid(jobId, firmId, 'ines-ashlar', 0.8), considered: [], satOut: [], why: 'best EV' });
    if (i < 3) {
      record('merge.detected', { jobId, runId: `run-${i}`, size });
    } else {
      record('floor.scarred', { jobId, runId: `run-${i}`, size });
    }
  }
  // Another firm's award and outcome never count for this one.
  record('job.awarded', { jobId: 'job-x', chosen: bid('job-x', 'quickset', 'mack-quickset', 0.9), considered: [], satOut: [], why: '' });
  record('merge.detected', { jobId: 'job-x', runId: 'run-x', size: 'small' });

  const r = reputation(firmId);
  assert.equal(r.samples, 4);
  assert.equal(r.passRateAll, 0.75);
  assert.equal(r.passRate.small, 1);
  assert.equal(r.passRate.medium, 0.5);
  assert.equal(r.passRate.large, null);
  // Brier: three (0.8 - 1)^2 = 0.04 and one (0.8 - 0)^2 = 0.64, mean 0.19.
  assert.ok(r.brier !== null && Math.abs(r.brier - 0.19) < 1e-9);
  assert.equal(r.durability, 1);
  // overclaim: mean of (0.8 - 1) * 3 and 0.8, so 0.05.
  assert.ok(Math.abs(r.overclaim - 0.05) < 1e-9);
  assert.ok(Math.abs(r.score - (0.5 * 0.75 + 0.3 * 0.81 + 0.2 * 1)) < 1e-9);

  record('merge.reverted', { jobId: 'job-0', runId: 'run-0' });
  const later = reputation(firmId);
  assert.ok(later.durability !== null && Math.abs(later.durability - 2 / 3) < 1e-9);
});

test('a job resolves once: a merge after a failed attempt counts for the firm that merged it', () => {
  record('job.awarded', { jobId: 'job-r', chosen: bid('job-r', 'kiln', 'oskar-kiln', 0.6), considered: [], satOut: [], why: '' });
  record('inspection.done', { inspection: { jobId: 'job-r', runId: 'run-a', passed: false } });
  record('floor.scarred', { jobId: 'job-r', runId: 'run-a', size: 'large' });
  record('job.awarded', { jobId: 'job-r', chosen: bid('job-r', 'meridian', 'hal-meridian', 0.9), considered: [], satOut: [], why: '' });
  record('merge.detected', { jobId: 'job-r', runId: 'run-b', size: 'large' });
  assert.equal(reputation('kiln').samples, 1);
  assert.equal(reputation('kiln').passRateAll, 0);
  assert.equal(reputation('meridian').samples, 1);
  assert.equal(reputation('meridian').passRate.large, 1);
});
