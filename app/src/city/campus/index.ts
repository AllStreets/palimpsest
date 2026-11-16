/**
 * The university campus (Phase 4 Tasks 34 and 35): the terrace, its quads,
 * the four halls, the library closing the axis, the clock tower between
 * the ranges and the observatory at the back corner (Task 36), stood on the
 * plot the engine took (engine/school/campus.ts) and turned so its gate
 * faces the centre of the city. Later tasks bring the campus's life.
 *
 * What it costs: one masonry draw for the site (the terrace, the walks, the
 * trees, the library, the tower and the observatory's drum and dome merged),
 * one instanced masonry draw for the four halls, one draw of panes (every
 * building's), one of the clock's hands, one of the dome's shutters, one
 * of the telescope and one of the library's readers (Phase 5 Task 10), in
 * the view; the two merged masonry draws and the shutters again in the
 * shadow map, and the two merged draws again in the AO's normal pass while
 * the eye is within AO_NEAR. Twelve calls at most on high, nine from home on
 * either tier (the trees are the city's, trees.ts).
 */
import * as THREE from 'three';

import { AO_NEAR, LAYER, setLayers } from '../lod.js';
import { Kit, PANE_READING, type TowerMaterials } from '../tower/kit.js';
import { makeClockTower } from './clock.js';
import { stampBuilt } from './gothic.js';
import { buildHall, instanceHalls, type Hall } from './halls.js';
import { BAY_DARK, GABLE_IDLE, LANTERN_IDLE, LIBRARY, makeLibrary } from './library.js';
import { makeReaders } from './readers.js';
import { makeObservatory, type ObservatoryState, type ObservatoryView } from './observatory.js';
import type { TreeSpot } from '../trees.js';
import { approachPath, buildSite, campusTreeSpots, FRONT_QUAD, HALL_Z, INNER_QUAD, mergeStamped, siteAnchors, TERRACE, walkGraph } from './site.js';

type V3 = [number, number, number];

/** The library's pick proxy maps to this in `pickables`: the city opens the campus's inspector (the live voyage, the nets, the graduates). */
export const CAMPUS_INSPECT = 'campus:inspect';

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

/** The library's light as the campus's life sets it (life.ts): one level per reading-room bay, one for the gable ends, one for the lantern. */
export interface LibraryLight {
  bays: ReadonlyArray<number>;
  ends: number;
  lantern: number;
}

