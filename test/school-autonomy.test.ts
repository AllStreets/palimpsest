/**
 * Asks, grants, suspension, revocation and mayAct (Phase 4 Task 16, rulings
 * 17 to 19). Temp home, a fake gh for the PR state, a local bare repo as
 * the stand-in for GitHub where a revert is needed. mayAct fails closed on
 * every doubt, and every refusal is a sentence he reads.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { actOn, briefData } from '../engine/brief.js';
import { openDb } from '../engine/db.js';
import { emit } from '../engine/events.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { entries, query, record } from '../engine/ledger.js';
import { grantKey, replay, verifyReplay } from '../engine/market/replay.js';
import { repoTowerId } from '../engine/market/ship.js';
import { mirrorDir } from '../engine/mirror.js';
import { getRepo, layEarnedFloor } from '../engine/repos.js';
import { askDue, BEAGLE_REPO, decline, grant, grantOf, grants, mayAct, noteActed, noteActResult, revoke, revokeOnRevert, suspend } from '../engine/school/autonomy.js';
import { installDecisions, registerPrediction } from '../engine/school/decisions.js';
import { startSchool } from '../engine/school/tick.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import { AGREE } from '../shared/school-rules.js';
import type { Floor, Inspection, Job, Repo, RepoChecks, Run, WorkKind } from '../shared/types.js';
import { checks, FULL, git, setUp, tearDown, tempDir } from './guild-fixtures.js';
import { agreedDecisions, constant, installNet, storeJobRow, storeRunRow } from './school-fixtures.js';

const OTHER = 'acme/gadgets';
const DAY = 24 * 60 * 60_000;
/** 12 November 2026, 03:00 local. */
const T0 = new Date(2026, 10, 12, 3, 0).getTime();
const HEAD = 'b'.repeat(40);

let clock = T0;
let stop: (() => void) | null = null;
/** What the fake gh answers to `pr view <n>`. */
let prStates: Map<number, { state: string; headRefOid: string | null }>;

