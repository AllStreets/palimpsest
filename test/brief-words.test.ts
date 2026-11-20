/**
 * The brief's words (Phase 3 Task 11): the day as the page's title, each
 * action's label, each item's sentence, what he did with an item and when,
 * the usage line with both windows and today's limit, and the empty
 * morning. Pure functions, no DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { actedLine, actionLabel, agreementOf, auditCounts, briefMeta, briefTitle, capBounds, emptyMorning, grantMoves, grantState, itemReadouts, itemSentence, kindWords, leadFigures, MOVE_LABEL, sinceLine, usageLine } from '../app/src/ui/brief-words.js';
import type { Brief, BriefAction, BriefItem, BudgetWindow, Grant } from '../shared/types.js';

const names = { agent: (id: string) => id, firm: (id: string) => ({ quickset: 'Quickset' })[id] ?? id };

function item(over: Partial<BriefItem>): BriefItem {
  return { id: 'x', kind: 'merged', repo: 'tidewater/harbor-ledger', title: 'A job', text: '', at: new Date(2026, 10, 11, 18, 30).toISOString(), tier: null, refs: {}, actions: [], acted: null, ...over };
}

function win(over: Partial<BudgetWindow> = {}): BudgetWindow {
  return { capPct: 50, cityPct: 7.6, usedPct: 44, estimatedPct: 44.83, resetsAt: null, ...over };
}

function usage(over: Partial<Brief['usage']> = {}): Brief['usage'] {
  return { fiveHour: win(), sevenDay: win({ capPct: 90, usedPct: 21, estimatedPct: 21.2 }), todayCapPct: null, paused: null, ...over };
}

test('the title is the day, written out', () => {
  assert.equal(briefTitle('2026-11-11'), 'Wednesday 11 November');
  assert.equal(briefTitle('2026-11-10'), 'Tuesday 10 November');
  assert.equal(briefTitle('2026-01-05'), 'Monday 5 January');
});

test('every action has its label, a word or two on a key', () => {
  const want: Record<BriefAction, string> = {
    accept: 'Post',
    tier: 'Tier',
    dismiss: 'Dismiss',
    why: 'Why',
    diff: 'Diff',
    fly: 'Fly there',
    retry: 'Retry',
    resume: 'Resume',
    'open-pr': 'Open PR',
    cap: 'Set limit',
    audit: 'Audit',
    tour: 'Walk the week',
    grant: 'Let it act here',
    decline: 'Not yet',
    revoke: 'Take back',
  };
  for (const [a, label] of Object.entries(want)) assert.equal(actionLabel(a as BriefAction), label, a);
});

test('the empty morning is one quiet line', () => {
  assert.equal(emptyMorning(), 'Nothing waits on you this morning');
});

test('a sentence never repeats the repo its dateline names', () => {
  const pr = item({ kind: 'pr', repo: 'hoshi/kumo', text: 'PR #312 on hoshi/kumo by Quickset waits for your review.' });
  assert.equal(itemSentence(pr, names), 'PR #312 by Quickset waits for your review.');
  assert.deepEqual(briefMeta(pr, Date.parse(pr.at) + 3_600_000), { where: 'kumo', when: '18:30' });
  assert.deepEqual(briefMeta(pr, Date.parse(pr.at) + 86_400_000), { where: 'kumo', when: 'yesterday 18:30' });
  const merged = item({ text: 'Merged, and Quickset was paid 28.37 credits.' });
  assert.equal(itemSentence(merged, names), 'Merged, and Quickset was paid 28.37 credits.');
});

test('a sentence starts with a capital, as the engine\'s notes do not always', () => {
  const note = item({ kind: 'note', repo: 'ferro/quarry', text: 'merged with changes: merged into release/2.4, not main.' });
  assert.equal(itemSentence(note, names), 'Merged with changes: merged into release/2.4, not main.');
});

test('a proposal says its tier and what the city would pay; its claim waits under Ask why', () => {
  const p = item({ kind: 'proposal', tier: 'high', refs: { jobId: 'j', auditId: 'a' }, text: 'The README says "x", and the code does not do it yet.' });
  assert.equal(itemSentence(p, names), 'Proposed from its README audit; at the high tier the city pays at most 150 credits.');
  const harness = item({ kind: 'proposal', tier: 'normal', refs: { jobId: 'j' }, text: 'This repo has no test command.' });
  assert.equal(itemSentence(harness, names), 'This repo has no test command. At the normal tier the city pays at most 60 credits.');
  // Once he answered it, the price is no longer the news: the row says what he did.
  const answered = { ...p, acted: { action: 'accept' as const, at: new Date().toISOString() } };
  assert.equal(itemSentence(answered, names), 'Proposed from its README audit.');
  assert.equal(itemSentence({ ...harness, acted: answered.acted }, names), 'This repo has no test command.');
});

test('the usage sentence rounds the windows to whole percents', () => {
  const u = item({ kind: 'usage', repo: null, title: 'The five-hour window is at 44.83%', text: 'The cap is 50%. The city pauses at the cap; you can change today\'s limit here, for today only.' });
  assert.equal(itemSentence(u, names), 'The five-hour window is at 45%. The cap is 50%. The city pauses at the cap; you can change today\'s limit here, for today only.');
  assert.deepEqual(briefMeta(u, Date.now()), { where: '', when: '' });
});

test('a recommendation to audit names the repo alone: when it connected is not the news', () => {
  const due = item({ kind: 'audit-due', repo: 'kestrel/fieldnotes', text: 'Its README has not been checked against its code. An audit reads the clone.' });
  assert.deepEqual(briefMeta(due, Date.now()), { where: 'fieldnotes', when: '' });
  assert.equal(itemSentence(due, names), 'Its README has not been checked against its code.');
});

test('what he did with an item, and when, as a short readout', () => {
  const at = new Date(2026, 10, 12, 9, 14).toISOString();
  assert.equal(actedLine(item({ kind: 'proposal', acted: { action: 'accept', at } })), 'Posted 09:14');
  assert.equal(actedLine(item({ acted: { action: 'dismiss', at } })), 'Dismissed 09:14');
  assert.equal(actedLine(item({ kind: 'failed', acted: { action: 'retry', at } })), 'Posted again 09:14');
  assert.equal(actedLine(item({ kind: 'halt', acted: { action: 'resume', at } })), 'Resumed 09:14');
  assert.equal(actedLine(item({ kind: 'proposal', tier: 'low', acted: { action: 'tier', at } })), 'Tier low 09:14');
  assert.equal(actedLine(item({ kind: 'audit-due', acted: { action: 'audit', at } })), 'Audit queued 09:14');
  assert.equal(actedLine(item({ kind: 'usage', acted: { action: 'cap', at } }), 60), 'Limit 60% 09:14');
  assert.equal(actedLine(item({ kind: 'usage', acted: { action: 'cap', at } })), 'Limit set 09:14');
  // Looking is not acting: Ask why, the diff, the floor and the PR leave no line.
  for (const a of ['why', 'diff', 'fly', 'open-pr'] as BriefAction[]) assert.equal(actedLine(item({ acted: { action: a, at } })), '', a);
  assert.equal(actedLine(item({})), '');
});

test('the usage line names both windows and today\'s limit, and says when the limit is his', () => {
  assert.equal(usageLine(usage(), 50), 'The five-hour window stands at 45% against today\'s limit of 50%, the usual cap; the seven-day window at 21%.');
  const his = usage({ fiveHour: win({ capPct: 60 }), todayCapPct: 60 });
  assert.equal(usageLine(his, 50), 'The five-hour window stands at 45% against today\'s limit of 60%, set by you until midnight; the seven-day window at 21%.');
  const same = usage({ todayCapPct: 50 });
  assert.equal(usageLine(same, 50), 'The five-hour window stands at 45% against today\'s limit of 50%, the usual cap, held by you until midnight; the seven-day window at 21%.');
  const unread = usage({ fiveHour: win({ usedPct: null, estimatedPct: 0 }), sevenDay: win({ usedPct: null, estimatedPct: 0, capPct: 90 }) });
  assert.match(usageLine(unread, 50), /^No reading of your plan yet;/);
});

test('today\'s limit may rise to five points under the hard stop, never below five', () => {
  assert.deepEqual(capBounds(90), { min: 5, max: 85 });
  assert.deepEqual(capBounds(8), { min: 5, max: 5 });
});

test('the since readout says the window, and whether this is the day\'s first look', () => {
  const since = new Date(2026, 10, 11, 6, 40).toISOString();
  assert.equal(sinceLine(since, '2026-11-12', true), 'Since yesterday 06:40');
  assert.equal(sinceLine(since, '2026-11-12', false), 'Since yesterday 06:40, second look');
  assert.equal(sinceLine(new Date(2026, 10, 9, 6, 40).toISOString(), '2026-11-12', true), 'Since Monday 06:40');
  assert.equal(sinceLine(new Date(2026, 10, 12, 6, 40).toISOString(), '2026-11-12', true), 'Since 06:40');
});

test('a row reads as figures and short labels; its sentence waits under Why', () => {
  const p = item({ kind: 'proposal', tier: 'high', refs: { jobId: 'j', auditId: 'a' } });
  assert.deepEqual(itemReadouts(p, names), [{ v: 'high', k: 'tier' }]);
  const merged = item({ text: 'Merged, and Quickset was paid 28.37 credits.' });
  assert.deepEqual(itemReadouts(merged, names), [{ v: 'merged', tone: 'ok' }, { v: '28.37', k: 'cr' }, { v: 'Quickset', tone: 'quiet' }]);
  const pr = item({ kind: 'pr', repo: 'hoshi/kumo', text: 'PR #312 on hoshi/kumo by Quickset waits for your review.' });
  assert.deepEqual(itemReadouts(pr, names), [{ v: '#312', k: 'PR' }, { v: 'Quickset', tone: 'quiet' }, { v: 'review', tone: 'warn' }]);
  const failed = item({ kind: 'failed', text: 'Failed, with one attempt left. The run finished without changing anything.' });
  assert.deepEqual(itemReadouts(failed, names), [{ v: 'failed', tone: 'fail' }, { v: '1', k: 'attempt left' }]);
  assert.deepEqual(itemReadouts(item({ kind: 'failed', text: 'Failed for good after 2 attempts.' }), names), [{ v: 'failed', tone: 'fail' }, { v: 'no attempts left', tone: 'quiet' }]);
  const audit = item({ kind: 'audit', text: '14 claims read: 8 real, 2 partial, 3 missing and 1 broken; 4 jobs proposed.' });
  assert.deepEqual(itemReadouts(audit, names), [{ v: '4', k: 'jobs proposed' }]);
  const usage = item({ kind: 'usage', repo: null, title: 'The five-hour window is at 44.83%', text: 'The cap is 50%. The city pauses at the cap.' });
  assert.deepEqual(itemReadouts(usage, names), [{ v: '45%', k: 'five-hour' }, { v: '50%', k: 'cap' }]);
  // A note has no figures: its first clause, cut at a word.
  const note = item({ kind: 'note', repo: 'ferro/quarry', text: 'merged with changes: merged into release/2.4, not main.' });
  assert.deepEqual(itemReadouts(note, names), [{ v: 'Merged with changes' }]);
});

test('the figures behind the instruments: the lead, an audit, an ask', () => {
  assert.deepEqual(leadFigures('6 things wait on you; 11 merged since yesterday. The city spent 954.60 credits.'), { waiting: 6, merged: 11, spent: '954.60' });
  assert.deepEqual(leadFigures('Nothing waits on you this morning. The city made no model calls.'), { waiting: 0, merged: 0, spent: null });
  assert.deepEqual(auditCounts('14 claims read: 8 real, 2 partial, 3 missing and 1 broken; 4 jobs proposed.'), { real: 8, partial: 2, missing: 3, broken: 1, jobs: 4 });
  assert.equal(auditCounts('The audit could not read the clone.'), null);
  assert.deepEqual(agreementOf('The master has agreed with you on 48 of the last 50 propose:readme-gap decisions, and on its last 10 on tidewater/harbor-ledger.'), { agreed: 48, of: 50, here: 10 });
  assert.equal(agreementOf('Nothing to say.'), null);
});

// ---------------------------------------------------------------- autonomy (Phase 4 Task 31)

const NOW = new Date(2026, 10, 12, 9, 30).getTime();
const day = (d: number, h = 18, m = 30): string => new Date(2026, 10, d, h, m).toISOString();
function pair(over: Partial<Grant>): Grant {
  return { kind: 'merge:low', repo: 'hoshi/kumo', state: 'granted', at: day(3), by: 'him', rate: null, reason: null, acted: 0, quietUntil: null, ...over };
}

test('a pair says its state in a few words, as a ledger sets them', () => {
  assert.equal(grantState(pair({ state: 'asked', by: 'school', at: day(10) }), NOW), 'asked on Tuesday');
  assert.equal(grantState(pair({ state: 'asked', by: 'school', at: day(11) }), NOW), 'asked yesterday');
  assert.equal(grantState(pair({ state: 'asked', by: 'school', at: day(12, 2, 10) }), NOW), 'asked today');
  assert.equal(grantState(pair({ state: 'asked', by: 'school', at: day(1) }), NOW), 'asked on 1 November');
  assert.equal(grantState(pair({ acted: 6 }), NOW), 'granted 3 November, 6 merges since');
  assert.equal(grantState(pair({ acted: 1 }), NOW), 'granted 3 November, 1 merge since');
  assert.equal(grantState(pair({ acted: 0 }), NOW), 'granted 3 November, none since');
  assert.equal(grantState(pair({ kind: 'propose:readme-gap', acted: 2 }), NOW), 'granted 3 November, 2 proposals accepted since');
  assert.equal(grantState(pair({ state: 'revoked', by: 'revert', at: day(8), quietUntil: day(38) }), NOW), 'revoked by a revert on 8 November');
  assert.equal(grantState(pair({ state: 'revoked', by: 'him', at: day(2), quietUntil: new Date(2026, 11, 2, 9).toISOString() }), NOW), 'you took it back; quiet until 2 December');
  assert.equal(grantState(pair({ state: 'revoked', by: 'him', at: day(2), quietUntil: day(11) }), NOW), 'you took it back on 2 November');
  assert.equal(grantState(pair({ state: 'declined', by: 'him', at: day(9), quietUntil: new Date(2026, 11, 9, 9).toISOString() }), NOW), 'you said not yet; quiet until 9 December');
  assert.equal(grantState(pair({ state: 'declined', by: 'him', at: day(9), quietUntil: day(10) }), NOW), 'you said not yet on 9 November');
});

test("a suspended pair names his undo, or keeps the engine's sentence whole", () => {
  assert.equal(grantState(pair({ kind: 'propose:readme-gap', state: 'suspended', by: 'school', reason: 'he undid it' }), NOW), 'suspended: you undid an accepted proposal');
  assert.equal(grantState(pair({ kind: 'merge:normal', state: 'suspended', by: 'school', reason: 'he undid it' }), NOW), 'suspended: you undid a merge it made');
  const window = 'The master agreed with you on 44 of the last 50 merge:low decisions; autonomy needs 50 at 95%.';
  assert.equal(grantState(pair({ state: 'suspended', by: 'school', reason: window }), NOW), 'suspended: the master agreed with you on 44 of the last 50 low-tier merges; autonomy needs 50 at 95%');
  assert.equal(grantState(pair({ state: 'suspended', by: 'school', reason: null }), NOW), 'suspended by the school');
});

test('each state offers only what the engine accepts, and Beagle is never offered a grant', () => {
  assert.deepEqual(grantMoves(pair({ state: 'asked' }), 'settings'), ['grant', 'decline']);
  assert.deepEqual(grantMoves(pair({ state: 'granted' }), 'district'), ['revoke']);
  assert.deepEqual(grantMoves(pair({ state: 'suspended' }), 'settings'), ['revoke']);
  // A revoked pair is granted again only from Settings (ruling 17); a decline waits out its quiet.
  assert.deepEqual(grantMoves(pair({ state: 'revoked' }), 'settings'), ['regrant']);
  assert.deepEqual(grantMoves(pair({ state: 'revoked' }), 'district'), []);
  assert.deepEqual(grantMoves(pair({ state: 'declined' }), 'settings'), []);
  for (const repo of ['AllStreets/beagle', 'allstreets/Beagle ']) {
    assert.deepEqual(grantMoves(pair({ repo, state: 'asked' }), 'settings'), ['decline'], repo);
    assert.deepEqual(grantMoves(pair({ repo, state: 'revoked' }), 'settings'), [], repo);
  }
  assert.equal(MOVE_LABEL.grant, 'Let the city do this on its own here');
  assert.equal(MOVE_LABEL.decline, 'Not yet');
  assert.equal(MOVE_LABEL.revoke, 'Take it back');
  assert.equal(MOVE_LABEL.regrant, 'Grant it again');
});

test('a kind of work is said in words, never as its code', () => {
  assert.equal(kindWords('propose:readme-gap'), 'README gap proposals');
  assert.equal(kindWords('merge:low'), 'low-tier merges');
  assert.equal(kindWords('merge:ui'), 'UI merges');
  const ask = item({ kind: 'autonomy', repo: 'tidewater/harbor-ledger', text: 'The master has agreed with you on 48 of the last 50 propose:readme-gap decisions, and on its last 10 on tidewater/harbor-ledger. If you grant it, the city acts there without you when every check holds.' });
  assert.equal(itemSentence(ask, names), 'The master has agreed with you on 48 of the last 50 README gap proposals, and on its last 10 here. If you grant it, the city acts there without you when every check holds.');
  const acted = item({ kind: 'acted', repo: 'hoshi/kumo', text: 'The city merged PR #12 of "Fix" on hoshi/kumo on its own, under its merge:low grant.' });
  assert.equal(itemSentence(acted, names), 'The city merged PR #12 of "Fix" on its own, under its grant for low-tier merges.');
});

test('his answer to an ask, and his taking back, in quiet words', () => {
  const at = new Date(2026, 10, 12, 9, 14).toISOString();
  assert.equal(actedLine(item({ kind: 'autonomy', acted: { action: 'grant', at } })), 'Granted 09:14');
  assert.equal(actedLine(item({ kind: 'autonomy', acted: { action: 'decline', at } })), 'Not yet, quiet 30 days 09:14');
  assert.equal(actedLine(item({ kind: 'acted', acted: { action: 'revoke', at } })), 'Taken back 09:14');
});

test('Waiting on you sets what needs a click first, then what he handled today, apart and quieter (audit 2026-11-17)', async () => {
  const { waitingGroups, HANDLED_HEAD } = await import('../app/src/ui/brief-words.js');
  const at = new Date(2026, 10, 11, 18, 30).toISOString();
  const posted = item({ id: 'p1', kind: 'proposal', acted: { action: 'accept', at } });
  const open = item({ id: 'p2', kind: 'proposal', actions: ['accept', 'tier', 'dismiss'] });
  const tiered = item({ id: 'p3', kind: 'proposal', actions: ['accept', 'tier', 'dismiss'], acted: { action: 'tier', at } });
  const dismissed = item({ id: 'f1', kind: 'pr', acted: { action: 'dismiss', at } });
  const pr = item({ id: 'pr1', kind: 'pr', actions: ['open-pr', 'why'] });
  const g = waitingGroups([posted, open, tiered, dismissed, pr]);
  assert.deepEqual(g.open.map((i) => i.id), ['p2', 'p3', 'pr1'], 'a tier changed still waits for the post');
  assert.deepEqual(g.handled.map((i) => i.id), ['p1', 'f1']);
  assert.equal(HANDLED_HEAD, 'Handled today');
});
