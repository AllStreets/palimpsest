import * as THREE from 'three';

import { AGENT_ROOT_SCALE, layoutTower } from '../../../../shared/tower-layout.js';
import { crownFor, floorTransform } from '../../../../shared/silhouette.js';
import type { Silhouette, TowerSpec } from '../../../../shared/types.js';
import { crownSlots } from '../kits.js';
import { makeLensCrown, makeSpire } from './crowns.js';
import { addDatum, type DatumPlan } from './datum.js';
import { bareEdge, crownFloors, earnedLine, ERA_BUILDERS, firmMark, firmMarkColor, type FloorShape, scarFloor, TITANIUM_TWIST } from './eras.js';
import { bracketGeometry, Kit, M, type MatKey, rng, type TowerMaterials } from './kit.js';
import { ROOT_BUILDERS, ROOT_TOP_HALF } from './roots.js';
import { type Look, lookFor } from './variants.js';

export type { TowerMaterials } from './kit.js';

/** The first floor's width; every floor above is 0.6% narrower than the one below. */
export const FLOOR_WIDTH = 26;
export const TAPER = 0.994;
/** Each new era steps in this far overall, so the eras read as setbacks in the silhouette. */
export const ERA_SETBACK = 1.6;
/** An agent's own tower: narrower than a repo's, a single practice rather than a district. */
export const AGENT_FLOOR_WIDTH = 16;
/**
 * The earned floors step in this far overall (at most, and never more than
 * a sixth of the founding top's width) from the founding top, so the
 * datum band reads as the rim of a ledge between the two, not a cap on the
 * roof. Above it they hold their width (with the taper) whatever era each
 * agent works in: a repo's earned floors change era floor by floor.
 */
export const EARNED_LEDGE = 2.4;
/** The cantilever bracket as modelled (kit.ts bracketGeometry): its reach and its depth at the wall, in metres. */
const BRACKET_REACH = 3;
const BRACKET_DEPTH = 2.6;

export interface BuildOptions {
  /** The first floor's width; an agent tower's default is AGENT_FLOOR_WIDTH, a repo's FLOOR_WIDTH. */
  width?: number;
  /** A bankrupt firm's tower: every material unlit, no light lines, the datum left. Defaults to the spec's own flag. */
  dark?: boolean;
  /** Each firm's slot (Task 4), which picks its mark colour; a firm not in it takes a colour from its id. */
  firmSlots?: Map<string, number>;
}

/** What a dark tower draws in place of each emitter (null: left out). */
const DARK: Partial<Record<MatKey, MatKey | null>> = {
  lightLine: null,
  earnedLine: null,
  handLine: null,
  accent: null,
  vent: 'unlit',
  beacon: 'unlit',
  stained: 'unlit',
  window: 'darkGlass',
  stoneWin: 'darkGlass',
  brickWin: 'darkGlass',
  glassWin: 'darkGlass',
  titaniumWin: 'darkGlass',
  scifiWin: 'darkGlass',
};

/** A waiting floor's own emitters stay off too: its light slots and reveals light when it merges. */
const ASLEEP: Partial<Record<MatKey, MatKey | null>> = { vent: 'unlit', lightLine: null };

export interface BuiltTower {
  group: THREE.Group;
  /** One invisible proxy per floor, mapped to its floor id. */
  pickables: Map<THREE.Object3D, string>;
  /** The root's own pick proxy (not a floor). */
  rootPick: THREE.Object3D;
  /** Equals layoutTower(spec).top: the roof of the top floor, under any crown or spire. */
  top: number;
  /** What stands on an agent tower's roof by its silhouette (crownFor), or nothing. */
  crown: { kind: 'lens' | 'spire' | 'none'; rings: number; height: number };
  dispose(): void;
}

/**
 * The colour drift of a run of floors laid in one year: a few percent of
 * value, alternating lighter and darker year on year so a long run reads as
 * built over time rather than extruded, with a slight warm or cool lean (a
 * new kiln batch, a new quarry bed). Deterministic per repo, era and year.
 */
