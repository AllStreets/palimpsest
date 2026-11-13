/**
 * The university's site (Phase 4 Task 34): one 240 m block of the district
 * spiral raised 6 m on a terrace behind a battered wall of dressed ashlar
 * with a limestone coping, climbed by two flights of steps cut into the
 * front, and laid out on top as two lawned quads with gravel walks, a
 * walk along the parapet, and the pads the later buildings stand on.
 *
 * Everything opaque on the campus, the terrace and the halls alike, is drawn
 * in one material: a scan is picked per vertex (`aKind`: brick, limestone,
 * slate, ashlar, turf or gravel), so the whole site is one draw a pass and
 * the four halls one instanced draw a pass, whatever is added later. The
 * tones are vertex colours over the scans, and a hall's instance colour
 * drifts them a little from hall to hall.
 *
 * Pure three.js (the material itself is campus/masonry.ts), so it is tested in Node.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import type { CollarPlaza } from '../collar.js';

/** The terrace's height over the street. */
export const TERRACE = 6;
/**
 * Half the side of the ground the campus keeps: the three blocks' buildable
 * squares (lots.ts BLOCK) with the streets round them left to the city. The
 * wall's foot stands a metre inside it.
 */
export const CAMPUS_HALF = 112;
/** The wall's foot, its top (battered in) and the inner edge of the coping. */
const WALL_FOOT = 111;
const WALL_TOP = 110.3;
const COPING_OUT = 110.5;
const COPING_IN = 109.3;
/** The stair well cut into the front: half its width between the cheek walls, and how far in it reaches. */
const WELL_HALF = 7.5;
const WELL_DEPTH = 16;
/** Where the lawns of the two quads lie (local x), and the halls' fronts either side of them (local z). */
export const FRONT_QUAD = { x0: 12, x1: 68 } as const;
export const INNER_QUAD = { x0: -76, x1: -20 } as const;
export const QUAD_HALF = 44;
/** A hall's centre line from the axis: its front stands at QUAD_HALF + a path. */
export const HALL_Z = 56.5;

export type Kind = 'brick' | 'limestone' | 'slate' | 'ashlar' | 'turf' | 'gravel' | 'lamp' | 'dial' | 'louvre' | 'gilt' | 'yew' | 'copper' | 'paint' | 'brass' | 'glow';
export const KIND: Record<Kind, number> = { brick: 0, limestone: 1, slate: 2, ashlar: 3, turf: 4, gravel: 5, lamp: 6, dial: 7, louvre: 8, gilt: 9, yew: 10, copper: 11, paint: 12, brass: 13, glow: 14 };
/** Metres per tile of each kind's scan (the Kit's TILE for brick and limestone); 0 keeps the piece's own UVs (a clock dial's painted face, the copper's seams). */
const TILE: Record<Kind, number> = { brick: 1.5, limestone: 3.0, slate: 2.0, ashlar: 2.4, turf: 9, gravel: 1.6, lamp: 1, dial: 0, louvre: 1, gilt: 1, yew: 1, copper: 0, paint: 1, brass: 1, glow: 0 };
/**
 * Each kind's tone, a vertex colour over its scan: red-brown brick, a pale
 * warm limestone, a cool blue-grey slate, the terrace's pale buff ashlar, a
 * mown turf, a pale gravel, the lamps' warm light (the shader emits the
 * lamp kind's colour), a clock dial's face (its paint is the shader's dial
 * texture, lit from behind after sunset), weathered timber louvres, the
 * gilt of the clock's hands, the yews' deep blue-green (flat, no lawn
 * mottle, so a columnar tree never reads pale), the observatory's copper
 * (the shader paints the patina; the tone is its drift), the cream paint of
 * its telescope, the brass of its plate (lit by a uniform while the master
 * is trusted) and the warm lamplit lining inside its dome (its tone is the
 * lamplight itself, in linear light, which the shader emits by a uniform
 * while the slit is open; its paint is near black).
 */
