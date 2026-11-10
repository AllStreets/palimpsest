import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Era } from '../../../../shared/types.js';

/**
 * The four surfaces every era is built from, filled per repo from its
 * variant (variants.ts): `Wall` the main surface, `Trim` the second one,
 * `Band` the accent on belt courses, cornices and the crown, `Win` the
 * window glass, `Face` the wall finish on the Blender-authored coursed
 * blocks (kits.ts), which carry their joints in geometry rather than in the
 * shader. So `brickWall` is common red on one tower and cream city brick on
 * the next.
 */
export type EraSlot = 'Wall' | 'Trim' | 'Band' | 'Win' | 'Face';
export type EraMatKey = `${Era}${EraSlot}`;

/** The material key of one of an era's slots. */
export function slot(era: Era, s: EraSlot): EraMatKey {
  return `${era}${s}`;
}

/**
 * The materials a tower is built from. In the browser these are the scanned
 * PBR sets and the window shader (see look.ts); node tests pass plain
 * materials, so nothing here touches textures or the DOM.
 */
export interface TowerMaterials extends Record<EraMatKey, THREE.Material> {
  /** Dressed sandstone: Beaux-Arts roots and stone-era floors. */
  sand: THREE.Material;
  /** Warm travertine: the Roman root. */
  travertine: THREE.Material;
  /** Cool grey limestone: the Gothic root. */
  gothic: THREE.Material;
  /** Pale Indiana limestone: the Chicago root. */
  limestone: THREE.Material;
  /** Rough granite: battered pagoda platforms and plinths. */
  granite: THREE.Material;
  /** Polished bronze: the datum band, bright enough to read against stone and dark steel alike. */
  datum: THREE.Material;
  /** Dark painted steel: frames, reveals, roof edges. */
  steel: THREE.Material;
  /** Dark graphite metal: the sci-fi mullions. */
  graphite: THREE.Material;
  /** Concrete slab edges and soffits. */
  slab: THREE.Material;
  /** Glazing over a lit room (interior-mapped in the browser). Reads per-instance colour as data. */
  window: THREE.Material;
  /** The Gothic rose window's stained glass. */
  stained: THREE.Material;
  /** Fired clay roof tile: pagoda eaves. */
  roofTile: THREE.Material;
  /** Lacquered vermilion timber: pagoda posts and brackets. */
  timber: THREE.Material;
  /** Lime plaster: pagoda walls. */
  plaster: THREE.Material;
  /** Sci-fi slab light lines, a real emitter. */
  lightLine: THREE.Material;
  /** The thin warm accent at the slab edge of a floor Claude co-authored. */
  accent: THREE.Material;
  /** The thin cool line at the slab edge of a floor earned in the market and merged: under the bloom threshold, never the Claude amber. */
  earnedLine: THREE.Material;
  /** The line of a floor he merged with his own changes added: a warm ivory pair, apart from both the cool line and the amber. */
  handLine: THREE.Material;
  /** A firm's mark on the floors it earned: a thin painted metal strip, its colour the vertex colour (the firm's). */
  firmMark: THREE.Material;
  /** Matte rust-red primer: a scar floor, a failed inspection left standing as a deliberate wound. */
  primer: THREE.Material;
  /** Glass with nothing lit behind it: every pane of a dark tower. */
  darkGlass: THREE.Material;
  /** Coated optical glass: the polished disc of a lens tower's crown, holding the dusk sky. */
  lens: THREE.Material;
  /** Hot-dip galvanised steel, a pale satin grey: the cantilever brackets and girders, and the needle's mast. */
  galvanised: THREE.Material;
  /** The unlit stand-in for every emitter (vents, beacons, stained glass) on a dark tower. */
  unlit: THREE.Material;
  /** Warm amber light vents and lit slots set into sci-fi faces (the ziggurat's terraces, the deco crown), a real emitter. */
  vent: THREE.Material;
  /** Red aircraft warning lights on every sci-fi roof, a real emitter. */
  beacon: THREE.Material;
  /** Dark matte roofing membrane on the sci-fi roof plates: a roof, never a mirror of the sunset. */
  roof: THREE.Material;
  /** Invisible pick proxies. */
  pick: THREE.Material;
}

export type MatKey = keyof TowerMaterials;

