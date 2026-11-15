import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { BLOCK, PITCH, STREET } from '../app/src/city/lots.js';
import { CROSSING, DROPPED, gutterAt, KERB, KERB_EDGE, kerbShare, kerbTileGeometry, streetFloor, streetSurface, TILE_RADIUS, tileClearsRiver, WEAR_GLSL, wearAt } from '../app/src/city/street.js';
import { BANKS, COPING } from '../shared/commute.js';

// The street floor (Phase 5 Task 1): kerbs along every street edge, dropped at the crossings, gutters beside them, and
// asphalt worn by where it is in the world.

/** Every street edge of the blocks round the origin: the kerb face along z at x = +-KERB_EDGE and along x at z = +-KERB_EDGE of each block. */
function* edges(): Generator<{ cx: number; cz: number; side: 1 | -1; along: 'x' | 'z' }> {
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const side of [1, -1] as const) for (const along of ['x', 'z'] as const) yield { cx: i * PITCH, cz: j * PITCH, side, along };
}

test('every street edge has a kerb 0.15 m high and a gutter 0.45 m wide', () => {
  assert.deepEqual(KERB, { height: 0.15, width: 0.3, gutter: 0.45 });
  // The kerb face stands at the block's half plus the pavement: 36 m from the block's centre on a 64 m block in an 80 m pitch.
  assert.equal(KERB_EDGE, BLOCK / 2 + STREET / 4);
  for (const e of edges()) {
    // Mid-edge, clear of the crossings: on the pavement a step up of the kerb's height, the kerb stone's width in from the face.
    const at = (inward: number, run = 0): [number, number] => (e.along === 'z' ? [e.cx + e.side * (KERB_EDGE - inward), e.cz + run] : [e.cx + run, e.cz + e.side * (KERB_EDGE - inward)]);
    assert.ok(Math.abs(streetFloor(...at(0.05)) - KERB.height) < 1e-9, `the kerb top at ${at(0.05)}`);
    assert.ok(Math.abs(streetFloor(...at(KERB.width)) - KERB.height) < 1e-9, `the pavement behind the kerb stone at ${at(KERB.width)}`);
    assert.ok(Math.abs(streetFloor(...at(2.0, 10)) - KERB.height) < 1e-9, `the pavement at ${at(2.0, 10)}`);
    // Over the face: the carriageway, and the gutter running the kerb's whole length but for the crossings.
    assert.equal(streetFloor(...at(-0.05)), 0, `the road at ${at(-0.05)}`);
    assert.equal(gutterAt(...at(-0.05)), 1, `the gutter under the kerb at ${at(-0.05)}`);
    assert.equal(gutterAt(...at(-KERB.gutter + 0.02, 12)), 1, `the gutter's far edge at ${at(-KERB.gutter + 0.02, 12)}`);
    assert.equal(gutterAt(...at(-KERB.gutter - 0.1)), 0, `past the gutter at ${at(-KERB.gutter - 0.1)}`);
    assert.equal(gutterAt(...at(0.1)), 0, 'no gutter on the pavement');
  }
  // Nothing stands in the middle of a carriageway or at a junction's centre.
  assert.equal(streetFloor(PITCH / 2, 0), 0);
  assert.equal(streetFloor(PITCH / 2, PITCH / 2), 0);
  // The kerb tiles hold the same floor: the tile's top at the kerb's height, its face down to the road, nothing below.
  const g = kerbTileGeometry();
  g.computeBoundingBox();
  assert.ok(Math.abs(g.boundingBox!.max.y - KERB.height) < 1e-6, `tile top ${g.boundingBox!.max.y}`);
  assert.ok(Math.abs(g.boundingBox!.min.y) < 1e-6, `tile foot ${g.boundingBox!.min.y}`);
  assert.ok(Math.abs(g.boundingBox!.max.x - KERB_EDGE) < 1e-6 && Math.abs(g.boundingBox!.min.z + KERB_EDGE) < 1e-6, 'the tile ends at the kerb face on every side');
  assert.ok(g.index && g.index.count / 3 < 600, `a tile is a few hundred triangles (${g.index!.count / 3})`);
});

