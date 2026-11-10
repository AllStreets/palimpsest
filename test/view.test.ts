import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CROWN_ALLOWANCE, cityExtent, easeLimits, fogFor, FOV, HERO_FOG, viewLimits, type CityExtent, type V3 } from '../app/src/city/view.js';
import { FLOOR_HEIGHT, ROOT_HEIGHT } from '../shared/tower-layout.js';

// ---------------------------------------------------------------- an independent pinhole camera

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Normalised device coordinates of `p` seen from `eye` looking at `target` through a FOV degree lens. */
function ndc(eye: V3, target: V3, aspect: number, p: V3): { x: number; y: number; z: number } {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const v = sub(p, eye);
  const z = dot(v, f);
  const t = Math.tan(((FOV / 2) * Math.PI) / 180);
  return { x: dot(v, r) / (z * t * aspect), y: dot(v, u) / (z * t), z };
}

/** Points round the city's bounding cylinder: every tower base and every crown lies inside it. */
function hull(e: CityExtent, footprint = 30): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const x = e.cx + Math.cos(a) * (e.radius + footprint);
    const z = e.cz + Math.sin(a) * (e.radius + footprint);
    pts.push([x, 0, z], [x, e.height, z]);
  }
  return pts;
}

/** The tallest crown at the city's centre and at each point of its rim. */
function crowns(e: CityExtent): V3[] {
  return hull(e).filter((p) => p[1] > 0);
}

const towerTop = (floors: number, root: keyof typeof ROOT_HEIGHT = 'gothic'): number => ROOT_HEIGHT[root] + floors * FLOOR_HEIGHT.medium;

const extent = (floors: number, radius: number, count: number): CityExtent => ({
  cx: 0,
  cz: 0,
  radius,
  height: towerTop(floors) + CROWN_ALLOWANCE,
  count,
});

const fogAt = (density: number, d: number): number => 1 - Math.exp(-density * density * d * d);

const ASPECTS = [1.6, 1.0, 2.2];

// ---------------------------------------------------------------- the tests

test('the extent of a city: the tallest crown and the reach of its districts round their centre', () => {
  const tower = (floors: number) => ({ id: 'x', repo: 'x', kind: 'founding' as const, root: 'gothic' as const, floors: Array.from({ length: floors }, () => ({ size: 'medium' as const })), datumIndex: floors });
  const e = cityExtent([
    { origin: { x: 240, z: 0 }, tower: tower(8) as never },
    { origin: { x: -240, z: 0 }, tower: tower(120) as never },
  ]);
  assert.equal(e.count, 2);
  assert.equal(e.cx, 0);
  assert.equal(e.cz, 0);
  assert.equal(e.radius, 240);
  assert.ok(Math.abs(e.height - (towerTop(120) + CROWN_ALLOWANCE)) < 1e-9, `height ${e.height}`);
  const none = cityExtent([]);
  assert.equal(none.count, 0);
  assert.equal(none.radius, 0);
});

test('at the home framing the tallest crown sits inside the frame with sky above it, at every window shape', () => {
  for (const aspect of ASPECTS) {
    for (const [floors, radius, count] of [
      [8, 0, 1],
      [40, 340, 6],
      [120, 340, 6],
      [120, 720, 18],
      [120, 0, 1],
    ] as const) {
      const e = extent(floors, radius, count);
      const { home } = viewLimits(e, aspect);
      for (const p of crowns(e)) {
        const s = ndc(home.eye, home.target, aspect, p);
        assert.ok(s.z > 0, 'in front of the eye');
        assert.ok(s.y < 0.92, `crown at ndc y ${s.y.toFixed(3)} (${floors} floors, radius ${radius}, aspect ${aspect})`);
        assert.ok(Math.abs(s.x) < 1, `crown at ndc x ${s.x.toFixed(3)} (${floors} floors, radius ${radius}, aspect ${aspect})`);
      }
    }
  }
});