/** Metres per texture tile for world-projected UVs on merged geometry. */
const TILE: Partial<Record<MatKey, number>> = {
  sand: 2.6,
  travertine: 3.2,
  gothic: 2.2,
  limestone: 3.0,
  granite: 2.0,
  datum: 2,
  steel: 2,
  slab: 3,
  stoneWall: 2.6,
  stoneTrim: 2.6,
  stoneBand: 2.6,
  brickWall: 1.5,
  brickTrim: 2.6,
  brickBand: 2.6,
  glassWall: 2,
  glassTrim: 2,
  glassBand: 2,
  titaniumWall: 3,
  titaniumTrim: 2,
  titaniumBand: 2,
  scifiWall: 3,
  scifiTrim: 3,
  scifiBand: 3,
};

/**
 * Window pane data, carried in the instance colour: `lit` (0 dark to 1 full),
 * `warm` (0 cool office light to 1 warm lamp light) and the pane style.
 */
export const PANE_FULL = 0.0; // floor to ceiling, no sill
export const PANE_CHANNEL = 0.25; // ribbed channel glass: translucent, the room reads only as light
export const PANE_SILL = 0.5; // punched window over a sill
export const PANE_SHOJI = 0.75; // lit paper in a timber lattice
export const PANE_SASH = 1.0; // punched window with glazing bars

export function paneData(lit: number, warm: number, style: number): THREE.Color {
  return new THREE.Color(lit, warm, style);
}

