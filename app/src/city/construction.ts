/**
 * Live construction on a job site (spec 6.3, Task 26): what stands on the
 * roof of a repo's tower while an agent really works on it.
 *
 * - `crane`: a hammerhead tower crane bolted to the roof on a cross base
 *   (lattice mast, slewing ring, cab, cat head with its pendants, a
 *   triangular jib with its trolley and hook block, a counter-jib with its
 *   winch and concrete ballast, red aviation lamps on the jib tip and the cat
 *   head) and the first two to four columns of the new floor.
 * - `framing`: the steel frame of the new floor rises with the run's real
 *   progress: columns, then beams in erection order from the crane's corner,
 *   then the metal deck, with debris netting hung on the outer face behind
 *   each perimeter beam. The crane's trolley runs out over the next beam and
 *   the hook rises a notch with each progress step; at the working edge a
 *   welder's arc strikes and breaks, throwing sparks that fall, bounce on the
 *   roof or drop past the facade, and lighting the steel round it with a
 *   flickering blue-white point light.
 * - `inspecting` (Task 27): the frame complete and the crane parked, while
 *   two inspection guild searchlights on tripods at the plaza's edge sweep
 *   the new floor through the haze, slowly, crossing, for as long as the
 *   inspection really runs (until its verdict changes the stage).
 * - `curing`: the verdict passed. Over four seconds the netting is let down
 *   the face and the frame cross-fades from primer into the finished floor's
 *   tone and away, leaving the floor the city lays there in its era's
 *   material; the crane parks and its lamp goes steady. A merge (`curing` at
 *   progress 1) then lights the floor's windows row by row and the crane
 *   climbs down its own mast; a PR left open (`waiting`) keeps the floor
 *   dark and the crane parked.
 * - `teardown`: the netting drops, the skeleton is struck piece by piece in
 *   reverse erection order and the crane dismantles, over six seconds; no
 *   floor. `scar` is the same teardown ending on the primer floor of a
 *   failed inspection, with one work lamp left burning on its bare corner
 *   for the rest of the evening.
 *
 * Nothing advances on a timer. Every position the frame, the crane, the
 * trolley and the hook take is a pure function of the site's stage and
 * progress (constructionState); update(dt) only eases the crane toward that
 * pose after an event and then holds it exactly. Between events only the
 * sparks, the arc and the lamps move, and none of them casts a shadow, so the
 * city's cached shadow map is redrawn only while the crane is actually moving
 * (update returns true then).
 *
 * The sparks are GPU particles: one instanced quad per spark, every position
 * computed in the vertex shader from its seed and the clock, drawn as a
 * velocity-aligned streak (the motion blur of a film shutter) with a floor of
 * about a pixel of width so a burst still glints from across the city. The
 * arc's on and off pattern is one integer hash shared by the shader (sparks
 * are only born while the arc burns) and the point light, so the light and
 * the sparks always agree.
 *
 * Own work, modelled in code (no kit, no Blender). Proportions after the
 * published data sheets of saddle-jib tower cranes of the 150 to 200 tm
 * class: a 1.6 m square mast in 2.5 m sections, a 1.2 m triangular jib in
 * 2.4 m panels, a cat head about 7 m tall, a counter-jib about a third of the
 * jib with its ballast at the tail.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Era, SiteStage, SiteState } from '../../../shared/types.js';
import { EXPOSURE, FLICKER, FLOOD } from './post.js';
import { MAX_SEARCH, SEARCH, SEARCH_LIGHT, SEARCH_PARS, SEARCH_UNIFORMS } from './searchlight.js';

// ---------------------------------------------------------------- the pure state

/** Bays per side of the new floor's frame. */
const BAYS = 4;
/** Where erection starts: the floor's corner on the crane's side, as a fraction of the half-width. */
const START = { x: -1, z: 1 };
/** Mast section size and the clear height of the mast above the roof, beyond the new floor. */
const MAST_W = 1.6;
const MAST_CLEAR = 15;
/** Column and beam depths (a 360 mm column, a 460 mm beam). */
const COL_D = 0.36;
const BEAM_D = 0.46;
/** Panels of debris netting rise this far above the new floor's top as edge protection. */
const NET_OVER = 1.2;

export interface FrameLayout {
  bay: number;
  /** Column feet in plan, in erection order. */
  columns: Array<[number, number]>;
  /** Beams in erection order: centre, length and direction ('x' or 'z'), and whether it lies on the perimeter. */
  beams: Array<{ x: number; z: number; len: number; dir: 'x' | 'z'; edge: boolean; ends: [[number, number], [number, number]] }>;
  /** Deck bays in erection order (bay centres), the crane's bay left open. */
  decks: Array<[number, number]>;
  /** Perimeter net panels in erection order: centre, facing (outward normal angle) and length. */
  nets: Array<{ x: number; z: number; ry: number; len: number }>;
  mast: { x: number; z: number };
}

const fromStart = (half: number, x: number, z: number): number => Math.hypot(x - START.x * half, z - START.z * half);

/** The new floor's frame in plan: a four-bay grid of columns and beams over the roof, ordered as it would be erected. */
export function frameLayout(half: number): FrameLayout {
  const bay = (2 * half) / BAYS;
  const line = (i: number): number => -half + i * bay;
  const inset = (v: number): number => (Math.abs(v) >= half - 1e-6 ? Math.sign(v) * (half - COL_D / 2) : v);
  const mast = { x: -bay / 2, z: bay / 2 };
  const columns: Array<[number, number]> = [];
  for (let i = 0; i <= BAYS; i++) {
    for (let j = 0; j <= BAYS; j++) {
      const perimeter = i === 0 || j === 0 || i === BAYS || j === BAYS;
      // Perimeter columns, and interior ones on alternate lines (the mast's bay stays clear).
      if (perimeter || (i % 2 === 0 && j % 2 === 0)) columns.push([inset(line(i)), inset(line(j))]);
    }
  }
  columns.sort((a, b) => fromStart(half, a[0], a[1]) - fromStart(half, b[0], b[1]) || a[0] - b[0] || a[1] - b[1]);

  const beams: FrameLayout['beams'] = [];
  for (let i = 0; i <= BAYS; i++) {
    for (let k = 0; k < BAYS; k++) {
      const z = inset(line(i));
      const x0 = inset(line(k));
      const x1 = inset(line(k + 1));
      beams.push({ x: (x0 + x1) / 2, z, len: x1 - x0, dir: 'x', edge: i === 0 || i === BAYS, ends: [[x0, z], [x1, z]] });
      const x = inset(line(i));
      const z0 = inset(line(k));
      const z1 = inset(line(k + 1));
      beams.push({ x, z: (z0 + z1) / 2, len: z1 - z0, dir: 'z', edge: i === 0 || i === BAYS, ends: [[x, z0], [x, z1]] });
    }
  }
  beams.sort((a, b) => fromStart(half, a.x, a.z) - fromStart(half, b.x, b.z) || a.x - b.x || a.z - b.z);

  const decks: Array<[number, number]> = [];
  for (let i = 0; i < BAYS; i++) {
    for (let j = 0; j < BAYS; j++) {
      const c: [number, number] = [line(i) + bay / 2, line(j) + bay / 2];
      if (Math.abs(c[0] - mast.x) < 1e-6 && Math.abs(c[1] - mast.z) < 1e-6) continue;
      decks.push(c);
    }
  }
  decks.sort((a, b) => fromStart(half, a[0], a[1]) - fromStart(half, b[0], b[1]) || a[0] - b[0] || a[1] - b[1]);

  const off = half + 0.55;
  const nets = beams
    .filter((b) => b.edge)
    .map((b) => {
      if (b.dir === 'x') return { x: b.x, z: Math.sign(b.z) * off, ry: b.z > 0 ? 0 : Math.PI, len: b.len + COL_D };
      return { x: Math.sign(b.x) * off, z: b.z, ry: b.x > 0 ? Math.PI / 2 : -Math.PI / 2, len: b.len + COL_D };
    });
  return { bay, columns, beams, decks, nets, mast };
}

export interface ConstructionState {
  stage: SiteStage;
  /** The crane's mast in plan, its height above the roof and its jib and counter-jib lengths. */
  crane: { x: number; z: number; height: number; jib: number; counter: number } | null;
  columns: { shown: number; total: number };
  beams: { shown: number; total: number };
  decks: { shown: number; total: number };
  /** Net panels hung (perimeter beams in), 0 when no netting hangs. */
  nets: number;
  /** The crane's pose: slew angle (the jib's +x turned about y), trolley radius, hook height in the slewing frame. */
  slew: number;
  trolley: number;
  hook: number;
  /** Whether a beam hangs from the hook. */
  load: boolean;
  /** Where the arc strikes, in the site's space (the tower's, roof at `top`), or null when nobody welds. */
  weldAt: [number, number, number] | null;
  lamp: 'blink' | 'steady';
  /** Whether the deck's work floodlights burn: from the crane's raising to the end of inspection, switched by stage. */
  floods: boolean;
  /** How opaque the frame stands: 1 standing, 0 cured away into the finished floor (the cure's cross-fade). */
  frameFade: number;
  /** How far the frame's paint has turned from primer to the finished floor's tone. */
  frameTint: number;
  /** How far the netting has been let down the face: 0 hung, 1 down and gone. */
  netDrop: number;
  /** How far the skeleton has been struck, piece by piece in reverse erection order: 0 standing, 1 gone. */
  strike: number;
  /** How far the crane has been dismantled (it climbs down its own mast): 0 standing, 1 gone. */
  dismantle: number;
  /** Whether the two guild searchlights sweep the floor (the inspection). */
  searchlights: boolean;
  /** The new floor's windows lighting row by row, 0 dark to 1 all lit; null while they are not this site's to light. */
  windows: number | null;
  /** Whether a work lamp is left burning on the floor (a scar). */
  workLamp: boolean;
  /** What the floor finishes as: its era's material (cured), primer (a scar), or nothing (still building, or struck). */
  floor: 'era' | 'primer' | null;
}

/** Seconds the cure takes: the netting let down, the frame cross-faded into the finished floor. */
export const CURE_S = 4;
/** Seconds a teardown takes: netting, skeleton, then the crane. */
export const STRIKE_S = 6;
/** Seconds the windows of a merged floor take to light, row by row. */
export const WINDOWS_S = 3.2;
/** Seconds the crane takes to climb down off a merged floor, once its windows are lit. */
export const DISMANTLE_S = 6;
/** The pause between the last row lighting and the crane starting down. */
const DISMANTLE_PAUSE = 0.6;

/**
 * Seconds since each transition began: the cure (the verdict passed), the
 * lighting (the merge) and the strike (teardown or scar). A transition is a
 * fixed animation started by its event, never a clock of its own: left out,
 * it is long over (the settled state).
 */
export interface StageClocks {
  cure?: number;
  lit?: number;
  strike?: number;
}

/** What stood when a teardown began: the frame's counts, how far it had cured, and whether the crane stood. */
export interface Before {
  columns: number;
  beams: number;
  decks: number;
  nets: number;
  frameFade: number;
  netDrop: number;
  crane: boolean;
}

const ease = (x: number): number => x * x * (3 - 2 * x);
const smooth = (x: number, a: number, b: number): number => THREE.MathUtils.smoothstep(x, a, b);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** The jib's angle so that it points from the mast at a plan point. */
const aim = (from: { x: number; z: number }, x: number, z: number): number => Math.atan2(-(z - from.z), x - from.x);

/** The crane a site of this size raises: where its mast stands, how tall it is, its jib and counter-jib. */
function craneFor(half: number, floorHeight: number): { x: number; z: number; height: number; jib: number; counter: number } {
  const lay = frameLayout(half);
  const jib = Math.max(26, Math.round(half * 3 + 6));
  return { x: lay.mast.x, z: lay.mast.z, height: floorHeight + MAST_CLEAR, jib, counter: Math.round(jib * 0.32) };
}

/**
 * What the site shows for a stage and progress: a pure function, so the same
 * event always draws the same frame and nothing moves between events.
 * `top` is the tower's roof, `half` its top floor's half-width and
 * `floorHeight` the new floor's height.
 */
export function constructionState(site: SiteState, top: number, half: number, floorHeight: number, clocks: StageClocks = {}, before?: Before): ConstructionState {
  const lay = frameLayout(half);
  const p = clamp01(site.progress);
  const crane = craneFor(half, floorHeight);
  const jib = crane.jib;
  const cTotal = lay.columns.length;
  const bTotal = lay.beams.length;
  const dTotal = lay.decks.length;
  const base: ConstructionState = {
    stage: site.stage,
    crane,
    columns: { shown: 0, total: cTotal },
    beams: { shown: 0, total: bTotal },
    decks: { shown: 0, total: dTotal },
    nets: 0,
    slew: 0,
    trolley: 6,
    hook: -2.5,
    load: false,
    weldAt: null,
    lamp: 'blink',
    floods: true,
    frameFade: 1,
    frameTint: 0,
    netDrop: 0,
    strike: 0,
    dismantle: 0,
    searchlights: false,
    windows: null,
    workLamp: false,
    floor: null,
  };
  // Parked: the jib turned to the tower's diagonal, trolley in, hook up under the jib.
  const parked = { slew: aim(lay.mast, half, -half), trolley: 6, hook: -2.6 };
  const edgesShown = (n: number): number => lay.beams.slice(0, n).filter((b) => b.edge).length;
  const whole = { columns: { shown: cTotal, total: cTotal }, beams: { shown: bTotal, total: bTotal }, decks: { shown: dTotal, total: dTotal } };

  switch (site.stage) {
    case 'crane': {
      // The crane has just been raised: two to four columns stand, and the hook is still down over the street, lifting.
      const cols = Math.min(4, 2 + Math.round(clamp01(p / 0.1) * 2));
      const out = aim(lay.mast, -half * 3, half * 3);
      return { ...base, columns: { shown: cols, total: cTotal }, slew: out, trolley: jib * 0.82, hook: -(crane.height + 10) + p * 60, load: true };
    }
    case 'framing': {
      const cols = Math.min(cTotal, 4 + Math.ceil((cTotal - 4) * clamp01(p / 0.45)));
      const beams = Math.round(bTotal * p);
      const decks = Math.floor(dTotal * clamp01((p - 0.25) / 0.75));
      // The next beam to go in (or the last, when the frame is done) is where the trolley runs and the hook carries steel.
      const next = lay.beams[Math.min(beams, bTotal - 1)];
      const r = Math.min(jib - 1.5, Math.max(4.5, Math.hypot(next.x - lay.mast.x, next.z - lay.mast.z)));
      // The hook rises with each step: from just over the roof to clear of the new floor's top.
      const hookWorld = top + floorHeight + 3.6 + 2.4 * p;
      // The arc strikes at the working edge: the far end of the last beam set, at its top flange.
      const last = beams > 0 ? lay.beams[beams - 1] : null;
      const col = lay.columns[Math.max(0, cols - 1)];
      const end = last ? last.ends[fromStart(half, ...last.ends[0]) > fromStart(half, ...last.ends[1]) ? 0 : 1] : col;
      const weldAt: [number, number, number] = [end[0], top + floorHeight - (last ? 0.12 : 0.05), end[1]];
      return {
        ...base,
        columns: { shown: cols, total: cTotal },
        beams: { shown: beams, total: bTotal },
        decks: { shown: decks, total: dTotal },
        nets: edgesShown(beams),
        slew: aim(lay.mast, next.x, next.z),
        trolley: r,
        hook: hookWorld - top - crane.height,
        load: beams < bTotal,
        weldAt,
      };
    }
    case 'inspecting':
      return { ...base, ...whole, nets: edgesShown(bTotal), ...parked, searchlights: true };
    case 'curing':
    case 'waiting': {
      // The cure: the netting let down first, the paint turning to the floor's finish, the frame fading into it.
      const cure = clamp01((clocks.cure ?? Infinity) / CURE_S);
      const cured = {
        ...base,
        ...whole,
        nets: edgesShown(bTotal),
        ...parked,
        lamp: 'steady' as const,
        floods: false,
        frameTint: smooth(cure, 0, 0.5),
        frameFade: 1 - smooth(cure, 0.5, 1),
        netDrop: smooth(cure, 0, 0.4),
        floor: 'era' as const,
      };
      if (site.stage === 'waiting' || p < 1) return cured;
      // Merged: once the cure is done the windows light row by row, then the crane climbs down its mast.
      const since = Math.min(clocks.lit ?? Infinity, (clocks.cure ?? Infinity) - CURE_S);
      const windows = clamp01(since / WINDOWS_S);
      const dismantle = clamp01((since - WINDOWS_S - DISMANTLE_PAUSE) / DISMANTLE_S);
      return { ...cured, windows, dismantle, crane: dismantle >= 1 ? null : crane, lamp: dismantle > 0 ? 'steady' : cured.lamp };
    }
    case 'teardown':
    case 'scar': {
      // The crew strikes the site: the netting is let down, the skeleton lowered piece by piece, then the crane taken down.
      const t = clocks.strike ?? Infinity;
      const b = before ?? { columns: 0, beams: 0, decks: 0, nets: 0, frameFade: 0, netDrop: 1, crane: false };
      const dismantle = b.crane ? clamp01((t - 2.4) / 3.6) : 1;
      return {
        ...base,
        columns: { shown: b.columns, total: cTotal },
        beams: { shown: b.beams, total: bTotal },
        decks: { shown: b.decks, total: dTotal },
        nets: b.nets,
        ...parked,
        lamp: 'steady',
        floods: false,
        frameFade: b.frameFade,
        netDrop: Math.max(b.netDrop, smooth(t, 0, 1.4)),
        strike: clamp01((t - 0.6) / 3),
        dismantle,
        crane: dismantle >= 1 ? null : crane,
        workLamp: site.stage === 'scar' && t >= STRIKE_S,
        floor: site.stage === 'scar' ? 'primer' : null,
      };
    }
    default:
      return { ...base, crane: null };
  }
}