test('from the farthest the camera may go, the whole city fits with sky above it from any height of view', () => {
  for (const aspect of ASPECTS) {
    for (const [floors, radius] of [
      [8, 0],
      [120, 340],
      [120, 900],
    ] as const) {
      const e = extent(floors, radius, 6);
      const lim = viewLimits(e, aspect);
      for (const elevation of [8, 25, 45, 70, 88]) {
        const el = (elevation * Math.PI) / 180;
        const target: V3 = [e.cx, lim.home.target[1], e.cz];
        const eye: V3 = [target[0] + Math.cos(el) * 0.6 * lim.maxDistance, target[1] + Math.sin(el) * lim.maxDistance, target[2] + Math.cos(el) * 0.8 * lim.maxDistance];
        for (const p of hull(e)) {
          const s = ndc(eye, target, aspect, p);
          assert.ok(s.z > 0 && s.y < 0.95 && s.y > -1 && Math.abs(s.x) < 1, `${floors} floors, radius ${radius}, elevation ${elevation}: point at ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`);
        }
      }
      assert.ok(lim.far > lim.maxDistance + radius + 8000, `far plane ${lim.far} reaches the ground's edge from the farthest eye`);
    }
  }
});

test('the farthest the camera may go and the home distance grow with the tallest tower and never shrink', () => {
  for (const radius of [0, 340, 900]) {
    let prev = viewLimits(extent(0, radius, 6), 1.6);
    for (let floors = 1; floors <= 120; floors++) {
      const next = viewLimits(extent(floors, radius, 6), 1.6);
      assert.ok(next.maxDistance >= prev.maxDistance - 1e-6, `maxDistance at ${floors} floors, radius ${radius}`);
      assert.ok(next.homeDistance >= prev.homeDistance - 1e-6, `home distance at ${floors} floors, radius ${radius}`);
      assert.ok(next.fogDensity <= prev.fogDensity + 1e-12, `fog thickens at ${floors} floors, radius ${radius}`);
      assert.ok(next.far >= prev.far - 1e-6, `far plane at ${floors} floors`);
      prev = next;
    }
  }
});

test('one floor more moves every limit by only a little: no jumps', () => {
  for (const radius of [0, 240, 340, 900]) {
    for (let floors = 0; floors < 120; floors++) {
      const a = viewLimits(extent(floors, radius, 6), 1.6);
      const b = viewLimits(extent(floors + 1, radius, 6), 1.6);
      const rel = (x: number, y: number) => Math.abs(y - x) / Math.max(x, 1e-9);
      // No jump: a limit moves at most in proportion to how much taller the city got (one floor on a short tower is a bigger share).
      const grew = rel(towerTop(floors) + CROWN_ALLOWANCE, towerTop(floors + 1) + CROWN_ALLOWANCE);
      const bound = 1.5 * grew + 0.002;
      assert.ok(rel(a.homeDistance, b.homeDistance) <= bound, `home distance jumps at ${floors} floors, radius ${radius}: ${a.homeDistance} to ${b.homeDistance}`);
      assert.ok(rel(a.maxDistance, b.maxDistance) <= bound, `maxDistance jumps at ${floors} floors, radius ${radius}: ${a.maxDistance} to ${b.maxDistance}`);
      assert.ok(rel(a.fogDensity, b.fogDensity) <= bound, `fog jumps at ${floors} floors, radius ${radius}: ${a.fogDensity} to ${b.fogDensity}`);
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(a.home.eye[i] - b.home.eye[i]) < 30, `home eye jumps at ${floors} floors`);
        assert.ok(Math.abs(a.home.target[i] - b.home.target[i]) < 10, `home target jumps at ${floors} floors`);
      }
    }
  }
});

test('a small city, one tower of 8 floors, is framed close and stands clear of the haze', () => {
  const e = extent(8, 0, 1);
  const lim = viewLimits(e, 1.6);
  assert.ok(lim.homeDistance < 420, `home distance ${lim.homeDistance}`);
  // The tower fills a good part of the frame's height.
  const top = ndc(lim.home.eye, lim.home.target, 1.6, [0, e.height, 0]).y;
  const base = ndc(lim.home.eye, lim.home.target, 1.6, [0, 0, 0]).y;
  assert.ok(top - base > 0.4, `the tower spans ${(((top - base) / 2) * 100).toFixed(0)}% of the frame's height`);
  assert.ok(fogAt(lim.fogDensity, lim.homeDistance) < 0.08, `haze on the tower ${fogAt(lim.fogDensity, lim.homeDistance).toFixed(3)}`);
  // The camera may still fly out over the ambient city as far as it always could.
  assert.ok(lim.maxDistance >= 2600);
});

