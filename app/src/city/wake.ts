/**
 * A ferry's wake, as the water draws it (river.ts): the Kelvin wedge spreading
 * from the bow at 19.5 degrees, each arm a continuous divergent crest whose
 * height decays with distance astern and wanders slowly, never a line of
 * dashes; two fainter crests run inside it, parallel, as the divergent wave
 * train does. This module is the pure shape: the same numbers feed the water
 * shader (WAKE_GLSL) and the tests, so what the test measures is what the
 * shader draws. Foam breaks up on the crests near the boat; the crests do not.
 */

/** The wedge's half angle, the reach of its arms astern of the bow, and how each measure runs with distance. */
export const WAKE = {
  /** tan of the Kelvin half angle (19.47 degrees). */
  tanHalf: 0.3536,
  /** Metres astern of the bow where the arms are drawn. */
  reach: 150,
  /** How far behind the bow's reference the wedge starts (the hull's half length). */
  bow: 10,
  /** The arm's height envelope at b metres astern: the crest decays and stands up close to the hull. */
  decay(b: number): number {
    return Math.exp(-b / 90) * (1 + 1.6 * Math.exp(-b / 45));
  },
  /** The crest's half width (metres across the arm) at b metres astern. */
  width(b: number): number {
    return 1.1 + 0.05 * b;
  },
  /** How far (metres) the arm's line wanders about its wedge at b astern. */
  wander(b: number): number {
    return 0.3 + 0.02 * b;
  },
  /** The two inner crests: how far inside the arm each runs, as a share of the arm's half spacing, and its strength. */
  inner: [
    { at: 0.62, strength: 0.55 },
    { at: 0.3, strength: 0.3 },
  ],
} as const;

/** A smooth value noise in one dimension, in [0, 1], the same curve in GLSL below. */
function slow(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number): number => {
    const s = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/**
 * The height of the arm's crest, b metres astern of the bow at time t: its
 * decayed envelope, modulated by a slow wander that leaves it at least 0.7
 * of itself, so the ridge reads as one line from the bow to where it fades.
 */
export function wakeArm(b: number, t: number): number {
  const flow = slow(b * 0.04 - t * 0.08);
  return WAKE.decay(b) * (0.7 + 0.3 * flow);
}

/** The shape in GLSL: wkFlow (the slow wander), wkDecay, wkWidth, wkWander and wkArm, as above. */
export const WAKE_GLSL = /* glsl */ `
  float wkHash1(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
  float wkFlow(float x) {
    float i = floor(x);
    float f = x - i;
    float u = f * f * (3.0 - 2.0 * f);
    return mix(wkHash1(i), wkHash1(i + 1.0), u);
  }
  float wkDecay(float b) { return exp(-b / 90.0) * (1.0 + 1.6 * exp(-b / 45.0)); }
  float wkWidth(float b) { return ${WAKE.width(0).toFixed(2)} + ${(WAKE.width(1) - WAKE.width(0)).toFixed(3)} * b; }
  float wkWander(float b) { return ${WAKE.wander(0).toFixed(2)} + ${(WAKE.wander(1) - WAKE.wander(0)).toFixed(3)} * b; }
  float wkArm(float b, float t) { return wkDecay(b) * (0.7 + 0.3 * wkFlow(b * 0.04 - t * 0.08)); }
`;
