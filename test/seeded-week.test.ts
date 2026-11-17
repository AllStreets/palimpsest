/**
 * The week the capture and ui-test tours walk (tools/seeded-week.ts): the seeded history's week, or the one before
 * when that holds more of the tour (a Monday), never the week the run is made in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { previousWeek, weekOf } from '../shared/tour.js';
import { seededWeek } from '../tools/seeded-week.js';

/** A page whose /api/tour answers with `stops[week]` stops. */
function pageWith(stops: Record<string, number>) {
  return {
    evaluate: async (fn: (w: string) => unknown, week: string) => {
      void fn;
      const n = stops[week] ?? 0;
      return n ? { stops: new Array(n).fill(0) } : null;
    },
  } as never;
}

test('the tour walks the seed\'s week, or the one before when that holds more', async () => {
  const at = Date.parse('2026-11-16T09:00:00Z');
  const week = weekOf(at).week;
  const before = previousWeek(week);
  assert.equal(await seededWeek(pageWith({ [week]: 6, [before]: 2 }), at), week);
  assert.equal(await seededWeek(pageWith({ [week]: 0, [before]: 6 }), at), before, 'from Monday the history is last week\'s');
});
