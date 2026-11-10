import * as THREE from 'three';

import { ROOT_HEIGHT } from '../../../../shared/tower-layout.js';
import type { RootStyle } from '../../../../shared/types.js';
import {
  face,
  flutedShaft,
  frustum,
  Kit,
  lathe,
  M,
  ME,
  type MatKey,
  PANE_FULL,
  PANE_SASH,
  PANE_SHOJI,
  PANE_SILL,
  paneData,
  piercedWall,
  pointedArch,
  roundArch,
  squareSweep,
  unitBox,
  wedge,
} from './kit.js';

/** Builds a root in the kit's frame, from the ground up to exactly ROOT_HEIGHT[style]. */
export type RootBuilder = (k: Kit, detail: boolean, rand: () => number) => void;

/** Half-width of each root's roof, where the first floor (26 m across) stands and the datum wraps an empty tower. */
export const ROOT_TOP_HALF: Record<RootStyle, number> = {
  beauxarts: 13.6,
  roman: 17.6,
  gothic: 13.8,
  pagoda: 13.6,
  chicago: 17.55,
};

// ---------------------------------------------------------------- shared

/** Stepped base: square courses, largest first, each `rise` tall. */
function steps(k: Kit, mat: MatKey, sizes: number[], rise: number): number {
  sizes.forEach((s, i) => k.box(mat, s, rise, s, M(0, rise * (i + 0.5), 0)));
  return sizes.length * rise;
}

/** Warm institutional light: most windows lit, a few dark. */
function warmLight(rand: () => number, style: number, on = 0.8): THREE.Color {
  return rand() < on ? paneData(0.6 + 0.4 * rand(), 1, style) : paneData(0.04, 1, style);
}

function pane(k: Kit, F: THREE.Matrix4, u: number, y: number, w: number, h: number, z: number, data: THREE.Color): void {
  k.pane('pane', 'window', F.clone().multiply(M(u, y, z, 0, w, h, 1)), data);
}

interface Opening {
  u: number;
  w: number;
  y0: number;
  /** Spring line; the arch above is round unless `pointed`. */
  ys: number;
  pointed?: boolean;
  /** Depth of the voussoir ring round a round arch, which rustication stops short of. */
  ring?: number;
}

function outline(o: Opening): THREE.Vector2[] {
  return o.pointed ? pointedArch(o.u, o.w, o.y0, o.ys) : roundArch(o.u, o.w, o.y0, o.ys);
}

/**
 * One face's wall, `depth` thick, pierced with arched openings. Its outer
 * face sits on the face plane (z=0 in the face frame). The two side faces
 * (1 and 3) are shortened so corners do not overlap.
 */
function wall(k: Kit, mat: MatKey, side: number, half: number, y0: number, h: number, depth: number, openings: Opening[]): void {
  const L = side % 2 === 0 ? half * 2 : half * 2 - 2 * depth;
  k.add(mat, piercedWall(L, h, depth, openings.map(outline)), face(side, half).multiply(M(0, y0, -depth)));
}

/** Half-width an opening takes up within a horizontal band, or 0 if the band misses it. */
function openingHalfIn(o: Opening, b0: number, b1: number): number {
  const top = o.pointed ? o.ys + o.w * Math.sin(Math.PI / 3) : o.ys + o.w / 2 + (o.ring ?? 0);
  if (b1 <= o.y0 || b0 >= top) return 0;
  if (b0 <= o.ys) return o.w / 2;
  if (o.pointed) {
    // Equilateral arch: each side is an arc of radius w centred on the far jamb.
    const dy = b0 - o.ys;
    return Math.max(0, Math.sqrt(o.w * o.w - dy * dy) - o.w / 2);
  }
  const r = o.w / 2 + (o.ring ?? 0);
  const dy = b0 - o.ys;
  return Math.sqrt(Math.max(0, r * r - dy * dy));
}

/**
 * Rusticated courses: blocks standing proud of the wall face with a deep
 * channel between each course, broken around the openings so every arch
 * keeps a clean reveal.
 */
function rusticate(
  k: Kit,
  mat: MatKey,
  side: number,
  half: number,
  y0: number,
  h: number,
  course: number,
  proud: number,
  openings: Opening[],
): void {
  const F = face(side, half);
  const L = half * 2;
  const n = Math.round(h / course);
  const ch = h / n;
  const gap = 0.12;
  for (let c = 0; c < n; c++) {
    const b0 = c * ch;
    const b1 = b0 + ch;
    const cuts = openings
      .map((o) => ({ o, hw: openingHalfIn(o, b0, b1) }))
      .filter((x) => x.hw > 0)
      .map(({ o, hw }) => [o.u - hw - 0.18, o.u + hw + 0.18] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let a = -L / 2;
    const runs: Array<[number, number]> = [];
    for (const [c0, c1] of cuts) {
      if (c0 > a) runs.push([a, c0]);
      a = Math.max(a, c1);
    }
    if (a < L / 2) runs.push([a, L / 2]);
    for (const [r0, r1] of runs) {
      if (r1 - r0 < 0.25) continue;
      k.box(mat, r1 - r0, ch - gap, proud, F.clone().multiply(M((r0 + r1) / 2, y0 + b0 + gap / 2 + (ch - gap) / 2, proud / 2)));
    }
  }
}

/**
 * Radiating voussoirs round a round arch: true wedges cut on the arch's
 * radii with a thin joint between each, standing `proud` of the wall, the
 * keystone longer and prouder still.
 */
function voussoirs(k: Kit, mat: MatKey, F: THREE.Matrix4, o: Opening, y0: number, proud: number, count: number, ring: number): void {
  const r = o.w / 2;
  const joint = 0.035 / r;
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI + joint / 2;
    const a1 = ((i + 1) / count) * Math.PI - joint / 2;
    const key = i === Math.floor(count / 2);
    const R = r + ring * (key ? 1.3 : 1);
    const shape = new THREE.Shape();
    shape.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
    shape.absarc(0, 0, r, a0, a1, false);
    shape.lineTo(Math.cos(a1) * R, Math.sin(a1) * R);
    shape.absarc(0, 0, R, a1, a0, true);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: proud + (key ? 0.12 : 0), bevelEnabled: false, curveSegments: 3 });
    k.add(mat, g, F.clone().multiply(M(o.u, y0 + o.ys, 0)));
  }
}

