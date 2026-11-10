import * as THREE from 'three';

import { type Kit, lathe, M, ME, PANE_FULL, paneData, unitBox } from './kit.js';

/**
 * What stands on the roof of an agent's tower (spec 6.2, ruling 25):
 *
 * - a careful reviewer's lens crown: a faceted glazed drum, one tier of
 *   mullions for every five floors earned, a bronze cornice and a dark roof
 *   plate, and on a turntable over it a fork mount carrying a thick coated
 *   lens in a bronze cell, tipped toward the low western sun like an
 *   instrument aimed at it. The more rings, the higher the fork lifts the
 *   lens and the further it can tip;
 * - a specialist's spire: a galvanised mast in three telescoping sections on
 *   a battered footing, collared at each joint, with an aviation lamp at mid
 *   height and one at its tip.
 *
 * Both are built into the tower's kit in the frame of its roof (y = 0 on the
 * roof, the plan centred on the origin), and neither reaches above `height`.
 */

/** Mullions round each tier of the lens drum: the drum is a 24-sided prism of glass. */
export const LENS_MULLIONS = 24;
/** Height of one tier of the drum, one per five floors. */
export const LENS_TIER = 0.8;
/** Where the dusk sun sits, as an angle about the vertical (sky.ts SUN_DIRECTION, x -260 and z 120). */
const SUN_AZIMUTH = Math.atan2(-260, 120);
/** The furthest a lens tips toward the sun. */
const MAX_TILT = (30 * Math.PI) / 180;

/**
 * A lens crown with `rings` tiers of mullions on a roof `half` metres from
 * centre to face, `height` tall (crownFor), turned `ry` about the vertical
 * with the tower's top floor so its lens stays aimed at the sun. Medium
 * quality leaves out the small hardware (pivot bosses, cell screws).
 */
