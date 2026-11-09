import * as THREE from 'three';

import type { Era, Floor } from '../../../../shared/types.js';
import {
  face,
  Kit,
  M,
  ME,
  type MatKey,
  PANE_FULL,
  PANE_SASH,
  paneData,
  paneGeometry,
  squareSweep,
  unitBox,
} from './kit.js';

/** Where a floor sits in its tower and in its run of same-era floors. */
export interface FloorContext {
  /** Index in the tower, from 0 at the root. */
  index: number;
  /** Index within the current run of same-era floors. */
  inRun: number;
  /** The floor below is a different era (or the root). */
  runStart: boolean;
  /** The floor above is a different era, or this is the top. */
  runEnd: boolean;
  /** The tower's top floor. */
  top: boolean;
  /** The last floor below the datum line: its run-end cap is left off so the datum band reads clean. */
  datum: boolean;
  rand: () => number;
}

/** What a floor builder reports back: its plan centre and half-width (for the pick proxy), and where a datum band at its top would sit clear of its facade. */
export interface FloorShape {
  cx: number;
  cz: number;
  half: number;
  datumHalf: number;
  /** When set, the datum band follows this rectangle ([x0, x1, z0, z1], at the floor's slab edge) instead of a square. */
  datumRect?: [number, number, number, number];
}

/**
 * Builds one floor in the frame of the kit's current base (its slab at y=0),
 * `width` across and `height` tall, without reaching above `height`.
 */
export type EraBuilder = (k: Kit, width: number, height: number, floor: Floor, ctx: FloorContext) => FloorShape;

/** How many windows of a floor are lit, and how warm, by era. */
const LIGHTING: Record<Era, { lit: number; warm: number }> = {
  stone: { lit: 0.5, warm: 0.92 },
  brick: { lit: 0.55, warm: 0.85 },
  glass: { lit: 0.8, warm: 0.55 },
  titanium: { lit: 0.55, warm: 0.15 },
  scifi: { lit: 0.92, warm: 0.5 },
};

/** Per-window light: whole floors go dark now and then; the rest light by chance, warm or cool. */
function lighter(era: Era, rand: () => number): (style: number) => THREE.Color {
  const { lit, warm } = LIGHTING[era];
  const floorOn = rand() > 0.12;
  const floorWarm = rand() < warm;
  // Lights run in groups along a floor (one tenant, one open office), not pane by pane.
  let on = rand() < lit;
  return (style) => {
    if (rand() > 0.72) on = rand() < lit;
    on = on && floorOn;
    const level = on ? 0.45 + 0.55 * rand() : rand() * 0.06;
    const w = rand() < 0.85 ? (floorWarm ? 1 : 0) : rand();
    return paneData(level, w, style);
  };
}

/**
 * The thin warm accent at the slab edge of a floor Claude co-authored: a
 * strip `tall` metres high standing `proud` metres clear of the face at
 * `half`, so it reads as its own line rather than hiding in a moulding.
 */
function claudeAccent(k: Kit, floor: Floor, half: number, y: number, proud = 0.1, tall = 0.1): void {
  if (!floor.claude) return;
  k.add('accent', squareSweep(half, [
    [-0.05, y],
    [proud, y],
    [proud, y + tall],
    [-0.05, y + tall],
  ]));
}

function bays(width: number, bay: number): number {
  return Math.max(3, Math.round(width / bay));
}

// ---------------------------------------------------------------- masonry

interface MasonryStyle {
  wall: MatKey;
  trim: MatKey;
  bay: number;
  winW: number;
  /** Window height as a fraction of the floor. */
  winH: number;
  reveal: number;
  style: number;
}

/**
 * A load-bearing wall: piers between deep punched openings, solid spandrels
 * above and below, the glass set back the full reveal so each opening holds
 * real shadow. Sills project; heads carry a lintel or a hood.
 */