const fakeGh: Runner = async (cmd, args, opts) => {
  if (cmd === 'gh') {
    if (args[0] === 'pr' && args[1] === 'view') {
      const s = prStates.get(Number(args[2])) ?? { state: 'OPEN', headRefOid: HEAD };
      return { stdout: JSON.stringify({ ...s, mergedAt: null, mergeCommit: null, closedAt: null, baseRefName: 'main' }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  return realRunner(cmd, args, opts);
};

beforeEach(() => {
  setUp('school-autonomy');
  clock = T0;
  prStates = new Map();
  setRunner(fakeGh);
  putRepo(FULL);
  school(true);
  installNet(constant('master', 2, 0.95), { at: new Date(T0 - DAY).toISOString() });
  stop = installDecisions({ now: () => clock });
});
afterEach(async () => {
  stop?.();
  stop = null;
  setRunner(realRunner);
  await tearDown();
});

function school(on: boolean): void {
  patchSettings({ school: { ...getSettings().school, enabled: on } });
}

function putRepo(fullName: string, over: Partial<Repo> = {}, c: Partial<RepoChecks> = {}): Repo {
  const repo: Repo = {
    fullName,
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
    checks: checks({ test: 'npm test', build: 'npm run build', ...c }),
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

function patchRepo(fullName: string, over: Partial<Repo>): void {
  const r = getRepo(fullName)!;
  openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...r, ...over }), fullName);
}

/** `kind` eligible, with `repo` passing its test: 50 agreed decisions there. */
function eligible(kind: WorkKind, repo = FULL): void {
  clock = agreedDecisions(kind, repo, AGREE.window, clock);
}

/** The pair asked and granted by him. */
function granted(kind: WorkKind, repo = FULL): void {
  eligible(kind, repo);
  const asked = askDue(clock);
  assert.ok(asked.some((g) => g.kind === kind && g.repo === repo), `${kind} on ${repo} was asked`);
  grant(kind, repo, clock);
  assert.equal(grantOf(kind, repo)?.state, 'granted');
}

type Row = Record<string, unknown> & { id: number };
const ledger = (kind: Parameters<typeof query>[0]['kind']): Row[] => query({ kind }).map((e) => ({ ...(e.data as Record<string, unknown>), id: e.id }));
const later = (ms = 60_000) => {
  clock += ms;
};

function inspectionOf(r: Run, over: Partial<Inspection> = {}): Inspection {
  const i: Inspection = {
    id: `insp-${r.id}`,
    runId: r.id,
    jobId: r.jobId,
    repo: r.repo,
    reviewerAgentId: null,
    reviewerFirmId: null,
    checks: [],
    passed: true,
    pushable: true,
    design: null,
    cost: 1,
    at: new Date(clock).toISOString(),
    ...over,
  };
  record('inspection.done', { runId: r.id, jobId: r.jobId, repo: r.repo, inspectionId: i.id, passed: i.passed, inspection: i });
  return i;
}

/** A city PR of `tier` waiting on him on `repo`, inspected, its guess written down at `clock`. */
function waitingPR(id: string, o: { tier?: Job['tier']; repo?: string; inspection?: Partial<Inspection> | null; predict?: boolean } = {}): { job: Job; run: Run } {
  const repo = o.repo ?? FULL;
  const job = storeJobRow(`job-${id}`, { repo, tier: o.tier ?? 'normal', status: 'waiting', runId: `run-${id}` });
  const run = storeRunRow(`run-${id}`, job.id, repo);
  const insp = o.inspection === null ? null : inspectionOf(run, o.inspection ?? {});
  if (o.predict !== false) registerPrediction(job, run, clock, insp);
  later();
  return { job, run };
}

/** A proposal waiting on him, its guess written down. */
function proposal(id: string, repo = FULL): Job {
  const job = storeJobRow(`job-${id}`, { repo, source: 'proposal', status: 'proposed', tier: 'low' });
  registerPrediction(job, null, clock);
  later();
  return job;
}

/** A merged city PR on `repo` with a lit floor, as the revert watch reads it. */
function litFloor(id: string, mergeSha: string, repo = FULL): { job: Job; run: Run; floor: Floor } {
  const job = storeJobRow(`job-${id}`, { repo, status: 'merged', runId: `run-${id}`, floorId: `floor-${id}`, title: `Add the ${id} widget` });
  const run = storeRunRow(`run-${id}`, job.id, repo, { stage: 'waiting', outcome: 'merged', endedAt: new Date(clock).toISOString(), prNumber: 12, mergeSha });
  const floor = layEarnedFloor(repoTowerId(repo), {
    id: `floor-${id}`,
    repo,
    kind: 'pr',
    refs: [],
    title: job.title,
    at: new Date(clock).toISOString(),
    era: 'glass',
    size: 'small',
    lines: 1,
    claude: false,
    founding: false,
    url: null,
    earned: { jobId: job.id, runId: run.id, agentId: 'w1', firmId: 'quickset', state: 'lit', reverted: false },
  });
  return { job, run, floor };
}

/** The stand-in for GitHub: a bare remote with one commit, mirrored under the home; his clone to push from. */
function remoteRepo(): { remote: string; w: string } {
  const work = join(tempDir, 'origin-work');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'widgets\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  const remote = join(tempDir, 'github', 'acme__widgets.git');
  mkdirSync(join(tempDir, 'github'), { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', work, remote);
  mkdirSync(paths().mirrors, { recursive: true });
  git(tempDir, 'clone', '-q', '--bare', remote, mirrorDir(FULL));
  const w = join(tempDir, 'his-clone');
  git(tempDir, 'clone', '-q', remote, w);
  return { remote, w };
}

/** A commit in his clone pushed to main. */
function commitOn(w: string, file: string, message: string): string {
  writeFileSync(join(w, file), `${message}\n`);
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', message);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  return git(w, 'rev-parse', 'HEAD');
}

// ---------------------------------------------------------------- asks (ruling 17)

test('an eligible kind with a trusted master asks once', () => {
  assert.deepEqual(askDue(clock), [], 'nothing is eligible yet');
  eligible('propose:readme-gap');
  const asked = askDue(clock);
  assert.equal(asked.length, 1);
  const [g] = asked;
  assert.equal(g.kind, 'propose:readme-gap');
  assert.equal(g.repo, FULL);
  assert.equal(g.state, 'asked');
  assert.equal(g.by, 'school');
  assert.ok(g.rate && g.rate.value >= AGREE.rate);
  assert.equal(g.quietUntil, null);
  assert.equal(g.acted, 0);
  // once: the open ask is not asked again, and the other kinds are not eligible
  assert.deepEqual(askDue(clock + DAY), []);
  assert.deepEqual(grants(), [g]);
  const rows = ledger('autonomy.asked');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].grant, g);
  assert.equal(rows[0].kind, g.kind);
  assert.equal(rows[0].repo, g.repo);
  // an untrusted master asks nothing
  openDb().exec('DELETE FROM grants');
  openDb().exec("DELETE FROM ledger WHERE kind = 'autonomy.asked'");
  installNet(constant('master', 3, 0.95), { trusted: false });
  assert.deepEqual(askDue(clock), []);
});

test('the school tick asks, and not when the school is off', async () => {
  eligible('propose:readme-gap');
  const s = startSchool({ gate: async () => ({ kind: 'light', ok: false, reason: 'on battery', power: 'battery', powerMode: 0, idleMin: 0, inWindow: false, trainNowUntil: null, freeGB: 100, thermal: 'nominal' }) });
  try {
    const r = await s.tick(clock);
    assert.equal(r.reason, 'on battery', 'the ask does not wait on the training gate');
    assert.equal(r.asked.length, 1);
    assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'asked');
    openDb().exec('DELETE FROM grants');
    school(false);
    const off = await s.tick(clock);
    assert.equal(off.reason, 'the school is off');
    assert.deepEqual(off.asked, []);
    assert.equal(grantOf('propose:readme-gap', FULL), null);
  } finally {
    s.stop();
  }
});

test('a declined pair is silent 30 days', () => {
  eligible('propose:readme-gap');
  askDue(clock);
  later();
  const g = decline('propose:readme-gap', FULL, clock);
  assert.equal(g.state, 'declined');
  assert.equal(g.by, 'him');
  assert.equal(g.quietUntil, new Date(clock + AGREE.quietDays * DAY).toISOString());
  assert.equal(ledger('autonomy.declined').length, 1);
  assert.deepEqual(askDue(clock + 29 * DAY), []);
  // a master of that day, so the only thing between the pair and an ask is the silence
  installNet(constant('master', 3, 0.95), { at: new Date(clock + AGREE.quietDays * DAY).toISOString() });
  assert.deepEqual(askDue(clock + AGREE.quietDays * DAY - 1), []);
  const again = askDue(clock + AGREE.quietDays * DAY + 1);
  assert.equal(again.length, 1);
  assert.equal(again[0].state, 'asked');
  // declining a pair that was not asked is refused
  assert.throws(() => decline('merge:low', FULL, clock), /was not asked/);
});

test('a pair he revoked is silent 30 days and he can re-grant it from Settings', () => {
  granted('propose:readme-gap');
  later();
  const g = revoke('propose:readme-gap', FULL, 'him', undefined, clock);
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'him');
  assert.equal(g.quietUntil, new Date(clock + AGREE.quietDays * DAY).toISOString());
  const [row] = ledger('autonomy.revoked');
  assert.equal(row.by, 'him');
  assert.equal(row.jobId, null);
  assert.deepEqual(askDue(clock + 10 * DAY), []);
  // not from an ask: there is none
  assert.throws(() => grant('propose:readme-gap', FULL, clock), /not asked/);
  const back = grant('propose:readme-gap', FULL, clock + DAY, { fromSettings: true });
  assert.equal(back.state, 'granted');
  assert.equal(back.by, 'him');
  assert.equal(back.quietUntil, null);
  const [, second] = ledger('autonomy.granted');
  assert.equal(second.fromSettings, true);
  // a pair never asked cannot be granted from Settings either
  assert.throws(() => grant('merge:low', FULL, clock, { fromSettings: true }), /never been asked/);
});

test('a repo without a build command and AllStreets/beagle are never asked', () => {
  putRepo(OTHER, {}, { build: null });
  putRepo(BEAGLE_REPO);
  eligible('propose:readme-gap', OTHER);
  eligible('propose:readme-gap', BEAGLE_REPO);
  assert.deepEqual(askDue(clock), [], 'no build, and Beagle');
  // nor a repo with the market off, a halted one, one without a test command, or one not connected
  putRepo(OTHER, { market: false });
  eligible('propose:readme-gap', OTHER);
  assert.deepEqual(askDue(clock), []);
  putRepo(OTHER, { halted: { at: new Date(clock).toISOString(), reason: 'a revert' } });
  assert.deepEqual(askDue(clock), []);
  putRepo(OTHER, {}, { test: null });
  assert.deepEqual(askDue(clock), []);
  putRepo(OTHER, { connected: false });
  assert.deepEqual(askDue(clock), []);
  putRepo(OTHER);
  assert.equal(askDue(clock).length, 1, 'with everything back, it is asked');
  // the pooled window is eligible, but FULL has no rows of its own there
  assert.ok(!askDue(clock).some((g) => g.repo === FULL));
});

test('only grant moves an ask to granted', () => {
  eligible('propose:readme-gap');
  askDue(clock);
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'asked');
  // nothing the school does grants: another tick, a suspension, a revert
  askDue(clock + DAY);
  suspend('propose:readme-gap', FULL, 'a test', clock);
  revokeOnRevert({ jobId: 'job-none', repo: FULL });
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'asked');
  assert.equal(ledger('autonomy.suspended').length, 0, 'a pair not granted is not suspended');
  // Beagle is never granted, even by hand
  assert.throws(() => grant('merge:low', BEAGLE_REPO, clock, { fromSettings: true }), /never granted/);
  const g = grant('propose:readme-gap', FULL, clock);
  assert.equal(g.state, 'granted');
  assert.equal(g.by, 'him');
  assert.deepEqual(grants(), [g]);
  // granting twice is refused
  assert.throws(() => grant('propose:readme-gap', FULL, clock), /already granted/);
});

