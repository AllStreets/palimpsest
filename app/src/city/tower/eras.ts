import * as THREE from 'three';

import type { Era, Floor } from '../../../../shared/types.js';
import {
  face,
  frustum,
  Kit,
  lathe,
  M,
  ME,
  type MatKey,
  PANE_CHANNEL,
  PANE_FULL,
  PANE_SASH,
  paneData,
  rng,
  slot,
  squareSweep,
  unitBox,
} from './kit.js';
import { hasKit, kitPiece } from '../kits.js';
import type { Family, MasonryRhythm, Variant } from './variants.js';

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
  /** Floors above this one (0 on the top floor): the sci-fi families shape their last few. */
  fromTop: number;
  /** The last floor below the datum line: its run-end cap is left off so the datum band reads clean. */
  datum: boolean;
  rand: () => number;
  /** The repo's variant for this floor's era: its materials (through the era's slots) and its rhythm. */
  variant: Variant;
  /**
   * Set on the top floors of a sci-fi run that carry the family's crown
   * instead of storeys: `stage` 0 is the crown's first floor (it builds the
   * whole crown, `height` metres tall, up to the tower's top), later stages
   * build nothing of their own.
   */
  crown?: { stage: number; height: number };
  /** A floor finished and waiting on his review: built whole, every pane unlit. */
  asleep?: boolean;
}

/** What a floor builder reports back: its plan centre and half-width (for the pick proxy), and where a datum band at its top would sit clear of its facade. */
export interface FloorShape {
  cx: number;
  cz: number;
  half: number;
  datumHalf: number;
  /** A round plan: the datum wraps it as a ring. */
  round?: boolean;
  /**
   * Where the floor's own slab edge runs: the plan centre and half-width of
   * its face at the foot of the floor (a ring when `round`). An earned
   * floor's light line, or a waiting floor's bare concrete edge, is laid here.
   */
  edge: { cx: number; cz: number; half: number; round?: boolean };
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
function lighter(era: Era, rand: () => number, own?: { lit: number; warm: number }, asleep = false): (style: number) => THREE.Color {
  if (asleep) return (style) => paneData(0, 0, style);
  const { lit, warm } = own ?? LIGHTING[era];
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

/** Each masonry era's own rhythm, before a variant adjusts it. */
const MASONRY: Record<'stone' | 'brick', MasonryRhythm> = {
  stone: { bay: 3.6, winW: 1.55, winH: 0.56, reveal: 0.55, paired: false },
  brick: { bay: 2.9, winW: 1.5, winH: 0.58, reveal: 0.34, paired: false },
};

/** The pier between the two windows of a pair. */
const PAIR_PIER = 0.5;

/** The depth of the joints between the coursed blocks (kits.py JOINT): the wall behind them sits this far back. */
const JOINT = 0.05;
/** Coursed blocks: about this long (two to a kit course) and this tall per course. Glazed terracotta is laid in blocks; the other bricks in bands. */
const COURSE = { stone: { l: 2.8, h: 0.62 }, terracotta: { l: 2.4, h: 0.7 }, brick: { l: 6, h: 0.95 } };

/**
 * Lays coursed blocks (the Blender kit's courses, kits.py) over the wall
 * between u0..u1 and y0..y1 of face frame F: whole courses as near the
 * course height as fit, running bond (each course offset half a block from
 * the one below), a pier laid in alternate long and paired blocks. Brick is
 * banded instead: a deep channel every metre or so, no head joints, the
 * scan's own bricks between. The blocks carry their own tones; each course
 * takes a few percent of drift on top, a batch of stone from one bed.
 */
function coursing(k: Kit, era: 'stone' | 'brick', v: Variant, F: THREE.Matrix4, u0: number, u1: number, y0: number, y1: number, seed: number): void {
  const len = u1 - u0;
  const tall = y1 - y0;
  if (len < 0.2 || tall < 0.15) return;
  const banded = era === 'brick' && !v.id.includes('terracotta');
  const size = era === 'stone' ? COURSE.stone : banded ? COURSE.brick : COURSE.terracotta;
  const rows = Math.max(1, Math.round(tall / size.h));
  const ch = tall / rows;
  const mat = slot(era, 'Face');
  const pier = len < size.l * 0.8;
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * ch;
    const n = Math.max(1, Math.round(len / size.l));
    const w = len / n;
    // A batch of stone from one bed: a course a few percent lighter or darker than its neighbours.
    const h1 = Math.sin((seed * 12.9898 + r * 78.233) * 1.7) * 43758.5453;
    const drift = 1 + 0.1 * ((h1 - Math.floor(h1)) - 0.5);
    const tone = new THREE.Color(drift, drift, drift);
    const piece = banded ? 'band_course' : pier ? ((r + seed) % 2 === 0 ? 'pier_block' : 'course_a') : (r + seed) % 2 === 0 ? 'course_a' : 'course_b';
    for (let i = 0; i < n; i++) {
      const u = u0 + w * (i + 0.5);
      k.instLod(`course:${era}:${piece}`, mat, () => kitPiece(`${piece}.hi`), () => kitPiece(`${piece}.lo`), F.clone().multiply(M(u, y, 0, 0, w, ch, 1)), tone);
    }
  }
}

/**
 * A load-bearing wall: piers between deep punched openings, solid spandrels
 * above and below, the glass set back the full reveal so each opening holds
 * real shadow. Sills project; heads carry a lintel or a hood. Windows come
 * singly or in pairs about a narrow pier, as the variant's rhythm says.
 */
function masonry(k: Kit, width: number, h: number, floor: Floor, c: FloorContext, era: 'stone' | 'brick'): FloorShape {
  const s: MasonryRhythm = { ...MASONRY[era], ...c.variant.masonry };
  const wall = slot(era, 'Wall');
  const trim = slot(era, 'Trim');
  const band = slot(era, 'Band');
  const isBrick = era === 'brick';
  const half = width / 2;
  const n = bays(width, s.bay);
  const pitch = width / n;
  const winW = s.paired ? Math.min(s.winW, (pitch * 0.66 - PAIR_PIER) / 2) : Math.min(s.winW, pitch * 0.62);
  const sillY = Math.max(0.75, h * 0.2);
  const headY = Math.min(h - 0.55, sillY + h * s.winH);
  const winH = headY - sillY;
  const light = lighter(floor.era, c.rand, c.variant.lights, c.asleep);
  const r = s.reveal;

  // Window centres along a face, left to right.
  const openings: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = -half + pitch * (i + 0.5);
    if (s.paired) openings.push(u - (winW + PAIR_PIER) / 2, u + (winW + PAIR_PIER) / 2);
    else openings.push(u);
  }

