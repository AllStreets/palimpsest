import assert from 'node:assert/strict';
import { test } from 'node:test';

import { underSheet } from '../app/src/ui/plate-guard.js';

test('a plate whose foot stands under an open sheet steps aside whole; one past its edge stands whole', () => {
  // The sheet's right edge at 752 px: a plate's words run right from its foot, so a foot at 740 would show half.
  assert.deepEqual(underSheet([740, 751.5, 752, 900, 30], 752), [true, true, false, false, true]);
  // No sheet open: every plate stands.
  assert.deepEqual(underSheet([10, 900], null), [false, false]);
});