export const TONE: Record<Kind, THREE.Color> = {
  brick: new THREE.Color(0.74, 0.5, 0.4),
  limestone: new THREE.Color(0.94, 0.91, 0.84),
  slate: new THREE.Color(0.2, 0.23, 0.28),
  ashlar: new THREE.Color(0.77, 0.78, 0.75),
  turf: new THREE.Color(0.3, 0.42, 0.16),
  gravel: new THREE.Color(0.93, 0.9, 0.82),
  lamp: new THREE.Color(1.0, 0.74, 0.44),
  dial: new THREE.Color(1, 1, 1),
  louvre: new THREE.Color(0.5, 0.42, 0.33),
  gilt: new THREE.Color(0.92, 0.72, 0.3),
  yew: new THREE.Color(0.14, 0.3, 0.25),
  copper: new THREE.Color(1, 1, 1),
  paint: new THREE.Color(0.74, 0.71, 0.64),
  brass: new THREE.Color(0.8, 0.6, 0.26),
  glow: new THREE.Color(0.55, 0.19, 0.035),
};

/** A small seeded generator for the trees' and lamps' variety (lots.ts rng, kept local so this module stays pure). */
function seeded(seed: number): () => number {
  let t = (seed * 2654435761) >>> 0 || 1;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
/** Lattice-free value noise in [0, 1) from a point. */
function hash3(x: number, y: number, z: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/** The campus's ground as the ambient city sees it: a square court kept clear of lots and lamps, never paved, no lanterns. */
export function campusPlaza(origin: { x: number; z: number }): CollarPlaza {
  return { x: origin.x, z: origin.z, court: CAMPUS_HALF, terrace: true };
}

// ---------------------------------------------------------------- pieces

/** UVs projected along each vertex's dominant normal axis, `tile` metres a tile, so a scan keeps its scale and runs on across pieces. */
export function projectUv(g: THREE.BufferGeometry, tile: number): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = p.getX(i);
      v = p.getZ(i);
    } else if (ax >= az) {
      u = p.getZ(i) * Math.sign(n.getX(i) || 1);
      v = p.getY(i);
    } else {
      u = -p.getX(i) * Math.sign(n.getZ(i) || 1);
      v = p.getY(i);
    }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

/**
 * A geometry made a campus piece of one kind: indexed position, normal, uv,
 * colour and `aKind` only, so every piece merges with every other; its UVs
 * projected at the kind's tile, its colour the kind's tone times `drift`.
 */
export function stamp(g: THREE.BufferGeometry, kind: Kind, drift = 1, shade?: (p: THREE.Vector3, n: THREE.Vector3) => number, tint?: THREE.Color): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (TILE[kind] > 0) projectUv(g, TILE[kind]);
  const tone = TONE[kind];
  const col = new Float32Array(n * 3);
  const kinds = new Float32Array(n).fill(KIND[kind]);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const k = drift * (shade ? shade(p.fromBufferAttribute(pos, i), q.fromBufferAttribute(nor, i)) : 1);
    col[i * 3] = tone.r * k * (tint?.r ?? 1);
    col[i * 3 + 1] = tone.g * k * (tint?.g ?? 1);
    col[i * 3 + 2] = tone.b * k * (tint?.b ?? 1);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kinds, 1));
  if (!g.index) g.setIndex(Array.from({ length: n }, (_, i) => i));
  return g;
}

/** Merges stamped pieces into one geometry and disposes them. */
export function mergeStamped(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(pieces, false);
  if (!g) throw new Error('campus: pieces did not merge');
  for (const p of pieces) p.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A box from x0..x1, y0..y1, z0..z1. */
function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** A box `w` by `d` in plan centred at (x, z), from y0 to y1, turned `ry` about its centre. */
function block(x: number, z: number, w: number, d: number, y0: number, y1: number, ry = 0): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, y1 - y0, d).rotateY(ry).translate(x, (y0 + y1) / 2, z);
}

