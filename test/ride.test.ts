import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dossierFloors, dossierOf, dossierParts, dossierWords, RIDE, rideAt, rideLength, rideNextStop, ridePlan, type Dossier, type RideKey } from '../shared/ride.js';
import { layoutTower } from '../shared/tower-layout.js';
import type { Bid, Floor, InspectionView, Job, RunView, SiteState, TowerSpec } from '../shared/types.js';

function floor(i: number, p: Partial<Floor> = {}): Floor {
  return {
    id: `acme/harbour#${i}`,
    repo: 'acme/harbour',
    kind: 'commits',
    refs: [`abc${String(i).padStart(4, '0')}`],
    title: `Change ${i}`,
    at: '2025-03-04T10:00:00Z',
    era: 'stone',
    size: 'medium',
    lines: 10,
    claude: false,
    founding: true,
    url: null,
    ...p,
  };
}

function tower(floors: Floor[], datumIndex = floors.length, kind: TowerSpec['kind'] = 'founding'): TowerSpec {
  return { id: 'acme/harbour', repo: 'acme/harbour', kind, root: 'beauxarts', floors, datumIndex };
}

const earned = (state: 'lit' | 'scar' | 'waiting') => ({ jobId: 'job-1', runId: 'run-1', agentId: 'priya-rao', firmId: 'quickset', state, reverted: false });

/** Seconds the plan takes to rise from y0 to y1 (eye heights), dwells left out. */
function travel(keys: RideKey[], y0: number, y1: number): number {
  let s = 0;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const lo = Math.max(a.y, y0);
    const hi = Math.min(b.y, y1);
    if (hi <= lo || b.y <= a.y) continue;
    s += ((b.t - a.t - a.dwell) * (hi - lo)) / (b.y - a.y);
  }
  return s;
}

test('ridePlan slows at the datum and dwells on scars and Claude floors', () => {
  // Twenty founding floors, a Claude floor among them, the datum, then five earned floors with a scar.
  const floors = [
    ...Array.from({ length: 20 }, (_, i) => floor(i, i === 8 ? { claude: true, title: 'Tidal windows' } : {})),
    ...Array.from({ length: 5 }, (_, j) =>
      floor(20 + j, { founding: false, era: 'glass', title: j === 2 ? 'Failed inspection: Berth search' : `Earned ${j}`, earned: earned(j === 2 ? 'scar' : 'lit') }),
    ),
  ];
  const spec = tower(floors, 20);
  const lay = layoutTower(spec);
  const names = { agents: new Map([['priya-rao', 'Priya Rao']]), firms: new Map([['quickset', 'Quickset']]) };
  const keys = ridePlan(lay, floors, { live: null, names, name: 'harbour', root: 'Beaux-Arts root' });

  // Times and heights only climb.
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i].t >= keys[i - 1].t + keys[i - 1].dwell - 1e-9, `key ${i} leaves after the last one's dwell`);
    assert.ok(keys[i].y >= keys[i - 1].y - 1e-9, `key ${i} never descends`);
  }
  // Ordinary floors pass at three a second, the datum's at 0.8.
  const h = lay.floors[3].h;
  const plain = travel(keys, lay.floors[2].y0 + h * 0.5, lay.floors[5].y0 + h * 0.5);
  assert.ok(Math.abs(plain - 3 / RIDE.speed) < 0.05, `three plain floors take a second (${plain.toFixed(2)} s)`);
  const atDatum = travel(keys, lay.datumY - h * 0.5, lay.datumY + h * 0.5);
  assert.ok(Math.abs(atDatum - 1 / RIDE.slow) < 0.05, `a floor's height at the datum takes 1.25 s (${atDatum.toFixed(2)} s)`);

  const datum = keys.find((k) => k.caption?.mark === 'datum');
  assert.ok(datum, 'the datum has its caption');
  assert.equal(datum.dwell, RIDE.dwell);
  assert.ok(Math.abs(datum.y - lay.datumY) < 3, 'and the ride stops level with it');

  const claude = keys.find((k) => k.caption?.mark === 'claude');
  assert.ok(claude, 'the Claude floor has its caption');
  assert.equal(claude.dwell, RIDE.dwell);
  assert.equal(claude.floorId, floors[8].id);
  assert.equal(claude.caption?.title, 'Tidal windows');
  assert.equal(claude.caption?.date, 'Mar 4, 2025');
  assert.match(claude.caption?.who ?? '', /Claude/);
  const claudeFloor = lay.floors[8];
  const slowClaude = travel(keys, claudeFloor.y0, claudeFloor.y0 + claudeFloor.h);
  assert.ok(Math.abs(slowClaude - 1 / RIDE.slow) < 0.05, `the Claude floor passes at 0.8 floors a second (${slowClaude.toFixed(2)} s)`);

  const scar = keys.find((k) => k.caption?.mark === 'scar');
  assert.ok(scar, 'the scar has its caption');
  assert.equal(scar.dwell, RIDE.dwell);
  assert.equal(scar.caption?.title, 'Berth search', 'the engine prefix is left off');
  assert.equal(scar.caption?.who, 'Priya Rao, Quickset');

  // It starts at street level on the root and ends over the roof with a slow orbit.
  assert.equal(keys[0].t, 0);
  assert.ok(keys[0].y < 2, 'the ride starts at street level');
  assert.equal(keys[0].caption?.title, 'Beaux-Arts root');
  const last = keys[keys.length - 1];
  assert.ok(last.y >= lay.top, 'the ride ends at the roof');
  assert.equal(last.dwell, RIDE.orbit);
  assert.equal(last.caption?.mark, null);

  // Between keys the eye rises smoothly: no jump bigger than the speed allows in a frame.
  let prev = rideAt(keys, 0).y;
  const end = last.t + last.dwell;
  for (let t = 1 / 60; t <= end; t += 1 / 60) {
    const y = rideAt(keys, t).y;
    assert.ok(y >= prev - 1e-6 && y - prev < 0.6, `smooth at ${t.toFixed(2)} s`);
    prev = y;
  }
  assert.equal(rideAt(keys, 0.2).caption?.title, 'Beaux-Arts root');
  assert.equal(rideAt(keys, claude.t + 0.5).caption?.title, 'Tidal windows');
  assert.equal(rideAt(keys, claude.t + 0.5).dwelling, true);
  assert.equal(rideAt(keys, end + 1).done, true);
});