  // The building behind the openings.
  k.box('slab', width - 2 * r, h, width - 2 * r, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    // Spandrels run the full face; piers stand between the openings. Their faces sit a joint's depth back:
    // the coursed blocks laid over them (coursing, below) stand in front with their joints touching them.
    k.box(wall, width, sillY, r, F.clone().multiply(M(0, sillY / 2, -r / 2 - JOINT)));
    k.box(wall, width, h - headY, r, F.clone().multiply(M(0, (headY + h) / 2, -r / 2 - JOINT)));
    coursing(k, era, c.variant, F, -half, half, 0, sillY, c.index * 7 + side);
    coursing(k, era, c.variant, F, -half, half, headY, h, c.index * 7 + side + 3);
    for (let i = 0; i <= openings.length; i++) {
      const a = i === 0 ? -half : openings[i - 1] + winW / 2;
      const b = i === openings.length ? half : openings[i] - winW / 2;
      if (b - a > 1e-3) {
        k.box(wall, b - a, winH, r, F.clone().multiply(M((a + b) / 2, sillY + winH / 2, -r / 2 - JOINT)));
        coursing(k, era, c.variant, F, a, b, sillY, headY, c.index * 7 + side + i * 13);
      }
    }
    for (const [j, u] of openings.entries()) {
      k.pane(`pane:${era}`, slot(era, 'Win'), F.clone().multiply(M(u, sillY + winH / 2, -r + 0.02, 0, winW, winH, 1)), light(PANE_SASH));
      // Sill, projecting and weathered.
      k.box(trim, winW + 0.32, 0.16, r + 0.16, F.clone().multiply(M(u, sillY - 0.08, -r / 2 + 0.08)));
      // Rain off the sill has run down the spandrel below it, darkest under the drip.
      const run = sillY - 0.2;
      k.stain(wall, winW * (0.85 + 0.25 * c.rand()), run, F.clone().multiply(M(u + (c.rand() - 0.5) * 0.2, run / 2 + 0.04, 0.012)), 0.5 + 0.22 * c.rand());
      if (s.paired) {
        // One lintel spans each pair, pier and all.
        if (j % 2 === 0) k.box(trim, 2 * winW + PAIR_PIER + 0.5, 0.42, 0.08, F.clone().multiply(M(u + (winW + PAIR_PIER) / 2, headY + 0.21, 0.04)));
      } else if (isBrick) {
        // Stone lintel flush with the brick, a little proud.
        k.box(trim, winW + 0.5, 0.42, 0.08, F.clone().multiply(M(u, headY + 0.21, 0.04)));
      } else if ((floor.size !== 'small' || c.inRun % 2 === 0) && headY + 0.5 < h) {
        // A hood moulding over each window.
        k.box(trim, winW + 0.5, 0.18, 0.22, F.clone().multiply(M(u, headY + 0.24, 0.11)));
        k.box(trim, winW + 0.34, 0.12, 0.12, F.clone().multiply(M(u, headY + 0.1, 0.06)));
      }
    }
  }

  if (isBrick) {
    // Stone quoins at the corners, long and short in alternate courses.
    for (let side = 0; side < 4; side++) {
      const F = face(side, half);
      for (let q = 0; q < 2; q++) {
        const long = (c.index + q + side) % 2 === 0;
        const L = long ? 1.1 : 0.7;
        const qh = h / 2 - 0.06;
        k.box(trim, L, qh, 0.06, F.clone().multiply(M(half - L / 2, q * (h / 2) + qh / 2 + 0.03, 0.03)));
      }
    }
    if (c.runStart || c.inRun % 4 === 0) {
      // A belt course in the variant's accent.
      k.add(band, squareSweep(half, [[-0.05, 0], [0.06, 0], [0.06, 0.32], [-0.05, 0.32]]));
    }
  } else {
    // A string course at every slab, so the floors read as laid courses.
    k.add(band, squareSweep(half, [[-0.05, 0], [0.1, 0], [0.1, 0.22], [0.04, 0.3], [-0.05, 0.3]]));
  }

  // On the string course's upper face (stone) or just above the soldier course (brick), standing clear of both.
  claudeAccent(k, floor, half, isBrick ? 0.32 : 0.3, 0.12, 0.1);