export interface Campus {
  group: THREE.Group;
  /** Stands the campus on its plot, turned so the gate faces the city's centre. */
  set(origin: { x: number; z: number }): void;
  origin(): { x: number; z: number } | null;
  /** The quads' and the forecourt's trees where they stand in the city (trees.ts plants them), or none before set(). */
  treeSpots(): TreeSpot[];
  anchors(): CampusAnchors;
  /** The school's state as the ledger tells it: the observatory opens while the nets train and lights its plate while the master is trusted. */
  setSchool(s: ObservatoryState): void;
  /** The observatory as it shows now (tests and captures). */
  observatory(): ObservatoryView;
  /** The campus's pickable parts, each mapped to the route it opens: the dome, to the school screen at the master; the library, to CAMPUS_INSPECT. */
  pickables: Map<THREE.Object3D, string>;
  /** The library's reading room: how many bays it has, which panes of the campus's pane draw they are (in bay order), and its light. */
  library: {
    bays: number;
    panes: ReadonlyArray<number>;
    /** The readers at its desks (readers.ts): one instanced draw, each desk's pose. */
    readers: { mesh: THREE.InstancedMesh; poses: ReadonlyArray<number> };
    set(light: LibraryLight): void;
  };
  /** The way from the street up the stair to the gate and onto the forecourt, in the world (people.ts). */
  approach(): V3[];
  /** The walks as a graph in the world, for the students (life.ts). */
  walks(): { nodes: V3[]; edges: Array<[number, number]> };
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

/** The reading-room bays' light when lit, bay by bay: the window shader's amber band, no two desks alike. */
const BAY_LIT = [0.54, 0.46, 0.6, 0.5, 0.57, 0.48, 0.62, 0.52, 0.58, 0.45, 0.55, 0.49, 0.61, 0.51];
/** Each bay's lamplight hue, 0 the paler to 1 the deeper amber: no two neighbours alike. */
const BAY_WARM = [0.55, 0.85, 0.3, 0.7, 0.95, 0.45, 0.65, 0.2, 0.8, 0.5, 0.35, 0.9, 0.6, 0.75];
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
  const libraryLights = makeLibrary(kit, { quality: opts.quality, seed: opts.seed });
  kit.base = new THREE.Matrix4().makeTranslation(local.clock.x, TERRACE, local.clock.z);
  const tower = makeClockTower(kit, now, { masonry, quality: opts.quality, seed: opts.seed, evening: opts.evening });
  // The observatory at the back corner, its door and slit facing the gate along the back lawn (the campus's +x).
  kit.base = new THREE.Matrix4().makeTranslation(local.dome.x, TERRACE, local.dome.z);
  const observatory = makeObservatory(kit, { masonry, quality: opts.quality, seed: opts.seed, facing: Math.PI / 2 });
  const built = stampBuilt(kit.build(), opts.materials.window);
  const siteGeo = mergeStamped([buildSite(detail), built.masonry]);
  const site = new THREE.Mesh(siteGeo, masonry);
  site.name = 'campus:site';
  site.castShadow = site.receiveShadow = true;
  group.add(site);

  const hall: Hall = buildHall({ quality: opts.quality, materials: opts.materials, masonry, seed: opts.seed ?? 'university' });
  const placements = hallPlacements();
  const halls = instanceHalls(hall, placements, HALL_TINTS, built.panes);
  // The library's lit panes among the extras: each found by where it stands (the Kit laid them in its own order).
  const firstExtra = hall.panes.matrices.length * placements.length;
  const paneNear = (p: THREE.Vector3): number => {
    let best = -1;
    let d = Infinity;
    const t = new THREE.Vector3();
    built.panes.matrices.forEach((m, j) => {
      const dj = t.setFromMatrixPosition(m).distanceTo(p);
      if (dj < d) {
        d = dj;
        best = j;
      }
    });
    return firstExtra + best;
  };
  const bayPanes = libraryLights.bays.map(paneNear);
  const endPanes = libraryLights.ends.map(paneNear);
  const lanternPanes = libraryLights.lantern.map(paneNear);
  built.panes.geometry.dispose();
  group.add(halls.group);
  const paneColour = new THREE.Color();
  const setPane = (j: number, lit: number): void => {
    halls.panes.getColorAt(j, paneColour);
    paneColour.r = lit;
    halls.panes.setColorAt(j, paneColour);
  };
  // The bays are reading rooms in the window shader, each with its own lamplight hue (the warm channel).
  bayPanes.forEach((j, i) => {
    halls.panes.getColorAt(j, paneColour);
    paneColour.g = BAY_WARM[i % BAY_WARM.length];
    paneColour.b = PANE_READING;
    halls.panes.setColorAt(j, paneColour);
  });
  if (halls.panes.instanceColor) halls.panes.instanceColor.needsUpdate = true;
  // The library's pick proxy: a box over the reading room and its frontispiece, never drawn; it opens the campus's inspector.
  const libraryPick = new THREE.Mesh(new THREE.BoxGeometry(LIBRARY.width + 10, 34, LIBRARY.length + 2), new THREE.MeshBasicMaterial({ visible: false }));
  libraryPick.name = 'campus:library-pick';
  libraryPick.visible = false;
  libraryPick.position.set(local.library.x + 2, TERRACE + 17, local.library.z);
  group.add(libraryPick);
  observatory.pickables.set(libraryPick, CAMPUS_INSPECT);
  // The panes never cast and are too thin for the AO: the view alone draws them. The hands likewise.
  setLayers(halls.panes, LAYER.view);
  setLayers(tower.hands, LAYER.view);
  group.add(tower.group);
  tower.update();
  // The readers at the library's desks (readers.ts): one instanced draw, seen through the glass, the view alone.
  const readers = makeReaders(libraryLights.bayFrames);
  setLayers(readers.mesh, LAYER.view);
  group.add(readers.mesh);
  // The telescope stands inside the dome: the view alone draws it. The shutters are part of the dome's silhouette.
  setLayers(observatory.telescope, LAYER.view);
  group.add(observatory.group);

