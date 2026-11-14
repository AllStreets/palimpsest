/**
 * The campus's collegiate gothic, shared by the halls, the library and the
 * clock tower (Phase 4 Tasks 34 and 35): openings with pointed or flat heads,
 * walls pierced for them with their panes, sills, mullions, transoms and
 * hood moulds, stepped buttresses under limestone weatherings, and the
 * stamping of a built Kit into the campus's one masonry geometry.
 *
 * Everything is built in a Kit whose materials only name the kinds; the
 * stamped pieces are merged into the site's draw and the panes kept for the
 * window shader. Pure three.js: tested in Node.
 */
import * as THREE from 'three';

import { Kit, M, PANE_SASH, paneData, paneGeometry, piercedWall, pointedArch, wedge, type MatKey } from '../tower/kit.js';
import { mergeStamped, stamp, type Kind } from './site.js';

/** The Kit material each kind is built in; the stamped geometry carries the kind, not the material. */
export const MAT: Record<Kind, MatKey> = { brick: 'brickWall', limestone: 'limestone', slate: 'roofTile', ashlar: 'granite', turf: 'sand', gravel: 'slab', lamp: 'lightLine', dial: 'datum', louvre: 'timber', gilt: 'accent', yew: 'travertine', copper: 'graphite', paint: 'plaster', brass: 'steel', glow: 'gothic', line: 'earnedLine' };
const KIND_OF: Partial<Record<string, Kind>> = Object.fromEntries(Object.entries(MAT).map(([k, m]) => [`tower:${m}`, k as Kind]));

/** The outline of a flat-headed opening. */
export function rect(u: number, w: number, y0: number, y1: number): THREE.Vector2[] {
  return [new THREE.Vector2(u - w / 2, y0), new THREE.Vector2(u + w / 2, y0), new THREE.Vector2(u + w / 2, y1), new THREE.Vector2(u - w / 2, y1)];
}

/** A round opening (a rose or an oculus), as a point loop. */
export function circle(u: number, y: number, r: number, n = 28): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) out.push(new THREE.Vector2(u + Math.cos((i / n) * Math.PI * 2) * r, y + Math.sin((i / n) * Math.PI * 2) * r));
  return out;
}

export interface Opening {
  u: number;
  w: number;
  y0: number;
  /** The spring of a pointed head, or the top of a flat one. */
  y1: number;
  pointed: boolean;
  /** How many lights the mullions divide it into. */
  lights: number;
  /** A transom across it at this height, if any. */
  transom?: number;
  /** How lit the room behind it is likely to be (the chance a pane is lit). */
  lit?: number;
}

export const top = (o: Opening): number => (o.pointed ? o.y1 + o.w * Math.sin(Math.PI / 3) : o.y1);
export const outline = (o: Opening): THREE.Vector2[] => (o.pointed ? pointedArch(o.u, o.w, o.y0, o.y1) : rect(o.u, o.w, o.y0, o.y1));

/** The panes a built Kit carried, as placements and data for one shared pane geometry. */
export interface Panes {
  geometry: THREE.BufferGeometry;
  matrices: THREE.Matrix4[];
  colours: THREE.Color[];
  material: THREE.Material;
}

/**
 * A built Kit taken apart: every piece in a kind's material stamped (its
 * tint multiplied in) and merged into one masonry geometry, its panes'
 * placements and light kept for instancing. Disposes the Kit's meshes.
 */
export function stampBuilt(built: THREE.Group, windowMaterial: THREE.Material): { masonry: THREE.BufferGeometry; panes: Panes } {
  const pieces: THREE.BufferGeometry[] = [];
  let panes: Panes | null = null;
  for (const child of built.children) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) continue;
    const kind = KIND_OF[mesh.name];
    if (kind) {
      // The Kit tinted every vertex by its drift; the kind's tone multiplies in.
      const g = mesh.geometry;
      const drift = g.attributes.color as THREE.BufferAttribute;
      const tints = Float32Array.from(drift.array as Float32Array);
      stamp(g, kind);
      const col = g.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * tints[i * 3], col.getY(i) * tints[i * 3 + 1], col.getZ(i) * tints[i * 3 + 2]);
      pieces.push(g);
    } else if (mesh.name === 'tower:pane') {
      const im = mesh as THREE.InstancedMesh;
      const matrices: THREE.Matrix4[] = [];
      const colours: THREE.Color[] = [];
      for (let i = 0; i < im.count; i++) {
        const m = new THREE.Matrix4();
        im.getMatrixAt(i, m);
        matrices.push(m);
        const c = new THREE.Color();
        im.getColorAt(i, c);
        colours.push(c);
      }
      panes = { geometry: im.geometry, matrices, colours, material: im.material as THREE.Material };
      im.dispose();
    }
  }
  if (!panes) panes = { geometry: paneGeometry(), matrices: [], colours: [], material: windowMaterial };
  return { masonry: mergeStamped(pieces), panes };
}

