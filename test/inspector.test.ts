import assert from 'node:assert/strict';
import { test } from 'node:test';

import { earnedRow, floorDate, floorLink, inspectorEntries } from '../app/src/ui/inspector.js';
import type { Floor, TowerSpec } from '../shared/types.js';

function floor(p: Partial<Floor>): Floor {
  return {
    id: 'acme/site#x',
    repo: 'acme/site',
    kind: 'commits',
    refs: [],
    title: 't',
    at: '2025-03-04T10:00:00Z',
    era: 'stone',
    size: 'small',
    lines: 1,
    claude: false,
    founding: true,
    url: null,
    ...p,
  };
}

test('a PR floor links to its own url', () => {
  const l = floorLink(floor({ kind: 'pr', refs: ['#42'], url: 'https://github.com/acme/site/pull/42' }));
  assert.deepEqual(l, { text: '#42', href: 'https://github.com/acme/site/pull/42', more: 0 });
});

test('a single commit links to the commit', () => {
  const l = floorLink(floor({ refs: ['abc1234'] }));
  assert.equal(l.href, 'https://github.com/acme/site/commit/abc1234');
});

test('a commit range links to the compare view with three dots', () => {
  const l = floorLink(floor({ refs: ['abc1234..def5678'] }));
  assert.equal(l.href, 'https://github.com/acme/site/compare/abc1234...def5678');
  assert.equal(l.text, 'abc1234..def5678');
});

test('a merged floor links its first ref and counts the rest', () => {
  // The floor url belongs to the later PR, so the first ref (a different PR) gets its own pull link.
  const l = floorLink(floor({ kind: 'pr', refs: ['#7', 'abc1234', '#9'], url: 'https://github.com/acme/site/pull/9' }));
  assert.deepEqual(l, { text: '#7', href: 'https://github.com/acme/site/pull/7', more: 2 });
});

test('a commit-first merged floor links the commit, not the PR url', () => {
  const l = floorLink(floor({ kind: 'pr', refs: ['abc1234', '#9'], url: 'https://github.com/acme/site/pull/9' }));
  assert.equal(l.href, 'https://github.com/acme/site/commit/abc1234');
  assert.equal(l.more, 1);
});

test('floor dates read as month, day, year', () => {
  assert.equal(floorDate('2025-03-04T10:00:00Z'), 'Mar 4, 2025');
  assert.equal(floorDate('not a date'), '');
});

test('a PR url from another repo or host is not trusted', () => {
  const other = floorLink(floor({ kind: 'pr', refs: ['#42'], url: 'https://example.com/acme/site/pull/42' }));
  assert.equal(other.href, 'https://github.com/acme/site/pull/42');
  const sibling = floorLink(floor({ kind: 'pr', refs: ['#42'], url: 'https://github.com/acme/site-fork/pull/42' }));
  assert.equal(sibling.href, 'https://github.com/acme/site/pull/42');
});

// ---------------------------------------------------------------- earned floors (Task 22)

const NAMES = {
  agents: new Map([['priya-rao', 'Priya Rao'], ['ines-ashlar', 'Ines Ashlar']]),
  firms: new Map([['quickset', 'Quickset'], ['ashlar-vane', 'Ashlar & Vane']]),
  inspections: new Map([['run-9', 'insp-abc123']]),
};

function earnedFloor(id: string, state: 'lit' | 'waiting' | 'scar', p: Partial<Floor> = {}): Floor {
  return floor({
    id,
    founding: false,
    kind: state === 'scar' ? 'commits' : 'pr',
    refs: state === 'scar' ? [] : ['#300'],
    title: state === 'scar' ? 'Failed inspection: Search index rebuild blocks the API' : 'Customs forms: prefill the IMO number',
    url: state === 'scar' ? null : 'https://github.com/acme/site/pull/300',
    earned: { jobId: 'job-1', runId: state === 'scar' ? 'run-9' : 'run-1', agentId: state === 'scar' ? 'ines-ashlar' : 'priya-rao', firmId: state === 'scar' ? 'ashlar-vane' : 'quickset', state, reverted: false },
    ...p,
  });
}

test('earned floors list with agent, firm and job', () => {
  const lit = earnedRow(earnedFloor('acme/site#job-job-1', 'lit'), NAMES);
  assert.equal(lit.agent, 'Priya Rao');
  assert.equal(lit.firm, 'Quickset');
  assert.equal(lit.job, 'Customs forms: prefill the IMO number');
  assert.deepEqual(lit.pr, { text: '#300', href: 'https://github.com/acme/site/pull/300' });
  assert.equal(lit.failed, false);
  assert.equal(lit.report, null);

  const scar = earnedRow(earnedFloor('acme/site#scar-run-9', 'scar'), NAMES);
  assert.equal(scar.failed, true);
  assert.equal(scar.state, 'Failed inspection');
  // The job title stands without the engine's prefix; the words come from the state.
  assert.equal(scar.job, 'Search index rebuild blocks the API');
  assert.equal(scar.agent, 'Ines Ashlar');
  assert.equal(scar.firm, 'Ashlar & Vane');
  assert.equal(scar.pr, null);
  assert.equal(scar.report, '#/inspections/insp-abc123');

  const waiting = earnedRow(earnedFloor('acme/site#job-job-2', 'waiting'), NAMES);
  assert.equal(waiting.state, 'Waiting on your review');

  const his = earnedRow(earnedFloor('acme/site#job-job-3', 'lit', { earned: { jobId: 'job-3', runId: 'run-3', agentId: 'priya-rao', firmId: 'quickset', state: 'lit', reverted: false, note: 'merged with his changes' } }), NAMES);
  assert.equal(his.state, 'Merged with your changes');

  // Names not known yet (the firms have not loaded): the ids stand in, never blank.
  const bare = earnedRow(earnedFloor('acme/site#job-job-4', 'lit'), { agents: new Map(), firms: new Map(), inspections: new Map() });
  assert.equal(bare.agent, 'priya-rao');
  assert.equal(bare.firm, 'quickset');
  // A scar whose inspection is not known yet links to its run.
  const early = earnedRow(earnedFloor('acme/site#scar-run-9', 'scar'), { agents: new Map(), firms: new Map(), inspections: new Map() });
  assert.equal(early.report, '#/runs/run-9');
});

test('the earned floors list under their own heading above the datum, the founding floors below it', () => {
  const founding = [floor({ id: 'a#1', era: 'stone' }), floor({ id: 'a#2', era: 'brick' })];
  const spec: TowerSpec = {
    id: 'acme/site#founding',
    repo: 'acme/site',
    kind: 'founding',
    root: 'roman',
    floors: [...founding, earnedFloor('acme/site#job-job-1', 'lit'), earnedFloor('acme/site#scar-run-9', 'scar')],
    datumIndex: 2,
  };
  const kinds = inspectorEntries(spec).map((e) => (e.type === 'floor' ? `floor:${e.floor.id}` : e.type === 'heading' ? `heading:${e.text}` : e.type));
  assert.deepEqual(kinds, [
    'heading:Built in the market',
    'floor:acme/site#scar-run-9',
    'floor:acme/site#job-job-1',
    'datum',
    'heading:Brick era',
    'floor:a#2',
    'heading:Stone era',
    'floor:a#1',
    'root',
  ]);
  // A tower with no earned floors keeps the datum on top, as before.
  const plain = inspectorEntries({ ...spec, floors: founding });
  assert.equal(plain[0].type, 'datum');
});