// ---------------------------------------------------------------- mayAct (ruling 18)

const refused = async (kind: WorkKind, repo: string, jobId: string, reason: string, at = clock) => {
  const r = await mayAct(kind, repo, jobId, at);
  assert.equal(r.ok, false);
  assert.equal(r.reason, reason);
};

test('mayAct refuses with the school off, Beagle even with a grant row written by hand, no grant, revoked and suspended', async () => {
  granted('propose:readme-gap');
  const j = proposal('p');
  school(false);
  await refused('propose:readme-gap', FULL, j.id, 'The school is off.');
  school(true);
  const at = new Date(clock).toISOString();
  openDb()
    .prepare('INSERT INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)')
    .run('merge:low', BEAGLE_REPO, 'granted', at, JSON.stringify({ kind: 'merge:low', repo: BEAGLE_REPO, state: 'granted', at, by: 'him', rate: null, reason: null, acted: 0, quietUntil: null }));
  await refused('merge:low', BEAGLE_REPO, j.id, 'AllStreets/beagle is never acted on while Palimpsest imports it.');
  await refused('merge:low', FULL, j.id, 'There is no grant for merge:low on acme/widgets.');
  eligible('propose:harness');
  askDue(clock);
  await refused('propose:harness', FULL, j.id, 'You have not granted propose:harness on acme/widgets yet.');
  decline('propose:harness', FULL, clock);
  await refused('propose:harness', FULL, j.id, 'You declined propose:harness on acme/widgets.');
  suspend('propose:readme-gap', FULL, 'he undid it', clock);
  await refused('propose:readme-gap', FULL, j.id, 'The grant for propose:readme-gap on acme/widgets is suspended: he undid it.');
  grant('propose:readme-gap', FULL, clock, { fromSettings: true });
  revoke('propose:readme-gap', FULL, 'him', undefined, clock);
  await refused('propose:readme-gap', FULL, j.id, 'The grant for propose:readme-gap on acme/widgets was revoked by you.');
  grant('propose:readme-gap', FULL, clock, { fromSettings: true });
  revoke('propose:readme-gap', FULL, 'revert', 'job-x', clock);
  await refused('propose:readme-gap', FULL, j.id, 'The grant for propose:readme-gap on acme/widgets was revoked after a revert.');
});