test('crossings drop the kerb to road level', () => {
  // The crossing lies between the junction's box and the stop line (ambient.ts): the last 2.5 m of every kerb before its corner.
  assert.deepEqual(CROSSING, { from: 4, to: 6.5 });
  for (const e of edges()) {
    const at = (inward: number, run: number): [number, number] => (e.along === 'z' ? [e.cx + e.side * (KERB_EDGE - inward), e.cz + run] : [e.cx + run, e.cz + e.side * (KERB_EDGE - inward)]);
    for (const end of [1, -1]) {
      const onCrossing = end * (PITCH / 2 - (CROSSING.from + CROSSING.to) / 2);
      const dropped = streetFloor(...at(0.05, onCrossing));
      assert.ok(dropped <= KERB.height * DROPPED + 1e-9 && dropped >= 0, `the kerb at the crossing is dropped to a lip (${dropped.toFixed(3)} m at ${at(0.05, onCrossing)})`);
      // The pavement ramps down to it behind the kerb, and is at full height a lane's width back along the run.
      assert.ok(streetFloor(...at(KERB.width + 0.3, onCrossing)) < KERB.height * 0.5, 'the pavement behind the dropped kerb ramps down');
      assert.ok(Math.abs(streetFloor(...at(0.05, onCrossing - end * 6)) - KERB.height) < 1e-9, 'the kerb stands again past the crossing');
      // The ramp along the kerb never steps back up on its way down.
      let last: number = KERB.height;
      for (let s = Math.abs(onCrossing) - 6; s <= Math.abs(onCrossing); s += 0.1) {
        const h = streetFloor(...at(0.05, end * s));
        assert.ok(h <= last + 1e-9, `monotonic at ${s}`);
        last = h;
      }
    }
  }
  // The corner apron itself is dropped on both kerbs that meet there.
  assert.ok(kerbShare(KERB_EDGE - 0.05, KERB_EDGE - 0.05) <= DROPPED + 1e-9);
  assert.equal(kerbShare(0, 0), 1);
  // Away from the junctions the gutter runs; through the crossing it is paved over for the walkers.
  assert.equal(gutterAt(KERB_EDGE + 0.1, 0), 1);
  // The tile geometry carries the drop: its lowest top vertex over a corner sits at the lip.
  const g = kerbTileGeometry();
  const pos = g.attributes.position as THREE.BufferAttribute;
  let cornerTop = Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) > KERB_EDGE - 0.1 && Math.abs(pos.getZ(i)) > KERB_EDGE - 0.1 && pos.getY(i) > 0.001) cornerTop = Math.min(cornerTop, pos.getY(i));
  }
  assert.ok(cornerTop <= KERB.height * DROPPED + 1e-9, `the tile's corner top is dropped (${cornerTop})`);
});

