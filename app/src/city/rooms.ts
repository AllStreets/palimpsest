import { SECTIONS } from './lots.js';
import type { CornerKind } from './shopfronts.js';

/**
 * The arithmetic behind the ambient facades' street-level detail (Phase 5
 * Task 2), kept apart from facade.ts so the tests and the tools can read it
 * without the materials: the arc length round a cut corner, by which the
 * shader maps a corner's windows so they keep their width; the rooms behind
 * the upper windows (their card, paint, depth, light), in JavaScript and as
 * the GLSL the facade program pastes in; and where a walk-up's windows fall.
 */

// ---------------------------------------------------------------- the cut corners

/** A cut corner: how far the cut reaches along x and along z from the corner's inner point, in metres. */
export interface Corner {
  kind: CornerKind;
  rx: number;
  rz: number;
}

/** The arc length of a quarter ellipse with half-axes a (along x) and b (along z) from angle 0 to th, by Simpson's rule over eight steps (the shader does the same). */
function ellipseArc(a: number, b: number, th: number): number {
  const h = th / 8;
  let sum = 0;
  for (let i = 0; i <= 8; i++) {
    const t = i * h;
    const f = Math.hypot(a * Math.sin(t), b * Math.cos(t));
    sum += f * (i === 0 || i === 8 ? 1 : i % 2 ? 4 : 2);
  }
  return (sum * h) / 3;
}

/** How long a cut corner runs, from the face along x to the face along z. */
export function cornerLength(c: Corner): number {
  return c.kind === 'chamfer' ? Math.hypot(c.rx, c.rz) : ellipseArc(c.rx, c.rz, Math.PI / 2);
}

/**
 * Where a point on a cut corner stands along it, in metres from its start on
 * the face along x: the distance along the chamfer, or the arc length round
 * the quarter round. x and z are the point's offsets from the corner's inner
 * point (the chamfer's missing corner, the round's centre), both toward the
 * corner. Windows laid along this coordinate keep their width round the
 * corner where a projection onto one axis would stretch them.
 */
export function cornerU(x: number, z: number, c: Corner): number {
  if (c.kind === 'chamfer') {
    const L = Math.hypot(c.rx, c.rz);
    const t = ((x - c.rx) * -c.rx + z * c.rz) / (L * L);
    return L * Math.min(1, Math.max(0, t));
  }
  const th = Math.atan2(z / c.rz, x / c.rx);
  return ellipseArc(c.rx, c.rz, Math.min(Math.PI / 2, Math.max(0, th)));
}

// ---------------------------------------------------------------- the rooms behind the glass

/** The rooms: how many furniture cards and wall paints there are, how deep a room is, how far from the eye rooms are traced on each tier, and the far reading of an unlit window. */
export const ROOM = { cards: 8, paints: 8, depth: [3.6, 5.4] as [number, number], far: { high: 260, medium: 140 }, unlitFar: 0.025 } as const;

