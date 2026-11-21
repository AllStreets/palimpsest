/**
 * Where the pins and the lock stand this frame, as pure functions of where their towers project: which pins show,
 * how far each lifts to clear the ones placed before it, the lock's brackets round its tower and where its tag goes.
 * The tag offsets here are the only copy: pins.css reads them through the custom properties tagCustomProperties()
 * gives, so the boxes the router keeps clear of and the tags drawn on screen never drift apart.
 */
import type { Box } from './route.js';

/** A point projected into the view, in CSS pixels, and whether it lies behind the eye. */
export interface Projected {
  x: number;
  y: number;
  behind: boolean;
}

/** The view the pins stand in. `left` is the pane's left edge, the panel's right. */
export interface View {
  w: number;
  h: number;
  left: number;
}

/** The lock round a tower: its line, the brackets' top and base, and their half width. */
export interface LockAt {
  x: number;
  top: number;
  base: number;
  half: number;
}

/**
 * A pin's tag about its mark at (x, y): its face starts `dx` right of the mark and its foot stands `dy` above it.
 * Its box reaches `padLeft` left of the mark and `padBelow` below it, so the mark and stem are kept clear too.
 * A tag that would overlap lifts by its own height plus `gap`, at most `maxLifts` times.
 */
export const PIN_TAG = Object.freeze({ dx: 10, dy: 12, padLeft: 7, padBelow: 7, gap: 14, maxLifts: 4 });

/**
 * The lock's tag: `w` by `h`, standing `gap` right of the brackets with its top `rise` above theirs. Past the
 * view's right edge less `edge` it flips: up and left of the ring, its right edge `flipGap` clear of the brackets
 * and its foot `flipRise` above their top, clear of a leader climbing in from below.
 */
export const LOCK_TAG = Object.freeze({ w: 200, h: 56, gap: 12, rise: 4, flipGap: 7, flipRise: 26, edge: 28 });

/** Where a pin may stand: right of the panel, inside the view's edges, below the top bar and above the foot. */
const PANE = Object.freeze({ left: 18, right: 24, top: 84, bottom: 40 });
/** Where the lock's brackets may reach: below the top bar, above the foot. */
const LOCK = Object.freeze({ top: 78, bottom: 30, headPad: 14, footPad: 6, minHalf: 16, maxHalf: 70, halfPad: 10 });

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The custom properties pins.css reads the tag offsets from, set on the pins' root from these constants. */
export function tagCustomProperties(): Record<string, string> {
  return {
    '--os-pin-tag-x': `${PIN_TAG.dx}px`,
    '--os-pin-tag-y': `${PIN_TAG.dy}px`,
    '--os-pin-lift-gap': `${PIN_TAG.gap}px`,
    '--os-lock-tag-w': `${LOCK_TAG.w}px`,
    '--os-lock-tag-h': `${LOCK_TAG.h}px`,
    '--os-lock-tag-gap': `${LOCK_TAG.gap}px`,
    '--os-lock-tag-rise': `${LOCK_TAG.rise}px`,
    '--os-lock-tag-flip-gap': `${LOCK_TAG.flipGap}px`,
    '--os-lock-tag-flip-rise': `${LOCK_TAG.flipRise}px`,
  };
}

/** A district pin's number: the lowest item number there, plus how many more share it ("03 +2"). */
export function pinLabel(ns: number[]): string {
  if (ns.length === 0) return '';
  const k = ns.length - 1;
  return k > 0 ? `${pad2(Math.min(...ns))} +${k}` : pad2(ns[0]);
}

/** A pin's whole box at a lift: its tag, the stem down to its mark, and the mark. What a leader keeps clear of. */
export function pinTagBox(at: { x: number; y: number }, w: number, h: number, lift = 0): Box {
  return { x0: at.x - PIN_TAG.padLeft, x1: at.x + PIN_TAG.dx + w, y0: at.y - PIN_TAG.dy - h - lift, y1: at.y + PIN_TAG.padBelow };
}

/** Just the tag's face at a lift: what another tag may not overlap. */
const faceBox = (at: { x: number; y: number }, w: number, h: number, lift: number): Box => ({
  x0: at.x - PIN_TAG.padLeft,
  x1: at.x + PIN_TAG.dx + w,
  y0: at.y - PIN_TAG.dy - h - lift,
  y1: at.y - PIN_TAG.dy - lift,
});

