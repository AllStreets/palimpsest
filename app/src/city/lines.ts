/**
 * Where the transit lines' tracks lie (Task 30's numbers, shared by
 * transit.ts, which lays the rails, and vehicles.ts, which runs the cars on
 * them): the track centres either side of each line, the curve radii at the
 * loops' corners, the tram's contact wire, and the polyline helpers both
 * use. Pure, so it is tested in Node.
 */

type V2 = { x: number; z: number };

/** Track centres either side of the line, and the curve radius at the loop's corners. */
export const TRAM_TRACK = 2.0;
export const TRAM_R = 13;
export const RAIL_TRACK = 2.1;
export const RAIL_R = 16;
export const POD_BEAM = 1.7;

/**
 * The elevated rail's cars (vehicles.ts runs them): their bogie centres'
 * spacing, and the body's half length nose to tail and half width.
 */
export const RAIL_CAR = { bogie: 10.6, half: 7.64, width: 1.42 } as const;
/** The viaduct's trough, from its centre line to the outer faces of its webs (transit.ts TROUGH): the deck a train's body keeps over. */
export const VIADUCT_HALF = 4.7;

/**
 * How far a rail car's body reaches from the line's centre on a curve of
 * radius r (the centre line's), on the inner track (its middle, which the
 * chord between its bogies pulls inward) and on the outer (its nose and
 * tail corners, which overhang outward past the bogies).
 */
export function railSwing(r: number, track = RAIL_TRACK, car: { bogie: number; half: number; width: number } = RAIL_CAR): { inner: number; outer: number } {
  const b = car.bogie / 2;
  const ri = r - track;
  const ro = r + track;
  const inner = r - (Math.sqrt(Math.max(0, ri * ri - b * b)) - car.width);
  const mid = Math.sqrt(Math.max(0, ro * ro - b * b));
  const outer = Math.hypot(mid + car.width, car.half) - r;
  return { inner, outer };
}

/**
 * The smallest curve the rail cars take inside the viaduct's deck with
 * their bogie spacing: below it a car's middle (inner track) or its corners
 * (outer track) hang outside the webs. Five centimetres kept in hand.
 */
export const VIADUCT_MIN_RADIUS = ((): number => {
  const fits = (r: number): boolean => {
    const s = railSwing(r);
    return Math.max(s.inner, s.outer) <= VIADUCT_HALF - 0.05;
  };
  let lo = RAIL_TRACK + RAIL_CAR.bogie / 2 + 0.01;
  let hi = 200;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
})();

/** The tram's contact wire over the rails. */
export const CONTACT_Y = 5.8;

function norm(v: V2): V2 | null {
  const l = Math.hypot(v.x, v.z);
  return l < 1e-9 ? null : { x: v.x / l, z: v.z / l };
}

/** Each vertex's left normal, mitred at corners (scaled so offsets keep their width). */
export function miters(pts: V2[], closed: boolean): V2[] {
  const n = pts.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const next = pts[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    const here = pts[i];
    const d0 = norm({ x: here.x - prev.x, z: here.z - prev.z });
    const d1 = norm({ x: next.x - here.x, z: next.z - here.z });
    const t0 = d0 ?? d1!;
    const t1 = d1 ?? d0!;
    const n0 = { x: -t0.z, z: t0.x };
    const n1 = { x: -t1.z, z: t1.x };
    let m = norm({ x: n0.x + n1.x, z: n0.z + n1.z }) ?? n0;
    const k = m.x * n0.x + m.z * n0.z;
    m = { x: m.x / Math.max(k, 0.3), z: m.z / Math.max(k, 0.3) };
    out.push(m);
  }
  return out;
}
/** A closed loop of axis-aligned corners with each corner rounded to radius r: a dense closed polyline. */
export function filleted(corners: V2[], r: number, seg = 10): V2[] {
  const out: V2[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const p = corners[(i - 1 + n) % n];
    const c = corners[i];
    const q = corners[(i + 1) % n];
    const d0 = norm({ x: c.x - p.x, z: c.z - p.z })!;
    const d1 = norm({ x: q.x - c.x, z: q.z - c.z })!;
    const a = { x: c.x - d0.x * r, z: c.z - d0.z * r };
    const b = { x: c.x + d1.x * r, z: c.z + d1.z * r };
    // A quadratic through the corner is close enough to an arc for a track at this radius, and keeps the tangents.
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const u = 1 - t;
      // Blend toward a true quarter circle: the control point pulled in so the midpoint sits on the arc.
      const w = Math.SQRT2;
      const den = u * u + 2 * u * t * (w / 2) + t * t;
      out.push({ x: (u * u * a.x + 2 * u * t * (w / 2) * c.x + t * t * b.x) / den, z: (u * u * a.z + 2 * u * t * (w / 2) * c.z + t * t * b.z) / den });
    }
  }
  return out;
}

/** A closed polyline offset sideways by d (left of travel positive). */
export function offsetLoop(pts: V2[], d: number): V2[] {
  const m = miters(pts, true);
  return pts.map((p, i) => ({ x: p.x + m[i].x * d, z: p.z + m[i].z * d }));
}
