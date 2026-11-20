// Redesign C: the leader from a Brief row to its tower runs in right angles and crosses no other pin.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeLeader, routePath, type Box } from '../app/src/ui/targeting.js';

/** Whether any run of the route passes through a box (its edges included). */
function crosses(pts: Array<[number, number]>, b: Box): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    if (x1 >= b.x0 && x0 <= b.x1 && y1 >= b.y0 && y0 <= b.y1) return true;
  }
  return false;
}

const rightAngled = (pts: Array<[number, number]>): boolean => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);

test('a clear sky: the leader leaves the rail level, climbs, and comes down onto the ring', () => {
  const pts = routeLeader({ x: 760, y: 500 }, { x: 1400, y: 300, r: 21 }, [], 88, 970);
  assert.ok(rightAngled(pts));
  assert.deepEqual(pts[0], [760, 500]);
  assert.deepEqual(pts.at(-1), [1400, 279], 'it ends on the ring, from above');
});

test('pins standing between the row and the tower are routed round, never crossed', () => {
  const pins: Box[] = [
    { x0: 1000, y0: 240, x1: 1180, y1: 300 },
    { x0: 1100, y0: 180, x1: 1280, y1: 236 },
    { x0: 900, y0: 400, x1: 1080, y1: 520 },
  ];
  const pts = routeLeader({ x: 760, y: 460 }, { x: 1400, y: 300, r: 21 }, pins, 88, 970);
  assert.ok(rightAngled(pts));
  for (const b of pins) assert.ok(!crosses(pts, b), `crosses ${JSON.stringify(b)}`);
});

test('the lock tag up and to the left of the ring pushes the channel above it', () => {
  const tag: Box = { x0: 1186, y0: 220, x1: 1386, y1: 274 };
  const pts = routeLeader({ x: 760, y: 600 }, { x: 1400, y: 300, r: 21 }, [tag], 88, 970);
  assert.ok(!crosses(pts, tag));
});

test('the path cuts each corner at 45 degrees', () => {
  assert.equal(routePath([[0, 0], [20, 0], [20, 20]]), 'M0.0,0.0 L14.0,0.0 L20.0,6.0 L20.0,20.0');
});
