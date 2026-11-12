/**
 * Proposals as draft jobs (Phase 3 Task 5, ruling 4): every verified gap an
 * audit finds becomes one `proposed` job that waits for his click, keyed on
 * the claim so it is proposed once, with a scope he can edit. No audit runs
 * here: the audits are rows written straight to the store under a temp home.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { installProposals, proposeFromAudit } from '../engine/audit/proposals.js';
import { audit as storedAudit, saveAudit } from '../engine/audit/store.js';
import { openDb } from '../engine/db.js';
import { emit, subscribe } from '../engine/events.js';
import { entries } from '../engine/ledger.js';
import { CITY_MARKER, acceptProposed, dismissProposed, job, keyTaken, listJobs, settleJobEffects, setScope, transition } from '../engine/market/jobs.js';
import { DENY_SCOPE, denied, proposalKey, repoMarketDefaults, TIER_VALUE } from '../shared/market-rules.js';
import type { Audit, Finding, Job, JobStatus, Proposal, Repo, Verdict } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

const FULL = 'acme/widgets';

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-proposals-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  storeRepo();
});

afterEach(async () => {
  await settleJobEffects();
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function storeRepo(): Repo {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: null,
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

let seq = 0;

function proposalOf(claim: string, over: Partial<Proposal> = {}): Proposal {
  return {
    key: proposalKey(FULL, claim),
    title: `Build: ${claim}`,
    body: `The README says "${claim}" and nothing in src does it. Build it behind a test.`,
    scope: ['src/**'],
    acceptance: [`${claim} holds and a test shows it.`],
    tier: 'normal',
    jobId: null,
    ...over,
  };
}

function gap(claim: string, verdict: Verdict = 'MISSING', over: Partial<Finding> = {}): Finding {
  seq += 1;
  return {
    id: `f${seq}`,
    claim,
    source: { file: 'README.md', line: seq * 3 },
    verdict,
    tested: false,
    evidence: [{ file: 'src/index.ts', line: 12, note: `nothing here does ${claim.toLowerCase()}`, verified: true }],
    unverified: false,
    proposal: proposalOf(claim),
    ...over,
  };
}

function auditOf(findings: Finding[], over: Partial<Audit> = {}): Audit {
  seq += 1;
  const a: Audit = {
    id: `audit-${seq}`,
    repo: FULL,
    model: 'claude:sonnet',
    trigger: 'connect',
    baseSha: 'abc1234',
    status: 'done',
    waitingReason: null,
    startedAt: `2026-11-11T09:${String(seq).padStart(2, '0')}:00.000Z`,
    endedAt: '2026-11-11T09:30:00.000Z',
    endedReason: null,
    findings,
    counts: { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 },
    unverified: findings.filter((f) => f.unverified).length,
    claimsRead: findings.length,
    credits: 12,
    unattended: false,
    markdownPath: null,
    ...over,
  };
  for (const f of findings) a.counts[f.verdict] += 1;
  saveAudit(a);
  return a;
}

const proposedOf = (repo = FULL) => listJobs({ repo, source: 'proposal' });

/** Walks a job through the board to `to` along the shortest legal road. */
function moveTo(j: Job, to: JobStatus): Job {
  const road: JobStatus[] = ['open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'];
  let cur = job(j.id)!;
  for (const step of road.slice(road.indexOf(cur.status) + 1)) {
    cur = transition(cur, step);
    if (step === to) break;
  }
  return cur;
}

// ---------------------------------------------------------------- posting

test('an audit with three gaps posts three proposed jobs with the marker, the tier\'s value and the finding\'s evidence in the body', () => {
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const a = auditOf([
    gap('Exports CSV', 'MISSING'),
    gap('Search is instant', 'PARTIAL', { proposal: proposalOf('Search is instant', { tier: 'low' }) }),
    gap('Hot reload works', 'BROKEN', { proposal: proposalOf('Hot reload works', { tier: 'high' }) }),
    gap('Boots in a second', 'REAL', { proposal: null, tested: true }),
    gap('Parses YAML', 'MISSING', { unverified: true, evidence: [{ file: 'src/ghost.ts', line: 1, note: 'not in the commit', verified: false }], proposal: null }),
  ]);
  const posted = proposeFromAudit(a);
  off();

  assert.equal(posted.length, 3);
  assert.deepEqual(proposedOf().map((j) => j.id).sort(), posted.map((j) => j.id).sort());
  for (const j of posted) {
    assert.equal(j.status, 'proposed');
    assert.equal(j.source, 'proposal');
    assert.ok(j.body.startsWith(`${CITY_MARKER}\n`), 'the body opens with the marker');
    assert.equal(j.value, TIER_VALUE[j.tier]);
    assert.match(j.body, /src\/index\.ts:12/, 'the evidence is in the body');
    assert.match(j.body, /nothing here does/);
    assert.ok(j.key?.startsWith(`${FULL}#`), 'the key names the repo');
    assert.equal(j.proposal?.auditId, a.id);
    assert.ok(j.acceptance.length >= 1);
    assert.deepEqual(j.scope, ['src/**']);
  }
  assert.deepEqual(posted.map((j) => j.tier).sort(), ['high', 'low', 'normal']);
  assert.equal(posted.find((j) => j.tier === 'high')?.value, 150);
  assert.equal(events.filter((t) => t === 'job.proposed').length, 3);
  assert.equal(entries().filter((e) => e.kind === 'job.proposed').length, 3);
  assert.equal(listJobs({ status: 'open' }).length, 0, 'nothing went on the open board');

  const stored = storedAudit(a.id)!;
  const withJobs = stored.findings.filter((f) => f.proposal?.jobId);
  assert.equal(withJobs.length, 3, 'each proposal remembers its job');
  for (const f of withJobs) assert.equal(job(f.proposal!.jobId!)?.proposal?.findingId, f.id);
  assert.equal(stored.findings.find((f) => f.claim === 'Parses YAML')?.proposal, null, 'an unverified finding proposes nothing');

  assert.deepEqual(proposeFromAudit(stored), [], 'the same audit posts nothing twice');
  assert.equal(proposedOf().length, 3);
});

