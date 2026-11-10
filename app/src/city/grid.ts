import * as THREE from 'three';

import { RESERVE_RADIUS, type CollarPlaza } from './collar';
import { facadeMaterial, louvreMaterial, roofboxMaterial, trimMaterial } from './facade';
import { ARCHETYPES, BLOCK, blockLots, blockSeed, farLot, lotParts, PITCH, rectNear, rng, standingLots, type Archetype, type Lot, type PartKind } from './lots';
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
  /** Draws these lots on their own, outside the city (the ambient swatch board), and returns the group holding them. */
  board(lots: Lot[]): { group: THREE.Group; dispose(): void };
  dispose(): void;
}

function near(x: number, z: number, plazas: Plaza[], r: number): boolean {
  return plazas.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
}

const dummy = new THREE.Object3D();
function place(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rot = 0): void {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, rot, 0);
  dummy.scale.set(sx, sy, sz);
  dummy.updateMatrix();
  m.setMatrixAt(i, dummy.matrix);
}

/** An instanced mesh with a running count that refuses to overflow its capacity. */
class Batch {
  mesh: THREE.InstancedMesh;
  n = 0;
  accent: THREE.InstancedBufferAttribute | null = null;
  style: THREE.InstancedBufferAttribute | null = null;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, shadows = true, styled = false) {
    if (styled) {
      // Facades read an accent colour and a style per building: the geometry is the batch's own, to carry them.
      geo = geo.clone();
      this.accent = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.style = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      geo.setAttribute('aAccent', this.accent);
      geo.setAttribute('aStyle', this.style);
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    this.mesh.castShadow = this.mesh.receiveShadow = shadows;
  }
  get full(): boolean {
    return this.n >= this.mesh.instanceMatrix.count;
  }
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, colour?: THREE.Color, rot = 0): void {
    if (this.full) return;
    place(this.mesh, this.n, x, y, z, sx, sy, sz, rot);
    if (colour) this.mesh.setColorAt(this.n, colour);
    this.n++;
  }
  /** Sets the accent and style of the instance just added. */
  dress(accent: THREE.Color, style: [number, number, number, number]): void {
    if (!this.accent || !this.style || this.n === 0) return;
    this.accent.setXYZ(this.n - 1, accent.r, accent.g, accent.b);
    this.style.setXYZW(this.n - 1, style[0], style[1], style[2], style[3]);
  }
  finish(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.accent) this.accent.needsUpdate = true;
    if (this.style) this.style.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }
}

/** A triangular prism a unit each way, its steep face at -z and its slope falling to +z: a sawtooth roof's tooth. */
function prismGeometry(): THREE.BufferGeometry {
  const fb = (x: number): number[] => [x, -0.5, -0.5];
  const bb = (x: number): number[] => [x, -0.5, 0.5];
  const ft = (x: number): number[] => [x, 0.5, -0.5];
  const L = -0.5;
  const R = 0.5;
  const tris = [fb(L), ft(R), ft(L), fb(L), fb(R), ft(R), ft(L), bb(R), bb(L), ft(L), ft(R), bb(R), fb(L), ft(L), bb(L), fb(R), bb(R), ft(R)].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return g;
}

type PartBatches = Record<Exclude<PartKind, `wall:${string}`>, Batch>;

/**
 * The ambient city: a street grid of blocks built of seven building types in
 * drifting neighbourhoods (lots.ts), heights falling off from the centre,
 * each type with its own facade (facade.ts), copings and cornices, and roof:
 * bulkheads and tanks on walk-ups, penthouses on offices, screened plant and
 * terraces on glass, cores on concrete, lamp standards and cars on parking
 * decks, sawtooth and clerestory roofs on sheds. Sodium street lamps line
 * every block. Plazas (the civic plaza and each district) are kept clear of
 * buildings and street lamps and ringed with lanterns; each district plaza
 * also gets a ring of lit bollards round its plinth. One instanced batch per
 * type and per kind of roof part, so the city draws in a few dozen calls.
 */
