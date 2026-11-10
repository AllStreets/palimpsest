import * as THREE from 'three';

import { layoutTower } from '../../../../shared/tower-layout.js';
import type { TowerSpec } from '../../../../shared/types.js';
import { crownSlots } from '../kits.js';
import { addDatum, type DatumPlan } from './datum.js';
import { bareEdge, crownFloors, earnedLine, ERA_BUILDERS, type FloorShape, scarFloor, TITANIUM_TWIST } from './eras.js';
import { Kit, M, type MatKey, rng, type TowerMaterials } from './kit.js';
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

export interface BuildOptions {
  /** The first floor's width; an agent tower's default is AGENT_FLOOR_WIDTH, a repo's FLOOR_WIDTH. */
  width?: number;
  /** A bankrupt firm's tower: every material unlit, no light lines, the datum left. Defaults to the spec's own flag. */
  dark?: boolean;
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
  /** Equals layoutTower(spec).top. */
  top: number;
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

  ROOT_BUILDERS[spec.root](kit, detail, rng(spec.id));

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
  const rootPick = proxy(0, layout.rootHeight / 2, 0, ROOT_TOP_HALF[spec.root] * 2 + 6, layout.rootHeight, 0);

  let width = opts.width ?? (spec.kind === 'agent' ? AGENT_FLOOR_WIDTH : FLOOR_WIDTH);
  let inRun = 0;
  let datumPlan: DatumPlan = { cx: 0, cz: 0, half: ROOT_TOP_HALF[spec.root] - 0.4, ry: 0 };
  const yearOf = (at: string): number => new Date(at).getUTCFullYear() || 0;
  const firstYear = layout.floors.length ? yearOf(layout.floors[0].floor.at) : 0;
  const last = layout.floors.length - 1;
  /** Floors earned in the market: they stand above the datum and are laid floor by floor in their agent's era. */
  const earnedAt = (i: number): boolean => i >= spec.datumIndex && !layout.floors[i].floor.founding;
  /** What a floor is built as: a scar is primer whatever its era, so it breaks a run. */
  const kindAt = (i: number): string | undefined => {
    const f = layout.floors[i]?.floor;
    return f ? (f.earned?.state === 'scar' ? 'scar' : f.era) : undefined;
  };
  // The sci-fi run at the top carries its family's crown over its last few floors, starting above the datum line
  // if the band falls inside them, so the band never cuts a crown in two. A tower whose top is earned in the
  // market ends in its last earned floor's own roof instead, and without the Blender kits the family builds
  // its own top floor.
  let crownStart = Infinity;
  const family = look.scifi.family ?? 'cluster';
  if (last >= 0 && layout.floors[last].floor.era === 'scifi' && !earnedAt(last) && crownSlots(family).length > 0) {
    let start = last;
    while (start > 0 && layout.floors[start - 1].floor.era === 'scifi') start--;
    let n = crownFloors(last - start + 1);
    const d = spec.datumIndex - 1;
    if (d >= last - n + 1 && d < last) n = last - d;
    crownStart = last - n + 1;
  }
  const crownHeight = crownStart <= last ? layout.top - layout.floors[crownStart].y0 : 0;
  layout.floors.forEach(({ floor, y0, h }, i) => {
    kit.tint = yearDrift(spec.repo, floor.era, yearOf(floor.at), firstYear);
    const earned = earnedAt(i);
    const prev = kindAt(i - 1);
    const next = kindAt(i + 1);
    const kind = kindAt(i);
    inRun = prev === kind ? inRun + 1 : 0;
    if (earned && i === spec.datumIndex && i > 0) width -= Math.min(EARNED_LEDGE, width * 0.16);
    else if (!earned && i > 0 && inRun === 0) width -= ERA_SETBACK;
    const ry = floor.era === 'titanium' ? inRun * TITANIUM_TWIST : 0;
    kit.base = M(0, y0, 0, ry);
    const state = earned ? floor.earned?.state ?? 'lit' : null;
    let shape: FloorShape;
    if (state === 'scar') {
      shape = scarFloor(kit, width, h, rng(floor.id));
    } else {
      if (state === 'waiting') kit.remap = { ...towerRemap, ...ASLEEP, ...(dark ? DARK : {}) };
      shape = ERA_BUILDERS[floor.era](kit, width, h, floor, {
        index: i,
        inRun,
        runStart: prev !== kind,
        runEnd: next !== kind,
        top: i === last,
        // An earned floor is a floor of its era's shaft, whatever stands above it; only the tower's top makes a roof.
        fromTop: earned && i !== last ? last - i + 24 : last - i,
        datum: i === spec.datumIndex - 1,
        rand: rng(floor.id),
        variant: look[floor.era],
        asleep: state === 'waiting',
        ...(i >= crownStart ? { crown: { stage: i - crownStart, height: crownHeight } } : {}),
      });
      kit.remap = towerRemap;
      if (state === 'waiting') bareEdge(kit, shape.edge);
      else if (state === 'lit') earnedLine(kit, shape.edge, floor.earned?.note?.startsWith('merged with his changes') ?? false);
    }
    pickables.set(proxy(shape.cx, y0 + h / 2, shape.cz, shape.half * 2, h, ry), floor.id);
    if (i === spec.datumIndex - 1) {
      datumPlan = { cx: shape.cx, cz: shape.cz, half: shape.datumHalf, ry, round: shape.round, ledge: last > i };
    }
    width *= TAPER;
  });

  kit.base = new THREE.Matrix4();
  kit.tint = new THREE.Color(1, 1, 1);
  addDatum(kit, layout.datumY, datumPlan);

  const group = kit.build();
  group.add(proxies);
  group.name = `tower:${spec.repo}`;
  return {
    group,
    pickables,
    rootPick,
    top: layout.top,
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
