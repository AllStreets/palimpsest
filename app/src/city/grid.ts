import * as THREE from 'three';

import { facadeMaterial } from './facade';
import { RESERVE_RADIUS, type CollarPlaza } from './collar';
import { BLOCK, blockSeed, floorsTo, PALETTES, PITCH, rectNear, rng, standingLots, type Family } from './lots';
import { materials } from './materials';

export { BLOCK, PITCH, STREET } from './lots';

/** Lamp heads sit this far from a block's centre along its south (+z) and east (+x) edges. */
export const LAMP_EDGE = BLOCK / 2 + 2;
/** Lamp positions along a block edge, from the block centre. */
export const LAMP_OFFSETS = [-24, -8, 8, 24];
/** Inside this radius the street grid gives way to an open paved plaza with no street lamps. */
export const PLAZA_RADIUS = 72;
/** Lanterns ring each plaza at this radius. */
export const PLAZA_LAMP_RING = 66;
export const PLAZA_LAMPS = 24;
/** Lit bollards ring each district's plinth at this radius. */
export const BOLLARD_RING = 36;
export const BOLLARDS = 20;

/** A plaza: a district (with its root's height, so the blocks round it stay under the root), a site, or the civic plaza. */
export type Plaza = CollarPlaza;

export interface Grid {
  group: THREE.Group;
  /** The building bodies, for line-of-sight tests (name plates hide behind them). */
  blockers: THREE.Object3D[];
  /** Rebuilds the skyline and lamps around these plazas (the civic plaza at the origin is always kept). */
  setPlazas(plazas: Plaza[]): void;
  /** Building bodies standing now, near city and far ring together (tests and debugging). */
  buildings(): number;
  dispose(): void;
}

function near(x: number, z: number, plazas: Plaza[], r: number): boolean {
  return plazas.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
}

/** Parapet and coping colours per family: stone copings on masonry, dark metal on glass. */
const COPING: Record<Family, THREE.Color> = {
  stone: new THREE.Color(0xb8ab96),
  brick: new THREE.Color(0x8c8276),
  concrete: new THREE.Color(0x6c6964),
  glass: new THREE.Color(0x222428),
};

const dummy = new THREE.Object3D();
function place(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
  dummy.position.set(x, y, z);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  m.setMatrixAt(i, dummy.matrix);
}

/** An instanced mesh with a running count that refuses to overflow its capacity. */
class Batch {
  mesh: THREE.InstancedMesh;
  n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, shadows = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.castShadow = this.mesh.receiveShadow = shadows;
  }
  get full(): boolean {
    return this.n >= this.mesh.instanceMatrix.count;
  }
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, colour?: THREE.Color): void {
    if (this.full) return;
    place(this.mesh, this.n, x, y, z, sx, sy, sz);
    if (colour) this.mesh.setColorAt(this.n, colour);
    this.n++;
  }
  finish(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }
}

