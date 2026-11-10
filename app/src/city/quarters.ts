/**
 * A firm's quarter (spec 6.1 to 6.2, ruling 15): one agent tower per agent
 * standing on its plot round a shared paved court, the firm's name cut into
 * a low stone plinth at the court's street edge, and a covered walk in the
 * firm's root vernacular joining each pair of neighbouring towers.
 *
 * Each tower stands on its firm's root at the agent scale (layoutTower),
 * shaped by its agent's silhouette (Task 23), carrying the floors its agent
 * earned (Task 22). A bankrupt firm's towers are dark until sold, and its
 * walk unlit (Task 28: the lights-out uniform, so the build is the same lit
 * or dark); a sold tower stays on its plot re-clad in its buyer's root and
 * its buyer's materials, behind a scaffold (quarterShow). The paving, the lanterns round the court and the
 * light pools on it are the ground's and the grid's (collar.ts `court`).
 */
import * as THREE from 'three';

import { QUARTER_COURT, QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import { agentRootHeight } from '../../../shared/tower-layout.js';
import type { Era, Quarter, RootStyle, TowerSpec } from '../../../shared/types.js';
import { type BuildOptions, buildTower, type BuiltTower } from './tower/build.js';
import { flutedShaft, Kit, M, type MatKey, piercedWall, pointedArch, roundArch, type TowerMaterials } from './tower/kit.js';
import { type Look, lookFor, preference, renderedDistance } from './tower/variants.js';

export { QUARTER_OFFSETS } from '../../../shared/district-layout.js';

const ERAS: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];

/** Half the foot of an agent's root (a district root's 21 m at the agent scale, ROOT_SCALE in layoutTower). */
const ROOT_FOOT_HALF = 13;
/** The covered walk: its width across, and its clear height under the roof. */
const WALK_WIDTH = 4.6;
const WALK_HEIGHT = 4.4;
/** The name plinth: its length along the court's south edge, its height and depth, and how far in from the edge it stands. */
const PLINTH = { length: 30, height: 1.15, depth: 2.4, inset: 5 };

/**
 * The look of one agent tower of a firm: the firm's own look (lookFor its
 * id) for the first plot, and for each plot after it, in every era but the
 * sci-fi, the variant that renders next nearest to the firm's own, so the
 * cluster shares one family of materials while no two towers are alike.
 * The sci-fi era is a family of massing: every tower of a firm keeps it.
 */
