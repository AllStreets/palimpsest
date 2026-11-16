import * as THREE from 'three';

import { SKY_DITHER, SUN_BLOOM_MAX } from './post.js';

/** Where the sun sits, just under the horizon: the glow band and the key light both follow it. */
export const SUN_DIRECTION = new THREE.Vector3(-260, 40, 120).normalize();

/**
 * The haze graded by height (Task 6): a ground haze whose density falls
 * with the height of what it veils, to HAZE_FLOOR of the ground's at the
 * top of a tall tower (exponential in height over HAZE_HEIGHT metres). The
 * streets and the far ground keep the haze the city was designed in; the
 * towers stand up out of it with their own stone, brick and glass.
 */
export const HAZE_HEIGHT = 140;
export const HAZE_FLOOR = 0.3;
/**
 * The haze graded by distance and by altitude, as dusk aerial perspective.
 * The air a surface fades into is the sky's own colour at that surface's
 * altitude (skyAir): the street-level haze is the horizon's (warm toward
 * the afterglow, violet away from it), and a wall or a crown higher up fades
 * toward the cooler sky above the horizon band, as a far tower dissolves
 * into the sky behind it. Close to the eye the scattered light is a lit air:
 * that colour with HAZE_NEAR_CHROMA of its chroma, lifted by HAZE_NEAR_LIFT
 * (the low haze over a city is lit from above by the bright western sky, so
 * the middle distance lightens and loses contrast rather than sinking into
 * the dark eastern horizon), a little cool; the full colour arrives with the
 * fog factor's HAZE_CHROMA_POW power, so fogged ground meets the dome with
 * no seam. A building a few hundred metres off loses contrast to the air,
 * never its hue: no one mauve-brown over the whole city.
 */
export const HAZE_NEAR_CHROMA = 0.4;
export const HAZE_NEAR_TINT: [number, number, number] = [0.96, 0.98, 1.06];
export const HAZE_NEAR_LIFT = 1.5;
export const HAZE_CHROMA_POW = 3;
/**
 * skyAir's altitude: a surface y metres up fades toward the sky at elevation
 * y / AIR_RISE (a sine), at most AIR_TOP: the street keeps the horizon band,
 * a 400 m crown the violet over it.
 */
export const AIR_RISE = 2000;
export const AIR_TOP = 0.2;
/** The dome's dither (post.ts SKY_DITHER, which the lens's composite lays again over what it blurs). */
export { SKY_DITHER };
/** The soft knee's start, as a share of SUN_BLOOM_MAX: under it the sky is untouched. */
const CAP_KNEE = 0.8;

/** A representative haze colour for the scene's fog object; the fog shader itself takes its colour from the sky per direction. */
export const HORIZON_FOG = new THREE.Color(0x58434c);

