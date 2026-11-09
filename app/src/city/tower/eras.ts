import * as THREE from 'three';

import type { Era, Floor } from '../../../../shared/types.js';
import {
  face,
  Kit,
  M,
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
  rand: () => number;
}

/** What a floor builder reports back: its plan centre and half-width, for the pick proxy. */
export interface FloorShape {
  cx: number;
  cz: number;
  half: number;
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
  titanium: { lit: 0.75, warm: 0.3 },
  scifi: { lit: 0.85, warm: 0.15 },
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

/** The thin warm accent at the slab edge of a floor Claude co-authored. */
function claudeAccent(k: Kit, floor: Floor, half: number, y: number): void {
  if (!floor.claude) return;
  k.add('accent', squareSweep(half, [
    [-0.05, y],
    [0.015, y],
    [0.015, y + 0.07],
    [-0.05, y + 0.07],
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

  claudeAccent(k, floor, half + (s.wall === 'brick' ? 0.06 : 0.1), 0.08);

  if (c.runEnd) {
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
  return { cx: 0, cz: 0, half: half + 0.3 };
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
  claudeAccent(k, f, half + 0.18, sb - 0.12);
  if (c.runEnd) {
    k.add('bronze', squareSweep(half, [[-0.2, h - 0.6], [0.3, h - 0.6], [0.3, h], [-0.2, h]]));
  }
  return { cx: 0, cz: 0, half: half + 0.3 };
};

// ---------------------------------------------------------------- titanium

/** Titanium: deep blade fins angled to catch the sky, a titanium slab edge, recessed glass; the run twists as it rises. */
const titanium: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const n = bays(w, 2.0);
  const pitch = w / n;
  const edge = 0.5;
  const light = lighter(f.era, c.rand);
  k.box('slab', w - 1.2, h, w - 1.2, M(0, h / 2, 0));
  k.add('titanium', squareSweep(half, [[-0.6, 0], [0.32, 0], [0.4, 0.06], [0.4, edge - 0.06], [0.32, edge], [-0.6, edge]]));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(u, (edge + h) / 2, -0.35, 0, pitch, h - edge, 1)), light(PANE_FULL), false);
    }
    for (let i = 1; i < n; i++) {
      const u = -half + pitch * i;
      // Fins alternate a few degrees either way, so neighbours take different slices of the sky.
      const a = (i % 2 === 0 ? 1 : -1) * 0.16;
      k.inst('fin', 'titanium', unitBox, F.clone().multiply(M(u, (edge + h) / 2, 0.3, a, 0.2, h - edge, 1.25)));
    }
    // Corner fins, set square.
    k.inst('fin', 'titanium', unitBox, F.clone().multiply(M(half - 0.1, (edge + h) / 2, 0.3, 0, 0.2, h - edge, 1.25)));
  }
  claudeAccent(k, f, half + 0.41, edge - 0.2);
  if (c.runEnd) {
    k.add('titanium', squareSweep(half, [[-0.6, h - 0.45], [0.55, h - 0.45], [0.55, h], [-0.6, h]]));
  }
  return { cx: 0, cz: 0, half: half + 1 };
};

// ---------------------------------------------------------------- sci-fi

/** Sci-fi: octagonal glass floors on titanium plates, stacked in cantilevered blocks of three, each plate edged with a line of light. */
const scifi: EraBuilder = (k, w, h, f, c) => {
  const block = Math.floor(c.inRun / 3);
  const shift = 2.6;
  const OFF: Array<[number, number]> = [[shift, 0], [0, shift], [-shift, 0], [0, -shift]];
  const [ox, oz] = c.inRun < 3 ? [0, 0] : OFF[block % 4];
  const base = k.base.clone();
  k.base = base.clone().multiply(M(ox, 0, oz));

  const flat = w / 2 - 0.4; // centre to face of the glass
  const R = flat / Math.cos(Math.PI / 8);
  const plate = 0.5;
  const light = lighter(f.era, c.rand);
  const octa = (r: number, hh: number, open = false): THREE.BufferGeometry => {
    const g = new THREE.CylinderGeometry(r, r, hh, 8, 1, open);
    g.rotateY(Math.PI / 8);
    return g;
  };
  k.add('slab', octa(R - 0.5, h - plate), M(0, plate + (h - plate) / 2, 0));
  k.add('titanium', octa(R + 0.75, plate), M(0, plate / 2, 0));
  k.add('lightLine', octa(R + 0.77, 0.05, true), M(0, 0.07, 0));
  const faceW = 2 * R * Math.sin(Math.PI / 8);
  for (let s = 0; s < 8; s++) {
    const F = M(0, 0, 0, (s * Math.PI) / 4).multiply(M(0, 0, flat));
    const panes = 3;
    for (let i = 0; i < panes; i++) {
      const u = -faceW / 2 + (faceW / panes) * (i + 0.5);
      k.inst('pane', 'window', paneGeometry, F.clone().multiply(M(u, (plate + h) / 2, 0, 0, faceW / panes, h - plate, 1)), light(PANE_FULL), false);
    }
    // A titanium rib at each corner of the octagon.
    const corner = M(0, 0, 0, (s * Math.PI) / 4 + Math.PI / 8).multiply(M(0, (plate + h) / 2, R + 0.05));
    k.inst('rib', 'titanium', unitBox, corner.multiply(M(0, 0, 0, 0, 0.3, h - plate, 0.3)));
  }
  if (f.claude) {
    k.add('accent', octa(R + 0.78, 0.07, true), M(0, plate - 0.12, 0));
  }
  k.base = base;
  return { cx: ox, cz: oz, half: R + 0.8 };
};

export const ERA_BUILDERS: Record<Era, EraBuilder> = { stone, brick, glass, titanium, scifi };

/** Each run of titanium floors twists a little per floor (radians). */
export const TITANIUM_TWIST = 0.012;
