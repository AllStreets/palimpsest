/**
 * The perf tool's own settings (Phase 5 Task 0): the port it binds, so the
 * city track's perf and the screens track's never collide and neither ever
 * answers on the real engine's 4770, the tiers it measures, and the window
 * it measures at.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERF_PORT_DEFAULT, PERF_VIEWPORT, perfPort, perfTiers } from '../tools/perf.js';

test('perf.ts listens on PERF_PORT', () => {
  assert.equal(PERF_PORT_DEFAULT, 4791);
  assert.equal(perfPort(undefined), 4791);
  assert.equal(perfPort(''), 4791);
  assert.equal(perfPort('4794'), 4794);
  assert.equal(perfPort(' 4795 '), 4795);
  assert.throws(() => perfPort('4770'), /4770/);
  assert.throws(() => perfPort('4771'), /4771/);
  assert.throws(() => perfPort('abc'), /PERF_PORT/);
  assert.throws(() => perfPort('80'), /PERF_PORT/);
  assert.throws(() => perfPort('4791.5'), /PERF_PORT/);
});

test('PERF_TIERS names high, medium or both, high alone by default', () => {
  assert.deepEqual(perfTiers(undefined), ['high']);
  assert.deepEqual(perfTiers(''), ['high']);
  assert.deepEqual(perfTiers('high,medium'), ['high', 'medium']);
  assert.deepEqual(perfTiers(' medium '), ['medium']);
  assert.deepEqual(perfTiers('medium,high,medium'), ['high', 'medium']);
  assert.throws(() => perfTiers('low'), /PERF_TIERS/);
});

test('the perf viewport is the main display\'s visible frame at DPR 2', () => {
  assert.deepEqual(PERF_VIEWPORT, { width: 1512, height: 890, dpr: 2 });
});
