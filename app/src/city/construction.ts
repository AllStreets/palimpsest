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
 * - `inspecting`, `curing`, `waiting`: the frame complete and the crane
 *   parked (Task 27 adds the searchlights, the cure and the scar).
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

import type { SiteStage, SiteState } from '../../../shared/types.js';
import { FLICKER } from './post.js';

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
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** The jib's angle so that it points from the mast at a plan point. */
const aim = (from: { x: number; z: number }, x: number, z: number): number => Math.atan2(-(z - from.z), x - from.x);

/**
 * What the site shows for a stage and progress: a pure function, so the same
 * event always draws the same frame and nothing moves between events.
 * `top` is the tower's roof, `half` its top floor's half-width and
 * `floorHeight` the new floor's height.
 */
export function constructionState(site: SiteState, top: number, half: number, floorHeight: number): ConstructionState {
  const lay = frameLayout(half);
  const p = clamp01(site.progress);
  const jib = Math.max(26, Math.round(half * 3 + 6));
  const crane = { x: lay.mast.x, z: lay.mast.z, height: floorHeight + MAST_CLEAR, jib, counter: Math.round(jib * 0.32) };
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
  };
  // Parked: the jib turned to the tower's diagonal, trolley in, hook up under the jib.
  const parked = { slew: aim(lay.mast, half, -half), trolley: 6, hook: -2.6 };
  const edgesShown = (n: number): number => lay.beams.slice(0, n).filter((b) => b.edge).length;

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
      return { ...base, columns: { shown: cTotal, total: cTotal }, beams: { shown: bTotal, total: bTotal }, decks: { shown: dTotal, total: dTotal }, nets: edgesShown(bTotal), ...parked };
    case 'curing':
      return { ...base, columns: { shown: cTotal, total: cTotal }, beams: { shown: bTotal, total: bTotal }, decks: { shown: dTotal, total: dTotal }, ...parked, lamp: 'steady' };
    case 'waiting':
      return { ...base, ...parked, lamp: 'steady' };
    default:
      // Teardown and the scar are Task 27's: nothing stands here yet.
      return { ...base, crane: null };
  }
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
    const norm = this.geos.map((g) => {
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      g.clearGroups();
      return g.index ? g.toNonIndexed() : g;
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

/** A net panel `len` wide and `h` tall hanging from y = h down to 0, bellied a little outward (+z) between its ties. */
function netPanel(len: number, h: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 8, 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = x + 0.5;
    const t = y + 0.5;
    // Tied at its top rope and every column; the bottom edge hangs free and swings out a hand's width.
    const belly = Math.sin(Math.PI * u) * (0.08 + 0.18 * (1 - t) * (1 - t));
    pos.setXYZ(i, x * len, t * h, belly);
    uv.setXY(i, u * len, t * h);
  }
  g.computeVertexNormals();
  return g;
}

/** A knotted square-mesh net, 50 mm cells, as an alpha texture (built from data so it also builds outside a browser). */
function netTexture(): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Two cords per tile in each direction, slightly irregular, thicker at the knots.
      const cx = Math.min(x % 16, 16 - (x % 16));
      const cy = Math.min(y % 16, 16 - (y % 16));
      const cord = Math.min(cx, cy) < 0.8 ? 1 : 0;
      const knot = cx < 2 && cy < 2 ? 1 : 0;
      const a = Math.max(cord, knot);
      const i = (y * n + x) * 4;
      // An alpha map is read from its green channel: the cords are white, the holes black.
      const v = a ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // 50 mm cells: the tile (two cells) repeats every 0.1 m of panel.
  t.repeat.set(10, 10);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- sparks

const SPARK_VERT = /* glsl */ `
  ${GLSL_ARC}
  attribute vec4 aSeed;
  attribute vec4 aDir;
  uniform float uTime;
  uniform vec3 uAt;
  uniform float uDeck;
  uniform float uHalf;
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
    if (abs(w.x) > uHalf || abs(w.z) > uHalf) return fly(v0, a);
    vec3 s = speed(v0, hit);
    vec3 v1 = vec3(s.x * 0.45, -s.y * 0.28, s.z * 0.45);
    vec3 q = p + fly(v1, a - hit);
    q.y = max(q.y, -drop + 0.01);
    return q;
  }

  void main() {
    vQuad = position.xy;
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

function makeSparks(count: number): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const seed = new Float32Array(count * 4);
  const dir = new Float32Array(count * 4);
  let s = 0x2545f491;
  const rnd = (): number => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
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
  quad.instanceCount = count;
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
function pixelScale(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number {
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
  set(site: SiteState | null, top: number, half: number, floorHeight: number): void;
  /** Eases the crane toward the pose the last event set and runs the sparks and lamps. True while something that casts a shadow moved. */
  update(dt: number): boolean;
  /** The welding arc's light this frame, in the site's space: where it is and how bright (candela), or null when nobody welds. */
  weld(): { at: THREE.Vector3; intensity: number } | null;
  /** The brightest the arc's light ever gets (post.ts). */
  readonly flickerPeak: number;
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
  disposables: Array<{ dispose(): void }>;
}

/** The crane's paint: a weathered crane yellow, darker than signage so it reads as painted steel at dusk. */
const CRANE_YELLOW = 0xa98228;
const PRIMER = 0x5c3024;
const LAMP_RED = new THREE.Color(9, 0.35, 0.1);

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
    const netMap = own(netTexture());
    const netMat = own(
      new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 1, alphaMap: netMap, alphaTest: 0.35, transparent: false, side: THREE.DoubleSide }),
    );
    // The alpha map tiles in metres (the panels' UVs are in metres).
    netMap.repeat.set(10, 10);
    const lampMat = own(new THREE.MeshBasicMaterial({ color: LAMP_RED.clone(), toneMapped: true }));

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow = true): THREE.Mesh => {
      own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      return m;
    };

    const H = state.crane!.height;
    const L = state.crane!.jib;
    const C = state.crane!.counter;
    const crane = new THREE.Group();
    crane.name = 'construction:crane';
    crane.position.set(state.crane!.x, top, state.crane!.z);

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
    crane.add(mesh(mast.build(), mats.yellow, 'construction:mast'));
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
    crane.add(mesh(ladder.build(), mats.dark, 'construction:ladder'));

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
    lay.columns.forEach(([x, z], i) => columns.setMatrixAt(i, new THREE.Matrix4().compose(v(x, top, z), new THREE.Quaternion(), v(1, fh, 1))));
    const beamGeo = own(beamSection(BEAM_D, 0.19, 0.016, 0.01));
    const beams = new THREE.InstancedMesh(beamGeo, mats.primer, lay.beams.length);
    beams.name = 'construction:beams';
    lay.beams.forEach((b, i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, b.dir === 'x' ? 0 : Math.PI / 2);
      beams.setMatrixAt(i, new THREE.Matrix4().compose(v(b.x, top + fh, b.z), q, v(b.len - COL_D, 1, 1)));
    });
    const deckGeo = own(deckSheet(8));
    const decks = new THREE.InstancedMesh(deckGeo, mats.deck, lay.decks.length);
    decks.name = 'construction:decks';
    lay.decks.forEach(([x, z], i) => decks.setMatrixAt(i, new THREE.Matrix4().compose(v(x, top + fh + 0.065, z), new THREE.Quaternion(), v(lay.bay - 0.12, 1, lay.bay - 0.12))));
    const netGeo = own(netPanel(1, fh + NET_OVER + 0.3));
    const nets = new THREE.InstancedMesh(netGeo, netMat, lay.nets.length);
    nets.name = 'construction:netting';
    lay.nets.forEach((nt, i) => nets.setMatrixAt(i, new THREE.Matrix4().compose(v(nt.x, top - 0.3, nt.z), new THREE.Quaternion().setFromAxisAngle(UP, nt.ry), v(nt.len, 1, 1))));
    // The net's own UVs are in metres along a unit panel: stretch them with the panel length.
    netMap.repeat.set(10 * lay.nets[0].len, 10);
    for (const m of [columns, beams, decks]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    nets.receiveShadow = true;
    object.add(columns, beams, decks, nets);

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
      disposables,
    };
  }

  function clear(): void {
    if (!built) return;
    for (const d of built.disposables) d.dispose();
    object.clear();
    built = null;
  }

  /** Applies the counts and switches of a state at once (the crane's pose eases in update). */
  function apply(b: Built, s: ConstructionState): void {
    b.state = s;
    b.columns.count = s.columns.shown;
    b.beams.count = s.beams.shown;
    b.decks.count = s.decks.shown;
    b.nets.count = s.nets;
    b.columns.visible = s.columns.shown > 0;
    b.beams.visible = s.beams.shown > 0;
    b.decks.visible = s.decks.shown > 0;
    b.nets.visible = s.nets > 0;
    b.load.visible = s.load;
    b.sparks.visible = s.weldAt !== null;
    b.arc.visible = s.weldAt !== null;
    if (s.weldAt) {
      weldAt.set(...s.weldAt);
      b.sparkMat.uniforms.uAt.value.copy(weldAt);
      b.arcMat.uniforms.uAt.value.copy(weldAt);
    }
    placeRopes(b);
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
    b.lampMat.color.copy(LAMP_RED).multiplyScalar(level);
  }

  return {
    object,
    flickerPeak: FLICKER.peak,
    set(next, top, half, floorHeight) {
      site = next;
      if (!next) {
        clear();
        return;
      }
      const state = constructionState(next, top, half, floorHeight);
      if (!state.crane) {
        clear();
        return;
      }
      const key = `${top.toFixed(3)}|${half.toFixed(3)}|${floorHeight.toFixed(3)}`;
      if (!built || built.key !== key) {
        const keep = built ? { slew: built.slew.rotation.y, trolley: built.trolley.position.x, hook: built.hook.position.y } : null;
        clear();
        built = build(top, half, floorHeight, keep ? { ...state, ...keep } : state);
        built.key = key;
      }
      apply(built, state);
    },
    update(dt) {
      clock = (clock + dt) % WRAP;
      if (!built) return false;
      const b = built;
      const s = b.state;
      // The crane's pose eases toward where the last event put it (a slow slew, a quicker trolley, the hook between), then holds exactly.
      const slew = approachAngle(b.slew.rotation.y, s.slew, 0.9, dt, 1e-4);
      const trolley = approach(b.trolley.position.x, s.trolley, 1.3, dt, 2e-3);
      const hook = approach(b.hook.position.y, s.hook, 1.1, dt, 2e-3);
      const moved = slew !== b.slew.rotation.y || trolley !== b.trolley.position.x || hook !== b.hook.position.y;
      if (moved) {
        b.slew.rotation.y = slew;
        b.trolley.position.x = trolley;
        b.hook.position.set(trolley, hook, 0);
        placeRopes(b);
      }
      b.sparkMat.uniforms.uTime.value = clock;
      arcLevelNow = s.weldAt ? arcLevel(clock) : 0;
      b.arcMat.uniforms.uArc.value = arcLevelNow;
      tickLamps(b);
      return moved;
    },
    weld() {
      if (!built || !built.state.weldAt || !site) return null;
      return { at: weldAt.clone(), intensity: arcLevelNow * FLICKER.peak };
    },
    dispose() {
      clear();
      site = null;
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
