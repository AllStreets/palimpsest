/**
 * The ui-test's last word (tools/ui-verdict.ts): a partial mode (UI_ONLY,
 * UI_FORCE_DROP) never reads as a full pass, and exits with its own code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PARTIAL_EXIT, partialMode, verdict } from '../tools/ui-verdict.js';

test('a partial run never reads as a full pass and exits apart', () => {
  assert.equal(partialMode({ UI_ONLY: 'spire' }), 'UI_ONLY=spire');
  assert.equal(partialMode({ UI_FORCE_DROP: '1' }), 'UI_FORCE_DROP=1');
  assert.equal(partialMode({}), null);
  const v = verdict([], 'UI_ONLY=spire');
  assert.equal(v.code, PARTIAL_EXIT);
  assert.notEqual(PARTIAL_EXIT, 0);
  assert.notEqual(PARTIAL_EXIT, 1);
  assert.match(v.line, /^PARTIAL run \(UI_ONLY=spire\): not a full pass$/);
  assert.doesNotMatch(v.line, /ui-test passed/);
});

test('failures fail whatever the mode, and only a full clean run passes', () => {
  assert.deepEqual(verdict(['x'], 'UI_ONLY=spire'), { code: 1, line: '1 check(s) failed (PARTIAL run (UI_ONLY=spire): not a full pass)' });
  assert.deepEqual(verdict(['x', 'y'], null), { code: 1, line: '2 check(s) failed' });
  assert.deepEqual(verdict([], null), { code: 0, line: 'ui-test passed' });
});