  let origin: { x: number; z: number } | null = null;
  const sphere = new THREE.Sphere();
  let aoSeen: boolean | null = null;
  const toWorld = (p: V3): V3 => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(group.matrixWorld);
    return [v.x, v.y, v.z];
  };

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
    treeSpots() {
      if (!origin) return [];
      const v = new THREE.Vector3();
      return campusTreeSpots().map((t) => {
        v.set(t.x, t.y, t.z).applyMatrix4(group.matrixWorld);
        return { ...t, x: v.x, y: v.y, z: v.z };
      });
    },
    setSchool: (s) => observatory.setState(s),
    observatory: () => observatory.view(),
    pickables: observatory.pickables,
    library: {
      bays: bayPanes.length,
      panes: bayPanes,
      readers: { mesh: readers.mesh, poses: readers.poses },
      set(light) {
        // A lit bay is a reading room's amber, not a blown pane: each at its own level, as the halls' windows are.
        bayPanes.forEach((j, i) => setPane(j, BAY_DARK + (BAY_LIT[i % BAY_LIT.length] - BAY_DARK) * Math.max(0, Math.min(1, light.bays[i] ?? 0))));
        readers.set(light.bays);
        for (const j of endPanes) setPane(j, GABLE_IDLE + (0.6 - GABLE_IDLE) * Math.max(0, Math.min(1, light.ends)));
        for (const j of lanternPanes) setPane(j, LANTERN_IDLE + (0.82 - LANTERN_IDLE) * Math.max(0, Math.min(1, light.lantern)));
        if (halls.panes.instanceColor) halls.panes.instanceColor.needsUpdate = true;
      },
    },
    approach() {
      group.updateWorldMatrix(true, false);
      return approachPath().map(toWorld);
    },
    walks() {
      group.updateWorldMatrix(true, false);
      const g = walkGraph();
      return { nodes: g.nodes.map(toWorld), edges: g.edges };
    },
    anchors() {
      group.updateWorldMatrix(true, false);
      const w = (v: THREE.Vector3): THREE.Vector3 => v.clone().applyMatrix4(group.matrixWorld);
      return { library: w(local.library), clock: w(local.clock), dome: w(local.dome), gate: w(local.gate) };
    },
    update(dt, _clock, eye) {
      if (!origin) return;
      tower.update();
      observatory.update(dt);
      // Past AO_NEAR the AO cannot see it (lod.ts): the view and the shadow map draw it alone.
      sphere.copy(siteGeo.boundingSphere!).applyMatrix4(group.matrixWorld);
      const near = sphere.distanceToPoint(eye) <= AO_NEAR;
      if (near === aoSeen) return;
      aoSeen = near;
      for (const m of [site, halls.masonry]) {
        if (near) m.layers.set(0);
        else setLayers(m, LAYER.view, LAYER.shadow);
      }
      // The shutters cast and are seen, never drawn for the AO: a thin band on a sphere the merged dome already fills.
      setLayers(observatory.shutter, LAYER.view, LAYER.shadow);
    },
    dispose() {
      halls.dispose();
      hall.dispose();
      tower.dispose();
      observatory.dispose();
      readers.dispose();
      siteGeo.dispose();
      libraryPick.geometry.dispose();
      (libraryPick.material as THREE.Material).dispose();
    },
  };
}