test('mayAct refuses the stop file, a halted repo, the market off, no build and no test', async () => {
  granted('propose:readme-gap');
  const j = proposal('p');
  writeFileSync(paths().stop, '');
  await refused('propose:readme-gap', FULL, j.id, 'The stop file is set.');
  const { rmSync } = await import('node:fs');
  rmSync(paths().stop);
  patchRepo(FULL, { halted: { at: new Date(clock).toISOString(), reason: 'A city merge was reverted' } });
  await refused('propose:readme-gap', FULL, j.id, 'acme/widgets is halted: A city merge was reverted.');
  patchRepo(FULL, { halted: null, market: false });
  await refused('propose:readme-gap', FULL, j.id, 'The market on acme/widgets is off.');
  patchRepo(FULL, { market: true, checks: checks({ test: 'npm test', build: null }) });
  await refused('propose:readme-gap', FULL, j.id, 'acme/widgets has no build command.');
  patchRepo(FULL, { checks: checks({ test: null, build: 'npm run build' }) });
  await refused('propose:readme-gap', FULL, j.id, 'acme/widgets has no test command.');
  patchRepo(FULL, { checks: checks({ test: 'npm test', build: 'npm run build' }), connected: false });
  await refused('propose:readme-gap', FULL, j.id, 'acme/widgets is not connected.');
  // a repo that was never connected has no grant either, and the grant is read first
  await refused('propose:readme-gap', 'acme/nothing', j.id, 'There is no grant for propose:readme-gap on acme/nothing.');
});