export function makeLensCrown(k: Kit, rings: number, quality: 'high' | 'medium', half: number, height: number, ry = 0): void {
  const R = Math.min(5, Math.max(2.4, half * 0.58));
  const detail = quality === 'high';
  const sides = LENS_MULLIONS;
  const apothem = R * Math.cos(Math.PI / sides);
  const facet = 2 * R * Math.sin(Math.PI / sides);
  // A steel plinth ring on the roof, wider than the drum, its top edge chamfered.
  const plinth = 0.35;
  k.add('steel', lathe([[0, 0], [R + 0.45, 0], [R + 0.45, plinth - 0.1], [R + 0.32, plinth], [0, plinth]], 48));
  let y = plinth;
  if (rings > 0) {
    // The drum: one tier of glass per ring, mullions at every facet joint, a transom over each tier.
    for (let t = 0; t < rings; t++) {
      const y0 = y + t * LENS_TIER;
      for (let s = 0; s < sides; s++) {
        const a = ((s + 0.5) / sides) * Math.PI * 2;
        const F = M(0, 0, 0, a).multiply(M(0, 0, apothem));
        // Dark optical-grade glazing with nothing lit behind it: each facet holds its own piece of the sky.
        k.pane('pane:lens', 'darkGlass', F.clone().multiply(M(0, y0 + LENS_TIER / 2, -0.02, 0, facet - 0.06, LENS_TIER - 0.06, 1)), paneData(1, 1, PANE_FULL));
        const m = (s / sides) * Math.PI * 2;
        k.inst('lens-mullion', 'graphite', unitBox, M(0, 0, 0, m).multiply(M(0, y0 + LENS_TIER / 2, R + 0.03, 0, 0.08, LENS_TIER, 0.18)));
      }
      // A bronze transom over each tier: the rings, counted from the street.
      k.add('datum', ringBand(R + 0.08, 0.16, 0.08), M(0, y0 + LENS_TIER - 0.04, 0));
    }
    // A solid back to the drum, so the glass reads as a skin over a room, not a lamp shade.
    k.add('slab', new THREE.CylinderGeometry(apothem - 0.4, apothem - 0.4, rings * LENS_TIER, sides, 1, false), M(0, y + (rings * LENS_TIER) / 2, 0, Math.PI / sides));
    y += rings * LENS_TIER;
  } else {
    // A young lens sits on a low bronze collar until its first ring is earned.
    k.add('datum', lathe([[0, 0], [R * 0.9, 0], [R * 0.9, 0.45], [0, 0.45]], 40), M(0, y, 0));
    y += 0.45;
  }
  // The cornice: a bronze ring stepped out at its lip, and the dark roof plate inside it.
  const cornice = 0.2;
  k.add('datum', lathe([[R - 0.2, 0], [R + 0.16, 0], [R + 0.26, cornice * 0.5], [R + 0.26, cornice], [R - 0.2, cornice], [R - 0.2, 0]], 48), M(0, y, 0));
  k.add('roof', new THREE.CylinderGeometry(R - 0.15, R - 0.15, 0.12, 48), M(0, y + 0.06, 0));
  y += cornice;
  // The turntable: a low steel drum the fork stands on.
  const table = 0.3;
  k.add('steel', lathe([[0, 0], [R * 0.42, 0], [R * 0.42, table * 0.6], [R * 0.36, table], [0, table]], 32), M(0, y, 0));
  y += table;
  // The lens, thicker as it grows, tipped as far toward the sun as the crown's height allows.
  const Rl = R * 0.62;
  const thick = Math.min(0.9, 0.5 + 0.12 * rings);
  const room = height - y - 0.12;
  const tilt = Math.max(0, Math.min(MAX_TILT, Math.asin(Math.min(1, Math.max(0, (room - thick) / (2 * Rl))))));
  // The pivot sits where the tipped lens's low rim just clears the turntable.
  const pivotY = y + Rl * Math.sin(tilt) + (thick / 2) * Math.cos(tilt) + 0.06;
  const aim = SUN_AZIMUTH - ry;
  const pivot = M(0, pivotY, 0, aim);
  const tip = pivot.clone().multiply(ME(0, 0, 0, tilt, 0, 0));
  k.add('lens', lensGeometry(Rl, thick, 0.1), tip);
  // The cell: a bronze ring round the rim, with a slim retaining ring on the face.
  k.add('datum', lathe([[Rl - 0.04, -0.12], [Rl + 0.16, -0.12], [Rl + 0.16, 0.12], [Rl - 0.04, 0.12], [Rl - 0.04, -0.12]], 64), tip);
  if (detail) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      k.box('steel', 0.07, 0.05, 0.07, tip.clone().multiply(M(Math.cos(a) * (Rl + 0.06), 0.14, Math.sin(a) * (Rl + 0.06))));
    }
  }
  // The fork: a bronze arm each side of the cell on the tilt axis, from the turntable to the pivot.
  const armFoot = y - 0.05;
  const armH = pivotY + 0.25 - armFoot;
  for (const sx of [-1, 1]) {
    k.add('graphite', fork(armH), pivot.clone().multiply(M(sx * (Rl + 0.32), -(pivotY - armFoot), 0)));
    if (detail) k.add('datum', new THREE.CylinderGeometry(0.17, 0.17, 0.36, 16).rotateZ(Math.PI / 2), pivot.clone().multiply(M(sx * (Rl + 0.2), 0, 0)));
  }
  // The arms stand on a cross beam across the turntable.
  k.box('graphite', 2 * (Rl + 0.32) + 0.3, 0.22, 0.42, M(0, armFoot + 0.11, 0, aim));
}

