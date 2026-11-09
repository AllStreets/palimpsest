import * as THREE from 'three';

import { facadeMaterial } from './facade';
import { materials } from './materials';

/** One city block's buildable square, in metres. */
export const BLOCK = 64;
/** Street corridor between blocks: pavement, kerb, two lanes, kerb, pavement. */
export const STREET = 16;
/** Block centre to block centre. DISTRICT_PITCH (240) is three of these, so districts sit on block centres. */
export const PITCH = BLOCK + STREET;
/** Lamp heads sit this far from a block's centre along its south (+z) and east (+x) edges. */
export const LAMP_EDGE = BLOCK / 2 + 2;
/** Lamp positions along a block edge, from the block centre. */
export const LAMP_OFFSETS = [-24, -8, 8, 24];
/** Ambient buildings keep this far from a district origin or the civic plaza. */
export const RESERVE_RADIUS = 90;
/** Inside this radius the street grid gives way to an open paved plaza with no street lamps. */
export const PLAZA_RADIUS = 72;
/**
 * Around each plaza the ambient city stays low, rising with distance, so a
 * district's tower reads as the landmark it is: at the plaza's edge buildings
 * top out at COLLAR_BASE metres, gaining COLLAR_RISE metres per metre out to COLLAR_REACH.
 */
export const COLLAR_BASE = 26;
export const COLLAR_RISE = 0.45;
export const COLLAR_REACH = 320;
/** Lanterns ring each plaza at this radius. */
export const PLAZA_LAMP_RING = 66;
export const PLAZA_LAMPS = 24;

export interface Plaza {
  x: number;
  z: number;
}

export interface Grid {
  group: THREE.Group;
  /** Rebuilds the skyline and lamps around these plazas (the civic plaza at the origin is always kept). */
  setPlazas(plazas: Plaza[]): void;
  dispose(): void;
}

/** A small deterministic generator, seeded per block so adding a district never reshuffles the rest of the city. */
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function blockSeed(i: number, j: number): number {
  return Math.abs((i * 73856093) ^ (j * 19349663)) + 1;
}

/** True when the rectangle centred at (x, z) of size w by d comes within `r` of (px, pz). */
function rectNear(x: number, z: number, w: number, d: number, px: number, pz: number, r: number): boolean {
  const dx = Math.max(Math.abs(px - x) - w / 2, 0);
  const dz = Math.max(Math.abs(pz - z) - d / 2, 0);
  return dx * dx + dz * dz < r * r;
}

function near(x: number, z: number, plazas: Plaza[], r: number): boolean {
  return plazas.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
}

const MASONRY = [0x8a7d6a, 0x6b6560, 0x7a4a3a, 0x9a8f80, 0x5e5249, 0x846f5c].map((c) => new THREE.Color(c));
const CURTAIN = [0x3a3f46, 0x2a2e33, 0x4d5560, 0x23272c, 0x39352f].map((c) => new THREE.Color(c));

/** One ambient building footprint and height, before plazas are cut out. */
interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  glassy: boolean;
  colour: THREE.Color;
  plant: number;
}

const FLOOR = 3.6;
/** Heights land on whole floors plus a parapet, like real buildings. */
function floorsTo(h: number): number {
  return Math.max(2, Math.round(h / FLOOR)) * FLOOR + 1.2;
}

/**
 * The buildings on block (i, j), seeded by the block alone. Three block
 * types, as real grids have them: perimeter blocks (a ring of lots lining
 * the streets around a courtyard, stepping in height lot to lot), a podium
 * with a tower, and a few freestanding buildings. Intensity falls off from
 * the centre, with block-to-block variation so the skyline has clusters.
 */
function blockLots(i: number, j: number): Lot[] {
  const r = rng(blockSeed(i, j));
  const cx = i * PITCH;
  const cz = j * PITCH;
  const dist = Math.hypot(cx, cz);
  const intensity = Math.max(0.16, 1 - dist / 1400) * (0.6 + 0.8 * r());
  const kind = r();
  const lots: Lot[] = [];
  const colourFor = (glassy: boolean): THREE.Color => {
    const pal = glassy ? CURTAIN : MASONRY;
    return pal[Math.floor(r() * pal.length)];
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
          let glassy = r() < 0.12;
          if (isCorner && corner === towerCorner) {
            h = floorsTo(base * 1.6 + 24 + Math.pow(r(), 1.8) * 110 * intensity);
            glassy = r() < 0.6;
          }
          lots.push({
            x: cx + (lx0 + lx1) / 2,
            z: cz + (lz0 + lz1) / 2,
            w: lx1 - lx0,
            d: lz1 - lz0,
            h,
            glassy,
            colour: colourFor(glassy),
            plant: r() < 0.5 ? 1 : 0,
          });
        }
        if (isCorner) corner++;
      }
    }
  } else if (kind < 0.74) {
    const podium = floorsTo(9 + r() * 9);
    lots.push({ x: cx, z: cz, w: BLOCK - 2, d: BLOCK - 2, h: podium, glassy: false, colour: colourFor(r() < 0.3), plant: 0 });
    const tw = 22 + r() * 14;
    const td = 22 + r() * 14;
    const glassy = r() < 0.7;
    lots.push({
      x: cx + (r() - 0.5) * (BLOCK - tw - 6),
      z: cz + (r() - 0.5) * (BLOCK - td - 6),
      w: tw,
      d: td,
      h: floorsTo(podium + 24 + intensity * (24 + Math.pow(r(), 1.8) * 170)),
      glassy,
      colour: colourFor(glassy),
      plant: 2,
    });
  } else {
    const count = 1 + Math.floor(r() * 3);
    for (let b = 0; b < count; b++) {
      const bw = 16 + r() * 22;
      const bd = 16 + r() * 22;
      const glassy = r() < 0.3;
      lots.push({
        x: cx + (r() - 0.5) * (BLOCK - bw),
        z: cz + (r() - 0.5) * (BLOCK - bd),
        w: bw,
        d: bd,
        h: floorsTo(8 + intensity * (10 + Math.pow(r(), 2) * 60)),
        glassy,
        colour: colourFor(glassy),
        plant: 1,
      });
    }
  }
  return lots;
}