// ---------------------------------------------------------------- the inspection's searchlights

/** The district plaza's paving ends at grid.ts PLAZA_RADIUS (72 m); the guild sets its tripods up just inside the lantern ring. */
const SEARCH_RING = 61;
/** The plaza edge faces the city's home view (view.ts BEARING), so the beams rise in front of the tower as the city is seen. */
const SEARCH_BEARING = Math.atan2(0.78, 0.63);
/** The two tripods stand this far either side of that bearing, so their beams cross over the floor. */
const SEARCH_SPREAD = 0.42;
/** The lens centre above the paving, on its tripod. */
const SEARCH_LENS_Y = 1.72;
/** The lens's radius, and one full sweep across the floor and back, in seconds. */
const SEARCH_LENS_R = 0.3;
const SEARCH_PERIOD = 44;

export { SEARCH } from './searchlight.js';

/** How bright steel of `albedo` looks `d` metres from a searchlight in its beam, after exposure (the shader's term in JS). */
export function searchRadiance(d: number, albedo: number): number {
  return (SEARCH.peak / Math.max(d, SEARCH.near) ** 2) * (albedo / Math.PI) * EXPOSURE;
}

/**
 * The guild sizes its lamps to the throw, as a crew picks a lamp for the
 * distance: each lamp is SEARCH.peak times this (a 7 kW class lamp), so
 * a face the beam rakes at a grazing angle still shows the streak, on a tall
 * tower as on a short one. The light still falls off with the square of the
 * distance from each lamp, and the term caps irradiance under the bloom
 * threshold, surface by surface (searchlight.ts SEARCH_CAP).
 */
export function searchThrow(length: number): number {
  return THREE.MathUtils.clamp(16 * (length / SEARCH.near) ** 2, 16, 640);
}

export interface Searchlight {
  /** The lens, in the site's space. */
  at: THREE.Vector3;
  /** Where the beam points (unit). */
  dir: THREE.Vector3;
  /** How far the beam runs before it meets the floor. */
  length: number;
  /** The beam's radius at the lens and where it meets the floor. */
  r0: number;
  r1: number;
}

/** Where a ray first enters a box, or null; t from 0. */
function enterBox(o: THREE.Vector3, d: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3): number | null {
  let t0 = 0;
  let t1 = Infinity;
  for (const k of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < min[k] || o[k] > max[k]) return null;
      continue;
    }
    const a = (min[k] - o[k]) / d[k];
    const b = (max[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? t0 : null;
}

/**
 * The two searchlights at `clock` seconds: each stands on its tripod at the
 * plaza edge and points at a spot that walks slowly along the two faces of
 * the new floor that look toward the city, the two in opposite phase so the
 * beams cross over the corner; each spot also rises and falls a little up
 * the face. The beam ends where it meets the floor. Pure: the same clock
 * always aims them the same way.
 */
export function searchAims(clock: number, top: number, half: number, floorHeight: number): Searchlight[] {
  const out: Searchlight[] = [];
  const env = half + 0.6;
  const min = new THREE.Vector3(-env, top - 0.3, -env);
  const max = new THREE.Vector3(env, top + floorHeight + NET_OVER, env);
  // The faces toward the city: the +z face (x from -0.8 half to the corner) then the +x face (z from the corner to -0.8 half).
  const run = 1.8 * half;
  const along = (u: number): [number, number] => {
    const s = u * run;
    return s <= 0 ? [half + s, env] : [env, half - s];
  };
  for (let i = 0; i < 2; i++) {
    const a = SEARCH_BEARING + (i === 0 ? -SEARCH_SPREAD : SEARCH_SPREAD);
    const at = new THREE.Vector3(Math.cos(a) * SEARCH_RING, SEARCH_LENS_Y, Math.sin(a) * SEARCH_RING);
    const w = (2 * Math.PI) / SEARCH_PERIOD;
    const u = (i === 0 ? 1 : -1) * 0.8 * Math.sin(w * clock + 0.4);
    const [x, z] = along(u);
    const y = top + floorHeight * (0.55 + 0.22 * Math.sin((2 * Math.PI * clock) / (13 + 4 * i) + i * 1.9));
    const dir = new THREE.Vector3(x, y, z).sub(at).normalize();
    const length = enterBox(at, dir, min, max) ?? at.distanceTo(new THREE.Vector3(x, y, z));
    // Focused wide enough that the spot covers the floor and, raking up the face from the plaza, the floors under it.
    out.push({ at, dir, length, r0: SEARCH_LENS_R, r1: Math.min(7, floorHeight * 1.5) });
  }
  return out;
}

// ---------------------------------------------------------------- the cure's tones and the scar's lamp

/**
 * The tone of each era's finished wall at dusk, which the frame's paint
 * turns to as it cures into the floor (the tower's own variant takes over as
 * the frame fades): limestone, brick, glazing, titanium, sci-fi panel.
 */
export const ERA_TONE: Record<Era, THREE.Color> = {
  stone: new THREE.Color(0xb3a58c),
  brick: new THREE.Color(0x8e5641),
  glass: new THREE.Color(0x4f5f6a),
  titanium: new THREE.Color(0x8d939a),
  scifi: new THREE.Color(0xc5ccd2),
};
/** Before the floor's era is known, the frame cures toward a plain concrete grey. */
const CURE_GREY = new THREE.Color(0x8a8784);

/**
 * The work lamp left on a scar: a caged 3000 K lamp clamped to the bare
 * corner post. Its light (one of the city's pool, post.ts FLICKER) is set so
 * primer a metre off comes to 0.85 after exposure, under the bloom threshold,
 * and falls off with the square of the distance.
 */
export const WORK_LAMP = (() => {
  const albedo = 0.3;
  const near = 1;
  const peak = Math.round(((0.85 * Math.PI * near * near) / (albedo * EXPOSURE)) * 10) / 10;
  return { peak, near, color: 0xffc48a } as const;
})();

/** How bright a surface of `albedo` looks `d` metres from the scar's work lamp, after exposure. */
export function workLampRadiance(d: number, albedo: number): number {
  return (WORK_LAMP.peak / Math.max(d, WORK_LAMP.near) ** 2) * (albedo / Math.PI) * EXPOSURE;
}

// ---------------------------------------------------------------- the arc's pattern, shared with the shader

/** A 32-bit integer hash to [0, 1] (PCG output permutation); GLSL's copy below gives the same bits. */
export function hash01(n: number): number {
  const h = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  return (((w >>> 22) ^ w) >>> 0) / 4294967295;
}

/** Bead length: a welder runs a bead, stops, moves the rod, strikes again. */
const BEAD = 1.3;
/** The clock wraps here so float32 keeps millisecond precision in the shader. */
const WRAP = 4096;

/** Whether the arc burns at time `t` (seconds). */
export function arcOn(t: number): boolean {
  const seg = Math.floor(t / BEAD);
  const u = t / BEAD - seg;
  return hash01(seg) < 0.74 && u < 0.38 + 0.58 * hash01(seg + 4099);
}

/** The arc's brightness at `t`, 0 to 1: a sputtering, flickering burn while on. */
export function arcLevel(t: number): number {
  if (!arcOn(t)) return 0;
  const f = Math.floor(t * 30);
  if (hash01(f + 77) < 0.07) return 0.18;
  return 0.55 + 0.45 * hash01(f);
}

const GLSL_ARC = /* glsl */ `
  float hash01(uint n) {
    uint h = n * 747796405u + 2891336453u;
    uint w = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    w = (w >> 22u) ^ w;
    return float(w) / 4294967295.0;
  }
  bool arcOn(float t) {
    float seg = floor(t / ${BEAD.toFixed(2)});
    float u = t / ${BEAD.toFixed(2)} - seg;
    uint s = uint(seg);
    return hash01(s) < 0.74 && u < 0.38 + 0.58 * hash01(s + 4099u);
  }
`;

// ---------------------------------------------------------------- shapes

const UP = new THREE.Vector3(0, 1, 0);

/** A matrix that stretches a unit member (centred, along y) into a bar from `a` to `b`, `t` thick. */
function barMatrix(a: THREE.Vector3, b: THREE.Vector3, t: number, d = t): THREE.Matrix4 {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(t, len, d));
}

/** Collects members for one rigid part and merges them into one geometry. */
/** A member's own tone and wear, the same every build (a seeded sequence per kind of part). */
let wearSeed = 0x51ed27;
const wearRnd = (): number => ((wearSeed = (Math.imul(wearSeed ^ (wearSeed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);

class Parts {
  private geos: THREE.BufferGeometry[] = [];
  private static box = new THREE.BoxGeometry(1, 1, 1);
  private static tube = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1);
  bar(a: THREE.Vector3, b: THREE.Vector3, t: number, round = false): void {
    this.geos.push((round ? Parts.tube : Parts.box).clone().applyMatrix4(barMatrix(a, b, t)));
  }
  box(x: number, y: number, z: number, w: number, h: number, d: number, ry = 0): void {
    this.geos.push(Parts.box.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, ry), new THREE.Vector3(w, h, d))));
  }
  add(g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const c = g.clone();
    if (m) c.applyMatrix4(m);
    this.geos.push(c);
  }
  get empty(): boolean {
    return this.geos.length === 0;
  }
  build(): THREE.BufferGeometry {
    wearSeed = 0x51ed27 + this.geos.length;
    const norm = this.geos.map((g) => {
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      g.clearGroups();
      const n = g.index ? g.toNonIndexed() : g;
      // Each member its own: a tone (a different heat of paint, a touched-up bay) and wear (how weathered, how rough).
      const tone = wearRnd();
      const wear = wearRnd() * wearRnd();
      const w = new Float32Array(n.attributes.position.count * 2);
      for (let i = 0; i < w.length; i += 2) {
        w[i] = tone;
        w[i + 1] = wear;
      }
      n.setAttribute('aWear', new THREE.Float32BufferAttribute(w, 2));
      return n;
    });
    const out = mergeGeometries(norm, false)!;
    for (const g of [...this.geos, ...norm]) g.dispose();
    this.geos = [];
    out.computeBoundingSphere();
    return out;
  }
}

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/**
 * A lattice box truss along +y from 0 to `len`: four chords `w` apart, with
 * a zig-zag of diagonals and a horizontal at every panel on each face.
 */
function latticeY(p: Parts, len: number, w: number, panel: number, chord: number, brace: number): void {
  const h = w / 2;
  const corners: Array<[number, number]> = [
    [h, h],
    [-h, h],
    [-h, -h],
    [h, -h],
  ];
  for (const [x, z] of corners) p.bar(v(x, 0, z), v(x, len, z), chord);
  const n = Math.max(1, Math.round(len / panel));
  const step = len / n;
  for (let k = 0; k <= n; k++) {
    const y = k * step;
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corners[f];
      const [bx, bz] = corners[(f + 1) % 4];
      p.bar(v(ax, y, az), v(bx, y, bz), brace, true);
      if (k < n) {
        const flip = (k + f) % 2 === 0;
        p.bar(v(flip ? ax : bx, y, flip ? az : bz), v(flip ? bx : ax, y + step, flip ? bz : az), brace, true);
      }
    }
  }
}

/** An I section (wide flange) along +y from 0 to 1: `d` deep along x, `bf` wide along z. */
function iSection(d: number, bf: number, tf: number, tw: number): THREE.BufferGeometry {
  const p = new Parts();
  p.box(0, 0.5, bf / 2 - tf / 2, d, 1, tf);
  p.box(0, 0.5, -bf / 2 + tf / 2, d, 1, tf);
  p.box(0, 0.5, 0, tw, 1, bf - 2 * tf);
  // Flanges on the outside faces: the web joins them.
  const g = p.build();
  // Turn so the flanges face along x (a column's strong axis) and the web runs along z.
  g.rotateY(Math.PI / 2);
  return g;
}

/** A beam: an I section along x from -0.5 to 0.5, `d` deep, its top at y = 0. */
function beamSection(d: number, bf: number, tf: number, tw: number): THREE.BufferGeometry {
  const p = new Parts();
  p.box(0, -tf / 2, 0, 1, tf, bf);
  p.box(0, -d + tf / 2, 0, 1, tf, bf);
  p.box(0, -d / 2, 0, 1, d - 2 * tf, tw);
  return p.build();
}

