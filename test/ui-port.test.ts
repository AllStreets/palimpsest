/**
 * The ui-test's engine port: UI_PORT when set (so ui-tests in two worktrees
 * stop colliding), 4779 otherwise, and never the real engine's 4770.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uiPort } from '../tools/ui-port.js';

test('the ui-test port defaults to 4779 and honours UI_PORT', () => {
  assert.equal(uiPort(undefined), 4779);
  assert.equal(uiPort(''), 4779);
  assert.equal(uiPort('4811'), 4811);
  assert.equal(uiPort(' 4812 '), 4812);
});

test('the ui-test port refuses the real engine port and anything that is not a port', () => {
  assert.throws(() => uiPort('4770'), /4770/);
  assert.throws(() => uiPort('4771'), /4771/);
  assert.throws(() => uiPort('abc'), /UI_PORT/);
  assert.throws(() => uiPort('80'), /UI_PORT/);
  assert.throws(() => uiPort('70000'), /UI_PORT/);
  assert.throws(() => uiPort('4811.5'), /UI_PORT/);
});
