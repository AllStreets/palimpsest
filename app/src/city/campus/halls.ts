/**
 * The university's four halls (Phase 4 Task 34): collegiate gothic ranges in
 * brick with limestone dressings under steep slate roofs. Two storeys of
 * mullioned windows, pointed below and flat-headed under hood moulds above,
 * between stepped buttresses with stone weatherings; a projecting porch
 * tower with a pointed doorway and a battlemented top; coped gables with
 * kneelers and finials carrying a great traceried window; gabled stone
 * dormers in the roof; brick stacks with pots on the ridge.
 *
 * One hall is built once in a Kit; its opaque pieces are stamped by kind and
 * merged into one geometry in the campus's masonry material, and its window
 * panes kept in the tower window shader. instanceHalls then stands any
 * number of copies as one InstancedMesh of masonry and one of panes, so four
 * halls cost the calls of one. Pure three.js: tested in Node.
 */
import * as THREE from 'three';

import { Kit, M, ME, PANE_FULL, PANE_SASH, paneData, piercedWall, pointedArch, rng, wedge, type TowerMaterials } from '../tower/kit.js';
import { MAT, stampBuilt, type Panes } from './gothic.js';
import type { Kind } from './site.js';

/** A hall's plan: its length along x and its width across z, centred on its own origin, at terrace level. */
export const HALL = { length: 56, width: 16, eaves: 9.4, ridge: 18.3, wall: 0.5 } as const;

export interface HallOptions {
  quality: 'high' | 'medium';
  /** The tower materials: only `window` draws, the rest name the kinds while the Kit builds. */
  materials: TowerMaterials;
  masonry: THREE.Material;
  seed: string;
}

/** One hall as built: its masonry, and its panes' placements and light, ready to instance. */
export interface Hall {
  masonry: THREE.BufferGeometry;
  masonryMaterial: THREE.Material;
  panes: Panes;
  dispose(): void;
}

/** The outline of a flat-headed opening. */
function rect(u: number, w: number, y0: number, y1: number): THREE.Vector2[] {
  return [new THREE.Vector2(u - w / 2, y0), new THREE.Vector2(u + w / 2, y0), new THREE.Vector2(u + w / 2, y1), new THREE.Vector2(u - w / 2, y1)];
}

interface Opening {
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
}

const top = (o: Opening): number => (o.pointed ? o.y1 + o.w * Math.sin(Math.PI / 3) : o.y1);
const outline = (o: Opening): THREE.Vector2[] => (o.pointed ? pointedArch(o.u, o.w, o.y0, o.y1) : rect(o.u, o.w, o.y0, o.y1));

/**
 * The frame of a face of the hall: x along the face, y up from the terrace,
 * z out of the face, origin at the face's centre line. `side` 0 is the
 * front (+z), 1 the +x end, 2 the back, 3 the -x end.
 */
function hallFace(side: number): THREE.Matrix4 {
  const out = side % 2 === 0 ? HALL.width / 2 : HALL.length / 2;
  return M(0, 0, 0, (side * Math.PI) / 2).multiply(M(0, 0, out));
}