test('a proposal key already open is not posted again', () => {
  const first = proposeFromAudit(auditOf([gap('Exports CSV')]));
  assert.equal(first.length, 1);
  acceptProposed(first[0].id);
  assert.equal(job(first[0].id)?.status, 'open');

  const again = proposeFromAudit(auditOf([gap('  exports   csv ')]));
  assert.deepEqual(again, [], 'the same claim, however spaced, is one key');
  assert.equal(proposedOf().length, 1);
  assert.equal(keyTaken(FULL, proposalKey(FULL, 'Exports CSV'))?.id, first[0].id);

  // A different repo's same claim is its own key.
  assert.equal(keyTaken('acme/gadgets', proposalKey('acme/gadgets', 'Exports CSV')), null);
});

test('a key he dismissed stays dismissed on the next audit', () => {
  const [p] = proposeFromAudit(auditOf([gap('Exports CSV')]));
  const dismissed = dismissProposed(p.id);
  assert.equal(dismissed.status, 'withdrawn');
  assert.equal(dismissed.withdrawnBy, 'him');

  const again = proposeFromAudit(auditOf([gap('Exports CSV')]));
  assert.deepEqual(again, []);
  assert.equal(proposedOf().length, 1);
  assert.equal(keyTaken(FULL, p.key!)?.id, p.id, 'his dismissal holds the key');

  const moves = entries().filter((e) => e.kind === 'job.changed' && (e.data as { to: string }).to === 'withdrawn');
  assert.equal(moves.length, 1);
  assert.equal((moves[0].data as { by: string }).by, 'him');
});

test('a merged key is posted again only while the claim is still missing or broken', () => {
  const [p] = proposeFromAudit(auditOf([gap('Exports CSV')]));
  acceptProposed(p.id);
  const merged = moveTo(p, 'merged');
  assert.equal(merged.status, 'merged');

  // The merge closed it: a PARTIAL or STUBBED finding on the same claim proposes nothing.
  assert.deepEqual(proposeFromAudit(auditOf([gap('Exports CSV', 'PARTIAL')])), []);
  assert.deepEqual(proposeFromAudit(auditOf([gap('Exports CSV', 'STUBBED')])), []);
  assert.equal(proposedOf().length, 1);

  // Still missing: proposed once more, and the body says so.
  const [again] = proposeFromAudit(auditOf([gap('Exports CSV', 'MISSING')]));
  assert.ok(again);
  assert.equal(again.status, 'proposed');
  assert.equal(again.key, p.key);
  assert.match(again.body, /proposed again: the merge did not close it/);
  assert.equal(proposedOf().length, 2);

  // And the new proposal now holds the key.
  assert.deepEqual(proposeFromAudit(auditOf([gap('Exports CSV', 'BROKEN')])), []);
  assert.equal(keyTaken(FULL, p.key!)?.id, again.id);
});

test('a key the city withdrew is free again', () => {
  const [p] = proposeFromAudit(auditOf([gap('Exports CSV')]));
  transition(p, 'withdrawn');
  assert.equal(job(p.id)?.withdrawnBy, 'city');
  assert.equal(keyTaken(FULL, p.key!), null);
  assert.equal(proposeFromAudit(auditOf([gap('Exports CSV')])).length, 1);
});

// ---------------------------------------------------------------- scope