test('a city with two 120 floor towers is framed whole and its far edge reads through the haze', () => {
  const e = extent(120, 600, 14);
  const lim = viewLimits(e, 1.6);
  const far: V3 = [e.cx - (lim.home.eye[0] - e.cx), 0, e.cz - (lim.home.eye[2] - e.cz)];
  const toFarEdge = Math.hypot(lim.home.eye[0] - far[0], lim.home.eye[1], lim.home.eye[2] - far[2]);
  const edge = Math.hypot(far[0] - e.cx, far[2] - e.cz);
  const point: V3 = [e.cx + ((far[0] - e.cx) / edge) * (e.radius + 30), e.height * 0.5, e.cz + ((far[2] - e.cz) / edge) * (e.radius + 30)];
  const d = Math.hypot(lim.home.eye[0] - point[0], lim.home.eye[1] - point[1], lim.home.eye[2] - point[2]);
  assert.ok(toFarEdge > 0);
  assert.ok(fogAt(lim.fogDensity, d) < 0.6, `the far edge is ${(fogAt(lim.fogDensity, d) * 100).toFixed(0)}% haze`);
  assert.ok(lim.maxDistance > lim.homeDistance * 1.3, 'there is room to fly out past the home framing');
});

test('the hero haze is kept for a city the size of the sample, and thins only past it', () => {
  // The sample city: six districts round (-40, 80), the tallest of 92 floors.
  const sample: CityExtent = { cx: -40, cz: 80, radius: 377.36, height: 410.6, count: 6 };
  assert.equal(viewLimits(sample, 1.6).fogDensity, HERO_FOG);
  for (const radius of [0, 120, 240]) assert.equal(viewLimits({ ...sample, radius }, 1.6).fogDensity, HERO_FOG);
  assert.ok(viewLimits(extent(120, 600, 14), 1.6).fogDensity < HERO_FOG * 0.9, 'a much bigger city thins the haze');
});

test('easing: the limits move toward a grown city over a second or two, never in one frame', () => {
  const from = { maxDistance: 2600, fogDensity: 0.00055, far: 20000 };
  const to = { maxDistance: 5200, fogDensity: 0.0003, far: 26000 };
  let cur = { ...from };
  cur = easeLimits(cur, to, 1 / 60, 500);
  assert.ok(cur.maxDistance > from.maxDistance && cur.maxDistance < from.maxDistance + 200, `one frame moved maxDistance to ${cur.maxDistance}`);
  for (let i = 0; i < 60 * 3; i++) cur = easeLimits(cur, to, 1 / 60, 500);
  assert.ok(Math.abs(cur.maxDistance - to.maxDistance) < 1, `after three seconds ${cur.maxDistance}`);
  assert.ok(Math.abs(cur.fogDensity - to.fogDensity) < 1e-6);
  assert.ok(Math.abs(cur.far - to.far) < 1);
});

test('easing never pulls in a camera that stands beyond a shrinking limit', () => {
  let cur = { maxDistance: 5200, fogDensity: 0.0003, far: 26000 };
  const to = { maxDistance: 2600, fogDensity: 0.00055, far: 20000 };
  for (let i = 0; i < 60 * 4; i++) {
    cur = easeLimits(cur, to, 1 / 60, 4000);
    assert.ok(cur.maxDistance >= 4000, `limit ${cur.maxDistance} would pull the camera in from 4000`);
  }
  // Once the user flies in, the limit follows down to where it belongs.
  for (let i = 0; i < 60 * 4; i++) cur = easeLimits(cur, to, 1 / 60, 1200);
  assert.ok(Math.abs(cur.maxDistance - 2600) < 1, `limit settles at ${cur.maxDistance}`);
});

/** A city of `n` districts on the spiral's blocks, with crowns of these floor counts where they stand. */
function peaked(floors: number[]): CityExtent {
  const spots = [[240, 0], [240, 240], [0, 240], [-240, 240], [-240, 0], [-240, -240], [0, -240], [240, -240], [480, -240], [480, 0], [480, 240], [480, 480], [240, 480], [0, 480]];
  const at = floors.map((f, i) => ({ x: spots[i][0], z: spots[i][1], height: towerTop(f) + CROWN_ALLOWANCE }));
  const cx = at.reduce((s, p) => s + p.x, 0) / at.length;
  const cz = at.reduce((s, p) => s + p.z, 0) / at.length;
  const radius = Math.max(...at.map((p) => Math.hypot(p.x - cx, p.z - cz)));
  return { cx, cz, radius, height: Math.max(...at.map((p) => p.height)), count: at.length, peaks: at };
}

