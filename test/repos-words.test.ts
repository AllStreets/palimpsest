/**
 * The Repos screen's push-mode reason (P2 Task 21 minor): a reason the
 * engine gave for refusing push mode stands only until the repo it was about
 * changes, or the stream comes back after missing events.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forgetPushWhy } from '../app/src/ui/repos-words.js';

const repo = (fullName: string) => ({ fullName });

test('a push-mode reason is forgotten when its repo reconnects, re-analyses or changes, and all of them when the stream comes back', () => {
  const why = new Map([
    ['acme/one', 'The repo has no build command.'],
    ['acme/two', 'The repo has no test command.'],
  ]);
  forgetPushWhy(why, { type: 'repo.analyzing', data: { repo: repo('acme/one') } });
  assert.equal(why.size, 2, 'a step changes nothing the reason was about');
  for (const type of ['repo.connected', 'repo.disconnected', 'repo.analyzed', 'repo.patched']) {
    why.set('acme/one', 'stale');
    forgetPushWhy(why, { type, data: { repo: repo('acme/one') } });
    assert.equal(why.has('acme/one'), false, `${type} kept the reason`);
    assert.equal(why.has('acme/two'), true, `${type} dropped another repo's reason`);
  }
  why.set('acme/one', 'stale');
  forgetPushWhy(why, { type: 'engine.reconnected', data: null });
  assert.equal(why.size, 0);
});
