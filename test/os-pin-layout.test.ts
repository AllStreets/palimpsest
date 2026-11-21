/**
 * Pin placement and the lock's geometry (Task 9), as pure functions: which pins stand this frame, how far each
 * lifts to clear the ones before it, where the lock stands round its tower and where its tag goes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOCK_TAG,
  PIN_TAG,
  lockGeometry,
  lockTagBox,
  pinLabel,
  pinTagBox,
  placePins,
  tagCustomProperties,
  type PinCandidate,
  type Projected,
  type View,
} from '../app/src/ui/os/pin-layout.js';

const VIEW: View = { w: 1440, h: 900, left: 560 };
const at = (x: number, y: number, behind = false): Projected => ({ x, y, behind });
const target = (repo: string, a: Projected | null, w = 150, h = 36): PinCandidate => ({ repo, quiet: false, locked: false, at: a, w, h });

test('a tower behind the eye or not built gets no pin', () => {
  const out = placePins([target('a/none', null), target('a/behind', at(800, 400, true))], [], VIEW);
  assert.deepEqual(out, [
    { repo: 'a/none', shown: false, lift: 0, box: null },
    { repo: 'a/behind', shown: false, lift: 0, box: null },
  ]);
});

test('a pin over the panel, or past an edge, waits', () => {
  const out = placePins(
    [target('a', at(VIEW.left + 10, 400)), target('b', at(VIEW.w - 20, 400)), target('c', at(800, 80)), target('d', at(800, VIEW.h - 30)), target('e', at(800, 400))],
    [],
    VIEW,
  );
  assert.deepEqual(out.map((p) => p.shown), [false, false, false, false, true]);
});

test('a shown pin\'s box is its tag and its stem, from the shared offsets', () => {
  const [p] = placePins([target('a', at(800, 400), 150, 36)], [], VIEW);
  assert.deepEqual(p.box, { x0: 793, x1: 960, y0: 352, y1: 407 });
  assert.deepEqual(pinTagBox(at(800, 400), 150, 36), p.box);
});

test('two targets on neighbouring towers: the later one lifts by h + 14', () => {
  const out = placePins([target('a', at(800, 400)), target('b', at(840, 380))], [], VIEW);
  assert.equal(out[0].lift, 0);
  assert.equal(out[1].lift, 36 + 14);
  assert.ok(out[1].shown);
  // Its box reaches from the lifted tag down to its own mark, so a leader keeps clear of the stem.
  assert.deepEqual(out[1].box, { x0: 833, x1: 1000, y0: 380 - 12 - 36 - 50, y1: 387 });
});

test('a target lifts clear of a reserved box', () => {
  const out = placePins([target('a', at(800, 400))], [{ x0: 780, x1: 900, y0: 380, y1: 420 }], VIEW);
  assert.equal(out[0].lift, 50);
});

test('a quiet pin never lifts and waits over a target\'s tag, and stands where it is clear', () => {
  const quiet = (repo: string, a: Projected): PinCandidate => ({ repo, quiet: true, locked: false, at: a, w: 80, h: 18 });
  const out = placePins([target('t', at(800, 400)), quiet('q1', at(830, 405)), quiet('q2', at(1200, 600))], [], VIEW);
  assert.deepEqual(out[1], { repo: 'q1', shown: false, lift: 0, box: null });
  assert.equal(out[2].shown, true);
  assert.equal(out[2].lift, 0);
});

test('lifting stops at 4: the sixth stands at the fourth lift, overlapping, never higher', () => {
  const out = placePins(Array.from({ length: 6 }, (_, i) => target(`r${i}`, at(800, 600))), [], VIEW);
  assert.deepEqual(out.map((p) => p.lift), [0, 50, 100, 150, 200, 200]);
  assert.ok(out.every((p) => p.shown));
});

test('the locked pin is shown, takes no room and adds no box', () => {
  const locked: PinCandidate = { repo: 'L', quiet: false, locked: true, at: at(800, 400), w: 150, h: 36 };
  const out = placePins([locked, target('b', at(810, 400))], [], VIEW);
  assert.deepEqual(out[0], { repo: 'L', shown: true, lift: 0, box: null });
  assert.equal(out[1].lift, 0);
});

test('placements come back in input order', () => {
  const out = placePins([target('z', at(900, 300)), target('a', at(1200, 600))], [], VIEW);
  assert.deepEqual(out.map((p) => p.repo), ['z', 'a']);
});

test('lockGeometry: null when either end is behind or the head is off the pane', () => {
  const frame = { width: 20, height: 60 };
  assert.equal(lockGeometry(at(900, 300, true), at(900, 600), frame, VIEW), null);
  assert.equal(lockGeometry(at(900, 300), at(900, 600, true), frame, VIEW), null);
  assert.equal(lockGeometry(at(VIEW.left + 18, 300), at(VIEW.left + 18, 600), frame, VIEW), null);
  assert.equal(lockGeometry(at(VIEW.w - 24, 300), at(VIEW.w - 24, 600), frame, VIEW), null);
});

test('lockGeometry: x from the head, half from the tower\'s own aspect, clamped 16 to 70', () => {
  // tall 300, width / height 1/3: half = 300 / 3 / 2 + 10 = 60.
  assert.deepEqual(lockGeometry(at(900, 300), at(905, 600), { width: 20, height: 60 }, VIEW), { x: 900, top: 286, base: 606, half: 60 });
  assert.equal(lockGeometry(at(900, 300), at(900, 800), { width: 60, height: 60 }, VIEW)!.half, 70);
  assert.equal(lockGeometry(at(900, 300), at(900, 310), { width: 5, height: 60 }, VIEW)!.half, 16);
  // top and base hold inside the pane's head and foot.
  const g = lockGeometry(at(900, 40), at(900, 890), { width: 10, height: 60 }, VIEW)!;
  assert.equal(g.top, 78);
  assert.equal(g.base, VIEW.h - 30);
});

test('lockTagBox: right of the brackets, and flipped up and left, clear of the lock, at the right edge', () => {
  const lock = { x: 900, top: 286, base: 606, half: 40 };
  const right = lockTagBox(lock, VIEW);
  assert.equal(right.flip, false);
  assert.deepEqual(right.box, { x0: 952, x1: 952 + LOCK_TAG.w, y0: 282, y1: 338 });
  const edge = { ...lock, x: VIEW.w - 100 };
  const flipped = lockTagBox(edge, VIEW);
  assert.equal(flipped.flip, true);
  assert.equal(flipped.box.x1, edge.x - edge.half - 7);
  assert.ok(flipped.box.y1 < edge.top, 'it stands above the lock');
  // It flips exactly when the unflipped tag would pass w - 28.
  const justFits = { ...lock, x: VIEW.w - 28 - 200 - 12 - 40 };
  assert.equal(lockTagBox(justFits, VIEW).flip, false);
  assert.equal(lockTagBox({ ...justFits, x: justFits.x + 1 }, VIEW).flip, true);
});

test('a district pin shared by several items: its lowest number, plus how many more', () => {
  assert.equal(pinLabel([7]), '07');
  assert.equal(pinLabel([12, 3, 9]), '03 +2');
  assert.equal(pinLabel([]), '');
});

test('the tag offsets reach the sheet as custom properties, from the same constants', () => {
  const props = tagCustomProperties();
  assert.equal(props['--os-pin-tag-x'], `${PIN_TAG.dx}px`);
  assert.equal(props['--os-pin-tag-y'], `${PIN_TAG.dy}px`);
  assert.equal(props['--os-lock-tag-w'], `${LOCK_TAG.w}px`);
  assert.equal(props['--os-lock-tag-gap'], `${LOCK_TAG.gap}px`);
  for (const v of Object.values(props)) assert.match(v, /^-?\d+(\.\d+)?px$/);
});