/** A balustrade round a square of half-width `half`: plinth, turned balusters, rail. Returns its height. */
function balustrade(k: Kit, mat: MatKey, half: number, y0: number, detail: boolean, prefix: string): number {
  const plinth = 0.3;
  const bh = 1.3;
  const rail = 0.4;
  k.add(mat, squareSweep(half, [[-0.35, y0], [0.0, y0], [0.0, y0 + plinth], [-0.35, y0 + plinth]]));
  k.add(mat, squareSweep(half, [[-0.4, y0 + plinth + bh], [0.05, y0 + plinth + bh], [0.05, y0 + plinth + bh + rail * 0.6], [0.0, y0 + plinth + bh + rail], [-0.4, y0 + plinth + bh + rail]]));
  if (detail) {
    const make = (): THREE.BufferGeometry =>
      lathe([[0, 0], [0.13, 0], [0.13, 0.12], [0.09, 0.2], [0.07, 0.45], [0.14, 0.75], [0.15, 0.85], [0.08, 1.0], [0.07, 1.12], [0.12, 1.18], [0.12, bh], [0, bh]], 10);
    const spacing = 0.42;
    for (let side = 0; side < 4; side++) {
      const F = face(side, half - 0.18);
      const n = Math.floor((half * 2 - 0.8) / spacing);
      for (let i = 0; i < n; i++) {
        const u = -half + 0.4 + spacing * (i + 0.5);
        k.inst(`${prefix}:baluster`, mat, make, F.clone().multiply(M(u, y0 + plinth, 0)));
      }
    }
  }
  return plinth + bh + rail;
}

// ---------------------------------------------------------------- Beaux-Arts

/**
 * Beaux-Arts: a stepped stylobate, a rusticated base pierced by arched
 * windows, a giant order of fluted Ionic columns before a lit hall, an
 * entablature with dentils, an attic and a balustrade.
 */
const beauxarts: RootBuilder = (k, detail, rand) => {
  const H = ROOT_HEIGHT.beauxarts;
  const FOOT = 34;
  const a = FOOT / 2;
  let y = steps(k, 'sand', [42, 40, 38], 0.45);

  // Rusticated base with arched windows.
  const baseH = 7;
  const depth = 1.0;
  const arches: Opening[] = [-12, -6, 0, 6, 12].map((u) => ({ u, w: 2.4, y0: 0.9, ys: 4.4, ring: 0.62 }));
  // The building behind the openings stops short of the glass, which sits just inside the wall.
  const baseCore = 2 * (a - 0.14 - depth - 0.1);
  k.box('slab', baseCore, baseH, baseCore, M(0, y + baseH / 2, 0));
  for (let side = 0; side < 4; side++) {
    wall(k, 'sand', side, a - 0.14, y, baseH, depth, arches);
    rusticate(k, 'sand', side, a - 0.14, y, baseH, 0.88, 0.14, arches);
    const F = face(side, a - 0.14);
    for (const o of arches) {
      pane(k, F, o.u, y + o.y0 + (o.ys + o.w / 2 - o.y0) / 2, o.w + 0.2, o.ys + o.w / 2 - o.y0 + 0.1, -depth - 0.03, warmLight(rand, PANE_SASH));
      voussoirs(k, 'sand', F, o, y, 0.2, 9, 0.62);
    }
  }
  y += baseH;

  // Band course: the stylobate of the order.
  k.add('sand', squareSweep(a, [[-3.2, y], [0.2, y], [0.35, y + 0.15], [0.35, y + 0.75], [0.2, y + 1.1], [-3.2, y + 1.1]]));
  y += 1.1;

  // The hall behind the colonnade: a recessed wall with tall windows.
  const order = 13.0; // base + shaft + capital
  const core = FOOT - 5;
  k.box('sand', core, order + 0.1, core, M(0, y + order / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, core / 2);
    for (let i = 0; i < 6; i++) {
      const u = -11.25 + i * 4.5;
      k.box('steel', 2.6, 9.6, 0.3, F.clone().multiply(M(u, y + 1.2 + 4.8, 0.0)));
      pane(k, F, u, y + 1.2 + 4.8, 2.2, 9.2, 0.16, warmLight(rand, PANE_SASH, 0.85));
      // Pedimented window head.
      k.box('sand', 3.1, 0.35, 0.3, F.clone().multiply(M(u, y + 10.95, 0.15)));
      k.box('sand', 2.8, 0.5, 0.2, F.clone().multiply(M(u, y + 10.55, 0.1)));
    }
  }

  // Giant order: Attic base, fluted shaft with entasis, Ionic capital with volutes. Columns share the corners.
  const ring = a - 1.25;
  const per = 9;
  const pitch = (ring * 2) / per;
  const baseG = (): THREE.BufferGeometry =>
    lathe([[0, 0], [1.05, 0], [1.05, 0.18], [1.0, 0.2], [1.02, 0.3], [0.95, 0.38], [0.88, 0.42], [0.92, 0.5], [0.86, 0.58], [0, 0.58]], detail ? 32 : 16);
  const shaftH = 11.6;
  const shaftG = (): THREE.BufferGeometry => (detail ? flutedShaft(0.82, shaftH, 24) : new THREE.CylinderGeometry(0.7, 0.82, shaftH, 16).translate(0, shaftH / 2, 0));
  const echinusG = (): THREE.BufferGeometry =>
    lathe([[0, 0], [0.74, 0], [0.8, 0.1], [0.74, 0.16], [0.9, 0.3], [1.0, 0.48], [0, 0.48]], detail ? 32 : 16);
  const abacusG = (): THREE.BufferGeometry => new THREE.BoxGeometry(2.3, 0.34, 2.3);
  const voluteG = (): THREE.BufferGeometry => new THREE.TorusGeometry(0.34, 0.12, 8, 18);
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < per; i++) {
      const u = -ring + pitch * i;
      const P = face(side, ring).multiply(M(u, 0, 0));
      k.inst('col:base', 'sand', baseG, P.clone().multiply(M(0, y, 0)));
      k.inst('col:shaft', 'sand', shaftG, P.clone().multiply(M(0, y + 0.58, 0)));
      k.inst('col:echinus', 'sand', echinusG, P.clone().multiply(M(0, y + 0.58 + shaftH, 0)));
      k.inst('col:abacus', 'sand', abacusG, P.clone().multiply(M(0, y + order - 0.17 + 0.0, 0)));
      if (detail) {
        // Volutes on the face of each capital, scrolled outward.
        for (const s of [-1, 1]) {
          k.inst('col:volute', 'sand', voluteG, P.clone().multiply(M(s * 0.86, y + order - 0.62, 0.62)));
          k.inst('col:volute', 'sand', voluteG, P.clone().multiply(M(s * 0.86, y + order - 0.62, -0.62)));
        }
      }
    }
  }
  y += order;

  // Entablature: two-fascia architrave, plain frieze, dentils, corona and cyma.
  const e0 = y;
  k.add('sand', squareSweep(ring, [[-1.6, e0], [0.9, e0], [0.9, e0 + 0.5], [1.0, e0 + 0.55], [1.0, e0 + 1.0], [1.12, e0 + 1.1], [0.95, e0 + 1.18], [0.95, e0 + 2.0], [-1.6, e0 + 2.0]]));
  if (detail) {
    const dentilG = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.22, 0.3, 0.32);
    for (let side = 0; side < 4; side++) {
      const F = face(side, ring + 0.95);
      const n = Math.floor((ring * 2 + 1.9) / 0.4);
      for (let i = 0; i < n; i++) k.inst('dentil', 'sand', dentilG, F.clone().multiply(M(-ring - 0.95 + 0.2 + i * 0.4, e0 + 2.17, 0.16)));
    }
  }
  k.add('sand', squareSweep(ring, [[-1.6, e0 + 2.0], [1.13, e0 + 2.0], [1.13, e0 + 2.34], [1.6, e0 + 2.42], [1.62, e0 + 2.75], [1.75, e0 + 2.85], [1.72, e0 + 3.0], [-1.6, e0 + 3.0]]));
  y = e0 + 3.0;

  // Attic: a plain storey with small square lights over the column bays.
  const atticTop = H - 2.0;
  const atticHalf = a - 1.6;
  k.box('sand', atticHalf * 2, atticTop - y, atticHalf * 2, M(0, (y + atticTop) / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, atticHalf);
    for (let i = 0; i < 6; i++) pane(k, F, -11.25 + i * 4.5, (y + atticTop) / 2, 1.5, 1.1, 0.02, warmLight(rand, PANE_SILL, 0.6));
  }
  k.add('sand', squareSweep(atticHalf, [[-0.3, atticTop - 0.5], [0.0, atticTop - 0.5], [0.25, atticTop - 0.25], [0.3, atticTop], [-0.3, atticTop]]));
  balustrade(k, 'sand', atticHalf, atticTop, detail, 'beaux');
  // The shaft's footing on the roof, so the first floor stands on stone.
  k.box('sand', ROOT_TOP_HALF.beauxarts * 2, H - atticTop, ROOT_TOP_HALF.beauxarts * 2, M(0, (atticTop + H) / 2, 0));
};

