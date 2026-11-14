/**
 * The university's library (Phase 4 Task 35): a collegiate gothic reading
 * room closing the axis at the far end of the inner quad. One tall storey
 * of traceried windows between stepped buttresses under a steep slate roof,
 * on a limestone podium; a projecting frontispiece on the axis with a
 * pointed doorway under three orders of moulding, a great five-light window
 * over it and a coped gable between two octagonal stair turrets that rise
 * past the ridge to pinnacled caps; great gable windows with a rose over
 * them at either end; an octagonal lantern on the ridge, glazed and lit,
 * under a slated spirelet.
 *
 * Built in the caller's Kit by the campus's gothic (gothic.ts) and stamped
 * into the site's one masonry draw; its panes ride in the halls' pane draw.
 * Local frame: origin at the library's anchor on the terrace, +x toward the
 * gate (its front), the length along z. Pure three.js: tested in Node.
 *
 * The reading room's bays are built dark (Task 37): the campus's life lights
 * one per genome racing while a voyage sails, through the panes' instance
 * colours, and the great windows at either end and the lantern with them.
 * makeLibrary answers where those panes stand so the campus can find them.
 */
import * as THREE from 'three';

import { Kit, M, ME, paneData, PANE_SASH, piercedWall, pointedArch, rng } from '../tower/kit.js';
import { circle, Gothic, top, type Opening, type Stages } from './gothic.js';

/** The library's plan: its length along z, its width across x, its floor over the terrace, eaves and ridge. */
export const LIBRARY = { length: 54, width: 18, podium: 1.2, eaves: 12.5, ridge: 22.5, wall: 0.55 } as const;

export interface LibraryOptions {
  quality: 'high' | 'medium';
  seed?: string;
}

/** The light the reading room's panes carry when nothing sails: dark glass, in the window shader's own terms. */
export const BAY_DARK = 0.04;
/** The lantern's lights when the room is dark: a night light on the ridge. */
export const LANTERN_IDLE = 0.3;

/**
 * Where the library's lit panes stand, in the Kit's frame (its base applied):
 * the reading-room bays along the long walls (the front's first, nearest the
 * frontispiece outward, then the back's), the great windows of the gable
 * ends and the lantern's lights.
 */
export interface LibraryLights {
  bays: THREE.Vector3[];
  ends: THREE.Vector3[];
  lantern: THREE.Vector3[];
}

/**
 * The frame of a face: x along the face, y up from the terrace, z out of
 * the face, origin at the face's centre line on the ground. `side` 0 is the
 * front (+x), 1 the +z end, 2 the back (-x), 3 the -z end.
 */
function libraryFace(side: number, out?: number): THREE.Matrix4 {
  const o = out ?? (side % 2 === 0 ? LIBRARY.width / 2 : LIBRARY.length / 2);
  return M(0, 0, 0, Math.PI / 2 - (side * Math.PI) / 2).multiply(M(0, 0, o));
}

