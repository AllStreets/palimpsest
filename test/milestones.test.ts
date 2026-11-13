/**
 * Milestones (Phase 3 Task 7, ruling 11): the lit spire, the founding
 * finial, a revival and a new firm's ribbon, reached from the floors as the
 * bus emits them, backfilled once from the towers, and the week's tour from
 * the ledger. Every test emits on the real bus and reads the rows and the
 * ledger. Temp home only; no model, no gh.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit } from '../engine/events.js';
import { query, record } from '../engine/ledger.js';
import { agentTowerId } from '../engine/market/firms.js';
import { backfillMilestones, installMilestones, listMilestones, milestonesOf, weekTour } from '../engine/market/milestones.js';
import { layEarnedFloor, updateEarnedFloor } from '../engine/repos.js';
import { LIGHTS_DAYS, QUIET_DAYS, RIBBON_DAYS } from '../shared/market-rules.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Floor, FloorSize, Job, Milestone, Repo, TowerSpec } from '../shared/types.js';
import { addAgent, addFirm, checks, setUp, tearDown } from './guild-fixtures.js';

const DAY = 24 * 3_600_000;
/** A Wednesday afternoon, local time. */
const NOW = new Date(2026, 10, 11, 15, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let off: () => void = () => {};
beforeEach(() => {
  setUp('milestones');
  off = installMilestones({ now: () => NOW });
});
afterEach(async () => {
  off();
  await tearDown();
});

function addRepo(full: string, over: Partial<Repo> = {}): Repo {
  const repo: Repo = {
    fullName: full,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-01-01T00:00:00.000Z',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
    checks: checks(),
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

function floor(id: string, repo: string, at: number, size: FloorSize, earned?: Floor['earned']): Floor {
  return { id, repo, kind: earned ? 'pr' : 'commits', refs: ['abc1234'], title: `Floor ${id}`, at: iso(at), era: 'glass', size, lines: size === 'small' ? 20 : size === 'medium' ? 200 : 800, claude: false, founding: !earned, url: null, ...(earned ? { earned } : {}) };
}

/** A connected repo with `founding` floors below its datum, the newest at `newestAt`. */
function addTower(repo: string, founding: Array<FloorSize>, newestAt = NOW - 200 * DAY, slot = 0): TowerSpec {
  addRepo(repo, { slot });
  const floors = founding.map((size, i) => floor(`${repo}#f${i}`, repo, newestAt - (founding.length - 1 - i) * DAY, size));
  const tower: TowerSpec = { id: `${repo}#founding`, repo, kind: 'founding', root: 'gothic', floors, datumIndex: floors.length };
  openDb().prepare('INSERT OR REPLACE INTO towers (repo, json) VALUES (?, ?)').run(repo, JSON.stringify(tower));
  return tower;
}

const earnedOn = (jobId: string, agentId: string, firmId: string, state: 'waiting' | 'lit' | 'scar'): Floor['earned'] => ({ jobId, runId: `run-${jobId}`, agentId, firmId, state, reverted: false });

/** Lays a job's floor on the repo tower and the agent tower and emits both `floor.laid`, as ship.ts does. */
function layJob(repo: string, jobId: string, agentId: string, firmId: string, size: FloorSize, state: 'waiting' | 'lit', at = NOW): Floor {
  const towerId = `${repo}#founding`;
  const f = layEarnedFloor(towerId, floor(`${repo}#job-${jobId}`, repo, at, size, earnedOn(jobId, agentId, firmId, state)));
  const g = layEarnedFloor(agentTowerId(agentId), floor(`agent:${agentId}#job-${jobId}`, repo, at, size, earnedOn(jobId, agentId, firmId, state)));
  record('floor.laid', { jobId, runId: `run-${jobId}`, towerId, floor: f, size: f.size });
  emit('floor.laid', { towerId, floor: f });
  record('floor.laid', { jobId, runId: `run-${jobId}`, towerId: agentTowerId(agentId), floor: g, size: g.size });
  emit('floor.laid', { towerId: agentTowerId(agentId), floor: g });
  return f;
}

/** Lights a job's floors at `at` and emits both `floor.lit`, as ship.ts does. */
function light(repo: string, jobId: string, agentId: string, at = NOW): Floor {
  let lit: Floor | null = null;
  for (const [towerId, id] of [[`${repo}#founding`, `${repo}#job-${jobId}`], [agentTowerId(agentId), `agent:${agentId}#job-${jobId}`]]) {
    const f = openDb().prepare('SELECT json FROM earned_floors WHERE id = ?').get(id) as { json: string } | undefined;
    assert.ok(f, `${id} is laid`);
    const cur = JSON.parse(f.json) as Floor;
    const next = updateEarnedFloor(id, { at: iso(at), earned: { ...cur.earned!, state: 'lit' } })!;
    if (!lit) lit = next;
    record('floor.lit', { jobId, runId: `run-${jobId}`, towerId, floorId: id, floor: next });
    emit('floor.lit', { towerId, floorId: id, floor: next });
  }
  return lit!;
}

function reached(id?: string): Milestone[] {
  return query({ kind: 'milestone.reached' })
    .map((e) => (e.data as { milestone: Milestone }).milestone)
    .filter((m) => !id || m.id === id);
}

function stored(id: string): Milestone | null {
  const row = openDb().prepare('SELECT json FROM milestones WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Milestone) : null;
}

function firmWithAgent(firmId: string, agentId: string, slot: number): void {
  addFirm(firmId, { slot });
  addAgent(agentId, firmId, 'claude:sonnet');
}

test('a lit floor that gives a tower the greatest earned height moves the lit spire and leaves the old holder unlit', () => {
  // Agent towers compete too (an agent's tower holds its floors from every repo); two agents keep each agent tower level with its district tower, and a level district tower ranks first.
  firmWithAgent('quickset', 'ola', 100);
  addAgent('rin', 'quickset', 'claude:sonnet', { towerIndex: 1 });
  addTower('acme/a', ['small'], NOW - 200 * DAY, 0);
  addTower('acme/b', ['small'], NOW - 200 * DAY, 1);
  // Nothing earned yet: no spire, and nothing in the ledger.
  assert.equal(listMilestones(NOW).filter((m) => m.kind === 'skyline').length, 0);

  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - 2 * DAY);
  assert.equal(reached().filter((m) => m.kind === 'skyline').length, 0, 'a waiting floor is no height yet');
  light('acme/a', 'j1', 'ola', NOW - DAY);
  const a = stored('skyline:acme/a#founding');
  assert.ok(a, 'the first lit earned floor holds the skyline');
  assert.equal(a.kind, 'skyline');
  assert.equal(a.lit, true);
  assert.equal(a.until, null);
  assert.equal(a.repo, 'acme/a');
  assert.equal(a.floorId, 'acme/a#job-j1');
  assert.equal(a.at, iso(NOW - DAY));
  assert.equal(reached('skyline:acme/a#founding').length, 1);

  // A taller earned floor on b takes the spire; a keeps its mast unlit.
  layJob('acme/b', 'j2', 'rin', 'quickset', 'large', 'waiting', NOW - DAY);
  light('acme/b', 'j2', 'rin', NOW);
  const b = stored('skyline:acme/b#founding');
  assert.ok(b);
  assert.equal(b.lit, true);
  assert.equal(b.floorId, 'acme/b#job-j2');
  const passed = stored('skyline:acme/a#founding');
  assert.equal(passed?.lit, false, 'the old holder keeps its spire unlit');
  assert.equal(passed?.until, null);
  // Its words no longer claim the skyline: it held it.
  assert.equal(passed?.title, 'Held the skyline');
  assert.match(passed?.detail ?? '', /^a held the skyline until /);
  assert.doesNotMatch(passed?.detail ?? '', /stands tallest/);
  // The patch writes the row and emits milestone.reached again with the patched row.
  const aRows = reached('skyline:acme/a#founding');
  assert.equal(aRows.length, 2);
  assert.deepEqual(aRows[1], passed);
  assert.equal(reached('skyline:acme/b#founding').length, 1);

  // Both stand in the active list: one lit, one not; the agent tower does not hold the spire (it stands no taller above its datum).
  const active = listMilestones(NOW, { active: true }).filter((m) => m.kind === 'skyline');
  assert.deepEqual(active.map((m) => [m.towerId, m.lit]).sort(), [['acme/a#founding', false], ['acme/b#founding', true]]);
  assert.deepEqual(milestonesOf('acme/b#founding').filter((m) => m.kind === 'skyline').map((m) => m.id), ['skyline:acme/b#founding']);
  // A second lighting on b changes nothing: the holder stays, and no row is written again.
  const before = reached().length;
  emit('floor.lit', { towerId: 'acme/b#founding', floorId: 'acme/b#job-j2' });
  assert.equal(reached().length, before);
  // Every title and detail is plain copy.
  for (const m of reached()) assert.doesNotMatch(`${m.title} ${m.detail}`, /—|–|--|\p{Extended_Pictographic}/u);
});

test('the founding skyline is a separate unlit row', () => {
  firmWithAgent('quickset', 'ola', 100);
  // c is far the tallest tower by total height; a is a stump that earns one floor.
  addTower('acme/a', ['small'], NOW - 200 * DAY, 0);
  addTower('acme/c', ['large', 'large', 'large', 'large', 'large'], NOW - 200 * DAY, 1);
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - DAY);
  light('acme/a', 'j1', 'ola', NOW);

  const spire = stored('skyline:acme/a#founding');
  assert.equal(spire?.lit, true, 'the lit spire measures earned height above the datum');
  const finial = stored('founding-skyline:acme/c#founding');
  assert.ok(finial, 'the tallest tower by total height carries the founding skyline');
  assert.equal(finial.kind, 'founding-skyline');
  assert.equal(finial.lit, false);
  assert.equal(finial.until, null);
  assert.equal(finial.floorId, null);
  assert.equal(stored('founding-skyline:acme/a#founding'), null);
  assert.equal(stored('skyline:acme/c#founding'), null, 'no earned floor, no spire');
  const kinds = listMilestones(NOW, { active: true }).filter((m) => m.kind.endsWith('skyline')).map((m) => `${m.kind}:${m.towerId}`).sort();
  assert.deepEqual(kinds, ['founding-skyline:acme/c#founding', 'skyline:acme/a#founding']);
});

test('a floor on a repo quiet for 100 days reaches a revival for seven days; one quiet 10 days does not', () => {
  firmWithAgent('quickset', 'ola', 100);
  addTower('acme/quiet', ['small', 'medium'], NOW - 100 * DAY, 0);
  addTower('acme/busy', ['small', 'medium'], NOW - 10 * DAY, 1);

  layJob('acme/quiet', 'j1', 'ola', 'quickset', 'small', 'waiting', NOW - 2 * DAY);
  assert.equal(reached().filter((m) => m.kind === 'revival').length, 0, 'a waiting floor is not a revival yet');
  light('acme/quiet', 'j1', 'ola', NOW);
  const r = stored('revival:acme/quiet#job-j1');
  assert.ok(r, 'the first lit floor in 100 days revives the repo');
  assert.equal(r.kind, 'revival');
  assert.equal(r.towerId, 'acme/quiet#founding');
  assert.equal(r.repo, 'acme/quiet');
  assert.equal(r.floorId, 'acme/quiet#job-j1');
  assert.equal(r.at, iso(NOW));
  assert.equal(r.until, iso(NOW + LIGHTS_DAYS * DAY));
  assert.equal(r.lit, true);
  assert.match(r.detail, /100 days/);
  assert.equal(reached('revival:acme/quiet#job-j1').length, 1);

  layJob('acme/busy', 'j2', 'ola', 'quickset', 'small', 'waiting', NOW - DAY);
  light('acme/busy', 'j2', 'ola', NOW);
  assert.equal(reached().filter((m) => m.kind === 'revival').length, 1, 'a repo quiet ten days is not revived');
  // The next floor on the revived repo, a day later, is no second revival.
  layJob('acme/quiet', 'j3', 'ola', 'quickset', 'small', 'waiting', NOW);
  light('acme/quiet', 'j3', 'ola', NOW + DAY);
  assert.equal(reached().filter((m) => m.kind === 'revival').length, 1);

  // The lights stay seven days and are not active after.
  assert.ok(listMilestones(NOW + 6 * DAY, { active: true }).some((m) => m.id === r.id));
  assert.ok(!listMilestones(NOW + 8 * DAY, { active: true }).some((m) => m.id === r.id));
  assert.ok(listMilestones(NOW + 8 * DAY).some((m) => m.id === r.id), 'the row stays in the full list');
});

test("a firm's first waiting floor ribbons it, its lighting dates the ribbon's end, a close ends it now, a bankruptcy ends it now", () => {
  firmWithAgent('quickset', 'ola', 100);
  firmWithAgent('kumo', 'rin', 101);
  firmWithAgent('ashlar', 'ines', 102);
  addTower('acme/a', ['small'], NOW - 30 * DAY, 0);

  // One ribbon per job, on the district tower's floor only (floor.laid fires for the agent tower too).
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - 2 * DAY);
  const ribbons = () => reached().filter((m) => m.kind === 'ribbon');
  assert.equal(ribbons().length, 1);
  const r = stored('ribbon:quickset:j1');
  assert.ok(r);
  assert.equal(r.towerId, 'acme/a#founding');
  assert.equal(r.floorId, 'acme/a#job-j1');
  assert.equal(r.firmId, 'quickset');
  assert.equal(r.agentId, 'ola');
  assert.equal(r.repo, 'acme/a');
  assert.equal(r.until, null);
  assert.equal(r.at, iso(NOW - 2 * DAY));
  assert.match(r.title, /first PR/i);
  assert.match(`${r.title} ${r.detail}`, /Quickset/);
  // Laying the same floor again (a re-ship) does not ribbon it twice.
  emit('floor.laid', { towerId: 'acme/a#founding', floor: JSON.parse((openDb().prepare('SELECT json FROM earned_floors WHERE id = ?').get('acme/a#job-j1') as { json: string }).json) as Floor });
  assert.equal(ribbons().length, 1);

  // Its lighting dates the ribbon's end at seven days after the merge.
  light('acme/a', 'j1', 'ola', NOW - DAY);
  const lit = stored('ribbon:quickset:j1');
  assert.equal(lit?.until, iso(NOW - DAY + RIBBON_DAYS * DAY));
  assert.equal(reached('ribbon:quickset:j1').length, 2, 'the patch emits the row again');
  assert.deepEqual(reached('ribbon:quickset:j1')[1], lit);
  assert.ok(listMilestones(NOW + 5 * DAY, { active: true }).some((m) => m.id === 'ribbon:quickset:j1'));
  assert.ok(!listMilestones(NOW + 7 * DAY, { active: true }).some((m) => m.id === 'ribbon:quickset:j1'));

  // The firm's second PR is not its first.
  layJob('acme/a', 'j2', 'ola', 'quickset', 'small', 'waiting', NOW);
  assert.equal(stored('ribbon:quickset:j2'), null);
  assert.equal(ribbons().length, 2);

  // Kumo's first PR closes without a merge: the ribbon ends now.
  layJob('acme/a', 'j3', 'rin', 'kumo', 'small', 'waiting', NOW - DAY);
  assert.ok(stored('ribbon:kumo:j3'));
  const closed = { id: 'j3', repo: 'acme/a', status: 'closed', title: 'A job', floorId: null } as unknown as Job;
  emit('job.changed', { job: closed, from: 'waiting' });
  assert.equal(stored('ribbon:kumo:j3')?.until, iso(NOW));
  // A later change of the same job writes nothing more.
  const n = reached('ribbon:kumo:j3').length;
  emit('job.changed', { job: { ...closed, status: 'failed' }, from: 'closed' });
  assert.equal(reached('ribbon:kumo:j3').length, n);

  // Ashlar's first PR waits when the firm goes bankrupt: the ribbon comes down now.
  layJob('acme/a', 'j4', 'ines', 'ashlar', 'small', 'waiting', NOW - DAY);
  assert.equal(stored('ribbon:ashlar:j4')?.until, null);
  emit('firm.bankrupt', { firmId: 'ashlar', at: iso(NOW) });
  assert.equal(stored('ribbon:ashlar:j4')?.until, iso(NOW));
  assert.equal(stored('ribbon:kumo:j3')?.until, iso(NOW), "another firm's ribbon is untouched");
  // A ribbon that already ended is not written again by the bankruptcy.
  const before = reached().length;
  emit('firm.bankrupt', { firmId: 'ashlar', at: iso(NOW + DAY) });
  assert.equal(reached().length, before);
});

test('backfill reaches the skyline once and is idempotent', () => {
  off();
  firmWithAgent('quickset', 'ola', 100);
  addTower('acme/a', ['small'], NOW - 200 * DAY, 0);
  addTower('acme/c', ['large', 'large', 'large'], NOW - 200 * DAY, 1);
  // Floors laid and lit while nothing listened (an engine from before milestones).
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - 3 * DAY);
  light('acme/a', 'j1', 'ola', NOW - 2 * DAY);
  layJob('acme/a', 'j2', 'ola', 'quickset', 'small', 'waiting', NOW - 2 * DAY);
  assert.equal(reached().length, 0);

  backfillMilestones(NOW);
  const spire = stored('skyline:acme/a#founding');
  assert.equal(spire?.lit, true);
  assert.equal(spire?.floorId, 'acme/a#job-j1');
  assert.equal(spire?.at, iso(NOW - 2 * DAY), "the spire dates from the floor that earned it, not from the backfill");
  assert.equal(stored('founding-skyline:acme/c#founding')?.lit, false);
  assert.equal(stored('ribbon:quickset:j1')?.until, iso(NOW - 2 * DAY + RIBBON_DAYS * DAY), 'the first PR floor, lit two days ago, is ribboned to seven days after');
  assert.equal(stored('ribbon:quickset:j2'), null);
  assert.equal(stored('revival:acme/a#job-j1')?.until, iso(NOW - 2 * DAY + LIGHTS_DAYS * DAY), 'a floor 198 days after the last is a revival');
  const once = reached().length;
  assert.equal(reached('skyline:acme/a#founding').length, 1);

  backfillMilestones(NOW);
  backfillMilestones(NOW + DAY);
  assert.equal(reached().length, once, 'a second backfill writes nothing');
  // With the bus listened to again, the next lit floor still moves the spire from the backfilled holder.
  off = installMilestones({ now: () => NOW });
  light('acme/a', 'j2', 'ola', NOW);
  assert.equal(stored('skyline:acme/a#founding')?.lit, true);
  assert.equal(reached('skyline:acme/a#founding').length, 1, 'the holder stays, so nothing is written');
});