/** Matrix from position, rotation about Y, and scale. */
export function M(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Matrix with a full Euler rotation. */
export function ME(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

/**
 * The frame of one face of a square plan of half-width `half`: x runs along
 * the face, y up, z out of the face, origin on the face's centre line at
 * ground level of the current piece. Sides go round counter-clockwise from +z.
 */
export function face(side: number, half: number): THREE.Matrix4 {
  return M(0, 0, 0, (side * Math.PI) / 2).multiply(M(0, 0, half));
}

/** `face(side, half)` then a local placement within it. */
export function onFace(side: number, half: number, u: number, y: number, d: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return face(side, half).multiply(M(u, y, d, 0, sx, sy, sz));
}

/** A small deterministic RNG seeded from a string (floor ids, repo names). */
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Indexed position/normal/uv/colour only, so any two pieces merge. Every vertex takes `tint` as its colour. */
function normalise(g: THREE.BufferGeometry, tint: THREE.Color): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = tint.r;
    col[i * 3 + 1] = tint.g;
    col[i * 3 + 2] = tint.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/** UVs projected from world position along each vertex's dominant normal axis, so scans keep real scale and run on across pieces. */
function worldUv(g: THREE.BufferGeometry, tile: number): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = p.getX(i);
      v = p.getZ(i);
    } else if (ax >= az) {
      u = p.getZ(i) * Math.sign(n.getX(i) || 1);
      v = p.getY(i);
    } else {
      u = -p.getX(i) * Math.sign(n.getZ(i) || 1);
      v = p.getY(i);
    }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

interface Batch {
  mat: MatKey;
  geo: THREE.BufferGeometry;
  /** The distant level of detail, drawn past LOD_FAR from the batch's centre. */
  lo?: THREE.BufferGeometry;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[] | null;
  shadow: boolean;
}

/**
 * Collects a tower's pieces and turns them into few draw calls: unique
 * pieces merge into one mesh per material (with world-projected UVs), and
 * repeated detail (columns, capitals, dentils, mullions, fins, panes) goes
 * into one InstancedMesh per part.
 */
/** Past this distance (metres from a batch's centre) a kit part draws its distant level of detail. */
export const LOD_FAR = 450;

export class Kit {
  /** Applied to everything added; builders set it to the current floor or root stage. */
  base = new THREE.Matrix4();
  /**
   * The colour of every piece added from now on, unique pieces as a vertex
   * colour and repeated parts as an instance colour: the small drift between
   * runs of floors laid in different years. Window panes never take it
   * (their instance colour is data). Variant materials read vertex colours;
   * every material that draws an instanced part reads its instance colour.
   */
  tint = new THREE.Color(1, 1, 1);
  /** High quality: kit parts carry their near level of detail too; medium draws only the distant one. */
  detail = true;
  /**
   * Materials swapped for others as pieces are added (a dark tower draws its
   * vents in `unlit` and its panes in `darkGlass`), or left out (null: a dark
   * tower's light lines). Empty for a lit tower.
   */
  remap: Partial<Record<MatKey, MatKey | null>> = {};
  private merged = new Map<MatKey, THREE.BufferGeometry[]>();
  private batches = new Map<string, Batch>();
  private geos = new Map<string, THREE.BufferGeometry>();

  constructor(readonly m: TowerMaterials) {}

  /** Adds a unique piece, placed by `local` within `base`. Takes ownership of `geo`. */
  add(mat: MatKey, geo: THREE.BufferGeometry, local?: THREE.Matrix4, projectUv = true): void {
    this.addNormalised(mat, normalise(geo, this.tint), local, projectUv);
  }

  /** The material a piece in `mat` is drawn in after the remap, or null when it is left out. */
  private resolve(mat: MatKey): MatKey | null {
    const to = this.remap[mat];
    return to === undefined ? mat : to;
  }

  private addNormalised(want: MatKey, g: THREE.BufferGeometry, local?: THREE.Matrix4, projectUv = true): void {
    const mat = this.resolve(want);
    if (mat === null) {
      g.dispose();
      return;
    }
    const m = local ? this.base.clone().multiply(local) : this.base;
    g.applyMatrix4(m);
    const tile = TILE[mat];
    if (projectUv && tile) worldUv(g, tile);
    let list = this.merged.get(mat);
    if (!list) this.merged.set(mat, (list = []));
    list.push(g);
  }

  /**
   * A weathering stain: a thin box standing 2 cm proud of a wall in `mat`,
   * darkest along its top edge (`strength` of the current tint taken off)
   * and fading to the wall's own tone at its foot, the way water and soot
   * run down from a sill or a cornice. Merges with the wall in one mesh.
   */
  stain(mat: MatKey, w: number, h: number, local: THREE.Matrix4, strength: number): void {
    const g = normalise(new THREE.BoxGeometry(w, h, 0.02), this.tint);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = g.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / h + 0.5;
      const k = 1 - strength * t * t;
      col.setXYZ(i, this.tint.r * k, this.tint.g * k, this.tint.b * k);
    }
    this.addNormalised(mat, g, local);
  }

  /** A box centred at `local`'s origin. */
  box(mat: MatKey, w: number, h: number, d: number, local: THREE.Matrix4): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), local);
  }

  /** A shared geometry by name, made once per tower. */
  geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geos.get(key);
    if (!g) this.geos.set(key, (g = make()));
    return g;
  }

  /**
   * One instance of a repeated part. `key` names the part (geometry and
   * material together). Its instance colour is `color` (white if none)
   * times the current `tint`, so repeated parts drift year to year with the
   * walls round them.
   */
  inst(key: string, mat: MatKey, make: () => THREE.BufferGeometry, local: THREE.Matrix4, color?: THREE.Color, shadow = true): void {
    this.instRaw(key, mat, make, local, (color ?? new THREE.Color(1, 1, 1)).clone().multiply(this.tint), shadow);
  }

  /**
   * One instance of a kit part with two levels of detail (kits.ts `<name>.hi`
   * and `<name>.lo`): the near one carries the relief, the far one the same
   * blocks as flat faces. At medium quality only the far one is built.
   */
  instLod(key: string, mat: MatKey, hi: () => THREE.BufferGeometry, lo: () => THREE.BufferGeometry, local: THREE.Matrix4, color?: THREE.Color): void {
    if (!this.detail) {
      this.inst(`${key}:lo`, mat, lo, local, color);
      return;
    }
    const to = this.resolve(mat);
    if (to === null) return;
    this.inst(key, mat, hi, local, color);
    const b = this.batches.get(to === mat ? key : `${key}|${to}`)!;
    b.lo ??= lo();
  }

  /** A window pane: its instance colour is data for the window shader (see paneData), so it is never tinted, and panes cast no shadow. */
  pane(key: string, mat: MatKey, local: THREE.Matrix4, data: THREE.Color): void {
    this.instRaw(key, mat, paneGeometry, local, data, false);
  }

  private instRaw(part: string, want: MatKey, make: () => THREE.BufferGeometry, local: THREE.Matrix4, color: THREE.Color, shadow: boolean): void {
    const mat = this.resolve(want);
    if (mat === null) return;
    // A remapped part batches apart from the same part in its own material.
    const key = mat === want ? part : `${part}|${mat}`;
    let b = this.batches.get(key);
    if (!b) {
      const geo = make();
      // White vertex colour, so a variant material that reads vertex colours (for the year drift) never draws a part black.
      if (!geo.attributes.color) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
      b = { mat, geo, matrices: [], colors: null, shadow };
      this.batches.set(key, b);
    }
    b.matrices.push(this.base.clone().multiply(local));
    b.colors ??= [];
    b.colors[b.matrices.length - 1] = color;
  }

  build(): THREE.Group {
    const group = new THREE.Group();
    for (const [mat, list] of this.merged) {
      const g = mergeGeometries(list, false);
      for (const piece of list) piece.dispose();
      if (!g) continue;
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.m[mat]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = `tower:${mat}`;
      group.add(mesh);
    }
    for (const [key, b] of this.batches) {
      const mesh = this.instanced(key, b, b.geo);
      if (!b.lo) {
        group.add(mesh);
        continue;
      }
      // Near and far levels share one centre (the mean of the instances), so the switch follows the part, not the tower's foot.
      const centre = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (const m of b.matrices) centre.add(p.setFromMatrixPosition(m));
      centre.divideScalar(b.matrices.length);
      const shift = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
      const far = this.instanced(`${key}:far`, b, b.lo);
      for (const m of [mesh, far]) {
        const t = new THREE.Matrix4();
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, t);
          m.setMatrixAt(i, shift.clone().multiply(t));
        }
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingBox();
        m.computeBoundingSphere();
      }
      far.castShadow = false;
      const lod = new THREE.LOD();
      lod.name = `tower:${key}:lod`;
      lod.position.copy(centre);
      lod.addLevel(mesh, 0);
      lod.addLevel(far, LOD_FAR);
      group.add(lod);
    }
    return group;
  }

  private instanced(key: string, b: Batch, geo: THREE.BufferGeometry): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, this.m[b.mat], b.matrices.length);
    b.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    if (b.colors) {
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < b.matrices.length; i++) mesh.setColorAt(i, b.colors[i] ?? white);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = true;
    mesh.name = `tower:${key}`;
    return mesh;
  }
}