  if (c.runEnd && !c.datum) {
    // A cornice closes the run: bed moulding, corona, cymatium, all inside the floor's height.
    const y0 = h - 0.95;
    // Streaks below the cornice where its drip has run down the wall between the windows.
    for (let side = 0; side < 4; side++) {
      const F = face(side, half);
      for (let i = 0; i <= openings.length; i++) {
        const a = i === 0 ? -half : openings[i - 1] + winW / 2;
        const b = i === openings.length ? half : openings[i] - winW / 2;
        if (b - a < 0.35) continue;
        const len = Math.min(y0 - 0.1, 1.2 + 1.8 * c.rand());
        k.stain(wall, Math.min(b - a, 0.4 + 0.6 * c.rand()), len, F.clone().multiply(M((a + b) / 2 + (c.rand() - 0.5) * 0.3, y0 - len / 2, 0.012)), 0.45 + 0.2 * c.rand());
      }
    }
    k.add(band, squareSweep(half, [
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
  return { cx: 0, cz: 0, half: half + 0.3, datumHalf: half + 0.12, edge: { cx: 0, cz: 0, half: half + 0.02 } };
}

const stone: EraBuilder = (k, w, h, f, c) => masonry(k, w, h, f, c, 'stone');

const brick: EraBuilder = (k, w, h, f, c) => masonry(k, w, h, f, c, 'brick');

// ---------------------------------------------------------------- glass

/**
 * Curtain wall: floor-height glazing over a lit office, mullions in the
 * variant's metal, a spandrel panel at each slab. Channel glass reads as
 * translucent ribbed panels instead of clear glass.
 */
const glass: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const n = bays(w, c.variant.pitch ?? 1.55);
  const style = c.variant.glass.channel ? PANE_CHANNEL : PANE_FULL;
  const pitch = w / n;
  const sb = Math.min(h * 0.45, c.variant.spandrel ?? 0.7);
  const depth = c.variant.depth ?? 1;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', w - 0.7, h, w - 0.7, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    // Spandrel band: bronze-framed dark panel hiding the slab.
    k.inst('spandrel', 'glassWall', unitBox, F.clone().multiply(M(0, sb / 2, -0.02, 0, w, sb, 0.12)));
    k.inst('transom', 'glassTrim', unitBox, F.clone().multiply(M(0, sb, 0.05, 0, w + 0.18, 0.1, 0.22)));
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.pane('pane:glass', 'glassWin', F.clone().multiply(M(u, (sb + h) / 2, 0, 0, pitch, h - sb, 1)), light(style));
    }
    for (let i = 0; i <= n; i++) {
      const u = -half + pitch * i;
      k.inst('mullion', 'glassTrim', unitBox, F.clone().multiply(M(u, h / 2, -0.01 + 0.15 * depth, 0, 0.1, h, 0.3 * depth)));
    }
  }
  claudeAccent(k, f, half, sb - 0.14, 0.32, 0.1);
  if (c.runEnd && !c.datum) {
    k.add('glassBand', squareSweep(half, [[-0.2, h - 0.6], [0.3, h - 0.6], [0.3, h], [-0.2, h]]));
  }
  // Mullion tips reach 0.3 m out per unit of depth; the datum wraps clear of them.
  return { cx: 0, cz: 0, half: half + Math.max(0.3, 0.3 * depth), datumHalf: half + Math.max(0.3, 0.3 * depth + 0.01), edge: { cx: 0, cz: 0, half: half + 0.06 } };
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
  const n = bays(w, c.variant.pitch ?? 2.0);
  // How far the fins stand out: a multiple of the 1.3 m blade.
  const fin = c.variant.depth ?? 1;
  const pitch = w / n;
  const edge = 0.55;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', w - 1.2, h, w - 1.2, M(0, h / 2, 0));
  // A dark graphite slab edge with small chamfers: it frames each floor without becoming a lit strip.
  k.add('titaniumTrim', squareSweep(half, [[-0.6, 0], [0.3, 0], [0.38, 0.07], [0.38, edge - 0.07], [0.3, edge], [-0.6, edge]]));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    for (let i = 0; i < n; i++) {
      const u = -half + pitch * (i + 0.5);
      k.pane('pane:titanium', 'titaniumWin', F.clone().multiply(M(u, (edge + h) / 2, -0.4, 0, pitch, h - edge, 1)), light(PANE_FULL));
    }
    for (let i = 1; i < n; i++) {
      const u = -half + pitch * i;
      const a = (i % 2 === 0 ? 1 : -1) * 0.14;
      k.inst('blade', 'titaniumWall', blade, F.clone().multiply(M(u, (edge + h) / 2, 0.32 * fin, a, 1, h - edge, fin)), panelTone(c.rand));
    }
    k.inst('blade', 'titaniumWall', blade, F.clone().multiply(M(half - 0.12, (edge + h) / 2, 0.32 * fin, 0, 1, h - edge, fin)), panelTone(c.rand));
  }
  claudeAccent(k, f, half + 0.38, edge / 2 - 0.05, 0.1, 0.1);
  if (c.runEnd && !c.datum) {
    k.add('titaniumBand', squareSweep(half, [[-0.6, h - 0.45], [0.75, h - 0.45], [0.8, h - 0.4], [0.8, h], [-0.6, h]]));
  }
  // The fins reach 0.97 m out per unit of depth; the datum wraps just clear of their tips.
  return { cx: 0, cz: 0, half: half + Math.max(1, fin), datumHalf: half + 0.97 * fin + 0.03, edge: { cx: 0, cz: 0, half: half + 0.4 } };
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
 * The length of a sci-fi run. The sci-fi era is the latest, so every floor
 * above a sci-fi floor is sci-fi too, and a family can shape its whole run
 * (a pyramid's batter, a needle's taper) from one floor's place in it.
 */
const runLength = (c: FloorContext): number => c.inRun + c.fromTop + 1;

/** Red aircraft warning lights: a small lamp at each of `at` (x, z), its top at `top`. */
function beacons(k: Kit, at: Array<[number, number]>, top: number): void {
  for (const [x, z] of at) k.box('beacon', 0.28, 0.28, 0.28, M(x, top - 0.14, z));
}

/** The four corners of a square of half-width `hw`, inset `in`. */
const corners = (hw: number, inset = 0.3): Array<[number, number]> => [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * (hw - inset), sz * (hw - inset)] as [number, number]));

// ---- deco

/**
 * How far in the deco shaft stands `fromTop` floors below the roof of a run
 * `run` floors long: the full shaft for the lower part, then three setbacks
 * over the top 60 percent, so a short run gets a short crown and a long one
 * a long shaft.
 */
function decoStep(fromTop: number, run: number): number {
  const t = fromTop / Math.max(1, run);
  return t > 0.6 ? 1 : t > 0.33 ? 0.86 : t > 0.12 ? 0.72 : 0.58;
}

/**
 * Monumental art deco: a pale cast-stone shaft drawn in unbroken vertical
 * lines of dark bronze fins, stepping back three times toward the roof. Each
 * setback leaves a terrace with a bronze parapet, four stone pylons at its
 * corners and sky bridges from the pylons to the shaft. The top floor is the
 * illuminated crown: no windows, only lit slots between the fins, under a
 * stepped bronze cap.
 */
const deco: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const run = runLength(c);
  const hs = Math.max(3.2, half * decoStep(c.fromTop, run));
  if (c.crown) return crown(k, 'deco', Math.max(3.2, half * decoStep(c.fromTop + c.crown.stage, run)), c);
  const below = Math.max(3.2, half * decoStep(c.fromTop + 1, run));
  const setback = !c.runStart && below > hs + 0.3;
  const n = bays(hs * 2, c.variant.pitch ?? 2.4);
  const p = (hs * 2) / n;
  const sp = 0.9;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', hs * 2 - 1.2, h, hs * 2 - 1.2, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, hs);
    // Stone spandrel at the slab, with a bronze string line along its top.
    k.box('scifiWall', hs * 2, sp, 0.5, F.clone().multiply(M(0, sp / 2, -0.25)));
    for (let i = 0; i < n; i++) {
      const u = -hs + p * (i + 0.5);
      if (c.top) {
        // The crown: a stone face with a lit slot recessed into it between every pair of fins.
        k.box('scifiWall', p, h - sp, 0.5, F.clone().multiply(M(u, (sp + h) / 2, -0.25)));
        k.box('vent', 0.16, h - sp - 0.7, 0.04, F.clone().multiply(M(u, (sp + h) / 2 - 0.1, 0.03)));
      } else {
        k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(u, (sp + h) / 2, -0.45, 0, p - 0.6, h - sp, 1)), light(PANE_FULL));
      }
    }
    for (let i = 0; i <= n; i++) {
      const u = -hs + p * i;
      const corner = i === 0 || i === n;
      // A stone pier between the windows, and in front of it the fin that draws the shaft's vertical line.
      k.inst('deco:pier', 'scifiWall', unitBox, F.clone().multiply(M(u, (sp + h) / 2, -0.25, 0, corner ? 1.0 : 0.5, h - sp, 0.5)));
      k.inst('deco:fin', 'scifiTrim', unitBox, F.clone().multiply(M(u, h / 2, 0.08, 0, corner ? 0.6 : 0.26, h, 0.5)));
    }
  }
  k.add('scifiBand', squareSweep(hs, [[-0.05, sp - 0.12], [0.1, sp - 0.12], [0.1, sp], [-0.05, sp]]));
  claudeAccent(k, f, hs, sp + 0.04, 0.22, 0.1);
  if (setback) {
    // The terrace left by the setback: its deck, a bronze parapet at the old face, stone pylons at the corners
    // and bridges from them to the shaft, so the masses read as one stepped composition.
    slabBox(k, 'slab', -below, below, 0, 0.3, -below, below);
    ring(k, 'scifiBand', -below, below, -below, below, 0.3, 1.1, 0.15);
    if (c.fromTop >= 2 && run >= 6) {
      const py = 1.3;
      for (const [x, z] of corners(below, py / 2)) {
        k.box('scifiWall', py, h, py, M(x, h / 2, z));
        k.box('scifiTrim', py + 0.3, 0.25, py + 0.3, M(x, h - 0.125, z));
        // The bridge runs from the pylon to the nearer face of the shaft.
        const ax = Math.abs(x) - py / 2 - hs;
        k.box('scifiTrim', ax, 0.5, 0.9, M(Math.sign(x) * (hs + ax / 2), h * 0.6, z));
        k.box('scifiTrim', 0.9, 0.5, ax, M(x, h * 0.6, Math.sign(z) * (hs + ax / 2)));
      }
    }
  }
  if (c.top) {
    // Stepped cap: a dark steel roof plate with a bronze edge, a stone block above it, warning lights at the corners.
    slabBox(k, 'roof', -hs - 0.3, hs + 0.3, h - 0.45, h - 0.25, -hs - 0.3, hs + 0.3);
    ring(k, 'scifiBand', -hs - 0.35, hs + 0.35, -hs - 0.35, hs + 0.35, h - 0.45, h - 0.3, 0.1);
    slabBox(k, 'scifiWall', -hs * 0.7, hs * 0.7, h - 0.25, h - 0.06, -hs * 0.7, hs * 0.7);
    slabBox(k, 'roof', -hs * 0.72, hs * 0.72, h - 0.06, h, -hs * 0.72, hs * 0.72);
    beacons(k, corners(hs + 0.35, 0.2), h);
  }
  return { cx: 0, cz: 0, half: (setback ? below : hs) + 0.5, datumHalf: hs + 0.42, edge: { cx: 0, cz: 0, half: hs + 0.03 } };
};

