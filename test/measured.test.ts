import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AMBIENT_INPUTS, AMBIENT_RENDERED } from '../app/src/city/ambient-rendered.js';
import { TONES } from '../app/src/city/lots.js';
import { RENDERED, RENDERED_INPUTS } from '../app/src/city/tower/rendered.js';
import { VARIANTS } from '../app/src/city/tower/variants.js';
import * as inputs from '../tools/measure-inputs.js';
import { ambientInputs, towerInputs } from '../tools/measure-inputs.js';

// The measured colour tables are screenshots turned into numbers. When what they were measured from changes
// (a palette, a material, the grade, the light), they no longer describe the city, and nothing else would say so.
// Each row carries its own stamp (Task 15): the inputs every row shares and the row's own material parameters.

/** Read off the module, so a build without them fails these tests alone. */
const I = inputs as unknown as Record<string, unknown>;
const staleRows = (I.staleRows ?? (() => ['(no staleRows)'])) as (stored: string, now: string, ids: Iterable<string>) => string[];

test("the towers' rendered colours were measured from the look the city has now", () => {
  const stale = staleRows(RENDERED_INPUTS, towerInputs(), Object.keys(RENDERED));
  assert.deepEqual(
    stale,
    [],
    `rows of app/src/city/tower/rendered.ts measured from other inputs than today's: ${stale.join(', ')}. ` +
      'Re-measure deliberately: npm run build && SWATCH_WRITE=1 node --import tsx tools/capture.ts swatches, review the picks it changes, and commit it with the reason.',
  );
});

test("the ambient city's rendered colours were measured from the look the city has now", () => {
  const stale = staleRows(AMBIENT_INPUTS, ambientInputs(), Object.keys(AMBIENT_RENDERED));
  assert.deepEqual(
    stale,
    [],
    `rows of app/src/city/ambient-rendered.ts measured from other inputs than today's: ${stale.join(', ')}. ` +
      'Re-measure deliberately: npm run build && AMBIENT_WRITE=1 node --import tsx tools/capture.ts ambient, rerun test/ambient.test.ts, and commit it with the reason.',
  );
});

test("the measured table is stale when a look's parameters change", () => {
  const before = towerInputs();
  const v = VARIANTS.stone.find((x) => x.id === 'stone:limestone')!;
  const wall = v.wall;
  try {
    // One look's wall, a shade darker: that row is stale, by name, and no other.
    v.wall = { ...wall, ...(wall.kind === 'scan' ? { body: wall.body - 0x010101 } : { color: wall.color - 0x010101 }) } as typeof wall;
    assert.deepEqual(staleRows(before, towerInputs(), Object.keys(RENDERED)), ['stone:limestone']);
  } finally {
    v.wall = wall;
  }
  assert.deepEqual(staleRows(before, towerInputs(), Object.keys(RENDERED)), [], 'restored, nothing is stale');
  // An ambient tone the same way.
  const amb = ambientInputs();
  const t = TONES.walkup[0];
  const was = t.wall;
  try {
    t.wall = was ^ 0x000101;
    assert.deepEqual(staleRows(amb, ambientInputs(), Object.keys(AMBIENT_RENDERED)), [t.id]);
  } finally {
    t.wall = was;
  }
  // A row with no stamp at all is stale.
  assert.deepEqual(staleRows('rows ', towerInputs(), ['stone:limestone']), ['stone:limestone']);
  // Every variant and tone is measured, and stamped.
  for (const list of Object.values(VARIANTS)) for (const x of list) assert.ok(RENDERED[x.id], `${x.id} has a row`);
  for (const list of Object.values(TONES)) for (const x of list) assert.ok(AMBIENT_RENDERED[x.id], `${x.id} has a row`);
});