// ---------------------------------------------------------------- shapes

/**
 * A moulding swept round a square plan: `profile` is a list of
 * [outward offset from `half`, height] pairs, bottom to top. Corners mitre.
 * Start and end the profile inside the wall (negative offset) to close it.
 */
export function squareSweep(half: number, profile: Array<[number, number]>): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let s = 0; s < 4; s++) {
    const r = (s * Math.PI) / 2;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    // Side s in the frame of face(s): x along the face, z outward. Rotate to world.
    const P = (u: number, y: number, z: number): number[] => [u * c + z * sn, y, -u * sn + z * c];
    for (let j = 0; j < profile.length - 1; j++) {
      const [d0, y0] = profile[j];
      const [d1, y1] = profile[j + 1];
      const h0 = half + d0;
      const h1 = half + d1;
      const a = P(-h0, y0, h0);
      const b = P(h0, y0, h0);
      const cc = P(h1, y1, h1);
      const d = P(-h1, y1, h1);
      pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A box whose top is scaled by `kTop` in x and z: a battered wall or a tapering shaft. */
export function frustum(w: number, h: number, d: number, kTop: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * kTop, p.getY(i), p.getZ(i) * kTop);
  }
  g.computeVertexNormals();
  return g;
}

/** A box whose top face slopes down toward +z (a buttress weathering), `drop` metres. */
export function wedge(w: number, h: number, d: number, drop: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0 && p.getZ(i) > 0) p.setY(i, p.getY(i) - drop);
  }
  g.computeVertexNormals();
  return g;
}

/** A turned part from a [radius, height] profile (bases, capitals, balusters). */
export function lathe(profile: Array<[number, number]>, segments = 24): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
  g.computeVertexNormals();
  return g;
}

/**
 * A fluted column shaft with entasis: `flutes` concave channels, the radius
 * swelling slightly a third of the way up and narrowing to the top. Base at y=0.
 */
