import * as THREE from 'three';

import { QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import { BANKS, BRIDGE_APPROACH, BRIDGES, COPING, PIERS, QUAY, QUAY_LAMP_CLEAR, QUAY_LAMP_IN, QUAY_LAMP_REACH, QUAY_LAMP_STEP, RIVER } from '../../../shared/commute.js';
import { AGENT_ROOT_SCALE } from '../../../shared/tower-layout.js';
import { CIVIC_LAMPS, FOUNTAIN, HALL } from './exchange.js';
import type { CollarPlaza as Plaza } from './collar.js';
import { BLOCK, BOLLARD_RING, BOLLARDS, COURT_LANTERN_INSET, COURT_LANTERN_REACH, COURT_LANTERN_STEP, COURT_PLINTH_CLEAR, LAMP_EDGE, LAMP_OFFSETS, PITCH, PLAZA_LAMP_RING, PLAZA_LAMPS, PLAZA_RADIUS, STREET } from './lots.js';
import { OUT_PARS, OUT_UNIFORMS } from './lightsout.js';
import { LOD_EYE } from './lod-shader.js';

/**
 * The street floor: kerbs 15 cm over the carriageway along every street
 * edge, dropped to a lip at the crossings; a gutter beside each kerb; the
 * pavements a step up on the kerbs' level; and asphalt worn by where it is
 * in the world (tyre tracks along the lanes, patch repairs, oil where the
 * cars stand at the stop lines and the cab ranks, wet in the gutters and the
 * low spots, catching the sky).
 *
 * The floor is drawn twice. The ground plane (ground.ts) is flat at the
 * road's level and carries the whole shader: paving, plazas, asphalt and its
 * wear, lamp pools. Near the eye, one instanced mesh of kerb tiles (one per
 * block, the pavement ring and the block inside it at the kerb's height, its
 * faces down to the road, its corners dropped) stands on the plane in the
 * same shader, so the kerb has an edge the light can catch. The tiles sink
 * to the plane where a plaza, a court, a quay or the river is the floor, and
 * fade into the plane past their reach by the same screen-door the roof kit
 * uses, so from home nothing is added.
 */

/** The kerb: its upstand over the carriageway, the kerb stone's width on the pavement, and the gutter's width in the road beside it, in metres. */
export const KERB = { height: 0.15, width: 0.3, gutter: 0.45 } as const;
/** The kerb face stands this far from a block's centre: the block's half plus the pavement (the street's half less the lane pair's). */
export const KERB_EDGE = BLOCK / 2 + STREET / 4;
/** The pedestrian crossing lies this far from a junction's centre: from the cross street's kerb line to the stop line (ambient.ts BOX). */
export const CROSSING = { from: STREET / 4, to: 6.5 } as const;
/** A dropped kerb keeps this share of the kerb's height as a lip. */
export const DROPPED = 0.1;
/** The pavement ramps down to a dropped kerb over this far behind the kerb stone. */
const RAMP_BACK = 1.4;
/** Along a kerb, from the block's centre: the drop begins here and is complete at the crossing's stop line. */
const DROP = { start: PITCH / 2 - CROSSING.to - 1.2, full: PITCH / 2 - CROSSING.to } as const;
/** A lane's centre, this far from the street's centre line (ambient.ts LANE). */
const LANE = 2;
/** Metres per paving texture tile. */
const PAVE_TILE = 4;
/** Lamp heads reach this far over the road from the pole. */
export const LAMP_REACH = 1.3;
/** Most plazas the floor shader tracks at once (the civic plaza plus districts, sites and courts). */
export const MAX_PLAZAS = 64;
/** Most cab ranks the asphalt darkens under. */
export const MAX_RANKS = 16;
/** How far from the eye the kerb tiles stand, by tier (filled out to `far` plus a step; at that range a 15 cm step is under a pixel). */
export const TILE_REACH = { high: { near: 300, far: 360 }, medium: { near: 190, far: 240 } } as const;
/** Blocks within this many of the centre carry kerb tiles: the ambient city's far ring (grid.ts farRadius), past which no street is built. */
export const TILE_RADIUS = { high: 40, medium: 28 } as const;
/** The tiles refill once the eye has moved this far. */
const TILE_STEP = 40;
/** The plinth's base course, in metres (its steps add 4 m each side). */
const PLINTH_FOOT = 34;
/** Half the foot of an agent tower's root (a district root's 21 m at the agent scale): the floodlit edge on a court. */
const AGENT_FOOT_HALF = 21 * AGENT_ROOT_SCALE;
/** Across each quay, from the wall's face inland: the coping, then a promenade of granite setts, then the quay road to its far kerb. */
const PROMENADE_TO = COPING + 4.2;
const QUAY_ROAD_TO = QUAY - 1.2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const fract = (v: number): number => v - Math.floor(v);
/** The shader's hash and value noise, in JS, so the wear can be read where the shader paints it. */
function gHash(x: number, y: number): number {
  let px = fract(x * 123.34);
  let py = fract(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fract(px * py);
}
function gNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = gHash(ix, iy) + (gHash(ix + 1, iy) - gHash(ix, iy)) * fx;
  const b = gHash(ix, iy + 1) + (gHash(ix + 1, iy + 1) - gHash(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}

// ---------------------------------------------------------------- the floor's shape

/** Block-local coordinates: from the centre of the block a point is on (or whose street corridor it is in). */
function local(x: number, z: number): [number, number] {
  return [x - Math.round(x / PITCH) * PITCH, z - Math.round(z / PITCH) * PITCH];
}

/**
 * The share of the kerb's height the pavement stands at, in block-local
 * coordinates: 1 along the runs, DROPPED through each crossing and the
 * corner apron between two, ramping down behind the kerb stone over
 * RAMP_BACK and along the kerb from DROP.start to DROP.full.
 */
export function kerbShare(lx: number, lz: number): number {
  const along = (s: number): number => smooth(DROP.start, DROP.full, Math.abs(s));
  const back = (u: number): number => smooth(KERB_EDGE - KERB.width - RAMP_BACK, KERB_EDGE - KERB.width, Math.abs(u));
  const atX = 1 - (1 - DROPPED) * along(lz) * back(lx);
  const atZ = 1 - (1 - DROPPED) * along(lx) * back(lz);
  return Math.min(atX, atZ);
}

/**
 * The street floor's height over the carriageway at a world point: the
 * kerb's on the pavements and the block behind them, dropped at the
 * crossings, 0 on the roads. Paved ground (plazas, courts, quays) is the
 * caller's: there the floor is the plane.
 */
export function streetFloor(x: number, z: number): number {
  const [lx, lz] = local(x, z);
  if (Math.abs(lx) > KERB_EDGE || Math.abs(lz) > KERB_EDGE) return 0;
  if (!tileClearsRiver(x - lx)) return 0;
  return KERB.height * kerbShare(lx, lz);
}

/**
 * Whether a block's kerb tile (centred at x) stands clear of the river: a
 * block the channel or its copings cut into keeps its quay at street level
 * (the ground's own paving), so no raised pavement hangs over the water.
 */
export function tileClearsRiver(x: number): boolean {
  return x + KERB_EDGE <= BANKS.west - COPING || x - KERB_EDGE >= BANKS.east + COPING;
}

/** 1 in a gutter (the road within KERB.gutter of a kerb face), 0 elsewhere. */
export function gutterAt(x: number, z: number): number {
  const [lx, lz] = local(x, z);
  const across = Math.max(Math.abs(lx), Math.abs(lz)) - KERB_EDGE;
  return across > 0 && across <= KERB.gutter ? 1 : 0;
}

/**
 * The wear at a world point on a road, each term 0 to 1 (0 off the roads):
 * the tyre tracks' polish, a patch repair, oil at the stop lines, and the
 * wet. The same arithmetic as the shader's streetWear, so a reading here is
 * what the asphalt shows there.
 */
export function wearAt(x: number, z: number): { track: number; patch: number; oil: number; wet: number } {
  const [lx, lz] = local(x, z);
  const alongZ = Math.abs(lx) >= Math.abs(lz);
  const across = alongZ ? Math.abs(lx) : Math.abs(lz);
  if (across <= KERB_EDGE) return { track: 0, patch: 0, oil: 0, wet: 0 };
  const run = alongZ ? lz : lx;
  const fromKerb = across - KERB_EDGE;
  const street = alongZ ? Math.floor(x / PITCH) * 2 : Math.floor(z / PITCH) * 2 + 1;
  const sid = alongZ ? Math.floor(z / PITCH) : Math.floor(x / PITCH);
  const dLane = across - (PITCH / 2 - LANE);
  const wander = (gHash(Math.floor(run / 12) + sid * 11.7, street * 3.1) - 0.5) * 0.3;
  const w = Math.abs(Math.abs(dLane + wander) - 0.78);
  const grainN = gNoise(x * 0.21, z * 0.21);
  let track = Math.exp((-w * w) / 0.09) * (0.55 + 0.45 * grainN);
  track *= smooth(0, 0.5, fromKerb) * (1 - smooth(3.6, 4, fromKerb));
  const cu = Math.floor(run / 5);
  const h = gHash(cu + sid * 97, street * 1.37);
  let patch = 0;
  if (h > 0.86) {
    const len = 0.45 + 0.4 * gHash(cu * 1.7, street + 0.3);
    const a0 = fract(run / 5);
    const across0 = 0.2 + 1.6 * gHash(cu * 2.3, street + 0.7);
    const wide = 1.2 + 1.8 * gHash(cu * 3.1, street + 0.9);
    patch = a0 > 0.05 && a0 < 0.05 + len && fromKerb > across0 && fromKerb < across0 + wide ? 1 : 0;
  }
  const toward = alongZ ? Math.sign(lx) : -Math.sign(lz);
  const r = toward * run;
  let oil = smooth(26, 33, r) * (1 - smooth(33.5, 34.5, r)) * (1 - smooth(0.4, 0.9, Math.abs(dLane))) * (0.5 + 0.5 * grainN);
  oil = clamp01(oil);
  const gutter = fromKerb <= KERB.gutter ? 1 : 0;
  const wetGutter = gutter * (0.35 + 0.65 * smooth(0.35, 0.6, gNoise(run * 0.12 + sid * 5.3, street * 2.9)));
  const low = gNoise(x * 0.33, z * 0.33) + 0.12 * gNoise(x * 1.9, z * 1.9) - 0.06;
  const puddle = smooth(0.655, 0.665, low) * (1 - smooth(3, 3.8, fromKerb));
  const damp = smooth(0.6, 0.655, low) * (1 - smooth(3, 3.8, fromKerb)) * 0.45;
  return { track: clamp01(track), patch, oil, wet: clamp01(Math.max(wetGutter, puddle, damp)) };
}

/**
 * A block's kerb tile: a grid over the block and its pavements, flat at the
 * kerb's height, its outer columns the kerb face down to the road, the arris
 * chamfered, and the corner aprons dropped with their ramps, as kerbShare
 * says. Instanced once per block near the eye.
 */
export function kerbTileGeometry(): THREE.BufferGeometry {
  const E = KERB_EDGE;
  const back = E - KERB.width;
  // Columns across one axis (the same across the other): each a coordinate and whether it is still on the pavement.
  const half: Array<{ u: number; on: boolean; arris: boolean }> = [
    { u: E, on: false, arris: false },
    { u: E, on: true, arris: true },
    { u: E - 0.03, on: true, arris: false },
    { u: back, on: true, arris: false },
    { u: back - RAMP_BACK, on: true, arris: false },
    { u: DROP.full, on: true, arris: false },
    { u: DROP.start, on: true, arris: false },
  ];
  const cols = [...half.map((c) => ({ ...c, u: -c.u })), ...half.slice().reverse()];
  const n = cols.length;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const cz of cols) {
    for (const cx of cols) {
      let y = 0;
      if (cx.on && cz.on) {
        const share = kerbShare(Math.min(Math.abs(cx.u), back), Math.min(Math.abs(cz.u), back));
        y = KERB.height * share;
        // The arris: a 2 cm chamfer on a full kerb, in proportion where it is dropped.
        if (cx.arris || cz.arris) y -= 0.02 * share;
      }
      pos.push(cx.u, y, cz.u);
      uv.push(cx.u / PAVE_TILE, cz.u / PAVE_TILE);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // The face cells (zero width) are kept: they are the kerb face. Cells off the pavement on both axes are not.
      if (!cols[i].on && !cols[i + 1].on) continue;
      if (!cols[j].on && !cols[j + 1].on) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the shader

/** The scans the floor is painted with (materials.ts texture(): the pave set and the granite colour), or blank texels in a test without a browser. */
export interface FloorMaps {
  pave: THREE.Texture;
  paveNormal: THREE.Texture;
  paveArm: THREE.Texture;
  granite: THREE.Texture;
}

function blankMaps(): FloorMaps {
  const one = (): THREE.Texture => {
    const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  };
  return { pave: one(), paveNormal: one(), paveArm: one(), granite: one() };
}

/**
 * The wear's noise, as a texture made here at start (no file): four
 * independent fields of smooth value noise, 16 cells across a 256 texel
 * square that repeats, so a noise read is one fetch instead of four hashes.
 * nz(p) in the shader reads it at the scale gNoise(p) had.
 */
const NOISE_SIZE = 256;
const NOISE_CELLS = 16;
let noiseTex: THREE.DataTexture | null = null;
function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  const per = NOISE_SIZE / NOISE_CELLS;
  for (let c = 0; c < 4; c++) {
    const lattice = new Float32Array(NOISE_CELLS * NOISE_CELLS);
    for (let j = 0; j < NOISE_CELLS; j++) for (let i = 0; i < NOISE_CELLS; i++) lattice[j * NOISE_CELLS + i] = gHash(i + c * 31.7, j + c * 17.3);
    const at = (i: number, j: number): number => lattice[((j + NOISE_CELLS) % NOISE_CELLS) * NOISE_CELLS + ((i + NOISE_CELLS) % NOISE_CELLS)];
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        const u = x / per;
        const v = y / per;
        const i = Math.floor(u);
        const j = Math.floor(v);
        let fx = u - i;
        let fy = v - j;
        fx = fx * fx * (3 - 2 * fx);
        fy = fy * fy * (3 - 2 * fy);
        const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
        const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
        data[(y * NOISE_SIZE + x) * 4 + c] = Math.round((a + (b - a) * fy) * 255);
      }
    }
  }
  noiseTex = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

/** The floor's uniforms, shared by the plane and the tiles. */
export interface FloorUniforms {
  /** x and z of each plaza's centre; a quarter's court half-side (0 for a round plaza, negative for a terrace, which flattens the tiles but is not paved); its standing plots as bits (-1 dark). */
  uPlazas: { value: THREE.Vector4[] };
  uPlazaCount: { value: number };
  /** Each cab rank: x, z, 1 along x or 0 along z, half its length. */
  uRanks: { value: THREE.Vector4[] };
  uRankCount: { value: number };
}

function floorUniforms(): FloorUniforms {
  return {
    uPlazas: { value: Array.from({ length: MAX_PLAZAS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) },
    uPlazaCount: { value: 1 },
    uRanks: { value: Array.from({ length: MAX_RANKS }, () => new THREE.Vector4(1e6, 1e6, 1, 0)) },
    uRankCount: { value: 0 },
  };
}

/**
 * The asphalt's wear by world position (the GLSL of wearAt): tyre tracks
 * either side of each lane's centre, patch repairs in crisp rectangles, oil
 * where the cars stand at the stop lines and in the cab ranks' bays, and the
 * wet in the gutters and the low spots. Reads nothing that moves.
 */
export const WEAR_GLSL = /* glsl */ `
  const float KERB_EDGE = ${KERB_EDGE.toFixed(2)};
  const float KERB_W = ${KERB.width.toFixed(2)};
  const float GUTTER_W = ${KERB.gutter.toFixed(2)};
  const float LANE_AT = ${(PITCH / 2 - LANE).toFixed(2)};
  uniform vec4 uRanks[${MAX_RANKS}];
  uniform int uRankCount;
  uniform sampler2D uNoise;
  // Smooth value noise from the noise texture, four fields, at gNoise's scale (a cell per unit of p).
  float nz(vec2 p) { return texture2D(uNoise, p / ${NOISE_CELLS.toFixed(1)}).r; }
  float nzB(vec2 p) { return texture2D(uNoise, p / ${NOISE_CELLS.toFixed(1)}).g; }
  float nzC(vec2 p) { return texture2D(uNoise, p / ${NOISE_CELLS.toFixed(1)}).b; }
  float nzD(vec2 p) { return texture2D(uNoise, p / ${NOISE_CELLS.toFixed(1)}).a; }
  // gp: world xz; lc: block-local xz (block centred). Only meaningful on a road (max(|lc|) > KERB_EDGE).
  void streetWear(vec2 gp, vec2 lc, out float track, out float mend, out float oil, out float wet) {
    bool alongZ = abs(lc.x) >= abs(lc.y);
    float across = alongZ ? abs(lc.x) : abs(lc.y);
    float run = alongZ ? lc.y : lc.x;
    float fromKerb = across - KERB_EDGE;
    float street = alongZ ? floor(gp.x / PITCH) * 2.0 : floor(gp.y / PITCH) * 2.0 + 1.0;
    float sid = alongZ ? floor(gp.y / PITCH) : floor(gp.x / PITCH);
    float dLane = across - LANE_AT;
    float wander = (gHash(vec2(floor(run / 12.0) + sid * 11.7, street * 3.1)) - 0.5) * 0.3;
    float w = abs(abs(dLane + wander) - 0.78);
    float grainN = nz(gp * 0.21);
    track = exp(-w * w / 0.09) * (0.55 + 0.45 * grainN);
    track *= smoothstep(0.0, 0.5, fromKerb) * (1.0 - smoothstep(3.6, 4.0, fromKerb));
    float cu = floor(run / 5.0);
    float h = gHash(vec2(cu + sid * 97.0, street * 1.37));
    mend = 0.0;
    if (h > 0.86) {
      float len = 0.45 + 0.4 * gHash(vec2(cu * 1.7, street + 0.3));
      float a0 = fract(run / 5.0);
      float across0 = 0.2 + 1.6 * gHash(vec2(cu * 2.3, street + 0.7));
      float wide = 1.2 + 1.8 * gHash(vec2(cu * 3.1, street + 0.9));
      mend = step(0.05, a0) * step(a0, 0.05 + len) * step(across0, fromKerb) * step(fromKerb, across0 + wide);
    }
    float toward = alongZ ? sign(lc.x) : -sign(lc.y);
    float r = toward * run;
    oil = smoothstep(26.0, 33.0, r) * (1.0 - smoothstep(33.5, 34.5, r)) * (1.0 - smoothstep(0.4, 0.9, abs(dLane))) * (0.5 + 0.5 * grainN);
    for (int i = 0; i < ${MAX_RANKS}; i++) {
      if (i >= uRankCount) break;
      vec4 rk = uRanks[i];
      vec2 d = gp - rk.xy;
      float u = rk.z > 0.5 ? d.x : d.y;
      float l = rk.z > 0.5 ? d.y : d.x;
      float bay = step(abs(u), rk.w) * step(abs(l), 1.6);
      if (bay > 0.0) oil += (0.25 + 0.55 * nzB(gp * 0.9)) * (1.0 - smoothstep(0.9, 1.6, abs(l)));
    }
    oil = clamp(oil, 0.0, 1.0);
    float gutter = step(fromKerb, GUTTER_W);
    float wetGutter = gutter * (0.35 + 0.65 * smoothstep(0.35, 0.6, nzB(vec2(run * 0.12 + sid * 5.3, street * 2.9))));
    // Standing water in the low spots of the kerb lane: a crisp shoreline, a damp rim round it.
    float low = nzC(gp * 0.33) + 0.12 * nzD(gp * 1.9) - 0.06;
    float puddle = smoothstep(0.655, 0.665, low) * (1.0 - smoothstep(3.0, 3.8, fromKerb));
    float damp = smoothstep(0.6, 0.655, low) * (1.0 - smoothstep(3.0, 3.8, fromKerb)) * 0.45;
    wet = clamp(max(wetGutter, max(puddle, damp)), 0.0, 1.0);
  }
`;

/** The constants and the plaza functions both shader stages share. */
function floorPars(): string {
  const lampOffsets = LAMP_OFFSETS.map((o) => o.toFixed(1)).join(', ');
  return /* glsl */ `
    uniform vec4 uPlazas[${MAX_PLAZAS}];
    uniform int uPlazaCount;
    const float PITCH = ${PITCH.toFixed(1)};
    const float HALF_BLOCK = ${(BLOCK / 2).toFixed(1)};
    const float LAMP_AT = ${(LAMP_EDGE + LAMP_REACH).toFixed(2)};
    const float PLAZA_R = ${PLAZA_RADIUS.toFixed(1)};
    const float RING_R = ${PLAZA_LAMP_RING.toFixed(1)};
    const float RING_N = ${PLAZA_LAMPS.toFixed(1)};
    const float BOLLARD_R = ${BOLLARD_RING.toFixed(1)};
    const float BOLLARD_N = ${BOLLARDS.toFixed(1)};
    const float PLINTH_HALF = ${(PLINTH_FOOT / 2 + 4).toFixed(1)};
    const float AGENT_FOOT = ${AGENT_FOOT_HALF.toFixed(2)};
    const float QOFF = ${Math.abs(QUARTER_OFFSETS[0].x).toFixed(1)};
    const float LANTERN_IN = ${COURT_LANTERN_INSET.toFixed(1)};
    const float LANTERN_STEP = ${COURT_LANTERN_STEP.toFixed(1)};
    const float LANTERN_REACH = ${COURT_LANTERN_REACH.toFixed(1)};
    const float PLINTH_CLEAR = ${COURT_PLINTH_CLEAR.toFixed(1)};
    const float OFFS[4] = float[4](${lampOffsets});
    const vec2 CIVIC_LAMP[4] = vec2[4](${CIVIC_LAMPS.map((l) => `vec2(${l.x.toFixed(1)}, ${l.z.toFixed(1)})`).join(', ')});
    const vec2 FOUNT = vec2(${FOUNTAIN.x.toFixed(1)}, ${FOUNTAIN.z.toFixed(1)});
    const float FOUNT_R = ${FOUNTAIN.radius.toFixed(1)};
    const float STAIR_FOOT = ${(HALL.z0 + HALL.depth + HALL.stair).toFixed(1)};
    const float HALL_HALF = ${(HALL.width / 2).toFixed(1)};
    const float RIVER_X = ${RIVER.x.toFixed(1)};
    const float RIVER_HALF = ${(RIVER.width / 2).toFixed(1)};
    const float BANK_W = ${BANKS.west.toFixed(1)};
    const float BANK_E = ${BANKS.east.toFixed(1)};
    const float QUAY_W = ${QUAY.toFixed(1)};
    const float PROM_TO = ${PROMENADE_TO.toFixed(2)};
    const float QROAD_TO = ${QUAY_ROAD_TO.toFixed(2)};
    const float APPROACH = ${BRIDGE_APPROACH.toFixed(1)};
    const float BRIDGE_Z[3] = float[3](${BRIDGES.map((z) => z.toFixed(1)).join(', ')});
    const float QLAMP_IN = ${QUAY_LAMP_IN.toFixed(2)};
    const float QLAMP_STEP = ${QUAY_LAMP_STEP.toFixed(1)};
    const float QLAMP_REACH = ${QUAY_LAMP_REACH.toFixed(1)};
    const float QLAMP_CLEAR = ${QUAY_LAMP_CLEAR.toFixed(1)};
    const vec2 PIER_AT[${PIERS.length}] = vec2[${PIERS.length}](${PIERS.map((p) => `vec2(${p.bank === 'west' ? '-1.0' : '1.0'}, ${p.z.toFixed(1)})`).join(', ')});
    float gHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
    // A plaza entry's radius: a court's half-side, a terrace's (negative, flattening only), or the round plaza's.
    float plazaRadius(vec4 u) { return u.z > 0.0 ? u.z : (u.z < 0.0 ? -u.z : PLAZA_R); }
    float plazaDist(vec4 u, vec2 p) { vec2 q = abs(p - u.xy); return u.z != 0.0 ? max(q.x, q.y) : length(q); }
    // How far the street floor stands here: 0 on a plaza, a court, a terrace, a quay, the river or a bridge's approach.
    float floorStands(vec2 p) {
      float s = 1.0;
      for (int i = 0; i < ${MAX_PLAZAS}; i++) {
        if (i >= uPlazaCount) break;
        vec4 u = uPlazas[i];
        s = min(s, smoothstep(plazaRadius(u) - 1.0, plazaRadius(u) + 3.0, plazaDist(u, p)));
      }
      float dq = p.x < RIVER_X ? BANK_W - p.x : p.x - BANK_E;
      s = min(s, smoothstep(QUAY_W, QUAY_W + 3.0, dq));
      for (int i = 0; i < 3; i++) {
        float az = abs(p.y - BRIDGE_Z[i]);
        s = min(s, 1.0 - (1.0 - smoothstep(7.8, 9.0, az)) * step(0.0, dq) * (1.0 - smoothstep(QUAY_W + APPROACH, QUAY_W + APPROACH + 2.0, dq)));
      }
      return s;
    }
  `;
}

/** The fragment stage's own functions: the nearest paved plaza and the lights (ground.ts as it was). */
const FLOOR_FRAGMENT_PARS = /* glsl */ `
  // True when a quay lamp stands at z on this bank (-1 west, 1 east): river.ts quayLampClear.
  bool quayLamp(float side, float z) {
    if (abs(z) > QLAMP_REACH + 0.5) return false;
    for (int i = 0; i < 3; i++) if (abs(z - BRIDGE_Z[i]) < QLAMP_CLEAR) return false;
    for (int i = 0; i < ${PIERS.length}; i++) if (PIER_AT[i].x == side && abs(z - PIER_AT[i].y) < QLAMP_CLEAR) return false;
    return true;
  }
  // The paved plaza whose edge is nearest (a terrace is not paved): its centre, its radius (a quarter's court half-side),
  // whether it is a district (index 0 is the civic plaza) and a quarter's standing plots. Returns the distance from its
  // centre, round for a plaza and square (the larger of the two offsets) for a court.
  float nearestPlaza(vec2 p, out vec2 c, out bool district, out bool civic, out float r, out float court, out float plots) {
    float best = 1e9; float bestD = 1e9; c = vec2(1e6); district = false; civic = false; r = PLAZA_R; court = 0.0; plots = 0.0;
    for (int i = 0; i < ${MAX_PLAZAS}; i++) {
      if (i >= uPlazaCount) break;
      vec4 u = uPlazas[i];
      if (u.z < 0.0) continue;
      vec2 q = abs(p - u.xy);
      float d = u.z > 0.0 ? max(q.x, q.y) : length(q);
      float rr = u.z > 0.0 ? u.z : PLAZA_R;
      if (d - rr < best) { best = d - rr; bestD = d; c = u.xy; district = i > 0 && u.z == 0.0; civic = i == 0; r = rr; court = u.z; plots = u.w; }
    }
    return bestD;
  }
  // Nearest of n lights evenly spaced on a ring of radius r (offset by half a step when half is 0.5).
  vec2 ringLight(vec2 d, float r, float n, float half_) {
    float st = 6.28318530718 / n;
    float a = (floor(atan(d.y, d.x) / st - half_ + 0.5) + half_) * st;
    return d - vec2(cos(a), sin(a)) * r;
  }
  float pool(vec2 d) { return exp(-dot(d, d) / 38.0) + 0.18 * exp(-dot(d, d) / 260.0); }
  bool inPlaza(vec2 p) {
    for (int i = 0; i < ${MAX_PLAZAS}; i++) {
      if (i >= uPlazaCount) break;
      vec4 u = uPlazas[i];
      if (u.z < 0.0) continue;
      vec2 q = abs(p - u.xy);
      if (u.z > 0.0 ? max(q.x, q.y) < u.z : length(q) < PLAZA_R) return true;
    }
    return false;
  }
`;

/**
 * The floor's colour, roughness and relief at a fragment: paving with its
 * weathering, the kerb stones and their faces, the gutter, the asphalt and
 * its wear, the quays' setts, the plaza paving. On the plane and the tiles alike.
 */
const FLOOR_SURFACE = /* glsl */ `
  #include <roughnessmap_fragment>
  vec2 gp = vGP.xz;
  vec2 cellId = floor((gp + PITCH * 0.5) / PITCH);
  vec2 lc = gp - cellId * PITCH;                 // position within this block's cell, block centred
  vec2 plazaC;
  bool district;
  bool civic;
  float plazaR;
  float court;
  float plots;
  float plazaD = nearestPlaza(gp, plazaC, district, civic, plazaR, court, plots);
  float plaza = 1.0 - smoothstep(plazaR - 2.0, plazaR, plazaD);
  float edge = max(abs(lc.x), abs(lc.y));
  float road = smoothstep(KERB_EDGE - 0.02, KERB_EDGE + 0.02, edge) * (1.0 - plaza);
  // The quays: inland from each wall's face, the coping (under granite), a promenade of setts, the quay road.
  float dq = gp.x < RIVER_X ? BANK_W - gp.x : gp.x - BANK_E;
  float onQuay = step(0.0, dq) * (1.0 - step(QUAY_W, dq));
  float quayRoad = smoothstep(PROM_TO, PROM_TO + 0.15, dq) * (1.0 - smoothstep(QROAD_TO - 0.15, QROAD_TO, dq)) * (1.0 - plaza);
  float prom = onQuay * (1.0 - smoothstep(PROM_TO - 0.1, PROM_TO, dq));
  // Each bridge carries its carriageway on inland across the quay to the next street.
  float approach = 0.0;
  for (int i = 0; i < 3; i++) {
    float az = abs(gp.y - BRIDGE_Z[i]);
    approach = max(approach, (1.0 - smoothstep(7.8, 8.0, az)) * step(0.0, dq) * (1.0 - step(QUAY_W + APPROACH, dq)));
  }
  approach *= 1.0 - plaza;
  float quayKerb = (onQuay * (smoothstep(PROM_TO - 0.25, PROM_TO - 0.1, dq) * (1.0 - smoothstep(PROM_TO, PROM_TO + 0.1, dq)) + smoothstep(QROAD_TO - 0.05, QROAD_TO + 0.05, dq) * (1.0 - smoothstep(QROAD_TO + 0.2, QROAD_TO + 0.3, dq)))) * (1.0 - approach) * (1.0 - plaza);
  road = max(road, max(quayRoad, approach));
  bool onStreet = onQuay < 0.5 && approach < 0.5;
  // The kerb stone: a band of granite the stone's width inside the face, on every street edge; on a tile, its face too.
  float kerbTop = smoothstep(KERB_EDGE - KERB_W - 0.02, KERB_EDGE - KERB_W, edge) * (1.0 - smoothstep(KERB_EDGE, KERB_EDGE + 0.02, edge)) * (1.0 - plaza) * (onStreet ? 1.0 : 0.0);
  float kerbFace = 0.0;
  #ifdef STREET_TILE
    kerbFace = (1.0 - smoothstep(0.35, 0.6, abs(vWN.y))) * (1.0 - plaza);
    kerbTop = max(kerbTop, kerbFace);
  #endif
  // Asphalt: dark, faintly blue, with fine grain, and the wear of being driven on.
  float grain = gHash(floor(gp * 9.0)) * 0.12 + gHash(floor(gp * 1.3)) * 0.08;
  vec3 asphalt = vec3(0.028, 0.029, 0.032) * (0.9 + grain);
  float asphaltRough = 0.74 + grain;
  float track = 0.0; float mend = 0.0; float oil = 0.0; float wet = 0.0; float dash = 0.0;
  // The wear is read within 200 m of the eye (past that the tracks and puddles are under a pixel) and eased out.
  float wearNear = 1.0 - smoothstep(140.0, 200.0, distance(vGP, uLodEye));
  if (road > 0.0 && onStreet && wearNear > 0.0) {
    streetWear(gp, lc, track, mend, oil, wet);
    track *= wearNear; oil *= wearNear; wet *= wearNear; mend *= wearNear;
    float fromKerb = edge - KERB_EDGE;
    // A gentle drift of tone along the street (older and newer surfacing, never blotches), then the patch's newer,
    // blacker asphalt.
    float age = nzD(gp * 0.09);
    asphalt *= 0.88 + 0.26 * age;
    // Centre dashes on streets that are not intersections, worn and broken where the tyres cross them.
    bool alongZ = abs(lc.x) > KERB_EDGE && abs(lc.y) <= HALF_BLOCK;
    bool alongX = abs(lc.y) > KERB_EDGE && abs(lc.x) <= HALF_BLOCK;
    float centre = alongZ ? abs(abs(lc.x) - PITCH * 0.5) : alongX ? abs(abs(lc.y) - PITCH * 0.5) : 99.0;
    if (centre < 0.1) {
      float run = alongZ ? lc.y : lc.x;
      dash = (1.0 - smoothstep(0.07, 0.1, centre)) * step(0.5, fract(run / 6.0)) * (0.55 + 0.45 * gHash(floor(gp * 3.0))) * (1.0 - 0.6 * nz(gp * 1.7) * nzB(gp * 0.4 + 3.0));
    }
    asphalt = mix(asphalt, asphalt * 0.62, mend);
    asphaltRough = mix(asphaltRough, 0.88, mend);
    // Tyres polish the aggregate: lighter, smoother.
    asphalt = mix(asphalt, asphalt * 1.35 + vec3(0.006), track * 0.8);
    asphaltRough -= 0.28 * track;
    // Oil: black and a little glossy where the engines drip.
    asphalt = mix(asphalt, vec3(0.012, 0.012, 0.013), oil * 0.85);
    asphaltRough = mix(asphaltRough, 0.42, oil);
    // The gutter: grime in the channel, and the wet standing in it and in the low spots, holding the sky.
    float gutter = (1.0 - smoothstep(GUTTER_W - 0.04, GUTTER_W, fromKerb)) * smoothstep(0.0, 0.03, fromKerb);
    asphalt = mix(asphalt, asphalt * 0.75 + vec3(0.004, 0.0035, 0.003), gutter * 0.9);
    asphalt = mix(asphalt, asphalt * 0.4, wet);
    asphaltRough = mix(asphaltRough, 0.13, wet);
    // A worn stop line across each lane before the junction (the crossing's near edge), broken by the tyres.
    float toward = (abs(lc.x) >= abs(lc.y)) ? sign(lc.x) : -sign(lc.y);
    float along = (abs(lc.x) >= abs(lc.y)) ? lc.y : lc.x;
    float stopLine = (1.0 - smoothstep(0.14, 0.2, abs(toward * along - ${(PITCH / 2 - CROSSING.to + 0.2).toFixed(2)}))) * smoothstep(0.3, 0.6, fromKerb) * (1.0 - smoothstep(3.5, 3.8, fromKerb));
    stopLine *= 0.45 + 0.55 * nzC(gp * 2.6) * (1.0 - 0.7 * track);
    asphalt = mix(asphalt, vec3(0.42, 0.4, 0.34), stopLine * 0.7);
  }
  asphalt = mix(asphalt, vec3(0.3, 0.27, 0.2), dash * 0.8 * (1.0 - wet * 0.5));
  // Weathering: broad stains and lighter worn patches so the paving never reads as one repeated tile.
  float stain = nz(gp * 0.045) * 0.6 + nzD(gp * 0.21) * 0.4;
  diffuseColor.rgb *= 0.72 + 0.5 * stain;
  // Tactile paving on the dropped kerbs' aprons (street.ts kerbShare): a buff field of blisters the pavement's
  // ramp wide, where the kerb drops for a crossing.
  if (edge > ${(DROP.start - 0.5).toFixed(1)} && edge < KERB_EDGE - KERB_W) {
    float dropZ = smoothstep(${DROP.start.toFixed(2)}, ${DROP.full.toFixed(2)}, abs(lc.y)) * smoothstep(${(KERB_EDGE - KERB.width - RAMP_BACK).toFixed(2)}, ${(KERB_EDGE - KERB.width - RAMP_BACK + 0.3).toFixed(2)}, abs(lc.x));
    float dropX = smoothstep(${DROP.start.toFixed(2)}, ${DROP.full.toFixed(2)}, abs(lc.x)) * smoothstep(${(KERB_EDGE - KERB.width - RAMP_BACK).toFixed(2)}, ${(KERB_EDGE - KERB.width - RAMP_BACK + 0.3).toFixed(2)}, abs(lc.y));
    float tactile = max(dropZ, dropX) * (1.0 - step(KERB_EDGE - KERB_W, edge)) * (1.0 - plaza) * (onStreet ? 1.0 : 0.0);
    if (tactile > 0.0) {
      vec2 bl = fract(gp / 0.067) - 0.5;
      float blister = 1.0 - smoothstep(0.26, 0.4, length(bl));
      vec3 buff = vec3(0.4, 0.31, 0.22) * (0.85 + 0.3 * nzB(gp * 3.0)) * (1.0 + 0.22 * blister);
      diffuseColor.rgb = mix(diffuseColor.rgb, buff * (0.72 + 0.5 * stain), tactile * 0.85);
    }
  }
  // The kerb stones: grey granite, each stone 0.9 m with a joint, the arris and the face scuffed with tyre rubber at the foot.
  if (kerbTop > 0.0) {
    float along = (abs(lc.x) > abs(lc.y)) ? lc.y : lc.x;
    float joint = 1.0 - smoothstep(0.012, 0.03, abs(fract(along / 0.915) - 0.5) * 0.915);
    // Grey granite: the scan's grain under the stone's own tone, each stone a shade its own, the lot darkened by weather.
    vec3 granite = mix(texture2D(uKerbMap, gp / 0.9).rgb, vec3(0.5, 0.49, 0.48), 0.4);
    vec3 stone = granite * vec3(0.44, 0.435, 0.43) * (0.78 + 0.4 * gHash(vec2(floor(along / 0.915), floor(edge)))) * (0.85 + 0.3 * nzC(gp * 0.6));
    stone *= mix(1.0, 0.55, joint);
    #ifdef STREET_TILE
      // The face: darker in the gutter's shadow, black with rubber and grime toward its foot, splashed by the wet.
      float scuff = (1.0 - smoothstep(0.0, 0.09, vGP.y)) * kerbFace;
      stone = mix(stone, stone * 0.8, kerbFace);
      stone = mix(stone, vec3(0.02, 0.02, 0.021), scuff * (0.45 + 0.45 * nzD(gp * 2.3)));
    #endif
    diffuseColor.rgb = mix(diffuseColor.rgb, stone, kerbTop);
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, asphalt, road * (1.0 - kerbFace));
  diffuseColor.rgb *= 1.0 - quayKerb * 0.3;
  // The promenade: small granite setts in rows along the river, cooler and darker than the precast paving.
  if (prom > 0.0 && approach < 0.5) {
    vec2 sp = vec2(dq / 0.32, gp.y / 0.44 + 0.5 * mod(floor(dq / 0.32), 2.0));
    vec2 sj = abs(fract(sp) - 0.5);
    float sjoint = 1.0 - smoothstep(0.38, 0.47, max(sj.x, sj.y));
    vec3 sett = vec3(0.34, 0.335, 0.33) * (0.82 + 0.3 * gHash(floor(sp))) * mix(0.55, 1.0, sjoint);
    diffuseColor.rgb = mix(diffuseColor.rgb, sett, prom * (1.0 - plaza));
  }
  // Plaza ring: a band of lighter dressed stone at the plaza's edge.
  float ring = smoothstep(plazaR - 4.0, plazaR - 3.6, plazaD) * (1.0 - smoothstep(plazaR - 1.2, plazaR - 0.8, plazaD));
  diffuseColor.rgb *= 1.0 + ring * 0.18;
  // Inside the plaza: warmer, paler dressed paving laid in concentric courses; a court is laid in a grid of
  // large slabs in staggered rows, and a little darker, so the quarter reads as one paved yard.
  vec2 paveTilt = vec2(0.0);
  float course = 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.06, abs(fract(plazaD / 6.0) - 0.5) - 0.44));
  if (court > 0.0) {
    vec2 cl = gp - plazaC;
    float row = floor(cl.y / 3.0);
    // Relief: each slab bedded a touch out of true, and its arrises worn round into the joint, so the court
    // catches the lanterns slab by slab instead of lying flat as a printed grid.
    vec2 sl = fract(vec2(cl.x / 6.0 + 0.5 * mod(row, 2.0), cl.y / 3.0)) - 0.5;
    vec2 sid = vec2(floor(cl.x / 6.0 + 0.5 * mod(row, 2.0)), row);
    paveTilt = (vec2(gHash(sid + 3.1), gHash(sid + 7.7)) - 0.5) * 0.07;
    paveTilt += vec2(smoothstep(0.43, 0.5, abs(sl.x)) * sign(sl.x), smoothstep(0.4, 0.5, abs(sl.y)) * sign(sl.y)) * 0.45;
    paveTilt *= plaza;
    vec2 slab = abs(fract(vec2(cl.x / 6.0 + 0.5 * mod(row, 2.0), cl.y / 3.0)) - 0.5);
    float joint = 1.0 - smoothstep(0.455, 0.48, max(slab.x * 1.0, slab.y * 0.5 + 0.25));
    course = (0.86 + 0.08 * gHash(vec2(floor(cl.x / 6.0 + 0.5 * mod(row, 2.0)), row))) * mix(0.72, 1.0, joint);
  }
  vec3 civicTone = vec3(1.0);
  if (civic && plazaD < plazaR) {
    // The civic plaza is laid to the exchange, not in rings: pale slabs in running bond across the axis; a
    // processional of dark granite setts from the stair to the fountain and on to the plaza's edge; a rosette
    // of radiating setts round the basin inside a dark band; and a dark border framing the forecourt.
    vec2 cl = gp - plazaC;
    float row = floor(cl.y / 1.5);
    vec2 slab = abs(fract(vec2(cl.x / 3.0 + 0.5 * mod(row, 2.0), cl.y / 1.5)) - 0.5);
    float sj = 1.0 - smoothstep(0.46, 0.49, max(slab.x, slab.y * 0.5 + 0.25));
    course = (0.9 + 0.1 * gHash(vec2(floor(cl.x / 3.0 + 0.5 * mod(row, 2.0)), row))) * mix(0.8, 1.0, sj);
    vec2 fd = cl - FOUNT;
    float fr = length(fd);
    float axis = step(abs(cl.x), 6.0) * step(STAIR_FOOT, cl.y);
    vec2 sett = abs(fract(cl / 0.6) - 0.5);
    float sjoint = 1.0 - smoothstep(0.42, 0.48, max(sett.x, sett.y));
    vec3 granite = vec3(0.56, 0.55, 0.56) * (0.88 + 0.16 * gHash(floor(cl / 0.6))) * mix(0.7, 1.0, sjoint);
    float rosette = step(FOUNT_R + 0.4, fr) * step(fr, FOUNT_R + 7.0);
    float ringJ = abs(fract(fr / 0.8) - 0.5);
    float rayJ = abs(fract(atan(fd.y, fd.x) / 6.28318530718 * 96.0 + floor(fr / 0.8) * 0.5) - 0.5);
    float rj = 1.0 - smoothstep(0.42, 0.48, max(ringJ, rayJ));
    vec3 rose = vec3(1.08, 1.0, 0.9) * (0.9 + 0.12 * gHash(vec2(floor(fr / 0.8), floor(atan(fd.y, fd.x) * 15.0)))) * mix(0.72, 1.0, rj);
    float band = step(FOUNT_R + 7.0, fr) * step(fr, FOUNT_R + 8.2);
    float border = step(abs(abs(cl.x) - (HALL_HALF + 4.0)), 0.6) * step(STAIR_FOOT - 1.0, cl.y) * step(cl.y, 66.0);
    civicTone = mix(vec3(1.0), granite / course, max(axis * (1.0 - rosette), 0.0));
    civicTone = mix(civicTone, rose / course, rosette);
    civicTone = mix(civicTone, vec3(0.5, 0.49, 0.5) / course, max(band, border));
  }
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.28, 1.2, 1.08) * course * civicTone, plaza * (1.0 - ring));
  roughnessFactor = mix(roughnessFactor, asphaltRough, road * (1.0 - kerbFace));
  roughnessFactor = mix(roughnessFactor, 0.72, kerbTop);
`;

/** The lamp pools and floodlight spill (ground.ts as it was): albedo-weighted irradiance added as emission. */
const FLOOR_LIGHT = /* glsl */ `
  #include <emissivemap_fragment>
  {
    float light = 0.0;
    bool nearP = plazaD < plazaR + 24.0;
    for (int k = 0; k < 4; k++) {
      float o = OFFS[k];
      vec2 lamps[4] = vec2[4](vec2(o, LAMP_AT), vec2(LAMP_AT, o), vec2(o, LAMP_AT - PITCH), vec2(LAMP_AT - PITCH, o));
      for (int q = 0; q < 4; q++) {
        vec2 lp = lamps[q];
        // No street lamp stands in the river's channel (grid.ts), so none lights the quay.
        if (abs(cellId.x * PITCH + lp.x - RIVER_X) < RIVER_HALF + 2.0) continue;
        if (nearP) {
          vec2 pole = cellId * PITCH + lp - (q % 2 == 0 ? vec2(0.0, ${LAMP_REACH.toFixed(2)}) : vec2(${LAMP_REACH.toFixed(2)}, 0.0));
          if (inPlaza(pole)) continue;
        }
        light += pool(lc - lp);
      }
    }
    // The quay lamps: warm white lanterns along both promenades (river.ts).
    float quayLight = 0.0;
    if (dq > -1.0 && dq < QUAY_W + 6.0) {
      float side = gp.x < RIVER_X ? -1.0 : 1.0;
      float lx = side < 0.0 ? BANK_W - QLAMP_IN : BANK_E + QLAMP_IN;
      float zl = floor(gp.y / QLAMP_STEP + 0.5) * QLAMP_STEP;
      for (int k = -1; k <= 1; k++) {
        float z = zl + float(k) * QLAMP_STEP;
        if (quayLamp(side, z)) quayLight += pool(gp - vec2(lx, z));
      }
    }
    // Lanterns around the nearest plaza, or lining a quarter's court.
    float streetLight = light;
    if (court > 0.0) {
      vec2 d = gp - plazaC;
      float l = court - LANTERN_IN;
      if (plazaD < l + 14.0) {
        // The nearest lantern on the edge running along x, and on the edge running along z.
        float ux = clamp(floor(d.x / LANTERN_STEP + 0.5) * LANTERN_STEP, -LANTERN_REACH, LANTERN_REACH);
        float uz = clamp(floor(d.y / LANTERN_STEP + 0.5) * LANTERN_STEP, -LANTERN_REACH, LANTERN_REACH);
        vec2 a = vec2(ux, sign(d.y) * l);
        vec2 b = vec2(sign(d.x) * l, uz);
        if (!(a.y > 0.0 && abs(a.x) < PLINTH_CLEAR)) light += 0.8 * pool(d - a);
        light += 0.8 * pool(d - b);
      }
    } else if (plazaD < RING_R + 14.0) {
      vec2 d = gp - plazaC;
      float step_ = 6.28318530718 / RING_N;
      float a = floor(atan(d.y, d.x) / step_ + 0.5) * step_;
      vec2 lp = vec2(cos(a), sin(a)) * RING_R;
      light += 0.8 * pool(d - lp);
    }
    // The civic plaza: a broad pool under each of the exchange's lamp standards, the warm spill of the open
    // doors down the stair and onto the forecourt, and the lamps' light caught round the basin's kerb.
    if (civic && plazaD < plazaR + 10.0) {
      vec2 cl = gp - plazaC;
      for (int k = 0; k < 4; k++) {
        vec2 d = cl - CIVIC_LAMP[k];
        float dd = dot(d, d);
        light += 1.25 * exp(-dd / 70.0) + 0.3 * exp(-dd / 520.0);
      }
      float spill = exp(-pow(max(abs(cl.x) - 18.0, 0.0), 2.0) / 30.0) * exp(-pow(max(cl.y - STAIR_FOOT, 0.0), 2.0) / 90.0) * step(STAIR_FOOT - 2.0, cl.y);
      light += 0.55 * spill;
      float fr = length(cl - FOUNT);
      light += 0.35 * exp(-pow(fr - FOUNT_R - 0.6, 2.0) / 3.0);
    }
    // District plazas: floodlight spill at the plinth's foot and lit bollards around it.
    // The plaza floor holds a broad, low wash from all of it together, brightest toward the plinth.
    if (district) light += 0.55 * (1.0 - smoothstep(18.0, PLAZA_R - 4.0, plazaD));
    // A quarter: floodlight spill at the foot of each standing tower's root, and a softer wash over the court.
    if (court > 0.0 && plots >= 0.0 && plazaD < court) {
      vec2 d = gp - plazaC;
      light += 0.3 * (1.0 - smoothstep(court - 30.0, court, plazaD));
      for (int k = 0; k < 4; k++) {
        if (mod(floor(plots / pow(2.0, float(k))), 2.0) < 0.5) continue;
        vec2 off = vec2(k % 2 == 0 ? -QOFF : QOFF, k < 2 ? -QOFF : QOFF);
        vec2 q = abs(d - off);
        float foot = max(q.x, q.y);
        light += 2.0 * exp(-pow(max(foot - AGENT_FOOT, 0.0), 2.0) / 9.0) * step(AGENT_FOOT - 0.5, foot);
      }
    }
    if (district && plazaD < BOLLARD_R + 10.0) {
      vec2 d = gp - plazaC;
      vec2 q = abs(d);
      float foot = max(q.x, q.y);
      light += 2.2 * exp(-pow(max(foot - PLINTH_HALF, 0.0), 2.0) / 9.0) * step(PLINTH_HALF - 0.5, foot);
      vec2 b = ringLight(d, BOLLARD_R, BOLLARD_N, 0.5);
      light += 1.6 * exp(-dot(b, b) / 5.0);
    }
    // A bankrupt firm's court: its lanterns and floodlights out with its towers (lightsout.ts), a re-clad tower's own spill back on.
    if (court > 0.0) light = streetLight + (light - streetLight) * (1.0 - lightsOut(vec3(gp.x, 0.0, gp.y)));
    // The kerb face is lit from the lamps' side only as the pool reaches it; the wet throws the pool back a little brighter.
    float onFloor = 1.0 - kerbFace * 0.55;
    totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.56, 0.22) * light * 2.6 * onFloor * (1.0 + 0.3 * wet);
    totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.46) * quayLight * 2.4;
  }
`;

/**
 * The floor material: the plane's, or the kerb tiles' (the same look, with
 * the kerb faces, the flattening to the plane over paved ground and the
 * fade past its reach). Both share the paving and granite scans and the
 * uniforms given.
 */
function floorMaterial(uniforms: FloorUniforms, maps: FloorMaps, tile: { near: number; far: number } | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.pave,
    normalMap: maps.paveNormal,
    aoMap: maps.paveArm,
    roughnessMap: maps.paveArm,
    color: 0xc4bdb5,
    roughness: 0.6,
    metalness: 0,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const kerbMap = { value: maps.granite };
  if (tile) mat.defines = { STREET_TILE: 1 };
  mat.customProgramCacheKey = () => (tile ? `palimpsest-street-tile-${tile.near}-${tile.far}` : 'palimpsest-street-plane');
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, OUT_UNIFORMS, { uKerbMap: kerbMap, uLodEye: LOD_EYE, uNoise: { value: noiseTexture() } });
    const pars = floorPars();
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGP;\nvarying vec3 vWN;\nvarying float vStand;\n${pars}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vWN = normalize(mat3(modelMatrix) * objectNormal);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vStand = 1.0;
        #ifdef STREET_TILE
          vec3 tileW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vStand = floorStands(tileW.xz);
          // Where the floor is the plane (paved ground), the tile sinks 3 cm under it and the plane covers it: no discard,
          // so the GPU can still cull the tile's hidden fragments before shading them.
          transformed.y = transformed.y * vStand - 0.03 * (1.0 - vStand);
        #endif`,
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGP = worldPosition.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGP;
        varying vec3 vWN;
        varying float vStand;
        uniform sampler2D uKerbMap;
        uniform vec3 uLodEye;
        ${OUT_PARS}
        ${pars}
        ${WEAR_GLSL}
        ${FLOOR_FRAGMENT_PARS}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
        {
          // The paving scan is a four by four grid of slabs: each 4 m tile is given a quarter turn or a flip of its
          // own, so the joints stay true and the scan's stains never repeat in step.
          vec2 paveCell = floor(vGP.xz / ${PAVE_TILE.toFixed(1)});
          vec2 paveLocal = fract(vGP.xz / ${PAVE_TILE.toFixed(1)});
          float paveTurn = gHash(paveCell + 11.0);
          if (paveTurn > 0.25) paveLocal = vec2(1.0 - paveLocal.y, paveLocal.x);
          if (paveTurn > 0.5) paveLocal = vec2(1.0 - paveLocal.y, paveLocal.x);
          if (paveTurn > 0.75) paveLocal = vec2(1.0 - paveLocal.y, paveLocal.x);
          if (gHash(paveCell + 23.0) > 0.5) paveLocal.x = 1.0 - paveLocal.x;
          diffuseColor *= texture2D(map, paveCell + paveLocal);
        }
        #endif`,
      )
      .replace('#include <roughnessmap_fragment>', FLOOR_SURFACE)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n        normal = normalize(normal + (viewMatrix * vec4(paveTilt.x, 0.0, paveTilt.y, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', FLOOR_LIGHT);
  };
  return mat;
}

// ---------------------------------------------------------------- the surface

/** A cab rank, as commute.ts lays them: its centre, the way its bays run, and their length. */
export interface RankSpot {
  x: number;
  z: number;
  dir: 'x' | 'z';
  length: number;
}

export interface StreetSurface {
  /** The kerb tiles: one instanced mesh, one call per pass, filled for the blocks round the eye. */
  kerbs: THREE.InstancedMesh;
  /** The floor's material for the ground plane: paving, asphalt and its wear, the plazas and the lamp pools. */
  asphalt: THREE.MeshStandardMaterial;
  /** The plazas standing (the civic plaza first), terraces included: the tiles sink to the plane on them; the paint takes the rest. */
  setPlazas(plazas: Plaza[]): void;
  /** Plazas the floor paves now, the civic plaza included (tests and debugging). */
  plazas(): number;
  /** The cab ranks the asphalt darkens under. */
  setRanks(ranks: RankSpot[]): void;
  /** Follows the eye: refills the tiles once it has moved a step. Returns true when it refilled. */
  update(eye: THREE.Vector3): boolean;
  dispose(): void;
}

/**
 * The street surface at a quality tier: the ground plane's material and the
 * kerb tiles (one instanced draw per pass) that stand on it near the eye.
 * The maps are the scans it paints with; left out, blank texels (tests).
 */
export function streetSurface(quality: 'high' | 'medium', maps: FloorMaps = blankMaps()): StreetSurface {
  const uniforms = floorUniforms();
  const reach = TILE_REACH[quality];
  const radius = TILE_RADIUS[quality];
  const asphalt = floorMaterial(uniforms, maps, null);
  const tileMat = floorMaterial(uniforms, maps, reach);
  const geo = kerbTileGeometry();
  // Blocks whose tile can stand within reach of the eye, with the step's margin: a square of them.
  const span = Math.ceil((reach.far + TILE_STEP) / PITCH);
  const cap = (2 * span + 1) ** 2;
  const kerbs = new THREE.InstancedMesh(geo, tileMat, cap);
  kerbs.name = 'kerbs';
  kerbs.count = 0;
  kerbs.visible = false;
  kerbs.castShadow = true;
  kerbs.receiveShadow = true;
  kerbs.frustumCulled = false;
  // Drawn before the plane, so the plane's fragments under the tiles fail the depth test instead of running the floor shader twice.
  kerbs.renderOrder = -1;
  kerbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  let plazas: Plaza[] = [{ x: 0, z: 0 }];
  const at = new THREE.Vector3(Infinity, 0, 0);
  const m = new THREE.Matrix4();

  /** True when a block's whole tile lies on paved ground (its centre inside a plaza's radius less the block's half diagonal): nothing of it would show. */
  const sunk = (x: number, z: number): boolean =>
    plazas.some((p) => {
      const r = p.court ?? PLAZA_RADIUS;
      const d = p.court !== undefined ? Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) : Math.hypot(p.x - x, p.z - z);
      return d + KERB_EDGE * Math.SQRT2 < r;
    });

  function fill(eye: THREE.Vector3): void {
    const ci = Math.round(eye.x / PITCH);
    const cj = Math.round(eye.z / PITCH);
    let n = 0;
    for (let i = ci - span; i <= ci + span && n < cap; i++) {
      for (let j = cj - span; j <= cj + span && n < cap; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) > radius) continue;
        const x = i * PITCH;
        const z = j * PITCH;
        // The tile's nearest point to the eye, on the ground.
        const dx = Math.max(Math.abs(eye.x - x) - KERB_EDGE, 0);
        const dz = Math.max(Math.abs(eye.z - z) - KERB_EDGE, 0);
        if (Math.hypot(dx, dz) > reach.far + TILE_STEP) continue;
        if (sunk(x, z) || !tileClearsRiver(x)) continue;
        m.makeTranslation(x, 0, z);
        kerbs.setMatrixAt(n++, m);
      }
    }
    kerbs.count = n;
    kerbs.visible = n > 0;
    kerbs.instanceMatrix.needsUpdate = true;
  }

  return {
    kerbs,
    asphalt,
    setPlazas(all) {
      plazas = [{ x: 0, z: 0 }, ...all].slice(0, MAX_PLAZAS);
      // A dark quarter's plots go in as -1: its floodlights are off. A terrace's court goes in negative: not paved, but the tiles sink to it.
      plazas.forEach((p, i) => uniforms.uPlazas.value[i].set(p.x, p.z, p.terrace ? -(p.court ?? PLAZA_RADIUS) : (p.court ?? 0), p.dark ? -1 : (p.towers ?? 0)));
      uniforms.uPlazaCount.value = plazas.length;
      if (Number.isFinite(at.x)) fill(at);
    },
    plazas: () => uniforms.uPlazaCount.value,
    setRanks(ranks) {
      const kept = ranks.slice(0, MAX_RANKS);
      kept.forEach((r, i) => uniforms.uRanks.value[i].set(r.x, r.z, r.dir === 'x' ? 1 : 0, r.length / 2));
      uniforms.uRankCount.value = kept.length;
    },
    update(eye) {
      if (eye.distanceTo(at) <= TILE_STEP) return false;
      at.copy(eye);
      fill(eye);
      return true;
    },
    dispose() {
      geo.dispose();
      asphalt.dispose();
      tileMat.dispose();
      kerbs.dispose();
    },
  };
}
