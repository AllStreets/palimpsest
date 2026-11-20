import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apiCredits,
  calibrate,
  claudeCredits,
  CREDIT_PCT,
  DEFAULT_TOKENS_PER_PCT,
  localCredits,
  MODEL_WEIGHT,
  modelFamily,
  pctFor,
  weightedTokens,
} from '../shared/credits.js';

const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

test('weighted tokens weigh output five times', () => {
  const inOnly = weightedTokens({ ...zero, input: 1000 }, 'claude-opus-4');
  const outOnly = weightedTokens({ ...zero, output: 1000 }, 'claude-opus-4');
  assert.equal(inOnly, 1000);
  assert.equal(outOnly, 5000);
  assert.equal(weightedTokens({ ...zero, cacheRead: 1000 }, 'claude-opus-4'), 100);
  assert.equal(weightedTokens({ ...zero, cacheCreation: 1000 }, 'claude-opus-4'), 1250);
});

test('opus weighs five times haiku', () => {
  const u = { input: 1000, output: 200, cacheRead: 5000, cacheCreation: 400 };
  assert.equal(weightedTokens(u, 'claude-opus-4'), 5 * weightedTokens(u, 'claude-haiku-4'));
  assert.equal(MODEL_WEIGHT.sonnet, 0.6);
  assert.equal(modelFamily('claude:sonnet'), 'sonnet');
  assert.equal(modelFamily('claude-fable-5'), 'fable');
});

test('an unknown family counts as opus', () => {
  assert.equal(modelFamily('some-new-model'), 'opus');
  const u = { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 };
  assert.equal(weightedTokens(u, 'some-new-model'), weightedTokens(u, 'claude-opus-4'));
});

test('one credit is a tenth of a percent', () => {
  assert.equal(CREDIT_PCT, 0.1);
  assert.equal(pctFor(10), 1);
  assert.equal(DEFAULT_TOKENS_PER_PCT, 60_000);
  // one percent of the window, measured in weighted tokens, is ten credits
  assert.equal(claudeCredits(60_000, DEFAULT_TOKENS_PER_PCT), 10);
});

test('local credits are cheap', () => {
  assert.ok(localCredits(600, 18) < 2);
  assert.equal(localCredits(1000, 0), 1);
});

test('api credits are twenty per dollar', () => {
  assert.equal(apiCredits(1), 20);
  assert.equal(apiCredits(0.25), 5);
});

test('calibrate blends by 0.3', () => {
  assert.equal(calibrate(60_000, 80_000), 66_000);
});

test('claudeCredits falls back to the default tokens-per-percent when it is not a finite number above 0', () => {
  const expected = claudeCredits(60_000, DEFAULT_TOKENS_PER_PCT);
  for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
    assert.equal(claudeCredits(60_000, bad), expected);
  }
});

test('claudeCredits returns 0 for a negative or non-finite weighted input', () => {
  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(claudeCredits(bad, 60_000), 0);
  }
});

test('localCredits returns 0 for a negative or non-finite seconds or modelGB input', () => {
  for (const bad of [-5, NaN, Infinity, -Infinity]) {
    assert.equal(localCredits(bad, 4), 0);
    assert.equal(localCredits(10, bad), 0);
  }
});

test('valid credit inputs keep their values', () => {
  assert.equal(claudeCredits(0, 60_000), 0);
  assert.equal(claudeCredits(60_000, 30_000), 20);
  assert.equal(localCredits(0, 4), 0);
  assert.equal(localCredits(1000, 0), 1);
});
