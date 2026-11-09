/**
 * The ambient city's lots: every block's buildings, seeded by the block
 * alone, and which of them stand once the occupied plots are cut out and the
 * collar has capped them. Pure (three's Color only), so it is tested in Node.
 * Because a block's lots depend on nothing but its coordinates, a plot given
 * back to the city fills with exactly the blocks that stood there before.
 */
import * as THREE from 'three';

import { ambientCap, cappedHeight, RESERVE_RADIUS, type CollarPlaza } from './collar.js';

/** One city block's buildable square, in metres. */
export const BLOCK = 64;
/** Street corridor between blocks: pavement, kerb, two lanes, kerb, pavement. */
export const STREET = 16;
/** Block centre to block centre. DISTRICT_PITCH (240) is three of these, so districts sit on block centres. */
export const PITCH = BLOCK + STREET;

/** A small deterministic generator, seeded per block so adding a district never reshuffles the rest of the city. */
export function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function blockSeed(i: number, j: number): number {
  return Math.abs((i * 73856093) ^ (j * 19349663)) + 1;
}

/** True when the rectangle centred at (x, z) of size w by d comes within `r` of (px, pz). */
export function rectNear(x: number, z: number, w: number, d: number, px: number, pz: number, r: number): boolean {
  const dx = Math.max(Math.abs(px - x) - w / 2, 0);
  const dz = Math.max(Math.abs(pz - z) - d / 2, 0);
  return dx * dx + dz * dz < r * r;
}

/** The ambient facade families (facade.ts draws each; 'plain' is the towers' own). */
export type Family = 'stone' | 'brick' | 'concrete' | 'glass';
const FAMILIES: Family[] = ['stone', 'brick', 'concrete', 'glass'];

/** Tints per family: over the scans they shift the stone from pale limestone to honey sandstone, the brick from red to brown. */
export const PALETTES: Record<Family, THREE.Color[]> = {
  stone: [0xc9bda9, 0xbcae96, 0xae9f86, 0xa79e92, 0xc2b6a4].map((c) => new THREE.Color(c)),
  brick: [0xc4b0a4, 0xb09486, 0xa08272, 0xbaa290, 0x94796b].map((c) => new THREE.Color(c)),
  concrete: [0x8f8a83, 0x7d7973, 0xa29c94, 0x6f6c68, 0x969087].map((c) => new THREE.Color(c)),
  glass: [0x3a3f46, 0x2a2e33, 0x4d5560, 0x31302c, 0x3d3a34].map((c) => new THREE.Color(c)),
};

/** One ambient building footprint and height, before plazas are cut out. */
export interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  family: Family;
  colour: THREE.Color;
  plant: number;
  /** Older masonry buildings carry a timber water tank on the roof. */
  tank: boolean;
}

const FLOOR = 3.6;
/** Heights land on whole floors plus a parapet, like real buildings. */
export function floorsTo(h: number): number {
  return Math.max(2, Math.round(h / FLOOR)) * FLOOR + 1.2;
}

/** Picks a family from weights in FAMILIES order. */
function pick(r: () => number, weights: [number, number, number, number]): Family {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < 4; i++) {
    x -= weights[i];
    if (x <= 0) return FAMILIES[i];
  }
  return FAMILIES[3];
}

/**
 * The buildings on block (i, j), seeded by the block alone. Three block
 * types, as real grids have them: perimeter blocks (a ring of lots lining
 * the streets around a courtyard, stepping in height and changing material
 * lot to lot), a podium with a tower, and a few freestanding buildings.
 * Intensity falls off from the centre, with block-to-block variation so the
 * skyline has clusters.
 */