export function createGrid(quality: 'high' | 'medium'): Grid {
  const M = materials();
  const radius = quality === 'high' ? 22 : 14;
  const blocks = (2 * radius + 1) ** 2;
  // Beyond the detailed city, a ring of low blocks (one building each, no lamps or roofs) carries the skyline into the haze.
  const farRadius = quality === 'high' ? 40 : 28;
  const group = new THREE.Group();
  group.name = 'ambient-city';

  // Capacity per kind: every part the city holds with nothing reserved, with room for re-toned and re-typed lots.
  const need = new Map<PartKind, number>();
  const count = (k: PartKind): void => void need.set(k, (need.get(k) ?? 0) + 1);
  for (let i = -radius; i <= radius; i++) for (let j = -radius; j <= radius; j++) for (const lot of blockLots(i, j)) for (const p of lotParts(lot)) count(p.kind);
  for (let i = -farRadius; i <= farRadius; i++) for (let j = -farRadius; j <= farRadius; j++) if (Math.max(Math.abs(i), Math.abs(j)) > radius) count(`wall:${farLot(i, j).archetype}`);
  const cap = (k: PartKind): number => Math.ceil((need.get(k) ?? 0) * 1.3) + 64;

  const box = new THREE.BoxGeometry(1, 1, 1);
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
  const capGeo = new THREE.ConeGeometry(1, 1, 10);
  const stackGeo = new THREE.CylinderGeometry(0.8, 1, 1, 10);
  const prismGeo = prismGeometry();
  const treeGeo = new THREE.IcosahedronGeometry(1, 0);
  const facadeMats = Object.fromEntries(ARCHETYPES.map((a) => [a, facadeMaterial(a)])) as Record<Archetype, THREE.MeshStandardMaterial>;
  const trimMat = trimMaterial();
  const roofboxMat = roofboxMaterial();
  const louvreMat = louvreMaterial();
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x4b3a2b, roughness: 0.92 });
  const sawMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.35 });
  // Clerestory and sawtooth glass: lit ones glow warm (HDR, so bloom finds them), dark ones mirror the sky.
  const glazeLitMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.1, 0.62) });
  const glazeDarkMat = new THREE.MeshStandardMaterial({ color: 0x0d1114, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.8 });
  const planterMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.95 });
  const treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  const deckLightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.3, 2.5) });

  function batchesFor(capOf: (k: PartKind) => number, shadows: boolean): { walls: Record<Archetype, Batch>; parts: PartBatches } {
    const walls = Object.fromEntries(ARCHETYPES.map((a) => [a, new Batch(box, facadeMats[a], capOf(`wall:${a}`), shadows, true)])) as Record<Archetype, Batch>;
    const parts: PartBatches = {
      trim: new Batch(box, trimMat, capOf('trim'), shadows),
      roofbox: new Batch(box, roofboxMat, capOf('roofbox'), shadows),
      louvre: new Batch(box, louvreMat, capOf('louvre'), shadows),
      tank: new Batch(tankGeo, tankMat, capOf('tank'), shadows),
      tankCap: new Batch(capGeo, M.darkMetal, capOf('tankCap'), shadows),
      stand: new Batch(box, M.darkMetal, capOf('stand'), shadows),
      chimney: new Batch(stackGeo, roofboxMat, capOf('chimney'), shadows),
      sawtooth: new Batch(prismGeo, sawMat, capOf('sawtooth'), shadows),
      glazeLit: new Batch(box, glazeLitMat, capOf('glazeLit'), false),
      glazeDark: new Batch(box, glazeDarkMat, capOf('glazeDark'), false),
      planter: new Batch(box, planterMat, capOf('planter'), false),
      tree: new Batch(treeGeo, treeMat, capOf('tree'), shadows),
      deckLight: new Batch(box, deckLightMat, capOf('deckLight'), false),
      pole: new Batch(box, M.darkMetal, capOf('pole'), false),
    };
    return { walls, parts };
  }
  const { walls, parts } = batchesFor(cap, true);

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

  const batches = [...Object.values(walls), ...Object.values(parts), poles, arms, lenses, bollards, bollardLights];
  for (const b of batches) group.add(b.mesh);

  const draw = (into: { walls: Record<Archetype, Batch>; parts: PartBatches }, lot: Lot, wallsOnly = false): void => {
    for (const p of lotParts(lot)) {
      if (p.kind.startsWith('wall:')) {
        const b = into.walls[lot.archetype];
        b.add(p.x, p.y, p.z, p.sx, p.sy, p.sz, p.colour);
        b.dress(lot.accent, lot.style);
      } else if (!wallsOnly) {
        into.parts[p.kind as keyof PartBatches].add(p.x, p.y, p.z, p.sx, p.sy, p.sz, p.colour, p.rot);
      }
    }
  };

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
        for (const lot of standingLots(i, j, all)) draw({ walls, parts }, lot);
      }
    }

    for (let i = -farRadius; i <= farRadius; i++) {
      for (let j = -farRadius; j <= farRadius; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) <= radius) continue;
        const lot = farLot(i, j);
        if (all.some((p) => rectNear(lot.x, lot.z, lot.w, lot.d, p.x, p.z, RESERVE_RADIUS))) continue;
        draw({ walls, parts }, lot, true);
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
    blockers: Object.values(walls).map((b) => b.mesh),
    setPlazas: build,
    buildings: () => Object.values(walls).reduce((n, b) => n + b.n, 0),
    board(lots) {
      const n = new Map<PartKind, number>();
      for (const lot of lots) for (const p of lotParts(lot)) n.set(p.kind, (n.get(p.kind) ?? 0) + 1);
      const own = batchesFor((k) => (n.get(k) ?? 0) + 1, false);
      const g = new THREE.Group();
      g.name = 'ambient-board';
      for (const lot of lots) draw(own, lot);
      const all = [...Object.values(own.walls), ...Object.values(own.parts)];
      for (const b of all) {
        b.finish();
        g.add(b.mesh);
      }
      return {
        group: g,
        dispose() {
          for (const b of all) {
            b.mesh.dispose();
            if (b.accent) b.mesh.geometry.dispose();
          }
        },
      };
    },
    dispose() {
      for (const g of [box, tankGeo, capGeo, stackGeo, prismGeo, treeGeo, poleGeo, bollardGeo]) g.dispose();
      for (const b of Object.values(walls)) b.mesh.geometry.dispose();
      for (const m of [...Object.values(facadeMats), trimMat, roofboxMat, louvreMat, tankMat, sawMat, glazeLitMat, glazeDarkMat, planterMat, treeMat, deckLightMat, lensMat]) m.dispose();
      for (const b of batches) b.mesh.dispose();
    },
  };
}
