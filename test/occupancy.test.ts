import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ambientCap } from '../app/src/city/collar.js';
import { standingLots } from '../app/src/city/lots.js';
import { occupancy, plazasOf, type RepoState } from '../app/src/city/occupancy.js';
import { DISTRICT_PITCH, districtOrigin, QUARTER_COURT } from '../shared/district-layout.js';
import { agentRootHeight, ROOT_HEIGHT } from '../shared/tower-layout.js';
import type { District, Quarter } from '../shared/types.js';

const PITCH = DISTRICT_PITCH / 3;

const district = (repo: string, slot: number): District => ({
  repo,
  index: slot,
  origin: districtOrigin(slot),
  tower: { id: `${repo}#founding`, repo, kind: 'founding', root: 'gothic', floors: [], datumIndex: 0 },
});

const state = (fullName: string, slot: number, connected: boolean, status: RepoState['status']): RepoState => ({ fullName, slot, connected, status });

test('a connected repo with a tower is a district', () => {
  const occ = occupancy([state('a/one', 0, true, 'ready')], [district('a/one', 0)]);
  assert.deepEqual(occ.districts.map((d) => d.repo), ['a/one']);
  assert.deepEqual(occ.sites, []);
});

test('a connected repo analyzing for the first time is a site', () => {
  const occ = occupancy([state('a/one', 3, true, 'analyzing')], []);
  assert.deepEqual(occ.districts, []);
  assert.deepEqual(occ.sites, [{ repo: 'a/one', origin: districtOrigin(3) }]);
});

test('a repo re-analyzing with a tower keeps its district and raises no scaffold', () => {
  const occ = occupancy([state('a/one', 0, true, 'analyzing')], [district('a/one', 0)]);
  assert.equal(occ.districts.length, 1);
  assert.deepEqual(occ.sites, []);
});

test('a connect stopped before any tower (disconnected while analyzing) occupies nothing', () => {
  const occ = occupancy([state('a/one', 4, false, 'analyzing')], []);
  assert.deepEqual(occ.districts, []);
  assert.deepEqual(occ.sites, []);
});

test('a disconnected or toggled off repo occupies nothing, even while a stale city still lists its tower', () => {
  const occ = occupancy([state('a/one', 0, false, 'ready'), state('a/two', 1, true, 'ready')], [district('a/one', 0), district('a/two', 1)]);
  assert.deepEqual(occ.districts.map((d) => d.repo), ['a/two']);
});

test('a connected repo that failed before any tower occupies nothing', () => {
  const occ = occupancy([state('a/one', 2, true, 'error')], []);
  assert.deepEqual(occ.districts, []);
  assert.deepEqual(occ.sites, []);
});

test('a district for a repo the page has not read yet still stands (the engine lists only connected ones)', () => {
  const occ = occupancy([], [district('a/one', 0)]);
  assert.equal(occ.districts.length, 1);
});

test('plazas are the occupied plots only: districts carry their root height, sites none', () => {
  const occ = occupancy(
    [state('a/one', 0, true, 'ready'), state('a/two', 1, true, 'analyzing'), state('a/three', 2, false, 'ready')],
    [district('a/one', 0), district('a/three', 2)],
  );
  assert.deepEqual(plazasOf(occ), [
    { ...districtOrigin(0), rootHeight: ROOT_HEIGHT.gothic },
    { ...districtOrigin(1) },
  ]);
});

/** The blocks within reach of a slot's plot, as (i, j) block coordinates. */
function blocksAround(slot: number): Array<[number, number]> {
  const o = districtOrigin(slot);
  const ci = Math.round(o.x / PITCH);
  const cj = Math.round(o.z / PITCH);
  const out: Array<[number, number]> = [];
  for (let i = ci - 4; i <= ci + 4; i++) for (let j = cj - 4; j <= cj + 4; j++) out.push([i, j]);
  return out;
}

const CIVIC = { x: 0, z: 0 };

test('a district clears ambient blocks from its plot', () => {
  const occ = occupancy([state('a/one', 4, true, 'ready')], [district('a/one', 4)]);
  const o = districtOrigin(4);
  const [i, j] = [Math.round(o.x / PITCH), Math.round(o.z / PITCH)];
  assert.equal(standingLots(i, j, [CIVIC, ...plazasOf(occ)]).length, 0);
  assert.ok(standingLots(i, j, [CIVIC]).length > 0, 'the plot has blocks when nothing reserves it');
});