test('mayAct suspends when the window is no longer eligible or the repo test fails, and the pair is asked afresh', async () => {
  granted('propose:readme-gap');
  const j = proposal('p');
  // three of his dismissals against the master's 0.95 on another repo: the pooled rate falls under 0.95
  putRepo(OTHER);
  for (let i = 0; i < 3; i++) {
    const k = storeJobRow(`dis-${i}`, { repo: OTHER, source: 'proposal', status: 'proposed' });
    registerPrediction(k, null, clock);
    later();
    const { resolve } = await import('../engine/school/decisions.js');
    resolve(k, 'dismiss', clock);
    later();
  }
  await refused('propose:readme-gap', FULL, j.id, 'The master agreed with you on 47 of the last 50 propose:readme-gap decisions; autonomy needs 50 at 95%.');
  const g = grantOf('propose:readme-gap', FULL)!;
  assert.equal(g.state, 'suspended');
  assert.equal(g.by, 'school');
  assert.equal(g.reason, 'The master agreed with you on 47 of the last 50 propose:readme-gap decisions; autonomy needs 50 at 95%.');
  assert.equal(ledger('autonomy.suspended').length, 1);
  // once eligible again, and with the repo still passing, the tick asks again: a suspension is no silence
  eligible('propose:readme-gap');
  assert.equal(askDue(clock).length, 1);
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'asked');
  grant('propose:readme-gap', FULL, clock);
  // the repo test: one of his dismissals on FULL itself, with enough agreed rows elsewhere to keep the window eligible
  eligible('propose:readme-gap', OTHER);
  const k = storeJobRow('dis-full', { repo: FULL, source: 'proposal', status: 'proposed' });
  registerPrediction(k, null, clock);
  later();
  const { resolve } = await import('../engine/school/decisions.js');
  resolve(k, 'dismiss', clock);
  later();
  await refused('propose:readme-gap', FULL, j.id, 'acme/widgets no longer passes its own test on propose:readme-gap: the master must have agreed with you on its last 10 decisions there, with at least 10 on record.');
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'suspended');
  assert.equal(ledger('autonomy.suspended').length, 2);
  // a skewed master refuses too, without a suspension
  grant('propose:readme-gap', FULL, clock, { fromSettings: true });
  eligible('propose:readme-gap');
  assert.equal((await mayAct('propose:readme-gap', FULL, j.id, clock)).ok, true, 'sanity: it would act now');
  openDb().prepare("UPDATE ledger SET json = json_set(json, '$.skewed', json('[\"propose:readme-gap\"]')) WHERE kind = 'net.trained' AND json_extract(json, '$.version.net') = 'master'").run();
  await refused('propose:readme-gap', FULL, j.id, 'The master is skewed on propose:readme-gap.');
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'granted');
});

test('mayAct refuses with the master missing, untrusted or old, no prediction, 0.89, and a guess from a replaced master 9 days old', async () => {
  granted('propose:readme-gap');
  const j = proposal('p');
  const key = `propose:readme-gap:${j.id}`;
  // missing: nothing promoted
  openDb().prepare("DELETE FROM ledger WHERE kind = 'net.promoted'").run();
  await refused('propose:readme-gap', FULL, j.id, 'There is no master yet.');
  installNet(constant('master', 3, 0.95), { trusted: false });
  await refused('propose:readme-gap', FULL, j.id, 'The master v3 does not beat its baseline.');
  installNet(constant('master', 4, 0.95), { at: new Date(clock - 9 * DAY).toISOString() });
  await refused('propose:readme-gap', FULL, j.id, 'The master v4 is 9 days old.');
  installNet(constant('master', 5, 0.95), { at: new Date(clock).toISOString() });
  // no guess
  const k = storeJobRow('job-noguess', { repo: FULL, source: 'proposal', status: 'proposed' });
  await refused('propose:readme-gap', FULL, k.id, 'The master made no guess on propose:readme-gap:job-noguess.');
  // an abstention
  school(false);
  const a = proposal('abstain');
  school(true);
  await refused('propose:readme-gap', FULL, a.id, 'The master abstained on propose:readme-gap:job-abstain: the school is off.');
  // 0.89
  installNet(constant('master', 6, 0.89), { at: new Date(clock).toISOString() });
  const low = proposal('low');
  await refused('propose:readme-gap', FULL, low.id, 'The master\'s guess on propose:readme-gap:job-low is 0.89, under 0.9.');
  // the guess from v5 (0.95) at `key` is fine while v5 is current ...
  installNet(constant('master', 5, 0.95), { at: new Date(clock).toISOString() });
  const pred = query({ kind: 'master.predicted' }).find((e) => (e.data as { key: string }).key === key)!;
  assert.equal((pred.data as { version: number }).version, 2);
  // ... the guess on j came from v2, trained a day before T0: replaced, and 10 days old by now
  const at = clock + 9 * DAY;
  installNet(constant('master', 7, 0.95), { at: new Date(at).toISOString() });
  await refused('propose:readme-gap', FULL, j.id, `The master's guess on ${key} came from v2, which is ${Math.floor((at - (T0 - DAY)) / DAY)} days old and no longer current.`, at);
  // a replaced guess younger than 8 days still counts
  const fresh = proposal('fresh');
  installNet(constant('master', 8, 0.95), { at: new Date(clock).toISOString() });
  assert.equal((await mayAct('propose:readme-gap', FULL, fresh.id, clock)).ok, true);
});