test('setScope changes a proposed job\'s scope and refuses a denied glob', () => {
  const [p] = proposeFromAudit(auditOf([gap('Exports CSV')]));
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const changed = setScope(p.id, { scope: ['src/export/**', 'test/export.test.ts'], acceptance: ['A CSV comes out with a header row.'] });
  off();
  assert.equal(changed.status, 'proposed');
  assert.deepEqual(changed.scope, ['src/export/**', 'test/export.test.ts']);
  assert.deepEqual(changed.acceptance, ['A CSV comes out with a header row.']);
  assert.deepEqual(job(p.id)?.scope, ['src/export/**', 'test/export.test.ts']);
  assert.deepEqual(events, ['job.changed']);
  const last = entries().filter((e) => e.kind === 'job.changed').at(-1)!.data as { from: string; to: string };
  assert.equal(last.from, 'proposed');
  assert.equal(last.to, 'proposed');

  assert.throws(() => setScope(p.id, { scope: ['src/**', '.github/workflows/**'] }), /\.github\/workflows\/\*\*/);
  assert.throws(() => setScope(p.id, { scope: ['**/.env'] }), /\.env/);
  assert.throws(() => setScope(p.id, { scope: ['**/*.pem'] }), /\*\.pem/);
  assert.throws(() => setScope(p.id, { scope: ['../other/**'] }), /refused|denied|not a path/i);
  assert.throws(() => setScope(p.id, { scope: ['/Users/him/src/**'] }), /refused|denied|not a path/i);
  assert.throws(() => setScope(p.id, { scope: ['prose only'] }), /refused|denied|not a path/i);
  assert.throws(() => setScope(p.id, { acceptance: ['', '  '] }), /acceptance/);
  assert.deepEqual(job(p.id)?.scope, ['src/export/**', 'test/export.test.ts'], 'a refused patch changes nothing');

  // Only the acceptance, with the scope kept; and an empty scope means the whole repo.
  assert.deepEqual(setScope(p.id, { acceptance: ['Another line.'] }).scope, ['src/export/**', 'test/export.test.ts']);
  assert.deepEqual(setScope(p.id, { scope: [] }).scope, ['**']);

  // Open still takes an edit; bidding does not.
  acceptProposed(p.id);
  assert.deepEqual(setScope(p.id, { scope: ['src/**'] }).scope, ['src/**']);
  transition(job(p.id)!, 'bidding');
  assert.throws(() => setScope(p.id, { scope: ['lib/**'] }), /only while proposed or open/);
  assert.throws(() => setScope('job-none', { scope: ['lib/**'] }), /no job/);
});

test('every proposed job\'s scope excludes DENY_SCOPE', () => {
  const dirty = [...DENY_SCOPE, '**/.env', 'src/.env.local', '.claude/settings.json', 'src/**', 'deploy/id_rsa.pub', 'lib/*.key', '.git/hooks/*'];
  const [p] = proposeFromAudit(auditOf([gap('Exports CSV', 'MISSING', { proposal: proposalOf('Exports CSV', { scope: dirty }) })]));
  assert.deepEqual(p.scope, ['src/**']);
  for (const g of p.scope) assert.equal(denied(g), null);

  // Nothing allowed left: the whole repo, which the guard still filters path by path.
  const [q] = proposeFromAudit(auditOf([gap('Parses YAML', 'MISSING', { proposal: proposalOf('Parses YAML', { scope: ['.env', '**/*.pem'] }) })]));
  assert.deepEqual(q.scope, ['**']);
});

test('a proposal\'s text is redacted and capped before it is a job', () => {
  const long = 'x'.repeat(10_000);
  const [p] = proposeFromAudit(auditOf([
    gap('Exports CSV', 'MISSING', {
      evidence: [{ file: 'src/index.ts', line: 1, note: 'see /Users/him/secrets and ghp_abcdefghijklmnopqrstuvwxyz0123456789', verified: true }],
      proposal: proposalOf('Exports CSV', { title: `Build it under /Users/him/code ${long}`, body: `token sk-ant-abcdefghijklmnopqrstuvwxyz ${long}` }),
    }),
  ]));
  assert.doesNotMatch(p.title, /\/Users\//);
  assert.doesNotMatch(p.body, /\/Users\//);
  assert.doesNotMatch(p.body, /ghp_|sk-ant-/);
  assert.ok(p.title.length <= 120, `title ${p.title.length}`);
  assert.ok(p.body.length <= 6000, `body ${p.body.length}`);
});

// ---------------------------------------------------------------- the bus

test('installProposals posts from a done audit on the bus and ignores the rest', () => {
  const off = installProposals();
  try {
    const failed = auditOf([gap('Exports CSV')], { status: 'failed', endedReason: 'the audit wrote to its clone' });
    emit('audit.ended', { audit: failed });
    assert.equal(proposedOf().length, 0, 'a failed audit proposes nothing');

    const done = auditOf([gap('Exports CSV'), gap('Search is instant', 'BROKEN')]);
    emit('audit.ended', { audit: done });
    assert.equal(proposedOf().length, 2);
    emit('audit.ended', { audit: storedAudit(done.id)! });
    assert.equal(proposedOf().length, 2, 'the same end twice posts nothing more');
  } finally {
    off();
  }
  emit('audit.ended', { audit: auditOf([gap('Parses YAML')]) });
  assert.equal(proposedOf().length, 2, 'unsubscribed');
});
