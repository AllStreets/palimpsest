import * as THREE from 'three';

import { reserves, type CollarPlaza } from './collar';
import { onExchange } from './exchange';
import { facadeMaterial, roofboxMaterial, trimMaterial } from './facade';
import { kitShared } from './kits';
import { lightsOutEmitter } from './lightsout.js';
import { AMBIENT_LOD, AO_NEAR, boxDistance, LAYER, setLayers, shadowColumn, type BlockBox } from './lod.js';
import { lodDepthMaterial, lodMaterial, LOD_EYE } from './lod-shader.js';
import { ARCHETYPES, BLOCK, blockLots, blockSeed, farLot, farLotStands, LAMP_EDGE, LAMP_OFFSETS, lotParts, PITCH, rng, standingLots, type Archetype, type Lot, type PartKind } from './lots';
import { inChannel } from '../../../shared/commute.js';
import { materials } from './materials';
import { AWNING, STRIPED } from './shopfronts.js';

export { BLOCK, LAMP_EDGE, LAMP_OFFSETS, PITCH, STREET } from './lots';

/** Blocks within this many of the centre (Chebyshev) carry bays and rooftop units; past it they would be sub-pixel. */
export const DETAIL_RADIUS = 10;
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
  /**
   * Follows the eye and the shadow's centre: the roof kit near the eye, the
   * blocks the AO can still see and the blocks in the sun's shadow column.
   * Returns true when what casts into the shadow map changed.
   */
  update(eye: THREE.Vector3, shadowTarget: THREE.Vector3): boolean;
  /** Instances each pass's copies hold now (tests and debugging). */
  lod(): { near: number; shadow: number; ao: number };
  dispose(): void;
}

/** The sun's shadow camera as scene.ts sets it up: the ambient shadow copies carry the blocks inside it. */
export interface ShadowBox {
  sun: THREE.Vector3;
  half: number;
  offset: number;
  near: number;
  far: number;
}

/**
 * Lanterns line a quarter's court this far in from its edge, every
 * COURT_LANTERN_STEP metres out to COURT_LANTERN_REACH either side of the
 * centre line (past it the towers stand).
 */
export const COURT_LANTERN_INSET = 5;
export const COURT_LANTERN_STEP = 16;
export const COURT_LANTERN_REACH = 32;
/** No lantern stands within this of the court's centre line on its south edge, where the firm's name plinth is. */
export const COURT_PLINTH_CLEAR = 20;

/** True on a plaza's paving: within PLAZA_RADIUS of a round plaza's centre, or on a quarter's court. */
function paved(x: number, z: number, plazas: Plaza[]): boolean {
  return plazas.some((p) => (p.court !== undefined ? Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) < p.court : (p.x - x) ** 2 + (p.z - z) ** 2 < PLAZA_RADIUS * PLAZA_RADIUS));
}

/** Where the lanterns round a quarter's court stand, from its centre: along each edge, clear of the name plinth. */
export function courtLanterns(court: number): Array<{ x: number; z: number }> {
  const l = court - COURT_LANTERN_INSET;
  const out: Array<{ x: number; z: number }> = [];
  const seen = new Set<string>();
  for (let u = -COURT_LANTERN_REACH; u <= COURT_LANTERN_REACH + 1e-6; u += COURT_LANTERN_STEP) {
    for (const [x, z] of [[u, -l], [u, l], [-l, u], [l, u]]) {
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (z === l && Math.abs(x) < COURT_PLINTH_CLEAR) continue;
      out.push({ x, z });
    }
  }
  return out;
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
  /** Runs of instances by block, flattened [block, start, end, ...]: what the pass copies select from. */
  runs: number[] = [];
  accent: THREE.InstancedBufferAttribute | null = null;
  style: THREE.InstancedBufferAttribute | null = null;
  shop: THREE.InstancedBufferAttribute | null = null;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, shadows = true, styled = false) {
    if (styled) {
      // Facades read an accent colour and a style per building: the geometry is the batch's own, to carry them.
      geo = geo.clone();
      this.accent = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.style = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      this.shop = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      geo.setAttribute('aAccent', this.accent);
      geo.setAttribute('aStyle', this.style);
      geo.setAttribute('aShop', this.shop);
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    this.mesh.castShadow = this.mesh.receiveShadow = shadows;
  }
  get full(): boolean {
    return this.n >= this.mesh.instanceMatrix.count;
  }
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, colour?: THREE.Color, rot = 0, block = -1): void {
    if (this.full) return;
    place(this.mesh, this.n, x, y, z, sx, sy, sz, rot);
    if (colour) this.mesh.setColorAt(this.n, colour);
    const r = this.runs;
    const last = r.length - 3;
    if (last >= 0 && r[last] === block && r[last + 2] === this.n) r[last + 2]++;
    else r.push(block, this.n, this.n + 1);
    this.n++;
  }
  reset(): void {
    this.n = 0;
    this.runs = [];
  }
  /** Sets the accent and style of the instance just added. */
  dress(accent: THREE.Color, style: [number, number, number, number], shop: [number, number, number, number]): void {
    if (!this.accent || !this.style || !this.shop || this.n === 0) return;
    this.accent.setXYZ(this.n - 1, accent.r, accent.g, accent.b);
    this.style.setXYZW(this.n - 1, style[0], style[1], style[2], style[3]);
    this.shop.setXYZW(this.n - 1, shop[0], shop[1], shop[2], shop[3]);
  }
  finish(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.accent) this.accent.needsUpdate = true;
    if (this.style) this.style.needsUpdate = true;
    if (this.shop) this.shop.needsUpdate = true;
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

