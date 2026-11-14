/**
 * The school's towers (Phase 4 Task 38): every agent tower on the
 * `collegiate` root, root and floors alike, drawn in the university's own
 * masonry in one call per pass however many graduates are hired.
 *
 * A school tower is built as any agent tower is (tower/build.ts, in its
 * quarter), then taken apart here: each piece's Kit slot names a kind of
 * the campus's one masonry material (brick, limestone, ashlar, slate, a
 * dark paint for steel, brass for the datum, a bare emitter for the lit
 * lines and lamps), its drift and instance colour multiplied in, every
 * repeated part laid out instance by instance, and all of it merged, in
 * world space, with every other school tower into one mesh; the panes of
 * every tower ride in one instanced draw of the campus's window material,
 * their light kept. The towers' own meshes stay where they are, hidden, for
 * picking, framing and the next rebuild. From home that is the masonry in
 * the view and the shadow map (and the AO's normal pass while any tower is
 * within AO_NEAR) and the panes in the view: four calls at most.
 * Pure three.js: tested in Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { type Kind, mergeStamped, stamp, TONE } from './campus/site.js';
import { AO_NEAR, LAYER, setLayers } from './lod.js';
import { type MatKey, paneData, paneGeometry } from './tower/kit.js';

/** A slot's kind in the campus masonry, and a tint on the kind's tone (the slot's own colour where the kind is a plain paint or a bare emitter). */
export interface SchoolKind {
  kind: Kind;
  tint?: THREE.Color;
}

/** A plain paint in the colour wanted: the paint kind's tone divided out. */
const paint = (r: number, g: number, b: number): SchoolKind => ({ kind: 'paint', tint: new THREE.Color(r / TONE.paint.r, g / TONE.paint.g, b / TONE.paint.b) });
/** A bare emitter at the colour and level the tower's own material burns at. */
const line = (r: number, g: number, b: number, k = 1): SchoolKind => ({ kind: 'line', tint: new THREE.Color(r * k, g * k, b * k) });
const dark = paint(0.2, 0.21, 0.23);

/**
 * Every Kit slot's place in the campus masonry: `pane` rides in the pane
 * draw, null is never drawn. The eras' slots: a brick floor is the campus's
 * brick with limestone dressings, a stone floor its ashlar; the glass,
 * titanium and sci-fi eras keep their massing in paint, slate and brass.
 */
export const SCHOOL_KIND: Record<MatKey, SchoolKind | 'pane' | null> = {
  sand: { kind: 'limestone' },
  travertine: { kind: 'limestone' },
  gothic: { kind: 'ashlar' },
  limestone: { kind: 'limestone' },
  granite: { kind: 'ashlar' },
  datum: { kind: 'brass' },
  steel: dark,
  graphite: dark,
  slab: { kind: 'ashlar', tint: new THREE.Color(0.9, 0.9, 0.9) },
  window: 'pane',
  stained: line(0.8, 0.45, 0.55, 0.6),
  roofTile: { kind: 'slate' },
  // Timber keeps its own tint (a door's oak, the pagoda's lacquer) on a plain paint.
  timber: paint(1, 1, 1),
  plaster: { kind: 'paint' },
  lightLine: line(0.88, 0.93, 1.0),
  accent: line(1.0, 0.36, 0.05, 1.5),
  earnedLine: line(0.5, 0.68, 0.95, 0.3),
  handLine: line(1.0, 0.84, 0.62, 0.25),
  // The firm's colour arrives as the vertex colour: the paint's tone divided out keeps it.
  firmMark: paint(1, 1, 1),
  primer: paint(0.36, 0.17, 0.13),
  darkGlass: 'pane',
  lens: { kind: 'slate', tint: new THREE.Color(0.5, 0.55, 0.6) },
  galvanised: paint(0.55, 0.57, 0.6),
  unlit: paint(0.12, 0.12, 0.13),
  vent: line(1.0, 0.6, 0.28, 0.55),
  beacon: line(1.0, 0.1, 0.05, 1.2),
  roof: paint(0.16, 0.17, 0.18),
  pick: null,
  stoneWall: { kind: 'ashlar' },
  stoneTrim: { kind: 'limestone' },
  stoneBand: { kind: 'limestone' },
  stoneWin: 'pane',
  stoneFace: { kind: 'ashlar' },
  brickWall: { kind: 'brick' },
  brickTrim: { kind: 'limestone' },
  brickBand: { kind: 'limestone' },
  brickWin: 'pane',
  brickFace: { kind: 'brick' },
  glassWall: { kind: 'slate' },
  glassTrim: dark,
  glassBand: { kind: 'brass' },
  glassWin: 'pane',
  glassFace: { kind: 'slate' },
  titaniumWall: paint(0.8, 0.8, 0.78),
  titaniumTrim: dark,
  titaniumBand: { kind: 'brass' },
  titaniumWin: 'pane',
  titaniumFace: paint(0.8, 0.8, 0.78),
  scifiWall: paint(0.72, 0.72, 0.7),
  scifiTrim: dark,
  scifiBand: { kind: 'brass' },
  scifiWin: 'pane',
  scifiFace: paint(0.72, 0.72, 0.7),
};

