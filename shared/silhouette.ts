/**
 * How an agent works shapes the top of its tower (spec 6.2, ruling 25). Pure
 * numbers shared by the engine and the city: which silhouette a temperament
 * gets, how each earned floor sits on the one below, and what stands on the roof.
 */
import type { Silhouette } from './types.js';

/** Degrees a lens tower turns per earned floor. */
export const LENS_TWIST_DEG = 1.5;
/** Earned floors per ring of the lens crown. */
export const LENS_FLOORS_PER_RING = 5;
/** How far, in metres, a cantilever floor steps out. */
export const CANTILEVER_STEP = 3;
/** Every this many earned floors, a cantilever floor steps out. */
export const CANTILEVER_EVERY = 3;
/** A needle narrows to this share of its base width... */
export const NEEDLE_MIN_SHARE = 0.6;
/** ...over this many earned floors, then holds. */
export const NEEDLE_TAPER_FLOORS = 20;

/**
 * The silhouette a temperament earns. Careful reviewers twist and grow a lens,
 * fast builders cantilever, specialists go needle-thin, anyone else stays plain.
 */
export function silhouetteFor(temperament: string): Silhouette {
  const t = temperament.toLowerCase();
  if (/\bspecialist/.test(t)) return 'needle';
  if (/\b(careful|review)/.test(t)) return 'lens';
  if (/\b(fast|quick)/.test(t)) return 'cantilever';
  return 'plain';
}

/**
 * Where earned floor `earnedIndex` (0 is the first floor above the datum)
 * sits: its turn about the tower's axis in radians, its step out in metres,
 * its width, and whether steel brackets carry it. Founding floors are never
 * transformed; the caller applies this to earned floors only.
 */
export function floorTransform(
  s: Silhouette,
  earnedIndex: number,
  baseWidth: number,
): { rotY: number; offsetX: number; offsetZ: number; width: number; bracket: boolean } {
  const n = Math.max(0, Math.floor(earnedIndex)) + 1; // the nth earned floor
  const plain = { rotY: 0, offsetX: 0, offsetZ: 0, width: baseWidth, bracket: false };
  switch (s) {
    case 'lens':
      return { ...plain, rotY: (n * LENS_TWIST_DEG * Math.PI) / 180 };
    case 'cantilever': {
      if (n % CANTILEVER_EVERY !== 0) return plain;
      const step = n / CANTILEVER_EVERY; // 1 for the third floor, 2 for the sixth...
      return { ...plain, offsetX: step % 2 === 1 ? CANTILEVER_STEP : -CANTILEVER_STEP, bracket: true };
    }
    case 'needle': {
      const share = 1 - (1 - NEEDLE_MIN_SHARE) * (Math.min(n, NEEDLE_TAPER_FLOORS) / NEEDLE_TAPER_FLOORS);
      return { ...plain, width: baseWidth * share };
    }
    default:
      return plain;
  }
}

/**
 * What stands on the roof after `earnedCount` earned floors: a lens crown
 * with one ring per five floors, a spire that lengthens as the needle climbs
 * (until the taper ends), or nothing. Heights are in metres.
 */
export function crownFor(
  s: Silhouette,
  earnedCount: number,
): { kind: 'lens' | 'spire' | 'none'; rings: number; height: number } {
  const n = Math.max(0, Math.floor(earnedCount));
  if (s === 'lens') {
    const rings = Math.floor(n / LENS_FLOORS_PER_RING);
    return { kind: 'lens', rings, height: 2.4 + 1.2 * rings };
  }
  if (s === 'needle') {
    return { kind: 'spire', rings: 0, height: 8 + 0.6 * Math.min(n, NEEDLE_TAPER_FLOORS) };
  }
  return { kind: 'none', rings: 0, height: 0 };
}
