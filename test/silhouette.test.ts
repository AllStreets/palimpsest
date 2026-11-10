import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crownFor, floorTransform, silhouetteFor } from '../shared/silhouette.js';

const DEG = Math.PI / 180;

test('silhouette maps careful reviewers to lens, fast builders to cantilever, specialists to needle', () => {
  assert.equal(silhouetteFor('careful reviewers'), 'lens');
  assert.equal(silhouetteFor('fast builders'), 'cantilever');
  assert.equal(silhouetteFor('specialists on high tier only'), 'needle');
  assert.equal(silhouetteFor('specialist in tests'), 'needle');
  assert.equal(silhouetteFor('local heavy lifters'), 'plain');
  assert.equal(silhouetteFor('cheap small jobs'), 'plain');
  assert.equal(silhouetteFor(''), 'plain');
});

test('lens twists 1.5 degrees per earned floor and grows a ring every five floors', () => {
  // The tenth earned floor (index 9) has turned 15 degrees on the datum.
  assert.ok(Math.abs(floorTransform('lens', 9, 16).rotY - 15 * DEG) < 1e-9);
  assert.ok(Math.abs(floorTransform('lens', 0, 16).rotY - 1.5 * DEG) < 1e-9);
  assert.equal(floorTransform('lens', 9, 16).width, 16);
  assert.deepEqual(crownFor('lens', 10).kind, 'lens');
  assert.equal(crownFor('lens', 10).rings, 2);
  assert.equal(crownFor('lens', 4).rings, 0);
  assert.ok(crownFor('lens', 10).height > crownFor('lens', 4).height);
});

test('cantilever steps every third floor and alternates sides', () => {
  const t = (i: number) => floorTransform('cantilever', i, 16);
  // Third and sixth earned floors (indices 2 and 5) step out 3 m to opposite sides on brackets.
  assert.equal(t(2).offsetX, 3);
  assert.equal(t(2).bracket, true);
  assert.equal(t(5).offsetX, -3);
  assert.equal(t(5).bracket, true);
  assert.equal(t(8).offsetX, 3);
  for (const i of [0, 1, 3, 4, 6, 7]) {
    assert.equal(t(i).offsetX, 0, `floor index ${i}`);
    assert.equal(t(i).bracket, false, `floor index ${i}`);
  }
  for (let i = 0; i < 12; i++) {
    assert.equal(t(i).rotY, 0);
    assert.equal(t(i).offsetZ, 0);
    assert.equal(t(i).width, 16);
  }
  assert.equal(crownFor('cantilever', 9).kind, 'none');
});

test('needle tapers to 60 percent at twenty floors', () => {
  const w = (i: number) => floorTransform('needle', i, 16).width;
  assert.ok(Math.abs(w(19) - 16 * 0.6) < 1e-9);
  assert.ok(Math.abs(w(40) - 16 * 0.6) < 1e-9, 'the taper holds at 60 percent above twenty floors');
  assert.ok(w(0) < 16 && w(0) > w(9) && w(9) > w(19));
  const spire = crownFor('needle', 20);
  assert.equal(spire.kind, 'spire');
  assert.ok(spire.height > 0);
});

test('plain leaves every floor alone and has no crown', () => {
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(floorTransform('plain', i, 16), { rotY: 0, offsetX: 0, offsetZ: 0, width: 16, bracket: false });
  }
  assert.deepEqual(crownFor('plain', 12), { kind: 'none', rings: 0, height: 0 });
});