test('a live site ends the ride at the work with its caption', () => {
  const floors = Array.from({ length: 12 }, (_, i) => floor(i));
  const lay = layoutTower(tower(floors));
  const live: SiteState = { repo: 'acme/harbour', runId: 'run-9', jobId: 'job-9', agentId: 'priya-rao', firmId: 'quickset', stage: 'framing', progress: 0.4, size: 'medium', since: '2026-11-10T18:00:00.000Z' };
  const keys = ridePlan(lay, floors, { live, names: { agents: new Map([['priya-rao', 'Priya Rao']]), firms: new Map([['quickset', 'Quickset']]) } });
  const last = keys[keys.length - 1];
  assert.equal(last.caption?.mark, 'live');
  assert.equal(last.caption?.title, 'Priya Rao is framing floor 13');
  assert.equal(last.caption?.who, 'Quickset');
  assert.ok(last.dwell >= RIDE.dwell, 'the ride waits at the work');
  assert.ok(Math.abs(last.y - lay.top) < 3, `and stops level with the roof the frame rises on (${last.y.toFixed(1)} against ${lay.top.toFixed(1)})`);
  assert.equal(keys.filter((k) => k.y > lay.top).length, 1, 'no orbit over a live site: the work is the last stop');
  // A site no longer at work (struck, or a scar) is not live: the ride goes to the roof.
  const done = ridePlan(lay, floors, { live: { ...live, stage: 'teardown' } });
  assert.notEqual(done[done.length - 1].caption?.mark, 'live');
});

test('a root-only tower rides the root and the roof', () => {
  const spec = tower([]);
  const lay = layoutTower(spec);
  const keys = ridePlan(lay, [], { live: null, root: 'Beaux-Arts root', name: 'harbour' });
  assert.equal(keys.length, 2, 'two stops: the street and the roof');
  assert.ok(keys[0].y < 2);
  assert.equal(keys[0].caption?.title, 'Beaux-Arts root');
  const last = keys[1];
  assert.ok(last.y >= lay.rootHeight && last.y < lay.rootHeight + 3, 'the roof is the root’s');
  assert.equal(last.dwell, RIDE.orbit);
  assert.ok(Number.isFinite(last.t) && last.t > keys[0].dwell, 'it takes time to climb');
  assert.ok(!keys.some((k) => k.caption?.mark === 'datum'), 'no datum without floors');
});

