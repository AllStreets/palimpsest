import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coalesced } from '../app/src/coalesce.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('a trigger while a run is in flight runs the job once more afterwards', async () => {
  const runs: Array<{ resolve: () => void }> = [];
  const trigger = coalesced(() => {
    const d = deferred();
    runs.push(d);
    return d.promise;
  });

  trigger();
  assert.equal(runs.length, 1);
  trigger();
  trigger();
  assert.equal(runs.length, 1, 'no overlapping run');

  runs[0].resolve();
  await tick();
  assert.equal(runs.length, 2, 'the dropped triggers cause exactly one follow-up run');

  runs[1].resolve();
  await tick();
  assert.equal(runs.length, 2, 'no further runs without new triggers');
});

test('a failed run still honours a pending trigger', async () => {
  let calls = 0;
  const fail = deferred();
  const trigger = coalesced(() => {
    calls++;
    return calls === 1 ? fail.promise.then(() => Promise.reject(new Error('boom'))) : Promise.resolve();
  });
  trigger();
  trigger();
  fail.resolve();
  await tick();
  await tick();
  assert.equal(calls, 2);
});