/** The shader's hash (h21 in FACADE_GLSL), in doubles: the same mapping, the tests' and the shader's rooms agree to float precision. */
function h21(x: number, y: number): number {
  const fr = (v: number): number => v - Math.floor(v);
  let px = fr(x * 123.34);
  let py = fr(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fr(px * py);
}

/** The room behind a window: its furniture card, its wall paint, its depth and its floor, from the room's id (its bay run and floor, with the face) and the building's seed. */
export function roomOf(rid: [number, number], bs: number): { card: number; paint: number; depth: number; boards: boolean } {
  return {
    card: Math.floor(h21(rid[0] * 3.7 + bs, rid[1] * 3.7 + bs) * ROOM.cards),
    paint: Math.floor(h21(rid[0] * 2.1 + bs, rid[1] * 2.1 + bs) * ROOM.paints),
    depth: ROOM.depth[0] + (ROOM.depth[1] - ROOM.depth[0]) * h21(rid[0] * 1.3 + bs, rid[1] * 1.3 + bs),
    boards: h21(rid[0] * 5.3 + bs, rid[1] * 5.3 + bs) >= 0.5,
  };
}

/**
 * The light in a room at P (metres along the room, up from its floor, in
 * from the glass), as a scale on its surfaces' colour: a lit room has a
 * ceiling fitting near its middle and falls off from it; an unlit one holds
 * the dusk from the glass, dying toward the back, and is never nothing.
 */
export function roomLight(lit: boolean, P: [number, number, number], box: { width: number; ceiling: number; depth: number }): number {
  const dx = P[0] - box.width * 0.5;
  const dy = P[1] - (box.ceiling - 0.05);
  const dz = P[2] - box.depth * 0.45;
  const on = 1.7 / (1 + 0.22 * (dx * dx + dy * dy + dz * dz));
  const off = 0.3 * (0.6 * Math.exp(-P[2] * 0.35) + 0.12 * (1 - P[2] / box.depth) + 0.3);
  return lit ? on : off;
}

const step = (edge: number, x: number): number => (x < edge ? 0 : 1);
const fract = (v: number): number => v - Math.floor(v);
const mix3 = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A furniture card on the back wall of a room: p in metres from the card's
 * foot at the wall's middle; its colour and how much of the wall it covers.
 * Eight: a bookcase, pictures, a wardrobe, a desk with a monitor, a bed, a
 * kitchen, a sofa with a standard lamp, curtains and a plant. The monitor and
 * the lamp shade carry light of their own when the room is lit. The same
 * arithmetic as roomCard in ROOM_GLSL.
 */
export function roomCard(card: number, p: [number, number], lit: boolean): { colour: [number, number, number]; mask: number } {
  const [x, y] = p;
  const ax = Math.abs(x);
  const l = lit ? 1 : 0;
  let c: [number, number, number] = [0, 0, 0];
  let m = 0;
  if (card < 0.5) {
    const inCase = step(ax, 1.0) * step(y, 1.95);
    const sy = fract((y - 0.05) / 0.38);
    const col = Math.floor(x / 0.055);
    const row = Math.floor(y / 0.38);
    const bh = 0.55 + 0.3 * h21(col, row);
    const book = step(0.12, sy) * step(sy, bh) * step(0.12, fract(x / 0.055)) * step(0.3, h21(col, 3.0));
    const hue = [0, 0.33, 0.67].map((o) => 0.5 + 0.5 * Math.cos(6.2831 * (h21(col, 7.0) + o)));
    const bc = mix3([0.3, 0.3, 0.3], hue, 0.35).map((v) => v * (0.1 + 0.25 * h21(col, 9.0))) as [number, number, number];
    c = mix3([0.16, 0.1, 0.06], bc, book).map((v) => v * (0.6 + 0.4 * step(0.12, sy) * step(sy, 1.0))) as [number, number, number];
    c = mix3(c, [0.2, 0.13, 0.08], step(sy, 0.1));
    m = inCase;
  } else if (card < 1.5) {
    const fx = Math.abs(ax - 0.6);
    const fy = Math.abs(y - 1.6);
    const frame = step(fx, 0.3) * step(fy, 0.36);
    const inner = step(fx, 0.25) * step(fy, 0.31);
    const pic = step(fx, 0.2) * step(fy, 0.25);
    c = mix3([0.12, 0.08, 0.05], [0.6, 0.58, 0.54], inner);
    c = mix3(c, [0.28, 0.3, 0.26].map((v) => v * (0.6 + 0.6 * h21(Math.floor(x * 4), Math.floor(y * 4)))), pic);
    m = frame;
  } else if (card < 2.5) {
    const box = step(ax, 0.65) * step(y, 2.15);
    const gap = Math.min(1, step(ax, 0.012) + step(Math.abs(y - 2.15), 0.02) + step(Math.abs(y - 0.08), 0.015));
    const handle = step(Math.abs(ax - 0.08), 0.012) * step(Math.abs(y - 1.05), 0.1);
    c = [0.3, 0.2, 0.12].map((v) => v * (1 - 0.6 * gap)) as [number, number, number];
    c = mix3(c, [0.5, 0.45, 0.35], handle);
    m = box;
  } else if (card < 3.5) {
    const top = step(ax, 0.8) * step(Math.abs(y - 0.74), 0.025);
    const legs = step(Math.abs(ax - 0.75), 0.03) * step(y, 0.74);
    const mon = step(ax, 0.3) * step(Math.abs(y - 1.03), 0.19);
    const screen = step(ax, 0.27) * step(Math.abs(y - 1.03), 0.16);
    const stand = step(ax, 0.04) * step(y, 0.84) * step(0.74, y);
    c = mix3([0.3, 0.22, 0.14], [0.08, 0.08, 0.08], Math.min(1, legs + stand + mon));
    c = mix3(c, mix3([0.05, 0.05, 0.05], [1.2, 1.3, 1.5], l), screen);
    m = Math.min(1, top + legs + mon + stand);
  } else if (card < 4.5) {
    const head = step(ax, 0.85) * step(y, 1.15) * step(0.3, y);
    const pillow = step(Math.abs(ax - 0.42), 0.32) * step(Math.abs(y - 0.62), 0.13);
    c = mix3([0.22, 0.16, 0.13], [0.6, 0.58, 0.55], pillow);
    m = head;
  } else if (card < 5.5) {
    const upper = step(ax, 1.15) * step(Math.abs(y - 1.85), 0.35);
    const lower = step(ax, 1.15) * step(y, 0.9);
    const door = step(0.04, fract((x + 1.15) / 0.575));
    const top = step(ax, 1.17) * step(Math.abs(y - 0.92), 0.025);
    c = [0.5, 0.49, 0.45].map((v) => v * (0.55 + 0.45 * door)) as [number, number, number];
    c = mix3(c, [0.08, 0.08, 0.09], top);
    m = Math.min(1, upper + lower + top);
  } else if (card < 6.5) {
    const sofa = step(ax, 0.85) * step(y, 0.95) * step(0.3, y);
    const stem = step(Math.abs(x - 1.1), 0.015) * step(y, 1.55);
    const shade = step(Math.abs(x - 1.1), 0.16) * step(Math.abs(y - 1.7), 0.15);
    c = mix3([0.2, 0.18, 0.22], [0.08, 0.08, 0.08], stem);
    c = mix3(c, mix3([0.3, 0.25, 0.2], [1.5, 1.1, 0.7], l), shade);
    m = Math.min(1, sofa + stem + shade);
  } else {
    const curtain = step(Math.abs(ax - 1.05), 0.22) * step(0.15, y);
    const fold = 0.7 + 0.3 * step(0.5, fract(x / 0.07));
    const pot = step(Math.abs(x - 0.55), 0.14) * step(y, 0.32);
    const leaf = step(Math.hypot((x - 0.55) * 1.0, (y - 0.75) * 0.8), 0.36);
    c = [0.28, 0.14, 0.12].map((v) => v * fold) as [number, number, number];
    c = mix3(c, [0.3, 0.2, 0.12], pot);
    c = mix3(c, [0.1, 0.18, 0.07], leaf);
    m = Math.min(1, curtain + pot + leaf);
  }
  return { colour: c, mask: m };
}

/**
 * A walk-up's windows on one face, as the shader lays them (ARCH 1: bays
 * near 2.2 to 2.8 m, one punched window a bay at 31% to 69% of it and 20%
 * to 78% of the storey), in metres along the face from its corner and up
 * from the ground, for the UI test that reads the rooms behind them.
 */
export function walkupWindows(faceW: number, bs: number, h: number): Array<{ u0: number; u1: number; y0: number; y1: number }> {
  const s = SECTIONS.walkup;
  const bayT = 2.2 + bs * 0.6;
  const n = Math.max(1, Math.floor(faceW / bayT + 0.5));
  const cw = faceW / n;
  const floors = Math.floor((h - s.ground - s.parapet) / s.floor);
  const out: Array<{ u0: number; u1: number; y0: number; y1: number }> = [];
  for (let j = 0; j < floors; j++) for (let i = 0; i < n; i++) out.push({ u0: (i + 0.31) * cw, u1: (i + 0.69) * cw, y0: s.ground + (j + 0.2) * s.floor, y1: s.ground + (j + 0.78) * s.floor });
  return out;
}

/**
 * The rooms' shader functions, pasted into the facade program (the same
 * arithmetic as roomLight and roomCard above): the paints, the light and the
 * furniture cards, and the arc length round a cut corner (cornerU).
 */
export const ROOM_GLSL = /* glsl */ `
  #define ROOM_CARDS 8.0
  // Eight wall paints behind the city's windows: warm white, cream, pale grey, sage, duck egg, ochre, dusty pink, panelled oak.
  vec3 roomPaint(float i) {
    return i < 0.5 ? vec3(0.62, 0.58, 0.52) : i < 1.5 ? vec3(0.6, 0.52, 0.38) : i < 2.5 ? vec3(0.46, 0.46, 0.45) : i < 3.5 ? vec3(0.42, 0.45, 0.38)
      : i < 4.5 ? vec3(0.42, 0.47, 0.48) : i < 5.5 ? vec3(0.52, 0.42, 0.27) : i < 6.5 ? vec3(0.52, 0.44, 0.41) : vec3(0.3, 0.2, 0.12);
  }
  // The light at P in a room (along, up, in): a ceiling fitting near the middle when lit; the dusk through the glass,
  // dying toward the back, when not. Never nothing.
  float roomLight(float lit, vec3 P, vec3 box) {
    vec3 d = P - vec3(box.x * 0.5, box.y - 0.05, box.z * 0.45);
    float on = 1.7 / (1.0 + 0.22 * dot(d, d));
    float off = 0.3 * (0.6 * exp(-P.z * 0.35) + 0.12 * (1.0 - P.z / box.z) + 0.3);
    return mix(off, on, lit);
  }
  // A furniture card on the back wall: p in metres from the card's foot at the wall's middle; rgb and its cover.
  vec4 roomCard(float card, vec2 p, float lit) {
    float ax = abs(p.x);
    vec3 c = vec3(0.0);
    float m = 0.0;
    if (card < 0.5) {
      // A bookcase: a dark case, shelves, books of uneven height in muted colours.
      float inCase = step(ax, 1.0) * step(p.y, 1.95);
      float sy = fract((p.y - 0.05) / 0.38);
      float col = floor(p.x / 0.055);
      float row = floor(p.y / 0.38);
      float bh = 0.55 + 0.3 * h21(vec2(col, row));
      float book = step(0.12, sy) * step(sy, bh) * step(0.12, fract(p.x / 0.055)) * step(0.3, h21(vec2(col, 3.0)));
      vec3 hue = 0.5 + 0.5 * cos(6.2831 * (h21(vec2(col, 7.0)) + vec3(0.0, 0.33, 0.67)));
      vec3 bc = mix(vec3(0.3), hue, 0.35) * (0.1 + 0.25 * h21(vec2(col, 9.0)));
      c = mix(vec3(0.16, 0.1, 0.06), bc, book) * (0.6 + 0.4 * step(0.12, sy) * step(sy, 1.0));
      c = mix(c, vec3(0.2, 0.13, 0.08), step(sy, 0.1));
      m = inCase;
    } else if (card < 1.5) {
      // Two framed pictures.
      float fx = abs(ax - 0.6);
      float fy = abs(p.y - 1.6);
      float frame = step(fx, 0.3) * step(fy, 0.36);
      float inner = step(fx, 0.25) * step(fy, 0.31);
      float pic = step(fx, 0.2) * step(fy, 0.25);
      c = mix(vec3(0.12, 0.08, 0.05), vec3(0.6, 0.58, 0.54), inner);
      c = mix(c, vec3(0.28, 0.3, 0.26) * (0.6 + 0.6 * h21(floor(p * 4.0))), pic);
      m = frame;
    } else if (card < 2.5) {
      // A wardrobe: two tall doors, a shadow line between, handles.
      float box = step(ax, 0.65) * step(p.y, 2.15);
      float gap = min(1.0, step(ax, 0.012) + step(abs(p.y - 2.15), 0.02) + step(abs(p.y - 0.08), 0.015));
      float handle = step(abs(ax - 0.08), 0.012) * step(abs(p.y - 1.05), 0.1);
      c = vec3(0.3, 0.2, 0.12) * (1.0 - 0.6 * gap);
      c = mix(c, vec3(0.5, 0.45, 0.35), handle);
      m = box;
    } else if (card < 3.5) {
      // A desk with a monitor, lit when the room is.
      float top = step(ax, 0.8) * step(abs(p.y - 0.74), 0.025);
      float legs = step(abs(ax - 0.75), 0.03) * step(p.y, 0.74);
      float mon = step(ax, 0.3) * step(abs(p.y - 1.03), 0.19);
      float screen = step(ax, 0.27) * step(abs(p.y - 1.03), 0.16);
      float stand = step(ax, 0.04) * step(p.y, 0.84) * step(0.74, p.y);
      c = mix(vec3(0.3, 0.22, 0.14), vec3(0.08), min(1.0, legs + stand + mon));
      c = mix(c, mix(vec3(0.05), vec3(1.2, 1.3, 1.5), lit), screen);
      m = min(1.0, top + legs + mon + stand);
    } else if (card < 4.5) {
      // A bed: the headboard and two pillows.
      float head = step(ax, 0.85) * step(p.y, 1.15) * step(0.3, p.y);
      float pillow = step(abs(ax - 0.42), 0.32) * step(abs(p.y - 0.62), 0.13);
      c = mix(vec3(0.22, 0.16, 0.13), vec3(0.6, 0.58, 0.55), pillow);
      m = head;
    } else if (card < 5.5) {
      // A kitchen: wall cupboards, the worktop and the units under it.
      float upper = step(ax, 1.15) * step(abs(p.y - 1.85), 0.35);
      float lower = step(ax, 1.15) * step(p.y, 0.9);
      float door = step(0.04, fract((p.x + 1.15) / 0.575));
      float top = step(ax, 1.17) * step(abs(p.y - 0.92), 0.025);
      c = vec3(0.5, 0.49, 0.45) * (0.55 + 0.45 * door);
      c = mix(c, vec3(0.08, 0.08, 0.09), top);
      m = min(1.0, upper + lower + top);
    } else if (card < 6.5) {
      // A sofa's back and a standard lamp beside it.
      float sofa = step(ax, 0.85) * step(p.y, 0.95) * step(0.3, p.y);
      float stem = step(abs(p.x - 1.1), 0.015) * step(p.y, 1.55);
      float shade = step(abs(p.x - 1.1), 0.16) * step(abs(p.y - 1.7), 0.15);
      c = mix(vec3(0.2, 0.18, 0.22), vec3(0.08), stem);
      c = mix(c, mix(vec3(0.3, 0.25, 0.2), vec3(1.5, 1.1, 0.7), lit), shade);
      m = min(1.0, sofa + stem + shade);
    } else {
      // Curtains either side, and a plant.
      float curtain = step(abs(ax - 1.05), 0.22) * step(0.15, p.y);
      float fold = 0.7 + 0.3 * step(0.5, fract(p.x / 0.07));
      float pot = step(abs(p.x - 0.55), 0.14) * step(p.y, 0.32);
      float leaf = step(length((p - vec2(0.55, 0.75)) * vec2(1.0, 0.8)), 0.36);
      c = vec3(0.28, 0.14, 0.12) * fold;
      c = mix(c, vec3(0.3, 0.2, 0.12), pot);
      c = mix(c, vec3(0.1, 0.18, 0.07), leaf);
      m = min(1.0, curtain + pot + leaf);
    }
    return vec4(c, m);
  }
  // The arc length of a quarter ellipse (half-axes a along x, b along z) from angle 0 to th: Simpson over eight steps.
  float ellipseArc(float a, float b, float th) {
    float h = th * 0.125;
    float sum = 0.0;
    for (int i = 0; i <= 8; i++) {
      float t = float(i) * h;
      float f = length(vec2(a * sin(t), b * cos(t)));
      sum += f * ((i == 0 || i == 8) ? 1.0 : (mod(float(i), 2.0) > 0.5 ? 4.0 : 2.0));
    }
    return sum * h / 3.0;
  }
`;
