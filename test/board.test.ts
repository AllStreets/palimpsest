/**
 * The job board's view logic (Task 36): which section each job stands in,
 * the words for a run's progress and a round's clock, the order of the bids
 * and the clean-up of text that comes from GitHub.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOARD_SOURCES, bidOrder, boardSections, cleanText, closesIn, eligible, excerpt, githubUrl, HIDDEN, money, pct, progressWords, sectionCount, stageOf } from '../app/src/ui/board.js';
import type { Bid, Job, Repo, RunProgress } from '../shared/types.js';

const NOW = Date.parse('2026-11-10T15:00:00');

function job(id: string, status: Job['status'], patch: Partial<Job> = {}): Job {
  return {
    id,
    repo: 'tidewater/harbor-ledger',
    source: 'issue',
    issue: 1,
    url: null,
    title: id,
    body: '',
    scope: [],
    acceptance: [],
    tier: 'normal',
    value: 60,
    status,
    attempts: 0,
    postedAt: new Date(NOW - 3_600_000).toISOString(),
    bidsCloseAt: null,
    awardedBid: null,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
    ...patch,
  };
}

const repo = (fullName: string, patch: Partial<Repo> = {}): Repo =>
  ({ fullName, connected: true, market: true, halted: null, strikes: 0, ...patch }) as Repo;

test('every job stands in one section, in the order he reads them', () => {
  const today = new Date(NOW - 2 * 3_600_000).toISOString();
  const yesterday = new Date(NOW - 26 * 3_600_000).toISOString();
  const jobs = [
    job('p', 'proposed', { source: 'harness' }),
    job('o', 'open'),
    job('b', 'bidding', { bidsCloseAt: new Date(NOW + 60_000).toISOString() }),
    job('a', 'awarded'),
    job('r', 'running'),
    job('i', 'inspecting'),
    job('s', 'shipping'),
    job('w', 'waiting'),
    job('m', 'merged', { closedAt: today }),
    job('m-old', 'merged', { closedAt: yesterday }),
    job('c', 'closed', { closedAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
    job('f', 'failed', { closedAt: today, attempts: 2 }),
    job('h', 'halted', { haltedFrom: 'open' }),
    job('x', 'withdrawn'),
  ];
  const s = boardSections(jobs, [repo('tidewater/harbor-ledger')], NOW);
  assert.deepEqual(
    s.map((x) => [x.key, x.jobs.map((j) => j.id)]),
    [
      ['proposed', ['p']],
      ['bidding', ['b', 'o']],
      ['running', ['r', 'i', 's', 'a']],
      ['waiting', ['w']],
      ['done', ['m', 'c']],
      ['failed', ['f']],
      ['halted', ['h']],
    ],
  );
});

test('the board filters by repo and names the halted repos even with no job', () => {
  const jobs = [job('a', 'bidding'), job('b', 'bidding', { repo: 'hoshi/kumo' })];
  const repos = [repo('tidewater/harbor-ledger'), repo('hoshi/kumo'), repo('kestrel/fieldnotes', { halted: { at: '2026-11-09T10:00:00Z', reason: 'A city merge was reverted' } })];
  const s = boardSections(jobs, repos, NOW, 'hoshi/kumo');
  assert.deepEqual(s.map((x) => [x.key, x.jobs.map((j) => j.id)]), [['bidding', ['b']]]);
  const all = boardSections(jobs, repos, NOW);
  const halted = all.find((x) => x.key === 'halted');
  assert.deepEqual(halted?.repos.map((r) => r.fullName), ['kestrel/fieldnotes']);
  assert.equal(boardSections(jobs, repos, NOW, 'kestrel/fieldnotes').find((x) => x.key === 'halted')?.repos.length, 1);
});

test('a failed job stays on the board for a week', () => {
  const old = job('f-old', 'failed', { closedAt: new Date(NOW - 8 * 86_400_000).toISOString() });
  const recent = job('f', 'failed', { closedAt: new Date(NOW - 2 * 86_400_000).toISOString() });
  const s = boardSections([old, recent], [], NOW);
  assert.deepEqual(s.find((x) => x.key === 'failed')?.jobs.map((j) => j.id), ['f']);
});

test('progress is said from the real counts', () => {
  const p = (x: Partial<RunProgress>): RunProgress => ({ toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0, ...x });
  assert.equal(progressWords(p({ toolCalls: 14, testsRun: 2, refusals: 1 })), '14 tool calls, 2 tests run, 1 refused');
  assert.equal(progressWords(p({ toolCalls: 1, filesChanged: 3 })), '1 tool call, 3 files changed');
  assert.equal(progressWords(p({})), 'no tool calls yet');
  assert.equal(progressWords(p({ toolCalls: 41, filesChanged: 2, testsRun: 286, refusals: 2 })), '41 tool calls, 2 files changed, 286 tests run, 2 refused');
});

test('the clock to close counts down and then says it is closing', () => {
  assert.equal(closesIn(new Date(NOW + 84_000).toISOString(), NOW), 'closes in 1:24');
  assert.equal(closesIn(new Date(NOW + 9_400).toISOString(), NOW), 'closes in 0:10');
  assert.equal(closesIn(new Date(NOW + 3_725_000).toISOString(), NOW), 'closes in 62:05');
  assert.equal(closesIn(new Date(NOW - 1000).toISOString(), NOW), 'closing');
  assert.equal(closesIn(null, NOW), 'opens for bids on the next round');
});

test('bids read in the order the award ranks them', () => {
  const bid = (id: string, ev: number, price: number): Bid => ({ id, jobId: 'j', firmId: 'f', agentId: id, plan: '', price, confidence: 0.8, calibrated: 0.7, appraisal: null, ev, cost: 1, at: `2026-11-10T14:00:0${id.length}Z` });
  assert.deepEqual(bidOrder([bid('a', 10, 30), bid('bb', 22, 20), bid('c', 22, 18)]).map((b) => b.id), ['c', 'bb', 'a']);
});

test('stage words follow the run, not the job alone', () => {
  assert.equal(stageOf(job('a', 'awarded'), null), 'Awarded, waiting for the site');
  assert.equal(stageOf(job('r', 'running'), 'installing'), 'Installing');
  assert.equal(stageOf(job('r', 'running'), 'working'), 'Working');
  assert.equal(stageOf(job('i', 'inspecting'), 'inspecting'), 'With the inspectors');
  assert.equal(stageOf(job('s', 'shipping'), 'shipping'), 'Opening the pull request');
});

test('text from GitHub is cleaned before it is shown', () => {
  assert.equal(cleanText('Fix‮date\u0007 bucket\n\n  in  days.ts'), 'Fixdate bucket in days.ts');
  assert.equal(cleanText('a'.repeat(30), 10), 'aaaaaaaaa…');
  assert.equal(cleanText(42 as unknown as string), '');
  assert.equal(cleanText('zero​width﻿'), 'zerowidth');
  assert.equal(excerpt('## Steps\n\nArrivals after **midnight UTC** land on [the wrong day](https://x.y/z).\n\nMore.', 200), 'Arrivals after midnight UTC land on the wrong day.');
  assert.equal(excerpt('<!-- template -->\n<img src=x onerror=alert(1)>\n`code` here'), 'code here');
  assert.equal(excerpt(''), '');
});

test('money and chances are set the same everywhere', () => {
  assert.equal(money(38), '38');
  assert.equal(money(38.456), '38.46');
  assert.equal(money(4.5), '4.50');
  assert.equal(pct(0.8), '80%');
  assert.equal(pct(0.716), '72%');
  assert.equal(pct(null), 'no record');
});

test('the board counts the agents that may answer a round as the market does', () => {
  const agent = (id: string, firmId: string, patch: Record<string, unknown> = {}) => ({ id, firmId, name: id, retired: false, bidsOn: ['low', 'normal'], ...patch });
  const firms = [
    { id: 'kiln', status: 'active', agents: [agent('a', 'kiln'), agent('b', 'kiln', { retired: true }), agent('c', 'kiln', { bidsOn: ['high'] })] },
    { id: 'lodestar', status: 'bankrupt', agents: [agent('d', 'lodestar')] },
    { id: 'quickset', status: 'active', agents: [agent('e', 'quickset'), agent('f', 'quickset')] },
  ] as unknown as Parameters<typeof eligible>[1];
  assert.deepEqual(eligible(job('j', 'bidding'), firms).map((a) => a.id), ['a', 'e', 'f']);
  assert.deepEqual(eligible(job('j', 'bidding', { excludedFirms: ['quickset'] }), firms).map((a) => a.id), ['a']);
});

test('only GitHub links leave the page', () => {
  assert.equal(githubUrl('https://github.com/tidewater/harbor-ledger/issues/214'), 'https://github.com/tidewater/harbor-ledger/issues/214');
  assert.equal(githubUrl('javascript:alert(1)'), null);
  assert.equal(githubUrl('https://github.com.evil.example/x'), null);
  assert.equal(githubUrl('http://github.com/x'), null);
  assert.equal(githubUrl('https://github.com/a b'), null);
  assert.equal(githubUrl(null), null);
});

// ---------------------------------------------------------------- Phase 5 Task 17: the screens' parked lines

/** Unicode 16's Default_Ignorable_Code_Point (DerivedCoreProperties.txt), written out, plus every Bidi_Control. */
const IGNORABLE: Array<[number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const BIDI_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

test('HIDDEN strips U+2066 to U+2069 and U+FEFF', () => {
  for (const c of [0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]) assert.equal(cleanText(`a${String.fromCodePoint(c)}b`), 'ab', `U+${c.toString(16).toUpperCase()}`);
});

test("HIDDEN covers every invisible code point in Unicode's Default_Ignorable_Code_Point set plus the bidi controls", () => {
  const missed: string[] = [];
  for (const [lo, hi] of IGNORABLE) {
    for (let c = lo; c <= hi; c++) if (`a${String.fromCodePoint(c)}b`.replace(HIDDEN, '') !== 'ab') missed.push(`U+${c.toString(16).toUpperCase()}`);
  }
  for (const c of BIDI_CONTROLS) if (`a${String.fromCodePoint(c)}b`.replace(HIDDEN, '') !== 'ab') missed.push(`U+${c.toString(16).toUpperCase()}`);
  assert.deepEqual(missed.slice(0, 12), [], `${missed.length} invisible code points pass`);
  // A tag character hides a whole message after an ordinary word; it goes too.
  assert.equal(cleanText('Fix the date\u{E0049}\u{E0047}\u{E004E}'), 'Fix the date');
  // Ordinary letters, digits, spaces and visible symbols stay, including ones from the same blocks.
  assert.equal(cleanText('Ola Bergström: café 12 → 3, ㅎ ᅡ'), 'Ola Bergström: café 12 → 3, ㅎ ᅡ');
});

test('the board header counts grouped rows as shown', () => {
  const section = (key: 'proposed' | 'bidding' | 'halted', n: number, repos = 0) => ({
    key,
    title: key,
    jobs: Array.from({ length: n }, (_, i) => job(`j${i}`, key === 'halted' ? 'halted' : key === 'proposed' ? 'proposed' : 'bidding')),
    repos: Array.from({ length: repos }, (_, i) => repo(`o/r${i}`)),
  });
  // Three of the city's identical proposals standing as one grouped row: the header says the row it shows.
  assert.equal(sectionCount(section('proposed', 3), 1), '1 row, 3 jobs');
  assert.equal(sectionCount(section('proposed', 5), 2), '2 rows, 5 jobs');
  // Every job its own row: the count is the jobs.
  assert.equal(sectionCount(section('bidding', 3), 3), '3 jobs');
  assert.equal(sectionCount(section('bidding', 1), 1), '1 job');
  // Halted: the repos, then their jobs.
  assert.equal(sectionCount(section('halted', 2, 1), 3), '1 repo, 2 jobs');
  assert.equal(sectionCount(section('halted', 0, 2), 2), '2 repos');
});

test("the board's source explainer says where its jobs come from", () => {
  assert.match(BOARD_SOURCES, /issues labelled palimpsest/);
  assert.match(BOARD_SOURCES, /the city/);
  assert.match(BOARD_SOURCES, /you/);
  assert.ok(!/[—–]|--/.test(BOARD_SOURCES), 'no dashes');
});
