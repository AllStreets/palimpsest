/**
 * A trained net run in TypeScript (Phase 4 Task 11, ruling 8): the trainer
 * writes the weights in MLX (trainer/nets.py) and the engine runs them here,
 * with no Python. Pure: no engine import.
 *
 * The forward pass is the trainer's exactly: standardise by the training
 * rows' mean and std, a linear layer, exact GELU `0.5 x (1 + erf(x / sqrt 2))`
 * (MLX's `nn.gelu`, not its tanh approximation), a linear head, then a
 * sigmoid, or nothing for the appraiser's cost head. Each `W` is MLX's layout,
 * one row per output unit. Arithmetic is in doubles; MLX's is float32, and
 * test/fixtures/net-parity.json holds the two within 1e-5.
 */
import { FEATURES } from './net-features.js';
import type { NetName } from './types.js';

export interface NetLayer {
  W: number[][];
  b: number[];
}

/** A net's weights file, as the trainer writes it. */
export interface NetWeights {
  net: NetName;
  version: number;
  features: string[];
  norm: { mean: number[]; std: number[] };
  /** The hidden layer, then the one-unit head. */
  layers: [NetLayer, NetLayer];
  out: 'sigmoid' | 'linear';
}

const NETS = Object.keys(FEATURES) as NetName[];

/** The head each net has: the cost head is a number of credits (log1p), every other a probability. */
export const outFor = (net: NetName): NetWeights['out'] => (net === 'appraiser-cost' ? 'linear' : 'sigmoid');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isNum);
const isMat = (v: unknown, rows: number, cols: number): v is number[][] => Array.isArray(v) && v.length === rows && v.every((r) => isVec(r, cols));

/**
 * A weights file read and checked, or null: the net is one of ours, its
 * columns are exactly that net's current `FEATURES` in order (weights trained
 * on other columns are never run), every number is finite, every std is
 * positive, and the layers' shapes chain d to h to 1.
 */
export function parseNet(text: string): NetWeights | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const net = o.net as NetName;
  if (typeof o.net !== 'string' || !NETS.includes(net)) return null;
  if (!Number.isInteger(o.version) || (o.version as number) < 1) return null;
  if (o.out !== outFor(net)) return null;
  const features = FEATURES[net];
  const d = features.length;
  if (!Array.isArray(o.features) || o.features.length !== d || o.features.some((f, i) => f !== features[i])) return null;
  const norm = o.norm as { mean?: unknown; std?: unknown } | null;
  if (!norm || typeof norm !== 'object' || !isVec(norm.mean, d) || !isVec(norm.std, d) || norm.std.some((s) => s <= 0)) return null;
  if (!Array.isArray(o.layers) || o.layers.length !== 2) return null;
  const [hidden, head] = o.layers as Array<{ W?: unknown; b?: unknown } | null>;
  if (!hidden || !head || !Array.isArray(hidden.b) || hidden.b.length < 1) return null;
  const h = hidden.b.length;
  if (!isMat(hidden.W, h, d) || !isVec(hidden.b, h) || !isMat(head.W, 1, h) || !isVec(head.b, 1)) return null;
  return {
    net,
    version: o.version as number,
    features: [...features],
    norm: { mean: norm.mean, std: norm.std },
    layers: [
      { W: hidden.W, b: hidden.b },
      { W: head.W, b: head.b },
    ],
    out: o.out as NetWeights['out'],
  };
}

const TWO_OVER_SQRT_PI = 2 / Math.sqrt(Math.PI);

/**
 * The error function to about 1e-15: erf(x) = 2/sqrt(pi) e^(-x^2) sum 2^n
 * x^(2n+1) / (1 3 5 ... (2n+1)), a series of positive terms with no
 * cancellation; past |x| = 6, erfc is under 3e-17 and erf is +-1.
 */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const a = Math.abs(x);
  if (a >= 6) return Math.sign(x);
  if (a === 0) return 0;
  const x2 = a * a;
  let term = a;
  let sum = a;
  for (let n = 1; n < 500; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return Math.sign(x) * Math.min(1, TWO_OVER_SQRT_PI * Math.exp(-x2) * sum);
}

/** Exact GELU, as MLX's `nn.gelu`. */
export const gelu = (x: number): number => 0.5 * x * (1 + erf(x / Math.SQRT2));

/** The net on one row of raw (encoded, unstandardised) features; a row of the wrong length throws. */
export function forward(net: NetWeights, x: readonly number[]): number {
  const { mean, std } = net.norm;
  if (x.length !== mean.length) throw new Error(`${net.net} takes ${mean.length} features, not ${x.length}`);
  const z = mean.map((m, j) => (x[j]! - m) / std[j]!);
  const [hidden, head] = net.layers;
  const a = hidden.W.map((row, i) => gelu(row.reduce((s, w, j) => s + w * z[j]!, hidden.b[i]!)));
  const o = head.W[0]!.reduce((s, w, i) => s + w * a[i]!, head.b[0]!);
  return net.out === 'sigmoid' ? 1 / (1 + Math.exp(-o)) : o;
}
