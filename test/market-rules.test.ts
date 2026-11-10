import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  calibrated,
  canHire,
  CREDITS_PER_USD,
  eraForScore,
  expectedValue,
  HIRE_FEE,
  isBankrupt,
  LEGAL_MOVES,
  PUSH_MODE_NEEDS,
  pushModeRefusal,
  legalMove,
  MAX_ATTEMPTS,
  NEW_FIRM_OVERCLAIM,
  overclaimOf,
  reputationScore,
  REVIEWER_SHARE,
  salePrice,
  START_BALANCE,
  TIER_LABELS,
  TIER_VALUE,
  tierFromLabels,
} from '../shared/market-rules.js';

test('constants', () => {
  assert.deepEqual(TIER_VALUE, { low: 20, normal: 60, high: 150 });
  assert.deepEqual(TIER_LABELS(), ['palimpsest', 'palimpsest:low', 'palimpsest:high']);
  assert.deepEqual(TIER_LABELS('city'), ['city', 'city:low', 'city:high']);
  assert.equal(NEW_FIRM_OVERCLAIM, 0.15);
  assert.equal(START_BALANCE, 300);
  assert.equal(HIRE_FEE, 80);
  assert.equal(REVIEWER_SHARE, 0.05);
  assert.equal(MAX_ATTEMPTS, 2);
  assert.equal(CREDITS_PER_USD, 20);
});

test('tier from labels', () => {
  assert.equal(tierFromLabels(['palimpsest', 'palimpsest:high']), 'high');
  assert.equal(tierFromLabels(['bug']), null);
  assert.equal(tierFromLabels([]), null);
  assert.equal(tierFromLabels(['palimpsest']), 'normal');
  assert.equal(tierFromLabels(['palimpsest:low']), 'low');
  assert.equal(tierFromLabels(['palimpsest:low', 'palimpsest']), 'normal');
  assert.equal(tierFromLabels(['city:high'], 'city'), 'high');
  assert.equal(tierFromLabels(['palimpsest:high'], 'city'), null);
});

test('calibrated discounts overclaim', () => {
  assert.equal(calibrated(0.9, 0.2), 0.72);
  assert.equal(calibrated(0.5, 0), 0.5);
});

test('expected value', () => {
  assert.equal(expectedValue(0.72, 60, 30), 13.2);
  assert.ok(expectedValue(0.2, 60, 30) < 0);
});

test('overclaim of a perfect firm is 0 and of a boaster is positive', () => {
  assert.equal(overclaimOf([]), NEW_FIRM_OVERCLAIM);
  assert.equal(
    overclaimOf([
      { confidence: 1, passed: true },
      { confidence: 0, passed: false },
    ]),
    0,
  );
  // an under-promiser is clamped at 0, never rewarded with a negative overclaim
  assert.equal(overclaimOf([{ confidence: 0.2, passed: true }]), 0);
  const boast = overclaimOf([
    { confidence: 0.9, passed: false },
    { confidence: 0.9, passed: true },
  ]);
  assert.ok(boast > 0);
  assert.equal(boast, 0.4);
});

test('overclaim counts only the last 20 resolved bids', () => {
  const old = Array.from({ length: 30 }, () => ({ confidence: 1, passed: false }));
  const recent = Array.from({ length: 20 }, () => ({ confidence: 1, passed: true }));
  assert.equal(overclaimOf([...old, ...recent]), 0);
});

test('reputation score weighs pass rate, calibration and durability, unknowns at half', () => {
  assert.equal(reputationScore({ passRateAll: null, brier: null, durability: null }), 0.5);
  assert.equal(reputationScore({ passRateAll: 1, brier: 0, durability: 1 }), 1);
  assert.equal(reputationScore({ passRateAll: 0.8, brier: 0.1, durability: 1 }), 0.87);
});

test('era ranges are half-open', () => {
  assert.equal(eraForScore(0, 'scifi'), 'stone');
  assert.equal(eraForScore(0.3499, 'scifi'), 'stone');
  assert.equal(eraForScore(0.35, 'scifi'), 'brick');
  assert.equal(eraForScore(0.5, 'scifi'), 'glass');
  assert.equal(eraForScore(0.65, 'scifi'), 'titanium');
  assert.equal(eraForScore(0.7999, 'scifi'), 'titanium');
  assert.equal(eraForScore(0.8, 'scifi'), 'scifi');
  assert.equal(eraForScore(1, 'scifi'), 'scifi');
});

test('era caps at capability', () => {
  assert.equal(eraForScore(0.95, 'glass'), 'glass');
  assert.equal(eraForScore(0.4, 'glass'), 'brick');
  assert.equal(eraForScore(0.9, 'titanium'), 'titanium');
});

test('bankrupt after 72 hours negative', () => {
  const since = '2026-11-01T00:00:00.000Z';
  const t0 = Date.parse(since);
  assert.equal(isBankrupt(null, t0 + 1e10), false);
  assert.equal(isBankrupt(since, t0 + 71 * 3600_000), false);
  assert.equal(isBankrupt(since, t0 + 72 * 3600_000), true);
  assert.equal(isBankrupt(since, new Date(t0 + 80 * 3600_000)), true);
});

test('sale price', () => {
  assert.equal(salePrice(10), 40);
  assert.equal(salePrice(0), 20);
});

test('canHire needs an active firm, balance over 400, more open jobs than idle agents, fewer than four towers', () => {
  assert.equal(canHire(401, 3, 1, 2, 'active'), true);
  assert.equal(canHire(400, 3, 1, 2, 'active'), false);
  assert.equal(canHire(500, 2, 2, 2, 'active'), false);
  assert.equal(canHire(500, 3, 2, 4, 'active'), false);
  assert.equal(canHire(500, 3, 2, 3, 'active'), true);
  assert.equal(canHire(900, 9, 0, 0, 'bankrupt'), false, 'only an active firm hires');
});

test('legal moves include bidding to open, awarded to failed, running to open and failed, inspecting to failed, halted to open and to waiting, proposed to open', () => {
  assert.ok(legalMove('bidding', 'open'));
  assert.ok(legalMove('awarded', 'failed'));
  assert.ok(legalMove('running', 'open'));
  assert.ok(legalMove('running', 'failed'));
  assert.ok(legalMove('inspecting', 'failed'));
  assert.ok(legalMove('halted', 'open'));
  assert.ok(legalMove('halted', 'waiting'));
  assert.ok(legalMove('proposed', 'open'));
  assert.equal(legalMove('proposed', 'bidding'), false);
  assert.equal(legalMove('open', 'merged'), false);
  assert.equal(legalMove('waiting', 'open'), false, 'a waiting PR never goes back to the board');
});

test('merged is terminal', () => {
  assert.deepEqual(LEGAL_MOVES.merged, []);
  assert.deepEqual(LEGAL_MOVES.closed, []);
  assert.deepEqual(LEGAL_MOVES.withdrawn, []);
  for (const to of Object.keys(LEGAL_MOVES) as Array<keyof typeof LEGAL_MOVES>) {
    assert.equal(legalMove('merged', to), false);
  }
});

test('push mode needs a test and a build command, and says so', () => {
  assert.equal(pushModeRefusal({ test: 'npm test', build: 'vite build' }), null);
  assert.equal(pushModeRefusal({ test: 'npm test', build: null }), PUSH_MODE_NEEDS);
  assert.equal(pushModeRefusal({ test: null, build: 'vite build' }), PUSH_MODE_NEEDS);
  assert.equal(pushModeRefusal(null), PUSH_MODE_NEEDS);
});