/** A sheet of composite metal deck one metre square, its trapezoidal ribs along x, its top at y = 0. */
function deckSheet(ribs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const prof: Array<[number, number]> = [];
  const depth = 0.06;
  for (let r = 0; r < ribs; r++) {
    const z0 = -0.5 + r / ribs;
    const w = 1 / ribs;
    prof.push([z0, 0], [z0 + w * 0.3, 0], [z0 + w * 0.42, -depth], [z0 + w * 0.88, -depth], [z0 + w, 0]);
  }
  for (let i = 0; i < prof.length - 1; i++) {
    const [za, ya] = prof[i];
    const [zb, yb] = prof[i + 1];
    if (za === zb && ya === yb) continue;
    const n = new THREE.Vector3(0, zb - za, -(yb - ya)).normalize();
    const quad = [
      [-0.5, ya, za],
      [0.5, ya, za],
      [0.5, yb, zb],
      [-0.5, ya, za],
      [0.5, yb, zb],
      [-0.5, yb, zb],
    ];
    for (const [x, y, z] of quad) {
      pos.push(x, y, z);
      nor.push(n.x, n.y, n.z);
      uv.push(x + 0.5, z + 0.5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * A net panel `len` wide and `h` tall hanging from y = h down to 0: its top
 * rope sags a hand between the columns it is tied to, its free bottom hem
 * droops further, and it bellies outward (+z), most at the hem.
 */
export function netPanel(len: number, h: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 10, 8);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = x + 0.5;
    const t = y + 0.5;
    // Tied at its top rope and every column; the bottom edge hangs free and swings out a hand's width.
    const span = Math.sin(Math.PI * u);
    const belly = span * (0.08 + 0.2 * (1 - t) * (1 - t));
    const sag = span * (0.1 * t + 0.22 * (1 - t));
    pos.setXYZ(i, x * len, t * h - sag, belly);
    uv.setXY(i, u * len, t * h);
  }
  g.computeVertexNormals();
  return g;
}

/** Net tiles per metre of panel: one 100 mm diamond to a tile, as debris and safety nets are knotted. */
export const NET_TILE = 10;

/**
 * Knotted diamond-mesh netting, one cell per tile, built from data so it
 * builds outside a browser too. `map` carries the cord's twist (a three-strand
 * rope catches the light in short bands, darker where it dives under at a
 * knot); `alpha` is the cord itself (read from the green channel), soft-edged
 * so that far off the net mips to a veil rather than vanishing.
 */
export function netTextures(): { map: THREE.DataTexture; alpha: THREE.DataTexture } {
  const n = 64;
  const shade = new Uint8Array(n * n * 4);
  const cover = new Uint8Array(n * n * 4);
  const r = 3.4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Two cords cross the tile on its diagonals; the knots sit where they meet.
      const a = (x + y) % n;
      const b = (x - y + n) % n;
      const dA = Math.min(a, n - a);
      const dB = Math.min(b, n - b);
      const d = Math.min(dA, dB) / Math.SQRT2;
      const knot = Math.hypot(dA, dB) / Math.SQRT2 < 4.2 ? 1 : 0;
      const on = Math.max(knot, THREE.MathUtils.clamp((r - d) / 0.9 + 0.5, 0, 1));
      // The twist: bands across the cord, along its length.
      const along = dA < dB ? b : a;
      const twist = 0.72 + 0.28 * Math.sin(along * 1.35 + d * 1.6);
      const under = knot ? 0.62 : 1;
      const i = (y * n + x) * 4;
      const v = Math.round(255 * twist * under);
      shade[i] = shade[i + 1] = shade[i + 2] = v;
      shade[i + 3] = 255;
      // A faint floor between the cords: up close the holes stay open, far off the net reads as a dark veil.
      const c = Math.round(255 * Math.max(on, 0.06));
      cover[i] = cover[i + 1] = cover[i + 2] = c;
      cover[i + 3] = 255;
    }
  }
  const tex = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(NET_TILE, NET_TILE);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { map: tex(shade, true), alpha: tex(cover, false) };
}

// ---------------------------------------------------------------- sparks

/** Most job sites the city draws at once (one live run per repo; more than this is never on screen). */
export const MAX_SITES = 8;

/**
 * The sparks' vertex shader. For one site its source is uniforms; for the
 * city's field every site's sparks share one draw, each spark reading its
 * site's arc, roof and clock from arrays by its site attribute.
 */
const sparkVert = (field: boolean): string => /* glsl */ `
  ${GLSL_ARC}
  attribute vec4 aSeed;
  attribute vec4 aDir;
  ${
    field
      ? `attribute float aSite;
  uniform vec4 uSiteA[${MAX_SITES}];
  uniform vec4 uSiteB[${MAX_SITES}];
  vec3 uAt;
  float uTime;
  float uDeck;
  float uHalf;
  vec2 uCentre;`
      : `uniform float uTime;
  uniform vec3 uAt;
  uniform float uDeck;
  uniform float uHalf;
  const vec2 uCentre = vec2(0.0);`
  }
  uniform float uPixel;
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vAlpha;

  const float G = 9.81;
  const float K = 1.6;

  // Where a spark is, \`a\` seconds after it left the arc with velocity \`v0\`: air drag on a tiny drop, then gravity.
  vec3 fly(vec3 v0, float a) {
    float e = (1.0 - exp(-K * a)) / K;
    return vec3(v0.x * e, v0.y * e - G / K * (a - e), v0.z * e);
  }
  vec3 speed(vec3 v0, float a) {
    float e = exp(-K * a);
    return vec3(v0.x * e, v0.y * e - G / K * (1.0 - e), v0.z * e);
  }
  // The spark's position at age \`a\`: it may bounce once on the roof below the arc and skitter, or fall past the facade.
  vec3 at(vec3 v0, float a) {
    float drop = uAt.y - uDeck;
    // Find the first crossing of the roof by stepping and refining.
    float hit = -1.0;
    float prev = 0.0;
    for (int i = 1; i <= 14; i++) {
      float s = float(i) * 0.12;
      if (fly(v0, s).y < -drop) {
        float lo = prev, hi = s;
        for (int j = 0; j < 5; j++) {
          float m = 0.5 * (lo + hi);
          if (fly(v0, m).y < -drop) hi = m; else lo = m;
        }
        hit = hi;
        break;
      }
      prev = s;
    }
    if (hit < 0.0 || a < hit) return fly(v0, a);
    vec3 p = fly(v0, hit);
    vec3 w = uAt + p;
    // Off the roof's edge it keeps falling.
    vec2 rel = w.xz - uCentre;
    if (abs(rel.x) > uHalf || abs(rel.y) > uHalf) return fly(v0, a);
    vec3 s = speed(v0, hit);
    vec3 v1 = vec3(s.x * 0.45, -s.y * 0.28, s.z * 0.45);
    vec3 q = p + fly(v1, a - hit);
    q.y = max(q.y, -drop + 0.01);
    return q;
  }

  void main() {
    vQuad = position.xy;
    ${
      field
        ? `int si = int(aSite + 0.5);
    uAt = uSiteA[si].xyz;
    uTime = uSiteA[si].w;
    uCentre = uSiteB[si].xy;
    uDeck = uSiteB[si].z;
    uHalf = uSiteB[si].w;
    if (uHalf <= 0.0) {
      vAlpha = 0.0;
      vColor = vec3(0.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }`
        : ''
    }
    float life = aSeed.x;
    float period = aSeed.y;
    float t = uTime + aSeed.z * period;
    float k = floor(t / period);
    float age = t - k * period;
    float born = uTime - age;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    if (age > life || !arcOn(mod(born + ${WRAP.toFixed(1)}, ${WRAP.toFixed(1)}))) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // Each spark's own direction, varied every time it is born again.
    float r = fract(sin(k * 12.9898 + aSeed.w * 78.233) * 43758.5453);
    float ang = aDir.x + r * 0.9;
    float up = aDir.y;
    float sp = aDir.z * (0.7 + 0.6 * r);
    vec3 v0 = vec3(cos(ang) * sqrt(1.0 - up * up), up, sin(ang) * sqrt(1.0 - up * up)) * sp;

    vec3 head = uAt + at(v0, age);
    vec3 tail = uAt + at(v0, max(0.0, age - 0.05));
    vec4 hv = modelViewMatrix * vec4(head, 1.0);
    vec4 tv = modelViewMatrix * vec4(tail, 1.0);
    vec3 axis = hv.xyz - tv.xyz;
    float len = length(axis);
    vec3 dir = len > 1e-4 ? axis / len : vec3(0.0, 1.0, 0.0);
    vec3 mid = 0.5 * (hv.xyz + tv.xyz);
    // Across the streak, wound to face the eye (side x dir points at the camera).
    vec3 side = normalize(cross(normalize(mid), dir));
    // At least about a pixel wide: far off, a streak keeps its light but spreads it over a pixel.
    float dist = max(1.0, -mid.z);
    float base = aDir.w;
    float width = max(base, dist * uPixel * 1.1);
    float thin = base / width;
    // Quad: x across the streak, y from tail (-1) to head (+1), with round caps.
    vec3 p = mix(tv.xyz, hv.xyz, position.y * 0.5 + 0.5) + side * position.x * width * 0.5 + dir * position.y * width * 0.5;
    gl_Position = projectionMatrix * vec4(p, 1.0);

    // White-hot as it leaves the arc, orange as it flies, a dull red as it dies.
    float u = age / life;
    vec3 hot = vec3(9.0, 7.6, 5.2);
    vec3 warm = vec3(6.0, 2.3, 0.55);
    vec3 cool = vec3(1.4, 0.22, 0.04);
    vec3 c = mix(hot, warm, smoothstep(0.0, 0.22, u));
    c = mix(c, cool, smoothstep(0.35, 1.0, u));
    vColor = c * mix(1.0, thin, 0.85);
    vAlpha = 1.0 - smoothstep(0.7, 1.0, u);
  }
`;

const SPARK_VERT = sparkVert(false);

const SPARK_FRAG = /* glsl */ `
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float across = 1.0 - vQuad.x * vQuad.x;
    float along = 0.35 + 0.65 * (vQuad.y * 0.5 + 0.5);
    float a = vAlpha * across * along;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const ARC_VERT = /* glsl */ `
  uniform vec3 uAt;
  uniform float uPixel;
  uniform float uSize;
  varying vec2 vQuad;
  void main() {
    vQuad = position.xy;
    vec4 c = modelViewMatrix * vec4(uAt, 1.0);
    float size = max(uSize, -c.z * uPixel * 3.0);
    c.xy += position.xy * size;
    // Drawn a little toward the camera, so the steel it burns on never cuts it.
    c.xyz *= 1.0 - 0.6 / max(1.0, length(c.xyz));
    gl_Position = projectionMatrix * c;
  }
`;

const ARC_FRAG = /* glsl */ `
  uniform float uArc;
  varying vec2 vQuad;
  void main() {
    float r = length(vQuad);
    float core = exp(-r * r * 26.0);
    float glow = exp(-r * 5.5) * 0.35;
    float a = (core * 14.0 + glow * 2.5) * uArc;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vec3(0.78, 0.88, 1.0) * a, 1.0);
  }