export function agentLook(firmId: string, plot: number): Look {
  const own = lookFor(firmId);
  const look = {} as Look;
  for (const era of ERAS) {
    if (era === 'scifi') {
      look.scifi = own.scifi;
      continue;
    }
    // Nearest first; the firm's own preference breaks ties, so the order is the firm's for good.
    const family = preference(firmId, era)
      .map((v, i) => ({ v, i, d: renderedDistance(own[era], v) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((x) => x.v);
    look[era] = family[plot % family.length];
  }
  return look;
}

/** Every tower's look in a quarter, by tower id: a tower another firm bought takes its buyer's family. */
export function quarterLooks(q: Quarter): Map<string, Look> {
  const out = new Map<string, Look>();
  q.towers.forEach((t, i) => out.set(t.id, agentLook(t.firmId ?? q.firmId, t.towerIndex ?? i)));
  return out;
}

// ---------------------------------------------------------------- the quarter as it shows: dark, re-clad, lit

/** A bankrupt firm's windows go out over this many seconds from `firm.bankrupt`. */
export const DARKEN_S = 2;
/**
 * The buyer's re-clad from `tower.sold`, in seconds: the scaffold rises up
 * the dark tower, the floors are rebuilt behind it in the buyer's look, the
 * scaffold is struck from the top down, then the windows relight.
 */
export const RECLAD = { rise: 8, rebuild: 1.4, strike: 5, relight: 2.4 } as const;
const RECLAD_TOTAL = RECLAD.rise + RECLAD.rebuild + RECLAD.strike + RECLAD.relight;

/** Seconds since each event the page saw live: the firm's bankruptcy, and each of its towers' sales by agent id. Left out, it is long over. */
export interface QuarterClocks {
  bankrupt?: number;
  sold?: ReadonlyMap<string, number>;
}

export type TowerPhase = 'lit' | 'darkening' | 'dark' | 'rising' | 'rebuilding' | 'striking' | 'relighting';

/** One agent tower as the city shows it now. */
export interface TowerShow {
  /** The tower as drawn: under a rising scaffold a bought tower still stands in its seller's root and look. */
  spec: TowerSpec;
  /** How lit its windows and lamps are, 0 (out) to 1. */
  lit: number;
  /** How far up the re-clad scaffold stands, 0 (none) to 1 (wrapped to the top). */
  scaffold: number;
  phase: TowerPhase;
}

export interface QuarterShow {
  /** The quarter as drawn: built the same whether its lights are on or not (quarterBuildKey). */
  quarter: Quarter;
  /** The court's lamps and the walk's lanterns, 0 (out) to 1. */
  court: number;
  plate: 'bankrupt' | 'active';
  towers: TowerShow[];
  /** True when nothing in it is still moving. */
  settled: boolean;
}

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * The quarter as the city shows it, from the engine's quarter and the
 * events seen live. Pure: the scene turns `lit` and `court` into the
 * lights-out uniform (lightsout.ts) and `scaffold` into the re-clad
 * scaffold, and rebuilds only when `quarter` changes (once per re-clad, at
 * the top of the rise).
 */
export function quarterShow(q: Quarter, clocks: QuarterClocks = {}): QuarterShow {
  const b = clocks.bankrupt;
  const fading = q.dark && b !== undefined && b < DARKEN_S;
  // A bankrupt firm's own lights: going out over DARKEN_S, then out.
  const own = q.dark ? (b === undefined ? 0 : 1 - ease(b / DARKEN_S)) : 1;
  let settled = !fading;
  const towers = q.towers.map((t): TowerShow => {
    const bought = (t.firmId ?? q.firmId) !== q.firmId;
    const s = t.agentId ? clocks.sold?.get(t.agentId) : undefined;
    if (bought && s !== undefined && s < RECLAD_TOTAL) {
      settled = false;
      const seller: TowerSpec = { ...t, firmId: q.firmId, root: q.root, dark: true };
      const buyer: TowerSpec = { ...t, dark: false };
      if (s < RECLAD.rise) return { spec: seller, lit: 0, scaffold: ease(s / RECLAD.rise), phase: 'rising' };
      const r = s - RECLAD.rise;
      if (r < RECLAD.rebuild) return { spec: buyer, lit: 0, scaffold: 1, phase: 'rebuilding' };
      const k = r - RECLAD.rebuild;
      if (k < RECLAD.strike) return { spec: buyer, lit: 0, scaffold: 1 - ease(k / RECLAD.strike), phase: 'striking' };
      return { spec: buyer, lit: ease((k - RECLAD.strike) / RECLAD.relight), scaffold: 0, phase: 'relighting' };
    }
    const dark = t.dark ?? (q.dark && !bought);
    if (!dark) return { spec: t, lit: 1, scaffold: 0, phase: 'lit' };
    return { spec: t, lit: own, scaffold: 0, phase: own > 0 ? 'darkening' : 'dark' };
  });
  return { quarter: { ...q, towers: towers.map((t) => t.spec) }, court: own, plate: q.dark ? 'bankrupt' : 'active', towers, settled };
}

/**
 * What a quarter's build depends on: everything but whether its lights are
 * on, which is a uniform (lightsout.ts). A quarter going dark or relighting
 * keeps its batches; a re-clad rebuilds once, when its root and look change.
 */
export function quarterBuildKey(q: Quarter): string {
  const { dark: _dark, ...rest } = q;
  return JSON.stringify({ ...rest, towers: q.towers.map(({ dark: _d, ...t }) => t) });
}

export interface QuarterOptions {
  /** The firm's name, cut into the plinth. */
  name: string;
  /** Each firm's slot, for the marks on the floors its agents earned. */
  firmSlots?: Map<string, number>;
  /** The materials a look is built in: look.ts towerMaterials in the city, plain ones in node tests. */
  materials: (look: Look) => TowerMaterials;
}

/** A quarter as a city centerpiece (scene.ts Centerpiece), with its agents' parts named. */
export interface QuarterPiece {
  object: THREE.Object3D;
  pickables: Map<THREE.Object3D, string | null>;
  dispose(): void;
  /** Every pickable part of an agent's tower, mapped to its agent's id; the rest (the plinth) is the firm's. */
  agents: Map<THREE.Object3D, string>;
  /** Each agent tower as built, by agent id. */
  towers: Map<string, BuiltTower>;
}

/** The stone each root's vernacular is dressed in, for its walk and its plinth. */
const STONE: Record<RootStyle, MatKey> = {
  beauxarts: 'sand',
  roman: 'travertine',
  gothic: 'gothic',
  pagoda: 'granite',
  chicago: 'limestone',
};

/**
 * The quarter as a city centerpiece, centred on its origin: each tower at
 * QUARTER_OFFSETS[towerIndex], the walks between neighbours, and the
 * plinth. Floors pick as themselves under their agent; the plinth as the firm.
 */
export function quarterCenterpiece(q: Quarter, quality: 'high' | 'medium', looks: (t: TowerSpec) => Look, opts: QuarterOptions): QuarterPiece {
  const mats = opts.materials;
  const group = new THREE.Group();
  group.name = `quarter:${q.firmId}`;
  const pickables = new Map<THREE.Object3D, string | null>();
  const agents = new Map<THREE.Object3D, string>();
  const towers = new Map<string, BuiltTower>();
  const disposers: Array<() => void> = [];

  const plots = new Set<number>();
  q.towers.forEach((t, i) => {
    const plot = t.towerIndex ?? i;
    const at = QUARTER_OFFSETS[plot];
    if (!at) return;
    plots.add(plot);
    const look = looks(t);
    // Built lit whatever its state: a dark tower's lights are out by the lights-out uniform (lightsout.ts), so going dark never rebuilds.
    const built = buildTower(t, quality, mats(look), look, { firmSlots: opts.firmSlots, dark: false } satisfies BuildOptions);
    built.group.name = `tower:${t.id}`;
    built.group.position.set(at.x, 0, at.z);
    group.add(built.group);
    for (const [p, id] of built.pickables) {
      pickables.set(p, id);
      if (t.agentId) agents.set(p, t.agentId);
    }
    pickables.set(built.rootPick, null);
    if (t.agentId) agents.set(built.rootPick, t.agentId);
    if (t.agentId) towers.set(t.agentId, built);
    disposers.push(() => built.dispose());
  });

  // The firm's own court pieces, in its own look and root (a firm all of whose towers were sold keeps its walk and name).
  const firmMats = mats(lookFor(q.firmId));
  const kit = new Kit(firmMats);
  kit.detail = quality === 'high';
  const lowest = Math.min(...q.towers.map((t) => agentRootHeight(t.root)));
  const spans = walks(kit, q.root, plots, Math.min(WALK_HEIGHT, lowest * 0.42));
  plinth(kit, q.root);
  garden(kit, q.root);
  lanternColumn(kit, q.root);
  const court = kit.build();
  court.name = 'quarter:walks';
  court.userData.spans = spans;
  group.add(court);
  disposers.push(() =>
    court.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    }),
  );

  // The plinth picks as the firm: an invisible box over it.
  const plinthPick = new THREE.Mesh(new THREE.BoxGeometry(PLINTH.length, PLINTH.height + 1, PLINTH.depth + 1), firmMats.pick);
  plinthPick.position.set(0, (PLINTH.height + 1) / 2, plinthZ());
  plinthPick.visible = false;
  plinthPick.name = 'quarter:plinth-pick';
  group.add(plinthPick);
  pickables.set(plinthPick, null);
  disposers.push(() => plinthPick.geometry.dispose());

  const trees = plantTrees();
  group.add(trees.object);
  disposers.push(trees.dispose);

  const letters = inscription(opts.name);
  if (letters) {
    group.add(letters.object);
    disposers.push(letters.dispose);
  }

  return {
    object: group,
    pickables,
    agents,
    towers,
    dispose() {
      for (const d of disposers) d();
    },
  };
}

/** The plinth's centre line, on the court's south (+z) edge: the side the city's home framing looks from. */
function plinthZ(): number {
  return QUARTER_COURT - PLINTH.inset - PLINTH.depth / 2;
}

// ---------------------------------------------------------------- the covered walks

/** Neighbouring plots joined by a walk: along the north and south rows, and down the west and east columns. */
const PAIRS: Array<[number, number]> = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
];