function masonry(k: Kit, width: number, h: number, floor: Floor, c: FloorContext, s: MasonryStyle): FloorShape {
  const half = width / 2;
  const n = bays(width, s.bay);
  const pitch = width / n;
  const winW = Math.min(s.winW, pitch * 0.62);
  const sillY = Math.max(0.75, h * 0.2);
  const headY = Math.min(h - 0.55, sillY + h * s.winH);
  const winH = headY - sillY;
  const light = lighter(floor.era, c.rand);
  const r = s.reveal;

  // The building behind the openings.
  k.box('slab', width - 2 * r, h, width - 2 * r, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    // Spandrels run the full face; piers stand between the openings.
    k.box(s.wall, width, sillY, r, F.clone().multiply(M(0, sillY / 2, -r / 2)));
    k.box(s.wall, width, h - headY, r, F.clone().multiply(M(0, (headY + h) / 2, -r / 2)));
    for (let i = 0; i <= n; i++) {
      const u = -half + pitch * i;
      const a = Math.max(-half, u - (pitch - winW) / 2);
      const b = Math.min(half, u + (pitch - winW) / 2);
      k.box(s.wall, b - a, winH, r, F.clone().multiply(M((a + b) / 2, sillY + winH / 2, -r / 2)));
    }
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(u, sillY + winH / 2, -r + 0.02, 0, winW, winH, 1)), light(s.style), false);
      // Sill, projecting and weathered.
      k.box(s.trim, winW + 0.32, 0.16, r + 0.16, F.clone().multiply(M(u, sillY - 0.08, -r / 2 + 0.08)));
      if (s.wall === 'brick') {
        // Stone lintel flush with the brick, a little proud.
        k.box(s.trim, winW + 0.5, 0.42, 0.08, F.clone().multiply(M(u, headY + 0.21, 0.04)));
      } else if ((floor.size !== 'small' || c.inRun % 2 === 0) && headY + 0.5 < h) {
        // A hood moulding over each window.
        k.box(s.trim, winW + 0.5, 0.18, 0.22, F.clone().multiply(M(u, headY + 0.24, 0.11)));
        k.box(s.trim, winW + 0.34, 0.12, 0.12, F.clone().multiply(M(u, headY + 0.1, 0.06)));
      }
    }
  }

  if (s.wall === 'brick') {
    // Stone quoins at the corners, long and short in alternate courses.
    for (let side = 0; side < 4; side++) {
      const F = face(side, half);
      for (let q = 0; q < 2; q++) {
        const long = (c.index + q + side) % 2 === 0;
        const L = long ? 1.1 : 0.7;
        const qh = h / 2 - 0.06;
        k.box(s.trim, L, qh, 0.06, F.clone().multiply(M(half - L / 2, q * (h / 2) + qh / 2 + 0.03, 0.03)));
      }
    }
    if (c.runStart || c.inRun % 4 === 0) {
      k.add(s.trim, squareSweep(half, [[-0.05, 0], [0.06, 0], [0.06, 0.32], [-0.05, 0.32]]));
    }
  } else {
    // A string course at every slab, so the floors read as laid courses.
    k.add(s.trim, squareSweep(half, [[-0.05, 0], [0.1, 0], [0.1, 0.22], [0.04, 0.3], [-0.05, 0.3]]));
  }

  // On the string course's upper face (stone) or just above the soldier course (brick), standing clear of both.
  claudeAccent(k, floor, half, s.wall === 'brick' ? 0.32 : 0.3, 0.12, 0.1);

  if (c.runEnd && !c.datum) {
    // A cornice closes the run: bed moulding, corona, cymatium, all inside the floor's height.
    const y0 = h - 0.95;
    k.add(s.trim, squareSweep(half, [
      [-0.1, y0],
      [0.0, y0],
      [0.18, y0 + 0.18],
      [0.24, y0 + 0.3],
      [0.62, y0 + 0.38],
      [0.66, y0 + 0.62],
      [0.75, y0 + 0.7],
      [0.82, y0 + 0.86],
      [0.82, h],
      [-0.1, h],
    ]));
  }
  return { cx: 0, cz: 0, half: half + 0.3, datumHalf: half + 0.12 };
}

const stone: EraBuilder = (k, w, h, f, c) =>
  masonry(k, w, h, f, c, { wall: 'sand', trim: 'sand', bay: 3.6, winW: 1.55, winH: 0.56, reveal: 0.55, style: PANE_SASH });

const brick: EraBuilder = (k, w, h, f, c) =>
  masonry(k, w, h, f, c, { wall: 'brick', trim: 'sand', bay: 2.9, winW: 1.5, winH: 0.58, reveal: 0.34, style: PANE_SASH });

// ---------------------------------------------------------------- glass

/** Curtain wall: floor-height glazing over a lit office, bronze mullions, a dark spandrel at each slab. */
const glass: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const n = bays(w, 1.55);
  const pitch = w / n;
  const sb = 0.7;
  const light = lighter(f.era, c.rand);
  k.box('slab', w - 0.7, h, w - 0.7, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    // Spandrel band: bronze-framed dark panel hiding the slab.
    k.inst('spandrel', 'steel', unitBox, F.clone().multiply(M(0, sb / 2, -0.02, 0, w, sb, 0.12)));
    k.inst('transom', 'bronze', unitBox, F.clone().multiply(M(0, sb, 0.05, 0, w + 0.18, 0.1, 0.22)));
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(u, (sb + h) / 2, 0, 0, pitch, h - sb, 1)), light(PANE_FULL), false);
    }
    for (let i = 0; i <= n; i++) {
      const u = -half + pitch * i;
      k.inst('mullion', 'bronze', unitBox, F.clone().multiply(M(u, h / 2, 0.14, 0, 0.1, h, 0.3)));
    }
  }
  claudeAccent(k, f, half, sb - 0.14, 0.32, 0.1);
  if (c.runEnd && !c.datum) {
    k.add('bronze', squareSweep(half, [[-0.2, h - 0.6], [0.3, h - 0.6], [0.3, h], [-0.2, h]]));
  }
  return { cx: 0, cz: 0, half: half + 0.3, datumHalf: half + 0.3 };
};