/**
 * Awning cloth: matte canvas in the front's own colour (instance colour; a
 * red past STRIPED marks a striped cloth, cream stripes across it), its
 * underside warmed by the shop light it hangs over.
 */
function awningMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'palimpsest-awning';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCloth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloth = vec2(position.x * length(instanceMatrix[0].xyz), position.z);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCloth;')
      .replace(
        '#include <color_fragment>',
        `{
          float striped = step(${(STRIPED - 0.5).toFixed(1)}, vColor.r);
          vec3 cloth = vec3(vColor.r - ${STRIPED.toFixed(1)} * striped, vColor.g, vColor.b);
          float stripe = striped * step(0.5, fract(vCloth.x / 0.36));
          diffuseColor.rgb = mix(cloth, vec3(0.62, 0.58, 0.5), stripe);
        }`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.6) * 0.3 * (1.0 - smoothstep(-0.3, 0.5, vCloth.y));');
  };
  return m;
}

/**
 * An awning in its own frame: a unit width along x, a unit reach along +z
 * from the wall at z = -0.5, a unit drop from the wall's edge to the outer
 * edge, with a valance hanging from that edge and a cloth fill at each side.
 * Scaled to the plan's bay, AWNING.drop and AWNING.reach by its instance.
 */
function awningGeometry(): THREE.BufferGeometry {
  const v = AWNING.valance / AWNING.drop;
  const P: number[] = [];
  const tri = (a: number[], b: number[], c: number[]): void => {
    P.push(...a, ...b, ...c);
  };
  const wl = [-0.5, 0.5, -0.5];
  const wr = [0.5, 0.5, -0.5];
  const ol = [-0.5, -0.5, 0.5];
  const or = [0.5, -0.5, 0.5];
  const vl = [-0.5, -0.5 - v, 0.5];
  const vr = [0.5, -0.5 - v, 0.5];
  // The slope.
  tri(wl, ol, or);
  tri(wl, or, wr);
  // The valance.
  tri(ol, vl, vr);
  tri(ol, vr, or);
  // The sides, from the wall's edge down the slope to the valance's foot.
  tri(wl, [-0.5, -0.5 - v, -0.5], vl);
  tri(wl, vl, ol);
  tri(wr, vr, [0.5, -0.5 - v, -0.5]);
  tri(wr, or, vr);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.computeVertexNormals();
  return g;
}

type PartBatches = Record<Exclude<PartKind, `wall:${string}`>, Batch>;