/**
 * A covered walk between each pair of neighbouring towers that stand,
 * meeting each root at the middle of its face. Returns how many it built.
 */
function walks(k: Kit, root: RootStyle, plots: Set<number>, height: number): number {
  let n = 0;
  for (const [a, b] of PAIRS) {
    if (!plots.has(a) || !plots.has(b)) continue;
    const A = QUARTER_OFFSETS[a];
    const B = QUARTER_OFFSETS[b];
    const along = Math.hypot(B.x - A.x, B.z - A.z);
    const length = along - 2 * ROOT_FOOT_HALF + 0.6;
    // The walk's own frame: x along the walk, centred between the two towers.
    k.base = M((A.x + B.x) / 2, 0, (A.z + B.z) / 2, Math.atan2(-(B.z - A.z), B.x - A.x));
    WALKS[root](k, length, height);
    k.base = new THREE.Matrix4();
    n++;
  }
  return n;
}

type WalkBuilder = (k: Kit, length: number, height: number) => void;

/** Bays along a walk of `length`: the count, and the pitch. */
function bays(length: number, pitch: number): { n: number; pitch: number } {
  const n = Math.max(3, Math.round(length / pitch));
  return { n, pitch: length / n };
}

/** The walk's paved floor, a step up from the court, and a lamp under the roof in every bay. */
function floorAndLamps(k: Kit, stone: MatKey, length: number, height: number, n: number, pitch: number): void {
  k.box(stone, length, 0.18, WALK_WIDTH + 0.6, M(0, 0.09, 0));
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + (i + 0.5) * pitch;
    // A small lantern hung under the roof: a dark housing and its warm glass.
    k.box('steel', 0.5, 0.3, 0.5, M(x, height - 0.35, 0));
    k.box('vent', 0.36, 0.22, 0.36, M(x, height - 0.62, 0));
  }
}