// ---------------------------------------------------------------- titanium

/** A blade fin: an elliptical section 0.5 m thick and 1.3 m deep, 1 m tall and centred; its faces curve enough to sweep the sky's gradient. */
function blade(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 28, 1);
  g.scale(0.25, 1, 0.65);
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Titanium cladding varies panel to panel (rolling batch, oxide film): a small tone and hue shift per fin. */
function panelTone(rand: () => number): THREE.Color {
  const v = 0.78 + 0.3 * rand();
  const hue = (rand() - 0.5) * 0.08;
  return new THREE.Color(v * (1 + hue), v, v * (1 - hue));
}

/**
 * Titanium: dark brushed blade fins with a curved section, angled a few
 * degrees either way so neighbours take different slices of the dusk sky,
 * a rounded titanium slab nose, and deep-set dark glass; the run twists as
 * it rises.
 */
const titanium: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const n = bays(w, 2.0);
  const pitch = w / n;
  const edge = 0.55;
  const light = lighter(f.era, c.rand);
  k.box('slab', w - 1.2, h, w - 1.2, M(0, h / 2, 0));
  // A dark graphite slab edge with small chamfers: it frames each floor without becoming a lit strip.
  k.add('graphite', squareSweep(half, [[-0.6, 0], [0.3, 0], [0.38, 0.07], [0.38, edge - 0.07], [0.3, edge], [-0.6, edge]]));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(u, (edge + h) / 2, -0.4, 0, pitch, h - edge, 1)), light(PANE_FULL), false);
    }
    for (let i = 1; i < n; i++) {
      const u = -half + pitch * i;
      const a = (i % 2 === 0 ? 1 : -1) * 0.14;
      k.inst('blade', 'titanium', blade, F.clone().multiply(M(u, (edge + h) / 2, 0.32, a, 1, h - edge, 1)), panelTone(c.rand));
    }
    k.inst('blade', 'titanium', blade, F.clone().multiply(M(half - 0.12, (edge + h) / 2, 0.32, 0, 1, h - edge, 1)), panelTone(c.rand));
  }
  claudeAccent(k, f, half + 0.38, edge / 2 - 0.05, 0.1, 0.1);
  if (c.runEnd && !c.datum) {
    k.add('graphite', squareSweep(half, [[-0.6, h - 0.45], [0.75, h - 0.45], [0.8, h - 0.4], [0.8, h], [-0.6, h]]));
  }
  return { cx: 0, cz: 0, half: half + 1, datumHalf: half + 1.0 };
};

// ---------------------------------------------------------------- sci-fi

