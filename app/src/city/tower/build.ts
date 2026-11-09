import * as THREE from 'three';

import { layoutTower } from '../../../../shared/tower-layout.js';
import type { TowerSpec } from '../../../../shared/types.js';
import { addDatum } from './datum.js';
import { ERA_BUILDERS, type FloorShape, TITANIUM_TWIST } from './eras.js';
import { Kit, M, rng, type TowerMaterials } from './kit.js';
import { ROOT_BUILDERS, ROOT_TOP_HALF } from './roots.js';

export type { TowerMaterials } from './kit.js';

/** The first floor's width; every floor above is 0.6% narrower than the one below. */
export const FLOOR_WIDTH = 26;
export const TAPER = 0.994;
/** Each new era steps in this far overall, so the eras read as setbacks in the silhouette. */
export const ERA_SETBACK = 1.6;

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
 * A Palimpsest tower, read bottom to top: the root in its inherited
 * vernacular, one floor per merged change laid in the era it was earned in,
 * and the bronze datum line where the repo joined the city. Heights follow
 * layoutTower exactly. The tower stands centred on its local origin.
 */
export function buildTower(spec: TowerSpec, quality: 'high' | 'medium', mats: TowerMaterials): BuiltTower {
  const layout = layoutTower(spec);
  const kit = new Kit(mats);
  const detail = quality === 'high';

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

  let width = FLOOR_WIDTH;
  let inRun = 0;
  let datumPlan = { cx: 0, cz: 0, half: ROOT_TOP_HALF[spec.root] - 0.4, octagon: false, ry: 0 };
  layout.floors.forEach(({ floor, y0, h }, i) => {
    const prev = layout.floors[i - 1]?.floor.era;
    const next = layout.floors[i + 1]?.floor.era;
    inRun = prev === floor.era ? inRun + 1 : 0;
    if (i > 0 && inRun === 0) width -= ERA_SETBACK;
    const ry = floor.era === 'titanium' ? inRun * TITANIUM_TWIST : 0;
    kit.base = M(0, y0, 0, ry);
    const shape: FloorShape = ERA_BUILDERS[floor.era](kit, width, h, floor, {
      index: i,
      inRun,
      runStart: prev !== floor.era,
      runEnd: next !== floor.era,
      top: i === layout.floors.length - 1,
      rand: rng(floor.id),
    });
    pickables.set(proxy(shape.cx, y0 + h / 2, shape.cz, shape.half * 2, h, ry), floor.id);
    if (i === spec.datumIndex - 1) {
      datumPlan =
        floor.era === 'scifi'
          ? { ...shape, half: shape.half - 0.05, octagon: true, ry: 0 }
          : { cx: 0, cz: 0, half: width / 2 + (floor.era === 'titanium' ? 0.35 : 0.12), octagon: false, ry };
    }
    width *= TAPER;
  });

  kit.base = new THREE.Matrix4();
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
        if (m.isMesh && m.geometry !== proxyGeo) m.geometry.dispose();
      });
      proxyGeo.dispose();
    },
  };
}