/** An arcade wall along each side of the walk, pierced by `opening`s, with a cornice and a flat roof over it. */
function arcade(k: Kit, stone: MatKey, length: number, height: number, pitch: number, opening: (u: number, w: number) => THREE.Vector2[]): void {
  const { n, pitch: p } = bays(length, pitch);
  const pier = Math.min(1.1, p * 0.24);
  const openings = Array.from({ length: n }, (_, i) => opening(-length / 2 + (i + 0.5) * p, p - pier));
  const depth = 0.7;
  for (const side of [-1, 1]) {
    // piercedWall extrudes toward +z from its face: set its outer face on the walk's edge.
    const z = side > 0 ? WALK_WIDTH / 2 - depth : -WALK_WIDTH / 2;
    k.add(stone, piercedWall(length, height, depth, openings), M(0, 0, z));
  }
  // Cornice, roof slab and a low parapet over it.
  k.box(stone, length + 0.6, 0.45, WALK_WIDTH + 0.9, M(0, height + 0.22, 0));
  k.box('roof', length, 0.12, WALK_WIDTH - 0.3, M(0, height + 0.5, 0));
  for (const side of [-1, 1]) k.box(stone, length + 0.6, 0.55, 0.32, M(0, height + 0.72, side * (WALK_WIDTH / 2 + 0.29)));
  floorAndLamps(k, stone, length, height, n, p);
}

