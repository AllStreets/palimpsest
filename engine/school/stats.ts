/**
 * The school's intervals (Phase 4 ruling 11): a seeded 95% percentile
 * bootstrap of a mean, and of the mean of paired differences.
 *
 * This mirrors `bootstrap()` in Beagle's `src/stats.ts` exactly: mulberry32
 * seeded with `seed`, 10,000 resamples of the values with replacement, the
 * resample means sorted, `lo` the one at floor(0.025 * 10,000) and `hi` the
 * one at ceil(0.975 * 10,000) - 1; no values gives 0 to 0. Task 4 points
 * these at Beagle's own `bootstrap()` once Beagle loads as a library; the
 * numbers must not move when it does.
 */
import type { Interval } from '../../shared/types.js';

/** Resamples per interval, as Beagle's bootstrap draws. */
export const BOOTSTRAP_RESAMPLES = 10_000;

/** mulberry32, as Beagle's `rng(seed)`. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Beagle's `bootstrap(xs, seed)`: the 95% percentile interval of the mean. */
function bootstrap(xs: readonly number[], seed: number): { lo: number; hi: number } {
  if (!xs.length) return { lo: 0, hi: 0 };
  const r = rng(seed);
  const n = xs.length;
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let b = 0; b < means.length; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(r() * n)];
    means[b] = s / n;
  }
  means.sort();
  return { lo: means[Math.floor(0.025 * means.length)], hi: means[Math.ceil(0.975 * means.length) - 1] };
}

/** The mean of `values` with its seeded 95% interval and how many values stand behind it. */
export function ci(values: readonly number[], seed = 1): Interval {
  const { lo, hi } = bootstrap(values, seed);
  return { value: mean(values), lo, hi, n: values.length };
}

/** The mean of `a[i] - b[i]` with its seeded 95% interval: above zero when `a` is reliably larger. */
export function pairedCi(a: readonly number[], b: readonly number[], seed = 1): { diff: number; lo: number; hi: number } {
  if (a.length !== b.length) throw new Error(`paired values must be the same length (${a.length} and ${b.length})`);
  const d = a.map((x, i) => x - b[i]);
  const { lo, hi } = bootstrap(d, seed);
  return { diff: mean(d), lo, hi };
}