// ---- ziggurat

/**
 * A megastructure pyramid: every floor's lower half is a sloped face of
 * dark basalt concrete, battered so the whole run tapers to a flat crown;
 * above it a band of amber-lit glazing is set back under the lip of the
 * next floor, so the faces read as a lattice of lit floors. Every third
 * floor is a terrace with warm light vents set into the slope.
 */
const ziggurat: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const run = runLength(c);
  const batter = Math.min(0.42, (half * 0.6) / run);
  const h0 = Math.max(3.5, half - batter * c.inRun);
  if (c.crown) return crown(k, 'ziggurat', Math.max(3.5, half - batter * (c.inRun - c.crown.stage)), c);
  const h1 = Math.max(3.2, h0 - batter);
  const terrace = c.inRun % 3 === 2;
  const sp = Math.min(h * 0.55, 2.4);
  // The glazing stands just inside the line the next floor's slope grows from, so the pyramid's face runs on
  // unbroken: slope, a band of lit glass, slope again.
  const gl = h1 - 0.12;
  const n = bays(gl * 2, c.variant.pitch ?? 1.6);
  const p = (gl * 2) / n;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', gl * 2 - 0.8, h, gl * 2 - 0.8, M(0, h / 2, 0));
  // The sloped face, from the floor below's line out at h0 up to the glass line at h1.
  k.add('scifiWall', frustum(h0 * 2, sp, h0 * 2, (h1 * 2) / (h0 * 2)), M(0, sp / 2, 0));
  const slope = Math.atan2(h0 - h1, sp);
  for (let side = 0; side < 4; side++) {
    const F = face(side, gl);
    for (let i = 0; i < n; i++) {
      const u = -gl + p * (i + 0.5);
      k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(u, (sp + h - 0.2) / 2, 0, 0, p, h - 0.2 - sp, 1)), light(PANE_FULL));
    }
    for (let i = 0; i <= n; i++) {
      k.inst('zig:mullion', 'scifiTrim', unitBox, F.clone().multiply(M(-gl + p * i, (sp + h - 0.2) / 2, 0.05, 0, 0.08, h - 0.2 - sp, 0.12)));
    }
    if (terrace || c.top) {
      // Light vents set into the slope every few metres, tilted with the face, so the terraces read as fire-lit.
      const G = face(side, 0);
      const nv = Math.max(2, Math.round((h0 * 2) / 3.6));
      for (let i = 0; i < nv; i++) {
        const u = -h0 + ((h0 * 2) / nv) * (i + 0.5);
        const y = sp * 0.5;
        const d = h0 - (h0 - h1) * (y / sp) + 0.02;
        k.add('vent', unitBox(), G.clone().multiply(ME(u, y, d, -slope, 0, 0, 1.3, 0.34, 0.08)));
      }
    }
  }
  // A thin dark edge where the slope above meets the glass; a terrace throws a ledge out with a warm line under it.
  const lip = terrace ? 0.6 : 0;
  slabBox(k, 'scifiTrim', -h1 - lip, h1 + lip, h - 0.2, h, -h1 - lip, h1 + lip);
  if (terrace) ring(k, 'vent', -h1 - lip + 0.1, h1 + lip - 0.1, -h1 - lip + 0.1, h1 + lip - 0.1, h - 0.22, h - 0.2, 0.05);
  claudeAccent(k, f, h1 + lip, h - 0.1, 0.12, 0.08);
  if (c.top) {
    // The crown deck: a dark steel plate over the last slope, a lit slot round a raised centre, lights at the corners.
    slabBox(k, 'roof', -h1 - lip, h1 + lip, h - 0.2, h - 0.1, -h1 - lip, h1 + lip);
    ring(k, 'vent', -h1 * 0.5 - 0.06, h1 * 0.5 + 0.06, -h1 * 0.5 - 0.06, h1 * 0.5 + 0.06, h - 0.1, h - 0.06, 0.05);
    slabBox(k, 'roof', -h1 * 0.5, h1 * 0.5, h - 0.1, h, -h1 * 0.5, h1 * 0.5);
    beacons(k, corners(h1 + lip, 0.25), h);
  }
  return { cx: 0, cz: 0, half: h0 + 0.1, datumHalf: h1 + lip + 0.1, edge: { cx: 0, cz: 0, half: h0 + 0.03 } };
};

// ---- needle

/**
 * A slender tapering tower: the shaft narrows steadily to the roof, drawn
 * in fine titanium lines (mullions less than a metre apart), with an
 * observation pod thrown out every ninth floor and warning lights at the
 * top. It stays at the floors' own height: no mast.
 */
