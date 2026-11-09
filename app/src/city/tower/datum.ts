import * as THREE from 'three';

import { Kit, M, squareSweep } from './kit.js';

/** The datum band's height; it hangs below `datumY` so it never rises past the floor it caps. */
export const DATUM_HEIGHT = 0.42;

/**
 * The datum line: a thin bronze band where the repo joined the city. Below
 * it, founding floors from real history; above it, floors earned later. It
 * wraps whatever stands at that height: a square plan of half-width `half`,
 * or an octagon of circumradius `half` (sci-fi floors), centred on (cx, cz)
 * and turned by `ry` (a twisting titanium run).
 */
export function addDatum(k: Kit, datumY: number, plan: { cx: number; cz: number; half: number; octagon: boolean; ry: number }): void {
  const y0 = datumY - DATUM_HEIGHT;
  const base = M(plan.cx, 0, plan.cz, plan.ry);
  if (plan.octagon) {
    const band = new THREE.CylinderGeometry(plan.half + 0.12, plan.half + 0.12, DATUM_HEIGHT, 8, 1, false);
    band.rotateY(Math.PI / 8);
    k.add('bronze', band, base.multiply(M(0, y0 + DATUM_HEIGHT / 2, 0)));
    return;
  }
  // A flat fillet between two small chamfers, so the band catches a line of light top and bottom.
  k.add(
    'bronze',
    squareSweep(plan.half, [
      [-0.2, y0],
      [0.06, y0],
      [0.12, y0 + 0.06],
      [0.12, y0 + DATUM_HEIGHT - 0.06],
      [0.06, y0 + DATUM_HEIGHT],
      [-0.2, y0 + DATUM_HEIGHT],
    ]),
    base,
  );
}
