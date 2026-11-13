/**
 * The university campus (Phase 4 Tasks 34 and 35): the terrace, its quads,
 * the four halls, the library closing the axis and the clock tower between
 * the ranges, stood on the plot the engine took (engine/school/campus.ts)
 * and turned so its gate faces the centre of the city. Later tasks stand
 * the observatory on its anchor and bring the campus's life.
 *
 * What it costs: one masonry draw for the site (the terrace, the walks, the
 * trees, the library and the tower merged), one instanced masonry draw for
 * the four halls, one draw of panes (every building's), one of the clock's
 * hands, in the view; the two merged masonry draws again in the shadow map,
 * and again in the AO's normal pass while the eye is within AO_NEAR. Eight
 * calls at most on high, six from home on either tier.
 */
import * as THREE from 'three';

import { AO_NEAR, LAYER, setLayers } from '../lod.js';
import { Kit, type TowerMaterials } from '../tower/kit.js';
import { makeClockTower } from './clock.js';
import { stampBuilt } from './gothic.js';
import { buildHall, instanceHalls, type Hall } from './halls.js';
import { makeLibrary } from './library.js';
import { buildSite, FRONT_QUAD, HALL_Z, INNER_QUAD, mergeStamped, siteAnchors, TERRACE } from './site.js';

export interface CampusOptions {
  quality: 'high' | 'medium';
  /** The tower materials: the halls' windows draw in `window`; the rest name kinds while the Kit builds. */
  materials: TowerMaterials;
  /** The masonry material (campus/masonry.ts in the app; a plain one in tests). The campus does not own it. */
  masonry: THREE.Material;
  seed?: string;
  /** His clock, for the tower's hands and its dials' light (a test's or a still's fixed time); the wall clock by default. */
  now?: () => Date;
  /** The city's own word on evening (scene.ts, from its ambient life's density); null or absent reads sunset from the season. */
  evening?: () => boolean | null;
}

/** Where the later buildings stand, in the world: the library at the axis's end, the clock between the ranges, the dome at the back corner, the gate at the stair head. */
export interface CampusAnchors {
  library: THREE.Vector3;
  clock: THREE.Vector3;
  dome: THREE.Vector3;
  gate: THREE.Vector3;
}

export interface Campus {
  group: THREE.Group;
  /** Stands the campus on its plot, turned so the gate faces the city's centre. */
  set(origin: { x: number; z: number }): void;
  origin(): { x: number; z: number } | null;
  anchors(): CampusAnchors;
  /** Per frame: `clock` is the city's seconds, `eye` the camera, which decides whether the AO still sees the campus. */
  update(dt: number, clock: number, eye: THREE.Vector3): void;
  dispose(): void;
}

/** The yaw that turns the campus's own +x toward the centre of the city, snapped to the grid's four directions. */
export function campusYaw(origin: { x: number; z: number }): number {
  const dx = Math.abs(origin.x) >= Math.abs(origin.z) ? -Math.sign(origin.x) : 0;
  const dz = dx === 0 ? -Math.sign(origin.z) || -1 : 0;
  return Math.atan2(-dz, dx);
}

/** The four halls' places on the terrace: two ranges either side of each quad, their fronts to the lawn. */
export function hallPlacements(): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (const q of [FRONT_QUAD, INNER_QUAD]) {
    const cx = (q.x0 + q.x1) / 2;
    for (const s of [1, -1]) {
      const m = new THREE.Matrix4().makeRotationY(s === 1 ? Math.PI : 0);
      m.setPosition(cx, TERRACE, s * HALL_Z);
      out.push(m);
    }
  }
  return out;
}

/** Each hall's brick fired in its own year: a little lighter or darker than the next. */
const HALL_TINTS = [1.0, 0.95, 1.04, 0.97].map((k) => new THREE.Color(k, k, k));

export function createCampus(opts: CampusOptions): Campus {
  const detail = opts.quality === 'high';
  const masonry = opts.masonry;
  const group = new THREE.Group();
  group.name = 'campus';

  const local = siteAnchors();
  const now = opts.now ?? (() => new Date());

  // The library and the clock tower, built in one Kit on their anchors and stamped into the site's draw.
  const kit = new Kit(opts.materials);
  kit.detail = detail;
  kit.base = new THREE.Matrix4().makeTranslation(local.library.x, TERRACE, local.library.z);
  makeLibrary(kit, { quality: opts.quality, seed: opts.seed });
  kit.base = new THREE.Matrix4().makeTranslation(local.clock.x, TERRACE, local.clock.z);
  const tower = makeClockTower(kit, now, { masonry, quality: opts.quality, seed: opts.seed, evening: opts.evening });
  const built = stampBuilt(kit.build(), opts.materials.window);
  const siteGeo = mergeStamped([buildSite(detail), built.masonry]);
  const site = new THREE.Mesh(siteGeo, masonry);
  site.name = 'campus:site';
  site.castShadow = site.receiveShadow = true;
  group.add(site);

  const hall: Hall = buildHall({ quality: opts.quality, materials: opts.materials, masonry, seed: opts.seed ?? 'university' });
  const halls = instanceHalls(hall, hallPlacements(), HALL_TINTS, built.panes);
  built.panes.geometry.dispose();
  group.add(halls.group);
  // The panes never cast and are too thin for the AO: the view alone draws them. The hands likewise.
  setLayers(halls.panes, LAYER.view);
  setLayers(tower.hands, LAYER.view);
  group.add(tower.group);
  tower.update();

  let origin: { x: number; z: number } | null = null;
  const sphere = new THREE.Sphere();
  let aoSeen: boolean | null = null;

  return {
    group,
    set(o) {
      origin = { x: o.x, z: o.z };
      group.position.set(o.x, 0, o.z);
      group.rotation.y = campusYaw(o);
      group.updateMatrixWorld(true);
      aoSeen = null;
    },
    origin: () => origin,
    anchors() {
      group.updateWorldMatrix(true, false);
      const w = (v: THREE.Vector3): THREE.Vector3 => v.clone().applyMatrix4(group.matrixWorld);
      return { library: w(local.library), clock: w(local.clock), dome: w(local.dome), gate: w(local.gate) };
    },
    update(_dt, _clock, eye) {
      if (!origin) return;
      tower.update();
      // Past AO_NEAR the AO cannot see it (lod.ts): the view and the shadow map draw it alone.
      sphere.copy(siteGeo.boundingSphere!).applyMatrix4(group.matrixWorld);
      const near = sphere.distanceToPoint(eye) <= AO_NEAR;
      if (near === aoSeen) return;
      aoSeen = near;
      for (const m of [site, halls.masonry]) {
        if (near) m.layers.set(0);
        else setLayers(m, LAYER.view, LAYER.shadow);
      }
    },
    dispose() {
      halls.dispose();
      hall.dispose();
      tower.dispose();
      siteGeo.dispose();
    },
  };
}
