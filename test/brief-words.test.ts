/**
 * The brief's words (Phase 3 Task 11): the day as the page's title, each
 * action's label, each item's sentence, what he did with an item and when,
 * the usage line with both windows and today's limit, and the empty
 * morning. Pure functions, no DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { actedLine, actionLabel, briefTitle, capBounds, dateline, emptyMorning, itemSentence, sinceLine, usageLine } from '../app/src/ui/brief-words.js';
import type { Brief, BriefAction, BriefItem, BudgetWindow } from '../shared/types.js';

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

test('every action has its label', () => {
  const want: Record<BriefAction, string> = {
    accept: 'Post as a job',
    tier: 'Change the tier',
    dismiss: 'Dismiss',
    why: 'Ask why',
    diff: 'Open the diff',
    fly: 'Fly to the floor',
    retry: 'Retry',
    resume: 'Resume',
    'open-pr': 'Open the PR',
    cap: "Change today's limit",
    audit: 'Audit it',
    tour: 'Walk through the week',
  };
  for (const [a, label] of Object.entries(want)) assert.equal(actionLabel(a as BriefAction), label, a);
});

test('the empty morning is one quiet line', () => {
  assert.equal(emptyMorning(), 'Nothing waits on you this morning');
});

test('a sentence never repeats the repo its dateline names', () => {
  const pr = item({ kind: 'pr', repo: 'hoshi/kumo', text: 'PR #312 on hoshi/kumo by Quickset waits for your review.' });
  assert.equal(itemSentence(pr, names), 'PR #312 by Quickset waits for your review.');
  assert.equal(dateline(pr, Date.parse(pr.at) + 3_600_000), 'kumo, 18:30');
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
  assert.equal(dateline(u, Date.now()), '');
});

test('a recommendation to audit names the repo alone: when it connected is not the news', () => {
  const due = item({ kind: 'audit-due', repo: 'kestrel/fieldnotes', text: 'Its README has not been checked against its code. An audit reads the clone.' });
  assert.equal(dateline(due, Date.now()), 'fieldnotes');
  assert.equal(itemSentence(due, names), 'Its README has not been checked against its code.');
});

test('what he did with an item, and when, in quiet words', () => {
  const at = new Date(2026, 10, 12, 9, 14).toISOString();
  assert.equal(actedLine(item({ kind: 'proposal', acted: { action: 'accept', at } })), 'Posted as a job, 9:14');
  assert.equal(actedLine(item({ acted: { action: 'dismiss', at } })), 'Dismissed, 9:14');
  assert.equal(actedLine(item({ kind: 'failed', acted: { action: 'retry', at } })), 'Posted again, 9:14');
  assert.equal(actedLine(item({ kind: 'halt', acted: { action: 'resume', at } })), 'Resumed, 9:14');
  assert.equal(actedLine(item({ kind: 'proposal', tier: 'low', acted: { action: 'tier', at } })), 'Tier set to low, 9:14');
  assert.equal(actedLine(item({ kind: 'audit-due', acted: { action: 'audit', at } })), 'Audit queued, 9:14');
  assert.equal(actedLine(item({ kind: 'usage', acted: { action: 'cap', at } }), 60), "Today's limit set to 60% by you, 9:14");
  // Looking is not acting: Ask why, the diff, the floor and the PR leave no line.
  for (const a of ['why', 'diff', 'fly', 'open-pr'] as BriefAction[]) assert.equal(actedLine(item({ acted: { action: a, at } })), '', a);
  assert.equal(actedLine(item({})), '');
});

test('the usage line names both windows and today\'s limit, and says when the limit is his', () => {
  assert.equal(usageLine(usage(), 50), 'The five-hour window stands at 45% against today\'s limit of 50%, the usual cap; the seven-day window at 21%.');
  const his = usage({ fiveHour: win({ capPct: 60 }), todayCapPct: 60 });
  assert.equal(usageLine(his, 50), 'The five-hour window stands at 45% against today\'s limit of 60%, set by you until midnight; the seven-day window at 21%.');
  const unread = usage({ fiveHour: win({ usedPct: null, estimatedPct: 0 }), sevenDay: win({ usedPct: null, estimatedPct: 0, capPct: 90 }) });
  assert.match(usageLine(unread, 50), /^No reading of your plan yet;/);
});

test('today\'s limit may rise to five points under the hard stop, never below five', () => {
  assert.deepEqual(capBounds(90), { min: 5, max: 85 });
  assert.deepEqual(capBounds(8), { min: 5, max: 5 });
});

test('the line under the title says the window, and whether this is the day\'s first look', () => {
  const since = new Date(2026, 10, 11, 6, 40).toISOString();
  assert.equal(sinceLine(since, '2026-11-12', true), 'Since yesterday at 6:40.');
  assert.equal(sinceLine(since, '2026-11-12', false), 'Since yesterday at 6:40. You have opened it once already today.');
  assert.equal(sinceLine(new Date(2026, 10, 9, 6, 40).toISOString(), '2026-11-12', true), 'Since Monday at 6:40.');
});