/**
 * The four battered faces of the terrace wall: the foot `hb` out from the
 * centre, the top `ht`, `h` tall. The +x face leaves the stair well open
 * between -gap and gap.
 */
function batteredWall(hb: number, ht: number, h: number, gap: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  // Each face as seen from outside, counter-clockwise: foot left, foot right, top right, top left.
  // +z face (u along +x), -z face (u along -x), -x face (u along +z); the +x face in two parts round the well.
  quad([-hb, 0, hb], [hb, 0, hb], [ht, h, ht], [-ht, h, ht]);
  quad([hb, 0, -hb], [-hb, 0, -hb], [-ht, h, -ht], [ht, h, -ht]);
  quad([-hb, 0, -hb], [-hb, 0, hb], [-ht, h, ht], [-ht, h, -ht]);
  quad([hb, 0, hb], [hb, 0, gap], [ht, h, gap], [ht, h, ht]);
  quad([hb, 0, -gap], [hb, 0, -hb], [ht, h, -ht], [ht, h, -gap]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Where the later buildings stand, in the campus's own frame (x toward the city, y the terrace). */
export interface SiteAnchors {
  library: THREE.Vector3;
  clock: THREE.Vector3;
  dome: THREE.Vector3;
  gate: THREE.Vector3;
}

export function siteAnchors(): SiteAnchors {
  return {
    gate: new THREE.Vector3(WALL_FOOT - WELL_DEPTH - 2, TERRACE, 0),
    library: new THREE.Vector3(-92, TERRACE, 0),
    clock: new THREE.Vector3((FRONT_QUAD.x0 + INNER_QUAD.x1) / 2, TERRACE, HALL_Z),
    dome: new THREE.Vector3(-90, TERRACE, -90),
  };
}

/**
 * The site's geometry, stamped and merged: the wall and its plinth, the
 * coping, the corner bastions, the stair well with its two flights and its
 * piers, the lawns, the walks and the quads' diagonals. `detail` (the high
 * tier) adds the bastions' caps and the piers' finials.
 */
export function buildSite(detail: boolean): THREE.BufferGeometry {
  const T = TERRACE;
  const pieces: THREE.BufferGeometry[] = [];
  const add = (kind: Kind, g: THREE.BufferGeometry, drift = 1, shade?: (p: THREE.Vector3, n: THREE.Vector3) => number, tint?: THREE.Color): void => {
    pieces.push(stamp(g, kind, drift, shade, tint));
  };
  const wellOut = WELL_HALF + 1.0;

  // The wall: battered dressed ashlar on a limestone plinth, a limestone coping on top.
  add('ashlar', batteredWall(WALL_FOOT, WALL_TOP, T, wellOut));
  const plinth = WALL_FOOT + 0.35;
  add('limestone', slab(-plinth, plinth, 0, 0.6, plinth - 0.7, plinth));
  add('limestone', slab(-plinth, plinth, 0, 0.6, -plinth, -plinth + 0.7));
  add('limestone', slab(-plinth, -plinth + 0.7, 0, 0.6, -plinth, plinth));
  add('limestone', slab(plinth - 0.7, plinth, 0, 0.6, wellOut, plinth));
  add('limestone', slab(plinth - 0.7, plinth, 0, 0.6, -plinth, -wellOut));
  const cop = (x0: number, x1: number, z0: number, z1: number): void => add('limestone', slab(x0, x1, T, T + 0.4, z0, z1));
  cop(-COPING_OUT, COPING_OUT, COPING_IN, COPING_OUT);
  cop(-COPING_OUT, COPING_OUT, -COPING_OUT, -COPING_IN);
  cop(-COPING_OUT, -COPING_IN, -COPING_IN, COPING_IN);
  cop(COPING_IN, COPING_OUT, wellOut, COPING_IN);
  cop(COPING_IN, COPING_OUT, -COPING_IN, -wellOut);
  // Corner bastions: square piers standing a little proud of the wall, capped in limestone.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (WALL_FOOT - 1.4);
      const cz = sz * (WALL_FOOT - 1.4);
      add('ashlar', block(cx, cz, 3.6, 3.6, 0, T + 0.9));
      add('limestone', block(cx, cz, 4.0, 4.0, T + 0.9, T + 1.3));
      if (detail) add('limestone', new THREE.ConeGeometry(2.0 * Math.SQRT2, 1.4, 4).rotateY(Math.PI / 4).translate(cx, T + 1.3 + 0.7, cz));
    }
  }

  // The stair well: cheek walls, two flights of twenty steps with a landing between, piers at the mouth.
  const x0 = WALL_FOOT;
  const xTop = WALL_FOOT - WELL_DEPTH;
  for (const s of [-1, 1]) {
    const zc = s * (WELL_HALF + 0.5);
    add('ashlar', block((x0 + xTop) / 2, zc, WELL_DEPTH + 0.5, 1.0, 0, T));
    add('limestone', block((x0 + xTop) / 2, zc, WELL_DEPTH + 0.5, 1.3, T, T + 0.4));
    // A pier at the mouth, with its cap.
    const px = x0 - 0.6;
    const pz = s * (WELL_HALF + 1.2);
    add('limestone', block(px, pz, 1.8, 1.8, 0, T + 1.6));
    add('limestone', block(px, pz, 2.1, 2.1, T + 1.6, T + 1.95));
    if (detail) add('limestone', new THREE.ConeGeometry(1.05 * Math.SQRT2, 0.9, 4).rotateY(Math.PI / 4).translate(px, T + 1.95 + 0.45, pz));
  }
  const rise = T / 2 / 20;
  const tread = 0.3;
  const run = 20 * tread;
  const landing = WELL_DEPTH - 2 * run;
  // Lower flight from the street, the landing, the upper flight to the terrace: each step a solid block down to the ground.
  for (let i = 0; i < 20; i++) {
    const xi = x0 - (i + 1) * tread;
    add('limestone', slab(xi, xi + tread, 0, (i + 1) * rise, -WELL_HALF, WELL_HALF));
  }
  add('limestone', slab(x0 - run - landing, x0 - run, 0, T / 2, -WELL_HALF, WELL_HALF));
  for (let i = 0; i < 20; i++) {
    const xi = x0 - run - landing - (i + 1) * tread;
    add('limestone', slab(xi, xi + tread, 0, T / 2 + (i + 1) * rise, -WELL_HALF, WELL_HALF));
  }

  // The lawn, in the pieces round the well, a metre thick so its edge never shows.
  const inner = COPING_IN;
  add('turf', slab(-inner, xTop, T - 1, T, -inner, inner));
  add('turf', slab(xTop, inner, T - 1, T, -inner, -wellOut));
  add('turf', slab(xTop, inner, T - 1, T, wellOut, inner));

  // The walks: pale gravel a hand above the lawn, each between dark stone kerbs that stand a little under the gravel
  // (so a walk crossing another covers them). The axis from the stair head to the library, a cross walk between
  // the two ranges, a walk along the parapet, a walk round each quad under the halls' fronts, and the diagonals.
  const top = T + 0.06;
  const kerbY = top - 0.015;
  /** A strip `len` long and `wid` wide centred at (cx, cz), turned `ry`, with its kerbs along the long sides. */
  const strip = (cx: number, cz: number, len: number, wid: number, ry: number): void => {
    add('gravel', new THREE.BoxGeometry(len, top - (T - 0.2), wid).rotateY(ry).translate(cx, (T - 0.2 + top) / 2, cz));
    for (const s of [-1, 1]) {
      const off = s * (wid / 2 + 0.14);
      add('ashlar', new THREE.BoxGeometry(len, kerbY - (T - 0.2), 0.3).rotateY(ry).translate(cx + Math.sin(ry) * off, (T - 0.2 + kerbY) / 2, cz + Math.cos(ry) * off), 0.5);
    }
  };
  const walk = (xa: number, xb: number, za: number, zb: number): void => {
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    const z0 = Math.min(za, zb);
    const z1 = Math.max(za, zb);
    if (x1 - x0 >= z1 - z0) strip((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, 0);
    else strip((x0 + x1) / 2, (z0 + z1) / 2, z1 - z0, x1 - x0, Math.PI / 2);
  };
  walk(-100, xTop + 0.5, -4.5, 4.5);
  const crossX = (FRONT_QUAD.x0 + INNER_QUAD.x1) / 2;
  walk(crossX - 3.5, crossX + 3.5, -inner + 3, inner - 3);
  // The observatory's walk: from its door steps along the back lawn to the cross walk (Task 36).
  walk(-81, crossX, -91.75, -88.25);
  const pw = 4.0;
  walk(-inner, inner, inner - pw, inner);
  walk(-inner, inner, -inner, -inner + pw);
  walk(-inner, -inner + pw, -inner, inner);
  walk(inner - pw, inner, -inner, -wellOut);
  walk(inner - pw, inner, wellOut, inner);
  for (const q of [FRONT_QUAD, INNER_QUAD]) {
    const z1 = QUAD_HALF + 4;
    walk(q.x0 - 4, q.x1 + 4, QUAD_HALF, z1);
    walk(q.x0 - 4, q.x1 + 4, -z1, -QUAD_HALF);
    walk(q.x0 - 4, q.x0, -z1, z1);
    walk(q.x1, q.x1 + 4, -z1, z1);
    // A classic college quad: the perimeter walk, the axis through it, and one cross walk from hall door to hall
    // door; no diagonals, the lawn kept whole in four panels.
    const cx = (q.x0 + q.x1) / 2;
    const dx = q.x1 - q.x0;
    walk(cx - 1.8, cx + 1.8, -QUAD_HALF, QUAD_HALF);
    // Mature trees in two rows down each lawn, standing in from the halls' walks, no two alike; a columnar
    // tree at each corner of the lawn, a darker species, for the quad to read as planted, not scattered.
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const tx = q.x0 + 7 + i * ((dx - 14) / 3);
        if (Math.abs(tx - cx) < 4) continue;
        const seed = Math.round(tx * 7 + sz * 131 + q.x0);
        tree(tx + (i % 2 ? 1.5 : -1.5), sz * (QUAD_HALF - 9), 0.85 + 0.3 * ((i * 7 + (sz + 1)) % 3) / 2, seed);
      }
      for (const sx of [-1, 1]) column(cx + sx * (dx / 2 - 3), sz * (QUAD_HALF - 3), 1.0, Math.round(cx * 3 + sx * 17 + sz * 29));
    }
    // Lamps at the quad's corners only.
    for (const sz of [-1, 1]) for (const lx of [q.x0 - 1.5, q.x1 + 1.5]) lamp(lx, sz * (QUAD_HALF + 5.2));
  }
  // Trees in the forecourt corners, a pair of columnar trees flanking the library's front.
  for (const sz of [-1, 1]) {
    tree(FRONT_QUAD.x1 + 14, sz * 22, 1.0, 11 + sz);
    column(-79, sz * 36, 1.1, 17 + sz);
  }
  // Lamps down the axis every second bay, two across the cross walk, every other post along the parapet walk,
  // and a pair at the stair head: half the posts of a first draft, which lit the lawns like a car park.
  for (let x = -76; x <= 84; x += 32) for (const sz of [-1, 1]) lamp(x, sz * 6.2);
  for (const z of [-30, 30]) for (const sx of [-1, 1]) lamp(crossX + sx * 5.4, z);
  const ring = inner - pw - 1.4;
  for (let u = -ring; u <= ring + 1e-6; u += ring / 2) {
    lamp(u, ring);
    lamp(u, -ring);
    if (Math.abs(u) > 1) lamp(-ring, u);
    if (Math.abs(u) > wellOut + 4) lamp(ring, u);
  }
  for (const sz of [-1, 1]) lamp(xTop + 1.2, sz * 6.4);
  /**
   * A tree, no two alike: a flared trunk forking into two limbs, a crown of
   * six to eight lobes (icosahedra pushed in and out by noise), the whole
   * leaning a few degrees. Its colour runs from a dark underside to a
   * sunlit top, each lobe a little lighter or darker than the next and the
   * edges broken by noise, all in the lawn's own kind.
   */
  function tree(x: number, z: number, size: number, seed: number): void {
    const r = seeded(seed);
    const k = size * (0.9 + 0.25 * r());
    const lean = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((r() - 0.5) * 0.12, r() * Math.PI * 2, (r() - 0.5) * 0.12));
    const place = new THREE.Matrix4().makeTranslation(x, T, z).multiply(lean);
    // The trunk, wider at the root, and a fork of two limbs leaning apart.
    const trunk = new THREE.CylinderGeometry(0.2 * k, 0.46 * k, 3.4 * k, 8).translate(0, 1.7 * k, 0);
    const limbs = [-1, 1].map((s) =>
      new THREE.CylinderGeometry(0.1 * k, 0.17 * k, 2.6 * k, 6)
        .translate(0, 1.3 * k, 0)
        .rotateZ(s * (0.35 + 0.2 * r()))
        .rotateY(r() * Math.PI * 2)
        .translate(0, 3.2 * k, 0),
    );
    const wood = mergeGeometries([trunk, ...limbs].map((g) => g.toNonIndexed()), false)!;
    add('slate', wood.applyMatrix4(place), 0.9);
    // The crown.
    const lobes: THREE.BufferGeometry[] = [];
    const n = 6 + Math.floor(r() * 3);
    const crownY = 5.4 * k;
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.8;
      const reach = (0.4 + r() * 1.6) * k;
      const rad = (1.4 + r() * 1.1) * k;
      const cy = crownY + (r() * 2.2 - 0.6) * k;
      // Shared vertices, so the noise moves each point once and the lobe shades smoothly.
      const g = mergeVertices(new THREE.IcosahedronGeometry(rad, 2));
      const pos = g.attributes.position as THREE.BufferAttribute;
      const salt = r() * 100;
      for (let v = 0; v < pos.count; v++) {
        const px = pos.getX(v);
        const py = pos.getY(v);
        const pz = pos.getZ(v);
        const len = Math.hypot(px, py, pz) || 1;
        const d = 1 + (hash3(px * 0.9 + salt, py * 0.9, pz * 0.9) - 0.5) * 0.5;
        pos.setXYZ(v, (px / len) * rad * d, (py / len) * rad * d * 0.82, (pz / len) * rad * d);
      }
      g.translate(Math.cos(a) * reach, cy, Math.sin(a) * reach);
      lobes.push(g);
      values.push(0.88 + r() * 0.26);
    }
    for (const g of lobes) g.computeVertexNormals();
    const counts = lobes.map((g) => g.attributes.position.count);
    const crown = mergeGeometries(lobes, false)!;
    const lo = crownY - 2.6 * k;
    const hi = crownY + 3.6 * k;
    let vi = 0;
    let lobe = 0;
    let left = counts[0];
    const lobeOf = (): number => {
      while (left <= 0 && lobe < counts.length - 1) left = counts[++lobe];
      left--;
      return lobe;
    };
    const perVertex = new Float32Array(crown.attributes.position.count);
    const pp = crown.attributes.position as THREE.BufferAttribute;
    for (vi = 0; vi < perVertex.length; vi++) {
      const l = lobeOf();
      const t = Math.min(1, Math.max(0, (pp.getY(vi) - lo) / (hi - lo)));
      const up = 0.42 + 0.58 * t * t;
      perVertex[vi] = up * values[l] * (0.92 + 0.16 * hash3(pp.getX(vi) * 3.1, pp.getY(vi) * 3.1, pp.getZ(vi) * 3.1));
    }
    let at = 0;
    // Leaves are a cooler, deeper green than a mown lawn.
    add('turf', crown.applyMatrix4(place), 0.8, () => perVertex[at++], new THREE.Color(0.72, 1.0, 0.78));
  }

  /**
   * The second species, a columnar tree (a fastigiate oak or a hornbeam
   * clipped tall): a straight trunk under a tight crown of lobes stacked up a
   * vertical axis, nearly three times taller than wide, in a deeper, bluer
   * green than the spreading trees. Built the same way, in the same draw.
   */
  function column(x: number, z: number, size: number, seed: number): void {
    const r = seeded(seed);
    const k = size * (0.9 + 0.2 * r());
    const place = new THREE.Matrix4().makeTranslation(x, T, z).multiply(new THREE.Matrix4().makeRotationY(r() * Math.PI * 2));
    const trunk = new THREE.CylinderGeometry(0.14 * k, 0.3 * k, 2.6 * k, 8).translate(0, 1.3 * k, 0);
    add('slate', trunk.toNonIndexed().applyMatrix4(place), 0.85);
    const lobes: THREE.BufferGeometry[] = [];
    const n = 5;
    const h0 = 2.2 * k;
    const h1 = 11.5 * k;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const cy = h0 + (h1 - h0) * t + 0.6 * k * (r() - 0.5);
      // Widest a third of the way up, closing to a point at the top.
      const rad = (0.9 + 1.4 * Math.sin(Math.PI * Math.min(1, 0.3 + 0.7 * (1 - t))) * (1 - 0.55 * t)) * k;
      const g = mergeVertices(new THREE.IcosahedronGeometry(rad, 2));
      const pos = g.attributes.position as THREE.BufferAttribute;
      const salt = r() * 100;
      for (let v = 0; v < pos.count; v++) {
        const px = pos.getX(v);
        const py = pos.getY(v);
        const pz = pos.getZ(v);
        const len = Math.hypot(px, py, pz) || 1;
        const d = 1 + (hash3(px * 1.3 + salt, py * 1.3, pz * 1.3) - 0.5) * 0.4;
        pos.setXYZ(v, (px / len) * rad * d, (py / len) * rad * d * 1.5, (pz / len) * rad * d);
      }
      g.translate((r() - 0.5) * 0.4 * k, cy, (r() - 0.5) * 0.4 * k);
      g.computeVertexNormals();
      lobes.push(g);
    }
    const crown = mergeGeometries(lobes, false)!;
    const pp = crown.attributes.position as THREE.BufferAttribute;
    const perVertex = new Float32Array(pp.count);
    for (let vi = 0; vi < pp.count; vi++) {
      const t = Math.min(1, Math.max(0, (pp.getY(vi) - h0) / (h1 - h0)));
      perVertex[vi] = (0.55 + 0.45 * t) * (0.88 + 0.24 * hash3(pp.getX(vi) * 2.7, pp.getY(vi) * 2.7, pp.getZ(vi) * 2.7));
    }
    let at = 0;
    add('yew', crown.applyMatrix4(place), 1, () => perVertex[at++]);
  }

  /** A lamp: a dark post with a warm lit head under a small cap, in the site's own draw (the head's kind emits). */
  function lamp(x: number, z: number): void {
    const h = 3.8;
    add('slate', new THREE.CylinderGeometry(0.06, 0.09, h, 7).translate(x, T + h / 2, z), 0.8);
    add('slate', new THREE.CylinderGeometry(0.16, 0.2, 0.3, 7).translate(x, T + 0.15, z), 0.8);
    add('lamp', new THREE.BoxGeometry(0.42, 0.5, 0.42).translate(x, T + h + 0.25, z));
    add('slate', new THREE.BoxGeometry(0.54, 0.08, 0.54).translate(x, T + h + 0.54, z), 0.8);
  }
  // The forecourt before the library's steps (widening the inner quad's walk) and the one inside the gate.
  walk(-82.5, -76, -22, 22);
  walk(FRONT_QUAD.x1 + 3.5, xTop + 0.5, -9, 9);

  return mergeStamped(pieces);
}
