/**
 * How far the camera may fly, where it opens, how thick the haze is and how
 * deep the view reaches, all from the city's extent. Pure, so it is tested
 * in Node.
 *
 * The rules: the tallest crown is never cut by the top of the frame at the
 * home framing; from as far as the camera may go, the whole city fits with
 * sky above it from any height of view; a small city is framed close and
 * stands clear of the haze; the hero haze stays for a city the size of the
 * sample and thins only as the city outgrows it, so the far edge of a big
 * city still reads as silhouettes; and every number moves continuously with
 * the city, so one more floor never makes the view jump.
 */
import { layoutTower } from '../../../shared/tower-layout.js';
import type { TowerSpec } from '../../../shared/types.js';

export type V3 = [number, number, number];

/** The app's lens, vertical, in degrees. */
export const FOV = 36;
/** Headroom above a tower's top floor for its crown, mast or a root's spire. */
export const CROWN_ALLOWANCE = 12;
/** Half the width of what stands on a plot, root and plaza edge included, round its origin. */
const FOOTPRINT = 40;
/** Half the width of a crown, a little over a top floor's. */
const CROWN_HALF = 16;
/** The haze the city was designed in: thick enough to swallow the horizon into the sky. */
export const HERO_FOG = 0.00055;
/** How far the camera could always fly out over the ambient city; it only ever widens. */
const MIN_MAX_DISTANCE = 2600;
/** The far plane never comes in closer than this: the horizon is always haze, never a clipped edge. */
const MIN_FAR = 20000;
/** From the city's centre to the ground's farthest corner (a 16 km square). */
const GROUND_REACH = 8000 * Math.SQRT2;
/** Shortest home framing: close on one tower, with its plaza and a little of the street round it. */
const MIN_HOME = 170;
/** The home framing stands this much farther back than a tight fit, so the city has air round it. */
const HOME_AIR = 1.12;
/** The mockup's bearing: the afterglow off to the left, sunlit faces turned partly toward the eye. */
const BEARING: V3 = normalize([0.63, 0.15, 0.78]);
/** Highest a crown may stand in the frame (normalised, 1 is the top edge): the rest is sky. */
const HOME_TOP = 0.84;
const FAR_TOP = 0.9;
const BOTTOM = -0.97;
const SIDE = 0.94;
/** Haze on the far edge of the city, seen from home, that still reads as a silhouette. */
const FAR_EDGE_HAZE = 0.58;
/** Density times distance that leaves the horizon about 92% haze (exponential squared). */
const HORIZON_HAZE = 1.6;
/** Seconds-based rate the limits ease at: most of the way in a second, settled in two. */
const EASE_RATE = 3;

export interface CityExtent {
  /** The centre of the districts on the ground. */
  cx: number;
  cz: number;
  /** From the centre to the farthest district's origin. */
  radius: number;
  /** The tallest crown, ground to tip. */
  height: number;
  count: number;
  /**
   * Each district's crown, ground to tip. The home framing fits these where
   * they stand; without them it assumes the tallest crown anywhere on the rim.
   */
  peaks?: Array<{ x: number; z: number; height: number }>;
}

export interface ViewLimits {
  /** The framing the app opens on and returns to. */
  home: { eye: V3; target: V3 };
  homeDistance: number;
  /** How far the camera may orbit out from its target. */
  maxDistance: number;
  /** Exponential squared haze density. */
  fogDensity: number;
  far: number;
}

/** The parts of the limits that ease while the city grows under the user's eye. */
export interface EasedLimits {
  maxDistance: number;
  fogDensity: number;
  far: number;
}