/** A buttress's stages, bottom to top: [y0, y1, depth out from the wall, width]. */
export type Stages = Array<[number, number, number, number]>;

/** The gothic builder over a Kit: pieces by kind, with the year-to-year drift of their tone. */
export class Gothic {
  constructor(
    readonly k: Kit,
    readonly rand: () => number,
    readonly detail: boolean,
  ) {}

  /** A piece in a kind's material; its tone drifts a touch piece by piece, as bricks fired in different years do. */
  add(kind: Kind, g: THREE.BufferGeometry, local?: THREE.Matrix4, drift = 0): void {
    this.k.tint.setScalar(1 - drift / 2 + drift * this.rand());
    this.k.add(MAT[kind], g, local, false);
  }

  box(kind: Kind, w: number, h: number, d: number, local: THREE.Matrix4, drift = 0): void {
    this.add(kind, new THREE.BoxGeometry(w, h, d), local, drift);
  }

  /** A pane in the window shader at (u, y) on the face frame F, `z` out of the face, `data` its light (kit.ts paneData). */
  pane(F: THREE.Matrix4, u: number, y: number, w: number, h: number, z: number, data: THREE.Color): void {
    this.k.pane('pane', 'window', F.clone().multiply(M(u, y, z, 0, w, h, 1)), data);
  }

  /** A window's light: lit with chance `on`, else nearly dark. */
  light(on = 0.82): THREE.Color {
    return this.rand() < on ? paneData(0.55 + 0.45 * this.rand(), 1, PANE_SASH) : paneData(0.04, 1, PANE_SASH);
  }

  /**
   * A face's brick wall `width` wide and `wallH` tall standing on a plinth
   * `plinthH` high, `D` thick behind the frame F, pierced for `openings`
   * (their heights from the ground), each glazed, with a limestone sill,
   * its mullions and transom, a hood mould over a pointed head (at high
   * quality) and a label mould over a flat one.
   */
  wall(F: THREE.Matrix4, width: number, plinthH: number, wallH: number, D: number, openings: Opening[], drift = 0.06): void {
    const holes = openings.map((op) => outline({ ...op, y0: op.y0 - plinthH, y1: op.y1 - plinthH }));
    this.add('brick', piercedWall(width, wallH, D, holes), F.clone().multiply(M(0, plinthH, -D)), drift);
    for (const op of openings) this.dress(F, op, D);
  }