test('re-analysis keeps milestones by floor id', () => {
  firmWithAgent('quickset', 'ola', 100);
  addTower('acme/a', ['small', 'small'], NOW - 120 * DAY, 0);
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - DAY);
  light('acme/a', 'j1', 'ola', NOW);
  const ids = milestonesOf('acme/a#founding').map((m) => m.id).sort();
  assert.deepEqual(ids, ['founding-skyline:acme/a#founding', 'revival:acme/a#job-j1', 'ribbon:quickset:j1', 'skyline:acme/a#founding']);
  const floorIds = new Map(milestonesOf('acme/a#founding').map((m) => [m.id, m.floorId]));

  // A re-analysis rewrites the founding tower (same id, the founding floors read again); the earned floors stand in their own table.
  const founding = [floor('acme/a#g0', 'acme/a', NOW - 121 * DAY, 'small'), floor('acme/a#g1', 'acme/a', NOW - 120 * DAY, 'medium'), floor('acme/a#g2', 'acme/a', NOW - 119 * DAY, 'small')];
  openDb().prepare('UPDATE towers SET json = ? WHERE repo = ?').run(JSON.stringify({ id: 'acme/a#founding', repo: 'acme/a', kind: 'founding', root: 'gothic', floors: founding, datumIndex: 3 }), 'acme/a');
  const repo = JSON.parse((openDb().prepare('SELECT json FROM repos WHERE full_name = ?').get('acme/a') as { json: string }).json) as Repo;
  emit('repo.analyzed', { repo: { ...repo, analyzedAt: iso(NOW) } });

  const after = milestonesOf('acme/a#founding');
  assert.deepEqual(after.map((m) => m.id).sort(), ids);
  for (const m of after) assert.equal(m.floorId, floorIds.get(m.id), `${m.id} keeps its floor`);
  assert.equal(stored('skyline:acme/a#founding')?.lit, true);
  assert.ok(listMilestones(NOW, { active: true }).some((m) => m.id === 'ribbon:quickset:j1'));

  // Disconnecting the repo takes every ornament with the tower; the rows stay.
  openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...repo, connected: false }), 'acme/a');
  emit('repo.disconnected', { repo: { ...repo, connected: false } });
  assert.equal(listMilestones(NOW, { active: true }).filter((m) => m.towerId === 'acme/a#founding').length, 0);
  assert.equal(milestonesOf('acme/a#founding').length, ids.length);
});

