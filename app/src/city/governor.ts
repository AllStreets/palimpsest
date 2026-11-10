/**
 * The automatic quality drop. The city opens at the quality in Settings;
 * when it cannot hold its frame rate there for several seconds running, or
 * draws more triangles per frame than the budget allows, it steps down to
 * medium once (lighter shadows, no ambient occlusion, a lower pixel ratio,
 * the far level of every kit part) and says so. It never steps back up by
 * itself: a city that flickers between qualities is worse than either.
 *
 * Pure: the scene feeds it each frame's time and triangle count.
 */

/** The frame the city aims for: 60 fps. */
export const TARGET_MS = 1000 / 60;
/** Slower than this on average (under about 48 fps) counts as missing the target. */
export const SLOW_MS = 1000 / 48;
/**
 * Triangles per frame, every pass counted (the shadow map when it redraws,
 * the AO normal pass, the main pass). The sample city draws about 13.4
 * million at high quality from its home framing; the budget leaves room for
 * Part B's river, transit and crowds and stops a city that outgrows it.
 */
export const TRIANGLE_BUDGET = 24_000_000;

export interface GovernorOptions {
  /** The quality the city opened at: a city already at medium has nowhere to go. */
  start?: 'high' | 'medium';
  /** How long the frames must stay slow (or over budget) before the drop, in ms. */
  sustainMs?: number;
  /** Frames in the first this many ms are never judged (shader compiles, texture uploads). */
  warmupMs?: number;
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
  const sustain = o.sustainMs ?? 5000;
  const warmup = o.warmupMs ?? 3000;
  const slow = o.slowMs ?? SLOW_MS;
  const budget = o.triangleBudget ?? TRIANGLE_BUDGET;
  let dropped = o.start === 'medium';
  let elapsed = 0;
  // The window being judged: its length in ms, its frames, and how much of it ran over budget.
  let span = 0;
  let frames = 0;
  let over = 0;
  const reset = (): void => {
    span = 0;
    frames = 0;
    over = 0;
  };
  return {
    frame(ms, triangles) {
      if (dropped) return null;
      if (ms > GAP_MS) {
        reset();
        return null;
      }
      elapsed += ms;
      if (elapsed < warmup) return null;
      span += ms;
      frames++;
      if (triangles > budget) over += ms;
      if (span < sustain) return null;
      const mean = span / frames;
      const due = mean > slow || over >= span * 0.9;
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