/** One fork arm `h` tall, its foot at y = 0: broad at the foot, narrowing to a rounded boss at the pivot. */
function fork(h: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.26, 0);
  s.lineTo(0.26, 0);
  s.lineTo(0.14, h - 0.25);
  s.absarc(0, h - 0.25, 0.14, 0, Math.PI, false);
  s.lineTo(-0.26, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: false, curveSegments: 8 });
  // Extruded along z; turn it so the arm's plate faces along the tilt axis (x).
  g.translate(0, 0, -0.08);
  g.rotateY(Math.PI / 2);
  return g;
}

/** A biconvex lens of radius `r`, `thick` at its centre and `edge` at its rim, its axis vertical and centred at y = 0. */
function lensGeometry(r: number, thick: number, edge: number): THREE.BufferGeometry {
  const n = 16;
  const sag = (thick - edge) / 2;
  const pts: Array<[number, number]> = [];
  // Up the lower face from the centre to the rim, then back in over the upper face: spherical caps.
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([r * t, -(edge / 2 + sag * (1 - t * t))]);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    pts.push([r * t, edge / 2 + sag * (1 - t * t)]);
  }
  pts[0][0] = 0.0001;
  pts[pts.length - 1][0] = 0.0001;
  return lathe(pts, 72);
}

/** A flat ring band of outer radius `r`, `w` deep and `h` tall, its foot at y = 0. */
function ringBand(r: number, w: number, h: number): THREE.BufferGeometry {
  return lathe([[r - w, 0], [r, 0], [r, h], [r - w, h], [r - w, 0]], LENS_MULLIONS * 2);
}

/**
 * A spire `height` metres tall on a roof `half` metres from centre to face:
 * a battered footing, then a galvanised mast in three telescoping sections,
 * each narrower than the one below and collared where they meet, an aviation
 * lamp at mid height and one at the tip under a short lightning rod.
 */
export function makeSpire(k: Kit, height: number, half: number): void {
  const footing = Math.min(1.8, height * 0.1);
  const base = Math.min(half * 0.38, 2.2);
  // A square footing, battered to an octagon, so the mast grows out of the roof rather than standing on it.
  k.add('steel', lathe([[0, 0], [base, 0], [base * 0.92, footing * 0.35], [base * 0.5, footing], [0, footing]], 8), M(0, 0, 0, Math.PI / 8));
  k.add('galvanised', lathe([[0, 0], [base * 1.04, 0], [base * 1.04, 0.12], [0, 0.12]], 8), M(0, footing * 0.35 - 0.06, 0, Math.PI / 8));
  const lampH = 0.42;
  const rod = 0.5;
  const mastTop = height - rod - lampH;
  const span = mastTop - footing;
  // Three sections, the lower longest; each starts a little narrower than the one below ends.
  const parts = [0.42, 0.33, 0.25];
  let y = footing;
  let r = base * 0.5;
  parts.forEach((share, i) => {
    const h = span * share;
    const r1 = i === parts.length - 1 ? 0.1 : r * 0.62;
    k.add('galvanised', new THREE.CylinderGeometry(r1, r, h, 8, 1, false), M(0, y + h / 2, 0, Math.PI / 8));
    if (i < parts.length - 1) {
      // The joint collar, and the next section steps in from it.
      k.add('steel', lathe([[0, -0.1], [r1 + 0.12, -0.1], [r1 + 0.12, 0.1], [0, 0.1]], 8), M(0, y + h, 0, Math.PI / 8));
      if (i === 0) {
        // The mid lamp on a short arm at the first joint.
        k.box('galvanised', 0.08, 0.08, 0.3, M(0, y + h - 0.3, r1 + 0.2));
        k.add('beacon', new THREE.SphereGeometry(0.13, 10, 6), M(0, y + h - 0.3, r1 + 0.4));
      }
      r = r1 * 0.85;
    }
    y += h;
  });
  k.add('beacon', new THREE.SphereGeometry(lampH / 2, 12, 8), M(0, mastTop + lampH / 2, 0));
  k.add('galvanised', new THREE.CylinderGeometry(0.02, 0.04, rod, 6), M(0, height - rod / 2, 0));
}