/** Just the mark, which never moves. */
const markBox = (at: { x: number; y: number }): Box => ({ x0: at.x - PIN_TAG.padLeft, x1: at.x + PIN_TAG.padLeft, y0: at.y - PIN_TAG.dy, y1: at.y + PIN_TAG.padBelow });

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Whether a projected point stands where a pin may show. */
const inPane = (p: Projected, view: View): boolean =>
  !p.behind && p.x > view.left + PANE.left && p.x < view.w - PANE.right && p.y > PANE.top && p.y < view.h - PANE.bottom;

/**
 * The lock round a tower, from its head and foot projected and its frame's own size; null when either end is
 * behind the eye or the head is off the pane.
 */
export function lockGeometry(head: Projected, foot: Projected, frame: { width: number; height: number }, view: View): LockAt | null {
  if (head.behind || foot.behind) return null;
  if (!(head.x > view.left + PANE.left && head.x < view.w - PANE.right)) return null;
  const tall = foot.y - head.y;
  const half = Math.max(LOCK.minHalf, Math.min(LOCK.maxHalf, (tall * frame.width) / Math.max(1e-6, frame.height) / 2 + LOCK.halfPad));
  return { x: head.x, top: Math.max(LOCK.top, head.y - LOCK.headPad), base: Math.min(view.h - LOCK.bottom, foot.y + LOCK.footPad), half };
}

/**
 * The lock's tag box: right of the brackets, or flipped up and left of the ring when it would pass the view's edge.
 * Its top never stands above `top` (the pane's top, Task 10): a tag that would drops to it whole.
 */
export function lockTagBox(lock: LockAt, view: View, top = -Infinity): { box: Box; flip: boolean } {
  const flip = lock.x + lock.half + LOCK_TAG.gap + LOCK_TAG.w > view.w - LOCK_TAG.edge;
  let x0: number;
  let y0: number;
  if (flip) {
    x0 = lock.x - lock.half - LOCK_TAG.flipGap - LOCK_TAG.w;
    y0 = lock.top - LOCK_TAG.flipRise - LOCK_TAG.h;
  } else {
    x0 = lock.x + lock.half + LOCK_TAG.gap;
    y0 = lock.top - LOCK_TAG.rise;
  }
  y0 = Math.max(y0, top);
  return { flip, box: { x0, x1: x0 + LOCK_TAG.w, y0, y1: y0 + LOCK_TAG.h } };
}

/** One pin to place: its district, whether it is quiet or the one locked on, where its tower's head projects, and its tag's size. */
export interface PinCandidate {
  repo: string;
  quiet: boolean;
  locked: boolean;
  at: Projected | null;
  w: number;
  h: number;
}

/** Where a pin stands this frame: whether it shows, how far its tag lifts, and its box for the router (null when it takes no room). */
export interface PinPlacement {
  repo: string;
  shown: boolean;
  lift: number;
  box: Box | null;
}

/**
 * Places the pins in input order, each clear of `reserved` (the lock's tag and ring) and of those placed before it.
 * A target's tag lifts by its height plus the gap, at most four times, and stands at the last lift even if it
 * still overlaps. A quiet pin never lifts: it waits while it would overlap. The locked pin shows but takes no room,
 * because the lock names its tower.
 */
export function placePins(cands: PinCandidate[], reserved: Box[], view: View): PinPlacement[] {
  const taken: Box[] = [...reserved];
  return cands.map((c): PinPlacement => {
    const hidden: PinPlacement = { repo: c.repo, shown: false, lift: 0, box: null };
    const at = c.at;
    if (!at || !inPane(at, view)) return hidden;
    if (c.locked) return { repo: c.repo, shown: true, lift: 0, box: null };
    const hit = (b: Box): boolean => taken.some((o) => overlaps(b, o));
    let lift = 0;
    if (c.quiet) {
      if (hit(pinTagBox(at, c.w, c.h))) return hidden;
    } else {
      for (let k = 0; k < PIN_TAG.maxLifts && hit(faceBox(at, c.w, c.h, lift)); k++) lift += c.h + PIN_TAG.gap;
    }
    taken.push(faceBox(at, c.w, c.h, lift), markBox(at));
    return { repo: c.repo, shown: true, lift, box: pinTagBox(at, c.w, c.h, lift) };
  });
}
