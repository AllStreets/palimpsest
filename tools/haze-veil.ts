/**
 * The haze's veil over the mid-distance band (Phase 5 Task 15a), read for the
 * ui-test's hazeBandChecks: the light the haze lays over the band is the
 * band's mean luma less the same band's in clear air (haze(0)), read in the
 * same run from the same eye.
 *
 * Task 15a held the band under an absolute 62 when clear air read 57 there
 * from home, which let the haze add 5. Task 15's re-measured looks lit the city
 * itself brighter: clear air from home now reads 61 to 64 from run to run, so
 * the absolute ceiling failed on the city's own lights with the haze adding
 * under one. The ceiling is now the veil itself, the same 5 over clear air.
 */

/** The most the haze may add to the band's mean luma (0 to 255) over clear air: Task 15a's 62 over its clear air's 57. */
export const HAZE_VEIL_LUMA = 5;

/** The veil the haze lays over the band, in luma, and whether it is within HAZE_VEIL_LUMA. */
export function hazeVeil(band: { mean: number }, clear: { mean: number }): { veil: number; holds: boolean } {
  const veil = band.mean - clear.mean;
  return { veil, holds: Number.isFinite(veil) && veil <= HAZE_VEIL_LUMA };
}