test('an agent tower ends over its crown', () => {
  const floors = Array.from({ length: 6 }, (_, i) => floor(i, { founding: false, era: 'glass', earned: earned('lit') }));
  const lay = layoutTower(tower(floors, 0, 'agent'));
  const keys = ridePlan(lay, floors, { live: null, crown: 9 });
  assert.ok(keys[keys.length - 1].y >= lay.top + 9 * 0.5, 'the orbit looks across the crown');
});

test('a long ride climbs faster at cruise to keep within 45 s, never past 6 floors a second', () => {
  const plain = Array.from({ length: 120 }, (_, i) => floor(i));
  const lay = layoutTower(tower(plain));
  const keys = ridePlan(lay, plain, { live: null });
  assert.ok(rideLength(keys) <= RIDE.longest + 0.05, `a 120 floor tower rides in ${rideLength(keys).toFixed(1)} s`);
  // A short tower keeps three floors a second.
  const short = Array.from({ length: 12 }, (_, i) => floor(i));
  const sl = layoutTower(tower(short));
  const sk = ridePlan(sl, short, { live: null });
  const h = sl.floors[3].h;
  const t = travel(sk, sl.floors[2].y0 + h / 2, sl.floors[5].y0 + h / 2);
  assert.ok(Math.abs(t - 1) < 0.05, `three floors a second on a short tower (${t.toFixed(2)} s)`);
  // A tower too long even at six floors a second rides at six, and the slow floors stay at 0.8.
  const huge = Array.from({ length: 400 }, (_, i) => floor(i, i % 40 === 5 ? { claude: true } : {}));
  const hl = layoutTower(tower(huge));
  const hk = ridePlan(hl, huge, { live: null });
  const fh = hl.floors[10].h;
  const cruise = travel(hk, hl.floors[10].y0, hl.floors[16].y0);
  assert.ok(Math.abs(cruise - 6 / RIDE.fastest) < 0.05, `six floors take a second at the cap (${cruise.toFixed(2)} s)`);
  const c = hl.floors[5];
  assert.ok(Math.abs(travel(hk, c.y0, c.y0 + fh) - 1 / RIDE.slow) < 0.05, 'the Claude floor still passes at 0.8');
});

test('skipping goes to the next stop', () => {
  const floors = Array.from({ length: 20 }, (_, i) => floor(i, i === 8 ? { claude: true } : {}));
  const keys = ridePlan(layoutTower(tower(floors)), floors, { live: null });
  const claude = keys.find((k) => k.caption?.mark === 'claude')!;
  assert.equal(rideNextStop(keys, 0.2), claude.t, 'from the street, the Claude floor');
  const datum = keys.find((k) => k.caption?.mark === 'datum')!;
  assert.equal(rideNextStop(keys, claude.t + 0.1), datum.t, 'waiting there, the next stop');
  const last = keys[keys.length - 1];
  assert.equal(rideNextStop(keys, last.t + 1), null, 'nothing past the last stop');
});

// ---------------------------------------------------------------- the floor dossier (Phase 3 Task 18)

const job = (p: Partial<Job> = {}): Job => ({ id: 'job-1', repo: 'acme/harbour', source: 'issue', title: 'Uploads lose their place', status: 'merged', ...p }) as unknown as Job;
const run = (p: Partial<RunView> = {}): RunView => ({ id: 'run-1', jobId: 'job-1', bidId: 'bid-1', progress: { toolCalls: 9, filesChanged: 4, testsRun: 2, turns: 6, weightedTokens: 1000, credits: 12, refusals: 0 }, summary: null, ...p }) as unknown as RunView;
const bid = (p: Partial<Bid> = {}): Bid => ({ id: 'bid-1', jobId: 'job-1', plan: 'Add the missing retry to the uploader.', ...p }) as unknown as Bid;
const inspection = (p: Partial<InspectionView> = {}): InspectionView => ({ id: 'insp-1', runId: 'run-1', passed: true, pushable: true, checks: [], inconclusive: null, ...p }) as unknown as InspectionView;