const WALKS: Record<RootStyle, WalkBuilder> = {
  // Round-arched arcades in dressed sandstone under a balustraded cornice.
  beauxarts(k, length, height) {
    arcade(k, 'sand', length, height, 4.2, (u, w) => roundArch(u, w, 0.02, height - 0.8 - w / 2));
  },
  // A colonnade: fluted travertine columns each side carrying an entablature.
  roman(k, length, height) {
    const { n, pitch } = bays(length, 3.8);
    const r = 0.34;
    const shaft = height - 1.1;
    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + i * pitch;
      for (const side of [-1, 1]) {
        const z = side * (WALK_WIDTH / 2 - 0.4);
        k.box('travertine', 0.95, 0.3, 0.95, M(x, 0.15, z));
        // flutedShaft stands on its foot: the shaft rises from the base block.
        k.inst('quarter:column', 'travertine', () => flutedShaft(r, shaft, 16), M(x, 0.3, z));
        k.box('travertine', 0.86, 0.26, 0.86, M(x, 0.3 + shaft + 0.13, z));
      }
    }
    // Architrave, frieze and cornice, then the roof.
    const top = 0.3 + shaft + 0.26;
    for (const side of [-1, 1]) k.box('travertine', length + 0.9, 0.5, 0.8, M(0, top + 0.25, side * (WALK_WIDTH / 2 - 0.4)));
    k.box('travertine', length + 1.2, 0.36, WALK_WIDTH + 0.8, M(0, top + 0.68, 0));
    k.box('roof', length, 0.1, WALK_WIDTH - 0.4, M(0, top + 0.9, 0));
    floorAndLamps(k, 'travertine', length, top, n, pitch);
  },
  // A cloister walk: pointed arches in grey limestone, buttressed at every pier, under a slate lean-to.
  gothic(k, length, height) {
    const { n, pitch } = bays(length, 3.4);
    arcade(k, 'gothic', length, height, 3.4, (u, w) => pointedArch(u, w * 0.9, 0.02, height - 0.6 - w * 0.9 * 0.87));
    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + i * pitch;
      for (const side of [-1, 1]) k.box('gothic', 0.5, height * 0.8, 0.8, M(x, height * 0.4, side * (WALK_WIDTH / 2 + 0.35)));
    }
    // A pitched slate roof over the parapets.
    const half = WALK_WIDTH / 2 + 0.5;
    const rise = 1.4;
    const slope = Math.atan2(rise, half);
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(length + 0.6, 0.16, Math.hypot(half, rise));
      k.add('roofTile', g, M(0, height + 0.5 + rise / 2, side * half * 0.5).multiply(new THREE.Matrix4().makeRotationX(side * slope)));
    }
  },
  // Lacquered timber posts on a granite step under a tiled roof with flared eaves.
  pagoda(k, length, height) {
    const { n, pitch } = bays(length, 3.6);
    k.box('granite', length + 0.8, 0.4, WALK_WIDTH + 1.0, M(0, 0.2, 0));
    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + i * pitch;
      for (const side of [-1, 1]) k.inst('quarter:post', 'timber', () => new THREE.CylinderGeometry(0.2, 0.22, 1, 12), M(x, 0.4 + (height - 0.4) / 2, side * (WALK_WIDTH / 2 - 0.3), 0, 1, height - 0.4, 1));
    }
    for (const side of [-1, 1]) k.box('timber', length + 0.4, 0.42, 0.32, M(0, height - 0.2, side * (WALK_WIDTH / 2 - 0.3)));
    // Two tiled slopes, steep at the ridge and flaring out over the eaves.
    const half = WALK_WIDTH / 2 + 1.3;
    for (const side of [-1, 1]) {
      const upper = new THREE.BoxGeometry(length + 1.6, 0.18, half * 0.7);
      k.add('roofTile', upper, M(0, height + 0.95, side * half * 0.33).multiply(new THREE.Matrix4().makeRotationX(side * 0.5)));
      const eave = new THREE.BoxGeometry(length + 2.0, 0.14, half * 0.45);
      k.add('roofTile', eave, M(0, height + 0.32, side * half * 0.8).multiply(new THREE.Matrix4().makeRotationX(side * 0.22)));
    }
    k.box('roofTile', length + 1.8, 0.3, 0.4, M(0, height + 1.4, 0));
    floorAndLamps(k, 'granite', length, height, n, pitch);
  },
  // Limestone piers carrying a riveted steel girder and a flat canopy, the Chicago frame in miniature.
  chicago(k, length, height) {
    const { n, pitch } = bays(length, 5.2);
    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + i * pitch;
      for (const side of [-1, 1]) k.box('limestone', 0.8, height, 0.8, M(x, height / 2, side * (WALK_WIDTH / 2 - 0.4)));
    }
    for (const side of [-1, 1]) {
      k.box('steel', length + 0.8, 0.62, 0.42, M(0, height + 0.31, side * (WALK_WIDTH / 2 - 0.4)));
      k.box('steel', length + 0.8, 0.08, 0.7, M(0, height + 0.04, side * (WALK_WIDTH / 2 - 0.4)));
    }
    k.box('slab', length + 1.4, 0.3, WALK_WIDTH + 1.4, M(0, height + 0.77, 0));
    k.box('steel', length + 1.5, 0.36, 0.1, M(0, height + 0.75, WALK_WIDTH / 2 + 0.72));
    k.box('steel', length + 1.5, 0.36, 0.1, M(0, height + 0.75, -WALK_WIDTH / 2 - 0.72));
    floorAndLamps(k, 'limestone', length, height, n, pitch);
  },
};

// ---------------------------------------------------------------- the cloister garth