export interface SchoolBatch {
  group: THREE.Group;
  /** Draws exactly these built towers (each already placed in the world): new ones are taken in and hidden, ones no longer listed let go. Returns true when anything changed. */
  set(towers: THREE.Object3D[]): boolean;
  /** Per frame: the AO's normal pass sees the masonry only while a tower is within its reach of the eye. */
  update(eye: THREE.Vector3): void;
  dispose(): void;
}

interface Entry {
  geo: THREE.BufferGeometry | null;
  sphere: THREE.Sphere | null;
  panes: THREE.Matrix4[];
  colours: THREE.Color[];
}

/** A pane's light with the power off (a dark tower's panes draw in darkGlass). */
const DARK_PANE = paneData(0, 1, 1);

/** The tower's own vertex colour (the Kit's drift) times an instance colour, kept to multiply back after the stamp. */
function tints(g: THREE.BufferGeometry, by?: THREE.Color): Float32Array {
  const n = g.attributes.position.count;
  const out = new Float32Array(n * 3).fill(1);
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  for (let i = 0; i < n; i++) {
    out[i * 3] = (col?.getX(i) ?? 1) * (by?.r ?? 1);
    out[i * 3 + 1] = (col?.getY(i) ?? 1) * (by?.g ?? 1);
    out[i * 3 + 2] = (col?.getZ(i) ?? 1) * (by?.b ?? 1);
  }
  return out;
}

/** A piece in world space stamped into its kind, the tower's own tints multiplied in. */
function stamped(g: THREE.BufferGeometry, k: SchoolKind, by?: THREE.Color): THREE.BufferGeometry {
  const t = tints(g, by);
  stamp(g, k.kind, 1, undefined, k.tint);
  const col = g.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * t[i * 3], col.getY(i) * t[i * 3 + 1], col.getZ(i) * t[i * 3 + 2]);
  return g;
}

/** Takes a built tower apart: its pieces stamped and merged, its panes kept; its meshes hidden. */
function take(tower: THREE.Object3D): Entry {
  tower.updateMatrixWorld(true);
  const pieces: THREE.BufferGeometry[] = [];
  const panes: THREE.Matrix4[] = [];
  const colours: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const mesh = (o: THREE.Mesh): void => {
    const key = o.userData.mat as MatKey | undefined;
    const k = key ? SCHOOL_KIND[key] : undefined;
    const im = o as THREE.InstancedMesh;
    if (k === 'pane' && im.isInstancedMesh) {
      const unlit = key === 'darkGlass';
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        panes.push(m.clone().premultiply(im.matrixWorld));
        if (unlit || !im.instanceColor) colours.push(DARK_PANE.clone());
        else {
          im.getColorAt(i, c);
          colours.push(c.clone());
        }
      }
    } else if (k && k !== 'pane') {
      if (im.isInstancedMesh) {
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m);
          const g = im.geometry.clone().applyMatrix4(m.premultiply(im.matrixWorld));
          if (im.instanceColor) im.getColorAt(i, c);
          pieces.push(stamped(g, k, im.instanceColor ? c : undefined));
        }
      } else {
        pieces.push(stamped(o.geometry.clone().applyMatrix4(o.matrixWorld), k));
      }
    }
    o.visible = false;
  };
  const visit = (o: THREE.Object3D): void => {
    if (o.name === 'tower:picks') return;
    if ((o as THREE.LOD).isLOD) {
      // A part with a near and a far level: the near one, which the merged mesh keeps at any distance.
      const near = (o as THREE.LOD).levels[0]?.object as THREE.Mesh | undefined;
      if (near?.isMesh) mesh(near);
      // Hidden, the LOD is never updated by the renderer, so its levels stay hidden too.
      o.visible = false;
      for (const level of o.children) level.visible = false;
      return;
    }
    if ((o as THREE.Mesh).isMesh) {
      mesh(o as THREE.Mesh);
      return;
    }
    o.children.forEach(visit);
  };
  visit(tower);
  const geo = pieces.length ? mergeStamped(pieces) : null;
  return { geo, sphere: geo?.boundingSphere?.clone() ?? null, panes, colours };
}