const CITIES = [
  [8],
  [92, 38, 66, 24, 52, 0],
  [120, 38, 120, 24, 52, 0],
  [120, 120, 30, 8, 12, 22, 30, 18, 9, 14],
  [10, 12, 8, 120],
  [0, 0, 0],
];

test('framed on the crowns where they stand, every crown and plaza is inside the frame at home', () => {
  for (const aspect of ASPECTS) {
    for (const floors of CITIES) {
      const e = peaked(floors);
      const { home } = viewLimits(e, aspect);
      for (const p of e.peaks ?? []) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const s = ndc(home.eye, home.target, aspect, [p.x + Math.cos(a) * 14, p.height, p.z + Math.sin(a) * 14]);
          assert.ok(s.z > 0 && s.y < 0.92 && Math.abs(s.x) < 1, `crown of ${floors.join('/')} at ${s.x.toFixed(2)}, ${s.y.toFixed(2)} (aspect ${aspect})`);
          const b = ndc(home.eye, home.target, aspect, [p.x + Math.cos(a) * 30, 0, p.z + Math.sin(a) * 30]);
          assert.ok(b.z > 0 && b.y > -1 && Math.abs(b.x) < 1, `plaza of ${floors.join('/')} at ${b.x.toFixed(2)}, ${b.y.toFixed(2)} (aspect ${aspect})`);
        }
      }
    }
  }
});

test('framed on the crowns where they stand, one tower growing a floor at a time never makes the home framing jump', () => {
  for (const base of CITIES) {
    for (let i = 0; i < base.length; i++) {
      let prev = viewLimits(peaked(base.map((f, j) => (j === i ? 0 : f))), 1.6);
      for (let f = 1; f <= 120; f++) {
        const next = viewLimits(peaked(base.map((g, j) => (j === i ? f : g))), 1.6);
        const step = Math.hypot(...next.home.eye.map((v, k) => v - prev.home.eye[k]));
        const aim = Math.abs(next.home.target[1] - prev.home.target[1]);
        // A floor is 4.2 m: the eye may move a few times that, never a leap.
        assert.ok(step < 30 && aim < 8, `${base.join('/')} tower ${i} at ${f} floors: eye moved ${step.toFixed(1)} m, aim ${aim.toFixed(1)} m`);
        assert.ok(next.homeDistance >= prev.homeDistance - 0.5, `${base.join('/')} tower ${i} at ${f} floors: home came in from ${prev.homeDistance.toFixed(1)} to ${next.homeDistance.toFixed(1)}`);
        prev = next;
      }
    }
  }
});

test('flown out past home, the haze thins so the city reads as it does from home; nearer than home it keeps its density', () => {
  for (const floors of CITIES) {
    const e = peaked(floors);
    const lim = viewLimits(e, 1.6);
    const at = (d: number) => fogFor(lim.fogDensity, lim.homeDistance, d);
    assert.equal(at(lim.homeDistance * 0.3), lim.fogDensity);
    assert.equal(at(lim.homeDistance), lim.fogDensity);
    // The haze on the city's centre at the farthest the camera may go is no thicker than at home
    // (a tiny city, nearly clear at home, may take on a little, so the horizon past it stays haze).
    const home = fogAt(lim.fogDensity, lim.homeDistance);
    const out = fogAt(at(lim.maxDistance), lim.maxDistance);
    assert.ok(out <= Math.max(home, 0.3) + 1e-9,`${floors.join('/')}: ${(out * 100).toFixed(0)}% haze flown out against ${(home * 100).toFixed(0)}% at home`);
    // Continuous, and never thicker as the camera flies out.
    let prev = at(lim.homeDistance);
    for (let d = lim.homeDistance; d <= lim.maxDistance; d *= 1.01) {
      const f = at(d);
      assert.ok(f <= prev + 1e-12 && prev - f < prev * 0.02, `${floors.join('/')} at ${d} m`);
      prev = f;
    }
    // The horizon stays haze from anywhere: the ground's edge 8 km off is all but gone.
    assert.ok(fogAt(at(lim.maxDistance), lim.maxDistance + 8000) > 0.9, `${floors.join('/')}: the horizon shows through`);
  }
});