const needle: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const run = runLength(c);
  const hs = Math.max(2.8, half * (1 - (0.42 * c.inRun) / Math.max(1, run)));
  if (c.crown) return crown(k, 'needle', Math.max(2.8, half * (1 - (0.42 * (c.inRun - c.crown.stage)) / Math.max(1, run))), c);
  const pod = run >= 9 && c.inRun % 9 === 5 && !c.top && !c.datum;
  const n = bays(hs * 2, c.variant.pitch ?? 0.8);
  const p = (hs * 2) / n;
  const edge = 0.32;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', hs * 2 - 0.6, h, hs * 2 - 0.6, M(0, h / 2, 0));
  // A titanium slab edge at every floor, the horizontal line the fine verticals hang from.
  k.add('scifiWall', squareSweep(hs, [[-0.5, 0], [0.2, 0], [0.24, edge / 2], [0.2, edge], [-0.5, edge]]));
  for (let side = 0; side < 4; side++) {
    const F = face(side, hs);
    for (let i = 0; i < n; i++) {
      k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(-hs + p * (i + 0.5), (edge + h) / 2, 0, 0, p, h - edge, 1)), light(PANE_FULL));
    }
    for (let i = 0; i <= n; i++) {
      k.inst('ndl:mullion', 'scifiTrim', unitBox, F.clone().multiply(M(-hs + p * i, (edge + h) / 2, 0.1, 0, 0.07, h - edge, 0.26)));
    }
  }
  claudeAccent(k, f, hs + 0.24, edge / 2 - 0.05, 0.1, 0.1);
  if (pod) {
    // Observation pod: a glazed ring deck thrown clear of the shaft on a titanium plate, its soffit lit.
    const r = hs + 2.2;
    slabBox(k, 'scifiTrim', -r, r, 0.4, 0.75, -r, r);
    ring(k, 'lightLine', -r + 0.5, r - 0.5, -r + 0.5, r - 0.5, 0.37, 0.4, 0.06);
    slabBox(k, 'scifiWall', -r, r, h - 0.55, h - 0.2, -r, r);
    const m = bays(r * 2, 1.6);
    const q = (r * 2) / m;
    for (let side = 0; side < 4; side++) {
      const F = face(side, r);
      for (let i = 0; i < m; i++) k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(-r + q * (i + 0.5), (0.75 + h - 0.55) / 2, 0, 0, q, h - 1.3, 1)), light(PANE_FULL));
      for (let i = 0; i <= m; i++) k.inst('ndl:mullion', 'scifiTrim', unitBox, F.clone().multiply(M(-r + q * i, (0.75 + h - 0.55) / 2, 0.06, 0, 0.07, h - 1.3, 0.18)));
    }
  }
  if (c.top) {
    // A dark steel cap over the last floor, edged in the trim metal, a low plant block, warning lights at the corners.
    slabBox(k, 'roof', -hs - 0.2, hs + 0.2, h - 0.5, h - 0.25, -hs - 0.2, hs + 0.2);
    ring(k, 'scifiTrim', -hs - 0.24, hs + 0.24, -hs - 0.24, hs + 0.24, h - 0.5, h - 0.38, 0.08);
    slabBox(k, 'roof', -hs * 0.4, hs * 0.4, h - 0.25, h, -hs * 0.4, hs * 0.4);
    beacons(k, corners(hs + 0.2, 0.2), h);
  }
  return { cx: 0, cz: 0, half: (pod ? hs + 2.2 : hs) + 0.3, datumHalf: hs + 0.12, edge: { cx: 0, cz: 0, half: hs + 0.26 } };
};

// ---- arcology

/**
 * A brutalist arcology: raw board-marked concrete, a deep slab at every
 * floor overhanging the face, piers between recesses more than a metre
 * deep with planted ledges at their feet and warm rooms behind, rain
 * stains under every slab, and cantilevered habitation pods hung off the
 * piers with lit undersides. The roof carries a parapet and a service block.
 */
const arcology: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  if (c.crown) return crown(k, 'arcology', half, c);
  const over = 0.9;
  const recess = 1.3;
  const n = bays(w, c.variant.pitch ?? 4.6);
  const p = w / n;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  const pods = c.inRun % 2 === 1 && !c.datum && !c.top;
  const podSides = pods ? [Math.floor(c.rand() * 4), (Math.floor(c.rand() * 4) + 2) % 4, Math.floor(c.rand() * 4)] : [];
  const podBays = pods ? [Math.floor(c.rand() * n), Math.floor(c.rand() * n)] : [];
  k.box('slab', w - 2 * recess - 0.4, h, w - 2 * recess - 0.4, M(0, h / 2, 0));
  slabBox(k, 'scifiTrim', -half - over, half + over, 0, 0.5, -half - over, half + over);
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    for (let i = 0; i < n; i++) {
      const u = -half + p * (i + 0.5);
      // The recess: a concrete ledge with planting on it, and the room's window behind.
      k.box('scifiTrim', p - 0.8, 0.35, 1.0, F.clone().multiply(M(u, 0.675, -recess + 0.5)));
      k.box('scifiBand', p - 1.0, 0.3, 0.8, F.clone().multiply(M(u, 1.0, -recess + 0.5)));
      k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(u, (1.15 + h - 0.1) / 2, -recess + 0.02, 0, p - 0.8, h - 1.25, 1)), light(PANE_FULL));
      // The spandrel over the window, under the slab above.
      k.box('scifiWall', p - 0.8, 0.5, 0.4, F.clone().multiply(M(u, h - 0.25, -recess + 0.2)));
      if (podSides.includes(side) && (podBays.includes(i) || i === Math.floor(n / 2))) {
        // A habitation pod cantilevered off the piers: a concrete box with a lit room at its end and a lit soffit.
        const pw = Math.min(p - 1.0, 3.4);
        const ph = h - 1.2;
        const pz = 0.3 + 1.3;
        k.inst('pod', 'scifiWall', unitBox, F.clone().multiply(M(u, 0.6 + ph / 2, pz, 0, pw, ph, 2.6)));
        k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(u, 0.6 + ph / 2, pz + 1.31, 0, pw - 0.5, ph - 0.6, 1)), light(PANE_FULL));
        k.box('lightLine', pw - 0.6, 0.03, 1.6, F.clone().multiply(M(u, 0.6 - 0.015, pz)));
      }
    }
    for (let i = 0; i <= n; i++) {
      const u = -half + p * i;
      k.box('scifiWall', 0.8, h - 0.5, recess + 0.3, F.clone().multiply(M(u, (0.5 + h) / 2, -recess / 2 + 0.15)));
      // Rain off the slab above has run down the pier from its top.
      const sh = 1.4 + 0.6 * c.rand();
      k.stain('scifiWall', 0.7, sh, F.clone().multiply(M(u + (c.rand() - 0.5) * 0.1, h - sh / 2 - 0.02, 0.312)), 0.5 + 0.2 * c.rand());
    }
  }
  claudeAccent(k, f, half + over, 0.5 - 0.14, 0.1, 0.1);
  if (c.top) {
    ring(k, 'scifiTrim', -half - over, half + over, -half - over, half + over, h - 1.0, h, 0.35);
    slabBox(k, 'slab', -half - over + 0.35, half + over - 0.35, h - 1.0, h - 0.85, -half - over + 0.35, half + over - 0.35);
    k.box('scifiWall', half * 0.7, 1.0, half * 0.55, M(-half * 0.25, h - 0.5, half * 0.2));
    k.box('scifiTrim', half * 0.3, 0.7, half * 0.3, M(half * 0.5, h - 0.65, -half * 0.45));
    beacons(k, corners(half + over, 0.3), h);
  }
  return { cx: 0, cz: 0, half: half + over + (pods ? 2.9 : 0.1), datumHalf: half + 0.35, edge: { cx: 0, cz: 0, half: half + over + 0.02 } };
};