export function buildHall(o: HallOptions): Hall {
  const detail = o.quality === 'high';
  const rand = rng(o.seed);
  const k = new Kit(o.materials);
  k.detail = detail;
  const { length: L, width: W, eaves: E, ridge: R, wall: D } = HALL;
  const pitch = Math.atan2(R - E, W / 2);
  const light = (on = 0.82): THREE.Color => (rand() < on ? paneData(0.55 + 0.45 * rand(), 1, PANE_SASH) : paneData(0.04, 1, PANE_SASH));
  /** A piece in a kind's material; its tone drifts a touch piece by piece, as bricks fired in different years do. */
  const add = (kind: Kind, g: THREE.BufferGeometry, local?: THREE.Matrix4, drift = 0): void => {
    k.tint.setScalar(1 - drift / 2 + drift * rand());
    k.add(MAT[kind], g, local, false);
  };
  const box = (kind: Kind, w: number, h: number, d: number, local: THREE.Matrix4, drift = 0): void => add(kind, new THREE.BoxGeometry(w, h, d), local, drift);
  const pane = (F: THREE.Matrix4, u: number, y: number, w: number, h: number, z: number, data: THREE.Color): void => {
    k.pane('pane', 'window', F.clone().multiply(M(u, y, z, 0, w, h, 1)), data);
  };

  // ---------------------------------------------------------------- the walls
  const plinthH = 0.6;
  // The plinth, a limestone course standing a little proud of the brick.
  box('limestone', L + 0.3, plinthH, W + 0.3, M(0, plinthH / 2, 0));
  const wallH = E - plinthH;
  const bays = [-22.4, -16.8, -11.2, -5.6, 0, 5.6, 11.2, 16.8, 22.4];
  const ground = (u: number): Opening => ({ u, w: 2.2, y0: 1.3, y1: 3.7, pointed: true, lights: 2, transom: 3.7 });
  const upper = (u: number): Opening => ({ u, w: 2.0, y0: 6.5, y1: 8.7, pointed: false, lights: 2 });
  const stringY = 5.95;

  /** A face's wall with its openings, the panes behind them, their sills, mullions, transoms and hood moulds. */
  const wallWith = (side: number, width: number, openings: Opening[]): void => {
    const F = hallFace(side);
    // Opening coordinates are from the terrace; the wall starts at the plinth.
    const holes = openings.map((op) => outline({ ...op, y0: op.y0 - plinthH, y1: op.y1 - plinthH }));
    add('brick', piercedWall(width, wallH, D, holes), F.clone().multiply(M(0, plinthH, -D)), 0.06);
    for (const op of openings) {
      const t = top(op);
      pane(F, op.u, (op.y0 + t) / 2, op.w + 0.2, t - op.y0 + 0.1, -D - 0.05, light());
      // Sill, mullions and transom in limestone, set in the reveal.
      box('limestone', op.w + 0.36, 0.16, 0.34, F.clone().multiply(M(op.u, op.y0 - 0.08, -0.02)));
      for (let i = 1; i < op.lights; i++) {
        const mu = op.u - op.w / 2 + (op.w * i) / op.lights;
        box('limestone', 0.15, t - op.y0, 0.28, F.clone().multiply(M(mu, (op.y0 + t) / 2, -D / 2)));
      }
      if (op.transom !== undefined) box('limestone', op.w, 0.14, 0.28, F.clone().multiply(M(op.u, op.transom, -D / 2)));
      if (op.pointed) {
        if (detail) {
          // A hood mould following the arch, a stone band standing proud of the brick.
          const band = new THREE.Shape(pointedArch(0, op.w + 0.5, op.y1 - 0.6, op.y1));
          band.holes.push(new THREE.Path(pointedArch(0, op.w + 0.02, op.y1 - 0.58, op.y1)));
          add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(op.u, 0, 0.0)));
        }
      } else {
        // A label mould over a flat head, with its returns.
        box('limestone', op.w + 0.6, 0.16, 0.14, F.clone().multiply(M(op.u, t + 0.18, 0.07)));
      }
    }
  };

  // Front and back: the bays either side of the porch, the porch bay itself only on the back.
  wallWith(0, L, [...bays.filter((u) => u !== 0).map(ground), ...bays.map(upper)]);
  wallWith(2, L, [...bays.map(ground), ...bays.map(upper)]);
  // The gable ends: a great traceried window of four lights with a transom, two small ground windows beside it.
  const great: Opening = { u: 0, w: 4.4, y0: 1.3, y1: 5.3, pointed: true, lights: 4, transom: 4.4 };
  const flank = (u: number): Opening => ({ u, w: 1.4, y0: 1.3, y1: 3.2, pointed: true, lights: 1 });
  for (const side of [1, 3]) wallWith(side, W - 2 * D, [great, flank(-5.4), flank(5.4)]);
  // A string course between the storeys, round the whole hall.
  for (const side of [0, 2]) box('limestone', L + 0.24, 0.24, 0.24, hallFace(side).multiply(M(0, stringY, 0.0)));
  for (const side of [1, 3]) box('limestone', W + 0.24, 0.24, 0.24, hallFace(side).multiply(M(0, stringY, 0.0)));

  // ---------------------------------------------------------------- buttresses
  /**
   * A buttress on a face frame at u: a limestone base block, then three
   * brick stages each set back and narrower than the one below, each under
   * a steep limestone weathering with a drip standing proud of the stage.
   */
  const buttress = (F: THREE.Matrix4, u: number): void => {
    const stages: Array<[number, number, number, number]> = [
      [plinthH, 3.3, 1.15, 1.36],
      [3.3, 6.3, 0.82, 1.2],
      [6.3, 8.75, 0.5, 1.04],
    ];
    add('limestone', new THREE.BoxGeometry(1.5, plinthH, 1.3), F.clone().multiply(M(u, plinthH / 2, 0.65)));
    for (const [y0, y1, d, w] of stages) {
      const drop = Math.min(0.7, d * 0.75);
      const h = y1 - y0 - drop;
      add('brick', wedge(w, h + drop, d, drop), F.clone().multiply(M(u, y0 + (h + drop) / 2, d / 2)), 0.04);
      // The weathering: a steep limestone slab with a drip, overhanging the stage by a hand.
      add('limestone', wedge(w + 0.12, drop + 0.14, d + 0.1, drop), F.clone().multiply(M(u, y1 - (drop + 0.14) / 2 + 0.1, d / 2 + 0.05)));
      add('limestone', new THREE.BoxGeometry(w + 0.12, 0.1, 0.14), F.clone().multiply(M(u, y1 - drop + 0.02, d + 0.08)));
    }
  };
  for (const side of [0, 2]) for (const u of [-19.6, -8.4, 8.4, 19.6]) buttress(hallFace(side), u);
  // Angle buttresses at the corners, set diagonally.
  for (let c = 0; c < 4; c++) {
    const sx = c < 2 ? 1 : -1;
    const sz = c % 2 === 0 ? 1 : -1;
    const C = M(sx * (L / 2 - 0.35), 0, sz * (W / 2 - 0.35), Math.atan2(sx, sz));
    buttress(C, 0);
  }

  // ---------------------------------------------------------------- the porch tower
  const PW = 6.0;
  const PD = 3.0;
  const PH = 14.0;
  const P = hallFace(0).multiply(M(0, 0, PD));
  const door: Opening = { u: 0, w: 2.4, y0: plinthH, y1: 2.6, pointed: true, lights: 1 };
  const porchWin: Opening = { u: 0, w: 1.8, y0: 6.6, y1: 8.6, pointed: true, lights: 2 };
  const porchLoop: Opening = { u: 0, w: 1.2, y0: 11.2, y1: 12.3, pointed: false, lights: 1 };
  {
    const holes = [door, porchWin, porchLoop].map((op) => outline({ ...op, y0: op.y0 - plinthH, y1: op.y1 - plinthH }));
    add('brick', piercedWall(PW, PH - plinthH, D, holes), P.clone().multiply(M(0, plinthH, -D)), 0.03);
    box('limestone', PW + 0.3, plinthH, PD + 0.15, M(0, plinthH / 2, W / 2 + PD / 2 + 0.05));
    // Its sides, solid brick, and its flat roof behind the parapet.
    for (const s of [-1, 1]) box('brick', D, PH - plinthH, PD - D, M(s * (PW / 2 - D / 2), plinthH + (PH - plinthH) / 2, W / 2 + (PD - D) / 2), 0.03);
    box('slate', PW - 2 * D, 0.2, PD - D, M(0, PH - 0.4, W / 2 + (PD - D) / 2));
    // The doorway: lit doors deep in the arch, under three orders of moulding.
    pane(P, 0, (door.y0 + top(door)) / 2, door.w + 0.2, top(door) - door.y0 + 0.1, -D - 0.05, paneData(0.9, 1, PANE_FULL));
    for (let i = 0; i < 3; i++) {
      const inner = door.w + i * 0.44;
      const band = new THREE.Shape(pointedArch(0, inner + 0.36, door.y0 - plinthH, door.y1 - plinthH));
      band.holes.push(new THREE.Path(pointedArch(0, inner, door.y0 - plinthH + 0.01, door.y1 - plinthH)));
      add('limestone', new THREE.ExtrudeGeometry(band, { depth: 0.1 + i * 0.1, bevelEnabled: false, curveSegments: 10 }), P.clone().multiply(M(0, plinthH, 0)));
    }
    pane(P, 0, (porchWin.y0 + top(porchWin)) / 2, porchWin.w + 0.2, top(porchWin) - porchWin.y0 + 0.1, -D - 0.05, light());
    box('limestone', 0.15, top(porchWin) - porchWin.y0, 0.28, P.clone().multiply(M(0, (porchWin.y0 + top(porchWin)) / 2, -D / 2)));
    box('limestone', porchWin.w + 0.36, 0.16, 0.34, P.clone().multiply(M(0, porchWin.y0 - 0.08, -0.02)));
    pane(P, 0, (porchLoop.y0 + porchLoop.y1) / 2, porchLoop.w + 0.2, porchLoop.y1 - porchLoop.y0 + 0.1, -D - 0.05, light(0.5));
    // A limestone string under the parapet, then the battlements: merlons on a coping, front and sides.
    box('limestone', PW + 0.3, 0.2, 0.2, P.clone().multiply(M(0, PH - 1.2, 0.05)));
    box('limestone', PW + 0.2, 0.22, 0.2, P.clone().multiply(M(0, PH - 0.11, 0.0)));
    for (const s of [-1, 1]) box('limestone', 0.2, 0.22, PD + 0.1, M(s * (PW / 2 + 0.0), PH - 0.11, W / 2 + PD / 2));
    const merlon = (x: number, z: number, w: number, d: number): void => box('limestone', w, 0.7, d, M(x, PH + 0.35, z));
    for (const x of [-2.4, -1.2, 0, 1.2, 2.4]) merlon(x, W / 2 + PD - 0.12, 0.6, 0.24);
    for (const s of [-1, 1]) for (const z of [0.6, 1.8]) merlon(s * (PW / 2 - 0.12), W / 2 + z, 0.24, 0.6);
    // The porch's own angle buttresses.
    for (const s of [-1, 1]) buttress(P, s * (PW / 2 - 0.65));
  }

  // ---------------------------------------------------------------- the roof
  const slope = Math.hypot(W / 2, R - E);
  const overhang = 0.45;
  const roofLen = L - 2 * D;
  for (const s of [-1, 1]) {
    // Each slope a slab from the eaves (overhanging) to the ridge, set so its top face meets the ridge line.
    const len = slope + overhang;
    const mid = len / 2 - overhang;
    const cz = s * (W / 2 - mid * Math.cos(pitch));
    const cy = E + mid * Math.sin(pitch);
    add('slate', new THREE.BoxGeometry(roofLen, 0.22, len), ME(0, cy - 0.06, cz, s * pitch, 0, 0));
    // The eaves: a limestone corbel course under the slates.
    box('limestone', L + 0.4, 0.32, 0.5, M(0, E - 0.16, s * (W / 2 + 0.05)));
  }
  // The ridge, in a darker lead-grey slate.
  box('slate', roofLen, 0.28, 0.5, M(0, R + 0.02, 0));

  // Gables: a brick triangle over each end wall, carrying a lancet, coped in limestone with kneelers and a finial.
  for (const side of [1, 3]) {
    const F = hallFace(side);
    const gable = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, R - E)]);
    const lancet: Opening = { u: 0, w: 1.0, y0: E + 1.4, y1: E + 3.2, pointed: true, lights: 1 };
    gable.holes.push(new THREE.Path(outline({ ...lancet, y0: lancet.y0 - E, y1: lancet.y1 - E })));
    add('brick', new THREE.ExtrudeGeometry(gable, { depth: D, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(0, E, -D)), 0.04);
    pane(F, 0, (lancet.y0 + top(lancet)) / 2, lancet.w + 0.2, top(lancet) - lancet.y0 + 0.1, -D - 0.05, light(0.6));
    box('limestone', lancet.w + 0.36, 0.14, 0.3, F.clone().multiply(M(0, lancet.y0 - 0.07, 0)));
    // The coping up each rake.
    const rake = Math.hypot(W / 2 + 0.3, R - E + 0.3);
    for (const s of [-1, 1]) {
      const ang = Math.atan2(R - E + 0.3, W / 2 + 0.3);
      // In the face frame x runs along the face: the rake climbs from u = s * (W/2 + 0.3) to the apex.
      add('limestone', new THREE.BoxGeometry(rake, 0.3, 0.7).rotateZ(-s * ang).translate((s * (W / 2 + 0.3)) / 2, E + (R - E + 0.3) / 2 + 0.1, 0), F.clone().multiply(M(0, 0, -D / 2)));
      // Kneelers at the foot of each rake.
      box('limestone', 0.9, 0.8, 0.8, F.clone().multiply(M(s * (W / 2 + 0.1), E + 0.3, -D / 2)));
    }
    // The finial at the apex: a shaft and a pointed cap.
    box('limestone', 0.5, 1.3, 0.5, F.clone().multiply(M(0, R + 0.75, -D / 2)));
    add('limestone', new THREE.ConeGeometry(0.42, 1.3, 4).rotateY(Math.PI / 4), F.clone().multiply(M(0, R + 1.4 + 0.65, -D / 2)));
    if (detail) add('limestone', new THREE.SphereGeometry(0.17, 8, 6), F.clone().multiply(M(0, R + 2.75, -D / 2)));
  }

  // Dormers: gabled, stone-faced, four to a slope, each with a small pointed window under its own slated gable.
  for (const s of [-1, 1]) {
    const F = hallFace(s === 1 ? 0 : 2);
    for (const u of [-19.6, -8.4, 8.4, 19.6]) {
      const inset = 1.3;
      const baseY = E + inset * Math.tan(pitch) - 0.9;
      const dw = 2.2;
      const dh = 3.1;
      const dd = 1.9;
      const win: Opening = { u, w: 1.1, y0: baseY + 0.9, y1: baseY + 2.2, pointed: true, lights: 1 };
      const faceShape = new THREE.Shape([new THREE.Vector2(-dw / 2, 0), new THREE.Vector2(dw / 2, 0), new THREE.Vector2(dw / 2, dh - 0.9), new THREE.Vector2(0, dh), new THREE.Vector2(-dw / 2, dh - 0.9)]);
      faceShape.holes.push(new THREE.Path(outline({ ...win, u: 0, y0: win.y0 - baseY, y1: win.y1 - baseY })));
      add('limestone', new THREE.ExtrudeGeometry(faceShape, { depth: dd, bevelEnabled: false, curveSegments: 8 }), F.clone().multiply(M(u, baseY, -inset - dd)));
      pane(F, u, (win.y0 + top(win)) / 2, win.w + 0.2, top(win) - win.y0 + 0.1, -inset - 0.3, light(0.7));
      // Its little roof: two slated slopes over the gable.
      const rl = Math.hypot(dw / 2 + 0.2, 0.9 + 0.1);
      const ra = Math.atan2(1.0, dw / 2 + 0.2);
      for (const t of [-1, 1]) add('slate', new THREE.BoxGeometry(rl, 0.12, dd + 0.3).rotateZ(-t * ra).translate((t * (dw / 2 + 0.2)) / 2, dh - 0.9 + 0.5 + 0.06, 0), F.clone().multiply(M(u, baseY, -inset - dd / 2 - 0.05)));
    }
  }

  // Chimneys: two brick stacks through the ridge, a limestone cap band, slate pots at high quality.
  for (const u of [-14, 14]) {
    box('brick', 2.4, 6.0, 1.3, M(u, R - 1.0 + 3.0 - 1.0, 0), 0.03);
    box('limestone', 2.7, 0.3, 1.6, M(u, R + 3.0 + 0.15, 0));
    if (detail) for (const s of [-1, 1]) add('slate', new THREE.CylinderGeometry(0.26, 0.3, 0.9, 10), M(u + s * 0.65, R + 3.3 + 0.45, 0));
  }

  // ---------------------------------------------------------------- stamp and merge
  const { masonry, panes } = stampBuilt(k.build(), o.materials.window);
  return {
    masonry,
    masonryMaterial: o.masonry,
    panes,
    dispose() {
      masonry.dispose();
      panes.geometry.dispose();
    },
  };
}