test('mayAct refuses a merge not passed, not pushable, a closed PR, a moved head and a failed revert read', async () => {
  granted('merge:normal');
  const notPassed = waitingPR('np', { inspection: { passed: false } });
  await refused('merge:normal', FULL, notPassed.job.id, 'The inspection of run-np did not pass.');
  const notPushable = waitingPR('npu', { inspection: { pushable: false } });
  await refused('merge:normal', FULL, notPushable.job.id, 'The inspection of run-npu is not pushable.');
  const none = waitingPR('ni', { inspection: null });
  await refused('merge:normal', FULL, none.job.id, 'No inspection of run-ni is on record.');
  const a = waitingPR('a');
  prStates.set(9, { state: 'CLOSED', headRefOid: HEAD });
  await refused('merge:normal', FULL, a.job.id, 'PR #9 on acme/widgets is closed.');
  prStates.set(9, { state: 'MERGED', headRefOid: HEAD });
  await refused('merge:normal', FULL, a.job.id, 'PR #9 on acme/widgets is merged.');
  prStates.set(9, { state: 'OPEN', headRefOid: 'c'.repeat(40) });
  await refused('merge:normal', FULL, a.job.id, 'The head of PR #9 on acme/widgets moved: it is ccccccc, not the inspected bbbbbbb.');
  prStates.set(9, { state: 'OPEN', headRefOid: null });
  await refused('merge:normal', FULL, a.job.id, 'The head of PR #9 on acme/widgets moved: it is unknown, not the inspected bbbbbbb.');
  prStates.set(9, { state: 'OPEN', headRefOid: HEAD });
  // a lit floor makes the revert read real; with no mirror and no gh it fails, and a failed read refuses
  litFloor('m', 'd'.repeat(40));
  const r = await mayAct('merge:normal', FULL, a.job.id, clock);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^The revert read of acme\/widgets failed: /);
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted', 'a failed read revokes nothing');
  // a propose grant does not cover a merge, and a job that is not a proposal is refused under one
  await refused('propose:readme-gap', FULL, a.job.id, 'There is no grant for propose:readme-gap on acme/widgets.');
  granted('propose:readme-gap');
  await refused('propose:readme-gap', FULL, a.job.id, 'job-a is not a proposal waiting on you.');
  // and a merge grant does not reach a job with no PR waiting
  const p = proposal('p');
  await refused('merge:normal', FULL, p.id, 'job-p has no PR waiting on you.');
  // the kind must match the PR: a low-tier PR is not merge:normal
  const low = waitingPR('low', { tier: 'low' });
  await refused('merge:normal', FULL, low.job.id, 'job-low is merge:low work, not merge:normal.');
});

test('a revert pushed a minute before is found by mayAct\'s own read, which revokes and refuses', async () => {
  const { w } = remoteRepo();
  granted('merge:normal');
  const mergeSha = commitOn(w, 'widgets.md', 'Add the m widget');
  const m = litFloor('m', mergeSha);
  noteActed('merge:normal', FULL, m.job.id, clock);
  const b = waitingPR('b');
  // sanity: before the revert, it may act
  assert.deepEqual(await mayAct('merge:normal', FULL, b.job.id, clock), { ok: true, reason: null });
  git(w, 'revert', '--no-edit', mergeSha);
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  later();
  const r = await mayAct('merge:normal', FULL, b.job.id, clock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'A city merge on acme/widgets was reverted: Add the m widget.');
  assert.equal(query({ kind: 'merge.reverted' }).length, 1, 'found by the forced read inside the throttle');
  const g = grantOf('merge:normal', FULL)!;
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'revert');
  assert.equal(g.quietUntil, new Date(clock + AGREE.quietDays * DAY).toISOString());
  const rows = ledger('autonomy.revoked');
  assert.equal(rows.length, 1, 'revoked once, by the handler before the halt');
  assert.equal(rows[0].by, 'revert');
  assert.equal(rows[0].jobId, m.job.id);
  assert.ok(getRepo(FULL)?.halted, 'the repo halts after');
  // and it stays refused
  await refused('merge:normal', FULL, b.job.id, 'The grant for merge:normal on acme/widgets was revoked after a revert.');
});