const VERTEX_DOME = /* glsl */ `
  varying vec3 vD;
  void main() {
    vD = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

const VERTEX_ENV = /* glsl */ `
  varying vec3 vD;
  void main() {
    vD = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * Haze brightness relative to the sky right at the horizon. At 1.0 fully
 * fogged ground meets the sky with no seam, as real inscattering does.
 */
const HAZE = 1.0;

/**
 * The sky as a function of direction, shared by the dome, the environment
 * map and the fog, so all three agree. `skyHaze` is the colour of the air at
 * the horizon in a given direction: warm toward the afterglow, violet away from it.
 */
export const SKY_GLSL = /* glsl */ `
  const vec3 SKY_SUN = vec3(${SUN_DIRECTION.x.toFixed(5)}, ${SUN_DIRECTION.y.toFixed(5)}, ${SUN_DIRECTION.z.toFixed(5)});
  const float SUN_BLOOM_MAX = ${SUN_BLOOM_MAX.toFixed(4)};
  const float CAP_KNEE = ${(SUN_BLOOM_MAX * CAP_KNEE).toFixed(4)};
  // The sky's cap (post.ts SUN_BLOOM_MAX): the colour scaled, never a channel clipped, so the glow keeps its hue;
  // a soft knee from CAP_KNEE that asymptotes to the cap, so the glow still rises toward the sun.
  vec3 skyCap(vec3 c) {
    float m = max(c.r, max(c.g, c.b));
    if (m <= CAP_KNEE) return c;
    float w = SUN_BLOOM_MAX - CAP_KNEE;
    return c * ((SUN_BLOOM_MAX - w * exp(-(m - CAP_KNEE) / w)) / m);
  }
  float skyHash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
  float skyNoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z); }
  float skySunFacing(vec3 d) {
    return max(dot(normalize(vec3(d.x, 0., d.z) + 1e-6), normalize(vec3(SKY_SUN.x, 0., SKY_SUN.z))), 0.);
  }
  vec3 skyClear(vec3 d) {
    float h = max(d.y, 0.0);
    float sd = skySunFacing(d);
    vec3 zen = vec3(0.035, 0.05, 0.11), mid = vec3(0.095, 0.105, 0.215), hor = vec3(0.95, 0.45, 0.22);
    vec3 c = mix(mid, zen, smoothstep(0.08, 0.55, h));
    float band = exp(-h*9.0) * (0.35 + 0.65*pow(sd, 3.0));
    c = mix(c, hor, clamp(band, 0., 1.));
    c += vec3(1.0, 0.55, 0.25) * pow(sd, 24.0) * exp(-h*14.0) * 1.4;
    return skyCap(c);
  }
  vec3 skyHaze(vec3 d) {
    vec3 c = skyClear(vec3(d.x, 0.0, d.z)) * ${HAZE.toFixed(3)};
    return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.22);
  }
  // The air at height y in the bearing of dir (sky.ts AIR_RISE): the sky's colour at an elevation that rises with y,
  // greyed as skyHaze is; at y = 0 it is skyHaze itself, so the far ground still meets the dome with no seam.
  vec3 skyAir(vec3 dir, float y) {
    float e = clamp(y / ${AIR_RISE.toFixed(1)}, 0.0, ${AIR_TOP.toFixed(3)});
    vec3 c = skyClear(vec3(dir.x, 0.0, dir.z) * inversesqrt(max(dir.x * dir.x + dir.z * dir.z, 1e-8)) * sqrt(1.0 - e * e) + vec3(0.0, e, 0.0)) * ${HAZE.toFixed(3)};
    return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.22);
  }
  // The haze laid over a surface colour by fog factor f, looking along dir, the surface y metres up (sky.ts
  // HAZE_NEAR_CHROMA, AIR_RISE): near the eye a lit air, the air's grey a little cool; toward the horizon the air's own
  // colour at the surface's altitude.
  vec3 hazeOver(vec3 col, vec3 dir, float f, float y) {
    vec3 far = skyAir(dir, y);
    float lum = dot(far, vec3(0.2126, 0.7152, 0.0722));
    vec3 near = mix(vec3(lum), far, ${HAZE_NEAR_CHROMA.toFixed(3)}) * vec3(${HAZE_NEAR_TINT.map((v) => v.toFixed(3)).join(', ')}) * ${HAZE_NEAR_LIFT.toFixed(3)};
    return mix(col, mix(near, far, pow(f, ${HAZE_CHROMA_POW.toFixed(2)})), f);
  }
  vec3 hazeOver(vec3 col, vec3 dir, float f) { return hazeOver(col, dir, f, 0.0); }
  // The ground haze's share of the density at height y (sky.ts HAZE_HEIGHT, HAZE_FLOOR).
  float hazeLayer(float y) {
    return ${HAZE_FLOOR.toFixed(3)} + ${(1 - HAZE_FLOOR).toFixed(3)} * exp(-max(y, 0.0) / ${HAZE_HEIGHT.toFixed(1)});
  }
  vec3 skyColor(vec3 d) {
    vec3 c = skyClear(d);
    float h = max(d.y, 0.0);
    float sd = skySunFacing(d);
    float n = skyNoise(d*vec3(3.0, 14.0, 3.0)*2.0) * 0.6 + skyNoise(d*vec3(7.0, 30.0, 7.0)) * 0.4;
    float cl = smoothstep(0.55, 0.85, n) * smoothstep(0.03, 0.12, h) * smoothstep(0.5, 0.15, h);
    c = mix(c, mix(vec3(0.22,0.18,0.24), vec3(0.95,0.55,0.38), pow(sd, 2.0)*exp(-h*4.0)), cl*0.55);
    return mix(skyHaze(d), c, smoothstep(-0.005, 0.07, d.y));
  }`;

const FRAGMENT = /* glsl */ `
  varying vec3 vD;
  ${SKY_GLSL}
  // Interleaved gradient noise (Jimenez 2014): one ordered dither step per pixel, so the dusk gradient and the
  // cap's knee never step into bands at 8 bits (the review of Task 6 saw concentric arcs in the clear-air still).
  float skyDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main(){ gl_FragColor = vec4(skyColor(normalize(vD)) + (skyDither(gl_FragCoord.xy) - 0.5) * ${SKY_DITHER.toFixed(6)}, 1.); }`;

/**
 * Replaces three's fog with fog whose colour is the sky's haze in the
 * direction of each fragment, so distant ground and buildings dissolve into
 * exactly the sky behind them at every bearing (one flat fog colour leaves a
 * seam wherever the sky is brighter). Density stays exponential squared.
 * Call before any material compiles.
 */
export function installSkyFog(): void {
  THREE.ShaderChunk.fog_pars_vertex = `
  #ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorld;
  #endif`;
  THREE.ShaderChunk.fog_vertex = `
  #ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
  #endif`;
  THREE.ShaderChunk.fog_pars_fragment = `
  #ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
    ${SKY_GLSL}
  #endif`;
  THREE.ShaderChunk.fog_fragment = `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      // Graded by height: the density the fragment is seen through falls with its own height (a ground haze).
      float fogLayer = hazeLayer(vFogWorld.y);
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * fogLayer * fogLayer );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = hazeOver( gl_FragColor.rgb, normalize(vFogWorld - cameraPosition), fogFactor, vFogWorld.y );
  #endif`;
}

type V3 = [number, number, number];
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The sky's cap, as the shader's skyCap: the colour scaled toward `cap` through a soft knee, never clipped. */
export function skyCap(c: V3, cap = SUN_BLOOM_MAX): V3 {
  const m = Math.max(c[0], c[1], c[2]);
  const knee = cap * CAP_KNEE;
  if (!(m > knee) || !Number.isFinite(cap)) return c;
  const w = cap - knee;
  const k = (cap - w * Math.exp(-(m - knee) / w)) / m;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * The clear sky in a direction, the same maths as the shader's skyClear
 * (tests hold the cap here; the GLSL carries the same constants). `cap` of
 * Infinity gives the uncapped radiance.
 */
export function skyClear(d: V3, cap = SUN_BLOOM_MAX): V3 {
  const h = Math.max(d[1], 0);
  const hl = Math.hypot(d[0], d[2]) + 1e-6;
  const sl = Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z);
  const sd = Math.max((d[0] / hl) * (SUN_DIRECTION.x / sl) + (d[2] / hl) * (SUN_DIRECTION.z / sl), 0);
  const zen: V3 = [0.035, 0.05, 0.11];
  const mid: V3 = [0.095, 0.105, 0.215];
  const hor: V3 = [0.95, 0.45, 0.22];
  let c = mix3(mid, zen, smoothstep(0.08, 0.55, h));
  const band = Math.min(1, Math.max(0, Math.exp(-h * 9) * (0.35 + 0.65 * Math.pow(sd, 3))));
  c = mix3(c, hor, band);
  const glow = Math.pow(sd, 24) * Math.exp(-h * 14) * 1.4;
  c = [c[0] + 1.0 * glow, c[1] + 0.55 * glow, c[2] + 0.25 * glow];
  return skyCap(c, cap);
}

/** The haze colour at the horizon in a direction, as the shader's skyHaze: the fog's far colour. */
export function skyHaze(d: V3): V3 {
  const c = skyClear([d[0], 0, d[2]]).map((v) => v * HAZE) as V3;
  const lum = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  return mix3(c, [lum, lum, lum], 0.22);
}

/** The air at height `y` in a bearing, as the shader's skyAir: the sky's colour at an elevation rising with y, greyed as skyHaze is. */
export function skyAir(d: V3, y: number): V3 {
  const e = Math.min(AIR_TOP, Math.max(0, y / AIR_RISE));
  const hl = Math.hypot(d[0], d[2]) || 1e-4;
  const k = Math.sqrt(1 - e * e) / hl;
  const c = skyClear([d[0] * k, e, d[2] * k]).map((v) => v * HAZE) as V3;
  const lum = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  return mix3(c, [lum, lum, lum], 0.22);
}

function skyMaterial(vertexShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader,
    fragmentShader: FRAGMENT,
  });
}

export interface Sky {
  dome: THREE.Mesh;
  environment: THREE.Texture;
  dispose(): void;
}

/**
 * The dusk sky dome, plus an environment map rendered from the same sky (and
 * a warm ring for the lit city below) so every reflection agrees with what
 * the viewer sees. A bright daytime HDRI made titanium read as white plastic.
 */
export function createSky(renderer: THREE.WebGLRenderer): Sky {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(15000, 64, 32), skyMaterial(VERTEX_DOME));
  dome.renderOrder = -1;
  dome.frustumCulled = false;

  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), skyMaterial(VERTEX_ENV));
  envScene.add(envSky);
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(49, 49, 6, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x5a3a28, side: THREE.BackSide }),
  );
  glow.position.y = -3;
  envScene.add(glow);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  pmrem.dispose();
  for (const m of [envSky, glow]) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }

  return {
    dome,
    environment: target.texture,
    dispose() {
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      target.dispose();
    },
  };
}
