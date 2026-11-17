/**
 * The command palette's ranking (Phase 5): prefix, then word start, then
 * substring, then a light fuzzy match; ties by kind and recency; the most
 * recent picks rise on an empty query.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchTier, rank, rememberPick, tallyLine, type PaletteEntry, type RecentPick } from '../app/src/ui/palette-rank.js';

const entry = (kind: string, name: string, keys: string[] = []): PaletteEntry => ({ key: `${kind}:${name}`, kind, name, state: '', keys, go() {} });
const KINDS = ['screen', 'repo', 'firm', 'agent', 'job'];
const names = (list: PaletteEntry[]): string[] => list.map((e) => e.name);

test('a match is graded prefix, word start, substring, fuzzy, none', () => {
  assert.equal(matchTier('har', 'harbor-ledger'), 4, 'prefix');
  assert.equal(matchTier('led', 'harbor-ledger'), 3, 'word start after a hyphen');
  assert.equal(matchTier('ledg', 'Harbor Ledger'), 3, 'word start after a space, any case');
  assert.equal(matchTier('rbo', 'harbor-ledger'), 2, 'substring');
  assert.equal(matchTier('hbl', 'harbor-ledger'), 1, 'fuzzy: letters in order within a short span');
  assert.equal(matchTier('zq', 'harbor-ledger'), 0, 'none');
  assert.equal(matchTier('', 'anything'), 4, 'an empty query matches everything as a prefix');
});

test('the fuzzy match is light: scattered letters across a long name do not count', () => {
  assert.equal(matchTier('hr', 'harbor-ledger'), 1, 'two letters close together');
  assert.equal(matchTier('hdr', 'the harbor of a distant republic reborn'), 0, 'letters strewn over a long name');
  assert.equal(matchTier('x', 'harbor-ledger'), 0, 'one letter only matches as a prefix, word start or substring');
});

test('a query of several words needs every word, graded by the weakest', () => {
  assert.equal(matchTier('harbor ledger', 'harbor-ledger'), 3, 'both words start words');
  assert.equal(matchTier('ledger harbor', 'harbor-ledger'), 3, 'in any order');
  assert.equal(matchTier('harbor quay', 'harbor-ledger'), 0, 'a word that matches nothing fails the query');
});

test('ranking is prefix, then word start, then substring, then fuzzy', () => {
  const list = [entry('repo', 'ledgerharbors'), entry('repo', 'north-harbor'), entry('repo', 'harbor-ledger'), entry('repo', 'hoarbor')];
  assert.deepEqual(names(rank('har', list, [], KINDS)), ['harbor-ledger', 'north-harbor', 'ledgerharbors', 'hoarbor']);
  assert.deepEqual(names(rank('zzz', list, [], KINDS)), []);
});

test('ties break by kind order, then by recency, then by name', () => {
  const list = [entry('job', 'Harbor fix'), entry('firm', 'Harbor & Sons'), entry('repo', 'harbor-two'), entry('repo', 'harbor-one'), entry('screen', 'Harbor')];
  assert.deepEqual(names(rank('har', list, [], KINDS)), ['Harbor', 'harbor-one', 'harbor-two', 'Harbor & Sons', 'Harbor fix']);
  const recent: RecentPick[] = [{ key: 'repo:harbor-two', at: 10 }];
  assert.deepEqual(names(rank('har', list, recent, KINDS)), ['Harbor', 'harbor-two', 'harbor-one', 'Harbor & Sons', 'Harbor fix'], 'a recent pick rises within its tier and kind');
});

test('a kind a source adds later still ranks: unknown kinds sort after the known, by name', () => {
  const list = [entry('voyage', 'harbor voyage'), entry('repo', 'harbor-one'), entry('graduate', 'harbor graduate')];
  assert.deepEqual(names(rank('har', list, [], KINDS)), ['harbor-one', 'harbor graduate', 'harbor voyage']);
});

test('other words an entry answers to match, but never above its own name', () => {
  const list = [entry('repo', 'acme/ledger', ['ledger', 'acme']), entry('firm', 'Ledgerwrights')];
  assert.deepEqual(names(rank('ledg', list, [], KINDS)), ['Ledgerwrights', 'acme/ledger'], 'a prefix of the name beats a prefix of a key, whatever the kind order');
  assert.deepEqual(names(rank('acme', list, [], KINDS)), ['acme/ledger']);
  const jobs = [entry('job', 'Harbor map', ['harbor-ledger']), entry('job', 'Add tests', ['harbor-ledger']), entry('repo', 'tidewater/harbor-ledger', ['harbor-ledger', 'tidewater'])];
  assert.deepEqual(names(rank('har', jobs, [], KINDS)), ['Harbor map', 'tidewater/harbor-ledger', 'Add tests'], 'a job found only by its repo sits below the district itself, which a word of its own name answers for');
});

test('on an empty query the most recent picks come first, newest first, then everything by kind in its source\'s order', () => {
  const list = [entry('job', 'Fix the quay'), entry('repo', 'b-repo'), entry('repo', 'a-repo'), entry('screen', 'Jobs'), entry('firm', 'Wrights')];
  const recent: RecentPick[] = [{ key: 'firm:Wrights', at: 5 }, { key: 'job:Fix the quay', at: 9 }, { key: 'repo:gone', at: 12 }];
  assert.deepEqual(names(rank('', list, recent, KINDS)), ['Fix the quay', 'Wrights', 'Jobs', 'b-repo', 'a-repo']);
  assert.deepEqual(names(rank('   ', list, recent, KINDS)), ['Fix the quay', 'Wrights', 'Jobs', 'b-repo', 'a-repo'], 'blank is empty');
});

test('a pick is remembered newest first, once, and the list is capped', () => {
  let r: RecentPick[] = [];
  r = rememberPick(r, 'a', 1);
  r = rememberPick(r, 'b', 2);
  r = rememberPick(r, 'a', 3);
  assert.deepEqual(r, [{ key: 'a', at: 3 }, { key: 'b', at: 2 }]);
  for (let i = 0; i < 20; i++) r = rememberPick(r, `k${i}`, 10 + i);
  assert.equal(r.length, 8);
  assert.equal(r[0].key, 'k19');
});

test('the empty state counts what the city holds in one quiet line', () => {
  assert.equal(tallyLine([[4, 'district'], [212, 'floor'], [3, 'firm'], [11, 'agent']]), 'The city holds 4 districts and 212 floors, 3 firms and 11 agents.');
  assert.equal(tallyLine([[1, 'district'], [8, 'floor'], [0, 'firm'], [0, 'agent']]), 'The city holds 1 district and 8 floors.');
  assert.equal(tallyLine([[0, 'district'], [0, 'floor'], [0, 'firm'], [0, 'agent']]), 'The city is empty so far. Connect a repo to raise its first district.');
  assert.equal(tallyLine([[2, 'firm'], [3, 'agent']]), 'The city holds 2 firms and 3 agents.');
});