function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Where the districts stand and how tall the tallest of them is. */
export function cityExtent(districts: ReadonlyArray<{ origin: { x: number; z: number }; tower: TowerSpec }>): CityExtent {
  if (districts.length === 0) return { cx: 0, cz: 0, radius: 0, height: 0, count: 0 };
  let cx = 0;
  let cz = 0;
  for (const d of districts) {
    cx += d.origin.x;
    cz += d.origin.z;
  }
  cx /= districts.length;
  cz /= districts.length;
  let radius = 0;
  const peaks = districts.map((d) => ({ x: d.origin.x, z: d.origin.z, height: layoutTower(d.tower).top + CROWN_ALLOWANCE }));
  for (const d of districts) radius = Math.max(radius, Math.hypot(d.origin.x - cx, d.origin.z - cz));
  const height = Math.max(...peaks.map((p) => p.height));
  return { cx, cz, radius, height, count: districts.length, peaks };
}

function ring(pts: V3[], cx: number, cz: number, r: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
  }
}

/** Points round the city's bounding cylinder: every base and every crown, seen from anywhere, lies inside it. */
function hull(e: CityExtent, height: number): V3[] {
  const pts: V3[] = [];
  ring(pts, e.cx, e.cz, e.radius + FOOTPRINT, 0, 24);
  ring(pts, e.cx, e.cz, e.radius + FOOTPRINT, height, 24);
  return pts;
}

/** The ground the districts stand on, and each crown where it stands (the tallest at the minimum height). */
function homeHull(e: CityExtent, height: number): V3[] {
  if (!e.peaks?.length) return hull(e, height);
  const pts: V3[] = [];
  ring(pts, e.cx, e.cz, e.radius + FOOTPRINT, 0, 24);
  const tallest = Math.max(...e.peaks.map((p) => p.height));
  for (const p of e.peaks) ring(pts, p.x, p.z, CROWN_HALF, p.height + (height - tallest), 8);
  return pts;
}

/** The camera's height of aim, between these shares of the tallest crown, that frames the city from nearest. */
function bestAim(pts: V3[], e: CityExtent, height: number, aspect: number): { target: V3; d: number } {
  const at = (k: number): number => fitDistance(pts, [e.cx, height * k, e.cz], BEARING, aspect, HOME_TOP);
  // Golden-section search: the fit distance falls and then rises as the aim climbs.
  let a = 0.12;
  let b = 0.62;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = at(c);
  let fd = at(d);
  for (let i = 0; i < 28; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = at(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = at(d);
    }
  }
  const k = (a + b) / 2;
  return { target: [e.cx, height * k, e.cz], d: at(k) };
}

/** True when every point lands inside the frame, crowns no higher than `top`, seen from target + dir * d. */
function fits(pts: V3[], target: V3, dir: V3, d: number, aspect: number, top: number): boolean {
  const eye: V3 = [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d];
  // Looking along -dir; right is forward x up, up is right x forward.
  const f: V3 = [-dir[0], -dir[1], -dir[2]];
  let r: V3 = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0];
  // Looking straight down there is no horizon to take right from: any horizontal right will do.
  r = Math.hypot(r[0], r[2]) < 1e-6 ? [1, 0, 0] : normalize(r);
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan(((FOV / 2) * Math.PI) / 180);
  for (const p of pts) {
    const v: V3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    if (z <= 1) return false;
    const y = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (z * t);
    const x = (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / (z * t * aspect);
    if (y > top || y < BOTTOM || Math.abs(x) > SIDE) return false;
  }
  return true;
}

