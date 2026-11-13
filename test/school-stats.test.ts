/**
 * The school's seeded bootstrap (Phase 4 Task 4's stats.ts, pulled forward
 * for Task 12): Beagle's percentile bootstrap, 10,000 resamples, mulberry32.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOOTSTRAP_RESAMPLES, ci, pairedCi } from '../engine/school/stats.js';

test('ci is seeded and stable', () => {
  const xs = [0.1, 0.4, 0.35, 0.8, 0.2, 0.9, 0.05, 0.6, 0.5, 0.3];
  const a = ci(xs);
  const b = ci(xs, 1);
  assert.deepEqual(a, b, 'the same values and seed give the same interval');
  assert.equal(a.n, 10);
  assert.ok(Math.abs(a.value - 0.42) < 1e-12);
  assert.ok(a.lo < a.value && a.value < a.hi);
  // pinned to Beagle's bootstrap(xs, 1) on the same values: a change to the generator, the resample count or the percentiles moves these
  assert.equal(a.lo, 0.26);
  assert.equal(a.hi, 0.5949999999999999);
  const other = ci(xs, 2);
  assert.notDeepEqual([other.lo, other.hi], [a.lo, a.hi], 'another seed resamples differently');
  assert.equal(BOOTSTRAP_RESAMPLES, 10_000);
  assert.deepEqual(ci([]), { value: 0, lo: 0, hi: 0, n: 0 });
  assert.deepEqual(ci([0.5, 0.5, 0.5]), { value: 0.5, lo: 0.5, hi: 0.5, n: 3 });
});

test('pairedCi of a better child has lo above zero', () => {
  const parent = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const child = parent.map((x, i) => (x === 1 || i % 2 === 0 ? 1 : 0));
  const p = pairedCi(child, parent);
  assert.ok(p.diff > 0);
  assert.ok(p.lo > 0, `lo ${p.lo}`);
  assert.ok(p.hi >= p.lo);
  assert.deepEqual(pairedCi(child, parent, 1), p, 'seeded');
  const same = pairedCi(parent, parent);
  assert.deepEqual(same, { diff: 0, lo: 0, hi: 0 });
  assert.throws(() => pairedCi([1, 2], [1]), /same length/);
});
