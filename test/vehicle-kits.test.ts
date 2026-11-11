import './kit-setup.js';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';

import { hasKit, kitShared } from '../app/src/city/kits.js';
import { codedParts, modelParts } from '../app/src/city/vehicles.js';

// The train's cab car and the cab, modelled in the kit pipeline (tools/kits/kits.py), read from kits.glb in Node.

const PIECES = ['veh_railEnd', 'veh_railEnd_gear', 'veh_cab', 'veh_cab_gear'];

test('kits.glb carries the modelled vehicles and leaves headroom under its cap', () => {
  for (const p of PIECES) assert.ok(hasKit(p), `kit piece ${p}`);
  const size = statSync(new URL('../app/public/kits/kits.glb', import.meta.url)).size;
  assert.ok(size <= 850_000, `kits.glb is ${(size / 1000).toFixed(0)} KB (at most 850 KB, leaving room for the figures)`);
});

test('every coded face of the modelled vehicles maps to a part, nothing is dropped', () => {
  for (const p of PIECES) {
    const parts = codedParts(kitShared(p));
    assert.equal(parts.unknown, 0, `${p}: every face's code is known`);
    assert.ok(parts.total > 100, `${p}: ${parts.total} triangles`);
  }
  const shell = codedParts(kitShared('veh_railEnd'));
  assert.ok(shell.parts.body > 0 && shell.parts.glass > 0 && shell.parts.trim > 0, 'the train shell has body, glazing and running gear');
  const gear = codedParts(kitShared('veh_railEnd_gear'));
  assert.ok(gear.kinds.board > 0 && gear.kinds.head > 0 && gear.kinds.tail > 0, 'its lamps: head, tail and the destination board');
  const cab = codedParts(kitShared('veh_cab'));
  assert.ok(cab.parts.body > 0 && cab.parts.glass > 0, 'the cab has body and canopy');
});

test('with the kits loaded the near train cab car and the cab are the modelled meshes', () => {
  const rail = modelParts('railEnd');
  const cab = modelParts('cab');
  assert.ok(rail.lamp > 0 && rail.glass > 0 && rail.body > 1000, `the cab car draws the modelled shell (${JSON.stringify(rail)})`);
  assert.ok(cab.body > 500, `the cab draws the modelled body (${JSON.stringify(cab)})`);
});