/** The nearest distance along `dir` from `target` at which the whole hull fits. Continuous in the hull. */
function fitDistance(pts: V3[], target: V3, dir: V3, aspect: number, top: number): number {
  let lo = 1;
  let hi = 200_000;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (fits(pts, target, dir, mid, aspect, top)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Every limit of the view, for a city of this extent seen through a window of this shape. */
export function viewLimits(e: CityExtent, aspect: number): ViewLimits {
  const height = Math.max(e.height, 40);
  const pts = hull(e, height);
  // Home: aimed at the height that lets every crown, with sky above, and every plaza in from nearest.
  const aim = bestAim(homeHull(e, height), e, height, aspect);
  const target = aim.target;
  const homeDistance = Math.max(MIN_HOME, aim.d * HOME_AIR);
  const eye: V3 = [target[0] + BEARING[0] * homeDistance, target[1] + BEARING[1] * homeDistance, target[2] + BEARING[2] * homeDistance];

  // From any height of view the user can orbit to, the whole city must fit at the farthest distance.
  let farFit = 0;
  for (const deg of [8, 25, 45, 70, 89]) {
    const el = (deg * Math.PI) / 180;
    const dir: V3 = [Math.cos(el) * 0.63 / Math.hypot(0.63, 0.78), Math.sin(el), Math.cos(el) * 0.78 / Math.hypot(0.63, 0.78)];
    farFit = Math.max(farFit, fitDistance(pts, target, dir, aspect, FAR_TOP));
  }
  // Room past a tight fit, and past the city's radius for a target panned to its edge.
  const maxDistance = Math.max(MIN_MAX_DISTANCE, farFit * 1.25 + e.radius);

  // The far edge of the city at mid height, as seen from home, is kept to a silhouette's worth of haze.
  const away = Math.hypot(eye[0] - e.cx, eye[2] - e.cz);
  const rim = e.radius + FOOTPRINT;
  const farEdge: V3 = away > 1e-6 ? [e.cx - ((eye[0] - e.cx) / away) * rim, height * 0.5, e.cz - ((eye[2] - e.cz) / away) * rim] : [e.cx, 0, e.cz];
  const toFarEdge = Math.hypot(eye[0] - farEdge[0], eye[1] - farEdge[1], eye[2] - farEdge[2]);
  const fogDensity = Math.min(HERO_FOG, Math.sqrt(-Math.log(1 - FAR_EDGE_HAZE)) / toFarEdge);

  const far = Math.max(MIN_FAR, (maxDistance + e.radius + GROUND_REACH) * 1.1);
  return { home: { eye, target }, homeDistance, maxDistance, fogDensity, far };
}

/**
 * True when this placement should open the city on its home framing: the
 * first one that has districts. An empty first answer (the engine down, or
 * nothing connected yet) leaves the camera where it is, so a city that
 * arrives later still opens on its own framing; after that the city never
 * moves the camera.
 */
export function opensHome(framed: boolean, districts: number): boolean {
  return !framed && districts > 0;
}

/**
 * The haze density for an eye `cameraDistance` from the city's home target.
 * Up to the home distance it is the city's own; flown out past it, it thins
 * in step with the distance, so the city keeps the haze it has from home and
 * reads whole from as far as the camera may go. It never thins so far that
 * the ground's edge, 8 km past the eye's distance, shows through the horizon.
 */
export function fogFor(density: number, homeDistance: number, cameraDistance: number): number {
  if (cameraDistance <= homeDistance) return density;
  const horizon = Math.min(density, HORIZON_HAZE / (cameraDistance + 8000));
  return Math.max(density * (homeDistance / cameraDistance), horizon);
}

/**
 * One frame of easing from the limits in force toward the city's new ones.
 * The farthest distance never drops below where the camera stands now
 * (`cameraDistance`), so a shrinking city never pulls in a camera the user is
 * holding: the limit waits for them and follows them in.
 */
export function easeLimits(cur: EasedLimits, to: EasedLimits, dt: number, cameraDistance: number): EasedLimits {
  const k = 1 - Math.exp(-EASE_RATE * dt);
  const step = (a: number, b: number): number => (Math.abs(b - a) <= Math.abs(b) * 1e-5 ? b : a + (b - a) * k);
  const maxDistance = Math.max(step(cur.maxDistance, to.maxDistance), Math.min(cameraDistance, cur.maxDistance));
  return { maxDistance, fogDensity: step(cur.fogDensity, to.fogDensity), far: step(cur.far, to.far) };
}