/** An axis-aligned box from two corners, in the kit's current frame. */
function slabBox(k: Kit, mat: MatKey, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  k.box(mat, x1 - x0, y1 - y0, z1 - z0, M((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
}

/** A thin rectangular ring of `mat` (lines `t` wide) round the rectangle [x0,x1] x [z0,z1]. */
function ring(k: Kit, mat: MatKey, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, t: number): void {
  slabBox(k, mat, x0, x1, y0, y1, z1 - t, z1);
  slabBox(k, mat, x0, x1, y0, y1, z0, z0 + t);
  slabBox(k, mat, x1 - t, x1, y0, y1, z0 + t, z1 - t);
  slabBox(k, mat, x0, x0 + t, y0, y1, z0 + t, z1 - t);
}

/**
 * Sci-fi: a glass core inside a graphite diagrid exoskeleton, on deep
 * titanium slabs that cantilever past the frame. Slabs run in blocks of
 * three, each block throwing a deep terrace out on a different side, so the
 * stack reads as cantilevered trays. Light is part of the build: a warm line
 * in the reveal between the slab's two fascia bands and a downlight line
 * set in each soffit. The top floor opens into a crown: the diagrid rises
 * free round a small glass pavilion under a thin canopy.
 */
const scifi: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const core = Math.max(4, half - 2.2);
  const deep = Math.floor(c.inRun / 3) % 4;
  // Outward reach of the slab past the glass on each side: +z, +x, -z, -x.
  const ext = [0, 1, 2, 3].map((s) => (s === deep ? 3.6 : 1.5));
  const x0 = -(core + ext[3]);
  const x1 = core + ext[1];
  const z0 = -(core + ext[2]);
  const z1 = core + ext[0];
  const slab = 0.95;

  // Slab: two titanium fascia bands with a recessed light reveal between them, a concrete core.
  slabBox(k, 'titanium', x0, x1, 0, 0.42, z0, z1);
  slabBox(k, 'slab', x0 + 0.12, x1 - 0.12, 0.42, 0.52, z0 + 0.12, z1 - 0.12);
  ring(k, 'lightLine', x0 + 0.1, x1 - 0.1, z0 + 0.1, z1 - 0.1, 0.45, 0.49, 0.04);
  slabBox(k, 'titanium', x0, x1, 0.52, slab, z0, z1);
  // Downlight line set into the soffit, a little in from the edge.
  if (!c.runStart) ring(k, 'lightLine', x0 + 0.45, x1 - 0.45, z0 + 0.45, z1 - 0.45, -0.025, 0, 0.06);
  if (f.claude) ring(k, 'accent', x0 - 0.03, x1 + 0.03, z0 - 0.03, z1 + 0.03, slab, slab + 0.08, 0.1);

  const light = lighter(f.era, c.rand);
  const top = c.top ? h - 0.5 : h;
  // The glass: the full core on ordinary floors, a small pavilion on the crown.
  const glassHalf = c.top ? core * 0.55 : core;
  k.box('slab', glassHalf * 2 - 0.8, top - slab, glassHalf * 2 - 0.8, M(0, (slab + top) / 2, 0));
  const nb = Math.max(2, Math.round((glassHalf * 2) / 1.7));
  const bw = (glassHalf * 2) / nb;
  for (let side = 0; side < 4; side++) {
    const F = face(side, glassHalf);
    for (let i = 0; i < nb; i++) {
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(-glassHalf + bw * (i + 0.5), (slab + top) / 2, 0, 0, bw, top - slab, 1)), light(PANE_FULL), false);
    }
    for (let i = 0; i <= nb; i++) {
      k.inst('sf:mullion', 'graphite', unitBox, F.clone().multiply(M(-glassHalf + bw * i, (slab + top) / 2, 0.06, 0, 0.07, top - slab, 0.14)));
    }
  }

  // Diagrid exoskeleton, 0.6 m outside the glass line: each floor's nodes sit half a module along from the floor
  // below's, so the members form diamonds two storeys tall.
  const frame = core + 0.6;
  const modules = Math.max(2, Math.round((frame * 2) / 5));
  const p = (frame * 2) / modules;
  const off = (c.inRun % 2) * (p / 2);
  const rise = top - slab;
  for (let side = 0; side < 4; side++) {
    const F = face(side, frame);
    for (let j = -1; j <= modules + 1; j++) {
      const u = -frame + off + j * p;
      if (u < -frame - 1e-6 || u > frame + 1e-6) continue;
      for (const dir of [-1, 1]) {
        const u1 = u + dir * (p / 2);
        if (u1 < -frame - 1e-6 || u1 > frame + 1e-6) continue;
        const dx = u1 - u;
        const len = Math.hypot(dx, rise);
        k.inst('sf:diagrid', 'graphite', unitBox, F.clone().multiply(ME((u + u1) / 2, slab + rise / 2, 0, 0, 0, -Math.atan2(dx, rise), 0.34, len, 0.46)));
      }
    }
    // Corner mast where two faces of the frame meet.
    k.inst('sf:mast', 'graphite', unitBox, F.clone().multiply(M(frame, slab + rise / 2, 0, 0, 0.6, rise, 0.6)));
  }

  if (c.top) {
    // Crown canopy over the frame, with its own soffit downlight.
    const ch = frame + 0.25;
    slabBox(k, 'titanium', -ch, ch, h - 0.5, h, -ch, ch);
    ring(k, 'lightLine', -ch + 0.35, ch - 0.35, -ch + 0.35, ch - 0.35, h - 0.525, h - 0.5, 0.06);
  }
  const reach = Math.max(...ext) + core;
  // On an ordinary floor the datum runs along the slab edge, clear of the diagrid; on the crown it wraps the canopy.
  return { cx: 0, cz: 0, half: reach + 0.1, datumHalf: frame + 0.25, datumRect: c.top ? undefined : [x0, x1, z0, z1] };
};

export const ERA_BUILDERS: Record<Era, EraBuilder> = { stone, brick, glass, titanium, scifi };

/** Each run of titanium floors twists a little per floor (radians). */
export const TITANIUM_TWIST = 0.012;