/** The roof kit parts drawn at two levels (lod.ts AMBIENT_LOD): the kit near the eye, a box of its bulk farther off. */
const HEAVY = ['bulkhead', 'penthouse', 'screen', 'unit', 'car', 'tank', 'tankCap', 'stand'] as const;
type Heavy = (typeof HEAVY)[number];

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
export function createGrid(quality: 'high' | 'medium', shadowBox: ShadowBox): Grid {
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
  const stackGeo = new THREE.CylinderGeometry(0.8, 1, 1, 10);
  const prismGeo = prismGeometry();
  const treeGeo = new THREE.IcosahedronGeometry(1, 0);
  // The Blender roof and massing kit (kits.py): timber water tanks on braced stands, bulkheads with copings and
  // doors, louvred penthouses, finned plant screens, rooftop units, cars, oriel bays and cut-corner walls.
  // The tank and its roof are authored at radius 0.5 and drawn at the radius-1 scale the cylinders used.
  const kitTank = kitShared('water_tank').clone().scale(2, 1, 2);
  const kitCap = kitShared('tank_cap').clone().scale(2, 1, 2);
  const kitStand = kitShared('tank_stand');
  const kitBulkhead = kitShared('bulkhead');
  const kitPenthouse = kitShared('penthouse');
  const kitScreen = kitShared('screen_panel');
  const kitUnit = kitShared('rooftop_unit');
  const kitCar = kitShared('car');
  const kitBay = kitShared('bay');
  const kitBayGlass = kitShared('bay_glass');
  const kitChamfer = kitShared('chamfer_box');
  const kitRound = kitShared('round_box');
  const facadeMats = Object.fromEntries(ARCHETYPES.map((a) => [a, facadeMaterial(a)])) as Record<Archetype, THREE.MeshStandardMaterial>;
  const trimMat = trimMaterial();
  const roofboxMat = roofboxMaterial();
  // Weathered cedar staves: grey-brown, not new timber.
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x4a423b, roughness: 0.95, vertexColors: true });
  // Kit pieces carry their own tones (door, grille, glasshouse) in vertex colours, under the part's instance colour.
  const kitMasonry = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true });
  const kitMetal = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.45, vertexColors: true });
  const kitPaint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.5, vertexColors: true, envMapIntensity: 1.4 });
  const kitBayMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: true });
  const sawMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.35 });
  // Clerestory and sawtooth glass: lit ones glow warm (HDR, so bloom finds them), dark ones mirror the sky.
  // Lit glass over a warm room, glossy enough to hold a little of the sky, rather than a flat orange panel.
  const glazeLitMat = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 0.1, metalness: 0, envMapIntensity: 1.2, emissive: new THREE.Color(1.0, 0.64, 0.36), emissiveIntensity: 0.5 });
  // Unlit glass still holds a little of the room behind it: without the faint warmth, a stack of dark oriel bays read
  // as flat black slabs down a street front (AUD-C).
  const glazeDarkMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.12, metalness: 0.25, envMapIntensity: 1.5, emissive: new THREE.Color(0.25, 0.19, 0.13), emissiveIntensity: 0.16 });
  const planterMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.95 });
  const treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  const deckLightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.3, 2.5) });
  // Awning cloth: matte canvas, seen from under as much as from above, in each front's own colour (instance colour).
  const awningMat = awningMaterial();
  const awningGeo = awningGeometry();

  type Batches = { walls: Record<Archetype, Batch>; cuts: Record<Archetype, Batch>; parts: PartBatches };
  function batchesFor(capOf: (k: PartKind) => number, shadows: boolean, cutOf: (a: Archetype) => number): Batches {
    const walls = Object.fromEntries(ARCHETYPES.map((a) => [a, new Batch(box, facadeMats[a], capOf(`wall:${a}`), shadows, true)])) as Record<Archetype, Batch>;
    const cuts = Object.fromEntries(ARCHETYPES.map((a) => [a, new Batch(a === 'midcentury' ? kitRound : kitChamfer, facadeMats[a], cutOf(a), shadows, true)])) as Record<Archetype, Batch>;
    const parts: PartBatches = {
      trim: new Batch(box, trimMat, capOf('trim'), shadows),
      roofbox: new Batch(box, roofboxMat, capOf('roofbox'), shadows),
      bulkhead: new Batch(kitBulkhead, kitMasonry, capOf('bulkhead'), shadows),
      penthouse: new Batch(kitPenthouse, kitMetal, capOf('penthouse'), shadows),
      screen: new Batch(kitScreen, kitMetal, capOf('screen'), shadows),
      unit: new Batch(kitUnit, kitMetal, capOf('unit'), false),
      car: new Batch(kitCar, kitPaint, capOf('car'), false),
      bay: new Batch(kitBay, kitBayMat, capOf('bay'), shadows),
      bayGlass: new Batch(kitBayGlass, glazeDarkMat, capOf('bayGlass'), false),
      bayLit: new Batch(kitBayGlass, glazeLitMat, capOf('bayLit'), false),
      tank: new Batch(kitTank, tankMat, capOf('tank'), shadows),
      tankCap: new Batch(kitCap, M.darkMetal, capOf('tankCap'), shadows),
      stand: new Batch(kitStand, M.darkMetal, capOf('stand'), shadows),
      chimney: new Batch(stackGeo, roofboxMat, capOf('chimney'), shadows),
      sawtooth: new Batch(prismGeo, sawMat, capOf('sawtooth'), shadows),
      glazeLit: new Batch(box, glazeLitMat, capOf('glazeLit'), false),
      glazeDark: new Batch(box, glazeDarkMat, capOf('glazeDark'), false),
      planter: new Batch(box, planterMat, capOf('planter'), false),
      tree: new Batch(treeGeo, treeMat, capOf('tree'), shadows),
      deckLight: new Batch(box, deckLightMat, capOf('deckLight'), false),
      awning: new Batch(awningGeo, awningMat, capOf('awning'), shadows),
      pole: new Batch(box, M.darkMetal, capOf('pole'), false),
    };
    return { walls, cuts, parts };
  }
  const cutNeed = new Map<Archetype, number>();
  for (let i = -radius; i <= radius; i++) for (let j = -radius; j <= radius; j++) for (const lot of blockLots(i, j)) for (const p of lotParts(lot)) if (p.chamfer) cutNeed.set(lot.archetype, (cutNeed.get(lot.archetype) ?? 0) + 1);
  // Built as the city always drew them (each batch receiving the sun's shadow if it casts one); the casting itself
  // moves to the shadow map's own copies below.
  const { walls, cuts, parts } = batchesFor(cap, true, (a) => Math.ceil((cutNeed.get(a) ?? 0) * 1.3) + 16);

  // ------------------------------------------------ the roof kit's two levels (lod.ts AMBIENT_LOD)
  // City-wide, every roof kit part draws as a box of its bulk in its mean tone (the far level, fading in past
  // AMBIENT_LOD.near); the kit itself draws only for the blocks near the eye, fading out by AMBIENT_LOD.far.
  /** Each roof kit part's own shape and material, and whether it casts. */
  const KIT: Record<Heavy, { geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean }> = {
    bulkhead: { geo: kitBulkhead, mat: kitMasonry, shadow: true },
    penthouse: { geo: kitPenthouse, mat: kitMetal, shadow: true },
    screen: { geo: kitScreen, mat: kitMetal, shadow: true },
    unit: { geo: kitUnit, mat: kitMetal, shadow: false },
    car: { geo: kitCar, mat: kitPaint, shadow: false },
    tank: { geo: kitTank, mat: tankMat, shadow: true },
    tankCap: { geo: kitCap, mat: M.darkMetal, shadow: true },
    stand: { geo: kitStand, mat: M.darkMetal, shadow: true },
  };
  const proxyGeos: THREE.BufferGeometry[] = [];
  const lodMats: THREE.Material[] = [];
  const lod = <T extends THREE.Material>(m: T, level: 'near' | 'far'): T => {
    const l = lodMaterial(m, level);
    lodMats.push(l);
    return l;
  };
  /** A kit part's far level: its bounding box (a low cylinder or cone for the round tank and its roof) in its mean vertex tone. */
  function proxyOf(k: Heavy): THREE.BufferGeometry {
    const src = KIT[k].geo;
    src.computeBoundingBox();
    const bb = src.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const mid = bb.getCenter(new THREE.Vector3());
    let g: THREE.BufferGeometry;
    if (k === 'tank') g = new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 8, 1);
    else if (k === 'tankCap') g = new THREE.ConeGeometry(size.x / 2, size.y, 8, 1);
    else if (k === 'stand') g = new THREE.BoxGeometry(size.x * 0.55, size.y, size.z * 0.55);
    else g = new THREE.BoxGeometry(size.x, size.y, size.z);
    g.translate(mid.x, mid.y, mid.z);
    const tone = new THREE.Color(1, 1, 1);
    const c = src.attributes.color as THREE.BufferAttribute | undefined;
    if (c) {
      tone.setRGB(0, 0, 0);
      for (let i = 0; i < c.count; i++) tone.r += c.getX(i), tone.g += c.getY(i), tone.b += c.getZ(i);
      tone.multiplyScalar(1 / c.count);
    }
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([tone.r, tone.g, tone.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    proxyGeos.push(g);
    return g;
  }
  // The far boxes replace the kit parts in the city-wide set; the kit parts' own batches become the near level's source.
  const kitPools = {} as Record<Heavy, Batch>;
  for (const k of HEAVY) {
    kitPools[k] = parts[k];
    parts[k] = new Batch(proxyOf(k), lod(KIT[k].mat, 'far'), kitPools[k].mesh.instanceMatrix.count, KIT[k].shadow);
  }

  // Street lamp: a slim pole, an arm reaching over the road, a housing and a sodium lens underneath.
  const lampCap = blocks * LAMP_OFFSETS.length * 2 + 64 * PLAZA_LAMPS;
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 1, 8);
  // A pole's round shaft draws near the eye (lod.ts); farther off a square post of its size stands in for it, which
  // still reads as the street's line of lamp posts from home.
  const poles = new Batch(poleGeo, M.darkMetal, lampCap);
  const poleFarGeo = new THREE.BoxGeometry(0.23, 1, 0.23);
  const polesFar = new Batch(poleFarGeo, lod(M.darkMetal, 'far'), lampCap, false);
  const arms = new Batch(box, M.darkMetal, lampCap, false);
  // A bankrupt firm's court lanterns go out with its towers (lightsout.ts).
  const lensMat = lightsOutEmitter(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const lenses = new Batch(box, lensMat, lampCap, false);
  const bollardGeo = new THREE.CylinderGeometry(0.16, 0.18, 1, 10);
  const bollards = new Batch(bollardGeo, M.darkMetal, 64 * BOLLARDS, false);
  const bollardLights = new Batch(bollardGeo, lensMat, 64 * BOLLARDS, false);

  /** Everything filled by a build (the near kit's sources among them). */
  const batches = [...Object.values(walls), ...Object.values(cuts), ...Object.values(parts), ...Object.values(kitPools), poles, polesFar, arms, lenses, bollards, bollardLights];
  /** What the view draws city-wide: everything but the near kit's sources. */
  const drawn = [...Object.values(walls), ...Object.values(cuts), ...Object.values(parts), polesFar, arms, lenses, bollards, bollardLights];
  for (const [k, b] of Object.entries(walls)) b.mesh.name = `wall:${k}`;
  for (const [k, b] of Object.entries(cuts)) b.mesh.name = `cut:${k}`;
  for (const [k, b] of Object.entries(parts)) b.mesh.name = HEAVY.includes(k as Heavy) ? `${k}:far` : k;
  Object.assign(lenses.mesh, { name: 'lamp-lens' });
  Object.assign(arms.mesh, { name: 'lamp-arm' });
  Object.assign(polesFar.mesh, { name: 'lamp-pole:far' });
  for (const b of drawn) {
    // The view draws the city-wide set; the shadow map and the AO draw local copies of it (below).
    setLayers(b.mesh, LAYER.view);
    b.mesh.castShadow = false;
    group.add(b.mesh);
  }

  // ------------------------------------------------ blocks
  // Every instance belongs to the block it stands on; the copies take whole blocks.
  const B = farRadius;
  const side = 2 * B + 1;
  const blockOf = (x: number, z: number): number => {
    const i = Math.max(-B, Math.min(B, Math.round(x / PITCH)));
    const j = Math.max(-B, Math.min(B, Math.round(z / PITCH)));
    return (i + B) * side + (j + B);
  };
  /** Each block's box: its square plus a street's half round it, ground to the top of what stands on it. */
  const boxes: BlockBox[] = [];
  for (let i = -B; i <= B; i++) {
    for (let j = -B; j <= B; j++) boxes.push({ minX: i * PITCH - PITCH / 2, maxX: i * PITCH + PITCH / 2, minY: 0, maxY: 0, minZ: j * PITCH - PITCH / 2, maxZ: j * PITCH + PITCH / 2 });
  }
  const used = new Uint8Array(boxes.length);

  // ------------------------------------------------ the passes' copies
  /** Instances of `sources` copied for the blocks selected, in one mesh of one shape, for one pass. */
  class Copy {
    mesh: THREE.InstancedMesh;
    count = 0;
    private bake: Array<THREE.Matrix4 | null>;
    constructor(
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      readonly sources: Batch[],
      layer: number,
      opts: { shadow?: boolean; colour?: boolean; bake?: Array<THREE.Matrix4 | null>; name: string },
    ) {
      const cap = Math.max(1, sources.reduce((n, b) => n + b.mesh.instanceMatrix.count, 0));
      this.mesh = new THREE.InstancedMesh(geo, mat, cap);
      this.mesh.name = opts.name;
      this.mesh.count = 0;
      this.mesh.castShadow = !!opts.shadow;
      this.mesh.receiveShadow = layer === 0 && !!opts.shadow;
      if (opts.colour) this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bake = opts.bake ?? sources.map(() => null);
      setLayers(this.mesh, layer);
      this.mesh.visible = false;
      group.add(this.mesh);
    }
    fill(selected: Uint8Array): void {
      const dst = this.mesh.instanceMatrix.array as Float32Array;
      const dstC = this.mesh.instanceColor?.array as Float32Array | undefined;
      const m = new THREE.Matrix4();
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      let n = 0;
      this.sources.forEach((src, s) => {
        const from = src.mesh.instanceMatrix.array as Float32Array;
        const fromC = src.mesh.instanceColor?.array as Float32Array | undefined;
        const bake = this.bake[s];
        const r = src.runs;
        for (let q = 0; q < r.length; q += 3) {
          const blk = r[q];
          if (blk < 0 || !selected[blk]) continue;
          const b = boxes[blk];
          lo[0] = Math.min(lo[0], b.minX);
          lo[1] = Math.min(lo[1], b.minY);
          lo[2] = Math.min(lo[2], b.minZ);
          hi[0] = Math.max(hi[0], b.maxX);
          hi[1] = Math.max(hi[1], b.maxY);
          hi[2] = Math.max(hi[2], b.maxZ);
          const k0 = r[q + 1];
          const k1 = r[q + 2];
          if (bake) {
            for (let k = k0; k < k1; k++, n++) m.fromArray(from, k * 16).multiply(bake).toArray(dst, n * 16);
          } else {
            dst.set(from.subarray(k0 * 16, k1 * 16), n * 16);
            // A part laid without a colour of its own draws in its material's (white instance colour).
            if (dstC && fromC) dstC.set(fromC.subarray(k0 * 3, k1 * 3), n * 3);
            else if (dstC) dstC.fill(1, n * 3, (n + k1 - k0) * 3);
            n += k1 - k0;
          }
        }
      });
      this.count = n;
      this.mesh.count = n;
      this.mesh.visible = n > 0;
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.clearUpdateRanges();
        this.mesh.instanceColor.addUpdateRange(0, n * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
      // The copy's bounds are its blocks' boxes, so each pass's camera culls it whole.
      if (n > 0) {
        const bounds = new THREE.Box3(new THREE.Vector3(lo[0], lo[1], lo[2]), new THREE.Vector3(hi[0], hi[1], hi[2]));
        this.mesh.boundingBox = bounds;
        this.mesh.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      }
    }
    dispose(): void {
      this.mesh.dispose();
    }
  }
  const plain = new THREE.MeshBasicMaterial();
  const wallBatches = [...Object.values(walls), parts.trim, parts.roofbox];
  const cutBatches = ARCHETYPES.filter((a) => a !== 'midcentury').map((a) => cuts[a]);
  // The shadow map: what casts, in the blocks of the sun's shadow column, one copy per shape.
  const shadowCopies = [
    new Copy(box, plain, wallBatches, LAYER.shadow, { shadow: true, name: 'shadow:box' }),
    new Copy(kitChamfer, plain, cutBatches, LAYER.shadow, { shadow: true, name: 'shadow:chamfer' }),
    new Copy(kitRound, plain, [cuts.midcentury], LAYER.shadow, { shadow: true, name: 'shadow:round' }),
    new Copy(stackGeo, plain, [parts.chimney], LAYER.shadow, { shadow: true, name: 'shadow:stack' }),
    new Copy(prismGeo, plain, [parts.sawtooth], LAYER.shadow, { shadow: true, name: 'shadow:prism' }),
    new Copy(treeGeo, plain, [parts.tree], LAYER.shadow, { shadow: true, name: 'shadow:tree' }),
    new Copy(kitBay, plain, [parts.bay], LAYER.shadow, { shadow: true, name: 'shadow:bay' }),
  ];
  // The far boxes of the roof kit cast too, as boxes, where the eye is too far for the kit's own shadow.
  const casting = HEAVY.filter((k) => KIT[k].shadow);
  const unitBox = (k: Heavy): THREE.Matrix4 => {
    const g = proxyGeos[HEAVY.indexOf(k)];
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const mid = bb.getCenter(new THREE.Vector3());
    return new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z).scale(size);
  };
  const farShadow = new Copy(box, plain, casting.map((k) => parts[k]), LAYER.shadow, { shadow: true, bake: casting.map(unitBox), name: 'shadow:far-kit' });
  farShadow.mesh.customDepthMaterial = lodDepthMaterial();
  shadowCopies.push(farShadow);
  // The AO: everything the view draws city-wide, in the blocks near enough for the AO to show, one copy per shape.
  const aoCopies = [
    new Copy(box, plain, [...wallBatches, parts.glazeLit, parts.glazeDark, parts.planter, parts.deckLight, parts.pole, arms, lenses], LAYER.ao, { name: 'ao:box' }),
    new Copy(kitChamfer, plain, cutBatches, LAYER.ao, { name: 'ao:chamfer' }),
    new Copy(kitRound, plain, [cuts.midcentury], LAYER.ao, { name: 'ao:round' }),
    new Copy(stackGeo, plain, [parts.chimney], LAYER.ao, { name: 'ao:stack' }),
    new Copy(prismGeo, plain, [parts.sawtooth], LAYER.ao, { name: 'ao:prism' }),
    new Copy(treeGeo, plain, [parts.tree], LAYER.ao, { name: 'ao:tree' }),
    new Copy(kitBay, plain, [parts.bay], LAYER.ao, { name: 'ao:bay' }),
    new Copy(kitBayGlass, plain, [parts.bayGlass, parts.bayLit], LAYER.ao, { name: 'ao:bay-glass' }),
    new Copy(bollardGeo, plain, [bollards, bollardLights], LAYER.ao, { name: 'ao:bollard' }),
  ];
  // The near level: the roof kit and the lamp poles and arms, in every pass, for the blocks near the eye.
  const nearCopies = [
    ...HEAVY.map((k) => new Copy(KIT[k].geo, lod(KIT[k].mat, 'near'), [kitPools[k]], 0, { shadow: KIT[k].shadow, colour: true, name: k })),
    new Copy(poleGeo, lod(M.darkMetal, 'near'), [poles], 0, { shadow: true, name: 'lamp-pole' }),
  ];

  const near = new Uint8Array(boxes.length);
  const ao = new Uint8Array(boxes.length);
  const shadow = new Uint8Array(boxes.length);
  const nearEye = new THREE.Vector3(Infinity, 0, 0);
  const aoEye = new THREE.Vector3(Infinity, 0, 0);
  const shadowAt = new THREE.Vector3(Infinity, 0, 0);
  /**
   * Each copy is refilled only when its blocks change: the near kit and the
   * AO select with a margin of a step past their reach and refill once the
   * eye has moved a step, so between refills they always hold what they need.
   */
  const NEAR_STEP = 40;
  const AO_STEP = 120;
  function select(into: Uint8Array, keep: (b: BlockBox) => boolean): boolean {
    let changed = false;
    for (let k = 0; k < boxes.length; k++) {
      const v = used[k] && keep(boxes[k]) ? 1 : 0;
      if (v !== into[k]) {
        into[k] = v;
        changed = true;
      }
    }
    return changed;
  }
  function update(eye: THREE.Vector3, target: THREE.Vector3, force = false): boolean {
    LOD_EYE.value.copy(eye);
    let shadowChanged = false;
    if (force || eye.distanceTo(nearEye) > NEAR_STEP) {
      nearEye.copy(eye);
      if (select(near, (b) => boxDistance(eye, b) < AMBIENT_LOD.far + NEAR_STEP) || force) {
        for (const c of nearCopies) c.fill(near);
        shadowChanged = true;
      }
    }
    if (force || eye.distanceTo(aoEye) > AO_STEP) {
      aoEye.copy(eye);
      if (select(ao, (b) => boxDistance(eye, b) < AO_NEAR + AO_STEP) || force) for (const c of aoCopies) c.fill(ao);
    }
    if (force || !target.equals(shadowAt)) {
      shadowAt.copy(target);
      if (select(shadow, shadowColumn(shadowBox.sun, target, shadowBox)) || force) {
        for (const c of shadowCopies) c.fill(shadow);
        shadowChanged = true;
      }
    }
    return shadowChanged;
  }

  const draw = (into: Batches, lot: Lot, wallsOnly = false, near = true): void => {
    const blk = blockOf(lot.x, lot.z);
    for (const p of lotParts(lot)) {
      // Bays and rooftop units are street- and roof-scale detail: drawn only in the nearer city.
      if (!near && (p.kind === 'bay' || p.kind === 'bayGlass' || p.kind === 'bayLit' || p.kind === 'unit' || p.kind === 'awning')) continue;
      if (p.kind.startsWith('wall:')) {
        const b = (p.chamfer ? into.cuts : into.walls)[lot.archetype];
        b.add(p.x, p.y, p.z, p.sx, p.sy, p.sz, p.colour, 0, blk);
        b.dress(lot.accent, lot.style, lot.shop);
      } else if (!wallsOnly) {
        const kind = p.kind as keyof PartBatches;
        // In the city the roof kit's parts go to both levels: the near kit's source and the far boxes.
        if (into.parts === parts && HEAVY.includes(kind as Heavy)) kitPools[kind as Heavy].add(p.x, p.y, p.z, p.sx, p.sy, p.sz, p.colour, p.rot, blk);
        into.parts[kind].add(p.x, p.y, p.z, p.sx, p.sy, p.sz, p.colour, p.rot, blk);
      } else continue;
      if (blk >= 0 && into.parts === parts) {
        used[blk] = 1;
        boxes[blk].maxY = Math.max(boxes[blk].maxY, p.y + p.sy / 2);
      }
    }
  };

  const lampColor = new THREE.Color();

  function build(plazas: Plaza[]): void {
    const all = [{ x: 0, z: 0 }, ...plazas];
    for (const b of batches) b.reset();
    used.fill(0);
    for (const b of boxes) b.maxY = 0;

    const lamp = (x: number, z: number, dir: 'x' | 'z' | 'none', r: () => number): void => {
      // The river runs down the street at x = -360: no lamp stands in its channel (the quays carry their own).
      if (lenses.full || inChannel(x, 2)) return;
      const h = 8;
      const blk = blockOf(x, z);
      used[blk] = 1;
      boxes[blk].maxY = Math.max(boxes[blk].maxY, h + 0.5);
      poles.add(x, h / 2, z, 1, h, 1, undefined, 0, blk);
      polesFar.add(x, h / 2, z, 1, h, 1, undefined, 0, blk);
      const reach = dir === 'none' ? 0 : 1.3;
      const ax = dir === 'x' ? reach : 0;
      const az = dir === 'z' ? reach : 0;
      // Low-pressure sodium is nearly monochrome orange; HDR values so bloom catches the lens.
      const k = 3.2 + r() * 0.6;
      lampColor.setRGB(1.0 * k, (0.56 + r() * 0.06) * k, 0.22 * k);
      if (dir === 'none') {
        arms.add(x, h + 0.25, z, 0.55, 0.5, 0.55, undefined, 0, blk);
        lenses.add(x, h - 0.06, z, 0.42, 0.12, 0.42, lampColor, 0, blk);
      } else {
        arms.add(x + ax / 2 + ax * 0.2, h, z + az / 2 + az * 0.2, dir === 'x' ? reach + 0.6 : 0.34, 0.2, dir === 'z' ? reach + 0.6 : 0.34, undefined, 0, blk);
        lenses.add(x + ax, h - 0.13, z + az, dir === 'x' ? 0.8 : 0.32, 0.06, dir === 'z' ? 0.8 : 0.32, lampColor, 0, blk);
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
          if (!paved(sx, sz, all)) lamp(sx, sz, 'z', rl);
          const ex = cx + LAMP_EDGE;
          const ez = cz + off;
          if (!paved(ex, ez, all)) lamp(ex, ez, 'x', rl);
        }
        const nearBlock = Math.max(Math.abs(i), Math.abs(j)) <= DETAIL_RADIUS;
        for (const lot of standingLots(i, j, all)) draw({ walls, cuts, parts }, lot, false, nearBlock);
      }
    }

    for (let i = -farRadius; i <= farRadius; i++) {
      for (let j = -farRadius; j <= farRadius; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) <= radius) continue;
        if (!farLotStands(i, j)) continue;
        const lot = farLot(i, j);
        if (all.some((p) => reserves(p, lot.x, lot.z, lot.w, lot.d))) continue;
        draw({ walls, cuts, parts }, lot, true);
      }
    }

    // Lanterns ringing each plaza (lining a quarter's court), and lit bollards around each district's plinth.
    const bollardColour = new THREE.Color(3.0, 1.9, 1.0);
    all.forEach((p: Plaza, idx) => {
      const r = rng(blockSeed(Math.round(p.x), Math.round(p.z)) + 7);
      if (p.court !== undefined) {
        for (const l of courtLanterns(p.court)) lamp(p.x + l.x, p.z + l.z, 'none', r);
        return;
      }
      for (let k = 0; k < PLAZA_LAMPS; k++) {
        const a = (k / PLAZA_LAMPS) * Math.PI * 2;
        const lx = Math.cos(a) * PLAZA_LAMP_RING;
        const lz = Math.sin(a) * PLAZA_LAMP_RING;
        // The civic plaza's ring keeps off the exchange's steps.
        if (idx === 0 && onExchange(lx, lz, 3)) continue;
        lamp(p.x + lx, p.z + lz, 'none', r);
      }
      if (idx === 0) return;
      for (let k = 0; k < BOLLARDS; k++) {
        const a = ((k + 0.5) / BOLLARDS) * Math.PI * 2;
        const bx = p.x + Math.cos(a) * BOLLARD_RING;
        const bz = p.z + Math.sin(a) * BOLLARD_RING;
        const blk = blockOf(bx, bz);
        used[blk] = 1;
        boxes[blk].maxY = Math.max(boxes[blk].maxY, 1.1);
        bollards.add(bx, 0.45, bz, 1, 0.9, 1, undefined, 0, blk);
        bollardLights.add(bx, 0.98, bz, 0.95, 0.16, 0.95, bollardColour, 0, blk);
      }
    });

    for (const b of batches) b.finish();
    // Every copy is refilled from the new build, at the eye and shadow centre last seen.
    if (Number.isFinite(nearEye.x)) update(nearEye.clone(), shadowAt.clone(), true);
  }

  build([]);

  return {
    group,
    blockers: [...Object.values(walls), ...Object.values(cuts)].map((b) => b.mesh),
    setPlazas: build,
    update: (eye, target) => update(eye, target),
    lod: () => ({
      near: nearCopies.reduce((n, c) => n + c.count, 0),
      shadow: shadowCopies.reduce((n, c) => n + c.count, 0),
      ao: aoCopies.reduce((n, c) => n + c.count, 0),
    }),
    buildings: () => [...Object.values(walls), ...Object.values(cuts)].reduce((n, b) => n + b.n, 0),
    board(lots) {
      const n = new Map<PartKind, number>();
      for (const lot of lots) for (const p of lotParts(lot)) n.set(p.kind, (n.get(p.kind) ?? 0) + 1);
      const own = batchesFor((k) => (n.get(k) ?? 0) + 1, false, () => lots.length + 1);
      const g = new THREE.Group();
      g.name = 'ambient-board';
      for (const lot of lots) draw(own, lot);
      const all = [...Object.values(own.walls), ...Object.values(own.cuts), ...Object.values(own.parts)];
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
      for (const g of [box, stackGeo, prismGeo, treeGeo, poleGeo, poleFarGeo, bollardGeo, kitTank, kitCap, ...proxyGeos]) g.dispose();
      for (const b of [...Object.values(walls), ...Object.values(cuts)]) b.mesh.geometry.dispose();
      for (const m of [...Object.values(facadeMats), trimMat, roofboxMat, kitMasonry, kitMetal, kitPaint, kitBayMat, tankMat, sawMat, glazeLitMat, glazeDarkMat, planterMat, treeMat, deckLightMat, lensMat, plain, farShadow.mesh.customDepthMaterial!, ...lodMats]) m.dispose();
      for (const b of batches) b.mesh.dispose();
      for (const c of [...shadowCopies, ...aoCopies, ...nearCopies]) c.dispose();
    },
  };
}
