/**
 * The firm and agent pages' view logic (Task 38): how long a firm below
 * zero has left, its books folded for reading with the balance kept exact,
 * the floors it built and the towers sold out of its quarter, a round said
 * in a line, the step line the reputation is drawn as, and an agent's
 * workflow and lineage in words.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bankruptIn, bookLines, figure, floorsBuilt, lineageWords, roundWords, soldTowers, stepPath, workflowWords } from '../app/src/ui/story.js';
import type { Agent, Bid, BookRow, Floor, FirmRound, Quarter, TowerSpec } from '../shared/types.js';

const H = 3_600_000;

test('a firm below zero has 72 hours, counted down in whole hours', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  assert.equal(bankruptIn(null, now), null);
  assert.equal(bankruptIn(new Date(now).toISOString(), now), 72);
  assert.equal(bankruptIn(new Date(now - 40.5 * H).toISOString(), now), 32, 'part of an hour left counts as an hour');
  assert.equal(bankruptIn(new Date(now - 80 * H).toISOString(), now), 0);
});

const row = (kind: string, delta: number, balance: number, extra: Partial<BookRow> = {}): BookRow => ({ at: '2026-11-10T09:00:00.000Z', kind, delta, balance, runId: null, jobId: null, agentId: null, title: null, ...extra });

test('the books fold each run of bid costs into one line, and keep every balance exact', () => {
  const names = { agent: (id: string) => ({ 'dagny-hollis': 'Dagny Hollis' })[id] ?? id, firm: (id: string) => id, job: (id: string) => ({ 'job-1': 'Fix the parser' })[id] ?? null };
  const books = [
    row('bid', -0.1, 299.9),
    row('bid', -0.2, 299.7, { at: '2026-11-10T09:30:00.000Z' }),
    row('run', -4.25, 295.45, { jobId: 'job-1' }),
    row('pay', 31.5, 326.95, { jobId: 'job-1' }),
    row('bid', -0.05, 326.9),
    row('hire', -80, 246.9, { agentId: 'dagny-hollis' }),
  ];
  const lines = bookLines(books, names);
  assert.deepEqual(lines.map((l) => l.text), ['Bidding, 2 bids', 'Work on Fix the parser', 'Paid for Fix the parser', 'Bidding, 1 bid', 'Hired Dagny Hollis from the roster']);
  assert.equal(lines[0].delta, -0.3, 'folded in micro-credits');
  assert.equal(lines[0].balance, 299.7, 'a folded line carries the balance its last row left');
  assert.equal(lines[0].at, '2026-11-10T09:30:00.000Z');
  assert.equal(lines.at(-1)!.balance, 246.9, 'the running balance ends at the books’ last balance');
  // Newest first is how the page reads them; the fold is the same either way.
  assert.deepEqual(bookLines(books, names, { newestFirst: true }).map((l) => l.balance), [246.9, 326.9, 326.95, 295.45, 299.7]);
});

const floor = (firmId: string, state: 'lit' | 'scar' | 'waiting'): Floor => ({ id: Math.random().toString(36), repo: 'acme/w', kind: 'pr', refs: [], title: 't', at: '', era: 'glass', size: 'small', lines: 1, claude: true, founding: false, url: null, earned: { jobId: 'j', runId: 'r', agentId: 'a', firmId, state, reverted: false } });
const tower = (agentId: string, firmId: string, floors: Floor[]): TowerSpec => ({ id: `agent:${agentId}`, repo: '', kind: 'agent', root: 'roman', floors, datumIndex: 0, firmId, agentId });
const quarter = (firmId: string, towers: TowerSpec[]): Quarter => ({ firmId, slot: 1, origin: { x: 0, z: 0 }, root: 'roman', dark: false, towers });

test('floors built count the firm’s lit and waiting floors wherever they stand; a sold tower names its buyer', () => {
  const qs = [quarter('quickset', [tower('mack', 'quickset', [floor('quickset', 'lit'), floor('quickset', 'scar'), floor('quickset', 'waiting')])]), quarter('lodestar', [tower('corin', 'quickset', [floor('lodestar', 'lit'), floor('lodestar', 'lit')])])];
  assert.equal(floorsBuilt(qs, 'quickset'), 2, 'a scar is not a floor built');
  assert.equal(floorsBuilt(qs, 'lodestar'), 2, 'floors stay the builder’s after its tower is sold');
  assert.deepEqual(soldTowers(qs, 'lodestar'), [{ agentId: 'corin', buyer: 'quickset' }]);
  assert.deepEqual(soldTowers(qs, 'quickset'), []);
});

const bid = (firmId: string, ev: number): Bid => ({ id: `b-${firmId}`, jobId: 'j', firmId, agentId: `${firmId}-a`, plan: '', price: 10, confidence: 0.8, calibrated: 0.8, appraisal: null, ev, cost: 0, at: '' });
const round = (won: boolean, mine: Bid, winner: Bid | null, outcome: FirmRound['outcome'] = null): FirmRound => ({ jobId: 'j', title: 'T', repo: 'acme/w', tier: 'normal', value: 60, at: '', won, bid: mine, winner, outcome });

test('a round in a line: won and what became of it, or lost and the EV that lost it', () => {
  const names = { agent: (id: string) => id, firm: (id: string) => ({ kiln: 'Kiln Brothers' })[id] ?? id, job: () => null };
  assert.equal(roundWords(round(true, bid('quickset', 5.63), bid('quickset', 5.63), 'merged'), names), 'Won at an expected value of 5.63; merged.');
  assert.equal(roundWords(round(true, bid('quickset', 5.63), bid('quickset', 5.63), 'live'), names), 'Won at an expected value of 5.63; at work now.');
  assert.equal(roundWords(round(false, bid('quickset', 3.42), bid('kiln', 12)), names), 'Lost to Kiln Brothers: 3.42 against 12.');
  assert.equal(roundWords(round(false, bid('quickset', -2), null), names), 'Nobody won: no bid was worth its price (this one -2).');
});

test('the reputation line is drawn as steps between its points, inside its box', () => {
  const d = stepPath([{ t: 0, v: 0.5 }, { t: 10, v: 1 }, { t: 20, v: 0.75 }], { w: 200, h: 100, t0: 0, t1: 20, v0: 0, v1: 1 });
  assert.equal(d, 'M0 50H100V0H200V25');
  assert.equal(stepPath([], { w: 200, h: 100, t0: 0, t1: 1, v0: 0, v1: 1 }), '');
  // One point holds flat to the right edge.
  assert.equal(stepPath([{ t: 5, v: 1 }], { w: 100, h: 10, t0: 0, t1: 10, v0: 0, v1: 1 }), 'M50 0H100');
});

test('workflow shapes and lineage, in words', () => {
  assert.match(workflowWords('vote', 3), /three plans/i);
  assert.match(workflowWords('self-check'), /checks its own work/i);
  assert.match(workflowWords('plan-then-answer'), /plan/i);
  assert.match(workflowWords('single'), /one pass/i);
  const a = { lineage: { origin: 'roster', parents: [], generation: 0, at: '2026-11-09T15:00:12.227Z' } } as unknown as Agent;
  assert.equal(lineageWords(a), 'Hired from the roster on 9 November 2026.');
  assert.equal(lineageWords({ lineage: { ...a.lineage, origin: 'seeded' } } as Agent), 'Seeded with the city on 9 November 2026.');
  assert.equal(lineageWords({ lineage: { ...a.lineage, origin: 'school', generation: 2 } } as Agent), 'Bred in the school on 9 November 2026, generation 2.');
});

test('a sum of credits reads as the books set it', () => {
  assert.equal(figure(606.18), '606.18');
  assert.equal(figure(300), '300.00');
  assert.equal(figure(-419.42), '−419.42');
  assert.equal(figure(12345.6), '12,345.60');
});