test('mayAct answers ok when every condition holds, and could not check on a throw', async () => {
  granted('merge:normal');
  const a = waitingPR('a');
  assert.deepEqual(await mayAct('merge:normal', FULL, a.job.id, clock), { ok: true, reason: null });
  granted('propose:readme-gap');
  const p = proposal('p');
  assert.deepEqual(await mayAct('propose:readme-gap', FULL, p.id, clock), { ok: true, reason: null });
  // a grant row that cannot be read
  openDb().prepare('UPDATE grants SET json = ? WHERE kind = ?').run('{not json', 'merge:normal');
  const r = await mayAct('merge:normal', FULL, a.job.id, clock);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^could not check: /);
  // a gh that throws
  openDb().prepare('DELETE FROM grants WHERE kind = ?').run('merge:normal');
  granted('merge:low');
  const low = waitingPR('low', { tier: 'low' });
  setRunner(async (cmd, args, opts) => (cmd === 'gh' ? Promise.reject(new Error('gh fell over')) : fakeGh(cmd, args, opts)));
  const t = await mayAct('merge:low', FULL, low.job.id, clock);
  assert.equal(t.ok, false);
  assert.match(t.reason!, /^could not check: .*gh fell over/);
});

// ---------------------------------------------------------------- revocation by revert (ruling 19)

test('revokeOnRevert revokes an autonomous job\'s grant', () => {
  granted('merge:normal');
  const m = litFloor('m', 'd'.repeat(40));
  noteActed('merge:normal', FULL, m.job.id, clock);
  noteActResult('merge:normal', FULL, m.job.id, { ok: true, reason: null }, clock);
  const data = { jobId: m.job.id, runId: m.run.id, repo: FULL, floorId: m.floor.id, mergeSha: 'd'.repeat(40), revertSha: 'e'.repeat(40), at: new Date(clock).toISOString() };
  // heard on the bus, through the decisions handler
  emit('merge.reverted', data);
  const g = grantOf('merge:normal', FULL)!;
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'revert');
  const rows = ledger('autonomy.revoked');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].by, 'revert');
  assert.equal(rows[0].jobId, m.job.id);
  assert.deepEqual(rows[0].grant, g);
  // heard again, or called directly: nothing more
  emit('merge.reverted', data);
  revokeOnRevert(data);
  assert.equal(ledger('autonomy.revoked').length, 1);
  // the pair is the acted row's, not the revert's repo: an act recorded under another repo revokes that pair
  granted('merge:low', FULL);
  putRepo(OTHER);
  const o = litFloor('o', 'f'.repeat(40), OTHER);
  record('autonomy.acted', { kind: 'merge:low', repo: FULL, jobId: o.job.id, key: `merge:low:${o.job.id}`, at: new Date(clock).toISOString() });
  revokeOnRevert({ ...data, jobId: o.job.id, repo: OTHER });
  assert.equal(grantOf('merge:low', FULL)?.state, 'revoked');
});

test('a revert of a job the city did not act on revokes nothing', () => {
  granted('merge:normal');
  const m = litFloor('m', 'd'.repeat(40));
  const data = { jobId: m.job.id, runId: m.run.id, repo: FULL, floorId: m.floor.id, mergeSha: 'd'.repeat(40), revertSha: 'e'.repeat(40), at: new Date(clock).toISOString() };
  emit('merge.reverted', data);
  revokeOnRevert(data);
  revokeOnRevert({});
  assert.equal(grantOf('merge:normal', FULL)?.state, 'granted');
  assert.deepEqual(ledger('autonomy.revoked'), []);
});

// ---------------------------------------------------------------- the brief and replay

