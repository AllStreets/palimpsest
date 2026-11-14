/**
 * The nets scored on rows they never saw (Phase 4 Task 12, rulings 11 and
 * 12): the split, the baseline each head must beat, the held-out scores
 * with their seeded intervals, trust, promotion, the current version and
 * the card the school screen shows.
 *
 * - The split: real rows by `at`, the newest 20% (at least 10) held out;
 *   distilled rows are only ever trained on (ruling 13). Only the training
 *   rows are written to `rows.json` for the trainer.
 * - The score: Brier for every sigmoid head, the master included; mean
 *   absolute error for the cost head; each a mean over the held-out rows
 *   with its 95% interval (stats.ts, seed 1). The baseline is the training
 *   rows' base rate (their median, for cost, since MAE is least there); for `appraiser-pass` it is the
 *   firm's pass rate as of the award, where the firm had one. `vsBaseline`
 *   is the paired interval of the per-row differences, and a head is
 *   trusted only when its `hi` is below zero.
 * - The master's agreement with him at 0.5 is reported beside its Brier,
 *   never instead. A kind he decides one way nearly always (at least
 *   `AGREE.rate` of its rows) on which the master does not beat that kind's
 *   own base rate is marked skewed: it can never be offered.
 * - Versions live at `paths().school/nets/<net>/v<n>.json`, each recorded
 *   as `net.trained`; a version is promoted (`net.promoted`) when it is
 *   trusted or the current one is not. A train the gate stopped, or whose
 *   weights the engine refuses, records nothing.
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { FEATURES } from '../../shared/net-features.js';
import { forward, MAX_NET_BYTES, outFor, parseNet, type NetWeights } from '../../shared/nets.js';
import { AGREE, HELD_OUT, NET_MIN, WORK_KINDS } from '../../shared/school-rules.js';
import type { NetCard, NetName, NetVersion, TrainState, WorkKind } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { paths } from '../home.js';
import { query, record } from '../ledger.js';
import { rowsFor, thinCause, type DatasetDeps, type Row } from './datasets.js';
import { ci, pairedCi } from './stats.js';
import { startTrain } from './trainer.js';

/** Labels a net needs before it reports anything (ruling 11): 30 to train on and 10 held out. */
export const NEEDS = NET_MIN.train + NET_MIN.heldOut;
/** The trainer's seed (ruling 8). */
export const NET_SEED = 1;
/** The nets are a few kilobytes: their local credits are the per-second floor alone. */
const NET_GB = 0;

const real = (r: Row): boolean => r.source === 'real';
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const byAt = (a: Row, b: Row): number => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

// ---------------------------------------------------------------- the split

/** How many of `n` real rows are held out: the newest 20%, at least 10. */
export function heldOutCount(n: number): number {
  return Math.min(n, Math.max(NET_MIN.heldOut, Math.ceil(n * HELD_OUT)));
}

/** The rows by `at`: the newest real rows held out, everything else (distilled rows included) to train on. */
export function split(rows: readonly Row[]): { train: Row[]; heldOut: Row[] } {
  const sorted = [...rows].sort(byAt);
  const reals = sorted.filter(real);
  const held = new Set(reals.slice(reals.length - heldOutCount(reals.length)));
  return { train: sorted.filter((r) => !held.has(r)), heldOut: sorted.filter((r) => held.has(r)) };
}

// ---------------------------------------------------------------- the baseline and the score

/**
 * The baseline's prediction for each held-out row: the training rows' base
 * rate (the mean of their real labels), or for `appraiser-pass` the firm's
 * pass rate as of the award where the row has one (ruling 11, Decision 14:
 * the appraiser later picks its own rows, so it is held to what the market
 * already knew). The cost head is held to the median of the training
 * labels, the constant with the least absolute error.
 */
export function baselineFor(net: NetName, train: readonly Row[], heldOut: readonly Row[]): number[] {
  const reals = train.filter(real);
  const ys = (reals.length ? reals : train).map((r) => r.y);
  // MAE is minimised by the median, so the cost head is held to it: beating the mean alone is no skill
  if (net === 'appraiser-cost') return heldOut.map(() => median(ys));
  const rate = mean(ys);
  if (net !== 'appraiser-pass') return heldOut.map(() => rate);
  const at = FEATURES[net].indexOf('firm_pass_rate');
  const has = FEATURES[net].indexOf('has_firm_pass_rate');
  return heldOut.map((r) => (r.x[has] === 1 && Number.isFinite(r.x[at]) ? Math.min(1, Math.max(0, r.x[at])) : rate));
}

export type Evaluation = Pick<NetVersion, 'metric' | 'score' | 'baseline' | 'vsBaseline' | 'agreement' | 'trusted'>;