// ---------------------------------------------------------------- Roman

/**
 * Roman: a travertine podium of two superimposed arcades framed by engaged
 * Tuscan half-columns and pilasters, lit loggias behind, and an attic.
 */
const roman: RootBuilder = (k, detail, rand) => {
  const H = ROOT_HEIGHT.roman;
  const FOOT = 36;
  const a = FOOT / 2;
  let y = steps(k, 'travertine', [42, 40, 38], 0.45);
  const bays = 7;
  const pitch = FOOT / bays;
  const us = Array.from({ length: bays }, (_, i) => -a + pitch * (i + 0.5));
  const depth = 1.4;
  const loggia = 3.4;
  const inner = a - depth - loggia;

  const arcade = (y0: number, h: number, arch: Omit<Opening, 'u'>, order: 'column' | 'pilaster'): void => {
    k.box('travertine', inner * 2, h, inner * 2, M(0, y0 + h / 2, 0));
    // Loggia ceiling.
    k.add('travertine', squareSweep(a - depth, [[-loggia - 0.1, y0 + h - 0.6], [0, y0 + h - 0.6], [0, y0 + h], [-loggia - 0.1, y0 + h]]));
    const openings = us.map((u) => ({ u, ...arch }));
    for (let side = 0; side < 4; side++) {
      wall(k, 'travertine', side, a, y0, h, depth, openings);
      const F = face(side, a);
      const Fi = face(side, inner);
      for (const o of openings) {
        voussoirs(k, 'travertine', F, o, y0, 0.1, 11, 0.55);
        // Door or window at the back of the loggia.
        const dh = Math.min(arch.ys + arch.w / 2 - 0.6, h - 1.2);
        pane(k, Fi, o.u, y0 + Math.max(arch.y0, 0.3) + dh / 2, arch.w * 0.62, dh, 0.02, warmLight(rand, order === 'column' ? PANE_FULL : PANE_SASH, 0.85));
        k.box('travertine', arch.w * 0.62 + 0.5, 0.3, 0.2, Fi.clone().multiply(M(o.u, y0 + Math.max(arch.y0, 0.3) + dh + 0.15, 0.1)));
      }
      // The order on the piers.
      for (let i = 0; i <= bays; i++) {
        const u = -a + pitch * i;
        if (i === 0 || i === bays) continue;
        if (order === 'column') {
          const shaftH = h - 1.0;
          const make = (): THREE.BufferGeometry => new THREE.CylinderGeometry(0.5, 0.58, shaftH, detail ? 24 : 12, 1).translate(0, shaftH / 2, 0);
          k.inst('rom:halfcol', 'travertine', make, F.clone().multiply(M(u, y0 + 0.4, 0.05)));
          const baseG = (): THREE.BufferGeometry => lathe([[0, 0], [0.78, 0], [0.78, 0.2], [0.66, 0.28], [0.6, 0.4], [0, 0.4]], 16);
          k.inst('rom:colbase', 'travertine', baseG, F.clone().multiply(M(u, y0, 0.05)));
          const capG = (): THREE.BufferGeometry => lathe([[0, 0], [0.52, 0], [0.56, 0.12], [0.74, 0.32], [0.76, 0.4], [0, 0.4]], 16);
          k.inst('rom:colcap', 'travertine', capG, F.clone().multiply(M(u, y0 + 0.4 + shaftH - 0.4, 0.05)));
          k.box('travertine', 1.7, 0.32, 0.9, F.clone().multiply(M(u, y0 + h - 0.38, 0.25)));
        } else {
          k.box('travertine', 1.0, h - 0.4, 0.3, F.clone().multiply(M(u, y0 + (h - 0.4) / 2, 0.15)));
          k.box('travertine', 1.3, 0.35, 0.42, F.clone().multiply(M(u, y0 + h - 0.6, 0.21)));
          k.box('travertine', 1.3, 0.3, 0.4, F.clone().multiply(M(u, y0 + 0.15, 0.2)));
        }
      }
    }
  };

  const h1 = 9.6;
  arcade(y, h1, { w: 3.1, y0: 0.02, ys: 6.0 }, 'column');
  y += h1;
  // Entablature between the storeys.
  k.add('travertine', squareSweep(a, [[-1, y], [0.25, y], [0.25, y + 0.55], [0.15, y + 0.6], [0.15, y + 1.0], [0.55, y + 1.15], [0.6, y + 1.45], [-1, y + 1.45]]));
  y += 1.45;
  const h2 = 7.2;
  arcade(y, h2, { w: 2.6, y0: 0.9, ys: 4.4 }, 'pilaster');
  y += h2;
  k.add('travertine', squareSweep(a, [[-1, y], [0.2, y], [0.2, y + 0.45], [0.5, y + 0.6], [0.55, y + 0.9], [-1, y + 0.9]]));
  y += 0.9;

  // Attic: solid, with small square lights and pilaster strips over the piers.
  const atticHalf = ROOT_TOP_HALF.roman;
  k.box('travertine', atticHalf * 2, H - y, atticHalf * 2, M(0, (y + H) / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, atticHalf);
    for (const u of us) pane(k, F, u, y + (H - y) * 0.45, 1.3, 0.9, 0.02, warmLight(rand, PANE_SILL, 0.5));
    for (let i = 1; i < bays; i++) k.box('travertine', 0.8, H - y - 0.5, 0.12, F.clone().multiply(M(-a + pitch * i, y + (H - y - 0.5) / 2, 0.06)));
  }
  k.add('travertine', squareSweep(atticHalf, [[-0.3, H - 0.5], [0.0, H - 0.5], [0.3, H - 0.3], [0.32, H], [-0.3, H]]));
};