export function makeLibrary(k: Kit, o: LibraryOptions): LibraryLights {
  const detail = o.quality === 'high';
  const g = new Gothic(k, rng(o.seed ?? 'library'), detail);
  const { length: L, width: W, podium: P, eaves: E, ridge: R, wall: D } = LIBRARY;
  const pitch = Math.atan2(R - E, W / 2);
  const lights: LibraryLights = { bays: [], ends: [], lantern: [] };
  /** Where an opening's pane stands (gothic.ts dress), in the Kit's frame. */
  const paneAt = (F: THREE.Matrix4, op: Opening, z = -D - 0.05): THREE.Vector3 => new THREE.Vector3().applyMatrix4(k.base.clone().multiply(F).multiply(M(op.u, (op.y0 + top(op)) / 2, z)));

  // ---------------------------------------------------------------- the podium
  // A limestone podium the floor stands on, a plinth course proud of the brick above it.
  g.box('limestone', W + 1.0, P, L + 1.0, M(0, P / 2, 0));
  g.box('limestone', W + 0.4, 0.5, L + 0.4, M(0, P + 0.25, 0));
  const plinthH = P + 0.5;

  // ---------------------------------------------------------------- the long walls
  const wallH = E - plinthH;
  // Dark until a voyage sails: the campus's life lights the bays.
  const bayWin = (u: number): Opening => ({ u, w: 3.0, y0: P + 1.7, y1: P + 7.6, pointed: true, lights: 3, transom: P + 5.0, lit: BAY_DARK });
  const stages: Stages = [
    [plinthH, P + 4.6, 1.35, 1.5],
    [P + 4.6, P + 8.4, 0.95, 1.3],
    [P + 8.4, E - 0.5, 0.55, 1.1],
  ];
  // The front: bays either side of the frontispiece; the back: every bay.
  const front = libraryFace(0);
  const back = libraryFace(2);
  const frontBays = [-9, 9, -15, 15, -21, 21].map(bayWin);
  const backBays = [-3, 3, -9, 9, -15, 15, -21, 21].map(bayWin);
  g.wall(front, L, plinthH, wallH, D, frontBays);
  g.wall(back, L, plinthH, wallH, D, backBays);
  for (const op of frontBays) lights.bays.push(paneAt(front, op));
  for (const op of backBays) lights.bays.push(paneAt(back, op));
  for (const u of [-18, -12, 12, 18]) g.buttress(front, u, stages, plinthH);
  for (const u of [-18, -12, -6, 0, 6, 12, 18]) g.buttress(back, u, stages, plinthH);
  // Angle buttresses at the corners.
  for (let c = 0; c < 4; c++) {
    const sx = c < 2 ? 1 : -1;
    const sz = c % 2 === 0 ? 1 : -1;
    g.buttress(M(sx * (W / 2 - 0.35), 0, sz * (L / 2 - 0.35), Math.atan2(sx, sz)), 0, stages, plinthH);
  }
  // A string course under the sills and a corbel course at the eaves, round the whole room.
  for (const side of [0, 1, 2, 3]) {
    const F = libraryFace(side);
    const w = side % 2 === 0 ? L : W;
    g.box('limestone', w + 0.3, 0.22, 0.22, F.clone().multiply(M(0, P + 1.5, 0.0)));
    g.box('limestone', w + 0.5, 0.36, 0.5, F.clone().multiply(M(0, E - 0.18, 0.05)));
  }

  // ---------------------------------------------------------------- the gable ends
  for (const side of [1, 3]) {
    const F = libraryFace(side);
    const great: Opening = { u: 0, w: 6.0, y0: P + 1.7, y1: P + 8.6, pointed: true, lights: 5, transom: P + 5.6, lit: BAY_DARK };
    const flank = (u: number): Opening => ({ u, w: 1.3, y0: P + 1.7, y1: P + 4.6, pointed: true, lights: 1, lit: 0.7 });
    g.wall(F, W - 2 * D, plinthH, wallH, D, [great, flank(-6.3), flank(6.3)]);
    lights.ends.push(paneAt(F, great));
    // The gable over it with a rose, coped, kneelers at the feet of the rakes, a finial at the apex.
    const roseY = E + 4.6;
    const shape = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, R - E)]);
    shape.holes.push(new THREE.Path(circle(0, roseY - E, 1.5)));
    g.add('brick', new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 10 }), F.clone().multiply(M(0, E, -D)), 0.04);
    g.pane(F, 0, roseY, 3.2, 3.2, -D - 0.05, paneData(0.7, 1, PANE_SASH));
    g.add('limestone', new THREE.TorusGeometry(1.62, 0.16, 8, 40), F.clone().multiply(M(0, roseY, 0.04)));
    if (detail) for (let i = 0; i < 8; i++) g.add('limestone', new THREE.BoxGeometry(0.14, 3.0, 0.2).rotateZ((i / 8) * Math.PI), F.clone().multiply(M(0, roseY, -D / 2)));
    const rake = Math.hypot(W / 2 + 0.3, R - E + 0.3);
    const ang = Math.atan2(R - E + 0.3, W / 2 + 0.3);
    for (const s of [-1, 1]) {
      g.add('limestone', new THREE.BoxGeometry(rake, 0.3, 0.8).rotateZ(-s * ang).translate((s * (W / 2 + 0.3)) / 2, E + (R - E + 0.3) / 2 + 0.1, 0), F.clone().multiply(M(0, 0, -D / 2)));
      g.box('limestone', 0.9, 0.8, 0.9, F.clone().multiply(M(s * (W / 2 + 0.1), E + 0.3, -D / 2)));
    }
    g.finial(F.clone().multiply(M(0, R + 0.1, -D / 2)), 0.55);
  }

  // ---------------------------------------------------------------- the roof
  const slope = Math.hypot(W / 2, R - E);
  const overhang = 0.45;
  const roofLen = L - 2 * D;
  for (const s of [-1, 1]) {
    const len = slope + overhang;
    const mid = len / 2 - overhang;
    const cx = s * (W / 2 - mid * Math.cos(pitch));
    const cy = E + mid * Math.sin(pitch);
    // The slopes run along z; each is a slab turned about z.
    g.add('slate', new THREE.BoxGeometry(len, 0.24, roofLen), ME(cx, cy - 0.06, 0, 0, 0, -s * pitch), 0);
  }
  g.box('slate', 0.5, 0.3, roofLen, M(0, R + 0.02, 0), 0);

  // The lantern on the ridge: an octagonal drum of lit lights between colonnettes on a limestone base, under a slated spirelet.
  {
    const lr = 2.4;
    const l0 = R - 1.2;
    g.add('limestone', new THREE.CylinderGeometry(lr + 0.5, lr + 0.9, 1.6, 8).translate(0, 0.8, 0), M(0, l0, 0, Math.PI / 8));
    const d0 = l0 + 1.6;
    const dh = 3.6;
    g.add('slate', new THREE.CylinderGeometry(lr - 0.3, lr - 0.3, dh, 8).translate(0, dh / 2, 0), M(0, d0, 0, Math.PI / 8), 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const F = M(Math.sin(a) * lr, d0, Math.cos(a) * lr, a);
      g.pane(F, 0, dh / 2, lr * 2 * Math.sin(Math.PI / 8) - 0.5, dh - 0.4, -0.1, paneData(LANTERN_IDLE, 1, PANE_SASH));
      lights.lantern.push(new THREE.Vector3().applyMatrix4(k.base.clone().multiply(F).multiply(M(0, dh / 2, -0.1))));
      const C = M(Math.sin(a + Math.PI / 8) * lr * Math.cos(Math.PI / 8), d0, Math.cos(a + Math.PI / 8) * lr * Math.cos(Math.PI / 8), 0);
      g.add('limestone', new THREE.CylinderGeometry(0.16, 0.18, dh, 8).translate(0, dh / 2, 0), C);
    }
    g.add('limestone', new THREE.CylinderGeometry(lr + 0.4, lr + 0.2, 0.5, 8).translate(0, 0.25, 0), M(0, d0 + dh, 0, Math.PI / 8));
    const s0 = d0 + dh + 0.5;
    const sh = 6.0;
    g.add('slate', new THREE.ConeGeometry(lr + 0.5, sh, 8).translate(0, sh / 2, 0), M(0, s0, 0, Math.PI / 8), 0);
    g.box('slate', 0.12, 1.0, 0.12, M(0, s0 + sh + 0.5, 0), 0);
    if (detail) g.add('slate', new THREE.SphereGeometry(0.2, 8, 6), M(0, s0 + sh + 1.0, 0), 0);
  }

  // ---------------------------------------------------------------- the frontispiece
  const FW = 14;
  const FD = 3.6;
  const FH = E + 8.5;
  /** The frontispiece gable's rise: its apex at the turrets' parapet. */
  const rise = 7.2;
  const FP = libraryFace(0, W / 2 + FD);
  {
    const door: Opening = { u: 0, w: 3.2, y0: P, y1: P + 3.4, pointed: true, lights: 1 };
    const great: Opening = { u: 0, w: 5.2, y0: P + 7.4, y1: P + 12.6, pointed: true, lights: 5, transom: P + 10.6, lit: 0.9 };
    const holes = [door, great].map((op) => pointedArch(op.u, op.w, op.y0 - plinthH, op.y1 - plinthH));
    g.add('brick', piercedWall(FW, FH - plinthH, D, holes), FP.clone().multiply(M(0, plinthH, -D)), 0.03);
    g.doorway(FP, door, D, plinthH);
    g.dress(FP, great, D);
    // Its flanks run back through the main roof to the ridge, so the bay is a transept whose roof stands on its own
    // walls, and the podium under it.
    for (const s of [-1, 1]) g.box('brick', W / 2 + FD - D, FH - plinthH, D, M((W / 2 + FD - D) / 2, plinthH + (FH - plinthH) / 2, s * (FW / 2 - D / 2)), 0.03);
    g.box('limestone', FD + 0.6, P, FW + 1.0, M(W / 2 + FD / 2 + 0.1, P / 2, 0));
    g.box('limestone', FD + 0.2, 0.5, FW + 0.4, M(W / 2 + FD / 2, P + 0.25, 0));
    // A string over the door, and the gable above with its coping and finial.
    g.box('limestone', FW + 0.3, 0.22, 0.24, FP.clone().multiply(M(0, P + 6.6, 0.0)));
    const shape = new THREE.Shape([new THREE.Vector2(-FW / 2, 0), new THREE.Vector2(FW / 2, 0), new THREE.Vector2(0, rise)]);
    const quat: Opening = { u: 0, w: 1.2, y0: FH + 0.8, y1: FH + 2.4, pointed: true, lights: 1, lit: 0.5 };
    shape.holes.push(new THREE.Path(pointedArch(0, quat.w, quat.y0 - FH, quat.y1 - FH)));
    g.add('brick', new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 10 }), FP.clone().multiply(M(0, FH, -D)), 0.03);
    g.dress(FP, quat, D);
    const rake = Math.hypot(FW / 2 + 0.3, rise + 0.3);
    const ang = Math.atan2(rise + 0.3, FW / 2 + 0.3);
    for (const s of [-1, 1]) {
      g.add('limestone', new THREE.BoxGeometry(rake, 0.3, 0.8).rotateZ(-s * ang).translate((s * (FW / 2 + 0.3)) / 2, FH + (rise + 0.3) / 2 + 0.1, 0), FP.clone().multiply(M(0, 0, -D / 2)));
    }
    g.finial(FP.clone().multiply(M(0, FH + rise + 0.1, -D / 2)), 0.5);
    // Its roof: two slated slopes on the flank walls from the gable back past the main ridge, closed by a coped gablet
    // standing behind the ridge (the main slope there is a hand under its foot), so no slab ends in the slate.
    const gl = Math.hypot(FW / 2, rise) + 0.3;
    const ga = Math.atan2(rise, FW / 2);
    const backX = -0.6;
    const span = W / 2 + FD + 0.4 - backX;
    for (const s of [-1, 1]) g.add('slate', new THREE.BoxGeometry(span, 0.2, gl).rotateX(s * ga).translate(0, FH + rise / 2 - 0.1, (s * FW) / 4), M(backX + span / 2, 0, 0), 0);
    g.box('slate', span, 0.3, 0.5, M(backX + span / 2, FH + rise + 0.02, 0), 0);
    g.gable(libraryFace(2, -backX), FW, FH, rise, D, []);
    // The steps: a flight across the door down to the forecourt, between low cheek walls.
    const flightW = 9.0;
    const rise1 = P / 6;
    for (let i = 0; i < 6; i++) {
      const tread = 0.42;
      const x0 = W / 2 + FD + 0.1 + i * tread;
      g.box('limestone', tread, P - i * rise1, flightW, M(x0 + tread / 2, (P - i * rise1) / 2, 0));
    }
    for (const s of [-1, 1]) g.box('limestone', 6 * 0.42 + 0.3, P + 0.5, 0.5, M(W / 2 + FD + 0.1 + (6 * 0.42 + 0.3) / 2, (P + 0.5) / 2, s * (flightW / 2 + 0.25)));
  }
  // The stair turrets at the frontispiece's corners: octagonal, banded in limestone, rising past the gable to a spirelet.
  for (const s of [-1, 1]) {
    const tr = 1.35;
    const tx = W / 2 + FD - 0.6;
    const tz = s * (FW / 2 + 0.3);
    const th = FH + rise;
    const T = M(tx, 0, tz, Math.PI / 8);
    g.add('limestone', new THREE.CylinderGeometry(tr + 0.25, tr + 0.4, plinthH, 8).translate(0, plinthH / 2, 0), T);
    g.add('brick', new THREE.CylinderGeometry(tr, tr, th - plinthH, 8).translate(0, plinthH + (th - plinthH) / 2, 0), T, 0.04);
    for (const y of [P + 6.6, E, FH]) g.add('limestone', new THREE.CylinderGeometry(tr + 0.2, tr + 0.2, 0.3, 8).translate(0, y + 0.15, 0), T);
    // Slit windows up the stair, facing the quad.
    for (let y = P + 3; y < th - 2; y += 3.2) {
      const F = M(tx + tr, 0, tz, Math.PI / 2);
      g.pane(F, 0, y, 0.4, 1.4, 0.02, paneData(0.5 + 0.4 * g.rand(), 1, PANE_SASH));
      g.box('limestone', 0.8, 0.12, 0.3, F.clone().multiply(M(0, y - 0.75, 0.1)));
    }
    // A corbelled parapet, then the spirelet and ball.
    g.add('limestone', new THREE.CylinderGeometry(tr + 0.45, tr + 0.1, 0.7, 8).translate(0, 0.35, 0), M(tx, th, tz, Math.PI / 8));
    g.add('limestone', new THREE.ConeGeometry(tr + 0.4, 4.2, 8).translate(0, 2.1, 0), M(tx, th + 0.7, tz, Math.PI / 8));
    if (detail) g.add('limestone', new THREE.SphereGeometry(0.2, 8, 6), M(tx, th + 4.9 + 0.2, tz));
  }
  return lights;
}