const lossOf =
  (metric: NetVersion['metric']) =>
  (p: number, y: number): number =>
    metric === 'mae' ? Math.abs(p - y) : (p - y) ** 2;

/**
 * The net scored on `heldOut` against `baseline` (one prediction per row):
 * Brier for a sigmoid head, MAE for the cost head, each with its interval;
 * the paired interval of net minus baseline; trusted only when that
 * interval's `hi` is below zero on at least `NET_MIN.heldOut` rows. The
 * master's agreement at 0.5 rides beside its Brier.
 */
export function evaluate(net: NetName, weights: NetWeights, heldOut: readonly Row[], baseline: readonly number[]): Evaluation {
  if (baseline.length !== heldOut.length) throw new Error('the baseline names one prediction per held-out row');
  const preds = heldOut.map((r) => forward(weights, r.x));
  if (preds.some((p) => !Number.isFinite(p))) throw new Error('the net gave a value that is not a number');
  const metric: NetVersion['metric'] = outFor(net) === 'linear' ? 'mae' : 'brier';
  const loss = lossOf(metric);
  const netLoss = preds.map((p, i) => loss(p, heldOut[i].y));
  const baseLoss = baseline.map((p, i) => loss(p, heldOut[i].y));
  const vsBaseline = pairedCi(netLoss, baseLoss, NET_SEED);
  return {
    metric,
    score: ci(netLoss, NET_SEED),
    baseline: ci(baseLoss, NET_SEED),
    vsBaseline,
    agreement: net === 'master' ? ci(preds.map((p, i) => ((p >= 0.5) === (heldOut[i].y >= 0.5) ? 1 : 0)), NET_SEED) : null,
    trusted: heldOut.length >= NET_MIN.heldOut && vsBaseline.hi < 0,
  };
}

/**
 * The kinds on which the master cannot show it knows better than his habit
 * (ruling 11): he decides one way on at least `AGREE.rate` of the kind's
 * training rows (its held-out rows when it has none), and on that kind's
 * held-out rows the master's Brier does not beat that rate's with `hi`
 * below zero. Such a kind is never offered.
 */
export function skewOf(train: readonly Row[], heldOut: readonly Row[], preds: readonly number[]): WorkKind[] {
  const out: WorkKind[] = [];
  const loss = lossOf('brier');
  for (const kind of WORK_KINDS) {
    const c = FEATURES.master.indexOf(`kind=${kind}`);
    const t = train.filter((r) => real(r) && r.x[c] === 1);
    const h = heldOut.map((r, i) => ({ r, p: preds[i] })).filter(({ r }) => r.x[c] === 1);
    if (t.length + h.length === 0) continue;
    const rate = mean(t.length ? t.map((r) => r.y) : h.map(({ r }) => r.y));
    if (rate < AGREE.rate && rate > 1 - AGREE.rate) continue;
    const beats =
      h.length > 0 &&
      pairedCi(
        h.map(({ r, p }) => loss(p, r.y)),
        h.map(({ r }) => loss(rate, r.y)),
        NET_SEED,
      ).hi < 0;
    if (!beats) out.push(kind);
  }
  return out;
}

// ---------------------------------------------------------------- versions and the current one

interface Trained {
  version: NetVersion;
  skewed: WorkKind[];
}

function trainedOf(net: NetName): Trained[] {
  const out: Trained[] = [];
  for (const e of query({ kind: 'net.trained' })) {
    const d = e.data as { version?: NetVersion; skewed?: unknown };
    if (!d.version || d.version.net !== net || !Number.isInteger(d.version.version)) continue;
    out.push({ version: d.version, skewed: Array.isArray(d.skewed) ? (d.skewed.filter((k) => (WORK_KINDS as readonly unknown[]).includes(k)) as WorkKind[]) : [] });
  }
  return out;
}

/**
 * The nets table beside the ledger (Task 28 fix round 1): a version's row as
 * `net.trained` records it, and `current` moved by each `net.promoted`, so
 * replay.ts can check the table against the ledger. The ledger stays what
 * `versions()` and `current()` read.
 */
export function putNetRow(v: NetVersion): void {
  openDb().prepare('INSERT OR REPLACE INTO nets (net, version, at, current, json) VALUES (?, ?, ?, ?, ?)').run(v.net, v.version, v.at, v.current ? 1 : 0, JSON.stringify(v));
}

/** `version` of `net` is now its current one, every other version of it not. */
export function markCurrent(net: NetName, version: number): void {
  openDb().prepare('UPDATE nets SET current = (version = ?) WHERE net = ?').run(version, net);
}

/** The version number last promoted for `net`, or null. */
function promotedVersion(net: NetName): number | null {
  let v: number | null = null;
  for (const e of query({ kind: 'net.promoted' })) {
    const d = e.data as { net?: unknown; version?: unknown };
    if (d.net === net && typeof d.version === 'number') v = d.version;
  }
  return v;
}

