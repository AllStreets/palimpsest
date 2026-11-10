import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMBIENT_INPUTS } from '../app/src/city/ambient-rendered.js';
import { RENDERED_INPUTS } from '../app/src/city/tower/rendered.js';
import { ambientInputs, towerInputs } from '../tools/measure-inputs.js';

// The measured colour tables are screenshots turned into numbers. When what they were measured from changes
// (a palette, a material, the grade, the light), they no longer describe the city, and nothing else would say so.

test("the towers' rendered colours were measured from the look the city has now", () => {
  assert.equal(
    towerInputs(),
    RENDERED_INPUTS,
    'tower variants, their materials, the swatch board or the scene light changed since app/src/city/tower/rendered.ts was measured. ' +
      'Re-measure deliberately: npm run build && SWATCH_WRITE=1 node --import tsx tools/capture.ts swatches, review the picks it changes, and commit it with the reason.',
  );
});

test("the ambient city's rendered colours were measured from the look the city has now", () => {
  assert.equal(
    ambientInputs(),
    AMBIENT_INPUTS,
    'ambient tones, sections, facades, the ambient board or the scene light changed since app/src/city/ambient-rendered.ts was measured. ' +
      'Re-measure deliberately: npm run build && AMBIENT_WRITE=1 node --import tsx tools/capture.ts ambient, rerun test/ambient.test.ts, and commit it with the reason.',
  );
});