const dummy = new THREE.Object3D();
function place(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
  dummy.position.set(x, y, z);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  m.setMatrixAt(i, dummy.matrix);
}

/**
 * The ambient city: a street grid of blocks holding several buildings each,
 * heights falling off with distance from the centre, setbacks on the taller
 * ones, a per-building palette over the world-space facade shader, and
 * sodium street lamps along every block. Plazas (the civic plaza and each
 * district) are kept clear of buildings and street lamps and ringed with
 * lanterns instead.
 */
export function createGrid(quality: 'high' | 'medium'): Grid {
  const M = materials();
  const radius = quality === 'high' ? 22 : 14;
  const blocks = (2 * radius + 1) ** 2;
  // Beyond the detailed city, a ring of low blocks (one building each, no lamps or shadows) carries the skyline into the haze.
  const farRadius = quality === 'high' ? 40 : 28;
  const farBlocks = (2 * farRadius + 1) ** 2 - blocks;
  const group = new THREE.Group();
  group.name = 'ambient-city';

  const box = new THREE.BoxGeometry(1, 1, 1);
  const masonryMat = facadeMaterial(0xffffff, { lit: 0.26, metal: 0.2, rough: 0.62 });
  const curtainMat = facadeMaterial(0xffffff, { lit: 0.34, metal: 0.7, rough: 0.22 });
  const masonry = new THREE.InstancedMesh(box, masonryMat, blocks * 14);
  const curtain = new THREE.InstancedMesh(box, curtainMat, blocks * 6);
  const parapets = new THREE.InstancedMesh(box, M.darkMetal, blocks * 20);
  const plantMat = new THREE.MeshStandardMaterial({ color: 0x4a4743, roughness: 0.85 });
  const plant = new THREE.InstancedMesh(box, plantMat, blocks * 12);
  for (const m of [masonry, curtain, parapets, plant]) {
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  const far = new THREE.InstancedMesh(box, masonryMat, farBlocks);
  group.add(far);

  // Street lamp: a slim pole, an arm reaching over the road, a housing and a sodium lens underneath.
  const lampCap = blocks * LAMP_OFFSETS.length * 2 + 64 * PLAZA_LAMPS;
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 1, 8);
  const poles = new THREE.InstancedMesh(poleGeo, M.darkMetal, lampCap);
  const arms = new THREE.InstancedMesh(box, M.darkMetal, lampCap);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lenses = new THREE.InstancedMesh(box, lensMat, lampCap);
  poles.castShadow = true;
  group.add(poles, arms, lenses);

  const lampColor = new THREE.Color();

  function build(plazas: Plaza[]): void {
    const all = [{ x: 0, z: 0 }, ...plazas];
    let nm = 0;
    let nc = 0;
    let np = 0;
    let nk = 0;
    let nl = 0;

    const lamp = (x: number, z: number, dir: 'x' | 'z' | 'none', r: () => number): void => {
      if (nl >= lampCap) return;
      const h = 8;
      place(poles, nl, x, h / 2, z, 1, h, 1);
      const reach = dir === 'none' ? 0 : 1.3;
      const ax = dir === 'x' ? reach : 0;
      const az = dir === 'z' ? reach : 0;
      if (dir === 'none') {
        place(arms, nl, x, h + 0.25, z, 0.55, 0.5, 0.55);
        place(lenses, nl, x, h - 0.06, z, 0.42, 0.12, 0.42);
      } else {
        place(arms, nl, x + ax / 2 + ax * 0.2, h, z + az / 2 + az * 0.2, dir === 'x' ? reach + 0.6 : 0.34, 0.2, dir === 'z' ? reach + 0.6 : 0.34);
        place(lenses, nl, x + ax, h - 0.13, z + az, dir === 'x' ? 0.8 : 0.32, 0.06, dir === 'z' ? 0.8 : 0.32);
      }
      // Low-pressure sodium is nearly monochrome orange; HDR values so bloom catches the lens.
      const k = 3.2 + r() * 0.6;
      lampColor.setRGB(1.0 * k, (0.56 + r() * 0.06) * k, 0.22 * k);
      lenses.setColorAt(nl, lampColor);
      nl++;
    };

    for (let i = -radius; i <= radius; i++) {
      for (let j = -radius; j <= radius; j++) {
        const rl = rng(blockSeed(i, j) + 101);
        const cx = i * PITCH;
        const cz = j * PITCH;
        for (const off of LAMP_OFFSETS) {
          const sx = cx + off;
          const sz = cz + LAMP_EDGE;
          if (!near(sx, sz, all, PLAZA_RADIUS)) lamp(sx, sz, 'z', rl);
          const ex = cx + LAMP_EDGE;
          const ez = cz + off;
          if (!near(ex, ez, all, PLAZA_RADIUS)) lamp(ex, ez, 'x', rl);
        }

        for (const lot of blockLots(i, j)) {
          if (all.some((p) => rectNear(lot.x, lot.z, lot.w, lot.d, p.x, p.z, RESERVE_RADIUS))) continue;
          const gap = Math.min(...all.map((p) => Math.hypot(lot.x - p.x, lot.z - p.z)));
          const h = gap < COLLAR_REACH ? Math.min(lot.h, floorsTo(COLLAR_BASE + (gap - RESERVE_RADIUS) * COLLAR_RISE)) : lot.h;
          const tiers = h > 150 ? 3 : h > 90 ? 2 : 1;
          const split = tiers === 3 ? [0.5, 0.3, 0.2] : tiers === 2 ? [0.62, 0.38] : [1];
          const mesh = lot.glassy ? curtain : masonry;
          let y = 0;
          let sw = lot.w;
          let sd = lot.d;
          for (let t = 0; t < tiers; t++) {
            const th = t === tiers - 1 ? h - y : floorsTo(h * split[t]) - 1.2;
            const n = lot.glassy ? nc : nm;
            if (n >= mesh.instanceMatrix.count || np >= parapets.instanceMatrix.count) break;
            place(mesh, n, lot.x, y + th / 2, lot.z, sw, th, sd);
            mesh.setColorAt(n, lot.colour);
            if (lot.glassy) nc++;
            else nm++;
            place(parapets, np++, lot.x, y + th + 0.3, lot.z, sw + 0.4, 0.6, sd + 0.4);
            y += th;
            sw *= 0.76;
            sd *= 0.76;
          }
          for (let k = 0; k < lot.plant && nk < plant.instanceMatrix.count; k++) {
            const ox = (k === 0 ? 0.12 : -0.22) * sw;
            const oz = (k === 0 ? -0.1 : 0.2) * sd;
            const ph = 2.4 + k * 1.4;
            place(plant, nk++, lot.x + ox, y + ph / 2, lot.z + oz, Math.min(sw * 0.4, 9), ph, Math.min(sd * 0.35, 7));
          }
        }
      }
    }

    let nf = 0;
    for (let i = -farRadius; i <= farRadius; i++) {
      for (let j = -farRadius; j <= farRadius; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) <= radius) continue;
        const r = rng(blockSeed(i, j));
        const cx = i * PITCH;
        const cz = j * PITCH;
        const bw = 24 + r() * 30;
        const bd = 24 + r() * 30;
        const bx = cx + (r() - 0.5) * (BLOCK - bw);
        const bz = cz + (r() - 0.5) * (BLOCK - bd);
        const h = 10 + Math.pow(r(), 2.6) * 40;
        const pal = r() < 0.3 ? CURTAIN : MASONRY;
        const colour = pal[Math.floor(r() * pal.length)];
        if (all.some((p) => rectNear(bx, bz, bw, bd, p.x, p.z, RESERVE_RADIUS))) continue;
        place(far, nf, bx, h / 2, bz, bw, h, bd);
        far.setColorAt(nf, colour);
        nf++;
      }
    }
    far.count = nf;

    // Lanterns ringing each plaza.
    for (const p of all) {
      const r = rng(blockSeed(Math.round(p.x), Math.round(p.z)) + 7);
      for (let k = 0; k < PLAZA_LAMPS; k++) {
        const a = (k / PLAZA_LAMPS) * Math.PI * 2;
        lamp(p.x + Math.cos(a) * PLAZA_LAMP_RING, p.z + Math.sin(a) * PLAZA_LAMP_RING, 'none', r);
      }
    }

    masonry.count = nm;
    curtain.count = nc;
    parapets.count = np;
    plant.count = nk;
    poles.count = arms.count = lenses.count = nl;
    for (const m of [masonry, curtain, parapets, plant, far, poles, arms, lenses]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  build([]);

  return {
    group,
    setPlazas: build,
    dispose() {
      box.dispose();
      poleGeo.dispose();
      masonryMat.dispose();
      curtainMat.dispose();
      lensMat.dispose();
      plantMat.dispose();
      for (const m of [masonry, curtain, parapets, plant, far, poles, arms, lenses]) m.dispose();
    },
  };
}