/** Every recorded version of `net`, oldest first, with `current` as it stands now. */
export function versions(net: NetName): NetVersion[] {
  const cur = promotedVersion(net);
  return trainedOf(net).map((t) => ({ ...t.version, current: t.version.version === cur }));
}

/**
 * The weights path stored in a version, resolved under `paths().school/nets`
 * with every link followed; null when it points anywhere else, or when it or
 * the nets folder cannot be resolved (a missing file is then missing).
 */
function weightsPath(v: NetVersion): string | null | 'missing' {
  let nets: string;
  try {
    nets = realpathSync(resolve(paths().school, 'nets'));
  } catch {
    return 'missing';
  }
  const lexical = resolve(paths().school, v.path);
  if (!lexical.startsWith(resolve(paths().school, 'nets') + sep)) return null;
  let p: string;
  try {
    p = realpathSync(lexical);
  } catch {
    return 'missing';
  }
  return p.startsWith(nets + sep) ? p : null;
}

export interface Current {
  weights: NetWeights;
  version: NetVersion;
}

/** The current version and its weights, or null with the reason (null too when nothing has been promoted). */
export function loadCurrent(net: NetName): { current: Current | null; reason: string | null } {
  const n = promotedVersion(net);
  if (n === null) return { current: null, reason: null };
  const version = versions(net).find((v) => v.version === n);
  if (!version) return { current: null, reason: `v${n} is promoted but was never recorded` };
  const file = weightsPath(version);
  if (file === 'missing') return { current: null, reason: `v${n}'s weights are missing` };
  if (!file) return { current: null, reason: `v${n}'s weights could not be read: its path is outside the school` };
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { current: null, reason: `v${n}'s weights are missing` };
  }
  if (size > MAX_NET_BYTES) return { current: null, reason: `v${n}'s weights could not be read: the file is too large` };
  let weights: NetWeights | null;
  try {
    weights = parseNet(readFileSync(file, 'utf8'));
  } catch {
    weights = null;
  }
  if (!weights || weights.net !== net || weights.version !== n) return { current: null, reason: `v${n}'s weights could not be read` };
  return { current: { weights, version }, reason: null };
}

/** The current version of `net` with its weights; null when none is promoted, or its file is missing or refused (`loadCurrent` keeps why). */
export function current(net: NetName): Current | null {
  return loadCurrent(net).current;
}

/** The kinds the current master marks skewed (ruling 11), for agreement() and the school screen. */
export function skewedKinds(): WorkKind[] {
  const n = promotedVersion('master');
  if (n === null) return [];
  return trainedOf('master').find((t) => t.version.version === n)?.skewed ?? [];
}

// ---------------------------------------------------------------- the card

/** Whether the appraiser has moved an award (Task 14 records `appraiserMoved: true` on `job.awarded`): its later rows are partly its own choice. */
function appraiserHasMoved(): boolean {
  const row = openDb().prepare("SELECT 1 AS hit FROM ledger WHERE kind = 'job.awarded' AND json_extract(json, '$.appraiserMoved') = 1 LIMIT 1").get();
  return row !== undefined;
}

/** A net as the school screen shows it (never a path), with the cause when it is thin (ruling 29). */
export function netCard(net: NetName, now: number, deps: DatasetDeps = {}): NetCard {
  const labels = rowsFor(net, now, deps).filter(real).length;
  const all = versions(net);
  const history = all.map((v) => ({ version: v.version, at: v.at, score: v.score, trusted: v.trusted }));
  const selfSelected = (net === 'appraiser-pass' || net === 'appraiser-cost') && appraiserHasMoved();
  const { current: cur, reason: refused } = loadCurrent(net);
  const shown = cur ? (({ path: _path, ...rest }) => rest)(cur.version) : null;
  const base = { net, current: shown, history, labels, needs: NEEDS, selfSelected };
  if (labels < NEEDS) return { ...base, status: 'thin', reason: `${labels} of ${NEEDS} labels`, cause: thinCause(net, now, deps) };
  if (cur) {
    const v = cur.version;
    return { ...base, status: v.trusted ? 'trusted' : 'trained', reason: v.trusted ? null : `v${v.version} does not beat its baseline on held-out rows`, cause: null };
  }
  return { ...base, status: 'untrained', reason: refused ?? 'Enough labels; not trained yet', cause: null };
}

/** Every net's card, in the order the screen lists them. */
export function netCards(now: number, deps: DatasetDeps = {}): NetCard[] {
  return (Object.keys(FEATURES) as NetName[]).map((n) => netCard(n, now, deps));
}

// ---------------------------------------------------------------- training