/** The trees inside the walks: a ring of eight round a still basin, clear of every tower and walk. */
const TREES: Array<[number, number]> = [
  [-24, -24],
  [0, -24],
  [24, -24],
  [-24, 0],
  [24, 0],
  [-24, 24],
  [0, 24],
  [24, 24],
];
const BASIN = 12;

/** A raised stone planter under each tree, and the basin in the middle: a stone kerb round still dark water. */
function garden(k: Kit, root: RootStyle): void {
  const stone = STONE[root];
  for (const [x, z] of TREES) {
    k.box(stone, 3.2, 0.55, 3.2, M(x, 0.275, z));
    k.box('roof', 2.6, 0.04, 2.6, M(x, 0.56, z));
  }
  const h = 0.6;
  for (const side of [-1, 1]) {
    k.box(stone, BASIN + 1.2, h, 0.6, M(0, h / 2, side * (BASIN / 2 + 0.3)));
    k.box(stone, 0.6, h, BASIN, M(side * (BASIN / 2 + 0.3), h / 2, 0));
  }
  k.box('darkGlass', BASIN, 0.1, BASIN, M(0, h - 0.18, 0));
}

/**
 * The court's lantern column (Task 28): the firm's mark on the city's
 * skyline. A pedestal in the basin, a shaft in the root's stone (fluted for
 * the classical roots, eight-sided for the rest), a capital, and a glazed
 * lantern burning warm under a bronze cap, LANTERN_TOP high: above the
 * agents' roots, well under every district tower. When the firm goes
 * bankrupt its glass goes out with its towers (the lantern glass is the
 * `vent` emitter, under the lights-out uniform).
 */
export const LANTERN_TOP = 36;
/** The lantern's glass: its centre's height, and its half width. */
export const LANTERN_GLASS = { y: 30.4, half: 0.8 };

function lanternColumn(k: Kit, root: RootStyle): void {
  const stone = STONE[root];
  // Pedestal: a base course, the die, and a cornice, standing in the water.
  k.box(stone, 3.6, 0.5, 3.6, M(0, 0.25, 0));
  k.box(stone, 2.8, 2.2, 2.8, M(0, 0.5 + 1.1, 0));
  k.box(stone, 3.2, 0.35, 3.2, M(0, 2.7 + 0.175, 0));
  const foot = 3.05;
  const shaft = 25;
  if (root === 'beauxarts' || root === 'roman') {
    // flutedShaft stands on its foot (y 0 to its height).
    k.inst('quarter:column-shaft', stone, () => flutedShaft(0.82, shaft, 20), M(0, foot, 0));
  } else {
    k.add(stone, new THREE.CylinderGeometry(0.72, 0.92, shaft, 8), M(0, foot + shaft / 2, 0, Math.PI / 8));
  }
  // Necking band and a square capital.
  const top = foot + shaft;
  k.box('datum', 1.9, 0.22, 1.9, M(0, top + 0.11, 0));
  k.box(stone, 2.5, 0.55, 2.5, M(0, top + 0.22 + 0.27, 0));
  // The lantern: a glass core between four bronze posts, a sill and a lintel.
  const y0 = top + 0.77;
  const h = 3.1;
  k.box('datum', 2.1, 0.16, 2.1, M(0, y0 + 0.08, 0));
  k.box('vent', LANTERN_GLASS.half * 2, h - 0.3, LANTERN_GLASS.half * 2, M(0, y0 + 0.16 + (h - 0.3) / 2, 0));
  for (const [x, z] of [
    [-0.92, -0.92],
    [0.92, -0.92],
    [-0.92, 0.92],
    [0.92, 0.92],
  ]) {
    k.box('steel', 0.2, h, 0.2, M(x, y0 + h / 2, z));
  }
  // Glazing bars across each face, so up close the glass reads as a lantern's and not a block of light.
  for (const side of [-1, 1]) {
    k.box('steel', 0.06, h - 0.3, LANTERN_GLASS.half * 2 + 0.04, M(side * (LANTERN_GLASS.half + 0.01), y0 + 0.16 + (h - 0.3) / 2, 0));
    k.box('steel', LANTERN_GLASS.half * 2 + 0.04, h - 0.3, 0.06, M(0, y0 + 0.16 + (h - 0.3) / 2, side * (LANTERN_GLASS.half + 0.01)));
  }
  k.box('datum', 2.2, 0.22, 2.2, M(0, y0 + h + 0.11, 0));
  // A pyramid cap in bronze and a finial ball.
  const cap = LANTERN_TOP - (y0 + h + 0.22) - 0.5;
  k.add('datum', new THREE.ConeGeometry(1.5, cap, 4, 1), M(0, y0 + h + 0.22 + cap / 2, 0, Math.PI / 4));
  k.add('datum', new THREE.SphereGeometry(0.25, 12, 8), M(0, LANTERN_TOP - 0.25, 0));
}

