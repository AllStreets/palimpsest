/**
 * The audit report's words (Phase 3 Task 10): each verdict as a word and a
 * mark, the lead in the engine's own sentence, evidence as a `file:line`
 * link that only ever goes to GitHub at the audited commit, where a
 * proposal stands, and why "Audit the README" is held. Pure functions, no DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAudit } from '../engine/audit/schema.js';
import { auditedBecause, auditHeld, auditStage, canProposeAgain, evidenceHref, evidenceText, leadOf, proposalWord, verdictMark, verdictWord, whatToBuild } from '../app/src/ui/audit-words.js';
import type { Audit, Finding, Job, Verdict } from '../shared/types.js';

const SHA = '872bfe892645b03745a1c06add3fc975b25a3e5e';

function finding(id: string, verdict: Verdict, over: Partial<Finding> = {}): Finding {
  return { id, claim: `claim ${id}`, source: { file: 'README.md', line: 3 }, verdict, tested: verdict === 'REAL', evidence: [{ file: 'src/a.ts', line: 4, note: '', verified: true }], unverified: false, proposal: null, ...over };
}

function auditOf(findings: Finding[], over: Partial<Audit> = {}): Audit {
  const counts = { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 };
  for (const f of findings) counts[f.verdict] += 1;
  return {
    id: 'audit-1',
    repo: 'tidewater/harbor-ledger',
    model: 'claude:sonnet',
    trigger: 'demand',
    baseSha: SHA,
    status: 'done',
    waitingReason: null,
    startedAt: '2026-11-11T09:00:00.000Z',
    endedAt: '2026-11-11T09:19:00.000Z',
    endedReason: null,
    findings,
    counts,
    unverified: findings.filter((f) => f.unverified).length,
    claimsRead: findings.length,
    credits: 23.4,
    unattended: false,
    markdownPath: null,
    ...over,
  };
}

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1', repo: 'tidewater/harbor-ledger', source: 'proposal', issue: null, url: null, title: 't', body: '', scope: ['**'], acceptance: ['a'], tier: 'normal', value: 60,
    status: 'proposed', attempts: 0, postedAt: '2026-11-11T09:20:00.000Z', bidsCloseAt: null, awardedBid: null, runId: null, floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null,
    key: 'tidewater/harbor-ledger#abc', proposal: { auditId: 'audit-1', findingId: 'f1' }, withdrawnBy: null, ...over,
  };
}

test('each verdict is a word and its own mark, none told apart by colour alone', () => {
  const verdicts: Verdict[] = ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN'];
  assert.deepEqual(verdicts.map(verdictWord), ['real', 'partial', 'missing', 'stubbed', 'broken']);
  assert.deepEqual(verdicts.map(verdictMark), ['full', 'half', 'empty', 'hatched', 'struck']);
  assert.equal(new Set(verdicts.map(verdictMark)).size, 5);
});

test('the lead is the sentence the audit page opens with', () => {
  const mixed = auditOf([
    ...Array.from({ length: 8 }, (_, i) => finding(`r${i}`, 'REAL')),
    finding('p1', 'PARTIAL'),
    finding('p2', 'PARTIAL'),
    finding('m1', 'MISSING'),
    finding('m2', 'MISSING'),
    finding('m3', 'MISSING', { unverified: true, evidence: [{ file: 'src/notify/email.ts', line: 12, note: '', verified: false }] }),
    finding('b1', 'BROKEN'),
  ]);
  assert.equal(leadOf(mixed), 'Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1 broken. One finding cites nothing found at the base commit and is unverified.');
  for (const a of [mixed, auditOf([]), auditOf([], { claimsRead: 3 }), auditOf([finding('s', 'STUBBED')])]) {
    assert.ok(renderAudit(a, { repoDescription: null }).includes(leadOf(a)), `the page carries "${leadOf(a)}"`);
  }
  assert.equal(leadOf(auditOf([])), 'No README to check.');
  assert.equal(leadOf(auditOf([], { status: 'capped', endedReason: 'credit cap of 40' })), 'The audit ended capped: credit cap of 40. Nothing was proposed.');
});

test('an audit not yet ended says where it is, and why it waits', () => {
  assert.equal(auditStage(auditOf([], { status: 'waiting', waitingReason: 'waiting for your Claude session to go quiet' })), 'Waiting: waiting for your Claude session to go quiet.');
  assert.equal(auditStage(auditOf([], { status: 'waiting' })), 'Waiting to start.');
  assert.equal(auditStage(auditOf([], { status: 'preparing' })), 'Cloning the repo at its base commit.');
  assert.equal(auditStage(auditOf([], { status: 'installing' })), 'Installing what its checks need.');
  assert.equal(auditStage(auditOf([], { status: 'reading', model: 'claude:sonnet' })), 'Reading the README against the code, on claude:sonnet.');
  assert.equal(auditStage(auditOf([])), null, 'a done audit has its lead instead');
});

test('evidence links go to GitHub at the audited commit, and nowhere else', () => {
  assert.equal(evidenceHref('tidewater/harbor-ledger', SHA, { file: 'src/schedule/days.ts', line: 7 }), `https://github.com/tidewater/harbor-ledger/blob/${SHA}/src/schedule/days.ts#L7`);
  assert.equal(evidenceHref('tidewater/harbor-ledger', SHA, { file: 'docs/a b.md', line: null }), `https://github.com/tidewater/harbor-ledger/blob/${SHA}/docs/a%20b.md`);
  for (const file of ['../../.ssh/id_rsa', '/Users/him/secret', 'a\\b', '', 'src/../x', 'javascript:alert(1)']) {
    assert.equal(evidenceHref('tidewater/harbor-ledger', SHA, { file, line: 1 }), null, file);
  }
  assert.equal(evidenceHref('tidewater/harbor-ledger', null, { file: 'src/a.ts', line: 1 }), null, 'no commit, no link');
  assert.equal(evidenceHref('tidewater/harbor-ledger', 'main', { file: 'src/a.ts', line: 1 }), null, 'a branch name is not a commit');
  assert.equal(evidenceHref('a/b/c', SHA, { file: 'src/a.ts', line: 1 }), null, 'a repo is an owner and a name');
  assert.equal(evidenceHref('../x', SHA, { file: 'src/a.ts', line: 1 }), null);
  assert.equal(evidenceText({ file: 'src/a.ts', line: 4 }), 'src/a.ts:4');
  assert.equal(evidenceText({ file: 'src/a.ts', line: null }), 'src/a.ts');
});

test('a proposal says where its job stands', () => {
  assert.equal(proposalWord(jobOf()), 'waiting on you');
  assert.equal(proposalWord(jobOf({ status: 'open' })), 'accepted, on the board');
  assert.equal(proposalWord(jobOf({ status: 'bidding' })), 'accepted, taking bids');
  assert.equal(proposalWord(jobOf({ status: 'running' })), 'accepted, being built');
  assert.equal(proposalWord(jobOf({ status: 'waiting' })), 'pull request open');
  assert.equal(proposalWord(jobOf({ status: 'merged' })), 'merged');
  assert.equal(proposalWord(jobOf({ status: 'withdrawn', withdrawnBy: 'him' })), 'dismissed');
  assert.equal(proposalWord(jobOf({ status: 'withdrawn', withdrawnBy: null })), 'withdrawn');
  assert.equal(proposalWord(null), 'not posted');
});

test('Propose again stands beside the newest merged or dismissed holder of a key only', () => {
  const dismissed = jobOf({ id: 'job-1', status: 'withdrawn', withdrawnBy: 'him' });
  assert.equal(canProposeAgain(dismissed, [dismissed]), true);
  assert.equal(canProposeAgain(jobOf({ status: 'merged' }), []), true);
  assert.equal(canProposeAgain(jobOf({ status: 'proposed' }), []), false);
  assert.equal(canProposeAgain(jobOf({ status: 'withdrawn', withdrawnBy: 'city' }), []), false);
  assert.equal(canProposeAgain(jobOf({ status: 'merged', key: null }), []), false);
  assert.equal(canProposeAgain(jobOf({ status: 'merged', source: 'issue' }), []), false);
  const newer = jobOf({ id: 'job-2', postedAt: '2026-11-12T09:00:00.000Z' });
  assert.equal(canProposeAgain(dismissed, [dismissed, newer]), false, 'a newer job holds the key');
});

test('Audit the README is held while one waits or reads, with the reason', () => {
  assert.equal(auditHeld([]), null);
  assert.equal(auditHeld([auditOf([])]), null, 'a done audit holds nothing');
  assert.equal(auditHeld([auditOf([], { status: 'waiting' })]), 'An audit is waiting to start.');
  assert.equal(auditHeld([auditOf([], { status: 'waiting', waitingReason: 'waiting for your Claude session to go quiet' })]), 'An audit is waiting for your Claude session to go quiet.');
  assert.equal(auditHeld([auditOf([], { status: 'reading' })]), 'An audit is reading the code now.');
  assert.equal(auditHeld([auditOf([], { status: 'preparing' })]), 'An audit is under way now.');
});

test("a proposal's page reads only what to build from its body; the claim and evidence stand above it", () => {
  const body = ['[palimpsest]', 'Claim: "Exports CSV" (README.md:4)', 'Verdict: MISSING, untested', '', 'Evidence:', '- src/a.ts:1: nothing', '', 'What to build:', 'Add a CSV writer.', '', 'Behind a test.', '', 'Accepted when:', '- [ ] A CSV comes out'].join('\n');
  assert.deepEqual(whatToBuild(body), { again: false, text: 'Add a CSV writer.\n\nBehind a test.' });
  assert.deepEqual(whatToBuild(`[palimpsest]\nproposed again: the merge did not close it\n\nClaim: "x"\n\nWhat to build:\nDo it.`), { again: true, text: 'Do it.' });
  assert.equal(whatToBuild('An issue body without the section'), null);
  assert.equal(whatToBuild(42), null);
});

test('the audit page says plainly why the audit ran', () => {
  assert.equal(auditedBecause('connect'), 'audited by itself when its market opened');
  assert.equal(auditedBecause('demand'), 'audited when you asked');
  assert.equal(auditedBecause('brief'), 'audited when you asked');
});
