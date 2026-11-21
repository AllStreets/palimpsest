/**
 * The leader's router: from a Brief row's rail to the ring at its tower's head, in right-angled runs that cross
 * no pin, no tag, no telemetry and no other leader. A pure function of what it is given, so it is held to its word
 * in node (test/os-route.test.ts) and the pins (pins.ts) only call it when what it avoids has moved.
 *
 * The rules, from the prototype's rounds 3 to 9: leave the rail level for a stub, climb or drop to a clear
 * channel, run along it to the tower's line, and arrive on the ring, from above for preference. Where no single
 * channel is clear it tries more stub columns, then a detour that changes channel once past what blocks it. Where
 * nothing is clear it gives no route at all: a leader that crosses a pin is never drawn, and the lock alone shows.
 */

export type Point = [number, number];

/** A box on screen the leader must not cross, in pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** How far every run keeps from every box, in pixels. */
export const CLEAR = 7;

/** The stub columns out of the rail, right of it: the first, and the one tried when the first is blocked. */
const STUBS = [44, 76];
/** What a turn costs, in pixels of run. */
const TURN = 36;
/** What the way onto the ring costs: from above reads as a lock coming down; level cuts the skyline; from below climbs the tower's face. */
const ARRIVE = { above: 0, level: 260, below: 520 };
/** A channel this near the ring (past its radius) that is not exactly level would arrive at its side, too close to read. */
const NEAR = 14;
/** The channel grid's pitch, in pixels. */
const PITCH = 4;

/** Whether the run from a to b comes nearer a box than CLEAR (meeting CLEAR exactly is clear). */
function blocked(a: Point, b: Point, avoid: Box[]): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  for (const o of avoid) {
    if (x1 > o.x0 - CLEAR && x0 < o.x1 + CLEAR && y1 > o.y0 - CLEAR && y0 < o.y1 + CLEAR) return true;
  }
  return false;
}

/** The route without its zero-length runs, and with straight-through points merged, so a turn is a turn. */
function tidy(raw: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of raw) {
    const last = out.at(-1);
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out.at(-2);
    if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

const runLength = (pts: Point[]): number => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
  return n;
};

const clearAll = (pts: Point[], avoid: Box[]): boolean => {
  for (let i = 1; i < pts.length; i++) if (blocked(pts[i - 1], pts[i], avoid)) return false;
  return true;
};

/** Limits on a search, for a caller that routes inside a frame (pins.ts). */
export interface RouteLimits {
  /** How many routes it may weigh before it gives up and returns null, so a layout with no way through cannot hitch. */
  maxConsiders?: number;
  /** The most points a route may have; a longer one is no route. */
  maxPoints?: number;
}

/**
 * The leader's route from the rail at `from` to the ring round `to`, keeping CLEAR from every box in `avoid`, with
 * channels tried between `top` and `bottom`. Null where no route is clear, where the search passes its budget, and
 * where the tower stands left of the first stub, so the leader would double back on itself.
 */