/**
 * The ambient city: a street grid of blocks in four facade families
 * (dressed stone, brick, ribbed concrete and glass curtain wall), heights
 * falling off from the centre, setbacks on the taller ones, parapet copings,
 * rooftop plant and timber water tanks on older roofs, and sodium street
 * lamps along every block. Plazas (the civic plaza and each district) are
 * kept clear of buildings and street lamps and ringed with lanterns; each
 * district plaza also gets a ring of lit bollards around its plinth.
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
  const facadeMats: Record<Family, THREE.MeshStandardMaterial> = {
    stone: facadeMaterial(0xffffff, { family: 'stone', lit: 0.3 }),
    brick: facadeMaterial(0xffffff, { family: 'brick', lit: 0.32 }),
    concrete: facadeMaterial(0xffffff, { family: 'concrete', lit: 0.3 }),
    glass: facadeMaterial(0xffffff, { family: 'glass', lit: 0.34 }),
  };
  const walls: Record<Family, Batch> = {
    stone: new Batch(box, facadeMats.stone, blocks * 6),
    brick: new Batch(box, facadeMats.brick, blocks * 6),
    concrete: new Batch(box, facadeMats.concrete, blocks * 5),
    glass: new Batch(box, facadeMats.glass, blocks * 3),
  };
  const copingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
  const parapets = new Batch(box, copingMat, blocks * 20);
  const plantMat = new THREE.MeshStandardMaterial({ color: 0x4a4743, roughness: 0.85 });
  const plant = new Batch(box, plantMat, blocks * 12);
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 14);
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x4b3a2b, roughness: 0.92 });
  const tanks = new Batch(tankGeo, tankMat, blocks * 3);
  const capGeo = new THREE.ConeGeometry(1, 1, 14);
  const tankCaps = new Batch(capGeo, M.darkMetal, blocks * 3);
  const stands = new Batch(box, M.darkMetal, blocks * 3);
  const far = new Batch(box, facadeMats.concrete, farBlocks, false);

  // Street lamp: a slim pole, an arm reaching over the road, a housing and a sodium lens underneath.
  const lampCap = blocks * LAMP_OFFSETS.length * 2 + 64 * PLAZA_LAMPS;
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 1, 8);
  const poles = new Batch(poleGeo, M.darkMetal, lampCap);
  const arms = new Batch(box, M.darkMetal, lampCap, false);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lenses = new Batch(box, lensMat, lampCap, false);
  const bollardGeo = new THREE.CylinderGeometry(0.16, 0.18, 1, 10);
  const bollards = new Batch(bollardGeo, M.darkMetal, 64 * BOLLARDS, false);
  const bollardLights = new Batch(bollardGeo, lensMat, 64 * BOLLARDS, false);

  const batches = [
    ...Object.values(walls),
    parapets,
    plant,
    tanks,
    tankCaps,
    stands,
    far,
    poles,
    arms,
    lenses,
    bollards,
    bollardLights,
  ];
  for (const b of batches) group.add(b.mesh);

  const lampColor = new THREE.Color();

  function build(plazas: Plaza[]): void {
    const all = [{ x: 0, z: 0 }, ...plazas];
    for (const b of batches) b.n = 0;

    const lamp = (x: number, z: number, dir: 'x' | 'z' | 'none', r: () => number): void => {
      if (lenses.full) return;
      const h = 8;
      poles.add(x, h / 2, z, 1, h, 1);
      const reach = dir === 'none' ? 0 : 1.3;
      const ax = dir === 'x' ? reach : 0;
      const az = dir === 'z' ? reach : 0;
      // Low-pressure sodium is nearly monochrome orange; HDR values so bloom catches the lens.
      const k = 3.2 + r() * 0.6;
      lampColor.setRGB(1.0 * k, (0.56 + r() * 0.06) * k, 0.22 * k);
      if (dir === 'none') {
        arms.add(x, h + 0.25, z, 0.55, 0.5, 0.55);
        lenses.add(x, h - 0.06, z, 0.42, 0.12, 0.42, lampColor);
      } else {
        arms.add(x + ax / 2 + ax * 0.2, h, z + az / 2 + az * 0.2, dir === 'x' ? reach + 0.6 : 0.34, 0.2, dir === 'z' ? reach + 0.6 : 0.34);
        lenses.add(x + ax, h - 0.13, z + az, dir === 'x' ? 0.8 : 0.32, 0.06, dir === 'z' ? 0.8 : 0.32, lampColor);
      }
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

        for (const lot of standingLots(i, j, all)) {
          const h = lot.h;
          const tiers = h > 150 ? 3 : h > 90 ? 2 : 1;
          const split = tiers === 3 ? [0.5, 0.3, 0.2] : tiers === 2 ? [0.62, 0.38] : [1];
          const wall = walls[lot.family];
          let y = 0;
          let sw = lot.w;
          let sd = lot.d;
          let topW = sw;
          let topD = sd;
          for (let t = 0; t < tiers; t++) {
            const th = t === tiers - 1 ? h - y : floorsTo(h * split[t]) - 1.2;
            wall.add(lot.x, y + th / 2, lot.z, sw, th, sd, lot.colour);
            parapets.add(lot.x, y + th + 0.3, lot.z, sw + 0.4, 0.6, sd + 0.4, COPING[lot.family]);
            y += th;
            topW = sw;
            topD = sd;
            sw *= 0.76;
            sd *= 0.76;
          }
          for (let k = 0; k < lot.plant; k++) {
            const ph = 2.4 + k * 1.4;
            plant.add(lot.x + (k === 0 ? 0.12 : -0.22) * topW, y + ph / 2, lot.z + (k === 0 ? -0.1 : 0.2) * topD, Math.min(topW * 0.3, 9), ph, Math.min(topD * 0.28, 7));
          }
          if (lot.tank && topW > 10 && topD > 10) {
            // A timber tank on a steel stand, set back from the street corner.
            const tx = lot.x - topW * 0.22;
            const tz = lot.z + topD * 0.2;
            const rad = 1.8 + Math.abs(Math.sin(lot.x * 12.9 + lot.z * 7.1)) * 0.8;
            stands.add(tx, y + 1.1, tz, rad * 1.7, 2.2, rad * 1.7);
            tanks.add(tx, y + 2.2 + 2.1, tz, rad, 4.2, rad);
            tankCaps.add(tx, y + 6.3 + 0.6, tz, rad * 1.04, 1.2, rad * 1.04);
          }
        }
      }
    }

    for (let i = -farRadius; i <= farRadius; i++) {
      for (let j = -farRadius; j <= farRadius; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) <= radius) continue;
        const r = rng(blockSeed(i, j));
        const bw = 24 + r() * 30;
        const bd = 24 + r() * 30;
        const bx = i * PITCH + (r() - 0.5) * (BLOCK - bw);
        const bz = j * PITCH + (r() - 0.5) * (BLOCK - bd);
        const h = 10 + Math.pow(r(), 2.6) * 40;
        const pal = PALETTES.concrete;
        if (all.some((p) => rectNear(bx, bz, bw, bd, p.x, p.z, RESERVE_RADIUS))) continue;
        far.add(bx, h / 2, bz, bw, h, bd, pal[Math.floor(r() * pal.length)]);
      }
    }

    // Lanterns ringing each plaza, and lit bollards around each district's plinth.
    const bollardColour = new THREE.Color(3.0, 1.9, 1.0);
    all.forEach((p, idx) => {
      const r = rng(blockSeed(Math.round(p.x), Math.round(p.z)) + 7);
      for (let k = 0; k < PLAZA_LAMPS; k++) {
        const a = (k / PLAZA_LAMPS) * Math.PI * 2;
        lamp(p.x + Math.cos(a) * PLAZA_LAMP_RING, p.z + Math.sin(a) * PLAZA_LAMP_RING, 'none', r);
      }
      if (idx === 0) return;
      for (let k = 0; k < BOLLARDS; k++) {
        const a = ((k + 0.5) / BOLLARDS) * Math.PI * 2;
        const bx = p.x + Math.cos(a) * BOLLARD_RING;
        const bz = p.z + Math.sin(a) * BOLLARD_RING;
        bollards.add(bx, 0.45, bz, 1, 0.9, 1);
        bollardLights.add(bx, 0.98, bz, 0.95, 0.16, 0.95, bollardColour);
      }
    });

    for (const b of batches) b.finish();
  }

  build([]);

  return {
    group,
    blockers: [...Object.values(walls), far].map((b) => b.mesh),
    setPlazas: build,
    buildings: () => [...Object.values(walls), far].reduce((n, b) => n + b.n, 0),
    dispose() {
      for (const g of [box, tankGeo, capGeo, poleGeo, bollardGeo]) g.dispose();
      for (const m of [...Object.values(facadeMats), copingMat, plantMat, tankMat, lensMat]) m.dispose();
      for (const b of batches) b.mesh.dispose();
    },
  };
}
