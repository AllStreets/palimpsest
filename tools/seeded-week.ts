/**
 * The week the tour walks in a run that seeds its own history (capture, ui-test): the seed's week, never the week
 * the run is made in, which from Monday can have nothing in it yet.
 */
import type { Page } from 'playwright';

import { previousWeek, weekOf } from '../shared/tour.js';

/**
 * The week the seeded history falls in: the seed's own week, or the one before when that holds more of the tour
 * (seeded early in a week, as on a Monday, the history is last week's). Not the week the run is made in.
 */
export async function seededWeek(page: Page, seededAt: number): Promise<string> {
  const stops = async (week: string): Promise<number> => {
    const t = (await page.evaluate((w) => fetch(`/api/tour?week=${w}`).then((r) => (r.ok ? r.json() : null)), week)) as { stops?: unknown[] } | null;
    return t?.stops?.length ?? 0;
  };
  const week = weekOf(seededAt).week;
  const before = previousWeek(week);
  return (await stops(week)) >= (await stops(before)) ? week : before;
}
