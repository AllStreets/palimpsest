/**
 * The week tour's plan (Phase 3 Task 7, ruling 12), pure: from a week and
 * the week's events to a silent walk of at most eight stops between the
 * exchange's two ends. The engine gathers the events from the ledger
 * (`weekTour` in engine/market/milestones.ts); the city drives the camera
 * (Task 17). A week runs from Monday 00:00 local to the next, and is named
 * by its Monday, the same key the brief offers on Monday mornings.
 */
import { localDay } from './day.js';
import { TOUR } from './market-rules.js';
import type { Tour, TourStop } from './types.js';

export interface TourEvent {
  kind: Exclude<TourStop['kind'], 'exchange'>;
  at: string;
  towerId: string | null;
  floorId: string | null;
  agentId: string | null;
  firmId: string | null;
  repo: string | null;
  title: string;
}

export interface Week {
  /** The Monday, YYYY-MM-DD local. */
  week: string;
  /** Monday 00:00 local, ISO. */
  from: string;
  /** The next Monday 00:00 local, ISO. */
  to: string;
}

/** When the week has more stops than the tour takes, the rarer kinds are kept first. */
const RANK: Record<TourEvent['kind'], number> = { skyline: 0, revival: 1, ribbon: 2, scar: 3, merged: 4, firm: 5, hire: 6 };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The moment a week key (YYYY-MM-DD) names: that day's noon, local, so a clock change cannot move it to another day. */
function dayNoon(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

/** The week that holds `now` (a time, or a day key such as the brief's Monday): Monday 00:00 local to the next. */
export function weekOf(now: number | string): Week {
  const d = new Date(typeof now === 'string' ? dayNoon(now) : now);
  const back = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 0, 0, 0);
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 0, 0, 0);
  return { week: localDay(monday.getTime()), from: monday.toISOString(), to: next.toISOString() };
}

/** The day's name, local, as the caption says it. */
export function dayName(at: string): string {
  return DAYS[new Date(Date.parse(at)).getDay()];
}

/**
 * The tour of week `w` from `events`: the ones in the week whose tower still
 * stands, one per floor or milestone, in time order; past `TOUR.maxStops`
 * the rarer kinds are kept. Fewer than `TOUR.minStops` is no tour (null).
 * Each stop dwells `TOUR.dwell` seconds under a caption that names the day
 * ("Ashlar & Vane laid floor 41 on harbor-ledger, Tuesday"); the camera
 * glides `TOUR.glide` seconds into each stop; the exchange opens and closes
 * the walk for `TOUR.exchange` seconds each. About 90 seconds at eight stops.
 */
export function tourPlan(w: Week, events: TourEvent[], standing: ReadonlySet<string>): Tour | null {
  const seen = new Set<string>();
  const inWeek: TourEvent[] = [];
  for (const e of events) {
    if (!e.towerId || !standing.has(e.towerId)) continue;
    if (e.at < w.from || e.at >= w.to) continue;
    const key = `${e.kind}|${e.towerId}|${e.floorId ?? ''}|${e.agentId ?? ''}|${e.firmId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inWeek.push(e);
  }
  if (inWeek.length < TOUR.minStops) return null;
  const byTime = (a: TourEvent, b: TourEvent) => a.at.localeCompare(b.at);
  let kept = [...inWeek].sort(byTime);
  if (kept.length > TOUR.maxStops) {
    kept = [...kept].sort((a, b) => RANK[a.kind] - RANK[b.kind] || byTime(a, b)).slice(0, TOUR.maxStops).sort(byTime);
  }
  const exchange = (at: string, glide: number): TourStop => ({
    kind: 'exchange',
    towerId: null,
    repo: null,
    floorId: null,
    agentId: null,
    firmId: null,
    title: 'The exchange',
    caption: 'The exchange',
    at,
    dwell: TOUR.exchange,
    glide,
  });
  const stops: TourStop[] = [
    exchange(w.from, 0),
    ...kept.map(
      (e): TourStop => ({
        kind: e.kind,
        towerId: e.towerId,
        repo: e.repo,
        floorId: e.floorId,
        agentId: e.agentId,
        firmId: e.firmId,
        title: e.title,
        caption: `${e.title}, ${dayName(e.at)}`,
        at: e.at,
        dwell: TOUR.dwell,
        glide: TOUR.glide,
      }),
    ),
    exchange(w.to, TOUR.glide),
  ];
  const seconds = stops.reduce((sum, s) => sum + s.dwell + s.glide, 0);
  return { week: w.week, from: w.from, to: w.to, stops, seconds };
}

/** The Monday of the week before `week`'s (both YYYY-MM-DD). */
export function previousWeek(week: string): string {
  return weekOf(dayNoon(week) - 7 * 86_400_000).week;
}

/**
 * Which week T walks at `now`: this week, unless it has fewer stops than a
 * tour needs (a Monday morning, say), then the week before, as the
 * Monday brief offers it. `planned` is the tour of a week, or null.
 */
export function tourWeekFor(now: number, planned: (week: string) => { stops: number } | null): string {
  const week = weekOf(now).week;
  const t = planned(week);
  return t && t.stops > 0 ? week : previousWeek(week);
}
