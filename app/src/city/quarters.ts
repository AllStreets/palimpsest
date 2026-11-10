/**
 * A firm's quarter (spec 6.1 to 6.2, ruling 15): one agent tower per agent
 * standing on its plot round a shared paved court, the firm's name cut into
 * a low stone plinth at the court's street edge, and a covered walk in the
 * firm's root vernacular joining each pair of neighbouring towers.
 *
 * Each tower stands on its firm's root at the agent scale (layoutTower),
 * shaped by its agent's silhouette (Task 23), carrying the floors its agent
 * earned (Task 22). A bankrupt firm's towers are dark until sold, and its
 * walk unlit; a sold tower stays on its plot re-clad in its buyer's root and
 * its buyer's materials. The paving, the lanterns round the court and the
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
    const built = buildTower(t, quality, mats(look), look, { firmSlots: opts.firmSlots } satisfies BuildOptions);
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
  // A bankrupt firm's walk is unlit with its towers.
  if (q.dark) kit.remap = { vent: 'unlit', lightLine: null };
  const lowest = Math.min(...q.towers.map((t) => agentRootHeight(t.root)));
  const spans = walks(kit, q.root, plots, Math.min(WALK_HEIGHT, lowest * 0.42));
  plinth(kit, q.root);
  garden(kit, q.root);
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

  const letters = inscription(opts.name, q.dark);
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
        k.inst('quarter:column', 'travertine', () => flutedShaft(r, shaft, 16), M(x, 0.3 + shaft / 2, z));
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

let foliage: { leaf: THREE.Material; bark: THREE.Material } | null = null;

/** Plane trees in leaf: a trunk forking into two limbs, and a broad crown of overlapping masses, instanced. */
function plantTrees(): { object: THREE.Object3D; dispose(): void } {
  foliage ??= {
    leaf: new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 0.95, metalness: 0 }),
    bark: new THREE.MeshStandardMaterial({ color: 0x6b6156, roughness: 0.9, metalness: 0 }),
  };
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 1, 8);
  // A lumpy crown mass: an icosphere pushed in and out a little, so no two read as the same ball.
  const crownGeo = new THREE.IcosahedronGeometry(1, 2);
  const pos = crownGeo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + 0.09 * Math.sin(v.x * 5.1 + v.y * 3.3) * Math.cos(v.z * 4.7 - v.y * 2.1);
    // Flatter underneath, as a crown is where the light stops reaching.
    v.multiplyScalar(k);
    if (v.y < 0) v.y *= 0.62;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  crownGeo.computeVertexNormals();
  const MASSES = 4;
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
      const b = a + (j * Math.PI * 2) / MASSES + 0.4 * Math.sin(i + j);
      const r = j === 0 ? 0 : 2.1;
      const size = (j === 0 ? 3.6 : 2.5) * s;
      q.setFromAxisAngle(up, b);
      crowns.setMatrixAt(
        MASSES * i + j,
        m.compose(new THREE.Vector3(x + Math.cos(b) * r, (j === 0 ? 7.2 : 6.4 + 0.5 * Math.sin(i * 3 + j)) * s, z + Math.sin(b) * r), q, new THREE.Vector3(size * 1.08, size * 0.82, size)),
      );
      // Each mass a shade apart: the sunlit top of a crown and the shaded masses round it.
      crowns.setColorAt(MASSES * i + j, tint.setRGB(0.92 + 0.12 * Math.sin(i * 1.3 + j * 2.1), 0.95 + 0.08 * Math.cos(i + j), 0.9));
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
function inscription(name: string, dark: boolean): { object: THREE.Object3D; dispose(): void } | null {
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
      g.fillStyle = dark ? 'rgba(14, 12, 11, 0.8)' : 'rgba(26, 20, 16, 0.84)';
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