let foliage: { leaf: THREE.Material; bark: THREE.Material } | null = null;

/** Value noise in 3D, for the crowns' clumps and the bark's patches. */
function vnoise(x: number, y: number, z: number): number {
  const h = (a: number, b: number, c: number): number => {
    const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const f = (t: number): number => t * t * (3 - 2 * t);
  const u = f(x - xi);
  const v = f(y - yi);
  const w = f(z - zi);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

/**
 * One crown mass of a London plane: a sphere broken into leaf clumps (two
 * octaves of noise pushing it in and out), flatter and darker underneath
 * where the light stops reaching, its normals bent toward the round of the
 * mass so it shades as foliage, not as facets.
 */
function crownMass(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = vnoise(v.x * 2.6 + 4, v.y * 2.6, v.z * 2.6) * 0.7 + vnoise(v.x * 6.1, v.y * 6.1 + 9, v.z * 6.1) * 0.3;
    const k = 0.8 + 0.42 * n;
    v.multiplyScalar(k);
    if (v.y < 0) v.y *= 0.58;
    pos.setXYZ(i, v.x, v.y, v.z);
    // Light on top and on the clumps that stand out, dark in the hollows and underneath.
    const shade = (0.55 + 0.45 * THREE.MathUtils.smoothstep(v.y, -0.5, 0.8)) * (0.78 + 0.32 * n);
    colors.set([shade * 0.96, shade, shade * 0.9], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const radial = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let i = 0; i < nrm.count; i++) {
    radial.fromBufferAttribute(pos, i).normalize();
    nv.fromBufferAttribute(nrm, i).lerp(radial, 0.55).normalize();
    nrm.setXYZ(i, nv.x, nv.y, nv.z);
  }
  return g;
}

/** A trunk or limb with the plane's camouflage bark: cream, olive and grey-brown plates where the old bark has shed. */
function barkedLimb(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.16, 0.3, 1, 12, 8);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const cream = new THREE.Color(0.86, 0.83, 0.7);
  const olive = new THREE.Color(0.55, 0.55, 0.44);
  const brown = new THREE.Color(0.4, 0.35, 0.29);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const a = Math.atan2(v.z, v.x);
    const n = vnoise(Math.cos(a) * 2.2 + 3, v.y * 3.4, Math.sin(a) * 2.2);
    const m = vnoise(Math.cos(a) * 4.4, v.y * 7 + 5, Math.sin(a) * 4.4);
    c.copy(n > 0.55 ? cream : n > 0.38 ? olive : brown).lerp(brown, m * 0.25);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** London planes in leaf: a mottled bole forking into two limbs and a broad crown of overlapping clumped masses, instanced. */
function plantTrees(): { object: THREE.Object3D; dispose(): void } {
  foliage ??= {
    leaf: new THREE.MeshStandardMaterial({ color: 0x5b6740, roughness: 0.92, metalness: 0, vertexColors: true }),
    bark: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, vertexColors: true }),
  };
  const trunkGeo = barkedLimb();
  const crownGeo = crownMass();
  const MASSES = 7;
  const trunks = new THREE.InstancedMesh(trunkGeo, foliage.bark, TREES.length * 3);
  const crowns = new THREE.InstancedMesh(crownGeo, foliage.leaf, TREES.length * MASSES);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  TREES.forEach(([x, z], i) => {
    const a = (i * 2.399) % (Math.PI * 2);
    const s = 1 + 0.1 * Math.sin(i * 1.7);
    // The bole to the fork at 3.4 m, then two limbs leaning apart.
    trunks.setMatrixAt(3 * i, m.compose(new THREE.Vector3(x, 0.55 + 1.45, z), q.identity(), new THREE.Vector3(1, 2.9, 1)));
    for (const side of [0, 1]) {
      const lean = side ? 0.42 : -0.38;
      const dir = new THREE.Vector3(Math.cos(a + side * Math.PI), 0, Math.sin(a + side * Math.PI));
      const axis = new THREE.Vector3().crossVectors(up, dir).normalize();
      q.setFromAxisAngle(axis, lean);
      const tip = new THREE.Vector3(0, 1.4, 0).applyQuaternion(q);
      trunks.setMatrixAt(3 * i + 1 + side, m.compose(new THREE.Vector3(x + tip.x, 3.45 + tip.y, z + tip.z), q, new THREE.Vector3(0.62, 2.8, 0.62)));
    }
    for (let j = 0; j < MASSES; j++) {
      // A high central mass, and six round it at two heights, leaning out over the limbs.
      const b = a + (j * Math.PI * 2) / (MASSES - 1) + 0.5 * Math.sin(i * 1.3 + j);
      const r = j === 0 ? 0 : 2.3 + 0.5 * Math.sin(i + j * 2.1);
      const size = (j === 0 ? 3.0 : 2.1 + 0.35 * Math.cos(i * 0.7 + j)) * s;
      const y = (j === 0 ? 7.6 : j % 2 ? 6.2 : 7.0) * s + 0.3 * Math.sin(i * 3 + j);
      q.setFromAxisAngle(up, b * 1.7);
      crowns.setMatrixAt(MASSES * i + j, m.compose(new THREE.Vector3(x + Math.cos(b) * r, y, z + Math.sin(b) * r), q, new THREE.Vector3(size * 1.08, size * 0.8, size)));
      crowns.setColorAt(MASSES * i + j, tint.setRGB(0.92 + 0.1 * Math.sin(i * 1.3 + j * 2.1), 0.95 + 0.07 * Math.cos(i + j), 0.88));
    }
  });
  const g = new THREE.Group();
  g.name = 'quarter:trees';
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    g.add(mesh);
  }
  return {
    object: g,
    dispose() {
      trunkGeo.dispose();
      crownGeo.dispose();
      trunks.dispose();
      crowns.dispose();
    },
  };
}

