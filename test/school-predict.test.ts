/**
 * The nets at work and the master's prospective guesses (Phase 4 Task 14,
 * ruling 15): `predict`, `masterInputs` and `registerPrediction`. Nets are
 * written straight into a temp home; no trainer runs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { query, record } from '../engine/ledger.js';
import { job as storedJob, postProposal, proposeHarnessJob } from '../engine/market/jobs.js';
import { rowsFor } from '../engine/school/datasets.js';
import { jobSchool, masterInputs, predict, registerPrediction } from '../engine/school/decisions.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Job, Repo } from '../shared/types.js';
import { addAgent, FULL, setUp, tearDown } from './guild-fixtures.js';
import { broken, constant, installNet, netOf } from './school-fixtures.js';

const DAY = 24 * 3_600_000;

beforeEach(() => {
  setUp('school-predict');
  putRepo();
  school(true);
});
afterEach(async () => {
  await tearDown();
});

function school(on: boolean): void {
  patchSettings({ school: { ...getSettings().school, enabled: on } });
}

function putRepo(): Repo {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-11-01T00:00:00.000Z',
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

function propose(title = 'Document the CLI flags'): Job {
  return postProposal({
    repo: FULL,
    title,
    body: 'The README names flags the CLI does not have.',
    scope: ['README.md'],
    acceptance: ['The README names only real flags'],
    tier: 'low',
    key: `proposal:${title}`,
    source: 'proposal',
    proposal: null,
  });
}

type Row = Record<string, unknown> & { id: number };
const predicted = (jobId?: string): Row[] => query({ kind: 'master.predicted', ...(jobId ? { jobId } : {}) }).map((e) => ({ ...(e.data as Record<string, unknown>), id: e.id }));
const tableRows = () => openDb().prepare('SELECT id, key, json FROM predictions').all() as Array<{ id: number; key: string; json: string }>;

// ---------------------------------------------------------------- tests

test('a proposed job registers one prediction, once', () => {
  const j = propose();
  const rows = predicted(j.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, `propose:readme-gap:${j.id}`);
  assert.equal(rows[0].kind, 'propose:readme-gap');
  assert.equal(rows[0].repo, FULL);
  assert.equal(rows[0].jobId, j.id);
  // registered again, by anything: the first stands and nothing more is written
  const again = registerPrediction(storedJob(j.id)!, null, Date.now());
  assert.equal(again.id, rows[0].id);
  assert.equal(predicted(j.id).length, 1);
  assert.equal(tableRows().length, 1);
  assert.equal(tableRows()[0].id, rows[0].id);

  const h = proposeHarnessJob(putRepo());
  const harness = predicted(h.id);
  assert.equal(harness.length, 1);
  assert.equal(harness[0].kind, 'propose:harness');
  // proposed again for the same repo: the key rule returns the same job, and no second prediction
  proposeHarnessJob(putRepo());
  assert.equal(predicted(h.id).length, 1);
});

test('with no master the prediction abstains with the reason', () => {
  const j = propose();
  const [row] = predicted(j.id);
  assert.equal(row.p, null);
  assert.equal(row.version, null);
  assert.match(String(row.reason), /no master/);
  // the inputs are written down all the same, so the decision can carry them to the master's rows
  assert.ok(row.inputs && typeof row.inputs === 'object');
  assert.deepEqual(Object.keys(row.inputs as object).sort(), ['appraiser', 'durability', 'router', 'taste', 'triage']);
});

test('a trusted master predicts, with its version and the inputs it read', () => {
  installNet(constant('master', 3, 0.93));
  installNet(constant('triage', 1, 0.6));
  const j = propose();
  const [row] = predicted(j.id);
  assert.ok(Math.abs((row.p as number) - 0.93) < 1e-9);
  assert.equal(row.version, 3);
  assert.equal(row.reason, null);
  const inputs = row.inputs as Record<string, number | null>;
  assert.ok(Math.abs((inputs.triage as number) - 0.6) < 1e-9);
  assert.equal(inputs.appraiser, null, 'a proposal has no bid to appraise');
  // the table row is the Prediction itself, which replay rebuilds
  const t = tableRows()[0];
  assert.deepEqual(JSON.parse(t.json), { id: row.id, key: row.key, kind: 'propose:readme-gap', repo: FULL, jobId: j.id, p: row.p, version: 3, reason: null, at: row.at });
});

test('an untrusted master abstains and says so', () => {
  installNet(constant('master', 2, 0.9), { trusted: false });
  const [row] = predicted(propose().id);
  assert.equal(row.p, null);
  assert.match(String(row.reason), /v2 does not beat its baseline/);
});

test('with the school off it abstains with "the school is off"', () => {
  installNet(constant('master', 3, 0.93));
  school(false);
  const [row] = predicted(propose().id);
  assert.equal(row.p, null);
  assert.equal(row.reason, 'the school is off');
  assert.equal(predict('master', { kind: 'propose:readme-gap' }), null);
  // predict reads the switch on every call
  school(true);
  assert.ok(predict('master', { kind: 'propose:readme-gap' }));
});

test('a master 9 days old abstains', () => {
  const now = Date.now();
  installNet(constant('master', 4, 0.93), { at: new Date(now - 9 * DAY).toISOString() });
  const j = propose();
  const [row] = predicted(j.id);
  assert.equal(row.p, null);
  assert.match(String(row.reason), /9 days old/);
  // one 7 days old still answers
  installNet(constant('master', 5, 0.93), { at: new Date(now - 7 * DAY).toISOString() });
  const k = propose('Explain the config file');
  const [fresh] = predicted(k.id);
  assert.ok(Math.abs((fresh.p as number) - 0.93) < 1e-9);
});

test('a net that throws makes it abstain', () => {
  // an input net that gives no number: the master abstains, naming it
  installNet(constant('master', 3, 0.93));
  installNet(broken('triage', 1));
  assert.equal(predict('triage', { kind: 'proposal', tier: 'low' }), null);
  const j = propose();
  const [row] = predicted(j.id);
  assert.equal(row.p, null);
  assert.match(String(row.reason), /triage/);
  assert.throws(() => masterInputs(storedJob(j.id)!, null, Date.now()), /triage/);
  // the master itself broken: abstains too, and the job was still proposed
  installNet(constant('triage', 2, 0.5));
  installNet(broken('master', 4));
  const k = propose('Explain the config file');
  assert.equal(storedJob(k.id)?.status, 'proposed');
  const [own] = predicted(k.id);
  assert.equal(own.p, null);
  assert.match(String(own.reason), /master/);
});

test('predict answers only from a current, trusted net', () => {
  assert.equal(predict('triage', { kind: 'proposal' }), null, 'no net');
  installNet(constant('triage', 1, 0.7), { trusted: false });
  assert.equal(predict('triage', { kind: 'proposal' }), null, 'not trusted');
  installNet(constant('triage', 2, 0.7));
  const got = predict('triage', { kind: 'proposal' });
  assert.ok(got && Math.abs(got.p - 0.7) < 1e-9 && got.version === 2);
});

test('distillation asks the real master, with the job\'s own inputs', () => {
  // a finished brief day with 40 items, two of them proposals
  const p = propose();
  record('brief.opened', { day: '2026-11-10', since: '2026-11-09T06:40:00.000Z', items: [`proposal:${p.id}`, ...Array.from({ length: 39 }, (_, i) => `halt:acme/r${i}`)], at: '2026-11-10T06:40:00.000Z' });
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  // the master reads whether the triage input is there: about 0.27 without it, 0.66 with it
  installNet(netOf('master', 1, [{ w: { has_triage: 1 }, head: 2 }], -1));
  const soft = () => rowsFor('triage', now).filter((r) => r.source === 'distilled');
  const without = soft();
  assert.equal(without.length, 1);
  assert.ok(Math.abs(without[0].y - 1 / (1 + Math.exp(1))) < 1e-9);
  installNet(constant('triage', 1, 0.5));
  const withTriage = soft();
  assert.equal(withTriage.length, 1);
  assert.ok(withTriage[0].y > 0.6, `the master saw the triage input: ${withTriage[0].y}`);
  // with the school off the master teaches nothing
  school(false);
  assert.equal(soft().length, 0);
});

test("a job's page shows the trusted nets and the master's guess, and only the guess with the school off", () => {
  addAgent('w1', 'quickset', 'claude:sonnet');
  addAgent('w2', 'meridian', 'claude:sonnet', { bidsOn: ['high'] });
  installNet(constant('router', 1, 0.7));
  installNet(constant('master', 2, 0.9));
  const j = propose();
  const s = jobSchool(storedJob(j.id)!);
  assert.deepEqual(s.router.map((r) => r.agentId), ['w1'], 'only an agent that bids on its tier');
  assert.ok(Math.abs(s.router[0].p - 0.7) < 1e-9);
  assert.equal(s.appraisal, null, 'nothing awarded');
  assert.equal(s.durability, null, 'no run');
  assert.equal(s.master?.jobId, j.id);
  assert.ok(Math.abs((s.master?.p as number) - 0.9) < 1e-9);
  school(false);
  const off = jobSchool(storedJob(j.id)!);
  assert.deepEqual(off.router, []);
  assert.equal(off.master?.id, s.master?.id);
});