export function routeLeader(
  from: { x: number; y: number },
  to: { x: number; y: number; r: number },
  avoid: Box[],
  top: number,
  bottom: number,
  limits: RouteLimits = {},
): Point[] | null {
  if (to.x < from.x + STUBS[0]) return null;
  const start: Point = [from.x, from.y];
  const maxPoints = limits.maxPoints ?? Infinity;
  let budget = limits.maxConsiders ?? Infinity;

  // How a channel arrives on the ring: its last point and its penalty, or null for a channel refused near it.
  const arrival = (c: number): { tail: Point[]; way: number } | null => {
    if (Math.abs(c - to.y) < 0.5) return { tail: [[to.x - to.r, c]], way: ARRIVE.level };
    if (Math.abs(c - to.y) < to.r + NEAR) return null;
    const above = c < to.y;
    return { tail: [[to.x, c], [to.x, above ? to.y - to.r : to.y + to.r]], way: above ? ARRIVE.above : ARRIVE.below };
  };

  const channels = new Set<number>();
  for (let c = Math.ceil(top / PITCH) * PITCH; c <= bottom; c += PITCH) channels.add(c);
  channels.add(from.y);
  channels.add(to.y);
  // The edges of what is in the way, held CLEAR off: the only channels through a gap narrower than the grid sees.
  const edges = new Set<number>();
  for (const b of avoid) {
    for (const c of [b.y0 - CLEAR, b.y1 + CLEAR]) if (c >= top && c <= bottom) edges.add(c);
  }
  for (const c of edges) channels.add(c);
  const grid = [...channels].sort((a, b) => a - b);

  let best: Point[] | null = null;
  let bestCost = Infinity;
  const consider = (raw: Point[], stub: number, way: number): void => {
    budget--;
    const pts = tidy(raw);
    if (pts.length > maxPoints) return;
    const cost = runLength(pts) + TURN * Math.max(0, pts.length - 2) + stub + way;
    // Ties keep the first found, so the same input always gives the same route.
    if (cost >= bestCost) return;
    if (!clearAll(pts, avoid)) return;
    best = pts;
    bestCost = cost;
  };

  /** One channel: out of the rail to the stub, up or down to the channel, along it, onto the ring. */
  const single = (xa: number): void => {
    for (const c of grid) {
      const arrive = arrival(c);
      if (!arrive) continue;
      const level = Math.abs(c - from.y) < 0.5;
      const head: Point[] = level ? [start] : [start, [xa, from.y], [xa, c]];
      consider([...head, ...arrive.tail], level ? 0 : xa - from.x, arrive.way);
    }
  };

  for (const dx of STUBS) {
    single(from.x + dx);
    if (budget < 0) return null;
    if (best) return best;
  }

  // More stub columns: just past each box's edges, between the rail's stubs and the tower's line.
  const columns = new Set<number>();
  for (const b of avoid) {
    for (const x of [b.x0 - CLEAR, b.x1 + CLEAR]) if (x > from.x + STUBS[0] && x < to.x) columns.add(x);
  }
  const extra = [...columns].sort((a, b) => a - b);
  for (const xa of extra) {
    single(xa);
    if (budget < 0) return null;
  }
  if (best) return best;

  // A detour: along one channel past what blocks it, then over to a second channel that reaches the ring.
  const ringNear = [to.y - to.r - NEAR, to.y + to.r + NEAR].filter((c) => c >= top && c <= bottom);
  const turnChannels = [...new Set([top, bottom, from.y, to.y, ...edges, ...ringNear])].sort((a, b) => a - b);
  const stubs = [...STUBS.map((dx) => from.x + dx), ...extra];
  for (const xa of stubs) {
    if (blocked(start, [xa, from.y], avoid)) continue;
    for (const c1 of turnChannels) {
      if (blocked([xa, from.y], [xa, c1], avoid)) continue;
      for (const x2 of extra) {
        if (x2 <= xa) continue;
        // What this detour costs before its second channel: past the best already found, it cannot win.
        const sofar = 2 * (xa - from.x) + Math.abs(c1 - from.y) + (to.x - to.r - xa) + 2 * TURN;
        if (sofar >= bestCost || blocked([xa, c1], [x2, c1], avoid)) continue;
        for (const c2 of turnChannels) {
          // Each second channel weighed counts against the budget, whether or not it is pruned.
          if (--budget < 0) return null;
          if (c2 === c1) continue;
          const arrive = arrival(c2);
          if (!arrive || sofar + Math.abs(c2 - c1) + arrive.way >= bestCost) continue;
          consider([start, [xa, from.y], [xa, c1], [x2, c1], [x2, c2], ...arrive.tail], xa - from.x, arrive.way);
        }
      }
    }
  }
  return best;
}

/** One thin box round each run of a route, so a second leader routed after it keeps clear of the first. */
export function leaderBoxes(pts: Point[], width = 2): Box[] {
  const out: Box[] = [];
  const half = width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    if (ax === bx && ay !== by) out.push({ x0: ax - half, y0, x1: ax + half, y1 });
    else out.push({ x0, y0: ay - half, x1, y1: ay + half });
  }
  return out;
}

/** An SVG path through the route's points, each corner cut at 45 degrees by `cut` pixels, as an instrument's leader is drawn. */
export function routePath(pts: Point[], cut = 6): string {
  if (pts.length === 0) return '';
  const f = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`;
  const parts = [`M${f(pts[0][0], pts[0][1])}`];
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === pts.length - 1) {
      parts.push(`L${f(x, y)}`);
      continue;
    }
    const [px, py] = pts[i - 1];
    const [nx, ny] = pts[i + 1];
    // Never cut more than half of either run, so two corners on one short run do not cross.
    const r = Math.min(cut, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    parts.push(`L${f(x - Math.sign(x - px) * r, y - Math.sign(y - py) * r)}`, `L${f(x + Math.sign(nx - x) * r, y + Math.sign(ny - y) * r)}`);
  }
  return parts.join(' ');
}