test('the brief carries the ask and an acted item with revoke', () => {
  eligible('merge:low');
  askDue(clock);
  let b = briefData(clock);
  const ask = b.sections.waiting.find((i) => i.kind === 'autonomy')!;
  assert.ok(ask, 'the ask waits on him');
  assert.equal(ask.id, `autonomy:merge:low:${FULL}`);
  assert.equal(ask.repo, FULL);
  assert.deepEqual(ask.actions, ['grant', 'decline', 'why']);
  assert.match(ask.title, /merge/);
  assert.match(ask.text, /50 of the last 50/);
  assert.ok(b.due);
  const did = actOn(ask.id, 'grant', {}, clock);
  assert.equal(grantOf('merge:low', FULL)?.state, 'granted');
  assert.deepEqual(did.item.actions, ['why']);
  const taughtRows = query({ kind: 'brief.action' }).map((e) => e.data as { action: string; taught: boolean });
  assert.deepEqual(taughtRows.at(-1), { ...taughtRows.at(-1), action: 'grant', taught: true });
  // the line stays in the window with his answer on it
  b = briefData(clock + 60_000);
  const answered = b.sections.waiting.find((i) => i.id === ask.id)!;
  assert.equal(answered.acted?.action, 'grant');
  assert.deepEqual(answered.actions, ['why']);
  // the city acts (Task 17 writes these rows): the act is news from the night, with revoke
  const low = waitingPR('low', { tier: 'low' });
  later();
  noteActed('merge:low', FULL, low.job.id, clock);
  noteActResult('merge:low', FULL, low.job.id, { ok: true, reason: null }, clock + 1000);
  assert.equal(grantOf('merge:low', FULL)?.acted, 1);
  b = briefData(clock + 60_000);
  const acted = b.sections.overnight.filter((i) => i.kind === 'acted');
  assert.equal(acted.length, 1, 'one line per act, not one per row');
  assert.equal(acted[0].repo, FULL);
  assert.equal(acted[0].refs.jobId, low.job.id);
  assert.match(acted[0].text, /on its own/);
  assert.deepEqual(acted[0].actions, ['revoke', 'why']);
  const r = actOn(acted[0].id, 'revoke', {}, clock + 120_000);
  assert.deepEqual(r.item.actions, ['why']);
  const g = grantOf('merge:low', FULL)!;
  assert.equal(g.state, 'revoked');
  assert.equal(g.by, 'him');
  assert.equal(ledger('autonomy.revoked')[0].jobId, low.job.id);
  const last = query({ kind: 'brief.action' }).at(-1)!.data as { action: string; taught: boolean };
  assert.deepEqual([last.action, last.taught], ['revoke', true]);
  // once revoked the line offers no revoke, and a declined ask is taught
  b = briefData(clock + 180_000);
  assert.deepEqual(b.sections.overnight.find((i) => i.kind === 'acted')?.actions, ['why']);
  eligible('propose:readme-gap');
  askDue(clock + 180_000);
  const d = actOn(`autonomy:propose:readme-gap:${FULL}`, 'decline', {}, clock + 180_000);
  assert.equal(grantOf('propose:readme-gap', FULL)?.state, 'declined');
  assert.deepEqual(d.item.actions, ['why']);
  assert.equal((query({ kind: 'brief.action' }).at(-1)!.data as { taught: boolean }).taught, true);
});

test('replay rebuilds grants', () => {
  granted('merge:normal');
  granted('propose:readme-gap');
  const a = waitingPR('a');
  noteActed('merge:normal', FULL, a.job.id, clock);
  noteActResult('merge:normal', FULL, a.job.id, { ok: false, reason: 'the PR closed' }, clock);
  suspend('merge:normal', FULL, 'he undid it', clock);
  revoke('propose:readme-gap', FULL, 'him', undefined, clock);
  eligible('merge:low');
  askDue(clock);
  decline('merge:low', FULL, clock);
  // the jobs and runs here were written straight to their tables, so only the grants are compared
  assert.deepEqual(verifyReplay().diffs.filter((d) => d.startsWith('grant ')), []);
  const replayed = replay(entries()).grants;
  assert.equal(grants().length, 3);
  for (const g of grants()) assert.deepEqual(replayed[grantKey(g.kind, g.repo)], g);
  assert.equal(Object.keys(replayed).length, 3);
  // the acted row Task 15 matches by jobId carries the kind and the repo at the top
  const [before, after] = ledger('autonomy.acted');
  assert.equal(before.kind, 'merge:normal');
  assert.equal(before.repo, FULL);
  assert.equal(before.jobId, a.job.id);
  assert.equal((before.grant as { acted: number }).acted, 1);
  assert.equal(after.kind, 'merge:normal');
  assert.equal(after.grant, undefined);
  assert.deepEqual(after.result, { ok: false, reason: 'the PR closed' });
});