export function flutedShaft(r: number, h: number, flutes = 24): THREE.BufferGeometry {
  const radial = flutes * 3;
  const g = new THREE.CylinderGeometry(1, 1, h, radial, 8, true);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const y = p.getY(i) + h / 2;
    const t = y / h;
    const a = Math.atan2(z, x);
    const entasis = 1 + 0.03 * Math.sin(Math.PI * Math.min(1, t * 1.5)) - 0.14 * t * t;
    const flute = 1 - 0.06 * Math.pow(Math.max(0, Math.cos(a * flutes)), 0.6);
    const rr = r * entasis * flute;
    p.setXYZ(i, Math.cos(a) * rr, y, Math.sin(a) * rr);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Points of a round arch opening: rectangle of width w up to the spring at ys, semicircle above. Centred on u. */
export function roundArch(u: number, w: number, y0: number, ys: number, n = 16): THREE.Vector2[] {
  const r = w / 2;
  const pts = [new THREE.Vector2(u - r, y0), new THREE.Vector2(u + r, y0)];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    pts.push(new THREE.Vector2(u + Math.cos(a) * r, ys + Math.sin(a) * r));
  }
  return pts;
}

/** Points of a pointed (equilateral) Gothic arch opening of width w, springing at ys. */
export function pointedArch(u: number, w: number, y0: number, ys: number, n = 10): THREE.Vector2[] {
  const r = w; // equilateral: each arc's radius equals the span
  const pts = [new THREE.Vector2(u - w / 2, y0), new THREE.Vector2(u + w / 2, y0)];
  const apexA = Math.acos(0.5); // 60 degrees
  // Right arc, centred on the left jamb, from the right spring up to the apex.
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * apexA;
    pts.push(new THREE.Vector2(u - w / 2 + Math.cos(a) * r, ys + Math.sin(a) * r));
  }
  // Left arc, centred on the right jamb, from the apex down to the left spring.
  for (let i = n - 1; i >= 0; i--) {
    const a = (i / n) * apexA;
    pts.push(new THREE.Vector2(u + w / 2 - Math.cos(a) * r, ys + Math.sin(a) * r));
  }
  return pts;
}

/**
 * A wall of width w and height h (x centred, y from 0) with openings cut
 * through it, extruded `depth` toward +z from z=0. Openings are point loops
 * in wall coordinates.
 */
export function piercedWall(w: number, h: number, depth: number, openings: THREE.Vector2[][]): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(-w / 2, 0),
    new THREE.Vector2(w / 2, 0),
    new THREE.Vector2(w / 2, h),
    new THREE.Vector2(-w / 2, h),
  ]);
  for (const o of openings) shape.holes.push(new THREE.Path(o));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
  return g;
}

/** A wide shallow pane geometry for instancing (1 x 1 in x and y, facing +z). */
export function paneGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1);
}

export function unitBox(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

/**
 * A tapered steel cantilever bracket, the kind that carries a floor stepped
 * out past the one below it: a plate web, full depth `depth` at the wall and
 * narrowing to a 0.3 m nose at the tip `reach` metres out, with a flat top
 * flange under the slab, a raking bottom flange that takes the thrust back
 * into the wall, and a bolted base plate. Frame: x out from the wall face
 * (the wall at x = 0), y up with the soffit at y = 0, z across the web.
 */
export function bracketGeometry(reach: number, depth: number): THREE.BufferGeometry {
  const nose = 0.3;
  const web = new THREE.ExtrudeGeometry(
    new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(reach, 0), new THREE.Vector2(reach, -nose), new THREE.Vector2(0, -depth)]),
    { depth: 0.24, bevelEnabled: false },
  );
  web.translate(0, 0, -0.12);
  const top = new THREE.BoxGeometry(reach, 0.1, 0.6);
  top.translate(reach / 2, -0.05, 0);
  // The raking flange runs along the web's lower edge, from the foot at the wall to the nose.
  const rake = Math.hypot(reach, depth - nose);
  const bottom = new THREE.BoxGeometry(rake, 0.12, 0.6);
  bottom.rotateZ(Math.atan2(depth - nose, reach));
  bottom.translate(reach / 2, -(depth + nose) / 2 - 0.03, 0);
  const plate = new THREE.BoxGeometry(0.08, depth + 0.3, 0.9);
  plate.translate(0.03, -depth / 2 + 0.05, 0);
  // A stiffener at the nose, closing the end.
  const end = new THREE.BoxGeometry(0.1, nose, 0.6);
  end.translate(reach - 0.04, -nose / 2, 0);
  const parts = [web, top, bottom, plate, end].map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    return n;
  });
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  return g;
}
