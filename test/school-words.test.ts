/**
 * The school screen's words (Phase 4 Task 30), kept pure so the tests can
 * read them: a score with its interval and n, a net's line by its standing,
 * the gate, a kind's agreement (and the skewed kind's sentence), the kinds'
 * labels, the LoRA's count, an arena's sealed uses, a voyage's line, a
 * grant's line, a train's line and the base model's download.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Agreement, GateState, Grant, Interval, NetCard, Prediction, TrainState, VoyageView } from '../shared/types.js';
import {
  agreementLine,
  arenaWords,
  baseButton,
  bredLine,
  dailyCreditsText,
  diffText,
  downloadLine,
  gateLine,
  graduatedLine,
  grantLine,
  intervalText,
  kindLabel,
  loraLine,
  lowPowerNote,
  masterGuessLine,
  NET_BIAS,
  netsOnJob,
  netLine,
  netRowLine,
  sealedLine,
  trainedLine,
  trainLine,
  trainNowHeld,
  trainerLine,
  untilLine,
  voyageLine,
} from '../app/src/ui/school-words.js';

const I = (value: number, lo: number, hi: number, n: number): Interval => ({ value, lo, hi, n });
const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();

const noDashes = (s: string): void => assert.ok(!/[—–]|-{2}/.test(s), `no dashes as punctuation: ${s}`);

test('a score reads with its interval and n, by its metric', () => {
  assert.equal(intervalText(I(0.14, 0.1, 0.19, 64), 'brier'), 'Brier 0.14, 95% interval 0.10 to 0.19, on 64 held-out rows');
  assert.equal(intervalText(I(0.31, 0.24, 0.38, 1), 'mae'), 'Error 0.31, 95% interval 0.24 to 0.38, on 1 held-out row');
  assert.equal(intervalText(I(0.92, 0.84, 0.98, 50), 'agreement'), 'Agreement 0.92, 95% interval 0.84 to 0.98, on 50 decisions');
  assert.equal(intervalText(I(0.61, 0.52, 0.7, 15), 'sealed'), 'Score 0.61, 95% interval 0.52 to 0.70, on 15 sealed tasks');
  assert.equal(diffText({ diff: 0.14, lo: 0.06, hi: 0.22 }), '+0.14, 95% interval +0.06 to +0.22');
  assert.equal(diffText({ diff: -0.08, lo: -0.13, hi: -0.02 }), '−0.08, 95% interval −0.13 to −0.02');
});

const card = (over: Partial<NetCard>): NetCard => ({ net: 'durability', status: 'thin', reason: '18 of 40 labels', cause: 'No city merge has had 30 days yet', current: null, history: [], labels: 18, needs: 40, selfSelected: false, ...over });
const version = (over: Partial<NonNullable<NetCard['current']>> = {}): NonNullable<NetCard['current']> => ({
  net: 'appraiser-pass',
  version: 6,
  at: '2026-11-09T02:10:00.000Z',
  rows: { train: 256, heldOut: 64, distilled: 0 },
  metric: 'brier',
  score: I(0.14, 0.1, 0.19, 64),
  baseline: I(0.22, 0.17, 0.27, 64),
  vsBaseline: { diff: -0.08, lo: -0.13, hi: -0.02 },
  agreement: null,
  trusted: true,
  current: true,
  seconds: 41,
  ...over,
});

test('a net says where it stands and why, in one line', () => {
  assert.equal(netLine(card({})), '18 of 40 labels. No city merge has had 30 days yet.');
  assert.equal(netLine(card({ status: 'untrained', reason: 'Enough labels; not trained yet', cause: null, labels: 44 })), 'Enough labels; not trained yet.');
  assert.equal(netLine(card({ status: 'untrained', reason: "v3's weights are missing", cause: null, labels: 44 })), "v3's weights are missing.");
  assert.equal(netLine(card({ net: 'router', status: 'trained', reason: 'v3 does not beat its baseline on held-out rows', cause: null, labels: 77, current: version({ net: 'router', version: 3, trusted: false, score: I(0.21, 0.16, 0.26, 64), vsBaseline: { diff: -0.01, lo: -0.05, hi: 0.03 } }) })), 'v3 does not beat its baseline on held-out rows.');
  assert.equal(netLine(card({ net: 'appraiser-pass', status: 'trusted', reason: null, cause: null, labels: 77, current: version() })), 'Trusted at v6: Brier 0.14, 95% interval 0.10 to 0.19, on 64 held-out rows, against a baseline of 0.22.');
  // A thin card with its counts but no cause from the engine still says its counts.
  assert.equal(netLine(card({ reason: null, cause: null, labels: 3 })), '3 of 40 labels.');
  // A cause that carries the counts itself is said once.
  assert.equal(netLine(card({ cause: '18 of 40 city merges have had 30 days or a revert' })), '18 of 40 city merges have had 30 days or a revert.');
  assert.equal(netLine(card({ net: 'taste', reason: '0 of 40 labels', cause: '0 of 40 labels: 1 UI change inspected', labels: 0 })), '0 of 40 labels: 1 UI change inspected.');
  assert.equal(netLine(card({ net: 'taste', reason: '0 of 40 labels', cause: 'No UI change has been inspected yet', labels: 0 })), '0 of 40 labels. No UI change has been inspected yet.');
  assert.equal(netRowLine(card({ net: 'appraiser-pass', status: 'trusted', reason: null, cause: null, labels: 77, history: [1, 2, 3, 4, 5, 6].map((v) => ({ version: v, at: '2026-11-09T02:10:00.000Z', score: I(0.2, 0.1, 0.3, 10), trusted: v > 2 })), current: version() })), `Trusted at v6, ${new Date('2026-11-09T02:10:00.000Z').getDate()} Nov; 6 versions so far.`);
  assert.equal(netRowLine(card({})), '18 of 40 labels. No city merge has had 30 days yet.');
});

const gate = (over: Partial<GateState>): GateState => ({ kind: 'heavy', ok: true, reason: null, power: 'ac', powerMode: 0, idleMin: 22, inWindow: true, trainNowUntil: null, freeGB: 180, thermal: 'nominal', ...over });

test('the gate says whether training may run, and what it read', () => {
  assert.equal(gateLine(gate({ ok: false, reason: 'on battery', power: 'battery' })), 'Training waits: on battery.');
  assert.equal(gateLine(gate({ powerMode: 1 }), { from: '01:00', to: '06:00' }), 'Training may run: on power in Low Power mode, idle 22 minutes, inside 1:00 to 6:00.');
  assert.equal(gateLine(gate({ idleMin: 1, inWindow: false, trainNowUntil: new Date(2026, 10, 10, 17, 30).toISOString() }), { from: '01:00', to: '06:00' }), 'Training may run: on power, idle 1 minute, on Train now until 17:30.');
  assert.equal(gateLine(gate({ idleMin: null, inWindow: true })), 'Training may run: on power, inside the window.');
  assert.equal(gateLine(gate({ ok: false, reason: 'the Mac has been idle 4 of 20 minutes', idleMin: 4 })), 'Training waits: the Mac has been idle 4 of 20 minutes.');
});

const agreement = (over: Partial<Agreement>): Agreement => ({ kind: 'propose:readme-gap', repo: null, rows: 50, agreed: 48, rate: I(0.96, 0.89, 0.99, 50), eligible: true, repoOk: null, skewed: false, ...over });

test("a kind's agreement carries its count and interval, and a skewed kind says why it may never be offered", () => {
  assert.equal(agreementLine(agreement({})), 'Agreed with you on 48 of the last 50 decisions: 0.96, 95% interval 0.89 to 0.99. Enough for autonomy.');
  assert.equal(agreementLine(agreement({ kind: 'merge:low', agreed: 44, rate: I(0.88, 0.76, 0.95, 50), eligible: false })), 'Agreed with you on 44 of the last 50 decisions: 0.88, 95% interval 0.76 to 0.95. Autonomy needs 50 at 95%.');
  assert.equal(agreementLine(agreement({ kind: 'merge:high', rows: 0, agreed: 0, rate: null, eligible: false })), 'No decision of this kind has had a prediction yet.');
  assert.equal(agreementLine(agreement({ kind: 'merge:ui', rows: 7, agreed: 7, rate: null, eligible: false })), 'Agreed with you on 7 of 7 decisions. Autonomy needs 50 at 95%.');
  assert.equal(agreementLine(agreement({ kind: 'propose:harness', skewed: true })), 'You approve nearly all of these, so the master cannot show it knows better than that; this kind may never be offered.');
});

test('the kinds have plain labels', () => {
  assert.equal(kindLabel('propose:harness'), 'Harness proposals');
  assert.equal(kindLabel('propose:readme-gap'), 'README gap proposals');
  assert.equal(kindLabel('merge:low'), 'Low-tier merges');
  assert.equal(kindLabel('merge:normal'), 'Normal-tier merges');
  assert.equal(kindLabel('merge:high'), 'High-tier merges');
  assert.equal(kindLabel('merge:ui'), 'UI merges');
});

test('the LoRA counts its verified changes against what it needs', () => {
  assert.equal(loraLine({ examples: 11, needs: 100 }), '11 of 100 verified changes');
  assert.equal(loraLine({ examples: 0, needs: 100 }), '0 of 100 verified changes');
  assert.equal(loraLine({ examples: 131, needs: 100 }), '131 verified changes, enough to train (100 needed)');
});

test("an arena's sealed set counts its uses", () => {
  assert.equal(sealedLine({ sealedUses: 3 }), 'sealed set used 3 of 10 times');
  assert.equal(sealedLine({ sealedUses: 0 }), 'sealed set not yet used, 10 uses allowed');
});

const voyage = (over: Partial<VoyageView>): VoyageView => ({
  id: 'v-2026-11-08-abc123',
  arena: 'arena-harbor-ledger-1',
  status: 'sailing',
  generation: 2,
  of: 4,
  runs: { done: 137, of: 480 },
  commissionedBy: null,
  scores: [{ genome: 'g', name: 'Harbour 2.1', generation: 2, mean: 0.5, lo: 0.4, hi: 0.6, parents: [] }],
  promoted: [],
  sealed: null,
  credits: 12,
  startedAt: '2026-11-08T01:00:00.000Z',
  endedAt: null,
  repo: 'tidewater/harbor-ledger',
  ...over,
});

test('a voyage says how far it has sailed, or why it waits, in one line', () => {
  assert.equal(voyageLine(voyage({})), 'Sailing: generation 2 of 4, 137 of 480 runs. A voyage spans several nights.');
  assert.equal(voyageLine(voyage({ status: 'paused', generation: 0, scores: [], runs: { done: 0, of: 480 }, queued: true, commissionedBy: 'quickset', reason: "Commissioned by Quickset; it sails first on the school's next night" })), "Queued. Commissioned by Quickset; it sails first on the school's next night.");
  assert.equal(voyageLine(voyage({ status: 'paused', runs: { done: 60, of: 480 }, reason: 'outside the training window' })), 'Paused at generation 2 of 4, 60 of 480 runs: outside the training window.');
  assert.equal(voyageLine(voyage({ status: 'done', generation: 4, runs: { done: 480, of: 480 }, endedAt: '2026-11-09T04:00:00.000Z', claim: true, champion: { genome: 'g', name: 'Harbour 4.3', model: 'ollama:qwen', generation: 4, parents: [] } })), 'Done after 4 generations and 480 runs. Harbour 4.3 beat every seeded local agent on the sealed tasks.');
  assert.equal(voyageLine(voyage({ status: 'done', generation: 4, runs: { done: 480, of: 480 }, claim: false, champion: { genome: 'g', name: 'Harbour 4.3', model: 'ollama:qwen', generation: 4, parents: [] }, reason: 'The sealed split was spent' })), 'Done after 4 generations and 480 runs. Harbour 4.3 makes no claim: the sealed split was spent.');
  assert.equal(voyageLine(voyage({ status: 'failed', reason: 'The arena is missing' })), 'Failed at generation 2 of 4, 137 of 480 runs: the arena is missing.');
  assert.equal(voyageLine(voyage({ status: 'capped', reason: null })), 'Stopped at the cap at generation 2 of 4, 137 of 480 runs.');
});

const grant = (over: Partial<Grant>): Grant => ({ kind: 'merge:low', repo: 'hoshi/kumo', state: 'granted', at: new Date(2026, 10, 4, 9, 12).toISOString(), by: 'him', rate: I(0.96, 0.89, 0.99, 50), reason: null, acted: 2, quietUntil: null, ...over });

test("a grant's line says its state in the engine's own words", () => {
  assert.equal(grantLine(grant({}), NOW), 'Granted by you on 4 Nov; the city has acted on it 2 times.');
  assert.equal(grantLine(grant({ acted: 0 }), NOW), 'Granted by you on 4 Nov; the city has not acted on it yet.');
  assert.equal(grantLine(grant({ state: 'suspended', by: 'school', reason: 'The master agreed with you on 44 of the last 50 merge:low decisions; autonomy needs 50 at 95%.', acted: 2 }), NOW), 'Suspended by the school: the master agreed with you on 44 of the last 50 merge:low decisions; autonomy needs 50 at 95%. The city acted on it 2 times before.');
  assert.equal(grantLine(grant({ state: 'asked', at: new Date(2026, 10, 10, 1, 0).toISOString(), acted: 0 }), NOW), 'Asked 14 hours ago; waiting on you.');
  assert.equal(grantLine(grant({ state: 'revoked', by: 'him', at: new Date(2026, 10, 10, 8, 0).toISOString(), quietUntil: new Date(2026, 11, 10, 8, 0).toISOString(), acted: 1 }), NOW), 'Taken back by you on 10 Nov, after the city acted on it once; not asked again until 10 Dec.');
  assert.equal(grantLine(grant({ state: 'revoked', by: 'revert', at: new Date(2026, 10, 9, 8, 0).toISOString(), reason: 'You reverted a merge the city made', acted: 1 }), NOW), 'Revoked by your revert on 9 Nov: you reverted a merge the city made.');
  assert.equal(grantLine(grant({ state: 'declined', at: new Date(2026, 10, 9, 8, 0).toISOString(), quietUntil: new Date(2026, 11, 9, 8, 0).toISOString(), acted: 0 }), NOW), 'Declined by you on 9 Nov; not asked again until 9 Dec.');
});

const train = (over: Partial<TrainState>): TrainState => ({ id: 'train-1', kind: 'lora', status: 'paused', reason: 'on battery', startedAt: '2026-11-10T01:00:00.000Z', endedAt: '2026-11-10T01:40:00.000Z', seconds: 2400, steps: { done: 350, of: 600, lost: 50, optimizerReset: true }, credits: 3.2, ...over });

test('a train names its kind, how it stands and what a pause lost', () => {
  assert.equal(trainLine(train({})), 'A LoRA, paused: on battery. 350 of 600 steps, 50 lost to the pause, the optimizer reset.');
  assert.equal(trainLine(train({ kind: 'nets', status: 'done', reason: null, steps: null })), 'The nets, done.');
  assert.equal(trainLine(train({ kind: 'voyage', status: 'running', reason: null, steps: null, endedAt: null })), 'A voyage, running.');
  assert.equal(trainLine(train({ kind: 'arena', status: 'failed', reason: 'The suite did not pass on the clean tree', steps: null })), 'An arena build, failed: the suite did not pass on the clean tree.');
  assert.equal(trainLine(train({ kind: 'eval', status: 'waiting', reason: 'outside the training window', steps: null })), 'A sealed race, waiting: outside the training window.');
  assert.equal(trainLine(train({ steps: { done: 600, of: 600, lost: 0, optimizerReset: false }, status: 'done', reason: null })), 'A LoRA, done. 600 of 600 steps.');
});

test('the base model and the trainer say where they stand', () => {
  assert.equal(downloadLine({ baseReady: false, download: null }, 'Qwen2.5-Coder-7B'), 'The base model, Qwen2.5-Coder-7B, is not downloaded.');
  assert.equal(downloadLine({ baseReady: true, download: null }, 'Qwen2.5-Coder-7B'), 'The base model, Qwen2.5-Coder-7B, is downloaded.');
  assert.equal(downloadLine({ baseReady: false, download: { running: true, status: null, reason: null } }, 'Qwen2.5-Coder-7B'), 'Downloading the base model, Qwen2.5-Coder-7B.');
  assert.equal(downloadLine({ baseReady: false, download: { running: false, status: 'failed', reason: 'The base model did not download: no network' } }, 'Qwen2.5-Coder-7B'), 'The base model, Qwen2.5-Coder-7B, is not downloaded. The last download failed: the base model did not download: no network.');
  assert.equal(trainerLine({ ready: false, reason: 'The trainer is not set up on this Mac', arch: null, mlx: null, mlxLm: null, pinned: false }), 'The trainer is not set up on this Mac.');
  assert.equal(trainerLine({ ready: true, reason: null, arch: 'arm64', mlx: '0.30.0', mlxLm: '0.28.0', pinned: true }), 'The trainer is ready: arm64, mlx 0.30.0, mlx-lm 0.28.0, the pinned versions.');
  assert.equal(trainerLine({ ready: true, reason: null, arch: 'arm64', mlx: '0.31.0', mlxLm: '0.28.0', pinned: false }), 'The trainer is ready: arm64, mlx 0.31.0, mlx-lm 0.28.0, not the pinned versions.');
});

test('no line carries a dash as punctuation', () => {
  for (const s of [
    netLine(card({})),
    gateLine(gate({ powerMode: 1 }), { from: '01:00', to: '06:00' }),
    agreementLine(agreement({ skewed: true })),
    voyageLine(voyage({})),
    grantLine(grant({}), NOW),
    trainLine(train({})),
    downloadLine({ baseReady: false, download: null }, 'Qwen2.5-Coder-7B'),
  ])
    noDashes(s);
});

// ---------------------------------------------------------------- the job page (Task 31)

const guess = (over: Partial<Prediction>): Prediction => ({ id: 1, key: 'propose:readme-gap:j', kind: 'propose:readme-gap', repo: 'tidewater/harbor-ledger', jobId: 'j', p: 0.88, version: 5, reason: null, at: new Date(2026, 10, 12, 18, 30).toISOString(), ...over });

test("a job page says the master's guess with its version and when, or why it made none", () => {
  assert.equal(masterGuessLine(guess({})), 'The master guessed you would accept it: 0.88, from v5, written down 12 November at 18:30.');
  assert.equal(masterGuessLine(guess({ kind: 'merge:low', p: 0.22 })), 'The master guessed you would not merge it: 0.22 that you would, from v5, written down 12 November at 18:30.');
  assert.equal(masterGuessLine(guess({ p: null, version: null, reason: 'the school is off' })), 'The master made no guess: the school is off.');
  assert.equal(masterGuessLine(guess({ p: null, version: null, reason: 'The master v3 is 9 days old.' })), 'The master made no guess: the master v3 is 9 days old.');
  assert.equal(masterGuessLine(guess({ p: null, version: null, reason: null })), 'The master made no guess.');
  noDashes(masterGuessLine(guess({ kind: 'merge:ui', p: 0.5 })));
});

test('the other nets on a job, each only when it spoke', () => {
  const agent = (id: string) => ({ a1: 'Mack Quickset', a2: 'Priya Rao', a3: 'Ada Quarry', a4: 'Tamsin Reed' })[id] ?? id;
  assert.deepEqual(netsOnJob({ appraisal: null, router: [], durability: null, master: null }, agent), []);
  assert.deepEqual(netsOnJob({ appraisal: 0.81, router: [{ agentId: 'a1', p: 0.74 }, { agentId: 'a2', p: 0.61 }, { agentId: 'a3', p: 0.4 }, { agentId: 'a4', p: 0.2 }], durability: 0.92, master: null }, agent), [
    'The appraiser gives the awarded bid 0.81 to merge.',
    'The router would send it first to Mack Quickset (0.74), then Priya Rao (0.61) and Ada Quarry (0.40).',
    'Durability gives the latest inspected run 0.92 to survive 30 days.',
  ]);
  assert.deepEqual(netsOnJob({ appraisal: null, router: [{ agentId: 'a2', p: 0.61 }], durability: null, master: null }, agent), ['The router would send it to Priya Rao (0.61).']);
});

// ---------------------------------------------------------------- Settings and the treasury (Task 32)

test('Train now, the Low Power note, the daily Claude credits and the base model, in Settings words', () => {
  const g = (over: Partial<GateState>): GateState => ({ kind: 'heavy', ok: false, reason: 'outside the training window', power: 'ac', powerMode: 0, idleMin: 30, inWindow: false, trainNowUntil: null, freeGB: 180, thermal: 'nominal', ...over });
  assert.equal(trainNowHeld(g({ power: 'battery' })), 'on battery');
  assert.equal(trainNowHeld(g({ power: 'unknown' })), 'could not read the power source');
  assert.equal(trainNowHeld(g({})), null);
  assert.equal(untilLine(new Date(2026, 10, 14, 4, 10).toISOString()), 'until 4:10');
  assert.equal(untilLine(new Date(2026, 10, 14, 16, 5).toISOString()), 'until 16:05');
  assert.equal(lowPowerNote(g({ powerMode: 1 })), 'Your Mac is set to Low Power on power; training then runs slower and cooler.');
  assert.equal(lowPowerNote(g({ powerMode: 1, power: 'battery' })), null);
  assert.equal(lowPowerNote(g({ powerMode: 0 })), null);
  assert.equal(dailyCreditsText(30), '30 credits, 3% of a window');
  assert.equal(dailyCreditsText(25), '25 credits, 2.5% of a window');
  assert.equal(dailyCreditsText(0), '0 credits, none of a window');
  assert.deepEqual(baseButton({ baseReady: false, download: null }), { label: 'Download, about 4.3 GB', state: 'none' });
  assert.deepEqual(baseButton({ baseReady: false, download: { running: true, status: null, reason: null } }), { label: 'Downloading', state: 'running' });
  assert.deepEqual(baseButton({ baseReady: false, download: { running: false, status: 'failed', reason: 'The trainer is not set up on this Mac' } }), { label: 'Download, about 4.3 GB', state: 'none' });
  assert.deepEqual(baseButton({ baseReady: true, download: null }), { label: 'Ready', state: 'ready' });
});

test("the treasury says how long the school trained this week", () => {
  assert.equal(trainedLine(3 * 3600 + 12 * 60), 'Trained 3 h 12 min on power this week.');
  assert.equal(trainedLine(3 * 3600 + 20), 'Trained 3 h on power this week.');
  assert.equal(trainedLine(42 * 60), 'Trained 42 min on power this week.');
  assert.equal(trainedLine(40), 'Trained under a minute on power this week.');
  assert.equal(trainedLine(0), 'Nothing trained this week.');
  for (const s of [trainedLine(3 * 3600 + 12 * 60), dailyCreditsText(30), untilLine(new Date().toISOString())]) noDashes(s);
});

// ---------------------------------------------------------------- an agent's page (Task 33)

test("a school agent's page says where it came from", () => {
  const arena = { id: 'arena-harbor-ledger-1', repo: 'tidewater/harbor-ledger', kind: 'planted' as const };
  assert.equal(arenaWords(arena), 'the planted bugs arena on tidewater/harbor-ledger');
  assert.equal(arenaWords({ ...arena, kind: 'past' }), 'the past changes arena on tidewater/harbor-ledger');
  assert.equal(bredLine({ generation: 2, commissionedBy: 'quickset' }, arena, (id) => (id === 'quickset' ? 'Quickset' : id)), 'Bred in generation 2 of a voyage on the planted bugs arena on tidewater/harbor-ledger, commissioned by Quickset.');
  assert.equal(bredLine({ generation: 4, commissionedBy: null }, null, (id) => id), 'Bred in generation 4 of one of the school’s own voyages.');
  assert.equal(graduatedLine({ examples: 112, arenas: ['arena-harbor-ledger-1'] }, [arena]), 'Taught on 112 verified changes, and raced sealed on the planted bugs arena on tidewater/harbor-ledger.');
  assert.equal(graduatedLine({ examples: 1, arenas: ['gone'] }, []), 'Taught on 1 verified change, and raced sealed on arena gone.');
  for (const s of [bredLine({ generation: 2, commissionedBy: null }, arena, (id) => id), graduatedLine({ examples: 3, arenas: [] }, [])]) noDashes(s);
});

// ---------------------------------------------------------------- Phase 5 Task 17

test("the school screen discloses the cost head's bias from excluded capped runs", () => {
  const bias = NET_BIAS['appraiser-cost'] ?? '';
  // Its rows leave out runs that hit their credit cap (datasets.ts), so it learns from the cheaper runs and reads costs low.
  assert.match(bias, /credit cap/);
  assert.match(bias, /low/);
  assert.ok(!/[—–]|--/.test(bias), 'no dashes');
  // Only the cost head carries this note; the pass head counts a capped run as nothing, which says nothing either way.
  assert.deepEqual(Object.keys(NET_BIAS), ['appraiser-cost']);
});

test('a net with enough labels and no training says when it trains, or why not', async () => {
  const { untrainedWhen } = await import('../app/src/ui/school-words.js');
  const s = { enabled: true, window: { from: '01:00', to: '06:00' }, idleMinutes: 20 };
  const waiting = card({ status: 'untrained', reason: 'Enough labels; not trained yet', cause: null, labels: 77 });
  assert.equal(untrainedWhen(waiting, s, gate({ kind: 'light', ok: false, reason: 'outside 1:00 to 6:00', inWindow: false })), '77 labels, enough to train. It trains in the next window, 1:00 to 6:00, once the Mac is on power and idle 20 minutes; now training waits: outside 1:00 to 6:00.');
  assert.equal(untrainedWhen(waiting, s, gate({ kind: 'light' })), '77 labels, enough to train. The gate is open, so it trains on the school\'s next pass.');
  assert.equal(untrainedWhen(waiting, { ...s, enabled: false }, gate({ kind: 'light' })), '77 labels, enough to train. The school is off, so nothing trains until you turn it on in Settings.');
  // The engine's own refusal is kept whole.
  assert.equal(untrainedWhen(card({ status: 'untrained', reason: "v3's weights are missing", cause: null, labels: 77 }), s, gate({ kind: 'light' })), "v3's weights are missing.");
  // Any other standing says what netRowLine says.
  assert.equal(untrainedWhen(card({}), s, gate({ kind: 'light' })), '18 of 40 labels. No city merge has had 30 days yet.');
  for (const x of [untrainedWhen(waiting, s, gate({ kind: 'light', ok: false, reason: 'on battery' }))]) noDashes(x);
});

test('the school says in plain words what a Brier score, its range and its baseline mean', async () => {
  const { SCORE_KEY } = await import('../app/src/ui/school-words.js');
  noDashes(SCORE_KEY);
  assert.match(SCORE_KEY, /0 is perfect/);
  assert.match(SCORE_KEY, /0\.25/);
  assert.match(SCORE_KEY, /lower is better/i);
  assert.match(SCORE_KEY, /range/);
  assert.match(SCORE_KEY, /baseline/);
});