test('the week tour reads the week from the ledger and the standing towers from the city', () => {
  firmWithAgent('quickset', 'ola', 100);
  firmWithAgent('kumo', 'rin', 101);
  addTower('acme/a', ['small'], NOW - 200 * DAY, 0);
  addTower('acme/gone', ['small'], NOW - 200 * DAY, 1);
  const monday = new Date(2026, 10, 9, 9, 0, 0).getTime();
  // This week: two merges on a, a scar, a first job, a hire, and a merge on a repo since disconnected. Last week: a merge that is not this week's.
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', monday);
  light('acme/a', 'j1', 'ola', monday + 3_600_000);
  layJob('acme/a', 'j2', 'ola', 'quickset', 'small', 'waiting', monday + DAY);
  light('acme/a', 'j2', 'ola', monday + DAY + 3_600_000);
  const scar = floor('acme/a#scar-run-j9', 'acme/a', monday + 2 * DAY, 'small', earnedOn('j9', 'rin', 'kumo', 'scar'));
  layEarnedFloor('acme/a#founding', scar);
  record('floor.scarred', { jobId: 'j9', runId: 'run-j9', towerId: 'acme/a#founding', floor: scar, size: scar.size });
  record('job.awarded', { jobId: 'j9', tier: 'normal', considered: [], satOut: [], chosen: { id: 'bid-j9', jobId: 'j9', firmId: 'kumo', agentId: 'rin', price: 20 }, why: 'test', at: iso(monday + 2 * DAY - 3_600_000), coolOffUntil: null });
  record('agent.hired', { agent: { id: 'rin', firmId: 'kumo', name: 'Agent rin' } });
  layJob('acme/gone', 'j5', 'ola', 'quickset', 'small', 'waiting', monday + 3 * DAY);
  light('acme/gone', 'j5', 'ola', monday + 3 * DAY + 3_600_000);
  openDb().prepare('UPDATE repos SET json = json_set(json, \'$.connected\', json(\'false\')) WHERE full_name = ?').run('acme/gone');
  // The ledger's times are the rows' write times, so move each row to when its event happened.
  const db = openDb();
  for (const e of query({ kind: ['floor.lit', 'floor.scarred'] })) {
    const d = e.data as { floor?: Floor; floorId?: string };
    const f = d.floor ?? (JSON.parse((db.prepare('SELECT json FROM earned_floors WHERE id = ?').get(d.floorId ?? '') as { json: string }).json) as Floor);
    db.prepare('UPDATE ledger SET at = ? WHERE id = ?').run(f.at, e.id);
  }
  for (const e of query({ kind: 'job.awarded' })) db.prepare('UPDATE ledger SET at = ? WHERE id = ?').run((e.data as { at: string }).at, e.id);
  for (const e of query({ kind: 'agent.hired' })) db.prepare('UPDATE ledger SET at = ? WHERE id = ?').run(iso(monday + 2 * DAY + 3_600_000), e.id);
  for (const e of query({ kind: 'milestone.reached' })) db.prepare('UPDATE ledger SET at = ? WHERE id = ?').run((e.data as { milestone: Milestone }).milestone.at, e.id);

  const t = weekTour(NOW);
  assert.ok(t);
  assert.equal(t.week, '2026-11-09');
  const stops = t.stops.filter((s) => s.kind !== 'exchange');
  assert.ok(!stops.some((s) => s.towerId === 'acme/gone#founding'), 'a disconnected repo is no stop');
  const merged = stops.filter((s) => s.kind === 'merged');
  assert.equal(merged.length, 2);
  assert.match(merged[0].caption, /^Quickset laid floor 2 on a, Monday$/);
  assert.equal(merged[0].floorId, 'acme/a#job-j1');
  assert.equal(merged[0].repo, 'acme/a');
  assert.equal(stops.filter((s) => s.kind === 'scar').length, 1);
  assert.match(stops.find((s) => s.kind === 'scar')!.caption, /Kumo.*a, Wednesday$/);
  assert.equal(stops.filter((s) => s.kind === 'firm').length, 1);
  assert.equal(stops.find((s) => s.kind === 'firm')!.towerId, agentTowerId('rin'));
  assert.equal(stops.filter((s) => s.kind === 'hire').length, 1);
  assert.ok(stops.some((s) => s.kind === 'skyline'), 'the skyline reached this week is a stop');
  assert.ok(stops.some((s) => s.kind === 'ribbon'));
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i - 1].at <= stops[i].at);
  // The brief's key for last week names the same tour from the Monday.
  assert.deepEqual(weekTour('2026-11-09'), t);
  // A week with nothing is no tour.
  assert.equal(weekTour(NOW - 14 * DAY), null);
});

