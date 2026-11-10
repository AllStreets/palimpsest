import assert from 'node:assert/strict';
import { test } from 'node:test';

import { qualityGovernor, TRIANGLE_BUDGET } from '../app/src/city/governor.js';

/** Feeds `seconds` of frames at `ms` each, with `triangles` drawn per frame; returns the first verdict. */
function run(g: ReturnType<typeof qualityGovernor>, seconds: number, ms: number, triangles = 1e6): 'medium' | null {
  let out: 'medium' | null = null;
  for (let t = 0; t < seconds * 1000; t += ms) out ??= g.frame(ms, triangles);
  return out;
}

test('a city holding 60 fps stays at high quality', () => {
  const g = qualityGovernor();
  assert.equal(run(g, 30, 16.7), null);
  assert.equal(g.dropped, false);
});

test('a sustained slow frame rate steps down to medium once', () => {
  const g = qualityGovernor();
  assert.equal(run(g, 2, 16.7), null, 'the first seconds (shader compiles, texture uploads) never count');
  assert.equal(run(g, 2, 40), null, 'a short slow patch is not sustained');
  assert.equal(run(g, 10, 40), 'medium');
  assert.equal(g.dropped, true);
  assert.equal(run(g, 20, 40), null, 'it never asks twice');
});

test('a hitch or a hidden tab does not count as slow frames', () => {
  const g = qualityGovernor();
  run(g, 4, 16.7);
  // One long gap (the tab was hidden, a tower was rebuilt) among good frames.
  assert.equal(g.frame(2000, 1e6), null);
  for (let i = 0; i < 6; i++) assert.equal(g.frame(900, 1e6), null, 'gaps past a quarter second are skipped');
  assert.equal(run(g, 20, 17), null);
});

test('a city drawing past the triangle budget steps down even while the frame rate holds', () => {
  const g = qualityGovernor();
  assert.equal(run(g, 2, 16.7, TRIANGLE_BUDGET * 1.2), null);
  assert.equal(run(g, 10, 16.7, TRIANGLE_BUDGET * 1.2), 'medium');
  const h = qualityGovernor();
  assert.equal(run(h, 20, 16.7, TRIANGLE_BUDGET * 0.9), null, 'under the budget nothing changes');
});

test('a governor started at medium has nothing to step down to', () => {
  const g = qualityGovernor({ start: 'medium' });
  assert.equal(run(g, 20, 50, TRIANGLE_BUDGET * 2), null);
});
