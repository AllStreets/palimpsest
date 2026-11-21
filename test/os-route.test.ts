/**
 * The leader's router (Task 9): from a Brief row's rail to the ring at its tower's head, in right angles, crossing
 * no pin, no tag and no other leader. Where nothing clear exists it gives no route at all, and the lock alone shows.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLEAR, leaderBoxes, routeLeader, routePath, type Box, type Point } from '../app/src/ui/os/route.js';

/** Whether any run of the route passes through a box, its edges included. */
function crosses(pts: Point[], b: Box): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    if (Math.max(ax, bx) >= b.x0 && Math.min(ax, bx) <= b.x1 && Math.max(ay, by) >= b.y0 && Math.min(ay, by) <= b.y1) return true;
  }
  return false;
}

/** Whether any run comes nearer a box than CLEAR. */
const tooNear = (pts: Point[], b: Box): boolean => crosses(pts, { x0: b.x0 - CLEAR + 0.01, y0: b.y0 - CLEAR + 0.01, x1: b.x1 + CLEAR - 0.01, y1: b.y1 + CLEAR - 0.01 });

const rightAngled = (pts: Point[]): boolean => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);

const TO = { x: 1400, y: 300, r: 21 };

function must(pts: Point[] | null): Point[] {
  assert.ok(pts, 'a route');
  return pts;
}

test('a clear sky: right angles, out of the rail, down onto the ring from above', () => {
  const pts = must(routeLeader({ x: 760, y: 500 }, TO, [], 88, 970));
  assert.ok(rightAngled(pts));
  assert.deepEqual(pts[0], [760, 500]);
  assert.deepEqual(pts.at(-1), [1400, 279]);
});

test('pins standing between are routed round, never crossed, and kept CLEAR from', () => {
  const pins: Box[] = [
    { x0: 1000, y0: 240, x1: 1180, y1: 300 },
    { x0: 1100, y0: 180, x1: 1280, y1: 236 },
    { x0: 900, y0: 400, x1: 1080, y1: 520 },
  ];
  const pts = must(routeLeader({ x: 760, y: 460 }, TO, pins, 88, 970));
  assert.ok(rightAngled(pts));
  for (const b of pins) assert.ok(!tooNear(pts, b), `too near ${JSON.stringify(b)}`);
});

test('the flipped lock tag up and left of the ring pushes the channel above it', () => {
  const tag: Box = { x0: 1186, y0: 220, x1: 1386, y1: 274 };
  const pts = must(routeLeader({ x: 760, y: 600 }, TO, [tag], 88, 970));
  assert.ok(!crosses(pts, tag));
  assert.ok(pts.at(-2)![1] <= 220 - CLEAR, 'the channel runs above the tag');
});

test('a wall of pins with one gap still gives a route, through the gap, crossing none', () => {
  // Thirty pins tiling y 88 to 970 at x 1000 to 1100, every gap too tight but one.
  const wall: Box[] = [];
  const pitch = (970 - 88) / 30;
  for (let i = 0; i < 30; i++) {
    const y0 = 88 + i * pitch;
    wall.push({ x0: 1000, x1: 1100, y0, y1: y0 + (i === 3 ? pitch - 17 : pitch - 2) });
  }
  const pts = must(routeLeader({ x: 760, y: 500 }, TO, wall, 88, 970));
  assert.ok(rightAngled(pts));
  assert.ok(pts.length <= 6, `${pts.length} points`);
  assert.deepEqual(pts.at(-1), [1400, 279]);
  for (const b of wall) assert.ok(!crosses(pts, b), `crosses ${JSON.stringify(b)}`);
});

test('a sealed wall gives no leader at all, never one that crosses', () => {
  const wall: Box[] = [];
  const pitch = (970 - 88) / 30;
  for (let i = 0; i < 30; i++) wall.push({ x0: 1000, x1: 1100, y0: 88 + i * pitch, y1: 88 + (i + 1) * pitch });
  assert.equal(routeLeader({ x: 760, y: 500 }, TO, wall, 88, 970), null);
});

test('a pin on the straight way is passed by a detour, when the direct channels are blocked', () => {
  // A band of pins across the whole sky at x 1000 to 1100 except a gap low down, and a pin over the tower's column
  // that the channel through that gap would run into: the route has to change channel past the wall.
  const blocks: Box[] = [
    { x0: 1000, x1: 1100, y0: 88, y1: 700 },
    { x0: 1000, x1: 1100, y0: 740, y1: 970 },
    { x0: 1300, x1: 1500, y0: 600, y1: 970 },
  ];
  const pts = must(routeLeader({ x: 760, y: 500 }, TO, blocks, 88, 970));
  assert.ok(rightAngled(pts));
  for (const b of blocks) assert.ok(!tooNear(pts, b), `too near ${JSON.stringify(b)}`);
  assert.deepEqual(pts.at(-1), [1400, 279]);
});

test('from above beats from below', () => {
  const pts = must(routeLeader({ x: 760, y: 300 }, { x: 1400, y: 520, r: 21 }, [], 88, 970));
  const last = pts.at(-1)!;
  const before = pts.at(-2)!;
  assert.equal(last[0], before[0], 'the last run is vertical');
  assert.ok(last[1] < 520 && before[1] < last[1], 'it comes down');
});

test('a second leader avoids the first', () => {
  const a = must(routeLeader({ x: 760, y: 500 }, TO, [], 88, 970));
  const boxesA = leaderBoxes(a);
  assert.equal(boxesA.length, a.length - 1, 'one box a run');
  const b = must(routeLeader({ x: 760, y: 620 }, { x: 1200, y: 420, r: 21 }, boxesA, 88, 970));
  for (const box of boxesA) assert.ok(!crosses(b, box), `B crosses A at ${JSON.stringify(box)}`);
});

test('leaderBoxes are thin boxes round each run', () => {
  assert.deepEqual(leaderBoxes([[0, 0], [20, 0], [20, 30]], 4), [
    { x0: 0, y0: -2, x1: 20, y1: 2 },
    { x0: 18, y0: 0, x1: 22, y1: 30 },
  ]);
});

test('routePath cuts each corner at 45 degrees', () => {
  assert.equal(routePath([[0, 0], [20, 0], [20, 20]]), 'M0.0,0.0 L14.0,0.0 L20.0,6.0 L20.0,20.0');
  assert.equal(routePath([]), '');
});

test('deterministic: the same input gives the same route', () => {
  const avoid: Box[] = [{ x0: 1000, y0: 240, x1: 1180, y1: 300 }];
  assert.deepEqual(routeLeader({ x: 760, y: 460 }, TO, avoid, 88, 970), routeLeader({ x: 760, y: 460 }, TO, avoid, 88, 970));
});