  /** An opening's pane and its dressings (the wall round it already cut). */
  dress(F: THREE.Matrix4, op: Opening, D: number): void {
    const t = top(op);
    this.pane(F, op.u, (op.y0 + t) / 2, op.w + 0.2, t - op.y0 + 0.1, -D - 0.05, this.light(op.lit));
    this.box('limestone', op.w + 0.36, 0.16, 0.34, F.clone().multiply(M(op.u, op.y0 - 0.08, -0.02)));
    for (let i = 1; i < op.lights; i++) {
      const mu = op.u - op.w / 2 + (op.w * i) / op.lights;
      this.box('limestone', 0.15, t - op.y0, 0.28, F.clone().multiply(M(mu, (op.y0 + t) / 2, -D / 2)));
    }
    if (op.transom !== undefined) this.box('limestone', op.w, 0.14, 0.28, F.clone().multiply(M(op.u, op.transom, -D / 2)));
    if (op.pointed) {
      if (this.detail) {
        const band = new THREE.Shape(pointedArch(0, op.w + 0.5, op.y1 - 0.6, op.y1));
        band.holes.push(new THREE.Path(pointedArch(0, op.w + 0.02, op.y1 - 0.58, op.y1)));
        this.add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(op.u, 0, 0.0)));
      }
    } else {
      this.box('limestone', op.w + 0.6, 0.16, 0.14, F.clone().multiply(M(op.u, t + 0.18, 0.07)));
    }
  }

  /**
   * A buttress on the face frame F at u: a limestone base block under the
   * first stage, then brick stages each set back and narrower than the one
   * below, each under a steep limestone weathering with a drip.
   */
  buttress(F: THREE.Matrix4, u: number, stages: Stages, plinthH: number): void {
    const [, , d0, w0] = stages[0];
    this.add('limestone', new THREE.BoxGeometry(w0 + 0.14, plinthH, d0), F.clone().multiply(M(u, plinthH / 2, d0 / 2)));
    for (const [y0, y1, d, w] of stages) {
      const drop = Math.min(0.7, d * 0.75);
      const h = y1 - y0 - drop;
      this.add('brick', wedge(w, h + drop, d, drop), F.clone().multiply(M(u, y0 + (h + drop) / 2, d / 2)), 0.04);
      this.add('limestone', wedge(w + 0.12, drop + 0.14, d + 0.1, drop), F.clone().multiply(M(u, y1 - (drop + 0.14) / 2 + 0.1, d / 2 + 0.05)));
      this.add('limestone', new THREE.BoxGeometry(w + 0.12, 0.1, 0.14), F.clone().multiply(M(u, y1 - drop + 0.02, d + 0.08)));
    }
  }

  /**
   * A coped gable on the face frame F: a brick triangle `w` wide rising
   * `rise` from `y`, `D` thick, pierced for `openings`; limestone coping up
   * each rake, kneelers at their feet, a finial at the apex.
   */
  gable(F: THREE.Matrix4, w: number, y: number, rise: number, D: number, openings: Opening[]): void {
    const shape = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, rise)]);
    for (const op of openings) shape.holes.push(new THREE.Path(outline({ ...op, y0: op.y0 - y, y1: op.y1 - y })));
    this.add('brick', new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(0, y, -D)), 0.04);
    for (const op of openings) {
      const t = top(op);
      this.pane(F, op.u, (op.y0 + t) / 2, op.w + 0.2, t - op.y0 + 0.1, -D - 0.05, this.light(op.lit ?? 0.6));
      this.box('limestone', op.w + 0.36, 0.14, 0.3, F.clone().multiply(M(op.u, op.y0 - 0.07, 0)));
    }
    const rake = Math.hypot(w / 2 + 0.3, rise + 0.3);
    const ang = Math.atan2(rise + 0.3, w / 2 + 0.3);
    for (const s of [-1, 1]) {
      this.add('limestone', new THREE.BoxGeometry(rake, 0.3, 0.7).rotateZ(-s * ang).translate((s * (w / 2 + 0.3)) / 2, y + (rise + 0.3) / 2 + 0.1, 0), F.clone().multiply(M(0, 0, -D / 2)));
      this.box('limestone', 0.9, 0.8, 0.8, F.clone().multiply(M(s * (w / 2 + 0.1), y + 0.3, -D / 2)));
    }
    this.finial(F.clone().multiply(M(0, y + rise, -D / 2)), 0.5);
  }

  /** A finial on the frame F: a square shaft and a pointed cap, a ball on it at high quality. */
  finial(F: THREE.Matrix4, w: number): void {
    this.box('limestone', w, 2.6 * w, w, F.clone().multiply(M(0, 1.3 * w, 0)));
    this.add('limestone', new THREE.ConeGeometry(0.84 * w, 2.6 * w, 4).rotateY(Math.PI / 4), F.clone().multiply(M(0, 2.6 * w + 1.3 * w, 0)));
    if (this.detail) this.add('limestone', new THREE.SphereGeometry(0.34 * w, 8, 6), F.clone().multiply(M(0, 5.5 * w, 0)));
  }

  /**
   * A pointed doorway on the face frame F at u: lit doors deep in the arch
   * under `orders` orders of limestone moulding standing proud of the wall.
   */
  doorway(F: THREE.Matrix4, door: Opening, D: number, plinthH: number, orders = 3): void {
    const t = top(door);
    this.pane(F, door.u, (door.y0 + t) / 2, door.w + 0.2, t - door.y0 + 0.1, -D - 0.05, paneData(0.9, 1, 0));
    for (let i = 0; i < orders; i++) {
      const inner = door.w + i * 0.44;
      const band = new THREE.Shape(pointedArch(0, inner + 0.36, door.y0 - plinthH, door.y1 - plinthH));
      band.holes.push(new THREE.Path(pointedArch(0, inner, door.y0 - plinthH + 0.01, door.y1 - plinthH)));
      this.add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1 + i * 0.1, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(door.u, plinthH, 0)));
    }
  }
}
