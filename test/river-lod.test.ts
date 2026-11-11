import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AO_NEAR, chunkLod, chunks, DETAIL_NEAR, RIVER_CHUNK, SHADOW_NEAR, waterSettings } from '../app/src/city/river-lod.js';
import { BRIDGES, PIERS } from '../shared/commute.js';

// The sample city's home framing (view.ts), and an eye on the stone bridge's parapet.
const HOME = { x: 540, y: 380, z: 960 };
const ON_BRIDGE = { x: -353, y: 2.6, z: 11.5 };

test('the river is cut into chunks along its length, each bridge and pier inside one chunk', () => {
  const all = chunks();
  assert.ok(all.length >= 30);
  for (let k = 1; k < all.length; k++) assert.equal(all[k].z0, all[k - 1].z1);
  for (const c of all) assert.equal(c.z1 - c.z0, RIVER_CHUNK);
  // Nothing is split across a seam: a bridge's deck and a pier's stage each sit wholly in one chunk.
  for (const z of BRIDGES) assert.ok(all.some((c) => z - 14 >= c.z0 && z + 14 <= c.z1), `bridge at ${z}`);
  for (const p of PIERS) assert.ok(all.some((c) => p.z - 5 >= c.z0 && p.z + 26 <= c.z1), `pier at ${p.z}`);
});

test('from home no chunk draws its detail, casts a shadow or joins the AO pass', () => {
  for (const c of chunks()) {
    const lod = chunkLod(HOME, c);
    assert.deepEqual(lod, { detail: false, shadow: false, ao: false }, `chunk ${c.z0}..${c.z1}`);
  }
});

test('close up the chunk underfoot draws everything, and detail thins with distance', () => {
  const here = chunks().find((c) => ON_BRIDGE.z >= c.z0 && ON_BRIDGE.z < c.z1)!;
  assert.deepEqual(chunkLod(ON_BRIDGE, here), { detail: true, shadow: true, ao: true });
  const far = chunks().find((c) => c.z0 > ON_BRIDGE.z + DETAIL_NEAR + 10)!;
  assert.equal(chunkLod(ON_BRIDGE, far).detail, false);
  // The passes give up a chunk no later than its detail does.
  assert.ok(AO_NEAR <= SHADOW_NEAR && SHADOW_NEAR <= DETAIL_NEAR);
  let last = true;
  for (let z = 0; z < 2000; z += 40) {
    const lod = chunkLod({ ...ON_BRIDGE, z: ON_BRIDGE.z - z }, here);
    if (!last) assert.equal(lod.detail, false, 'detail never comes back farther away');
    last = lod.detail;
  }
});

test('the water steps down with the quality: fewer march steps and a half-resolution colour source at medium', () => {
  assert.deepEqual(waterSettings('high'), { steps: 64, colourScale: 1 });
  assert.deepEqual(waterSettings('medium'), { steps: 40, colourScale: 0.5 });
});
