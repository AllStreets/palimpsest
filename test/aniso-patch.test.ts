import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { ANISO_PATCHES, missingAnisoTargets } from '../app/src/city/tower/aniso-patch.js';

test('every line the brushed-metal shader patch replaces is in the installed three', () => {
  assert.deepEqual(missingAnisoTargets(), []);
  for (const p of ANISO_PATCHES) {
    assert.ok(THREE.ShaderChunk[p.chunk].includes(p.target), `${p.chunk} still has: ${p.target}`);
  }
});

test('a three whose shader text has moved on is caught, not silently left unpatched', () => {
  const chunks = { ...THREE.ShaderChunk, lights_physical_fragment: 'void main() {}' };
  const missing = missingAnisoTargets(chunks, THREE.ShaderLib.physical.fragmentShader);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /lights_physical_fragment/);

  const noInclude = missingAnisoTargets(THREE.ShaderChunk, 'void main() {}');
  assert.equal(noInclude.length, 2, 'both includes the patch swaps out must be in the physical shader');
});