// ---------------------------------------------------------------- Gothic

/**
 * Gothic: a limestone hall of tall lancets between stepped buttresses with
 * pinnacles, a rose window over a pointed portal on the two fronts, a
 * pierced parapet, and a set-back clerestory with corner turrets.
 */
const gothic: RootBuilder = (k, detail, rand) => {
  const H = ROOT_HEIGHT.gothic;
  const FOOT = 34;
  const a = FOOT / 2;
  let y = steps(k, 'gothic', [42, 40, 38], 0.45);
  // Base course with a chamfered weathering.
  k.add('gothic', squareSweep(a, [[-1, y], [0.45, y], [0.45, y + 0.7], [0.0, y + 1.1], [-1, y + 1.1]]));
  y += 1.1;

  const bodyH = 21.6;
  const depth = 1.1;
  k.box('slab', FOOT - 2 * depth - 0.2, bodyH, FOOT - 2 * depth - 0.2, M(0, y + bodyH / 2, 0));
  const lancet = (u: number): Opening => ({ u, w: 2.1, y0: 2.4, ys: 14.0, pointed: true });
  const frontLancets = [-14.0, -8.5, 8.5, 14.0].map(lancet);
  const sideLancets = [-13.6, -6.8, 0, 6.8, 13.6].map(lancet);
  const portal: Opening = { u: 0, w: 4.6, y0: 0.02, ys: 5.4, pointed: true };
  const roseY = 14.6;
  const roseR = 3.9;
  const rose: THREE.Vector2[] = Array.from({ length: 40 }, (_, i) => {
    const t = (i / 40) * Math.PI * 2;
    return new THREE.Vector2(Math.cos(t) * roseR, roseY + Math.sin(t) * roseR);
  });

  for (let side = 0; side < 4; side++) {
    const front = side % 2 === 0;
    const lancets = front ? frontLancets : sideLancets;
    const L = front ? FOOT : FOOT - 2 * depth;
    const holes = [...lancets, ...(front ? [portal] : [])].map(outline);
    if (front) holes.push(rose);
    k.add('gothic', piercedWall(L, bodyH, depth, holes), face(side, a).multiply(M(0, y, -depth)));
    const F = face(side, a);
    for (const o of lancets) {
      const top = o.ys + o.w * Math.sin(Math.PI / 3);
      pane(k, F, o.u, y + (o.y0 + top) / 2, o.w + 0.2, top - o.y0 + 0.1, -depth - 0.05, warmLight(rand, PANE_SASH, 0.75));
      // Tracery: a central mullion and a quatrefoil eye in the head.
      k.inst('goth:mullion', 'gothic', unitBox, F.clone().multiply(M(o.u, y + (o.y0 + o.ys + 0.6) / 2, -depth / 2, 0, 0.16, o.ys + 0.6 - o.y0, 0.3)));
      if (detail) {
        const eye = (): THREE.BufferGeometry => new THREE.TorusGeometry(0.42, 0.07, 6, 20);
        k.inst('goth:eye', 'gothic', eye, F.clone().multiply(M(o.u, y + o.ys + 1.05, -depth / 2)));
      }
      // Hood mould over each lancet.
      k.box('gothic', o.w + 0.6, 0.22, 0.2, F.clone().multiply(M(o.u, y + o.y0 - 0.1, 0.1)));
    }
    if (front) {
      // Portal: lit doors deep in the arch, with a gable over it.
      pane(k, F, 0, y + 4.3, 4.8, 8.5, -depth - 0.05, paneData(1, 1, PANE_FULL));
      // Archivolts: three orders of pointed moulding stepping out round the portal.
      for (let o = 0; o < 3; o++) {
        const inner = portal.w + o * 0.7;
        const outer = inner + 0.5;
        const band = new THREE.Shape(pointedArch(0, outer, 0, portal.ys));
        band.holes.push(new THREE.Path(pointedArch(0, inner, 0.02, portal.ys)));
        k.add('gothic', new THREE.ExtrudeGeometry(band, { depth: 0.12 + o * 0.12, bevelEnabled: false, curveSegments: 12 }), F.clone().multiply(M(0, y, 0)));
      }
      // Rose window: stained glass behind radiating tracery.
      k.add('stained', new THREE.CircleGeometry(roseR + 0.1, 48), F.clone().multiply(M(0, y + roseY, -depth + 0.25)), false);
      for (let s = 0; s < 12; s++) {
        const t = (s / 12) * Math.PI;
        k.inst('goth:spoke', 'gothic', unitBox, F.clone().multiply(ME(0, y + roseY, -depth + 0.45, 0, 0, t, roseR * 2, 0.14, 0.24)));
      }
      const ringG = (r: number) => (): THREE.BufferGeometry => new THREE.TorusGeometry(r, 0.1, 6, 48);
      k.inst('goth:ring1', 'gothic', ringG(roseR * 0.42), F.clone().multiply(M(0, y + roseY, -depth + 0.45)));
      k.inst('goth:ring2', 'gothic', ringG(roseR * 0.78), F.clone().multiply(M(0, y + roseY, -depth + 0.45)));
      k.inst('goth:ring3', 'gothic', ringG(roseR + 0.05), F.clone().multiply(M(0, y + roseY, 0.05)));
    }
    // Drip course under the sills.
    k.box('gothic', L, 0.28, 0.24, F.clone().multiply(M(0, y + 2.2, 0.12)));
    // Buttresses between bays: three stages, each capped with a sloped weathering.
    const buttressUs = front ? [-11.3, -5.6, 5.6, 11.3] : [-10.2, -3.4, 3.4, 10.2];
    for (const u of buttressUs) buttress(k, F, u, y, bodyH, detail);
  }
  // Diagonal buttresses at the corners.
  for (let c = 0; c < 4; c++) {
    const C = M(0, 0, 0, (c * Math.PI) / 2 + Math.PI / 4).multiply(M(0, 0, a * Math.SQRT2 - 0.4));
    buttress(k, C, 0, y, bodyH, detail);
  }
  y += bodyH;

  // Pierced parapet over a corbel table.
  k.add('gothic', squareSweep(a, [[-1, y], [0.0, y], [0.3, y + 0.3], [0.3, y + 0.6], [-1, y + 0.6]]));
  const pTop = y + 0.6 + 1.3;
  for (let side = 0; side < 4; side++) {
    const L = side % 2 === 0 ? FOOT + 0.6 : FOOT + 0.6 - 0.7;
    const n = Math.floor(L / 1.4);
    const holes = Array.from({ length: n }, (_, i) => {
      const cx = -L / 2 + (L / n) * (i + 0.5);
      return Array.from({ length: 16 }, (_, j) => {
        const t = (j / 16) * Math.PI * 2;
        return new THREE.Vector2(cx + Math.cos(t) * 0.42, 0.65 + Math.sin(t) * 0.42);
      });
    });
    k.add('gothic', piercedWall(L, 1.3, 0.35, holes), face(side, a + 0.3).multiply(M(0, y + 0.6, -0.35)));
  }
  k.add('gothic', squareSweep(a + 0.3, [[-0.4, pTop], [0.06, pTop], [0.06, pTop + 0.18], [-0.4, pTop + 0.18]]));

  // Clerestory: a set-back storey of smaller lancets, octagonal turrets at the corners.
  const cHalf = ROOT_TOP_HALF.gothic;
  const cTop = H;
  const cBase = y;
  const cH = cTop - cBase - 1.0;
  const cDepth = 0.6;
  k.box('slab', cHalf * 2 - 2 * cDepth - 0.1, cTop - cBase, cHalf * 2 - 2 * cDepth - 0.1, M(0, (cBase + cTop) / 2, 0));
  const small = [-9.6, -4.8, 0, 4.8, 9.6].map((u): Opening => ({ u, w: 1.5, y0: 1.2, ys: 5.0, pointed: true }));
  for (let side = 0; side < 4; side++) {
    wall(k, 'gothic', side, cHalf, cBase, cH, cDepth, small);
    const F = face(side, cHalf);
    for (const o of small) {
      const top = o.ys + o.w * Math.sin(Math.PI / 3);
      pane(k, F, o.u, cBase + (o.y0 + top) / 2, o.w + 0.2, top - o.y0 + 0.1, -cDepth - 0.05, warmLight(rand, PANE_SASH, 0.8));
    }
  }
  k.add('gothic', squareSweep(cHalf, [[-0.5, cTop - 1.0], [0.0, cTop - 1.0], [0.25, cTop - 0.75], [0.25, cTop], [-0.5, cTop]]));
  for (let c = 0; c < 4; c++) {
    const C = M(0, 0, 0, (c * Math.PI) / 2 + Math.PI / 4).multiply(M(0, 0, cHalf * Math.SQRT2));
    const turret = new THREE.CylinderGeometry(1.25, 1.35, cTop - 2.6 - cBase, 8);
    k.add('gothic', turret, C.clone().multiply(M(0, cBase + (cTop - 2.6 - cBase) / 2, 0)));
    k.add('gothic', new THREE.CylinderGeometry(1.45, 1.45, 0.35, 8), C.clone().multiply(M(0, cTop - 2.6 + 0.17, 0)));
    k.add('gothic', new THREE.ConeGeometry(1.3, 2.25, 8), C.clone().multiply(M(0, cTop - 2.25 + 1.125, 0)));
  }
};