test('dossierOf fills diff, plan, verdict and claim from the views and null for a founding floor', () => {
  const f = floor(30, { founding: false, era: 'glass', lines: 212, earned: earned('lit') });
  const d = dossierOf(f, { job: job(), bids: [bid()], run: run(), inspection: inspection(), claim: null, firm: 'Quickset' });
  assert.deepEqual(d, { diff: { files: 4, lines: 212 }, plan: 'Add the missing retry to the uploader.', verdict: 'Passed, pushable', claim: null, firm: 'Quickset' });
  assert.deepEqual(dossierWords(d!), { line: '4 files, 212 lines. Plan: add the missing retry to the uploader. Passed, pushable.', claim: null });
  assert.deepEqual(dossierParts(d!), { facts: '4 files, 212 lines. Passed, pushable.', plan: 'Plan: add the missing retry to the uploader.', claim: null, verdict: 'pass' });
  // A proposal floor carries the README claim behind it.
  const p = dossierOf(f, { job: job({ source: 'proposal' }), bids: [bid()], run: run(), inspection: inspection(), claim: 'Resumable uploads', firm: 'Quickset' })!;
  assert.equal(dossierWords(p).claim, 'From the README: \u2018Resumable uploads\u2019');
  // A scar: its failed checks are the verdict.
  const scar = dossierOf(floor(31, { founding: false, earned: earned('scar'), lines: 40 }), {
    job: job(),
    bids: [bid()],
    run: run(),
    inspection: inspection({ passed: false, pushable: false, checks: [{ name: 'scope', status: 'fail' }, { name: 'test', status: 'pass' }, { name: 'review', status: 'fail' }] as InspectionView['checks'] }),
    claim: null,
    firm: null,
  })!;
  assert.equal(scar.verdict, 'Failed: scope, review');
  // A plan written as model output is cleaned and cut, never shown raw.
  const long = dossierOf(f, { job: job(), bids: [bid({ plan: `  first line\n\n${'x'.repeat(400)}` })], run: run(), inspection: null, claim: null, firm: null })!;
  assert.ok(long.plan!.length <= 160 && !/\n/.test(long.plan!), 'one line, cut');
  assert.equal(long.verdict, null, 'no inspection, no verdict');
  // Nothing for a founding floor, nor for an earned floor with nothing read yet.
  assert.equal(dossierOf(floor(3), { job: job(), bids: [bid()], run: run(), inspection: inspection(), claim: null, firm: null }), null);
  assert.equal(dossierOf(f, null), null);
});

test('ridePlan dwells longer on a floor with a dossier, and stops at it', () => {
  const floors = [
    ...Array.from({ length: 10 }, (_, i) => floor(i)),
    ...Array.from({ length: 6 }, (_, j) => floor(10 + j, { founding: false, era: 'glass', title: `Earned ${j}`, earned: earned('lit') })),
  ];
  const spec = tower(floors, 10);
  const lay = layoutTower(spec);
  const d: Dossier = { diff: { files: 4, lines: 212 }, plan: 'Add the retry.', verdict: 'Passed, pushable', claim: null, firm: 'Quickset' };
  const dossiers = new Map([[floors[13].id, d]]);
  const plain = ridePlan(lay, floors, { live: null });
  const keys = ridePlan(lay, floors, { live: null, dossiers });
  assert.ok(!plain.some((k) => k.floorId === floors[13].id), 'a plain earned floor is passed');
  const stop = keys.find((k) => k.floorId === floors[13].id);
  assert.ok(stop, 'the dossier floor is a stop');
  assert.equal(stop.dwell, RIDE.dossierDwell);
  assert.ok(RIDE.dossierDwell >= RIDE.dwell * 2 - 1e-9);
  assert.deepEqual(stop.caption?.dossier, d);
  assert.ok(keys.filter((k) => k.caption && k.floorId !== floors[13].id).every((k) => !k.caption!.dossier), 'nothing on the other stops');
});

test('dossierFloors picks the scars, the proposals and the newest earned floors, and none founding', () => {
  const floors = [
    ...Array.from({ length: 4 }, (_, i) => floor(i)),
    ...Array.from({ length: 9 }, (_, j) => floor(4 + j, { founding: false, at: `2025-03-${String(5 + j).padStart(2, '0')}T10:00:00Z`, earned: { ...earned(j === 1 ? 'scar' : 'lit'), jobId: `job-${j}` } })),
  ];
  const picked = dossierFloors(floors, new Set(['job-2']));
  assert.ok(picked.includes(floors[5].id), 'the scar');
  assert.ok(picked.includes(floors[6].id), 'the proposal');
  for (const f of floors.slice(-3)) assert.ok(picked.includes(f.id), 'the newest three');
  assert.ok(picked.every((id) => !floors.slice(0, 4).some((f) => f.id === id)), 'no founding floor');
  assert.ok(picked.length <= 6);
});
