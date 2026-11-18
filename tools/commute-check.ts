/**
 * The commute clip's tram check: did the followed walker board the tram within
 * the clip? Read from the people system's trip state (the figure probe's
 * stage and ride), so a walker who never boarded cannot be kept as the tram leg.
 */

/** The part of a figure probe the check reads (people-stage.ts FigureProbe). */
export interface TripState {
  stage: 'walk' | 'wait' | 'board' | 'ride' | 'alight' | 'idle';
  ride: { mode: string; id: string; phase: string } | null;
}

/** The walkers tried for the tram leg, in order: the first, then up to MAX_RETRIES others. */
export const TRAM_WALKERS = ['dagny-hollis', 'teodor-vane', 'ines-ashlar'] as const;
export const MAX_RETRIES = 2;

/** True when any state seen during the clip has the figure riding a tram. */
export function boardedTram(seen: ReadonlyArray<TripState | null>): boolean {
  return seen.some((s) => !!s && s.stage === 'ride' && s.ride?.mode === 'tram');
}