test('a freed plot is filled with the same blocks that stood there before the district existed', () => {
  const others = [state('a/zero', 0, true, 'ready')];
  const before = plazasOf(occupancy(others, [district('a/zero', 0)]));
  // Disconnected with a tower kept, a connect stopped mid-analysis, a first analysis that failed.
  const cases: Array<[string, RepoState, District[]]> = [
    ['disconnected', state('a/four', 4, false, 'ready'), [district('a/four', 4)]],
    ['stopped', state('a/four', 4, false, 'analyzing'), []],
    ['failed', state('a/four', 4, true, 'error'), []],
  ];
  for (const [what, freed, towers] of cases) {
    const after = plazasOf(occupancy([...others, freed], [district('a/zero', 0), ...towers]));
    for (const [i, j] of blocksAround(4)) {
      assert.deepEqual(standingLots(i, j, [CIVIC, ...after]), standingLots(i, j, [CIVIC, ...before]), `block ${i},${j} with a ${what} repo`);
    }
  }
});

test('the collar cap lifts over a freed plot', () => {
  const o = districtOrigin(4);
  const occupied = plazasOf(occupancy([state('a/four', 4, true, 'ready')], [district('a/four', 4)]));
  const freed = plazasOf(occupancy([state('a/four', 4, false, 'ready')], [district('a/four', 4)]));
  const x = o.x + 120;
  assert.ok(ambientCap(x, o.z, [CIVIC, ...occupied]) < ROOT_HEIGHT.gothic);
  assert.equal(ambientCap(x, o.z, [CIVIC, ...freed]), ambientCap(x, o.z, [CIVIC]));
});

// ---------------------------------------------------------------- quarters (Task 24)

const quarter = (firmId: string, slot: number, towers: number, dark = false): Quarter => ({
  firmId,
  slot,
  origin: districtOrigin(slot),
  root: 'chicago',
  dark,
  towers: Array.from({ length: towers }, (_, i) => ({
    id: `agent:${firmId}-${i}`,
    repo: '',
    kind: 'agent' as const,
    root: 'chicago' as const,
    floors: [],
    datumIndex: 0,
    firmId,
    agentId: `${firmId}-${i}`,
    dark,
    towerIndex: i,
  })),
});

test('occupancy includes quarters and keeps districts unchanged', () => {
  const repos = [state('a/one', 0, true, 'ready'), state('a/two', 1, true, 'analyzing')];
  const ds = [district('a/one', 0)];
  const without = occupancy(repos, ds);
  const occ = occupancy(repos, ds, [quarter('quickset', 6, 3), quarter('lodestar', 7, 1, true), quarter('gone', 8, 0)]);
  assert.deepEqual(occ.districts, without.districts);
  assert.deepEqual(occ.sites, without.sites);
  // A quarter stands while its firm has any tower, dark or not.
  assert.deepEqual(occ.quarters.map((q) => q.firmId), ['quickset', 'lodestar']);
  assert.deepEqual(without.quarters, []);
  // Its plaza is a court, under the collar like a district's, below the agents' roots.
  const plazas = plazasOf(occ);
  assert.equal(plazas.length, 4);
  const court = plazas.find((p) => p.x === districtOrigin(6).x && p.z === districtOrigin(6).z)!;
  assert.equal(court.court, QUARTER_COURT);
  assert.equal(court.rootHeight, agentRootHeight('chicago'));
  assert.equal(court.towers, 0b0111, 'which plots of the quarter stand');
});

test('a quarter on a slot a district holds never stands over it', () => {
  const occ = occupancy([state('a/one', 6, true, 'ready')], [district('a/one', 6)], [quarter('quickset', 6, 2)]);
  assert.deepEqual(occ.districts.map((d) => d.repo), ['a/one']);
  assert.deepEqual(occ.quarters, []);
});

test('a freed quarter is filled with the same blocks that stood there before the firm, and the collar lifts', () => {
  const others = [state('a/zero', 0, true, 'ready')];
  const before = plazasOf(occupancy(others, [district('a/zero', 0)]));
  const standing = plazasOf(occupancy(others, [district('a/zero', 0)], [quarter('kiln', 9, 2)]));
  const freed = plazasOf(occupancy(others, [district('a/zero', 0)], [quarter('kiln', 9, 0)]));
  const o = districtOrigin(9);
  let cleared = 0;
  for (const [i, j] of blocksAround(9)) {
    assert.deepEqual(standingLots(i, j, [CIVIC, ...freed]), standingLots(i, j, [CIVIC, ...before]), `block ${i},${j}`);
    cleared += standingLots(i, j, [CIVIC, ...before]).length - standingLots(i, j, [CIVIC, ...standing]).length;
  }
  assert.ok(cleared > 0, 'a standing quarter clears its court');
  const x = o.x + 100;
  assert.ok(ambientCap(x, o.z, [CIVIC, ...standing]) < agentRootHeight('chicago'));
  assert.equal(ambientCap(x, o.z, [CIVIC, ...freed]), ambientCap(x, o.z, [CIVIC, ...before]));
});
