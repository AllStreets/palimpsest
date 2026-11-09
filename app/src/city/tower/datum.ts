import { Kit, M, squareSweep } from './kit.js';

/** The datum band's height; it hangs below `datumY` so it never rises past the floor it caps. Tall enough to read from a street away. */
export const DATUM_HEIGHT = 1.1;
/** How far the band stands proud of the half-width it wraps. */
const PROUD = 0.3;

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
}

export function addDatum(k: Kit, datumY: number, plan: DatumPlan): void {
  const y0 = datumY - DATUM_HEIGHT;
  // A flat polished face between two chamfers, so the band catches a line of light top and bottom.
  k.add(
    'datum',
    squareSweep(plan.half, [
      [-0.2, y0],
      [PROUD - 0.12, y0],
      [PROUD, y0 + 0.12],
      [PROUD, y0 + DATUM_HEIGHT - 0.12],
      [PROUD - 0.12, y0 + DATUM_HEIGHT],
      [-0.2, y0 + DATUM_HEIGHT],
    ]),
    M(plan.cx, 0, plan.cz, plan.ry),
  );
}