`;

/** One quad per spark, `count` per site for `sites` sites (each spark knows its site by `aSite`). */
function sparkQuad(count: number, sites: number): THREE.InstancedBufferGeometry {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const seed = new Float32Array(count * sites * 4);
  const dir = new Float32Array(count * sites * 4);
  const site = new Float32Array(count * sites);
  let s = 0x2545f491;
  const rnd = (): number => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
  for (let i = 0; i < count * sites; i++) {
    site[i] = Math.floor(i / count);
    const glob = rnd() < 0.12;
    // Most sparks are tiny and short; a few are molten drops that fall slowly and glow longer.
    const life = glob ? 1.3 + rnd() * 0.9 : 0.25 + rnd() * rnd() * 1.25;
    seed[i * 4] = life;
    seed[i * 4 + 1] = life + 0.05 + rnd() * 0.5;
    seed[i * 4 + 2] = rnd();
    seed[i * 4 + 3] = rnd();
    dir[i * 4] = rnd() * Math.PI * 2;
    // Mostly sideways and down: an overhead weld throws its spray out and down.
    dir[i * 4 + 1] = glob ? -0.2 - rnd() * 0.6 : -0.85 + rnd() * 1.25;
    dir[i * 4 + 2] = glob ? 0.4 + rnd() * 0.8 : 1.6 + rnd() * rnd() * 7.5;
    dir[i * 4 + 3] = glob ? 0.03 : 0.008 + rnd() * 0.008;
  }
  quad.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  quad.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 4));
  quad.setAttribute('aSite', new THREE.InstancedBufferAttribute(site, 1));
  quad.instanceCount = count * sites;
  return quad;
}

function makeSparks(count: number): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const quad = sparkQuad(count, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uAt: { value: new THREE.Vector3() },
      uDeck: { value: 0 },
      uHalf: { value: 10 },
      uPixel: { value: 0.001 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(quad, material);
  mesh.name = 'construction:sparks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return { mesh, material };
}

/** The world size of one pixel per metre of distance, for the shaders' pixel floors. */
const bufferSize = new THREE.Vector2();
export function pixelScale(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number {
  const cam = camera as THREE.PerspectiveCamera;
  renderer.getDrawingBufferSize(bufferSize);
  const fov = cam.isPerspectiveCamera ? cam.fov : 50;
  return (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))) / Math.max(1, bufferSize.y);
}

// ---------------------------------------------------------------- the object

export interface Construction {
  /** Everything standing on the site, in the tower's space (the roof at `top`). */
  object: THREE.Group;
  /** Shows a site at a stage and progress over a roof at `top`, `half` wide, with a new floor `floorHeight` tall; null takes it all down. */
  set(site: SiteState | null, top: number, half: number, floorHeight: number, finish?: { era?: Era | null }): boolean;
  /** Eases the crane toward the pose the last event set and runs the sparks and lamps. True while something that casts a shadow moved. */
  update(dt: number): boolean;
  /** The welding arc's light this frame, in the site's space: where it is and how bright (candela), or null when nobody welds. */
  weld(): { at: THREE.Vector3; intensity: number } | null;
  /** The brightest the arc's light ever gets (post.ts). */
  readonly flickerPeak: number;
  /** Bumped whenever anything drawn moves or switches (an event, or the crane easing); the city redraws the site's instances then. */
  readonly revision: number;
  /** Bumped whenever the site's parts are rebuilt or taken down; the city rebuilds its batches then. */
  readonly structure: number;
  /** The aviation lamps' brightness this frame, 0 to 1. */
  lampLevel(): number;
  /** The roof the site stands on, its half-width and the new floor's height, or null when nothing stands. */
  roof(): { top: number; half: number; floorHeight: number } | null;
  /** The sparks' source this frame, in the site's space: the arc, the roof they bounce on, its half-width and the site's clock; null when nobody welds. */
  sparks(): { at: THREE.Vector3; deck: number; half: number; time: number } | null;
  /** Where the lit floodlights are, in the site's space (none when they are off). */
  floods(): THREE.Vector3[];
  /** The inspection's two searchlights this frame, in the site's space (none outside an inspection). */
  searchlights(): Searchlight[];
  /** The scar's work lamp: its lens, where its light sits and how bright it burns (candela); null when none burns. */
  workLamp(): { at: THREE.Vector3; light: THREE.Vector3; intensity: number } | null;
  /** What the floor finishes as, the tone the frame cured to and how far its windows have lit (null before any site). */
  finish(): { floor: 'era' | 'primer' | null; era: Era | null; tone: THREE.Color; windows: number | null } | null;
  /** The state last shown (tests and the city's debug view). */
  state(): ConstructionState | null;
  /** True while a transition (the cure, the lighting, the strike) is still under way. */
  busy(): boolean;
  /** Copies the site again where it stands (its object moved). */
  touch(): void;
  dispose(): void;
}

interface Built {
  key: string;
  state: ConstructionState;
  crane: THREE.Group;
  slew: THREE.Group;
  trolley: THREE.Group;
  hook: THREE.Group;
  load: THREE.Object3D;
  ropes: THREE.Mesh;
  columns: THREE.InstancedMesh;
  beams: THREE.InstancedMesh;
  decks: THREE.InstancedMesh;
  nets: THREE.InstancedMesh;
  lamps: THREE.Mesh;
  lampMat: THREE.MeshBasicMaterial;
  sparks: THREE.Mesh;
  sparkMat: THREE.ShaderMaterial;
  arc: THREE.Mesh;
  arcMat: THREE.ShaderMaterial;
  top: number;
  half: number;
  fh: number;
  floods: THREE.Group;
  lampLevel: number;
  /** The frame's pieces where they stand, before any is struck or let down. */
  rest: { columns: THREE.Matrix4[]; beams: THREE.Matrix4[]; decks: THREE.Matrix4[]; nets: THREE.Matrix4[] };
  /** The mast and its ladder, shortened as the crane climbs down. */
  mast: THREE.Object3D[];
  craneHeight: number;
  search: THREE.Group;
  heads: THREE.Group[];
  work: THREE.Group;
  /** The struck site's crane and frame have been taken off (a scar keeps only its lamp). */
  struck: boolean;
  /** Last strike and net drop laid out, so the instances move only when they change. */
  laid: { strike: number; netDrop: number };
  craneFade: number;
  disposables: Array<{ dispose(): void }>;
}

/** The crane's paint: a weathered crane yellow, darker than signage so it reads as painted steel at dusk. */
const CRANE_YELLOW = 0x9c8a3e;
const PRIMER = 0x5c3024;
const LAMP_RED = new THREE.Color(9, 0.35, 0.1);
/** The floodlights' lenses: a warm high-pressure-sodium white, hot enough to bloom. */
const FLOOD_LENS = new THREE.Color(7.5, 4.6, 2.2);
/** A searchlight's lens seen down its beam: a xenon white, far over the bloom threshold. */
const SEARCH_LENS = new THREE.Color(10, 9.7, 9.2);
/** The scar's work lamp's lens: a warm 3000 K glow that blooms a little. */
const WORK_LENS = new THREE.Color(5.2, 3.3, 1.7);
const NET_GREEN = 0x3c5646;
/** How far above the new floor's top the flood heads stand. */
const FLOOD_RISE = 2.4;

/** Eases `x` toward `to`, snapping when within `eps` so a settled pose is exact. */
function approach(x: number, to: number, k: number, dt: number, eps: number): number {
  const next = x + (to - x) * (1 - Math.exp(-k * dt));
  return Math.abs(to - next) < eps ? to : next;
}
/** The same for an angle, the short way round. */
function approachAngle(x: number, to: number, k: number, dt: number, eps: number): number {
  let d = to - x;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const next = x + d * (1 - Math.exp(-k * dt));
  return Math.abs(Math.atan2(Math.sin(to - next), Math.cos(to - next))) < eps ? to : next;
}

export function makeConstruction(quality: 'high' | 'medium'): Construction {
  const object = new THREE.Group();
  object.name = 'construction';
  const sparkCount = quality === 'high' ? 720 : 300;
  let built: Built | null = null;
  let site: SiteState | null = null;
  let clock = 0;
  let arcLevelNow = 0;
  const weldAt = new THREE.Vector3();
  let revision = 0;
  let structure = 0;

  function build(top: number, half: number, fh: number, state: ConstructionState): Built {
    const disposables: Array<{ dispose(): void }> = [];
    const own = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };
    const mats = {
      yellow: own(new THREE.MeshStandardMaterial({ color: CRANE_YELLOW, roughness: 0.66, metalness: 0.2 })),
      dark: own(new THREE.MeshStandardMaterial({ color: 0x2b2c2e, roughness: 0.55, metalness: 0.7 })),
      ballast: own(new THREE.MeshStandardMaterial({ color: 0x6f6c66, roughness: 0.95 })),
      glass: own(
        new THREE.MeshStandardMaterial({ color: 0x141b20, roughness: 0.06, metalness: 0.3, emissive: new THREE.Color(1.0, 0.72, 0.42), emissiveIntensity: 0.22 }),
      ),
      primer: own(new THREE.MeshStandardMaterial({ color: PRIMER, roughness: 0.72, metalness: 0.2 })),
      deck: own(new THREE.MeshStandardMaterial({ color: 0x9ea3a6, roughness: 0.42, metalness: 0.85, side: THREE.DoubleSide })),
      rope: own(new THREE.MeshStandardMaterial({ color: 0x1d1e1f, roughness: 0.45, metalness: 0.8 })),
    };
    const net = netTextures();
    own(net.map);
    own(net.alpha);
    const netMat = own(new THREE.MeshStandardMaterial({ color: NET_GREEN, roughness: 1, map: net.map, alphaMap: net.alpha, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const lampMat = own(new THREE.MeshBasicMaterial({ color: LAMP_RED.clone(), toneMapped: true }));
    const floodMat = own(new THREE.MeshBasicMaterial({ color: FLOOD_LENS.clone(), toneMapped: true }));
    const searchMat = own(new THREE.MeshBasicMaterial({ color: SEARCH_LENS.clone(), toneMapped: true }));
    const workMat = own(new THREE.MeshBasicMaterial({ color: WORK_LENS.clone(), toneMapped: true }));
    // Named by kind: the city draws every site's parts of one kind together (ConstructionField), by these names.
    for (const [k, m] of Object.entries({ ...mats, net: netMat, lamp: lampMat, flood: floodMat, search: searchMat, work: workMat })) m.name = k;

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow = true): THREE.Mesh => {
      own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      return m;
    };

    // A site first seen with its crane already gone (a scar, when the quality drop builds every site afresh) still
    // builds the crane it had, so the parts the rest of the site hangs off exist; it is struck straight away (set).
    const cr = state.crane ?? craneFor(half, fh);
    const H = cr.height;
    const L = cr.jib;
    const C = cr.counter;
    const crane = new THREE.Group();
    crane.name = 'construction:crane';
    crane.position.set(cr.x, top, cr.z);

    // the cross base on the roof and the mast
    const base = new Parts();
    const reach = Math.min(4.2, half * 0.6);
    for (const r of [Math.PI / 4, -Math.PI / 4]) {
      const a = v(Math.cos(r) * reach, 0.25, Math.sin(r) * reach);
      base.bar(a.clone().negate().setY(0.25), a, 0.5);
    }
    const mast = new Parts();
    latticeY(mast, H, MAST_W, 2.5, 0.16, 0.075);
    // Climbing-frame collar and a rest platform halfway, with its handrail.
    mast.box(0, 0.35, 0, MAST_W + 0.4, 0.5, MAST_W + 0.4);
    const ballast = new Parts();
    for (const r of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      ballast.box(Math.cos(r) * reach * 0.82, 0.95, Math.sin(r) * reach * 0.82, 1.6, 0.9, 1.2, -r);
    }
    const mastMesh = mesh(mast.build(), mats.yellow, 'construction:mast');
    crane.add(mastMesh);
    crane.add(mesh(base.build(), mats.dark, 'construction:base'));
    crane.add(mesh(ballast.build(), mats.ballast, 'construction:base-ballast'));
    // The mast's ladder inside, as a dark rail.
    const ladder = new Parts();
    ladder.bar(v(0.35, 0.6, -0.55), v(0.35, H, -0.55), 0.05);
    ladder.bar(v(-0.05, 0.6, -0.55), v(-0.05, H, -0.55), 0.05);
    for (let y = 0.9; y < H; y += 0.6) ladder.bar(v(-0.05, y, -0.55), v(0.35, y, -0.55), 0.03);

    // the slewing part: turntable, cab, cat head, jib, counter-jib
    const slew = new THREE.Group();
    slew.name = 'construction:slew';
    slew.position.y = H;
    const jy = 0.9;
    const yel = new Parts();
    const dark = new Parts();
    // Turntable and slewing ring.
    dark.add(new THREE.CylinderGeometry(1.05, 1.05, 0.35, 20), new THREE.Matrix4().makeTranslation(0, 0.18, 0));
    yel.box(0, jy - 0.2, 0, 2.2, 0.4, 2.2);
    // Cat head: four legs from the platform's corners to the apex, with two belts of bracing.
    const apexY = jy + 7.2;
    const legs: Array<[number, number]> = [
      [0.9, 0.9],
      [-0.9, 0.9],
      [-0.9, -0.9],
      [0.9, -0.9],
    ];
    for (const [x, z] of legs) yel.bar(v(x, jy, z), v(0, apexY, 0), 0.2);
    for (const y of [jy + 2.4, jy + 4.8]) {
      const f = 1 - (y - jy) / (apexY - jy);
      for (let i = 0; i < 4; i++) {
        const [ax, az] = legs[i];
        const [bx, bz] = legs[(i + 1) % 4];
        yel.bar(v(ax * f, y, az * f), v(bx * f, y, bz * f), 0.09, true);
      }
    }
    // Jib: a triangular truss, two bottom chords the trolley runs on and a top chord, in 2.4 m panels, tapering at its tip.
    const panel = 2.4;
    const n = Math.round((L - 1.2) / panel);
    const jibAt = (x: number): { w: number; h: number } => {
      const f = (x - 1.2) / (L - 1.2);
      return { w: 0.6, h: 1.45 - 0.75 * Math.max(0, f - 0.55) / 0.45 };
    };
    for (let k = 0; k < n; k++) {
      const x0 = 1.2 + k * panel;
      const x1 = x0 + panel;
      const a = jibAt(x0);
      const b = jibAt(x1);
      for (const s of [-1, 1]) {
        yel.bar(v(x0, jy, s * a.w), v(x1, jy, s * b.w), 0.16);
        // Side diagonals up to the top chord, a W pattern.
        yel.bar(v(k % 2 ? x0 : x1, jy, s * (k % 2 ? a.w : b.w)), v(k % 2 ? x1 : x0, jy + (k % 2 ? b.h : a.h), 0), 0.08, true);
      }
      yel.bar(v(x0, jy + a.h, 0), v(x1, jy + b.h, 0), 0.15, true);
      // Bottom ladder: a cross member and a diagonal.
      yel.bar(v(x0, jy, -a.w), v(x0, jy, a.w), 0.07, true);
      yel.bar(v(x0, jy, -a.w), v(x1, jy, b.w), 0.06, true);
      for (const s of [-1, 1]) yel.bar(v(x0, jy, s * a.w), v(x0, jy + a.h, 0), 0.07, true);
    }
    // The jib's root: a short heavy section bolted to the cat head.
    yel.box(0.6, jy + 0.7, 0, 1.2, 1.4, 1.3);
    // Tip: an end frame.
    const tip = jibAt(L);
    for (const s of [-1, 1]) yel.bar(v(L, jy, s * tip.w), v(L, jy + tip.h, 0), 0.1);
    // Counter-jib: two deep side beams, cross members, a grating, handrails, the winch and the ballast.
    const cy = jy + 0.25;
    for (const s of [-1, 1]) {
      yel.bar(v(-0.9, cy, s * 1.0), v(-C, cy, s * 1.0), 0.32);
      // Handrail posts and rails.
      dark.bar(v(-1, cy + 1.15, s * 1.15), v(-C + 0.2, cy + 1.15, s * 1.15), 0.05, true);
      dark.bar(v(-1, cy + 0.6, s * 1.15), v(-C + 0.2, cy + 0.6, s * 1.15), 0.035, true);
      for (let x = -1.2; x > -C; x -= 1.6) dark.bar(v(x, cy, s * 1.15), v(x, cy + 1.15, s * 1.15), 0.045, true);
    }
    for (let x = -1.2; x > -C; x -= 1.5) yel.bar(v(x, cy, -1.0), v(x, cy, 1.0), 0.14);
    dark.box(-C / 2 - 0.5, cy + 0.17, 0, C - 1.2, 0.04, 1.9);
    // Hoist winch: a drum on its frame, the motor and the electrical cabinet.
    dark.add(new THREE.CylinderGeometry(0.42, 0.42, 1.3, 16), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(-C * 0.45, cy + 0.65, 0)));
    yel.box(-C * 0.45 - 0.9, cy + 0.6, 0.45, 0.8, 0.75, 0.6);
    yel.box(-C * 0.62, cy + 0.85, -0.55, 0.9, 1.25, 0.55);
    const ball = new Parts();
    for (let i = 0; i < 4; i++) ball.box(-C + 0.45 + i * 0.58, cy - 0.35, 0, 0.52, 2.6, 2.3);
    // Pendants: tie bars from the apex to the jib's top chord at about 60%, and to the counter-jib's tail.
    const tieX = 1.2 + Math.round(n * 0.6) * panel;
    const tieAt = jibAt(tieX);
    for (const s of [-1, 1]) {
      dark.bar(v(0, apexY, s * 0.12), v(tieX, jy + tieAt.h, s * 0.08), 0.07, true);
      dark.bar(v(0, apexY, s * 0.12), v(-C + 0.6, cy + 0.2, s * 1.0), 0.07, true);
    }
    // Cab: on its own bracket at the jib's root, on the side, glazed to the front and below.
    yel.box(1.65, jy - 0.55, 1.55, 2.1, 0.12, 1.65);
    const cabFrame = new Parts();
    const cx0 = 0.75;
    const cx1 = 2.55;
    const cz0 = 0.75;
    const cz1 = 2.35;
    const cyb = jy - 0.48;
    const cyt = jy + 1.75;
    for (const [x, z] of [
      [cx0, cz0],
      [cx1, cz0],
      [cx1, cz1],
      [cx0, cz1],
    ] as Array<[number, number]>) cabFrame.bar(v(x, cyb, z), v(x, cyt, z), 0.1);
    cabFrame.box((cx0 + cx1) / 2, cyt + 0.06, (cz0 + cz1) / 2, cx1 - cx0 + 0.12, 0.14, cz1 - cz0 + 0.12);
    cabFrame.box(cx0 + 0.02, (cyb + cyt) / 2, (cz0 + cz1) / 2, 0.06, cyt - cyb, cz1 - cz0);
    cabFrame.box((cx0 + cx1) / 2, (cyb + cyt) / 2, cz0 + 0.02, cx1 - cx0, cyt - cyb, 0.06);
    const glass = new Parts();
    glass.box(cx1 - 0.02, (cyb + cyt) / 2 + 0.1, (cz0 + cz1) / 2, 0.04, cyt - cyb - 0.25, cz1 - cz0 - 0.12);
    glass.box((cx0 + cx1) / 2, (cyb + cyt) / 2 + 0.1, cz1 - 0.02, cx1 - cx0 - 0.12, cyt - cyb - 0.25, 0.04);
    // Walkways along the jib root and the cat head's platform rails.
    for (const s of [-1, 1]) dark.bar(v(-1.1, jy + 1.05, s * 1.12), v(1.1, jy + 1.05, s * 1.12), 0.04, true);

    // The cab's frame is the same paint: one draw with the rest of the slewing steel.
    const cabSteel = cabFrame.build();
    yel.add(cabSteel);
    cabSteel.dispose();
    slew.add(mesh(yel.build(), mats.yellow, 'construction:slew-steel'));
    slew.add(mesh(dark.build(), mats.dark, 'construction:slew-dark'));
    slew.add(mesh(ball.build(), mats.ballast, 'construction:ballast'));
    slew.add(mesh(glass.build(), mats.glass, 'construction:cab-glass', false));
    const ladderMesh = mesh(ladder.build(), mats.dark, 'construction:ladder');
    crane.add(ladderMesh);

    // trolley, hook block, ropes and the load
    const trolley = new THREE.Group();
    trolley.name = 'construction:trolley';
    const tp = new Parts();
    tp.box(0, jy - 0.15, 0, 1.5, 0.22, 1.5);
    for (const s of [-1, 1]) for (const x of [-0.5, 0.5]) tp.add(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(x, jy + 0.05, s * 0.6)));
    tp.box(0, jy - 0.4, 0, 0.9, 0.3, 0.5);
    trolley.add(mesh(tp.build(), mats.dark, 'construction:trolley-frame'));
    trolley.position.x = state.trolley;
    slew.add(trolley);

    const hook = new THREE.Group();
    hook.name = 'construction:hook';
    const hb = new Parts();
    // Hook block: a yellow block between two sheave plates, the hook beneath it.
    hb.box(0, 0, 0, 0.75, 1.0, 0.42);
    const hkDark = new Parts();
    for (const s of [-1, 1]) hkDark.add(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 18), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, 0.25, s * 0.24)));
    hkDark.bar(v(0, -0.5, 0), v(0, -0.85, 0), 0.12, true);
    const hookCurve = new THREE.TorusGeometry(0.22, 0.06, 6, 12, Math.PI * 1.4);
    hkDark.add(hookCurve, new THREE.Matrix4().makeRotationZ(Math.PI * 0.8).premultiply(new THREE.Matrix4().makeTranslation(0, -1.05, 0)));
    hookCurve.dispose();
    hook.add(mesh(hb.build(), mats.yellow, 'construction:hook-block'));
    hook.add(mesh(hkDark.build(), mats.dark, 'construction:hook-iron'));
    // The load: the next beam, slung level from the hook on two legs of chain.
    const load = new THREE.Group();
    load.name = 'construction:load';
    const lay = frameLayout(half);
    const loadBeam = beamSection(BEAM_D, 0.19, 0.016, 0.01);
    const lb = new THREE.Mesh(loadBeam, mats.primer);
    own(loadBeam);
    lb.scale.x = lay.bay - COL_D;
    lb.position.y = -2.7;
    lb.castShadow = true;
    load.add(lb);
    const sling = new Parts();
    for (const s of [-1, 1]) sling.bar(v(0, -1.15, 0), v(s * (lay.bay - COL_D) * 0.3, -2.7, 0), 0.035, true);
    load.add(mesh(sling.build(), mats.rope, 'construction:sling'));
    hook.add(load);
    hook.position.set(state.trolley, state.hook, 0);
    slew.add(hook);
    // Two falls of wire rope from the trolley's sheaves down to the block; stretched each time the hook moves.
    const ropeGeo = new Parts();
    for (const s of [-1, 1]) ropeGeo.bar(v(0, 0, s * 0.2), v(0, -1, s * 0.2), 0.055, true);
    const ropes = mesh(ropeGeo.build(), mats.rope, 'construction:ropes');
    slew.add(ropes);
    slew.rotation.y = state.slew;
    crane.add(slew);

    // aviation lamps on the jib tip and the cat head's apex
    const lampGeo = new THREE.SphereGeometry(0.22, 12, 8);
    const lamps = new Parts();
    lamps.add(lampGeo, new THREE.Matrix4().makeTranslation(L + 0.1, jy + tip.h + 0.25, 0));
    lamps.add(lampGeo, new THREE.Matrix4().makeTranslation(0, apexY + 0.3, 0));
    lampGeo.dispose();
    const lampMesh = mesh(lamps.build(), lampMat, 'construction:lamps', false);
    slew.add(lampMesh);
    object.add(crane);

    // the new floor's frame
    const colGeo = own(iSection(COL_D, 0.37, 0.025, 0.014));
    const columns = new THREE.InstancedMesh(colGeo, mats.primer, lay.columns.length);
    columns.name = 'construction:columns';
    const rest = { columns: [] as THREE.Matrix4[], beams: [] as THREE.Matrix4[], decks: [] as THREE.Matrix4[], nets: [] as THREE.Matrix4[] };
    lay.columns.forEach(([x, z], i) => columns.setMatrixAt(i, rest.columns[i] = new THREE.Matrix4().compose(v(x, top, z), new THREE.Quaternion(), v(1, fh, 1))));
    const beamGeo = own(beamSection(BEAM_D, 0.19, 0.016, 0.01));
    const beams = new THREE.InstancedMesh(beamGeo, mats.primer, lay.beams.length);
    beams.name = 'construction:beams';
    lay.beams.forEach((b, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, b.dir === 'x' ? 0 : Math.PI / 2);
      beams.setMatrixAt(i, rest.beams[i] = new THREE.Matrix4().compose(v(b.x, top + fh, b.z), q, v(b.len - COL_D, 1, 1)));
    });
    const deckGeo = own(deckSheet(8));
    const decks = new THREE.InstancedMesh(deckGeo, mats.deck, lay.decks.length);
    decks.name = 'construction:decks';
    lay.decks.forEach(([x, z], i) => decks.setMatrixAt(i, rest.decks[i] = new THREE.Matrix4().compose(v(x, top + fh + 0.065, z), new THREE.Quaternion(), v(lay.bay - 0.12, 1, lay.bay - 0.12))));
    const netGeo = own(netPanel(lay.nets[0].len, fh + NET_OVER + 0.3));
    const nets = new THREE.InstancedMesh(netGeo, netMat, lay.nets.length);
    nets.name = 'construction:netting';
    lay.nets.forEach((nt, i) => nets.setMatrixAt(i, rest.nets[i] = new THREE.Matrix4().compose(v(nt.x, top - 0.3, nt.z), new THREE.Quaternion().setFromAxisAngle(UP, nt.ry), v(1, 1, 1))));
    // Each piece fades on its own (the cure, the strike): the city's batches read these as instance alpha.
    for (const m of [columns, beams, decks, nets]) {
      m.userData.fade = new Float32Array(m.instanceMatrix.count).fill(1);
      m.userData.paint = 0;
    }
    for (const m of [columns, beams, decks]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    nets.receiveShadow = true;
    object.add(columns, beams, decks, nets);

    // Work floodlights: two on short masts at the deck's far corners, heads tipped in over the frame.
    const floods = new THREE.Group();
    floods.name = 'construction:floods';
    const pole = new Parts();
    const heads = new Parts();
    const lens = new Parts();
    const floodAt: THREE.Vector3[] = [];
    const fy = top + fh + FLOOD_RISE;
    for (const [sx, sz] of [
      [1, 1],
      [-1, -1],
    ]) {
      const x = sx * (half - 0.6);
      const z = sz * (half - 0.6);
      pole.bar(v(x, top, z), v(x, fy, z), 0.09, true);
      pole.bar(v(x - sx * 0.6, top, z), v(x, top + 1.6, z), 0.05, true);
      pole.bar(v(x, top, z - sz * 0.6), v(x, top + 1.6, z), 0.05, true);
      // The head faces the deck's middle, tipped down.
      const ry = Math.atan2(-x, -z);
      const m = new THREE.Matrix4().compose(v(x, fy, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.45, ry, 0, 'YXZ')), v(1, 1, 1));
      for (const dx of [-0.3, 0.3]) {
        const box = new THREE.BoxGeometry(0.5, 0.42, 0.2);
        heads.add(box, new THREE.Matrix4().makeTranslation(dx, 0, 0).premultiply(m));
        box.dispose();
        const glass = new THREE.PlaneGeometry(0.42, 0.34);
        lens.add(glass, new THREE.Matrix4().makeTranslation(dx, 0, 0.105).premultiply(m));
        glass.dispose();
      }
      floodAt.push(v(x, fy, z).add(v(-x, 0, -z).normalize().multiplyScalar(0.3)));
    }
    floods.add(mesh(pole.build(), mats.dark, 'construction:flood-masts'));
    floods.add(mesh(heads.build(), mats.dark, 'construction:flood-heads'));
    floods.add(mesh(lens.build(), floodMat, 'construction:flood-lenses', false));
    floods.userData.at = floodAt;
    object.add(floods);

    // The inspection guild's searchlights: two drum lamps on tripods at the plaza edge, on the side the city sees.
    const search = new THREE.Group();
    search.name = 'construction:searchlights';
    const tripods = new Parts();
    const searchHeads: THREE.Group[] = [];
    const drumGeo = new Parts();
    // A 2 kW xenon drum: a 0.7 m barrel, its cooling fins, the rear cap and the handle; the lens at the front (z 0).
    drumGeo.add(new THREE.CylinderGeometry(0.36, 0.36, 0.62, 22, 1, true), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, 0, -0.33)));
    drumGeo.add(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 22), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, 0, -0.02)));
    for (let k = 0; k < 5; k++) drumGeo.add(new THREE.CylinderGeometry(0.42, 0.42, 0.025, 22), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, 0, -0.2 - k * 0.09)));
    drumGeo.add(new THREE.CylinderGeometry(0.3, 0.36, 0.14, 22), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, 0, -0.71)));
    drumGeo.bar(v(0, 0.36, -0.5), v(0, 0.5, -0.36), 0.03, true);
    drumGeo.bar(v(0, 0.5, -0.36), v(0, 0.5, -0.12), 0.03, true);
    drumGeo.bar(v(0, 0.5, -0.12), v(0, 0.36, -0.02), 0.03, true);
    // Trunnions either side, on the yoke's axis.
    for (const sx of [-1, 1]) drumGeo.add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10), new THREE.Matrix4().makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(sx * 0.42, 0, -0.33)));
    const drum = drumGeo.build();
    const lensGeo = own(new THREE.CircleGeometry(0.31, 24));
    for (let i = 0; i < 2; i++) {
      const a = SEARCH_BEARING + (i === 0 ? -SEARCH_SPREAD : SEARCH_SPREAD);
      const x = Math.cos(a) * SEARCH_RING;
      const z = Math.sin(a) * SEARCH_RING;
      // Three splayed legs to a head plate, a centre post, the turntable and a yoke whose forks hold the drum.
      for (let k = 0; k < 3; k++) {
        const r = (k / 3) * Math.PI * 2 + a;
        tripods.bar(v(x + Math.cos(r) * 0.95, 0.02, z + Math.sin(r) * 0.95), v(x, 0.92, z), 0.05);
        tripods.bar(v(x + Math.cos(r) * 0.45, 0.45, z + Math.sin(r) * 0.45), v(x, 0.62, z), 0.025, true);
      }
      tripods.add(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16), new THREE.Matrix4().makeTranslation(x, 0.95, z));
      tripods.bar(v(x, 0.95, z), v(x, 1.12, z), 0.12, true);
      tripods.add(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 18), new THREE.Matrix4().makeTranslation(x, 1.15, z));
      const toward = Math.atan2(-z, -x);
      for (const sx of [-1, 1]) {
        const px = x + Math.cos(toward + Math.PI / 2) * sx * 0.5;
        const pz = z + Math.sin(toward + Math.PI / 2) * sx * 0.5;
        tripods.bar(v(x, 1.17, z), v(px, 1.2, pz), 0.05, true);
        tripods.bar(v(px, 1.2, pz), v(px, SEARCH_LENS_Y, pz), 0.05, true);
      }
      // A cable reel and its lead off across the paving to the guild's van.
      tripods.add(new THREE.CylinderGeometry(0.28, 0.28, 0.18, 16), new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(x - Math.cos(a) * 1.6, 0.28, z - Math.sin(a) * 1.6)));
      tripods.bar(v(x, 0.03, z), v(x - Math.cos(a) * 1.6, 0.03, z - Math.sin(a) * 1.6), 0.025, true);
      const head = new THREE.Group();
      head.name = `construction:searchlight-head-${i}`;
      head.position.set(x, SEARCH_LENS_Y, z);
      const d = new THREE.Mesh(drum, mats.dark);
      d.name = `construction:searchlight-drum-${i}`;
      d.castShadow = false;
      d.userData.live = true;
      const lens = new THREE.Mesh(lensGeo, searchMat);
      lens.name = `construction:searchlight-lens-${i}`;
      lens.userData.live = true;
      head.add(d, lens);
      searchHeads.push(head);
      search.add(head);
    }
    own(drum);
    search.add(mesh(tripods.build(), mats.dark, 'construction:searchlight-tripods', false));
    search.visible = false;
    object.add(search);

    // The scar's work lamp: a caged lamp on a clamp bracket off the bare corner post that faces the city, raking the primer.
    const work = new THREE.Group();
    work.name = 'construction:worklamp';
    const wy = top + fh * 0.62;
    const wc = half - 0.1;
    const wl = half + 0.5;
    const bracket = new Parts();
    bracket.bar(v(wc, wy - 0.1, wc), v(wl, wy - 0.1, wl), 0.05);
    bracket.box(wc, wy - 0.1, wc, 0.22, 0.14, 0.22);
    bracket.bar(v(wl, wy - 0.1, wl), v(wl, wy + 0.05, wl), 0.04);
    const lampHead = new Parts();
    lampHead.box(0, 0, -0.08, 0.3, 0.24, 0.16);
    for (const hx of [-0.1, 0, 0.1]) lampHead.bar(v(hx, -0.12, 0.01), v(hx, 0.12, 0.01), 0.014, true);
    lampHead.bar(v(-0.18, 0.13, -0.05), v(0.18, 0.13, -0.05), 0.02, true);
    const lampAim = new THREE.Matrix4().compose(v(wl, wy + 0.12, wl), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, -Math.PI / 2 - 0.35, 0, 'YXZ')), v(1, 1, 1));
    const workSteel = new Parts();
    workSteel.add(bracket.build());
    workSteel.add(lampHead.build(), lampAim);
    work.add(mesh(workSteel.build(), mats.dark, 'construction:worklamp-steel', false));
    const workLens = new THREE.Mesh(own(new THREE.PlaneGeometry(0.24, 0.18)), workMat);
    workLens.name = 'construction:worklamp-lens';
    workLens.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 0.005).premultiply(lampAim));
    work.add(workLens);
    work.userData.at = new THREE.Vector3(0, 0, 0.005).applyMatrix4(lampAim);
    // The light sits out in front of the face it rakes, so the nearest primer is a metre off (WORK_LAMP).
    work.userData.light = v(half - 0.1, wy + 0.05, half + 1.1);
    work.visible = false;
    object.add(work);

    // sparks and the arc
    const { mesh: sparks, material: sparkMat } = makeSparks(sparkCount);
    own(sparks.geometry);
    own(sparkMat);
    sparkMat.uniforms.uDeck.value = top;
    sparkMat.uniforms.uHalf.value = half;
    sparks.onBeforeRender = (renderer, _scene, camera) => {
      sparkMat.uniforms.uPixel.value = pixelScale(renderer, camera);
    };
    const arcGeo = own(new THREE.PlaneGeometry(2, 2));
    const arcMat = own(
      new THREE.ShaderMaterial({
        vertexShader: ARC_VERT,
        fragmentShader: ARC_FRAG,
        uniforms: { uAt: { value: new THREE.Vector3() }, uPixel: { value: 0.001 }, uSize: { value: 0.35 }, uArc: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.name = 'construction:spark-arc';
    arc.frustumCulled = false;
    arc.renderOrder = 3;
    arc.onBeforeRender = (renderer, _scene, camera) => {
      arcMat.uniforms.uPixel.value = pixelScale(renderer, camera);
    };
    object.add(sparks, arc);

    return {
      key: '',
      state,
      crane,
      slew,
      trolley,
      hook,
      load,
      ropes,
      columns,
      beams,
      decks,
      nets,
      lamps: lampMesh,
      lampMat,
      sparks,
      sparkMat,
      arc,
      arcMat,
      top,
      half,
      fh,
      floods,
      lampLevel: 1,
      rest,
      mast: [mastMesh, ladderMesh],
      craneHeight: H,
      search,
      heads: searchHeads,
      work,
      struck: false,
      laid: { strike: -1, netDrop: -1 },
      craneFade: 1,
      disposables,
    };
  }

  function clear(): void {
    if (!built) return;
    structure++;
    revision++;
    for (const d of built.disposables) d.dispose();
    object.clear();
    built = null;
  }

  // ------------------------------------------------ transitions: the cure, the lighting and the strike
  let clocks: StageClocks = {};
  let before: Before | undefined;
  let era: Era | null = null;
  let current: ConstructionState | null = null;
  let roof: { top: number; half: number; fh: number } | null = null;
  const tone = new THREE.Color();
  const tint = (): THREE.Color => tone.copy(era ? ERA_TONE[era] : CURE_GREY);
  /** Whether a transition is still under way at these clocks. */
  const live = (c: StageClocks): boolean => {
    if (c.cure !== undefined && c.cure < CURE_S) return true;
    if (c.strike !== undefined && c.strike < STRIKE_S) return true;
    if (c.lit !== undefined && site?.stage === 'curing') {
      const since = Math.min(c.lit, (c.cure ?? Infinity) - CURE_S);
      if (since < WINDOWS_S + DISMANTLE_PAUSE + DISMANTLE_S) return true;
    }
    return false;
  };
  /** Nothing stands any more: no crane, no frame and no lamp. */
  const gone = (s: ConstructionState): boolean => !s.crane && !s.workLamp && (s.frameFade <= 0 || s.strike >= 1 || s.beams.shown + s.columns.shown === 0);

  /** Lays the frame's pieces out for a state: struck pieces lowered and faded, the netting let down, the paint turned. */
  function layFrame(b: Built, s: ConstructionState): void {
    const total = s.decks.shown + s.beams.shown + s.columns.shown;
    // Struck in reverse erection order: the last deck sheet first, the first column last; about a third move at once.
    const struck = (k: number): number => (total ? clamp01((s.strike - (k / total) * 0.7) / 0.3) : 1);
    const moved = s.strike !== b.laid.strike;
    let k = 0;
    const m = new THREE.Matrix4();
    for (const [mesh, rest, shown] of [
      [b.decks, b.rest.decks, s.decks.shown],
      [b.beams, b.rest.beams, s.beams.shown],
      [b.columns, b.rest.columns, s.columns.shown],
    ] as Array<[THREE.InstancedMesh, THREE.Matrix4[], number]>) {
      const fade = mesh.userData.fade as Float32Array;
      for (let i = shown - 1; i >= 0; i--) {
        const l = struck(k++);
        // Each piece is lowered off its seat into the floor and is gone at the last; in the cure each piece goes whole
        // at its own moment, so the frame thins member by member into the floor rather than dissolving in a stipple.
        const cured = s.frameFade < 1 && s.frameFade <= 0.02 + 0.96 * hash01(k * 7919 + 13);
        fade[i] = !cured && l < 0.98 ? 1 : 0;
        if (moved) mesh.setMatrixAt(i, l > 0 ? m.makeTranslation(0, -b.fh * 0.8 * ease(l), 0).multiply(rest[i]) : rest[i]);
      }
      if (moved) mesh.instanceMatrix.needsUpdate = true;
      mesh.userData.tint = { color: tint(), k: s.frameTint };
      mesh.userData.paint++;
      mesh.visible = shown > 0 && fade.subarray(0, shown).some((f) => f > 0);
    }
    // The netting is let down the face on its ropes, and taken away at the foot.
    const nf = b.nets.userData.fade as Float32Array;
    const drop = ease(s.netDrop) * (b.fh + 3);
    for (let i = 0; i < s.nets; i++) {
      nf[i] = 1 - smooth(s.netDrop, 0.55, 1);
      if (s.netDrop !== b.laid.netDrop) b.nets.setMatrixAt(i, drop > 0 ? m.makeTranslation(0, -drop, 0).multiply(b.rest.nets[i]) : b.rest.nets[i]);
    }
    if (s.netDrop !== b.laid.netDrop) b.nets.instanceMatrix.needsUpdate = true;
    b.nets.userData.paint++;
    b.nets.visible = s.nets > 0 && s.netDrop < 1;
    b.laid = { strike: s.strike, netDrop: s.netDrop };
  }

  /** The crane climbs down its own mast: the slewing head lowered a section at a time, the mast shortened under it, then the base taken off. */
  function layCrane(b: Built, s: ConstructionState): void {
    const d = s.dismantle;
    const H = b.craneHeight;
    const y = H - (H - 1.4) * ease(clamp01(d / 0.85));
    b.slew.position.y = y;
    for (const o of b.mast) o.scale.y = Math.max(0.02, y / H);
    // The base is taken off whole once the head is down.
    const fade = d < 0.97 ? 1 : 0;
    if (fade === b.craneFade) return;
    b.craneFade = fade;
    b.crane.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.userData.fade = fade;
      o.userData.paint = (o.userData.paint ?? 0) + 1;
    });
  }

  /** Applies the counts and switches of a state at once (the crane's pose eases in update). */
  function apply(b: Built, s: ConstructionState): void {
    b.state = s;
    current = s;
    b.columns.count = s.columns.shown;
    b.beams.count = s.beams.shown;
    b.decks.count = s.decks.shown;
    b.nets.count = s.nets;
    layFrame(b, s);
    b.load.visible = s.load;
    b.floods.visible = s.floods;
    b.sparks.visible = s.weldAt !== null;
    b.arc.visible = s.weldAt !== null;
    b.search.visible = s.searchlights;
    b.work.visible = s.workLamp;
    if (s.weldAt) {
      weldAt.set(...s.weldAt);
      b.sparkMat.uniforms.uAt.value.copy(weldAt);
      b.arcMat.uniforms.uAt.value.copy(weldAt);
    }
    if (!b.struck) layCrane(b, s);
    placeRopes(b);
    if (s.searchlights) aimSearch(b);
  }

  const zAxis = new THREE.Vector3(0, 0, 1);
  function aimSearch(b: Built): void {
    const aims = searchAims(clock, b.top, b.half, b.fh);
    aims.forEach((a, i) => b.heads[i].quaternion.setFromUnitVectors(zAxis, a.dir));
  }

  /** Takes the crane and the frame off a struck scar, so only its lamp is left for the city to draw. */
  function strikeOff(b: Built): void {
    for (const o of [b.crane, b.columns, b.beams, b.decks, b.nets, b.floods, b.sparks, b.arc, b.search]) object.remove(o);
    b.struck = true;
    structure++;
    revision++;
  }

  /** Shows the state the site's stage and clocks give now; true when what stands changed shape (the shadow map is redrawn). */
  function show(): boolean {
    if (!site || !roof) return false;
    const s = constructionState(site, roof.top, roof.half, roof.fh, clocks, before);
    current = s;
    if (gone(s)) {
      const had = built !== null;
      clear();
      return had;
    }
    if (!built) return false;
    const b = built;
    const shape = b.state.crane !== s.crane || b.state.strike !== s.strike || b.state.netDrop !== s.netDrop || b.state.dismantle !== s.dismantle;
    apply(b, s);
    revision++;
    if (s.workLamp && !s.crane && !b.struck) {
      strikeOff(b);
      return true;
    }
    return shape;
  }

  function placeRopes(b: Built): void {
    // From under the trolley's sheaves (just below the jib's bottom chords) to the top of the hook block.
    const from = 0.9 - 0.55;
    const to = b.hook.position.y + 0.5;
    const len = Math.max(0.05, from - to);
    b.ropes.position.set(b.trolley.position.x, from, 0);
    b.ropes.scale.set(1, len, 1);
  }

  function tickLamps(b: Built): void {
    let level = 1;
    if (b.state.lamp === 'blink') {
      // A medium-intensity obstruction light: thirty flashes a minute, each a soft half-second pulse.
      const u = (clock % 2) / 2;
      level = 0.05 + 0.95 * THREE.MathUtils.smoothstep(u, 0, 0.04) * (1 - THREE.MathUtils.smoothstep(u, 0.22, 0.3));
    }
    // The lamps are switched off before the crane comes down.
    if (b.state.dismantle > 0 || b.struck) level = 0;
    b.lampLevel = level;
    b.lampMat.color.copy(LAMP_RED).multiplyScalar(level);
  }

  /** The window the shadow map is last redrawn in during a transition, so it follows the strike in quarter seconds rather than every frame. */
  let shadowStep = -1;

  return {
    object,
    flickerPeak: FLICKER.peak,
    set(next, top, half, floorHeight, finish) {
      const key = `${top.toFixed(3)}|${half.toFixed(3)}|${floorHeight.toFixed(3)}`;
      const nextEra = finish?.era ?? era;
      // The same stage and progress over the same roof is no change: nothing is rebuilt, recopied or redrawn.
      if (next && site && built && built.key === key && next.runId === site.runId && next.stage === site.stage && next.progress === site.progress && nextEra === era) {
        site = next;
        return false;
      }
      const had = built !== null;
      const prev = site;
      site = next;
      if (!next) {
        clear();
        clocks = {};
        before = undefined;
        current = null;
        roof = null;
        era = null;
        return had;
      }
      // A new run on this site starts afresh; a site first seen part way through a transition shows it settled.
      const fresh = !prev || prev.runId !== next.runId;
      if (fresh) {
        clocks = {};
        before = undefined;
        era = null;
      }
      era = nextEra;
      const building = (st: SiteStage | undefined): boolean => st === 'crane' || st === 'framing' || st === 'inspecting';
      if (!fresh && prev && prev.stage !== next.stage) {
        // The verdict passed on a frame that stood here: the cure begins.
        if ((next.stage === 'curing' || next.stage === 'waiting') && clocks.cure === undefined && building(prev.stage)) clocks.cure = 0;
        // The crew strikes the site: what stood is what comes down.
        if ((next.stage === 'teardown' || next.stage === 'scar') && clocks.strike === undefined && current) {
          clocks.strike = 0;
          before = { columns: current.columns.shown, beams: current.beams.shown, decks: current.decks.shown, nets: current.nets, frameFade: current.frameFade, netDrop: current.netDrop, crane: current.crane !== null };
        }
        // A teardown that ends in a scar carries straight on.
        if (prev.stage === 'teardown' && next.stage === 'scar') clocks.strike ??= STRIKE_S;
      }
      // Merged: the windows light (and the crane comes down) once the cure is done.
      if (!fresh && next.stage === 'curing' && next.progress >= 1 && clocks.lit === undefined) clocks.lit = 0;
      roof = { top, half, fh: floorHeight };
      const state = constructionState(next, top, half, floorHeight, clocks, before);
      current = state;
      if (gone(state) || (!state.crane && !built && !state.workLamp)) {
        clear();
        return had;
      }
      if (!built || built.key !== key) {
        const keep = built && !built.struck ? { slew: built.slew.rotation.y, trolley: built.trolley.position.x, hook: built.hook.position.y } : null;
        clear();
        built = build(top, half, floorHeight, keep ? { ...state, ...keep } : state);
        built.key = key;
        structure++;
      }
      apply(built, state);
      if (state.workLamp && !state.crane && !built.struck) strikeOff(built);
      revision++;
      return true;
    },
    update(dt) {
      clock = (clock + dt) % WRAP;
      const was = live(clocks);
      for (const k of ['cure', 'lit', 'strike'] as const) if (clocks[k] !== undefined && Number.isFinite(clocks[k])) clocks[k]! += dt;
      let shaped = false;
      if (was) {
        shaped = show();
        // The shadow map follows a transition in quarter seconds, and once more when it settles.
        const step = live(clocks) ? Math.floor(((clocks.strike ?? 0) + (clocks.lit ?? 0) + (clocks.cure ?? 0)) * 4) : -2;
        if (shaped && step !== shadowStep) shadowStep = step;
        else shaped = step === -2 && shadowStep !== -2 ? ((shadowStep = -2), true) : false;
      }
      if (!built) return shaped;
      const b = built;
      const s = b.state;
      if (s.searchlights) aimSearch(b);
      let moved = false;
      if (!b.struck) {
        // The crane's pose eases toward where the last event put it (a slow slew, a quicker trolley, the hook between), then holds exactly.
        const slew = approachAngle(b.slew.rotation.y, s.slew, 0.9, dt, 1e-4);
        const trolley = approach(b.trolley.position.x, s.trolley, 1.3, dt, 2e-3);
        const hook = approach(b.hook.position.y, s.hook, 1.1, dt, 2e-3);
        moved = slew !== b.slew.rotation.y || trolley !== b.trolley.position.x || hook !== b.hook.position.y;
        if (moved) {
          b.slew.rotation.y = slew;
          b.trolley.position.x = trolley;
          b.hook.position.set(trolley, hook, 0);
          placeRopes(b);
          revision++;
        }
      }
      b.sparkMat.uniforms.uTime.value = clock;
      arcLevelNow = s.weldAt ? arcLevel(clock) : 0;
      b.arcMat.uniforms.uArc.value = arcLevelNow;
      tickLamps(b);
      return moved || shaped;
    },
    weld() {
      if (!built || !built.state.weldAt || !site) return null;
      return { at: weldAt.clone(), intensity: arcLevelNow * FLICKER.peak };
    },
    get revision() {
      return revision;
    },
    get structure() {
      return structure;
    },
    lampLevel: () => built?.lampLevel ?? 0,
    roof: () => (built ? { top: built.top, half: built.half, floorHeight: built.fh } : null),
    sparks() {
      if (!built || !built.state.weldAt) return null;
      return { at: weldAt.clone(), deck: built.top, half: built.half, time: clock };
    },
    floods() {
      if (!built || !built.state.floods) return [];
      return (built.floods.userData.at as THREE.Vector3[]).map((p) => p.clone());
    },
    searchlights() {
      if (!built || !built.state.searchlights) return [];
      return searchAims(clock, built.top, built.half, built.fh);
    },
    workLamp() {
      if (!built || !built.state.workLamp) return null;
      return { at: (built.work.userData.at as THREE.Vector3).clone(), light: (built.work.userData.light as THREE.Vector3).clone(), intensity: WORK_LAMP.peak };
    },
    finish() {
      if (!site || !current) return null;
      return { floor: current.floor, era, tone: tint().clone(), windows: current.windows };
    },
    state: () => current,
    busy: () => live(clocks),
    touch() {
      revision++;
    },
    dispose() {
      clear();
      site = null;
      clocks = {};
      before = undefined;
      current = null;
    },
  };
}

// ---------------------------------------------------------------- the city's field: every site in a few draws

/** Which drawn kind a site part belongs to, by its material's name. */
const STEEL_KINDS = new Set(['yellow', 'dark', 'ballast', 'glass', 'primer', 'deck', 'rope']);
const LAMP_KINDS = new Set(['lamp', 'flood', 'search', 'work']);

export const GLARE_VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iColor;
  attribute vec3 iSize;
  uniform float uPixel;
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vSoft;
  void main() {
    vQuad = position.xy;
    vSoft = iSize.z;
    vec4 c = viewMatrix * vec4(iPos, 1.0);
    // A haze is lit air seen from afar: close to the site (or inside it) it fades out, or it would veil the whole view.
    float far = -c.z;
    vColor = iColor * mix(1.0, smoothstep(iSize.x * 3.0, iSize.x * 9.0, far), iSize.z);
    // A world size, but never under a few pixels: from across the city a lamp still reads as a lamp.
    float size = max(iSize.x, -c.z * uPixel * iSize.y);
    c.xy += position.xy * size;
    c.xyz *= 1.0 - 0.6 / max(1.0, length(c.xyz));
    gl_Position = projectionMatrix * c;
  }
`;

