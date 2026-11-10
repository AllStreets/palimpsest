import * as THREE from 'three';

import { Kit, M, squareSweep } from './kit.js';

/** The datum band's height; it hangs below `datumY` so it never rises past the floor it caps. Tall enough to read from the hero's distance. */
export const DATUM_HEIGHT = 1.6;
/** How far the band stands proud of the half-width it wraps: far enough to throw a shadow line under it. */
const PROUD = 0.45;

/**
 * The datum line: a thin bronze band where the repo joined the city. Below
 * it, founding floors from real history; above it, floors earned later. It
 * wraps the floor below it at `half` (each era reports a half-width clear of
 * its own facade), centred on (cx, cz) and turned by `ry` (a twisting
 * titanium run). The floor under it leaves off its run-end cap so the band
 * is never buried.
 */
export interface DatumPlan {
  cx: number;
  cz: number;
  half: number;
  ry: number;
  /** A round plan (the biomorphic sci-fi shell): the band is a ring of radius `half` instead of a square. */
  round?: boolean;
}

export function addDatum(k: Kit, datumY: number, plan: DatumPlan): void {
  const y0 = datumY - DATUM_HEIGHT;
  // A flat polished face between two chamfers, so the band catches a line of light top and bottom.
  const profile: Array<[number, number]> = [
    [-0.2, y0],
    [PROUD - 0.12, y0],
    [PROUD, y0 + 0.12],
    [PROUD, y0 + DATUM_HEIGHT - 0.12],
    [PROUD - 0.12, y0 + DATUM_HEIGHT],
    [-0.2, y0 + DATUM_HEIGHT],
  ];
  const geo = plan.round
    ? new THREE.LatheGeometry(
        profile.map(([d, y]) => new THREE.Vector2(plan.half + d, y)),
        64,
      )
    : squareSweep(plan.half, profile);
  if (plan.round) geo.computeVertexNormals();
  k.add('datum', geo, M(plan.cx, 0, plan.cz, plan.ry));
  // A lit reveal under the band's soffit, so the line still reads where the band itself falls into shade.
  const lit: Array<[number, number]> = [
    [-0.2, y0 - 0.06],
    [PROUD - 0.14, y0 - 0.06],
    [PROUD - 0.14, y0],
    [-0.2, y0],
  ];
  const glow = plan.round ? new THREE.LatheGeometry(lit.map(([d, y]) => new THREE.Vector2(plan.half + d, y)), 64) : squareSweep(plan.half, lit);
  if (plan.round) glow.computeVertexNormals();
  k.add('lightLine', glow, M(plan.cx, 0, plan.cz, plan.ry));
}