export function blockLots(i: number, j: number): Lot[] {
  const r = rng(blockSeed(i, j));
  const cx = i * PITCH;
  const cz = j * PITCH;
  const dist = Math.hypot(cx, cz);
  const intensity = Math.max(0.16, 1 - dist / 1400) * (0.6 + 0.8 * r());
  const kind = r();
  const lots: Lot[] = [];
  const lot = (x: number, z: number, w: number, d: number, h: number, family: Family, plant: number): Lot => {
    const pal = PALETTES[family];
    const masonry = family === 'stone' || family === 'brick';
    return { x, z, w, d, h, family, colour: pal[Math.floor(r() * pal.length)], plant, tank: masonry && h < 70 && r() < 0.4 };
  };
  const half = BLOCK / 2;

  if (kind < 0.6) {
    const xs = [-half, -half + 13 + r() * 9, half - 13 - r() * 9, half];
    const zs = [-half, -half + 13 + r() * 9, half - 13 - r() * 9, half];
    const base = 9 + intensity * (14 + r() * 34);
    const towerCorner = r() < 0.18 * intensity ? Math.floor(r() * 4) : -1;
    let corner = 0;
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        if (a === 1 && b === 1) continue;
        const x0 = xs[a];
        const x1 = xs[a + 1];
        const z0 = zs[b];
        const z1 = zs[b + 1];
        const isCorner = a !== 1 && b !== 1;
        const alongX = b !== 1;
        const parts = isCorner ? 1 : 1 + Math.floor(r() * 3);
        for (let k = 0; k < parts; k++) {
          const t0 = k / parts;
          const t1 = (k + 1) / parts;
          const lx0 = alongX ? x0 + (x1 - x0) * t0 : x0;
          const lx1 = alongX ? x0 + (x1 - x0) * t1 : x1;
          const lz0 = alongX ? z0 : z0 + (z1 - z0) * t0;
          const lz1 = alongX ? z1 : z0 + (z1 - z0) * t1;
          let h = floorsTo(base * (0.65 + 0.7 * r()));
          let family = pick(r, [0.34, 0.36, 0.22, 0.08]);
          if (isCorner && corner === towerCorner) {
            h = floorsTo(base * 1.6 + 24 + Math.pow(r(), 1.8) * 110 * intensity);
            family = pick(r, [0.15, 0.05, 0.3, 0.5]);
          }
          lots.push(lot(cx + (lx0 + lx1) / 2, cz + (lz0 + lz1) / 2, lx1 - lx0, lz1 - lz0, h, family, r() < 0.5 ? 1 : 0));
        }
        if (isCorner) corner++;
      }
    }
  } else if (kind < 0.74) {
    const podium = floorsTo(9 + r() * 9);
    lots.push(lot(cx, cz, BLOCK - 2, BLOCK - 2, podium, pick(r, [0.5, 0.1, 0.4, 0]), 0));
    const tw = 22 + r() * 14;
    const td = 22 + r() * 14;
    lots.push(
      lot(
        cx + (r() - 0.5) * (BLOCK - tw - 6),
        cz + (r() - 0.5) * (BLOCK - td - 6),
        tw,
        td,
        floorsTo(podium + 24 + intensity * (24 + Math.pow(r(), 1.8) * 170)),
        pick(r, [0.1, 0, 0.25, 0.65]),
        2,
      ),
    );
  } else {
    const count = 1 + Math.floor(r() * 3);
    for (let b = 0; b < count; b++) {
      const bw = 16 + r() * 22;
      const bd = 16 + r() * 22;
      lots.push(
        lot(
          cx + (r() - 0.5) * (BLOCK - bw),
          cz + (r() - 0.5) * (BLOCK - bd),
          bw,
          bd,
          floorsTo(8 + intensity * (10 + Math.pow(r(), 2) * 60)),
          pick(r, [0.2, 0.4, 0.3, 0.1]),
          1,
        ),
      );
    }
  }
  return lots;
}

/**
 * The lots that stand on block (i, j) round these plazas (the civic plaza
 * included): none within RESERVE_RADIUS of a plaza, and each one cut to whole
 * storeys under the collar.
 */
export function standingLots(i: number, j: number, plazas: CollarPlaza[]): Lot[] {
  const out: Lot[] = [];
  for (const lot of blockLots(i, j)) {
    if (plazas.some((p) => rectNear(lot.x, lot.z, lot.w, lot.d, p.x, p.z, RESERVE_RADIUS))) continue;
    out.push({ ...lot, h: cappedHeight(lot.h, ambientCap(lot.x, lot.z, plazas)) });
  }
  return out;
}
