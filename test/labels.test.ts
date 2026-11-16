/**
 * The city's name plates (labels.ts): a plate near the viewport's right edge
 * sets its words left of its hairline rather than clipping them, and a
 * tower's plate says what its lit and dark bands are.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as labels from '../app/src/city/labels.js';
import type { Floor } from '../shared/types.js';

const mod = labels as unknown as {
  plateFlips?: (x: number, words: number, viewWidth: number) => boolean;
  plateFits?: (x: number, y: number, words: number, flip: boolean, viewWidth: number, viewHeight: number, margin?: number) => boolean;
  PLATE_FIT_SPARE?: number;
  bandKey?: (floors: readonly Floor[]) => string;
};

test('a plate near the right edge sets its words left of its hairline', () => {
  assert.equal(typeof mod.plateFlips, 'function', 'the plates decide which side of the hairline their words stand');
  // Words 120 px wide on a 1512 px view: right of the hairline while they fit, left of it once they would run past.
  assert.equal(mod.plateFlips!(600, 120, 1512), false);
  assert.equal(mod.plateFlips!(1512 - 7 - 120 - 8, 120, 1512), false);
  assert.equal(mod.plateFlips!(1440, 120, 1512), true, 'Meridian at the right edge flips');
  // Never flipped where the words would then run off the left edge instead.
  assert.equal(mod.plateFlips!(60, 400, 300), false);
});

test('a plate whose name would run off the view is not shown until it fits (Task 15a)', () => {
  assert.equal(typeof mod.plateFits, 'function', 'the plates know when their words are whole on screen');
  // On screen, either side of the hairline.
  assert.equal(mod.plateFits!(600, 500, 120, false, 1512, 890), true);
  assert.equal(mod.plateFits!(1440, 500, 120, true, 1512, 890), true);
  // The foot past the right edge: flipped, the words still run off it (the overview's quarter plates in round 0).
  assert.equal(mod.plateFits!(1560, 500, 120, true, 1512, 890), false);
  // The foot past the left edge, and a name over the top of the view or a foot under its bottom.
  assert.equal(mod.plateFits!(-30, 500, 120, false, 1512, 890), false);
  assert.equal(mod.plateFits!(600, 20, 120, false, 1512, 890), false);
  assert.equal(mod.plateFits!(600, 900, 120, false, 1512, 890), false);
  // Once hidden it shows again only with PLATE_FIT_SPARE pixels to spare, so a plate at the edge does not flicker.
  assert.ok((mod.PLATE_FIT_SPARE ?? 0) >= 4);
  assert.equal(mod.plateFits!(1512 - 7 - 120 - 3, 500, 120, false, 1512, 890), true);
  assert.equal(mod.plateFits!(1512 - 7 - 120 - 3, 500, 120, false, 1512, 890, mod.PLATE_FIT_SPARE), false);
});

const floor = (i: number, state?: 'lit' | 'scar' | 'waiting'): Floor => ({
  id: `acme/w#f${i}`,
  repo: 'acme/w',
  kind: 'pr',
  refs: [],
  title: `change ${i}`,
  at: '2026-11-01T00:00:00Z',
  era: 'glass',
  size: 'medium',
  lines: 10,
  claude: false,
  founding: !state,
  url: null,
  ...(state ? { earned: { jobId: `j${i}`, runId: `r${i}`, agentId: 'a', firmId: 'f', state, reverted: false } } : {}),
});

test("a tower's plate says what its lit and dark bands are, in the inspector's words", () => {
  assert.equal(typeof mod.bandKey, 'function', 'the plate has a band key');
  assert.equal(mod.bandKey!([floor(0), floor(1)]), '', 'a tower with no market floors says nothing');
  assert.equal(mod.bandKey!([floor(0), floor(1, 'lit')]), 'A lit floor is a change a firm built here that you merged.');
  assert.equal(
    mod.bandKey!([floor(0), floor(1, 'lit'), floor(2, 'scar'), floor(3, 'waiting')]),
    'A lit floor is a change a firm built here that you merged; a dark band is a scar, work that failed inspection, kept where it failed; a floor still unlit waits on your review.',
  );
  assert.equal(mod.bandKey!([floor(2, 'scar')]), 'A dark band is a scar, work that failed inspection, kept where it failed.');
});

test("the plates' words carry their own dark ground, and the second line an ink lighter than --ink-2 (Task 15a review)", () => {
  const m = labels as unknown as { PLATE_SHADOW?: string; PLATE_SUB_INK?: string };
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  assert.ok(m.PLATE_SHADOW && /0 0 2px rgba\(10, 9, 12, 0\.9/.test(m.PLATE_SHADOW), 'a tight dark shadow under the letters');
  assert.ok(m.PLATE_SUB_INK && lum(m.PLATE_SUB_INK) > lum('#b9b1a4') && lum(m.PLATE_SUB_INK) < lum('#f4efe6'), `the second line's ink ${m.PLATE_SUB_INK} sits between --ink-2 and the name's`);
});