/** A stepped buttress at `u` on a face frame, with a pinnacle on top. */
function buttress(k: Kit, F: THREE.Matrix4, u: number, y0: number, h: number, detail: boolean): void {
  const stages: Array<[number, number, number]> = [
    [0, 0.42, 2.3],
    [0.42, 0.74, 1.7],
    [0.74, 1.0, 1.1],
  ];
  for (const [s0, s1, d] of stages) {
    const hh = (s1 - s0) * h;
    k.add('gothic', wedge(1.3, hh, d, Math.min(0.8, d * 0.45)), F.clone().multiply(M(u, y0 + s0 * h + hh / 2, d / 2)));
  }
  // Pinnacle: a square shaft with gablets, then a crocketed spire.
  const top = y0 + h;
  k.add('gothic', new THREE.BoxGeometry(0.95, 3.0, 0.95), F.clone().multiply(M(u, top + 1.5, 0.55)));
  k.add('gothic', new THREE.ConeGeometry(0.72, 3.4, 4).rotateY(Math.PI / 4), F.clone().multiply(M(u, top + 3.0 + 1.7, 0.55)));
  if (detail) {
    const crocket = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.16, 0.16, 0.32);
    for (let i = 0; i < 4; i++) {
      for (const c of [0, 1, 2, 3]) {
        const t = (i + 0.5) / 4.5;
        const r = 0.72 * (1 - t) * Math.SQRT1_2 + 0.12;
        const ang = (c * Math.PI) / 2;
        k.inst('goth:crocket', 'gothic', crocket, F.clone().multiply(M(u, top + 3.0 + t * 3.4, 0.55)).multiply(M(0, 0, 0, ang)).multiply(M(0, 0, r)));
      }
    }
  }
}