/**
 * The halls stood at `placements` (each a hall's own origin on the terrace):
 * one draw of masonry, one of panes, whatever their number. `extra` panes
 * (the library's and the tower's, already in the campus frame) ride in the
 * same pane draw.
 */
export function instanceHalls(hall: Hall, placements: THREE.Matrix4[], tints?: THREE.Color[], extra?: Pick<Panes, 'matrices' | 'colours'>): { group: THREE.Group; masonry: THREE.InstancedMesh; panes: THREE.InstancedMesh; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'halls';
  const masonry = new THREE.InstancedMesh(hall.masonry, hall.masonryMaterial, placements.length);
  placements.forEach((p, i) => {
    masonry.setMatrixAt(i, p);
    masonry.setColorAt(i, tints?.[i] ?? new THREE.Color(1, 1, 1));
  });
  masonry.instanceMatrix.needsUpdate = true;
  if (masonry.instanceColor) masonry.instanceColor.needsUpdate = true;
  masonry.castShadow = masonry.receiveShadow = true;
  masonry.name = 'campus:halls';
  masonry.computeBoundingBox();
  masonry.computeBoundingSphere();
  const n = hall.panes.matrices.length;
  const extraN = extra?.matrices.length ?? 0;
  const total = n * placements.length + extraN;
  const panes = new THREE.InstancedMesh(hall.panes.geometry, hall.panes.material, Math.max(1, total));
  const m = new THREE.Matrix4();
  placements.forEach((p, i) => {
    hall.panes.matrices.forEach((local, j) => {
      panes.setMatrixAt(i * n + j, m.copy(p).multiply(local));
      panes.setColorAt(i * n + j, hall.panes.colours[j]);
    });
  });
  extra?.matrices.forEach((mat, j) => {
    panes.setMatrixAt(n * placements.length + j, mat);
    panes.setColorAt(n * placements.length + j, extra.colours[j]);
  });
  if (total === 0) panes.count = 0;
  panes.instanceMatrix.needsUpdate = true;
  if (panes.instanceColor) panes.instanceColor.needsUpdate = true;
  panes.castShadow = false;
  panes.receiveShadow = true;
  panes.name = 'campus:panes';
  panes.computeBoundingBox();
  panes.computeBoundingSphere();
  group.add(masonry, panes);
  return {
    group,
    masonry,
    panes,
    dispose() {
      masonry.dispose();
      panes.dispose();
    },
  };
}
