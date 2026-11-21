/**
 * The pure models under the screens' instruments (readout.ts): a window's use
 * along its scale, a run of decisions as ticks, and verdicts as shares of one
 * bar. No DOM, so they run in node.
 */
import type { Tone } from './tokens.js';

/** One figure and its short key: '4.10' and 'credits'. An empty `v` is not shown. */
export interface Readout {
  v: string;
  k?: string;
  tone?: Tone;
}

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));
const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);

/**
 * A window's use as a rangefinder reads it: the lit run and the head along a
 * 0 to 100 scale, the cap standing on it, and the whole reading in words for
 * the reader ("five-hour window 45%, limit 50%"). A window not read has no run
 * and no head. At or past its cap it is over, and the words say so.
 */
export function rangeModel(window: string, pct: number | null, cap: number | null): { run: number; head: number | null; cap: number | null; over: boolean; label: string } {
  const read = finite(pct);
  const capped = finite(cap);
  const run = read ? clamp100(pct) : 0;
  const words = `${window} window ${read ? `${Math.round(pct)}%` : 'not read'}${capped ? `, limit ${Math.round(cap)}%` : ''}`;
  const over = read && capped && pct >= cap;
  return { run, head: read ? run : null, cap: capped ? clamp100(cap) : null, over, label: over ? `${words}, over the limit` : words };
}

/**
 * A run of `of` decisions as ticks, `on` of them agreed. Only counts are known,
 * so the misses are drawn together at the newest end. `on` is held to 0..of.
 */
export function tickModel(on: number, of: number): Array<'on' | 'off'> {
  const n = Math.max(0, Math.floor(of) || 0);
  const lit = Math.max(0, Math.min(n, Math.floor(on) || 0));
  return Array.from({ length: n }, (_, i) => (i < lit ? 'on' : 'off'));
}

/** Each part's share of the whole, the parts with none dropped. All zero is no bar: []. */
export function segmentModel(parts: Array<{ key: string; n: number }>): Array<{ key: string; n: number; share: number }> {
  const kept = parts.filter((p) => Number.isFinite(p.n) && p.n > 0);
  const total = kept.reduce((s, p) => s + p.n, 0);
  return total > 0 ? kept.map((p) => ({ key: p.key, n: p.n, share: p.n / total })) : [];
}