export interface TrainNetResult {
  net: NetName;
  /** `thin`: too few labels, nothing started; `waiting`: the gate or the switch said no; `stopped`: paused or stopped mid-train; `failed`: no usable weights. */
  status: 'thin' | 'waiting' | 'stopped' | 'failed' | 'trained';
  reason: string | null;
  version: NetVersion | null;
  promoted: boolean;
  train: TrainState | null;
}

function nextVersion(net: NetName): number {
  return trainedOf(net).reduce((m, t) => Math.max(m, t.version.version), 0) + 1;
}

/**
 * Trains the next version of `net` on its training rows under the light
 * gate, scores it on the held-out rows, records `net.trained`, and promotes
 * it when it is trusted or the current one is not. Nothing is recorded when
 * the net is thin, the gate says no, the trainer stops or fails, or its
 * weights are refused.
 */
export async function trainNet(net: NetName, now: number, deps: DatasetDeps = {}): Promise<TrainNetResult> {
  const result = (status: TrainNetResult['status'], reason: string | null, train: TrainState | null = null): TrainNetResult => ({ net, status, reason, version: null, promoted: false, train });
  const rows = rowsFor(net, now, deps);
  const labels = rows.filter(real).length;
  if (labels < NEEDS) return result('thin', `${labels} of ${NEEDS} labels`);
  const { train, heldOut } = split(rows);

  const version = nextVersion(net);
  const dir = join(paths().school, 'nets', net);
  mkdirSync(dir, { recursive: true });
  const rowsPath = join(dir, 'rows.json');
  writeFileSync(rowsPath, train.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rel = join('nets', net, `v${version}.json`);
  const outPath = join(paths().school, rel);
  // a stopped train may have left partial weights here: never read them as this train's
  rmSync(outPath, { force: true });

  const id = `net-${net}-v${version}`;
  let answer: Record<string, unknown> | null = null;
  const state = await startTrain({
    kind: 'nets',
    gate: 'light',
    command: { id, cmd: 'train_net', net, rows_path: rowsPath, out_path: outPath, seed: NET_SEED, version, features: [...FEATURES[net]] },
    gb: NET_GB,
    model: 'mlx:nets',
    now,
    onLine: (line) => {
      if (line.stream !== 'stdout' || !line.line.startsWith('{')) return;
      try {
        const d = JSON.parse(line.line) as Record<string, unknown>;
        if (d && d.id === id && typeof d.ok === 'boolean') answer = d;
      } catch {
        // not an answer
      }
    },
  });
  if (state.status === 'waiting') return result('waiting', state.reason, state);
  if (state.status === 'paused') return result('stopped', state.reason, state);
  if (state.status !== 'done') return result('failed', state.reason, state);
  const a = answer as Record<string, unknown> | null;
  if (!a) return result('failed', 'the trainer gave no answer', state);
  if (a.ok !== true) return result('failed', typeof a.error === 'string' ? a.error : 'the trainer refused the request', state);
  if (a.stopped === true) return result('stopped', 'the trainer stopped before the end', state);

  let weights: NetWeights | null = null;
  try {
    if (statSync(outPath).size <= MAX_NET_BYTES) weights = parseNet(readFileSync(outPath, 'utf8'));
  } catch {
    weights = null;
  }
  if (!weights || weights.net !== net || weights.version !== version) return result('failed', `v${version}'s weights could not be read`, state);

  let e: Evaluation;
  let preds: number[];
  try {
    preds = heldOut.map((r) => forward(weights!, r.x));
    e = evaluate(net, weights, heldOut, baselineFor(net, train, heldOut));
  } catch (err) {
    return result('failed', `v${version} could not be scored: ${err instanceof Error ? err.message : String(err)}`, state);
  }

  const was = loadCurrent(net).current;
  // a current whose weights cannot be read serves nothing, so it is no better than an untrusted one and the new version replaces it
  const promote = e.trusted || !was?.version.trusted;
  const v: NetVersion = {
    net,
    version,
    at: state.endedAt ?? new Date(now).toISOString(),
    rows: { train: train.filter(real).length, heldOut: heldOut.length, distilled: train.filter((r) => !real(r)).length },
    ...e,
    current: promote,
    seconds: state.seconds,
    path: rel,
  };
  const skewed = net === 'master' ? skewOf(train, heldOut, preds) : [];
  record('net.trained', { version: v, skewed, trainId: state.id });
  putNetRow(v);
  emit('net.trained', { net, version: v.version, trusted: v.trusted });
  if (promote) {
    const data = { net, version, from: was?.version.version ?? null, trusted: v.trusted, at: v.at };
    record('net.promoted', data);
    markCurrent(net, version);
    emit('net.promoted', data);
  }
  return { net, status: 'trained', reason: null, version: v, promoted: promote, train: state };
}