// ---------------------------------------------------------------- the name plinth

/** A long low block of the root's stone on a base course, its top weathered back, at the court's south edge. */
function plinth(k: Kit, root: RootStyle): void {
  const stone = STONE[root];
  const z = plinthZ();
  const { length, height, depth } = PLINTH;
  k.box(stone, length + 0.8, 0.22, depth + 0.6, M(0, 0.11, z));
  k.box(stone, length, height - 0.22, depth, M(0, 0.22 + (height - 0.22) / 2, z));
  k.box(stone, length + 0.24, 0.16, depth + 0.24, M(0, height + 0.08, z));
}

/**
 * The firm's name cut into the plinth's street face, in the index's serif:
 * each letter a shadowed cut with its lower edge catching the light. Drawn
 * on a canvas, so only in the browser (null in node tests).
 */
function inscription(name: string): { object: THREE.Object3D; dispose(): void } | null {
  if (typeof document === 'undefined') return null;
  const W = 2048;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const draw = (): void => {
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    let size = 88;
    g.font = `500 ${size}px Newsreader, Georgia, serif`;
    const width = g.measureText(name).width;
    // Letter-spaced a touch, as cut lettering is, and never wider than the face.
    const spacing = 6;
    const fit = Math.min(1, (W * 0.86) / (width + spacing * name.length));
    size *= fit;
    g.font = `500 ${size.toFixed(1)}px Newsreader, Georgia, serif`;
    g.textBaseline = 'middle';
    const total = g.measureText(name).width + spacing * fit * (name.length - 1);
    let x = (W - total) / 2;
    const y = H * 0.54;
    for (const ch of name) {
      // The lower lip of the cut catches the light; the cut itself holds shadow.
      g.fillStyle = 'rgba(255, 236, 205, 0.32)';
      g.fillText(ch, x, y + 2.2);
      g.fillStyle = 'rgba(26, 20, 16, 0.84)';
      g.fillText(ch, x, y);
      x += g.measureText(ch).width + spacing * fit;
    }
    tex.needsUpdate = true;
  };
  draw();
  // Redraw once the serif has loaded, if it had not.
  void document.fonts?.load('500 88px Newsreader').then(draw, () => {});
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    roughness: 0.95,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const face = (PLINTH.height - 0.22) * 0.8;
  const geo = new THREE.PlaneGeometry(face * (W / H), face);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.22 + (PLINTH.height - 0.22) / 2, plinthZ() + PLINTH.depth / 2 + 0.012);
  mesh.name = 'quarter:inscription';
  return {
    object: mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
