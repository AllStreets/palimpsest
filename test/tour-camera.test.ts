/**
 * The week tour's camera (Phase 3 Task 17): tourKeys is pure, from the
 * engine's tour and the frames the city gives each stop to an eye, a target
 * and a time per key; tourPose walks them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { TOUR_EYE, tourKeys, tourLength, tourPose, type TourFrame } from '../app/src/city/tour.js';
import { TOUR } from '../shared/market-rules.js';
import type { Tour, TourStop } from '../shared/types.js';

function stop(kind: TourStop['kind'], repo: string | null, floorId: string | null, at: string): TourStop {
  const ex = kind === 'exchange';
  return { kind, towerId: repo ? `${repo}#founding` : null, repo, floorId, agentId: null, firmId: null, title: ex ? 'The exchange' : `${kind} on ${repo}`, caption: ex ? 'The exchange' : `${kind} on ${repo}, Tuesday`, at, dwell: ex ? TOUR.exchange : TOUR.dwell, glide: ex && at === '2026-11-09T06:00:00Z' ? 0 : TOUR.glide };
}

const TOWERS: Record<string, TourFrame> = {
  'a/one': { center: new THREE.Vector3(300, 60, 0), width: 30, height: 120 },
  'a/two': { center: new THREE.Vector3(-300, 90, 260), width: 34, height: 180 },
  'a/three': { center: new THREE.Vector3(0, 40, -320), width: 28, height: 80 },
};
const EXCHANGE: TourFrame = { center: new THREE.Vector3(0, 10, 0), width: 80, height: 30 };

function tour(): Tour {
  const stops = [
    stop('exchange', null, null, '2026-11-09T06:00:00Z'),
    stop('merged', 'a/one', 'a/one#f40', '2026-11-10T09:00:00Z'),
    stop('skyline', 'a/two', null, '2026-11-11T09:00:00Z'),
    stop('scar', 'a/three', 'a/three#f12', '2026-11-12T09:00:00Z'),
    stop('exchange', null, null, '2026-11-16T06:00:00Z'),
  ];
  return { week: '2026-11-09', from: stops[0].at, to: stops[4].at, stops, seconds: stops.reduce((n, s) => n + s.dwell + s.glide, 0) };
}

/** A floor's frame: a slice of its tower; a stop with no floor frames the whole tower. */
function frames(s: TourStop): TourFrame | null {
  const t = s.repo ? TOWERS[s.repo] : null;
  if (!t) return null;
  if (!s.floorId) return t;
  return { center: t.center.clone().setY(t.center.y + 30), width: t.width, height: 4.5 };
}

test('tourKeys places the exchange first and last and an eye per stop', () => {
  const keys = tourKeys(tour(), frames, EXCHANGE, Object.values(TOWERS));
  assert.equal(keys.length, 5);
  assert.equal(keys[0].stop.kind, 'exchange');
  assert.equal(keys[keys.length - 1].stop.kind, 'exchange');
  for (const k of keys.slice(1, -1)) {
    const f = frames(k.stop)!;
    const flat = Math.hypot(k.eye.x - f.center.x, k.eye.z - f.center.z);
    assert.ok(flat >= TOUR_EYE.out - 1e-6, `${k.stop.caption}: the eye stands well out from its frame (${flat.toFixed(1)} m)`);
    assert.ok(k.eye.y > f.center.y + 10, `${k.stop.caption}: a little above what it looks at`);
    // Never square on to a face, never down a corner: a three-quarter view.
    const a = (((Math.atan2(k.eye.z - k.target.z, k.eye.x - k.target.x) * 180) / Math.PI) % 90 + 90) % 90;
    assert.ok(a >= 20 - 1e-6 && a <= 70 + 1e-6, `${k.stop.caption}: a three-quarter view (${a.toFixed(1)} degrees off the face)`);
  }
  // A whole tower stands in frame, its crown included: the eye far enough back for its height.
  const sky = keys[2];
  const t = TOWERS['a/two'];
  const dist = sky.eye.distanceTo(sky.target);
  const half = (36 / 2) * (Math.PI / 180);
  assert.ok(Math.tan(half) * dist >= t.height * 0.55, `the skyline's tower stands whole in the frame (${dist.toFixed(0)} m back for ${t.height} m)`);
  assert.ok(sky.target.y + Math.tan(half) * dist * 0.9 >= t.center.y + t.height / 2, 'its crown under the frame top');
});

test("a stop whose tower is gone is passed over, and the tour's keys keep their order", () => {
  const tr = tour();
  tr.stops.splice(2, 0, stop('merged', 'gone/repo', 'gone/repo#f1', '2026-11-10T12:00:00Z'));
  const keys = tourKeys(tr, frames, EXCHANGE, Object.values(TOWERS));
  assert.ok(keys.every((k) => k.stop.repo !== 'gone/repo'));
  assert.deepEqual(keys.map((k) => k.stop.kind), ['exchange', 'merged', 'skyline', 'scar', 'exchange']);
});

test("an eye inside a tower's frame moves out", () => {
  // A tower standing right where the eye would go for a/one's floor, between it and the exchange.
  const blocker: TourFrame = { center: new THREE.Vector3(240, 80, 0), width: 40, height: 160 };
  const tr = tour();
  const keys = tourKeys(tr, frames, EXCHANGE, [...Object.values(TOWERS), blocker]);
  for (const k of keys) {
    for (const t of [...Object.values(TOWERS), blocker]) {
      const inside = Math.abs(k.eye.x - t.center.x) < t.width / 2 + TOUR_EYE.clear && Math.abs(k.eye.z - t.center.z) < t.width / 2 + TOUR_EYE.clear && k.eye.y < t.center.y + t.height / 2 + TOUR_EYE.clear;
      assert.ok(!inside, `${k.stop.caption}: the eye stands clear of every tower (${k.eye.toArray().map((v) => v.toFixed(0)).join(', ')})`);
    }
  }
});

test("glides sum to the tour's seconds, and the walk passes every key", () => {
  const tr = tour();
  const keys = tourKeys(tr, frames, EXCHANGE, Object.values(TOWERS));
  assert.equal(tourLength(keys), tr.seconds);
  for (const k of keys) {
    const p = tourPose(keys, k.t + k.stop.glide + k.stop.dwell / 2);
    assert.equal(p.index, keys.indexOf(k), 'the stop dwelt at');
    assert.ok(p.eye.distanceTo(k.eye) < 6, `${k.stop.caption}: the eye stands at its key while it dwells, drifting a little (${p.eye.distanceTo(k.eye).toFixed(1)} m)`);
    assert.ok(p.dwelling);
  }
  // Mid-glide the eye rises over the line between two keys, so it never swings low through the towers.
  const k = keys[2];
  const mid = tourPose(keys, k.t + k.stop.glide / 2);
  assert.equal(mid.dwelling, false);
  assert.ok(mid.eye.y > (keys[1].eye.y + k.eye.y) / 2 + 5, `the glide arcs up (${mid.eye.y.toFixed(0)} m)`);
  // Reduced motion: no glide, only the stops, cut from one to the next.
  const still = tourPose(keys, k.t + 0.1, true);
  assert.equal(still.index, 2);
  assert.ok(still.eye.distanceTo(k.eye) < 1e-6, 'cut straight to the stop');
});