export function yearDrift(repo: string, era: string, year: number, firstYear: number): THREE.Color {
  const r = rng(`${repo}|${era}|${year}`);
  const sign = (year - firstYear) % 2 === 0 ? 1 : -1;
  const v = 1 + sign * (0.022 + 0.022 * r());
  const lean = (r() - 0.5) * 0.03;
  return new THREE.Color(v * (1 + lean), v, v * (1 - lean));
}

/**
 * A Palimpsest tower, read bottom to top: the root in its inherited
 * vernacular, one floor per merged change laid in the era it was earned in
 * (in the repo's own variant of that era's material), and the bronze datum
 * line where the repo joined the city. Above the datum, the floors earned
 * in the market: each in its agent's era, lit with a cool line at its slab
 * edge once merged, asleep (unlit, its slab edge bare) while its PR waits,
 * or left in primer where an inspection failed. Heights follow layoutTower
 * exactly. The tower stands centred on its local origin.
 */
export function buildTower(
  spec: TowerSpec,
  quality: 'high' | 'medium',
  mats: TowerMaterials,
  look: Look = lookFor(spec.repo),
  opts: BuildOptions = {},
): BuiltTower {
  const layout = layoutTower(spec);
  const kit = new Kit(mats);
  const detail = quality === 'high';
  kit.detail = detail;
  const dark = opts.dark ?? spec.dark ?? false;
  const towerRemap: Partial<Record<MatKey, MatKey | null>> = dark ? DARK : {};
  kit.remap = towerRemap;

  // An agent's tower stands on its firm's root at the agent scale: the same vernacular, smaller in every dimension.
  const rootScale = spec.kind === 'agent' ? AGENT_ROOT_SCALE : 1;
  kit.base = M(0, 0, 0, 0, rootScale, rootScale, rootScale);
  ROOT_BUILDERS[spec.root](kit, detail, rng(spec.id));
  kit.base = new THREE.Matrix4();
  const rootTopHalf = ROOT_TOP_HALF[spec.root] * rootScale;

  const proxyGeo = new THREE.BoxGeometry(1, 1, 1);
  const proxies = new THREE.Group();
  proxies.name = 'tower:picks';
  const pickables = new Map<THREE.Object3D, string>();
  const proxy = (cx: number, y: number, cz: number, w: number, h: number, ry: number): THREE.Mesh => {
    const p = new THREE.Mesh(proxyGeo, mats.pick);
    p.position.set(cx, y, cz);
    p.rotation.y = ry;
    p.scale.set(w, h, w);
    p.visible = false;
    proxies.add(p);
    return p;
  };
  const rootPick = proxy(0, layout.rootHeight / 2, 0, (rootTopHalf + 3) * 2, layout.rootHeight, 0);

  let width = opts.width ?? (spec.kind === 'agent' ? AGENT_FLOOR_WIDTH : FLOOR_WIDTH);
  let inRun = 0;
  const last = layout.floors.length - 1;
  let datumPlan: DatumPlan = { cx: 0, cz: 0, half: rootTopHalf - 0.4, ry: 0 };
  const yearOf = (at: string): number => new Date(at).getUTCFullYear() || 0;
  const firstYear = layout.floors.length ? yearOf(layout.floors[0].floor.at) : 0;
  /** Floors earned in the market: they stand above the datum, each in its agent's era. */
  const earnedAt = (i: number): boolean => i >= spec.datumIndex && !layout.floors[i].floor.founding;
  const stateAt = (i: number): 'lit' | 'waiting' | 'scar' | null => (earnedAt(i) ? (layout.floors[i].floor.earned?.state ?? 'lit') : null);
  /**
   * Floors run by era: consecutive floors of one era are one run (one stage
   * of building, one width above the datum), a scar inside a run included;
   * the datum always starts a new run.
   */
  const sameRun = (a: number, b: number): boolean =>
    a >= 0 && b <= last && layout.floors[a].floor.era === layout.floors[b].floor.era && !(b === spec.datumIndex && earnedAt(b));
  // An agent's tower is shaped above its datum by how the agent works; a repo's own tower never is.
  const silhouette: Silhouette = spec.kind === 'agent' ? (spec.silhouette ?? 'plain') : 'plain';
  const earnedCount = layout.floors.filter((_, i) => earnedAt(i)).length;
  const roofCrown = earnedCount > 0 ? crownFor(silhouette, earnedCount) : { kind: 'none' as const, rings: 0, height: 0 };
  // The sci-fi run at the top carries its family's crown over its last few floors, founding or earned, starting
  // above the datum line if the band falls inside them, so the band never cuts a crown in two, and above any
  // scar, which stays primer. A tower topped in another era ends in that era's own roof. Without the Blender
  // kits the family builds its own top floor.
  let crownStart = Infinity;
  const family = look.scifi.family ?? 'cluster';
  // A lens or a spire is the tower's crown: the family's own crown is left off under it.
  if (roofCrown.kind === 'none' && last >= 0 && layout.floors[last].floor.era === 'scifi' && stateAt(last) !== 'scar' && crownSlots(family).length > 0) {
    let start = last;
    while (start > 0 && sameRun(start - 1, start) && stateAt(start - 1) !== 'scar') start--;
    let n = crownFloors(last - start + 1);
    const d = spec.datumIndex - 1;
    if (d >= last - n + 1 && d < last) n = last - d;
    crownStart = last - n + 1;
  }
  const crownHeight = crownStart <= last ? layout.top - layout.floors[crownStart].y0 : 0;
  // The run the tower tops out in: its sci-fi families shape themselves toward the roof; runs below it are shaft.
  let topRun = last;
  while (topRun > 0 && sameRun(topRun - 1, topRun)) topRun--;
  /** Earned floors taper by whole runs: each run holds one width, the next starts as narrow as the floors laid. */
  let pendingTaper = 0;
  /** The width of the first earned floor, which every silhouette measures from. */
  let earnedBase = 0;
  /** The floor below, as built: its plan centre, half-width and height, for the brackets under an overhang. */
  let below: { cx: number; half: number; h: number } | null = null;
  let topPlan = { cx: 0, cz: 0, half: width / 2, ry: 0 };
  layout.floors.forEach(({ floor, y0, h }, i) => {
    kit.tint = yearDrift(spec.repo, floor.era, yearOf(floor.at), firstYear);
    const earned = earnedAt(i);
    const state = stateAt(i);
    const runStart = !sameRun(i - 1, i);
    const runEnd = !sameRun(i, i + 1);
    inRun = runStart ? 0 : inRun + 1;
    if (earned && i === spec.datumIndex && i > 0) width -= Math.min(EARNED_LEDGE, width * 0.16);
    else if (!earned && i > 0 && inRun === 0) width -= ERA_SETBACK;
    if (earned && runStart) {
      width *= TAPER ** pendingTaper;
      pendingTaper = 0;
    }
    if (earned && i === spec.datumIndex) earnedBase = width;
    // The silhouette moves each earned floor: a lens turns it, a cantilever steps it out, a needle narrows it.
    const t = earned ? floorTransform(silhouette, i - spec.datumIndex, earnedBase) : floorTransform('plain', 0, width);
    const w = silhouette === 'needle' && earned ? t.width : width;
    const ry = (floor.era === 'titanium' ? inRun * TITANIUM_TWIST : 0) + t.rotY;
    const ox = t.offsetX;
    const oz = t.offsetZ;
    kit.base = M(ox, y0, oz, ry);
    const inCrown = i >= crownStart;
    let shape: FloorShape;
    if (state === 'scar') {
      shape = scarFloor(kit, w, h, rng(floor.id));
    } else {
      // A crown is asleep while the floor at the top of it waits on his review.
      const asleep = state === 'waiting' || (inCrown && stateAt(last) === 'waiting');
      if (asleep) kit.remap = { ...towerRemap, ...ASLEEP, ...(dark ? DARK : {}) };
      // The amber belongs to Claude-co-authored history: an earned floor shows its firm's mark instead.
      const built = earned ? { ...floor, claude: false } : floor;
      shape = ERA_BUILDERS[floor.era](kit, w, h, built, {
        index: i,
        inRun,
        runStart,
        runEnd,
        top: i === last,
        // Below the top run an earned floor is a floor of its era's shaft; only the top run shapes toward a roof.
        fromTop: earned && i < topRun ? last - i + 24 : last - i,
        datum: i === spec.datumIndex - 1,
        rand: rng(floor.id),
        variant: look[floor.era],
        asleep,
        ...(inCrown ? { crown: { stage: i - crownStart, height: crownHeight } } : {}),
      });
      kit.remap = towerRemap;
      if (state && !inCrown) {
        if (state === 'waiting') bareEdge(kit, shape.edge);
        else earnedLine(kit, shape.edge, floor.earned?.note?.startsWith('merged with his changes') ?? false);
        if (floor.earned) firmMark(kit, shape.edge, firmMarkColor(floor.earned.firmId, opts.firmSlots));
      }
    }
    pickables.set(proxy(shape.cx + ox, y0 + h / 2, shape.cz + oz, shape.half * 2, h, ry), floor.id);
    // Wherever an earned floor overhangs the one below (a cantilever's step, and the floor back over the axis
    // above it), a pair of tapered steel brackets carries it from the face of the floor below.
    if (earned && below && silhouette === 'cantilever') {
      kit.base = new THREE.Matrix4();
      kit.tint = new THREE.Color(1, 1, 1);
      const half = w / 2;
      for (const side of [1, -1]) {
        const face = below.cx + side * below.half;
        const reach = side * (ox + side * half - face);
        if (reach < 0.5) continue;
        // One bracket shape, stretched to the reach and to the depth the floor below allows.
        const depth = Math.min(BRACKET_DEPTH, below.h * 0.62);
        for (const z of [-half * 0.52, half * 0.52]) {
          kit.inst('bracket', 'galvanised', () => bracketGeometry(BRACKET_REACH, BRACKET_DEPTH), M(face, y0, z, side > 0 ? 0 : Math.PI, reach / BRACKET_REACH, depth / BRACKET_DEPTH, 1));
        }
        // The edge girder the brackets' noses carry, under the slab along the overhang's outer edge.
        kit.box('galvanised', 0.36, 0.5, w + 0.2, M(face + side * (reach - 0.2), y0 - 0.25, 0));
      }
    }
    below = { cx: ox, half: w / 2, h };
    topPlan = { cx: shape.cx + ox, cz: shape.cz + oz, half: shape.edge.half, ry };
    if (i === spec.datumIndex - 1) {
      datumPlan = { cx: shape.cx, cz: shape.cz, half: shape.datumHalf, ry, round: shape.round, ledge: last > i };
    }
    if (earned) pendingTaper++;
    else width *= TAPER;
  });

  kit.base = new THREE.Matrix4();
  kit.tint = new THREE.Color(1, 1, 1);
  addDatum(kit, layout.datumY, datumPlan);
  if (roofCrown.kind !== 'none') {
    // On the top floor's roof, turned with it, so a lens tower's crown follows its twist.
    kit.base = M(topPlan.cx, layout.top, topPlan.cz, topPlan.ry);
    if (roofCrown.kind === 'lens') makeLensCrown(kit, roofCrown.rings, quality, topPlan.half, roofCrown.height, topPlan.ry);
    else makeSpire(kit, roofCrown.height, topPlan.half);
    kit.base = new THREE.Matrix4();
  }

  const group = kit.build();
  group.add(proxies);
  group.name = `tower:${spec.repo}`;
  return {
    group,
    pickables,
    rootPick,
    top: layout.top,
    crown: roofCrown,
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m.geometry === proxyGeo) return;
        m.geometry.dispose();
        // Frees the instance matrix and colour buffers on the GPU.
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      proxyGeo.dispose();
    },
  };
}