// ---- organic

/**
 * A biomorphic tower on a round plan: a white glazed-ceramic shell that
 * swells a little at mid-height and tapers to a shallow dome, each floor a
 * band of glazing between ceramic spandrels, under a ribbed exoskeleton
 * whose ribs lean a few degrees per floor so they sweep up the shell in
 * curves.
 */
const organic: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  const run = runLength(c);
  const radius = (i: number): number => {
    const t = i / Math.max(1, run);
    return Math.max(2.6, half * 0.96 * (1 + 0.14 * Math.sin(Math.PI * t)) * (1 - 0.3 * t));
  };
  const r0 = radius(c.inRun);
  if (c.crown) return crown(k, 'organic', radius(c.inRun - c.crown.stage), c);
  const r1 = radius(c.inRun + 1);
  const rg = Math.min(r0, r1) - 0.4;
  const sp = 1.0;
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.add('slab', lathe([[0, 0], [rg - 0.45, 0], [rg - 0.45, h], [0, h]], 48));
  // The spandrel shell, curving from the slab line in to the glass, and the lip the next floor's shell grows from.
  k.add('scifiWall', lathe([[rg - 0.3, sp + 0.2], [rg + 0.03, sp + 0.2], [rg + 0.03, sp], [(r0 + rg) / 2 + 0.1, sp * 0.55], [r0, 0.0], [r0 - 0.6, 0]], 64));
  const top = c.top ? h - 0.45 : h;
  k.add('scifiWall', lathe([[rg - 0.3, top - 0.3], [rg + 0.03, top - 0.3], [r1, top - 0.12], [r1, top], [r1 - 0.6, top]], 64));
  const nP = Math.max(8, Math.round((2 * Math.PI * rg) / (c.variant.pitch ?? 1.8)));
  const chord = 2 * rg * Math.sin(Math.PI / nP);
  const gy0 = sp + 0.2;
  const gy1 = top - 0.3;
  for (let i = 0; i < nP; i++) {
    const a = ((i + 0.5) / nP) * Math.PI * 2;
    k.pane('pane:scifi', 'scifiWin', M(rg * Math.sin(a), (gy0 + gy1) / 2, rg * Math.cos(a), a, chord, gy1 - gy0, 1), light(PANE_FULL));
    const b = (i / nP) * Math.PI * 2;
    k.inst('org:mullion', 'graphite', unitBox, M((rg + 0.04) * Math.sin(b), (gy0 + gy1) / 2, (rg + 0.04) * Math.cos(b), b, 0.07, gy1 - gy0, 0.12));
  }
  // The exoskeleton: ribs leaning with the twist, each a straight piece of a helix one floor tall.
  const nR = 12;
  const twist = 0.045;
  const R = Math.max(r0, r1) + 0.22;
  const lean = Math.atan2(R * twist, h);
  // Shortened so the leaning box's corners stay inside the floor's height.
  const len = (h - 0.4 * Math.sin(lean)) / Math.cos(lean);
  for (let j = 0; j < nR; j++) {
    const a = c.inRun * twist + (j / nR) * Math.PI * 2 + twist / 2;
    k.inst('org:rib', 'scifiTrim', unitBox, ME(R * Math.sin(a), h / 2, R * Math.cos(a), 0, a, -lean, 0.4, len, 0.44));
  }
  claudeAccent(k, f, rg + 0.1, sp + 0.22, 0.18, 0.1);
  if (c.top) {
    // A shallow ceramic dome over the last lip, a titanium ring at its spring, warning lights round the ring.
    k.add('scifiBand', lathe([[r1 - 0.12, top], [r1 + 0.1, top], [r1 + 0.1, top + 0.08], [r1 - 0.12, top + 0.08]], 64));
    k.add('scifiWall', lathe([[r1 - 0.2, top + 0.08], [r1 * 0.8, h - 0.2], [r1 * 0.45, h - 0.04], [0, h]], 64));
    beacons(k, [0, 1, 2, 3].map((i) => [(r1 - 0.25) * Math.sin((i / 4) * Math.PI * 2 + Math.PI / 4), (r1 - 0.25) * Math.cos((i / 4) * Math.PI * 2 + Math.PI / 4)] as [number, number]), top + 0.36);
  }
  return { cx: 0, cz: 0, half: R + 0.3, datumHalf: R + 0.3, round: true, edge: { cx: 0, cz: 0, half: r0 + 0.03, round: true } };
};

// ---- cluster

/** Where a cluster's boxes sit round the core, floor by floor: eight bearings, taken three apart so neighbours jump. */
const BEARINGS: Array<[number, number]> = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];

/**
 * Stacked cantilevers: glazed carbon boxes climb a dark core, each floor
 * thrown out on a different bearing and a little larger or smaller than
 * the last, so the stack reads as offset volumes with their undersides lit. The core's corners carry light
 * seams. The roof box stands centred under a canopy.
 */