// ---------------------------------------------------------------- Pagoda

/**
 * Pagoda base: a battered granite platform, then two timber storeys of
 * vermilion posts, plaster and lit shoji under deep flared eaves of ribbed
 * clay tile with upturned corners, bracket sets under each eave and a
 * balcony with a railing where the tower begins.
 */
const pagoda: RootBuilder = (k, detail, rand) => {
  const H = ROOT_HEIGHT.pagoda;
  // Ishigaki: a battered dressed-granite platform with a cut-stone kerb.
  const platH = 4.4;
  k.add('granite', frustum(44, platH, 44, 40.5 / 44), M(0, platH / 2, 0));
  k.box('granite', 40.8, 0.35, 40.8, M(0, platH + 0.175, 0));
  // Steps up the middle of the front and back.
  for (const side of [0, 2]) {
    const F = face(side, 20.2);
    for (let s = 0; s < 8; s++) k.box('granite', 8, (s + 1) * 0.6, 0.55, F.clone().multiply(M(0, ((s + 1) * 0.6) / 2, 2.2 - s * 0.55 + 0.28 - 0.0)));
  }
  const y = platH + 0.35;

  const storey = (half: number, y0: number, h: number, prefix: string): void => {
    k.box('plaster', half * 2, h, half * 2, M(0, y0 + h / 2, 0));
    const posts = Math.round((half * 2) / 3.2);
    const pitch = (half * 2) / posts;
    for (let side = 0; side < 4; side++) {
      const F = face(side, half);
      for (let i = 0; i < posts; i++) {
        const u = -half + pitch * i;
        k.inst(`${prefix}:post`, 'timber', unitBox, F.clone().multiply(M(u, y0 + h / 2, 0.08, 0, 0.55, h, 0.55)));
        // Lit shoji between the posts, under a transom.
        const sw = pitch - 0.9;
        pane(k, F, u + pitch / 2, y0 + 0.9 + (h - 2.6) / 2, sw, h - 2.6, 0.03, warmLight(rand, PANE_SHOJI, 0.9));
        if (detail) {
          // Bracket set: three blocks stepping out under the eave.
          for (let b = 0; b < 3; b++) {
            k.inst(`${prefix}:bracket`, 'timber', unitBox, F.clone().multiply(M(u, y0 + h + 0.2 + b * 0.3, 0.3 + b * 0.3, 0, 0.5 - b * 0.04, 0.26, 0.6 + b * 0.5)));
          }
        }
      }
      // Corner post.
      k.inst(`${prefix}:post`, 'timber', unitBox, F.clone().multiply(M(half, y0 + h / 2, 0.08, 0, 0.6, h, 0.6)));
    }
    // Nuki tie beams.
    for (const t of [0.55, h - 1.2]) {
      k.add('timber', squareSweep(half, [[-0.2, y0 + t], [0.22, y0 + t], [0.22, y0 + t + 0.36], [-0.2, y0 + t + 0.36]]), undefined, false);
    }
    k.add('timber', squareSweep(half, [[-0.2, y0 + h], [0.3, y0 + h], [0.3, y0 + h + 1.1], [-0.2, y0 + h + 1.1]]), undefined, false);
  };

  // Lower storey and its eave.
  const h1 = 7.6;
  storey(16, y, h1, 'pag1');
  eave(k, { hIn: 14.4, yIn: 15.0, hOut: 21.6, yOut: 12.1, lift: 1.5, detail });
  // Upper storey and its eave.
  const y2 = 15.0;
  const h2 = 6.6;
  storey(14.5, y2, h2, 'pag2');
  eave(k, { hIn: 13.2, yIn: 24.4, hOut: 18.8, yOut: 22.1, lift: 1.25, detail });

  // Balcony where the tower begins: deck, railing, and the plastered footing of the shaft.
  const top = ROOT_TOP_HALF.pagoda;
  k.box('timber', (top + 1.6) * 2, 0.35, (top + 1.6) * 2, M(0, 24.4 + 0.175, 0));
  k.box('plaster', top * 2, H - 24.4, top * 2, M(0, (24.4 + H) / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, top);
    for (let i = 0; i < 7; i++) pane(k, F, -top + (top * 2 / 7) * (i + 0.5), 24.75 + (H - 24.75) / 2, 2.6, H - 24.75 - 0.6, 0.03, warmLight(rand, PANE_SHOJI, 0.85));
    const R = face(side, top + 1.45);
    for (let i = 0; i <= 14; i++) k.inst('pag:rail', 'timber', unitBox, R.clone().multiply(M(-top - 1.45 + ((top + 1.45) * 2 / 14) * i, 24.75 + 0.55, 0, 0, 0.18, 1.1, 0.18)));
  }
  k.add('timber', squareSweep(top + 1.45, [[-0.1, 25.9], [0.1, 25.9], [0.1, 26.1], [-0.1, 26.1]]), undefined, false);
  k.add('timber', squareSweep(top, [[-0.1, H - 0.4], [0.18, H - 0.4], [0.18, H], [-0.1, H]]), undefined, false);
};

