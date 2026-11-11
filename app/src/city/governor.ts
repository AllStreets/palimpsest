/**
 * The automatic quality drop. The city opens at the quality in Settings;
 * when it cannot hold its frame rate there for ten seconds running, or
 * draws more triangles per frame than the budget allows, it steps down to
 * medium once (lighter shadows, no ambient occlusion, a lower pixel ratio,
 * the far level of every kit part) and says so. It never steps back up by
 * itself: a city that flickers between qualities is worse than either.
 *
 * Sustained means sustained: the drop is due only when slow frames fill
 * four fifths of the window's time, not when a few long frames pull the
 * mean down. A screenshot, a capture, a sheet opening or another tab's work
 * each cost a run of long frames among good ones, and none of them is the
 * city's steady rate. Nor are the seconds after a hitch or a hidden tab,
 * when shaders compile and textures upload; those are left out as well.
 *
 * Pure: the scene feeds it each frame's time and triangle count.
 */

/** The frame the city aims for: 60 fps. */
export const TARGET_MS = 1000 / 60;
/** A frame longer than this (under about 48 fps) counts as slow. */
export const SLOW_MS = 1000 / 48;
/**
 * Triangles per frame, every pass counted (the shadow map when it redraws,
 * the AO normal pass, the main pass). The sample city draws about 13.4
 * million at high quality from its home framing; the budget leaves room for
 * Part B's river, transit and crowds and stops a city that outgrows it.
 */
export const TRIANGLE_BUDGET = 24_000_000;
/** The share of a window's time that must be slow (or over budget) for the drop to be due. */
export const SLOW_SHARE = 0.8;

export interface GovernorOptions {
  /** The quality the city opened at: a city already at medium has nowhere to go. */
  start?: 'high' | 'medium';
  /** How long the frames must stay slow (or over budget) before the drop, in ms. */
  sustainMs?: number;
  /** Frames in the first this many ms are never judged (shader compiles, texture uploads). */
  warmupMs?: number;
  /** Frames in this many ms after a gap are never judged either (the same work, after a rebuild or a hidden tab). */
  settleMs?: number;
  slowMs?: number;
  triangleBudget?: number;
}

export interface Governor {
  /** One frame's time in ms and the triangles it drew. Returns 'medium' on the frame the drop is due, else null. */
  frame(ms: number, triangles: number): 'medium' | null;
  readonly dropped: boolean;
}

/** Gaps longer than this are a hidden tab, a rebuild or a hitch, not a frame rate. */
const GAP_MS = 250;

export function qualityGovernor(o: GovernorOptions = {}): Governor {
  const sustain = o.sustainMs ?? 10_000;
  const warmup = o.warmupMs ?? 3000;
  const settle = o.settleMs ?? 1500;
  const slow = o.slowMs ?? SLOW_MS;
  const budget = o.triangleBudget ?? TRIANGLE_BUDGET;
  let dropped = o.start === 'medium';
  let elapsed = 0;
  // Time still to pass, unjudged, after the last gap.
  let settling = 0;
  // The window being judged: its length in ms, how much of it was slow and how much ran over budget.
  let span = 0;
  let slowFor = 0;
  let over = 0;
  const reset = (): void => {
    span = 0;
    slowFor = 0;
    over = 0;
  };
  return {
    frame(ms, triangles) {
      if (dropped) return null;
      if (ms > GAP_MS) {
        reset();
        settling = settle;
        return null;
      }
      elapsed += ms;
      if (elapsed < warmup) return null;
      if (settling > 0) {
        settling -= ms;
        return null;
      }
      span += ms;
      if (ms > slow) slowFor += ms;
      if (triangles > budget) over += ms;
      if (span < sustain) return null;
      const due = slowFor >= span * SLOW_SHARE || over >= span * 0.9;
      reset();
      if (!due) return null;
      dropped = true;
      return 'medium';
    },
    get dropped() {
      return dropped;
    },
  };
}
