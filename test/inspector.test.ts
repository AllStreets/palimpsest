import assert from 'node:assert/strict';
import { test } from 'node:test';

import { campusSections, earnedRow, floorDate, floorLink, inspectorEntries, type CampusInspectorView } from '../app/src/ui/inspector.js';
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

// ---------------------------------------------------------------- the campus (Phase 4 Task 37)

test('the inspector lists the live voyage', () => {
  const view: CampusInspectorView = {
    voyage: { id: 'voy-1', arena: 'arena-harbor-1', repo: 'tidewater/harbor-ledger', status: 'sailing', generation: 2, of: 4, runs: { done: 137, of: 480 }, racing: 8, commissionedBy: 'quickset', startedAt: '2026-11-11T22:00:00Z' },
    nets: [
      { net: 'appraiser', version: 6, trusted: true, at: '2026-11-12T20:00:00Z' },
      { net: 'router', version: 2, trusted: false, at: null },
    ],
    graduates: [{ id: 'mlx:grad-qwen25c7-1', model: 'mlx:grad-qwen25c7-1', base: 'qwen2.5-coder:7b', agentId: 'grad-1', at: '2026-11-12T05:00:00Z', vsBase: { diff: 0.14, lo: 0.06, hi: 0.22 }, examples: 212 }],
    bays: 14,
  };
  const names = { agents: new Map([['grad-1', 'Quill Bennet']]), firms: new Map([['quickset', 'Quickset']]), inspections: new Map() };
  const sections = campusSections(view, names);
  assert.deepEqual(sections.map((s) => s.heading), ['Sailing now', 'Trained nets', 'Graduates']);
  const [voyage, nets, grads] = sections;
  assert.equal(voyage.rows.length, 1);
  assert.equal(voyage.rows[0].title, 'A voyage on harbor-ledger');
  assert.equal(voyage.rows[0].meta, 'generation 2 of 4, 137 of 480 runs');
  assert.equal(voyage.rows[0].state, '8 genomes racing, 8 of 14 reading-room bays lit. Commissioned by Quickset.');
  assert.equal(voyage.rows[0].href, '#/school/voyages/voy-1');
  assert.equal(nets.count, '2');
  assert.deepEqual(nets.rows.map((r) => [r.title, r.meta]), [['Appraiser', 'version 6, trusted'], ['Router', 'version 2, trained but not yet trusted']]);
  assert.equal(nets.rows[0].state, 'Nov 12, 2026');
  assert.equal(grads.rows[0].title, 'Quill Bennet');
  assert.equal(grads.rows[0].meta, 'mlx:grad-qwen25c7-1 on qwen2.5-coder:7b, 212 examples');
  assert.equal(grads.rows[0].state, 'Beat its base by 0.14 [0.06, 0.22] on the sealed race.');
  assert.equal(grads.rows[0].href, '#/agents/grad-1');
  // Paused for the night, the bays are dark and the sentence says so.
  const paused = campusSections({ ...view, voyage: { ...view.voyage!, status: 'paused', commissionedBy: null } }, names)[0];
  assert.equal(paused.rows[0].state, 'Paused for the night, the reading room dark.');
  // Nothing yet: each section says so plainly, in words rather than an empty list.
  const empty = campusSections({ voyage: null, nets: [], graduates: [], bays: 14 }, names);
  assert.equal(empty[0].rows.length, 0);
  assert.equal(empty[0].empty, 'No voyage sails tonight. The reading room is dark.');
  assert.equal(empty[1].empty, 'No net has trained yet.');
  assert.equal(empty[2].empty, 'No graduate yet. An adapter graduates only when it beats its base on a sealed race.');
  // A graduate not yet hired is named by its model.
  const unhired = campusSections({ ...view, graduates: [{ ...view.graduates[0], agentId: null }] }, names)[2];
  assert.equal(unhired.rows[0].title, 'mlx:grad-qwen25c7-1');
  assert.equal(unhired.rows[0].href, null);
});