interface EaveSpec {
  hIn: number;
  yIn: number;
  hOut: number;
  yOut: number;
  /** How far the corners turn up, metres. */
  lift: number;
  detail: boolean;
}

/**
 * A hipped eave round a square plan: a concave sweep from the wall out to a
 * thin edge whose corners turn up, laid in ribbed tile (round and pan tiles
 * running down the slope), with a timber soffit and fascia under it and
 * ridged hips with end tiles on the diagonals.
 */
function eave(k: Kit, e: EaveSpec): void {
  const S = 8;
  // Tile courses: round tiles over pan tiles, sampled exactly four times a course so the ribs never alias into waves.
  const COURSE = 0.36;
  const ribs = Math.round((e.hOut * 2) / COURSE);
  const N = e.detail ? ribs * 4 : 120;
  const PROFILE = [0, 0.65, 1, 0.65];
  const surface = (offset: number, ribbed: boolean): Array<(s: number, t: number, j?: number) => THREE.Vector3> =>
    [0, 1, 2, 3].map((side) => (s: number, t: number, j?: number) => {
      const half = e.hIn + (e.hOut - e.hIn) * s;
      const u = t * half;
      const corner = Math.pow(Math.max(0, (Math.abs(t) - 0.45) / 0.55), 2.2);
      let y = e.yIn + (e.yOut - e.yIn) * s - 0.55 * Math.sin(Math.PI * s) * (1 - s * 0.4) + e.lift * corner * s * s + offset;
      if (ribbed && j !== undefined) y += 0.085 * PROFILE[j % 4] * (1 - corner * 0.6);
      const r = (side * Math.PI) / 2;
      return new THREE.Vector3(u * Math.cos(r) + half * Math.sin(r), y, -u * Math.sin(r) + half * Math.cos(r));
    });
  const grid = (fs: Array<(s: number, t: number, j?: number) => THREE.Vector3>, flip: boolean, N: number): THREE.BufferGeometry => {
    const pos: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (const f of fs) {
      for (let i = 0; i <= S; i++) for (let j = 0; j <= N; j++) {
        const p = f(i / S, (j / N) * 2 - 1, j);
        pos.push(p.x, p.y, p.z);
      }
      for (let i = 0; i < S; i++) for (let j = 0; j < N; j++) {
        const a = base + i * (N + 1) + j;
        const b = a + 1;
        const c = a + (N + 1);
        const d = c + 1;
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
      base += (S + 1) * (N + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  // Only the tiled face needs a vertex per rib; the soffit and fascia are smooth.
  const SMOOTH = 120;
  k.add('roofTile', grid(surface(0, e.detail), false, N), undefined, false);
  k.add('timber', grid(surface(-0.32, false), true, SMOOTH), undefined, false);
  // Fascia: a timber board along the edge, following the upturn.
  const edge = surface(0, false);
  const pos: number[] = [];
  const idx: number[] = [];
  let b = 0;
  for (const f of edge) {
    for (let j = 0; j <= SMOOTH; j++) {
      const p = f(1, (j / SMOOTH) * 2 - 1);
      pos.push(p.x, p.y + 0.02, p.z, p.x, p.y - 0.42, p.z);
    }
    for (let j = 0; j < SMOOTH; j++) {
      const a = b + j * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    b += (SMOOTH + 1) * 2;
  }
  const fascia = new THREE.BufferGeometry();
  fascia.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fascia.setIndex(idx);
  fascia.computeVertexNormals();
  k.add('timber', fascia, undefined, false);
  // Hips: a ridge of stacked tile along each diagonal, ending in an upswept end tile.
  const top = surface(0, false);
  for (let c = 0; c < 4; c++) {
    const f = top[c];
    const segs = 10;
    for (let i = 0; i < segs; i++) {
      const p0 = f(i / segs, 1);
      const p1 = f((i + 1) / segs, 1);
      const mid = p0.clone().lerp(p1, 0.5);
      const len = p0.distanceTo(p1);
      const m = new THREE.Matrix4().lookAt(p0, p1, new THREE.Vector3(0, 1, 0));
      m.setPosition(mid.x, mid.y + 0.16, mid.z);
      k.add('roofTile', new THREE.BoxGeometry(0.42, 0.34, len + 0.04), m, false);
    }
    const end = f(1, 1);
    k.add('roofTile', new THREE.BoxGeometry(0.6, 0.7, 0.6), M(end.x, end.y + 0.42, end.z, (c * Math.PI) / 2 + Math.PI / 4), false);
  }
  // Rafter ends under the eave.
  if (e.detail) {
    const under = surface(-0.32, false);
    for (let side = 0; side < 4; side++) {
      const n = Math.floor((e.hOut * 2) / 0.6);
      for (let j = 1; j < n; j++) {
        const t = (j / n) * 2 - 1;
        const p0 = under[side](0.84, t);
        const p1 = under[side](1.0, t);
        const mid = p0.clone().lerp(p1, 0.5);
        const m = new THREE.Matrix4().lookAt(p0, p1, new THREE.Vector3(0, 1, 0));
        m.setPosition(mid.x, mid.y - 0.16, mid.z);
        m.scale(new THREE.Vector3(0.16, 0.2, p0.distanceTo(p1)));
        k.inst('pag:rafter', 'timber', unitBox, m);
      }
    }
  }
}

// ---------------------------------------------------------------- Chicago

/**
 * Chicago: a Richardsonian base of rock-faced rusticated limestone with a
 * tall round-arched entrance under voussoirs, then two storeys of Chicago
 * windows between piers, a heavy cornice on modillions and a parapet.
 */
const chicago: RootBuilder = (k, detail, rand) => {
  const H = ROOT_HEIGHT.chicago;
  const FOOT = 36;
  const a = FOOT / 2;
  let y = steps(k, 'granite', [42, 40], 0.45);
  k.box('granite', FOOT + 0.8, 0.7, FOOT + 0.8, M(0, y + 0.35, 0));
  y += 0.7;

  // Rusticated base: arched windows all round, the grand entrance on the two fronts.
  const baseH = 8.6;
  const depth = 1.3;
  const grand: Opening = { u: 0, w: 7.0, y0: 0.02, ys: 4.6, ring: 1.2 };
  const side5 = [-14, -7, 0, 7, 14].map((u): Opening => ({ u, w: 2.8, y0: 1.2, ys: 4.6, ring: 0.75 }));
  const front4 = [-14, -8.2, 8.2, 14].map((u): Opening => ({ u, w: 2.8, y0: 1.2, ys: 4.6, ring: 0.75 }));
  const baseCore = 2 * (a - 0.2 - depth - 0.1);
  k.box('slab', baseCore, baseH, baseCore, M(0, y + baseH / 2, 0));
  for (let side = 0; side < 4; side++) {
    const front = side % 2 === 0;
    const openings = front ? [...front4, grand] : side5;
    wall(k, 'limestone', side, a - 0.2, y, baseH, depth, openings);
    rusticate(k, 'limestone', side, a - 0.2, y, baseH, 0.95, 0.2, openings);
    const F = face(side, a - 0.2);
    for (const o of openings) {
      const big = o === grand;
      voussoirs(k, 'limestone', F, o, y, 0.28, big ? 17 : 9, big ? 1.2 : 0.75);
      const top = o.ys + o.w / 2;
      pane(k, F, o.u, y + (o.y0 + top) / 2, o.w + 0.2, top - o.y0 + 0.1, -depth - 0.05, big ? paneData(1, 1, PANE_FULL) : warmLight(rand, PANE_SASH, 0.8));
    }
  }
  y += baseH;

  // String course.
  k.add('limestone', squareSweep(a, [[-1, y], [0.1, y], [0.25, y + 0.2], [0.25, y + 0.6], [0.1, y + 0.8], [-1, y + 0.8]]));
  y += 0.8;

  // Two storeys of Chicago windows between piers.
  const upperH = 11.6;
  const recess = 0.5;
  const bays = 6;
  const pitch = FOOT / bays;
  k.box('slab', FOOT - 2 * recess, upperH, FOOT - 2 * recess, M(0, y + upperH / 2, 0));
  const storeyH = upperH / 2;
  for (let side = 0; side < 4; side++) {
    const F = face(side, a);
    for (let i = 0; i <= bays; i++) {
      const u = -a + pitch * i;
      const w = i === 0 || i === bays ? 2.0 : 1.4;
      const uu = i === 0 ? u + w / 2 : i === bays ? u - w / 2 : u;
      k.box('limestone', w, upperH, recess + 0.35, F.clone().multiply(M(uu, y + upperH / 2, (0.35 - recess) / 2)));
    }
    for (let s = 0; s < 2; s++) {
      const sy = y + s * storeyH;
      for (let i = 0; i < bays; i++) {
        const u = -a + pitch * (i + 0.5);
        const clear = pitch - 1.4;
        // Spandrel panel under the window, a sill on top of it.
        k.box('limestone', clear, 1.2, recess - 0.08, F.clone().multiply(M(u, sy + 0.6, -recess / 2 - 0.04)));
        k.box('limestone', clear + 0.1, 0.16, 0.3, F.clone().multiply(M(u, sy + 1.25, -recess + 0.15)));
        const wh = storeyH - 1.7;
        const wy = sy + 1.33 + wh / 2;
        // Tripartite: a wide fixed light flanked by narrow sashes, in dark steel frames.
        const side_w = clear * 0.22;
        const mid_w = clear - 2 * side_w;
        pane(k, F, u, wy, mid_w - 0.1, wh, -recess + 0.02, warmLight(rand, PANE_SILL, 0.65));
        pane(k, F, u - (mid_w + side_w) / 2, wy, side_w - 0.1, wh, -recess + 0.02, warmLight(rand, PANE_SASH, 0.65));
        pane(k, F, u + (mid_w + side_w) / 2, wy, side_w - 0.1, wh, -recess + 0.02, warmLight(rand, PANE_SASH, 0.65));
        for (const m of [-mid_w / 2, mid_w / 2]) k.inst('chi:mullion', 'steel', unitBox, F.clone().multiply(M(u + m, wy, -recess + 0.06, 0, 0.14, wh, 0.12)));
        k.box('limestone', clear, storeyH - 1.33 - wh, recess - 0.08, F.clone().multiply(M(u, sy + storeyH - (storeyH - 1.33 - wh) / 2, -recess / 2 - 0.04)));
      }
    }
  }
  y += upperH;

  // Cornice on modillions, then a parapet.
  const c0 = y;
  k.add('limestone', squareSweep(a, [[-1, c0], [0.35, c0], [0.35, c0 + 0.5], [0.55, c0 + 0.6], [0.55, c0 + 0.9], [-1, c0 + 0.9]]));
  if (detail) {
    const mod = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.35, 0.42, 1.0);
    for (let side = 0; side < 4; side++) {
      const F = face(side, a + 0.55);
      const n = Math.floor((FOOT + 1) / 1.0);
      for (let i = 0; i < n; i++) k.inst('chi:modillion', 'limestone', mod, F.clone().multiply(M(-a - 0.5 + 0.5 + i * 1.0, c0 + 1.11, 0.5)));
    }
  }
  k.add('limestone', squareSweep(a, [[-1, c0 + 1.32], [1.6, c0 + 1.32], [1.6, c0 + 1.72], [1.75, c0 + 1.82], [1.7, c0 + 2.0], [-1, c0 + 2.0]]));
  k.box('limestone', FOOT - 0.9, H - c0 - 2.0, FOOT - 0.9, M(0, (c0 + 2.0 + H) / 2, 0));
  k.add('limestone', squareSweep(a - 0.45, [[-0.5, H - 0.25], [0.12, H - 0.25], [0.12, H], [-0.5, H]]));
};

export const ROOT_BUILDERS: Record<RootStyle, RootBuilder> = { beauxarts, roman, gothic, pagoda, chicago };