export function schoolBatch(masonry: THREE.Material, window: THREE.Material): SchoolBatch {
  const group = new THREE.Group();
  group.name = 'school-towers';
  const entries = new Map<THREE.Object3D, Entry>();
  let stone: THREE.Mesh | null = null;
  let glass: THREE.InstancedMesh | null = null;
  const paneGeo = paneGeometry();
  let aoSeen: boolean | null = null;
  const sphere = new THREE.Sphere();

  function clear(): void {
    if (stone) {
      group.remove(stone);
      stone.geometry.dispose();
      stone = null;
    }
    if (glass) {
      group.remove(glass);
      glass.dispose();
      glass = null;
    }
  }

  function remerge(): void {
    clear();
    aoSeen = null;
    const geos: THREE.BufferGeometry[] = [];
    const spheres: THREE.Sphere[] = [];
    const panes: THREE.Matrix4[] = [];
    const colours: THREE.Color[] = [];
    for (const e of entries.values()) {
      if (e.geo) {
        geos.push(e.geo);
        spheres.push(e.sphere!);
      }
      panes.push(...e.panes);
      colours.push(...e.colours);
    }
    if (geos.length) {
      const merged = geos.length === 1 ? geos[0].clone() : mergeGeometries(geos, false);
      if (merged) {
        merged.computeBoundingSphere();
        stone = new THREE.Mesh(merged, masonry);
        stone.name = 'school:masonry';
        stone.castShadow = stone.receiveShadow = true;
        stone.userData.lodParts = spheres;
        group.add(stone);
      }
    }
    if (panes.length) {
      glass = new THREE.InstancedMesh(paneGeo, window, panes.length);
      panes.forEach((p, i) => {
        glass!.setMatrixAt(i, p);
        glass!.setColorAt(i, colours[i]);
      });
      glass.instanceMatrix.needsUpdate = true;
      if (glass.instanceColor) glass.instanceColor.needsUpdate = true;
      glass.castShadow = false;
      glass.receiveShadow = true;
      glass.name = 'school:panes';
      glass.computeBoundingBox();
      glass.computeBoundingSphere();
      // Too thin for the AO and never a caster: the view alone draws the panes.
      setLayers(glass, LAYER.view);
      group.add(glass);
    }
  }

  return {
    group,
    set(towers) {
      const want = new Set(towers);
      let changed = false;
      for (const [t, e] of entries) {
        if (want.has(t)) continue;
        e.geo?.dispose();
        entries.delete(t);
        changed = true;
      }
      for (const t of towers) {
        if (entries.has(t)) continue;
        entries.set(t, take(t));
        changed = true;
      }
      if (changed) remerge();
      return changed;
    },
    update(eye) {
      if (!stone) return;
      let d = Infinity;
      for (const s of stone.userData.lodParts as THREE.Sphere[]) d = Math.min(d, Math.max(0, sphere.copy(s).distanceToPoint(eye)));
      const near = d <= AO_NEAR;
      if (near === aoSeen) return;
      aoSeen = near;
      if (near) stone.layers.set(0);
      else setLayers(stone, LAYER.view, LAYER.shadow);
    },
    dispose() {
      clear();
      for (const e of entries.values()) e.geo?.dispose();
      entries.clear();
      paneGeo.dispose();
    },
  };
}