test('an older PR merging while a newer one still waits does not mask a revival', () => {
  firmWithAgent('quickset', 'ola', 100);
  addAgent('rin', 'quickset', 'claude:sonnet', { towerIndex: 1 });
  addTower('acme/quiet', ['small'], NOW - 100 * DAY, 0);
  layJob('acme/quiet', 'j1', 'ola', 'quickset', 'small', 'waiting', NOW - 2 * DAY);
  layJob('acme/quiet', 'j2', 'rin', 'quickset', 'small', 'waiting', NOW - DAY);
  light('acme/quiet', 'j1', 'ola', NOW);
  const r = stored('revival:acme/quiet#job-j1');
  assert.ok(r, 'the waiting floor j2 is not a floor the repo had');
  assert.match(r.detail, /100 days/);
  // j2 merging a day later is no second revival: j1 stands lit before it.
  light('acme/quiet', 'j2', 'rin', NOW + DAY);
  assert.equal(stored('revival:acme/quiet#job-j2'), null);
});

test('a skyline tie leaves the holder unchanged', () => {
  // Pin: equal earned heights never move the spire.
  firmWithAgent('quickset', 'ola', 100);
  addAgent('rin', 'quickset', 'claude:sonnet', { towerIndex: 1 });
  addTower('acme/a', ['small'], NOW - 30 * DAY, 0);
  addTower('acme/b', ['large', 'large'], NOW - 30 * DAY, 1);
  layJob('acme/a', 'j1', 'ola', 'quickset', 'medium', 'waiting', NOW - 2 * DAY);
  light('acme/a', 'j1', 'ola', NOW - DAY);
  assert.equal(stored('skyline:acme/a#founding')?.lit, true);
  const before = reached().filter((m) => m.kind === 'skyline').length;
  layJob('acme/b', 'j2', 'rin', 'quickset', 'medium', 'waiting', NOW - DAY);
  light('acme/b', 'j2', 'rin', NOW);
  assert.equal(stored('skyline:acme/a#founding')?.lit, true, 'the holder keeps a tie');
  assert.equal(stored('skyline:acme/b#founding'), null, 'a level tower gets no spire row');
  assert.equal(reached().filter((m) => m.kind === 'skyline').length, before, 'nothing is written on a tie');
});

test('a revival reaches exactly on the 90-day boundary and not an hour short of it', () => {
  // Pin: QUIET_DAYS is inclusive.
  firmWithAgent('quickset', 'ola', 100);
  addTower('acme/edge', ['small'], NOW - QUIET_DAYS * DAY, 0);
  addTower('acme/short', ['small'], NOW - QUIET_DAYS * DAY + 3_600_000, 1);
  layJob('acme/edge', 'j1', 'ola', 'quickset', 'small', 'waiting', NOW - DAY);
  light('acme/edge', 'j1', 'ola', NOW);
  assert.ok(stored('revival:acme/edge#job-j1'), 'ninety days exactly is quiet');
  layJob('acme/short', 'j2', 'ola', 'quickset', 'small', 'waiting', NOW - DAY);
  light('acme/short', 'j2', 'ola', NOW);
  assert.equal(stored('revival:acme/short#job-j2'), null, 'an hour short of ninety days is not');
});
