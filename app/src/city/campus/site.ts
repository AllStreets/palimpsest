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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

export type Kind = 'brick' | 'limestone' | 'slate' | 'ashlar' | 'turf' | 'gravel';
export const KIND: Record<Kind, number> = { brick: 0, limestone: 1, slate: 2, ashlar: 3, turf: 4, gravel: 5 };
/** Metres per tile of each kind's scan (the Kit's TILE for brick and limestone). */
const TILE: Record<Kind, number> = { brick: 1.5, limestone: 3.0, slate: 2.0, ashlar: 2.4, turf: 9, gravel: 1.1 };
/**
 * Each kind's tone, a vertex colour over its scan: red-brown brick, a pale
 * warm limestone, blue-grey slate, the terrace's buff ashlar, a dark turf
 * and a pale gravel.
 */
export const TONE: Record<Kind, THREE.Color> = {
  brick: new THREE.Color(0.74, 0.5, 0.4),
  limestone: new THREE.Color(0.9, 0.86, 0.78),
  slate: new THREE.Color(0.18, 0.19, 0.21),
  ashlar: new THREE.Color(0.8, 0.74, 0.64),
  turf: new THREE.Color(0.2, 0.3, 0.12),
  gravel: new THREE.Color(0.86, 0.8, 0.68),
};

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
export function stamp(g: THREE.BufferGeometry, kind: Kind, drift = 1): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  projectUv(g, TILE[kind]);
  const tone = TONE[kind];
  const col = new Float32Array(n * 3);
  const kinds = new Float32Array(n).fill(KIND[kind]);
  for (let i = 0; i < n; i++) {
    col[i * 3] = tone.r * drift;
    col[i * 3 + 1] = tone.g * drift;
    col[i * 3 + 2] = tone.b * drift;
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
    library: new THREE.Vector3(-88, TERRACE, 0),
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
  const add = (kind: Kind, g: THREE.BufferGeometry, drift = 1): void => {
    pieces.push(stamp(g, kind, drift));
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

  // The walks: gravel a hand above the lawn. The axis from the stair head to the library, a walk along the parapet,
  // a walk round each quad under the halls' fronts, and the diagonals that cross each lawn.
  const top = T + 0.06;
  const walk = (xa: number, xb: number, za: number, zb: number): void => add('gravel', slab(Math.min(xa, xb), Math.max(xa, xb), T - 0.2, top, Math.min(za, zb), Math.max(za, zb)));
  walk(-100, xTop + 0.5, -3.5, 3.5);
  const pw = 3.2;
  walk(-inner, inner, inner - pw, inner);
  walk(-inner, inner, -inner, -inner + pw);
  walk(-inner, -inner + pw, -inner, inner);
  walk(inner - pw, inner, -inner, -wellOut);
  walk(inner - pw, inner, wellOut, inner);
  for (const q of [FRONT_QUAD, INNER_QUAD]) {
    const z1 = QUAD_HALF + 3.5;
    walk(q.x0 - 3.5, q.x1 + 3.5, QUAD_HALF, z1);
    walk(q.x0 - 3.5, q.x1 + 3.5, -z1, -QUAD_HALF);
    walk(q.x0 - 3.5, q.x0, -z1, z1);
    walk(q.x1, q.x1 + 3.5, -z1, z1);
    // The diagonals, corner to corner, meeting at the middle of the lawn.
    const cx = (q.x0 + q.x1) / 2;
    const dx = q.x1 - q.x0;
    const len = Math.hypot(dx, 2 * QUAD_HALF);
    for (const s of [-1, 1]) add('gravel', new THREE.BoxGeometry(len, top - (T - 0.2), 1.8).rotateY(s * Math.atan2(2 * QUAD_HALF, dx)).translate(cx, (T - 0.2 + top) / 2, 0));
    // From the axis to each hall's door.
    walk(cx - 1.2, cx + 1.2, -QUAD_HALF, QUAD_HALF);
    // Mature trees in two rows down each lawn, between the diagonals and the halls' walks.
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const tx = q.x0 + 7 + i * ((dx - 14) / 3);
        if (Math.abs(tx - cx) < 4) continue;
        tree(tx + (i % 2 ? 1.5 : -1.5), sz * (QUAD_HALF - 9), 0.85 + 0.3 * ((i * 7 + (sz + 1)) % 3) / 2);
      }
    }
  }
  // Trees in the forecourt corners and before the library's pad.
  for (const sz of [-1, 1]) {
    tree(FRONT_QUAD.x1 + 14, sz * 22, 1.0);
    tree(-104, sz * 24, 0.9);
  }
  // A tree: a dark trunk and a crown of two leafy masses, in the lawn's own kind a shade darker.
  function tree(x: number, z: number, k: number): void {
    add('slate', new THREE.CylinderGeometry(0.22 * k, 0.34 * k, 3.4 * k, 7).translate(x, T + 1.7 * k, z));
    add('turf', new THREE.SphereGeometry(3.3 * k, 12, 8).scale(1, 0.82, 1).translate(x, T + 5.6 * k, z), 0.42);
    add('turf', new THREE.SphereGeometry(2.3 * k, 10, 7).scale(1.1, 0.8, 1).translate(x + 1.3 * k, T + 6.9 * k, z - 0.7 * k), 0.5);
  }
  // The pad before the library's steps and the forecourt inside the gate.
  walk(-100, -80, -14, 14);
  walk(FRONT_QUAD.x1 + 3.5, xTop + 0.5, -9, 9);

  return mergeStamped(pieces);
}