test('wear is deterministic by world position', () => {
  const a = wearAt(117.3, 150.2);
  const b = wearAt(117.3, 150.2);
  assert.deepEqual(a, b);
  for (const k of Object.keys(a) as Array<keyof typeof a>) assert.ok(a[k] >= 0 && a[k] <= 1, `${k} in [0, 1]`);
  // Tyre tracks run where the wheels run: strongest a wheel's half-track off a lane's centre, faint at the lane's centre.
  const lane = PITCH / 2 - 2; // a lane's centre, 2 m right of the street's centre line (ambient.ts LANE)
  let centre = 0;
  let wheel = 0;
  for (let z = -30; z <= 30; z += 1.5) {
    centre += wearAt(lane, z).track;
    wheel += wearAt(lane + 0.78, z).track;
  }
  assert.ok(wheel > centre * 1.5, `tracks under the wheels (${wheel.toFixed(2)}) not between them (${centre.toFixed(2)})`);
  // Oil darkens the lane before a junction's stop line, not mid-block.
  const stop = PITCH / 2 - CROSSING.to - 2.5;
  assert.ok(wearAt(lane, stop).oil > wearAt(lane, 0).oil + 0.2, 'oil at the stop line');
  // The gutter is where the wet collects.
  assert.ok(wearAt(KERB_EDGE + 0.2, 10).wet > wearAt(PITCH / 2, 10).wet, 'wet in the gutter more than at the crown');
  // Patches are sparse and crisp: over a long run some asphalt is patched and most is not.
  let patched = 0;
  const n = 400;
  for (let i = 0; i < n; i++) patched += wearAt(lane + (i % 3) * 0.5, -40 + i * 0.2).patch > 0.5 ? 1 : 0;
  assert.ok(patched > n * 0.02 && patched < n * 0.4, `patches cover a little of the road (${patched} of ${n})`);
  // The shader chunk reads world position and nothing that moves: no time, no eye.
  assert.ok(WEAR_GLSL.includes('streetWear('));
  assert.ok(!/uTime|time\b|uLodEye|cameraPosition/.test(WEAR_GLSL), 'the wear chunk has no time or eye in it');
  // Off the roads there is no wear.
  assert.equal(wearAt(0, 0).track, 0);
});

test('kerbs draw in one instanced call per tier', () => {
  for (const tier of ['high', 'medium'] as const) {
    const s = streetSurface(tier);
    assert.ok(s.kerbs instanceof THREE.InstancedMesh, `${tier}: the kerbs are one instanced mesh`);
    assert.ok(!Array.isArray(s.kerbs.material), `${tier}: one material, so one call per pass`);
    assert.ok(s.asphalt instanceof THREE.Material);
    // Filled for the blocks round the eye, never past its capacity; the eye on the civic plaza sees the blocks round it.
    s.update(new THREE.Vector3(116, 1.6, 180));
    const filled = s.kerbs.count;
    assert.ok(filled > 0 && filled <= s.kerbs.instanceMatrix.count, `${tier}: ${filled} of ${s.kerbs.instanceMatrix.count} tiles`);
    // Moving the eye a step refills; standing still does not.
    const again = s.update(new THREE.Vector3(116, 1.6, 181));
    assert.equal(again, false, `${tier}: a metre's move keeps the fill`);
    assert.ok(s.update(new THREE.Vector3(116 + 2000, 1.6, 180)), `${tier}: a long move refills`);
    // Past the ambient city's far ring there is nothing to draw, and the mesh hides rather than drawing an empty call.
    s.update(new THREE.Vector3(TILE_RADIUS[tier] * PITCH + 2000, 1.6, 0));
    assert.equal(s.kerbs.count, 0);
    assert.equal(s.kerbs.visible, false);
    // The base plane and the tiles share the floor's textures: the asphalt material is the plane's, the tiles' is its own program.
    assert.notEqual(s.kerbs.material, s.asphalt);
    s.dispose();
  }
  // The medium tier draws fewer tiles than high: its reach is shorter.
  const hi = streetSurface('high');
  const md = streetSurface('medium');
  assert.ok(md.kerbs.instanceMatrix.count < hi.kerbs.instanceMatrix.count);
  hi.dispose();
  md.dispose();
});

test('no kerb tile hangs over the river: a block the channel cuts keeps its quay at street level', () => {
  for (let i = -12; i <= 12; i++) {
    const x = i * PITCH;
    const over = x + KERB_EDGE > BANKS.west - COPING && x - KERB_EDGE < BANKS.east + COPING;
    assert.equal(tileClearsRiver(x), !over, `the block at x ${x}`);
    if (over) for (const dx of [-30, -10, 10, 30]) assert.equal(streetFloor(x + dx, 10), 0, `no step up on its quay (${x + dx})`);
  }
  assert.equal(tileClearsRiver(-400), false);
  assert.equal(tileClearsRiver(-320), false);
  assert.equal(tileClearsRiver(-480), true);
});