const cluster: EraBuilder = (k, w, h, f, c) => {
  const half = w / 2;
  if (c.crown) return crown(k, 'cluster', half, c);
  const core = Math.max(3, half * 0.44);
  const centred = c.datum || c.top;
  const [ox, oz] = centred ? [0, 0] : BEARINGS[(c.inRun * 3) % BEARINGS.length];
  const reach = half * (0.36 + 0.1 * (c.inRun % 2));
  const bx = ox * reach;
  const bz = oz * reach;
  const bh = c.top ? half * 0.54 : half * (0.56 + 0.08 * ((c.inRun + 1) % 2));
  const light = lighter(f.era, c.rand, c.variant.lights, c.asleep);
  k.box('slab', core * 2 - 0.3, h, core * 2 - 0.3, M(0, h / 2, 0));
  k.box('scifiWall', core * 2, h, core * 2, M(0, h / 2, 0));
  if (c.variant.seams) {
    for (const [x, z] of corners(core, 0)) {
      k.box('lightLine', 0.06, h - 0.5, 0.06, M(x * (1 + 0.02 / core), h / 2, z * (1 + 0.02 / core)));
    }
  }
  // The box: a floor plate, a carbon fascia over it, glazing above; the lower storey of a pair lights its underside.
  slabBox(k, 'scifiTrim', bx - bh, bx + bh, 0, 0.35, bz - bh, bz + bh);
  ring(k, 'lightLine', bx - bh + 0.4, bx + bh - 0.4, bz - bh + 0.4, bz + bh - 0.4, -0.03, 0, 0.06);
  ring(k, 'scifiWall', bx - bh, bx + bh, bz - bh, bz + bh, 0.35, 0.7, 0.25);
  const gt = c.top ? h - 0.4 : h;
  const n = bays(bh * 2, c.variant.pitch ?? 1.7);
  const p = (bh * 2) / n;
  for (let side = 0; side < 4; side++) {
    const F = M(bx, 0, bz).multiply(face(side, bh));
    for (let i = 0; i < n; i++) k.pane('pane:scifi', 'scifiWin', F.clone().multiply(M(-bh + p * (i + 0.5), (0.7 + gt) / 2, -0.02, 0, p, gt - 0.7, 1)), light(PANE_FULL));
    for (let i = 0; i <= n; i++) k.inst('cl:mullion', 'scifiTrim', unitBox, F.clone().multiply(M(-bh + p * i, (0.7 + gt) / 2, 0.05, 0, 0.07, gt - 0.7, 0.14)));
  }
  if (!c.top) slabBox(k, 'roof', bx - bh, bx + bh, h - 0.25, h, bz - bh, bz + bh);
  claudeAccent(k, f, bh, 0.35 + 0.04, 0.2, 0.1);
  if (c.top) {
    // The roof pavilion's canopy, thrown past the box, with a lit soffit and the warning lights at its corners.
    const ch = bh + 0.8;
    slabBox(k, 'roof', -ch, ch, h - 0.4, h - 0.1, -ch, ch);
    slabBox(k, 'scifiBand', -ch, ch, h - 0.1, h, -ch, ch);
    ring(k, 'lightLine', -ch + 0.35, ch - 0.35, -ch + 0.35, ch - 0.35, h - 0.425, h - 0.4, 0.06);
    beacons(k, corners(ch, 0.2), h);
  }
  const far = Math.max(core, Math.abs(bx) + bh, Math.abs(bz) + bh);
  return { cx: bx / 2, cz: bz / 2, half: far - Math.max(Math.abs(bx), Math.abs(bz)) / 2 + 0.2, datumHalf: bh + 0.12, edge: { cx: bx, cz: bz, half: bh + 0.03 } };
};

const FAMILY_BUILDERS: Record<Family, EraBuilder> = { deco, ziggurat, needle, arcology, organic, cluster };

/**
 * How many of a sci-fi run's top floors carry its crown: about a third of a
 * short run (runs are five to twelve floors in most towers), so the crown is
 * tall enough to read from the hero's distance, never all of a long run.
 */
export function crownFloors(run: number): number {
  return run >= 12 ? 5 : run >= 8 ? 4 : run >= 5 ? 3 : run >= 3 ? 2 : 1;
}

/** Each crown piece's slot (kits.py) and the tower material it takes. */
const CROWN_SLOT: Record<string, MatKey> = {
  wall: 'scifiWall',
  trim: 'scifiTrim',
  band: 'scifiBand',
  vent: 'vent',
  light: 'lightLine',
  roof: 'roof',
  beacon: 'beacon',
  glass: 'vent',
};

/**
 * Each family's crown (kits.py crown_<family>): the half-width it starts
 * from, as a share of the shaft below; how far its widest part reaches
 * (for the pick proxy); and the half-width at its top, which a datum band
 * on the tower's last floor wraps.
 */
const CROWNS: Record<Family, { base: number; reach: number; top: number; round?: boolean }> = {
  deco: { base: 1.0, reach: 1.0, top: 0.6 },
  ziggurat: { base: 1.0, reach: 1.0, top: 0.36 },
  needle: { base: 1.0, reach: 1.12, top: 0.4 },
  arcology: { base: 1.0, reach: 1.3, top: 1.07 },
  organic: { base: 1.0, reach: 1.1, top: 0.47, round: true },
  cluster: { base: 0.82, reach: 1.1, top: 0.78 },
};

/**
 * A family's crown over the top floors of its run, authored in Blender
 * (kits.py) and scaled to the shaft it caps: `half` is the shaft's
 * half-width where the crown starts. The first crown floor lays the whole
 * crown; the floors above it in the crown only report their shape.
 */
function crown(k: Kit, family: Family, half: number, c: FloorContext): FloorShape {
  const spec = CROWNS[family];
  const b = half * spec.base;
  const H = c.crown!.height;
  if (c.crown!.stage === 0) {
    for (const [slotName, mat] of Object.entries(CROWN_SLOT)) {
      const name = `crown_${family}.${slotName}`;
      if (!hasKit(name)) continue;
      k.add(mat, kitPiece(name), M(0, 0, 0, 0, b, H, b));
    }
  }
  return { cx: 0, cz: 0, half: b * spec.reach + 0.3, datumHalf: b * spec.top + 0.12, round: spec.round, edge: { cx: 0, cz: 0, half: b + 0.03, round: spec.round } };
}

/** Sci-fi: the floor is built in its variant's family (see FAMILIES in variants.ts). */
const scifi: EraBuilder = (k, w, h, f, c) => FAMILY_BUILDERS[c.variant.family ?? 'cluster'](k, w, h, f, c);

export const ERA_BUILDERS: Record<Era, EraBuilder> = { stone, brick, glass, titanium, scifi };

/** Each run of titanium floors twists a little per floor (radians). */
export const TITANIUM_TWIST = 0.012;

// ---------------------------------------------------------------- earned floors (Task 22)

/** A sweep round a plan's edge: a square of half-width `half`, or a ring when `round`. */
function edgeSweep(edge: FloorShape['edge'], profile: Array<[number, number]>): THREE.BufferGeometry {
  if (!edge.round) return squareSweep(edge.half, profile);
  const g = new THREE.LatheGeometry(
    profile.map(([d, y]) => new THREE.Vector2(edge.half + d, y)),
    64,
  );
  g.computeVertexNormals();
  return g;
}

/** How tall the light line at an earned floor's slab edge is, and how far it stands clear of the face. */
const LINE = { tall: 0.11, proud: 0.05 };

/**
 * The thin cool line at the slab edge of a floor earned in the market and
 * merged: a lit reveal at the very foot of the floor, below anything the
 * era puts at its slab (so it never sits on the Claude amber). A floor he
 * merged with his own changes added carries a warm ivory pair instead.
 */
export function earnedLine(k: Kit, edge: FloorShape['edge'], his: boolean): void {
  const strip = (y: number): Array<[number, number]> => [
    [-0.12, y],
    [LINE.proud, y],
    [LINE.proud, y + LINE.tall],
    [-0.12, y + LINE.tall],
  ];
  const at = M(edge.cx, 0, edge.cz);
  if (!his) {
    k.add('earnedLine', edgeSweep(edge, strip(0.0)), at);
    return;
  }
  k.add('handLine', edgeSweep(edge, strip(0.0)), at);
  k.add('handLine', edgeSweep(edge, strip(0.2)), at);
}

/**
 * Each firm's mark, by its slot among the firms (Task 4): six muted dusk
 * colours, apart from the cool merged line, his ivory pair, the Claude
 * amber and the bronze datum. Linear multipliers on a white painted metal.
 */