export const GLARE_FRAG = /* glsl */ `
  varying vec2 vQuad;
  varying vec3 vColor;
  varying float vSoft;
  void main() {
    float r = length(vQuad);
    float core = exp(-r * r * 26.0);
    float glow = exp(-r * 5.5) * 0.18;
    // A soft haze (vSoft 1): the warm air over a lit deck, no hot core, faded to nothing at the quad's edge.
    float haze = exp(-r * r * 3.2) * (1.0 - smoothstep(0.75, 1.0, r));
    float a = mix(core + glow, haze, vSoft);
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

/** How much of the budget's peak the floods use: lit steel by the heads keeps contrast, well under the threshold. */
const FLOOD_GAIN = 0.55;
/** Inside this the floods' light is held level (a head's lens is not a point); past the window it is gone. */
const FLOOD_NEAR = 3;
const FLOOD_WINDOW: [number, number] = [6, 14];
/**
 * The floods' colour on the steel: sodium-warm, mixed with white so it warms
 * the paint without repainting it (primer stays red, the crane stays yellow).
 */
export const FLOOD_TINT = new THREE.Color(1, 1, 1).lerp(new THREE.Color(FLOOD.color), 0.6);

/**
 * How bright steel of `albedo` looks `d` metres from a flood head, after
 * exposure: the shader's flood term in JS. Inverse square, held level inside
 * three metres and windowed away steeply past six, so a flood lights its
 * deck and the frame round it and leaves the rest of the site night steel.
 * At its brightest it is about half the budget (post.ts FLOOD).
 */
export function floodRadiance(d: number, albedo: number): number {
  const window = 1 - THREE.MathUtils.smoothstep(d, FLOOD_WINDOW[0], FLOOD_WINDOW[1]);
  return ((FLOOD_GAIN * FLOOD.peak) / Math.max(d, FLOOD_NEAR) ** 2) * window * (albedo / Math.PI) * EXPOSURE;
}

/** The arc's glare colour at full burn, and the floodlights' (a warm sodium white). */
const ARC_GLARE = new THREE.Color(10.9, 12.3, 14);
const FLOOD_GLARE = new THREE.Color(FLOOD.color).multiplyScalar(5.2);
/**
 * The haze over a lit deck and down its top floors: additive and soft, its
 * brightest pixel well under the bloom threshold so it reads as lit air, not
 * as a lamp.
 */
const DECK_HAZE = new THREE.Color(FLOOD.color).multiplyScalar(0.52);
const FLOOR_HAZE = new THREE.Color(FLOOD.color).multiplyScalar(0.26);
const MAX_FLOODS = MAX_SITES * 2;
/** The searchlights' lenses from in front, and the work lamp's, as glare; and the warm air round the work lamp. */
const SEARCH_GLARE = new THREE.Color(1, 0.97, 0.92).multiplyScalar(9);
const WORK_GLARE = new THREE.Color(WORK_LAMP.color).multiplyScalar(3.2);
const WORK_HAZE = new THREE.Color(WORK_LAMP.color).multiplyScalar(0.62);
const SEARCH_HIT = new THREE.Color(1, 0.97, 0.92).multiplyScalar(0.24);

/**
 * A searchlight's beam through the dusk haze, as an open cone from the lens
 * to where it meets the floor. What the eye sees is light scattered off the
 * haze along the beam: strongest where the eye looks through the beam's
 * middle (the cone's surface faces the eye), soft at its edges, fading as
 * the beam spreads (its light shared over a wider section) and as the haze
 * between the beam and the eye swallows it, with the slow grain of the air
 * in it. Close to the eye it fades out, so a camera inside a beam is never
 * veiled. Additive and well under the bloom threshold: only the lens blooms.
 */
const BEAM_VERT = /* glsl */ `
  attribute vec3 iFrom;
  attribute vec3 iDir;
  attribute vec4 iShape;
  uniform float uPixel;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vAxis;
  varying float vT;
  varying float vLevel;
  varying float vSpread;
  void main() {
    // position.x: the angle round the beam (0 to 1), position.y: how far along it (0 to 1).
    float len = iShape.x;
    float rTrue = mix(iShape.y, iShape.z, position.y);
    // Never under about a pixel and a half wide, with its light kept: from across the city a beam is still a line.
    vec3 centre = iFrom + iDir * (len * position.y);
    float px = distance(centre, cameraPosition) * uPixel;
    float r = max(rTrue, px * 0.8);
    vec3 up = abs(iDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 u = normalize(cross(iDir, up));
    vec3 w = cross(iDir, u);
    float a = position.x * 6.2831853;
    vec3 radial = u * cos(a) + w * sin(a);
    vec3 p = iFrom + iDir * (len * position.y) + radial * r;
    vWorld = p;
    vNormal = radial;
    vAxis = iDir;
    vT = position.y;
    vLevel = iShape.w * rTrue / r;
    vSpread = iShape.y / rTrue;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFog;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vAxis;
  varying float vT;
  varying float vLevel;
  varying float vSpread;
  float bh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float bnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(bh(i), bh(i + vec3(1, 0, 0)), f.x), mix(bh(i + vec3(0, 1, 0)), bh(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(bh(i + vec3(0, 0, 1)), bh(i + vec3(1, 0, 1)), f.x), mix(bh(i + vec3(0, 1, 1)), bh(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    // The eye's ray crosses the beam on a chord: longest through its middle, nothing at its silhouette, and longer
    // the more nearly the eye looks along the beam (held at five times side-on). Each of the two faces carries half.
    vec3 Vp = V - normalize(vAxis) * dot(V, normalize(vAxis));
    float sp = max(length(Vp), 0.2);
    float core = abs(dot(normalize(vNormal), Vp)) / (sp * sp);
    // The light spreads as the beam widens (the haze's forward scatter keeps the far beam brighter than spread alone);
    // the eye's own haze swallows a far beam; near the eye it fades out.
    float spread = pow(vSpread, 0.6);
    float haze = exp(-pow(uFog * dist, 2.0));
    float nearEye = smoothstep(5.0, 30.0, dist);
    float ends = smoothstep(0.0, 0.012, vT) * (1.0 - smoothstep(0.975, 1.0, vT));
    // The grain of the air the beam passes through.
    float grain = 0.72 + 0.56 * bnoise(vWorld * 0.11);
    float a = core * spread * haze * nearEye * ends * grain * vLevel;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

/**
 * The city's steel, lit by the sites' floodlights. The floods light only the
 * construction itself (the frame, the deck, the crane's mast and the netting),
 * by a term added after three's own lights, so they cost nothing anywhere
 * else in the city. A little grime, by world position, keeps the paint from
 * reading as fresh plastic. Radiance stays under the bloom threshold
 * (post.ts FLOOD).
 */
interface FieldLights {
  pos: { value: THREE.Vector3[] };
  count: { value: number };
  color: { value: THREE.Color };
}

function floodLit<T extends THREE.MeshStandardMaterial>(m: T, floods: FieldLights, grime: boolean): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFloodPos = floods.pos;
    shader.uniforms.uFloodCount = floods.count;
    shader.uniforms.uFloodColor = floods.color;
    Object.assign(shader.uniforms, SEARCH_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFieldWorld;\nattribute vec2 aWear;\nvarying vec2 vWear;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vWear = aWear;
        vec4 fw = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          fw = batchingMatrix * fw;
        #endif
        vFieldWorld = (modelMatrix * fw).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFieldWorld;
        varying vec2 vWear;
        uniform vec3 uFloodPos[${MAX_FLOODS}];
        uniform int uFloodCount;
        uniform vec3 uFloodColor;
        ${SEARCH_PARS}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fieldRust = 0.0;
        ${
          grime
            ? `{
          vec3 q = floor(vFieldWorld * 2.7);
          float g = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float streak = fract(sin(dot(floor(vFieldWorld.xz * 9.0), vec2(41.3, 17.9))) * 9631.7);
          diffuseColor.rgb *= 0.84 + 0.12 * g + 0.04 * streak;
          // The member's own heat of paint.
          diffuseColor.rgb *= 0.88 + 0.24 * vWear.x;
          // Rust weeps down from the joints: thin runs in lanes, strongest just under each joint, on the worn members.
          vec2 cell = floor(vFieldWorld.xz * 14.0);
          float lane = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
          float run = fract(vFieldWorld.y / 2.4 + lane * 0.37);
          fieldRust = step(0.8, lane) * pow(1.0 - run, 2.5) * (0.35 + vWear.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.075, 0.03), clamp(fieldRust, 0.0, 0.75));
        }`
            : ''
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        ${grime ? 'roughnessFactor = clamp(roughnessFactor + (vWear.y - 0.3) * 0.5 + fieldRust * 0.25, 0.25, 0.97);' : ''}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        for (int i = 0; i < ${MAX_FLOODS}; i++) {
          if (i >= uFloodCount) break;
          vec3 L = uFloodPos[i] - geometryPosition;
          float d2 = max(dot(L, L), 1.0);
          float d = sqrt(d2);
          L /= d;
          float reach = 1.0 - smoothstep(${FLOOD_WINDOW[0].toFixed(1)}, ${FLOOD_WINDOW[1].toFixed(1)}, d);
          float nl = max(dot(geometryNormal, L), 0.0);
          // A thin cloth or a beam seen from behind still glows a little with the light through it.
          nl = max(nl, 0.18 * max(dot(-geometryNormal, L), 0.0));
          // Inverse square, held level inside three metres and windowed away past six (floodRadiance).
          float near = max(d, ${FLOOD_NEAR.toFixed(1)});
          reflectedLight.directDiffuse += uFloodColor * (nl * reach / (near * near)) * BRDF_Lambert(material.diffuseColor);
        }
        // The inspection's searchlights (searchlight.ts), shared with the towers they sweep.
        ${SEARCH_LIGHT}`,
      );
  };
  m.customProgramCacheKey = () => `construction-flood-${grime ? 1 : 0}`;
  // It carries the searchlight term itself: the city's pass over its materials leaves it alone.
  m.userData.searchLit = true;
  return m;
}

export interface ConstructionField {
  /** Every site's parts, drawn: a handful of batches whatever the number of sites. */
  group: THREE.Group;
  /** Draws these sites (their own objects stay out of the scene: they are the record the batches copy); `eye` turns the searchlights' lens glare to the camera. */
  update(sites: ReadonlyArray<Construction>, eye?: THREE.Vector3): void;
  /** Meshes the field draws with, for budgets (tests). */
  draws(): number;
  dispose(): void;
}

interface Mirror {
  src: THREE.Mesh;
  batch: THREE.BatchedMesh;
  ids: number[];
  /** The source's own instances (an InstancedMesh), or one. */
  instanced: boolean;
  color: THREE.Color;
  /** Each instance's own paint (a different mill, a different coat), before any cure tint or fade. */
  base: THREE.Color[];
  /** The source's paint revision last uploaded. */
  paint: number;
}

/**
 * Draws every job site in the city with a fixed number of draw calls: one
 * batch for all the steel (crane, frame, deck, ropes: each part keeps its
 * paint as an instance colour), one for the netting, one for the lamps and
 * flood lenses, one for every site's sparks and one for the glare of arcs and
 * floods. Each site's own object is the record: the field copies its parts'
 * world matrices into the batches when the site changes (an event, or the
 * crane easing after one) and rebuilds the batches only when a site's parts
 * are built or taken down. Between events nothing is copied; only the spark
 * clocks, the arcs, the lamps and the glare change, which are uniforms and a
 * few dozen instance values.
 */
export function makeConstructionField(quality: 'high' | 'medium'): ConstructionField {
  const group = new THREE.Group();
  group.name = 'construction-field';
  const sparkCount = quality === 'high' ? 720 : 300;
  const floods: FieldLights = {
    pos: { value: Array.from({ length: MAX_FLOODS }, () => new THREE.Vector3()) },
    count: { value: 0 },
    color: { value: FLOOD_TINT.clone().multiplyScalar(FLOOD_GAIN * FLOOD.peak) },
  };
  // Pieces go whole (the cure, the strike): an instance's alpha is 1 or 0, and 0 hides it, so the steel stays opaque.
  const steelMat = floodLit(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.66, metalness: 0.35 }), floods, true);
  const net = netTextures();
  // White: each panel's own green comes in as its instance colour.
  const netMat = floodLit(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: net.map, alphaMap: net.alpha, transparent: true, depthWrite: false, side: THREE.DoubleSide }), floods, false);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });

  // Every site's sparks in one draw.
  const sparkGeo = sparkQuad(sparkCount, MAX_SITES);
  const sparkMat = new THREE.ShaderMaterial({
    vertexShader: sparkVert(true),
    fragmentShader: SPARK_FRAG,
    uniforms: {
      uSiteA: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) },
      uSiteB: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) },
      uPixel: { value: 0.001 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const sparks = new THREE.Mesh(sparkGeo, sparkMat);
  sparks.name = 'field:sparks';
  sparks.frustumCulled = false;
  sparks.renderOrder = 2;
  sparks.onBeforeRender = (renderer, _s, camera) => {
    sparkMat.uniforms.uPixel.value = pixelScale(renderer, camera);
  };

  // The glare of every arc and floodlight in one draw.
  const GLARES = MAX_SITES * 9;
  const glareGeo = new THREE.InstancedBufferGeometry();
  glareGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  glareGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const gPos = new THREE.InstancedBufferAttribute(new Float32Array(GLARES * 3), 3);
  const gColor = new THREE.InstancedBufferAttribute(new Float32Array(GLARES * 3), 3);
  const gSize = new THREE.InstancedBufferAttribute(new Float32Array(GLARES * 3), 3);
  for (const a of [gPos, gColor, gSize]) a.setUsage(THREE.DynamicDrawUsage);
  glareGeo.setAttribute('iPos', gPos);
  glareGeo.setAttribute('iColor', gColor);
  glareGeo.setAttribute('iSize', gSize);
  glareGeo.instanceCount = 0;
  const glareMat = new THREE.ShaderMaterial({
    vertexShader: GLARE_VERT,
    fragmentShader: GLARE_FRAG,
    uniforms: { uPixel: { value: 0.001 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glare = new THREE.Mesh(glareGeo, glareMat);
  glare.name = 'field:glare';
  glare.frustumCulled = false;
  glare.renderOrder = 3;
  glare.onBeforeRender = (renderer, _s, camera) => {
    glareMat.uniforms.uPixel.value = pixelScale(renderer, camera);
  };

  // Every site's searchlight beams in one draw: a cone of 24 sides in 24 rings along the beam.
  const beamGeo = new THREE.InstancedBufferGeometry();
  {
    const SIDES = 24;
    const RINGS = 24;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= RINGS; j++) for (let i = 0; i <= SIDES; i++) pos.push(i / SIDES, (j / RINGS) ** 1.6, 0);
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SIDES; i++) {
        const a = j * (SIDES + 1) + i;
        const b = a + SIDES + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    beamGeo.setIndex(idx);
  }
  const bFrom = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEARCH * 3), 3);
  const bDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEARCH * 3), 3);
  const bShape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEARCH * 4), 4);
  for (const a of [bFrom, bDir, bShape]) a.setUsage(THREE.DynamicDrawUsage);
  beamGeo.setAttribute('iFrom', bFrom);
  beamGeo.setAttribute('iDir', bDir);
  beamGeo.setAttribute('iShape', bShape);
  beamGeo.instanceCount = 0;
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: { uColor: { value: SEARCH.color.clone().multiplyScalar(0.3) }, uFog: { value: 0 }, uPixel: { value: 0.001 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const beams = new THREE.Mesh(beamGeo, beamMat);
  beams.name = 'field:beams';
  beams.frustumCulled = false;
  beams.renderOrder = 2;
  beams.visible = false;
  beams.onBeforeRender = (renderer, scene, camera) => {
    beamMat.uniforms.uFog.value = (scene.fog as THREE.FogExp2 | null)?.density ?? 0;
    beamMat.uniforms.uPixel.value = pixelScale(renderer, camera);
  };

  // The steel's flood and searchlight terms are in view space: the lights follow the camera each frame.
  const floodWorld: THREE.Vector3[] = [];
  const searchWorld: Array<{ at: THREE.Vector3; dir: THREE.Vector3; cone: THREE.Vector4 }> = [];
  const toView = (camera: THREE.Camera): void => {
    floods.count.value = Math.min(MAX_FLOODS, floodWorld.length);
    for (let i = 0; i < floods.count.value; i++) floods.pos.value[i].copy(floodWorld[i]).applyMatrix4(camera.matrixWorldInverse);
  };

  let batches: { steel: THREE.BatchedMesh | null; net: THREE.BatchedMesh | null; lamp: THREE.BatchedMesh | null } = { steel: null, net: null, lamp: null };
  let mirrors: Mirror[] = [];
  /** Parts that move every frame without an event (the searchlight heads sweeping): copied each frame, nothing else is. */
  let live: Mirror[] = [];
  let bySite = new Map<Construction, { mirrors: Mirror[]; revision: number; structure: number; lamp: number }>();
  const geoCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();

  const jitter = new THREE.Color();
  /** A copy with only position, normal, uv and wear, never indexed: every geometry a batch holds must agree. */
  function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
    let c = geoCache.get(g);
    if (c) return c;
    c = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'aWear') c.deleteAttribute(k);
    const count = c.attributes.position.count;
    if (!c.attributes.uv) c.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (!c.attributes.aWear) c.setAttribute('aWear', new THREE.Float32BufferAttribute(new Float32Array(count * 2).fill(0.4), 2));
    c.clearGroups();
    geoCache.set(g, c);
    return c;
  }

  function clearBatches(): void {
    for (const b of Object.values(batches)) {
      if (!b) continue;
      group.remove(b);
      b.dispose();
    }
    batches = { steel: null, net: null, lamp: null };
    for (const g of geoCache.values()) g.dispose();
    geoCache.clear();
    mirrors = [];
    live = [];
    bySite = new Map();
  }

  function kindOf(m: THREE.Mesh): 'steel' | 'net' | 'lamp' | null {
    const name = (m.material as THREE.Material).name;
    if (STEEL_KINDS.has(name)) return 'steel';
    if (name === 'net') return 'net';
    if (LAMP_KINDS.has(name)) return 'lamp';
    return null;
  }

  /** Builds the batches afresh from every site's parts. */
  function rebuild(sites: ReadonlyArray<Construction>): void {
    clearBatches();
    const parts: Array<{ site: Construction; mesh: THREE.Mesh; kind: 'steel' | 'net' | 'lamp' }> = [];
    for (const site of sites) {
      site.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const kind = kindOf(m);
        if (kind) parts.push({ site, mesh: m, kind });
      });
    }
    const size = { steel: { v: 0, n: 0 }, net: { v: 0, n: 0 }, lamp: { v: 0, n: 0 } };
    const seen = new Set<THREE.BufferGeometry>();
    for (const p of parts) {
      const g = plain(p.mesh.geometry);
      if (!seen.has(g)) {
        seen.add(g);
        size[p.kind].v += g.attributes.position.count;
      }
      size[p.kind].n += (p.mesh as THREE.InstancedMesh).isInstancedMesh ? (p.mesh as THREE.InstancedMesh).instanceMatrix.count : 1;
    }
    const make = (kind: 'steel' | 'net' | 'lamp', mat: THREE.Material): THREE.BatchedMesh | null => {
      if (size[kind].n === 0) return null;
      const b = new THREE.BatchedMesh(size[kind].n, size[kind].v, 0, mat);
      b.name = `field:${kind}`;
      b.frustumCulled = false;
      b.sortObjects = kind === 'net';
      b.castShadow = kind === 'steel';
      b.receiveShadow = kind !== 'lamp';
      group.add(b);
      return b;
    };
    batches = { steel: make('steel', steelMat), net: make('net', netMat), lamp: make('lamp', lampMat) };
    // BatchedMesh lays out its draw list in its own onBeforeRender: keep it, and move the floods into view space first.
    for (const b of [batches.steel, batches.net]) {
      if (!b) continue;
      const own = b.onBeforeRender.bind(b);
      b.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        toView(camera);
        own(renderer, scene, camera, geometry, material, group);
      };
    }
    const geoIds = new Map<THREE.BatchedMesh, Map<THREE.BufferGeometry, number>>();
    for (const p of parts) {
      const batch = batches[p.kind]!;
      let ids = geoIds.get(batch);
      if (!ids) geoIds.set(batch, (ids = new Map()));
      const g = plain(p.mesh.geometry);
      let gid = ids.get(g);
      if (gid === undefined) {
        gid = batch.addGeometry(g);
        ids.set(g, gid);
      }
      const inst = (p.mesh as THREE.InstancedMesh).isInstancedMesh;
      const n = inst ? (p.mesh as THREE.InstancedMesh).instanceMatrix.count : 1;
      const mirror: Mirror = { src: p.mesh, batch, ids: [], instanced: inst, color: (p.mesh.material as THREE.MeshStandardMaterial).color.clone(), base: [], paint: -1 };
      for (let i = 0; i < n; i++) {
        const id = batch.addInstance(gid);
        // Instanced steel (columns, beams, deck sheets) varies piece by piece: a different mill, a different coat.
        if (inst && p.kind === 'steel') {
          const h = hash01(i * 7919 + n * 104729);
          const k = hash01(i * 3571 + 17);
          jitter.copy(mirror.color).multiplyScalar(0.84 + 0.3 * h).offsetHSL((k - 0.5) * 0.025, (k - 0.5) * 0.12, 0);
        } else jitter.copy(mirror.color);
        mirror.base.push(jitter.clone());
        batch.setColorAt(id, jitter);
        mirror.ids.push(id);
      }
      if (p.mesh.userData.live) live.push(mirror);
      mirrors.push(mirror);
      let entry = bySite.get(p.site);
      if (!entry) bySite.set(p.site, (entry = { mirrors: [], revision: -1, structure: p.site.structure, lamp: -1 }));
      entry.mirrors.push(mirror);
    }
    for (const site of sites) if (!bySite.has(site)) bySite.set(site, { mirrors: [], revision: -1, structure: site.structure, lamp: -1 });
  }

  const m4 = new THREE.Matrix4();
  const m5 = new THREE.Matrix4();
  /** Whether a part and every group above it, up to its site, is shown. */
  const shown = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  const paintTo = new THREE.Vector4();
  const tinted = new THREE.Color();
  /** The alpha a source gives instance `i`: its own fade (the cure, the strike), 1 when it has none. */
  const alphaOf = (src: THREE.Object3D, i: number): number => {
    const f = src.userData.fade as Float32Array | number | undefined;
    return f === undefined ? 1 : typeof f === 'number' ? f : (f[i] ?? 1);
  };
  /** Uploads a part's paint: each instance's own colour turned toward the cure's tone, with its fade as alpha. */
  function paint(mi: Mirror): void {
    const t = mi.src.userData.tint as { color: THREE.Color; k: number } | undefined;
    mi.ids.forEach((id, i) => {
      tinted.copy(mi.base[i]);
      if (t && t.k > 0) tinted.lerp(t.color, t.k);
      mi.batch.setColorAt(id, paintTo.set(tinted.r, tinted.g, tinted.b, alphaOf(mi.src, i)));
    });
    mi.paint = mi.src.userData.paint as number;
  }
  function copy(site: Construction, mirrorsOf: Mirror[]): void {
    site.object.updateMatrixWorld(true);
    for (const mi of mirrorsOf) {
      const on = shown(mi.src);
      if (mi.src.userData.paint !== undefined && mi.src.userData.paint !== mi.paint) paint(mi);
      if (mi.instanced) {
        const im = mi.src as THREE.InstancedMesh;
        mi.ids.forEach((id, i) => {
          const visible = on && i < im.count && alphaOf(im, i) > 0.003;
          mi.batch.setVisibleAt(id, visible);
          if (!visible) return;
          im.getMatrixAt(i, m4);
          mi.batch.setMatrixAt(id, m5.multiplyMatrices(im.matrixWorld, m4));
        });
      } else {
        const visible = on && alphaOf(mi.src, 0) > 0.003;
        mi.batch.setVisibleAt(mi.ids[0], visible);
        if (visible) mi.batch.setMatrixAt(mi.ids[0], mi.src.matrixWorld);
      }
    }
  }

  const col = new THREE.Color();
  const tmp = new THREE.Vector3();
  return {
    group,
    update(sites, eye) {
      const list = sites.slice(0, MAX_SITES);
      // A site built, rebuilt or taken down, or the set of sites changed: the batches are laid out again.
      const changed = list.length !== bySite.size || list.some((s) => bySite.get(s)?.structure !== s.structure);
      if (changed) rebuild(list);
      for (const s of list) {
        const e = bySite.get(s)!;
        if (e.revision !== s.revision) {
          copy(s, e.mirrors);
          e.revision = s.revision;
        }
        // The aviation lamps flash: their instance colours follow the site's lamp level.
        const level = s.lampLevel();
        if (level === e.lamp) continue;
        e.lamp = level;
        for (const mi of e.mirrors) {
          if ((mi.src.material as THREE.Material).name !== 'lamp') continue;
          col.copy(mi.color).setRGB(LAMP_RED.r * level, LAMP_RED.g * level, LAMP_RED.b * level);
          for (const id of mi.ids) mi.batch.setColorAt(id, col);
        }
      }
      // The searchlight heads sweep without an event: only they are copied each frame.
      for (const mi of live) {
        const on = shown(mi.src);
        mi.batch.setVisibleAt(mi.ids[0], on);
        if (!on) continue;
        mi.src.updateWorldMatrix(true, false);
        mi.batch.setMatrixAt(mi.ids[0], mi.src.matrixWorld);
      }
      // Sparks, glare and the floods' light, per site.
      floodWorld.length = 0;
      searchWorld.length = 0;
      let nb = 0;
      let g = 0;
      const put = (p: THREE.Vector3, c: THREE.Color, size: number, px: number, soft = 0): void => {
        if (g >= GLARES) return;
        gPos.setXYZ(g, p.x, p.y, p.z);
        gColor.setXYZ(g, c.r, c.g, c.b);
        gSize.setXYZ(g, size, px, soft);
        g++;
      };
      list.forEach((s, i) => {
        const at = s.object.position;
        const sp = s.sparks();
        const a = sparkMat.uniforms.uSiteA.value[i] as THREE.Vector4;
        const b = sparkMat.uniforms.uSiteB.value[i] as THREE.Vector4;
        if (sp) {
          a.set(sp.at.x + at.x, sp.at.y + at.y, sp.at.z + at.z, sp.time);
          b.set(at.x, at.z, sp.deck + at.y, sp.half);
          const w = s.weld();
          if (w && w.intensity > 0) put(new THREE.Vector3(a.x, a.y, a.z), col.copy(ARC_GLARE).multiplyScalar(w.intensity / FLICKER.peak), 0.35, 3);
        } else b.set(0, 0, 0, 0);
        for (const f of s.floods()) {
          const p = f.add(at);
          floodWorld.push(p);
          put(p, FLOOD_GLARE, 1.1, 8);
        }
        // Lit night construction from across the city: a warm haze over the working deck and down the top floors.
        const roof = s.roof();
        if (roof && s.floods().length > 0) {
          put(new THREE.Vector3(at.x, roof.top + roof.floorHeight * 0.7, at.z), DECK_HAZE, roof.half * 1.8, 28, 1);
          put(new THREE.Vector3(at.x, roof.top - roof.floorHeight * 1.5, at.z), FLOOR_HAZE, roof.half * 1.6, 20, 1);
        }
        // The inspection's searchlights: the beams, their spots on the steel, and the lens's glare seen from in front.
        for (const l of s.searchlights()) {
          if (nb >= MAX_SEARCH) break;
          const from = l.at.clone().add(at);
          bFrom.setXYZ(nb, from.x, from.y, from.z);
          bDir.setXYZ(nb, l.dir.x, l.dir.y, l.dir.z);
          bShape.setXYZW(nb, l.length, l.r0, l.r1, 1);
          nb++;
          const half = Math.atan(l.r1 / l.length);
          searchWorld.push({ at: from, dir: l.dir.clone(), cone: new THREE.Vector4(Math.cos(half), Math.cos(half * 0.7), searchThrow(l.length), l.length) });
          const facing = eye ? Math.max(0, l.dir.dot(tmp.copy(eye).sub(from).normalize())) : 1;
          if (facing > 0.02) put(from.clone().addScaledVector(l.dir, 0.05), col.copy(SEARCH_GLARE).multiplyScalar(facing ** 3), 0.5, 5);
          // Where the beam meets the floor the haze round the spot is lit too: from across the city the floor reads as lit.
          put(from.clone().addScaledVector(l.dir, l.length - 0.6), SEARCH_HIT, l.r1 * 1.5, 12, 1);
        }
        // The scar's work lamp: its lens and the warm air round it.
        const wl = s.workLamp();
        if (wl) {
          // Sized for the distance: a lamp's core never under eight pixels, and the warm air round it a soft bloom whose
          // visible glow is never under about sixteen pixels across, so it reads from home; it fades out as the camera
          // comes close (the haze shader's near fade).
          put(wl.at.clone().add(at), WORK_GLARE, 0.3, 8);
          put(wl.light.clone().add(at), WORK_HAZE, 3.2, 20, 1);
        }
      });
      // The lamps, in world space, for every material the searchlights light (searchlight.ts).
      SEARCH_UNIFORMS.uSearchCount.value = Math.min(MAX_SEARCH, searchWorld.length);
      searchWorld.slice(0, MAX_SEARCH).forEach((w, i) => {
        SEARCH_UNIFORMS.uSearchPosW.value[i].copy(w.at);
        SEARCH_UNIFORMS.uSearchDirW.value[i].copy(w.dir);
        SEARCH_UNIFORMS.uSearchCone.value[i].copy(w.cone);
      });
      beamGeo.instanceCount = nb;
      bFrom.needsUpdate = bDir.needsUpdate = bShape.needsUpdate = true;
      beams.visible = nb > 0;
      for (let i = list.length; i < MAX_SITES; i++) (sparkMat.uniforms.uSiteB.value[i] as THREE.Vector4).set(0, 0, 0, 0);
      glareGeo.instanceCount = g;
      gPos.needsUpdate = gColor.needsUpdate = gSize.needsUpdate = true;
      sparkGeo.instanceCount = sparkCount * list.length;
      sparks.visible = list.some((s) => s.sparks() !== null);
      glare.visible = g > 0;
      if (sparks.parent !== group) group.add(sparks, glare, beams);
    },
    draws() {
      let n = 0;
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.visible) n++;
      });
      return n;
    },
    dispose() {
      clearBatches();
      steelMat.dispose();
      netMat.dispose();
      net.map.dispose();
      net.alpha.dispose();
      lampMat.dispose();
      sparkGeo.dispose();
      sparkMat.dispose();
      glareGeo.dispose();
      glareMat.dispose();
      beamGeo.dispose();
      beamMat.dispose();
      group.clear();
    },
  };
}

// ---------------------------------------------------------------- the hoist

export interface Hoist {
  object: THREE.Group;
  height: number;
  /** Puts the car's floor at `y` metres up the mast (clamped to the mast). */
  setCar(y: number): void;
  dispose(): void;
}

/** Mast section of a rack-and-pinion hoist: 0.65 m square, 1.508 m tall. */
const HOIST_SECTION = 1.508;

/**
 * A construction hoist: a galvanised rack-and-pinion mast from the ground to
 * `height`, its rack on the car side, and a cage car riding it (Task 35 rides
 * it). The mast stands at the origin; the car hangs off its +x face.
 */
export function makeHoist(height: number): Hoist {
  const object = new THREE.Group();
  object.name = 'hoist';
  const galv = new THREE.MeshStandardMaterial({ color: 0x9a9fa3, roughness: 0.5, metalness: 0.85 });
  const cage = new THREE.MeshStandardMaterial({ color: 0x5f6468, roughness: 0.6, metalness: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: CRANE_YELLOW, roughness: 0.55, metalness: 0.25 });
  const mast = new Parts();
  latticeY(mast, height, 0.65, HOIST_SECTION, 0.076, 0.03);
  // The rack: a toothed bar on the car side, drawn as a flat bar.
  mast.box(0.36, height / 2, 0, 0.05, height, 0.08);
  const mastMesh = new THREE.Mesh(mast.build(), galv);
  mastMesh.name = 'hoist:mast';
  mastMesh.castShadow = true;
  mastMesh.receiveShadow = true;
  object.add(mastMesh);

  const car = new THREE.Group();
  car.name = 'hoist:car';
  const W = 1.5;
  const D = 3.2;
  const Hc = 2.4;
  const frame = new Parts();
  for (const [x, z] of [
    [0.45, -D / 2],
    [0.45 + W, -D / 2],
    [0.45 + W, D / 2],
    [0.45, D / 2],
  ] as Array<[number, number]>) frame.bar(v(x, 0, z), v(x, Hc, z), 0.08);
  frame.box(0.45 + W / 2, 0.06, 0, W, 0.12, D);
  frame.box(0.45 + W / 2, Hc, 0, W + 0.08, 0.08, D + 0.08);
  const panels = new Parts();
  // Mesh panels on the long sides, a solid kick plate below them.
  for (const z of [-D / 2, D / 2]) panels.box(0.45 + W / 2, Hc / 2 + 0.25, z, W - 0.1, Hc - 0.6, 0.03);
  panels.box(0.45 + W, Hc / 2 + 0.25, 0, 0.03, Hc - 0.6, D - 0.1);
  const trimP = new Parts();
  for (const z of [-D / 2, D / 2]) trimP.box(0.45 + W / 2, 0.3, z, W, 0.45, 0.05);
  trimP.box(0.45 + W, 0.3, 0, 0.05, 0.45, D);
  // The drive unit on top of the car, on the mast side.
  trimP.box(0.6, Hc + 0.45, 0, 0.5, 0.8, 1.0);
  const meshes: Array<[Parts, THREE.Material, string]> = [
    [frame, galv, 'hoist:car-frame'],
    [panels, cage, 'hoist:car-panels'],
    [trimP, trim, 'hoist:car-trim'],
  ];
  for (const [p, m, name] of meshes) {
    const mm = new THREE.Mesh(p.build(), m);
    mm.name = name;
    mm.castShadow = true;
    mm.receiveShadow = true;
    car.add(mm);
  }
  object.add(car);
  const top = Math.max(0, height - Hc);
  return {
    object,
    height,
    setCar(y) {
      car.position.y = Math.min(top, Math.max(0, y));
    },
    dispose() {
      object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      galv.dispose();
      cage.dispose();
      trim.dispose();
      object.clear();
    },
  };
}
