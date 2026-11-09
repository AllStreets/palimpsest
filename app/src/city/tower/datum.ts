import { Kit, M, squareSweep } from './kit.js';

/** The datum band's height; it hangs below `datumY` so it never rises past the floor it caps. */
export const DATUM_HEIGHT = 0.42;

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
  /** A rectangle ([x0, x1, z0, z1]) to follow instead of the square: a sci-fi floor's slab edge. */
  rect?: [number, number, number, number];
}

export function addDatum(k: Kit, datumY: number, plan: DatumPlan): void {
  const y0 = datumY - DATUM_HEIGHT;
  if (plan.rect) {
    // Four bronze bars on the slab edge's line, mitred by overlap at the corners.
    const [x0, x1, z0, z1] = plan.rect;
    const t = 0.12;
    const y = y0 + DATUM_HEIGHT / 2;
    k.box('bronze', x1 - x0 + 2 * t, DATUM_HEIGHT, t, M((x0 + x1) / 2, y, z1 + t / 2));
    k.box('bronze', x1 - x0 + 2 * t, DATUM_HEIGHT, t, M((x0 + x1) / 2, y, z0 - t / 2));
    k.box('bronze', t, DATUM_HEIGHT, z1 - z0, M(x1 + t / 2, y, (z0 + z1) / 2));
    k.box('bronze', t, DATUM_HEIGHT, z1 - z0, M(x0 - t / 2, y, (z0 + z1) / 2));
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
    M(plan.cx, 0, plan.cz, plan.ry),
  );
}