export const FIRM_MARKS: readonly THREE.Color[] = [
  new THREE.Color(0.26, 0.55, 0.47), // verdigris
  new THREE.Color(0.52, 0.29, 0.47), // heather
  new THREE.Color(0.6, 0.52, 0.21), // ochre olive
  new THREE.Color(0.72, 0.36, 0.26), // copper rose
  new THREE.Color(0.27, 0.36, 0.58), // slate blue
  new THREE.Color(0.19, 0.4, 0.24), // bottle green
];

/** A firm's mark colour: by its slot when known, else by its id, so a firm keeps one colour everywhere. */
export function firmMarkColor(firmId: string, slots?: Map<string, number>): THREE.Color {
  const slot = slots?.get(firmId);
  const i = slot !== undefined ? slot : Math.floor(rng(firmId)() * FIRM_MARKS.length);
  return FIRM_MARKS[((i % FIRM_MARKS.length) + FIRM_MARKS.length) % FIRM_MARKS.length];
}

/** The firm's mark: a painted strip just above the slab edge's line, in the firm's colour. */
export function firmMark(k: Kit, edge: FloorShape['edge'], color: THREE.Color): void {
  const was = k.tint;
  k.tint = color.clone();
  k.add('firmMark', edgeSweep(edge, [
    [-0.12, 0.14],
    [0.05, 0.14],
    [0.05, 0.46],
    [-0.12, 0.46],
  ]), M(edge.cx, 0, edge.cz));
  k.tint = was;
}

/**
 * A waiting floor's slab edge, left in bare concrete until the PR merges:
 * a plain cast nosing round the foot of the floor, standing over whatever
 * finish the era would give its slab.
 */
export function bareEdge(k: Kit, edge: FloorShape['edge']): void {
  k.add('slab', edgeSweep(edge, [
    [-0.2, 0],
    [0.09, 0],
    [0.09, 0.32],
    [-0.2, 0.32],
  ]), M(edge.cx, 0, edge.cz));
}

/**
 * A scar: the floor a failed inspection left standing, built as the approved
 * primer floor. A rough concrete slab whose edge was never dressed (its
 * nosing broken into uneven lengths, rebar stubs left out of it), steel
 * studs bare at the corners where the sheathing stops short, and between
 * them sheathing boards in matte rust-red primer, each coat a little
 * different, butted with open seams. No glazing at all. It stands as tall
 * as its size, like any floor.
 */
export function scarFloor(k: Kit, width: number, h: number, rand: () => number): FloorShape {
  const half = width / 2;
  const slabT = 0.34;
  const skin = half - 0.12;
  const clear = Math.min(1.6, half * 0.28);
  const tint = k.tint.clone();
  // The structure behind: a dark core, so nothing reads through the seams as sky.
  k.box('slab', width - 1.0, h, width - 1.0, M(0, h / 2, 0));
  for (let side = 0; side < 4; side++) {
    const F = face(side, half);
    // The slab's edge, cast and never dressed: lengths of nosing at uneven depths and heights.
    let u = -half;
    while (u < half - 1e-3) {
      const len = Math.min(half - u, 0.7 + 1.6 * rand());
      const out = -0.04 + 0.16 * rand();
      const t = slabT * (0.72 + 0.28 * rand());
      k.box('slab', len, t, 0.3 + out, F.clone().multiply(M(u + len / 2, t / 2, -0.15 + out / 2)));
      u += len;
    }
    // Rebar stubs left out of the slab edge, a few per face.
    const stubs = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < stubs; i++) {
      const su = -half + clear + rand() * (width - 2 * clear);
      k.box('steel', 0.035, 0.035, 0.22 + 0.2 * rand(), F.clone().multiply(M(su, 0.12 + 0.12 * rand(), 0.12)));
    }
    // Sheathing boards between the bare corners, 1.2 m wide and stood on end in two rows with their joints
    // staggered, each board's coat of primer a few percent off its neighbours. One bay per face was never
    // closed: its studs stand bare, the wound shown rather than painted over.
    const span = width - 2 * clear;
    const n = Math.max(2, Math.round(span / 1.22));
    const bw = span / n;
    const y0 = slabT + 0.02;
    const y1 = h - 0.06;
    const open = 1 + Math.floor(rand() * Math.max(1, n - 2));
    const split = y0 + (y1 - y0) * (0.48 + 0.1 * rand());
    for (let i = 0; i < n; i++) {
      const bu = -half + clear + bw * (i + 0.5);
      if (i === open) {
        for (let j = 0; j <= 3; j++) {
          const su = bu - bw / 2 + 0.06 + ((bw - 0.12) * j) / 3;
          k.box('steel', 0.05, y1 - y0, 0.15, F.clone().multiply(M(su, (y0 + y1) / 2, skin - half - 0.06)));
        }
        k.box('steel', bw, 0.05, 0.16, F.clone().multiply(M(bu, split, skin - half - 0.06)));
        continue;
      }
      const stagger = i % 2 === 0 ? 0 : 0.35;
      const cut = Math.min(y1 - 0.2, split + stagger * (y1 - split));
      for (const [a, z] of [[y0, cut], [cut, y1]] as const) {
        const v = 0.84 + 0.22 * rand();
        k.tint = tint.clone().multiplyScalar(v);
        k.box('primer', bw - 0.04, z - a - 0.03, 0.05, F.clone().multiply(M(bu, (a + z) / 2, skin - half + 0.025)));
      }
    }
    k.tint = tint.clone();
    // The bare corner: studs at 40 cm centres on both tracks, a bottom and a top track, a diagonal strap.
    const c0 = half - clear;
    const cu = half - 0.08;
    const studs = Math.max(2, Math.round(clear / 0.4));
    for (let i = 0; i <= studs; i++) {
      const su = c0 + ((cu - c0) * i) / studs;
      k.box('steel', 0.05, y1 - y0, 0.15, F.clone().multiply(M(su, (y0 + y1) / 2, skin - half - 0.06)));
    }
    k.box('steel', clear + 0.04, 0.05, 0.16, F.clone().multiply(M((c0 + half) / 2, y0 + 0.025, skin - half - 0.06)));
    k.box('steel', clear + 0.04, 0.05, 0.16, F.clone().multiply(M((c0 + half) / 2, y1 - 0.025, skin - half - 0.06)));
    const dx = cu - c0;
    const dy = y1 - y0 - 0.2;
    const len = Math.hypot(dx, dy);
    k.add('steel', new THREE.BoxGeometry(0.03, len, 0.01), F.clone().multiply(ME((c0 + cu) / 2, (y0 + y1) / 2, skin - half + 0.02, 0, 0, Math.atan2(dx, dy))));
  }
  // The corner post itself: a steel box column, bare.
  const post = h - 0.08 - slabT;
  for (const [x, z] of corners(half, 0.1)) k.box('steel', 0.16, post, 0.16, M(x, slabT + post / 2, z));
  return { cx: 0, cz: 0, half: half + 0.2, datumHalf: half + 0.12, edge: { cx: 0, cz: 0, half: half + 0.02 } };
}
