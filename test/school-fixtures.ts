/**
 * Nets written straight into a temp home for the tests that use them (Phase
 * 4 Task 14): a weights file under `paths().school/nets`, its `net.trained`
 * row and its `net.promoted` row, so `current(net)` serves it. No trainer.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { record } from '../engine/ledger.js';
// installs the school's hooks into the market, as the engine does through tick.ts
import { registerPrediction, resolve } from '../engine/school/decisions.js';
import { FEATURES } from '../shared/net-features.js';
import { outFor, type NetWeights } from '../shared/nets.js';
import type { Job, NetName, NetVersion, Run, WorkKind } from '../shared/types.js';

/** One hidden unit: `gelu(sum of w * column + b)`, weighted by `head` into the output. */
export interface Unit {
  w: Record<string, number>;
  b?: number;
  head: number;
}

/** A net of `units` hidden units over raw (unstandardised) columns, with output bias `bias`. */
export function netOf(net: NetName, version: number, units: Unit[], bias: number): NetWeights {
  const cols = FEATURES[net];
  const d = cols.length;
  const rows = (units.length ? units : [{ w: {}, head: 0 }]).map((u) => {
    const row = new Array<number>(d).fill(0);
    for (const [name, w] of Object.entries(u.w)) {
      const i = cols.indexOf(name);
      if (i < 0) throw new Error(`no column ${name} in ${net}`);
      row[i] = w;
    }
    return { row, b: u.b ?? 0, head: u.head };
  });
  return {
    net,
    version,
    features: [...cols],
    norm: { mean: new Array<number>(d).fill(0), std: new Array<number>(d).fill(1) },
    layers: [
      { W: rows.map((r) => r.row), b: rows.map((r) => r.b) },
      { W: [rows.map((r) => r.head)], b: [bias] },
    ],
    out: outFor(net),
  };
}

/** A net that says `p` whatever it sees. */
export function constant(net: NetName, version: number, p: number): NetWeights {
  return netOf(net, version, [], Math.log(p / (1 - p)));
}

/** A net whose every answer is not a number: two huge units whose products overflow to infinity and cancel. */
export function broken(net: NetName, version: number): NetWeights {
  return netOf(net, version, [{ w: {}, b: 1e308, head: 1e308 }, { w: {}, b: 1e308, head: -1e308 }], 0);
}

const iv = (value: number) => ({ value, lo: value, hi: value, n: 10 });

/** Writes `weights`, records its `net.trained` (trusted or not, trained at `at`) and promotes it. */
export function installNet(weights: NetWeights, o: { trusted?: boolean; at?: string } = {}): NetVersion {
  const rel = join('nets', weights.net, `v${weights.version}.json`);
  mkdirSync(join(paths().school, 'nets', weights.net), { recursive: true });
  writeFileSync(join(paths().school, rel), JSON.stringify(weights));
  const trusted = o.trusted ?? true;
  const version: NetVersion = {
    net: weights.net,
    version: weights.version,
    at: o.at ?? new Date().toISOString(),
    rows: { train: 40, heldOut: 10, distilled: 0 },
    metric: weights.out === 'linear' ? 'mae' : 'brier',
    score: iv(0.1),
    baseline: iv(0.2),
    vsBaseline: trusted ? { diff: -0.1, lo: -0.15, hi: -0.05 } : { diff: -0.01, lo: -0.05, hi: 0.03 },
    agreement: weights.net === 'master' ? iv(0.9) : null,
    trusted,
    current: true,
    seconds: 1,
    path: rel,
  };
  record('net.trained', { version, skewed: [], trainId: `train-${weights.net}-${weights.version}` });
  record('net.promoted', { net: weights.net, version: weights.version, from: null, trusted, at: version.at });
  return version;
}

// ---------------------------------------------------------------- an agreement window (Tasks 15 and 16)

let seq = 0;

/** A job written straight to the store, for a decision the tests resolve themselves. */
export function storeJobRow(id: string, over: Partial<Job>): Job {
  const j: Job = {
    id,
    repo: 'acme/widgets',
    source: 'manual',
    issue: null,
    url: null,
    title: `Job ${id}`,
    body: '',
    scope: ['**'],
    acceptance: ['it works'],
    tier: 'normal',
    value: 60,
    status: 'waiting',
    attempts: 0,
    postedAt: '2026-11-12T01:00:00.000Z',
    bidsCloseAt: null,
    awardedBid: null,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO jobs (id, repo, status, json, key) VALUES (?, ?, ?, ?, ?)').run(j.id, j.repo, j.status, JSON.stringify(j), null);
  return j;
}

/** A run written straight to the store: a PR waiting on him unless `over` says otherwise. */
export function storeRunRow(id: string, jobId: string, repo: string, over: Partial<Run> = {}): Run {
  const r: Run = {
    id,
    jobId,
    bidId: `bid-${jobId}`,
    agentId: 'w1',
    firmId: 'quickset',
    repo,
    model: 'claude:sonnet',
    branch: `palimpsest/${jobId}`,
    dir: null,
    baseSha: null,
    headSha: 'b'.repeat(40),
    stage: 'waiting',
    outcome: null,
    endedReason: null,
    progress: { toolCalls: 0, filesChanged: 1, testsRun: 0, turns: 1, weightedTokens: 0, credits: 0, refusals: 0 },
    startedAt: '2026-11-12T01:00:00.000Z',
    endedAt: null,
    prNumber: 9,
    prUrl: `https://github.com/${repo}/pull/9`,
    mergeSha: null,
    inspectionId: null,
    scar: false,
    unattended: false,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
  return r;
}

/**
 * `count` of his decisions of `kind` on `repo`, each agreeing with the
 * installed master (which must guess approve, 0.5 or more), one minute
 * apart from `from`. Proposal kinds are accepted proposals; merge kinds are
 * merged PRs of the tier. Returns the clock after the last one.
 */
export function agreedDecisions(kind: WorkKind, repo: string, count: number, from: number): number {
  let clock = from;
  for (let i = 0; i < count; i++) {
    const id = `agree-${repo.replace('/', '-')}-${kind.replace(':', '-')}-${seq++}`;
    if (kind.startsWith('propose:')) {
      const j = storeJobRow(id, { repo, source: kind === 'propose:harness' ? 'harness' : 'proposal', status: 'proposed', tier: 'low' });
      registerPrediction(j, null, clock);
      clock += 60_000;
      resolve(j, 'accept', clock);
    } else {
      const tier = kind === 'merge:ui' ? 'normal' : (kind.slice('merge:'.length) as Job['tier']);
      const j = storeJobRow(id, { repo, tier, status: 'waiting', runId: `run-${id}` });
      const r = storeRunRow(`run-${id}`, j.id, repo);
      registerPrediction(j, r, clock);
      clock += 60_000;
      resolve(j, 'merge', clock, { run: r });
    }
    clock += 60_000;
  }
  return clock;
}
