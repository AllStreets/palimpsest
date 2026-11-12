/**
 * The ambient roof kit's dissolve (lod.ts AMBIENT_LOD), in the shaders: each
 * instance measures its distance from the eye, the near kit drops its
 * fragments as the far box takes them up, by the same screen-door pattern,
 * so the two never both draw a pixel and never both leave one empty. An
 * instance wholly past its level is folded away before rasterising.
 */
import * as THREE from 'three';

import { AMBIENT_LOD } from './lod.js';

/** The eye the fade measures from: the view camera, set each frame (the shadow pass has its own camera). */
export const LOD_EYE = { value: new THREE.Vector3() };

const VERTEX_PARS = 'uniform vec3 uLodEye;\nvarying float vLodFade;';
const fadeAt = (near: number, far: number): string => /* glsl */ `
  {
    #ifdef USE_INSTANCING
      vec4 lodAt = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    #else
      vec4 lodAt = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    #endif
    vLodFade = smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, distance(lodAt.xyz, uLodEye));
  }`;
// Past the clip volume: the instance's triangles are dropped before rasterising.
const FOLD = 'gl_Position = vec4(0.0, 0.0, 2.0, 1.0);';
// Interleaved gradient noise: an even screen-door threshold per pixel.
const DITHER = 'float lodN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));';

/**
 * A copy of `src` that draws as the near level ('near', fading out across the
 * band) or the far level ('far', fading in). Its program key is its own.
 */
export function lodMaterial<T extends THREE.Material>(src: T, level: 'near' | 'far', band: { near: number; far: number } = AMBIENT_LOD): T {
  const m = src.clone() as T;
  // A clone carries the source's user data but not its shader patches: let the searchlight and lights-out patch it afresh.
  m.userData = {};
  const keep = level === 'near' ? 'lodN < vLodFade' : 'lodN >= vLodFade';
  const fold = level === 'near' ? 'vLodFade >= 1.0' : 'vLodFade <= 0.0';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLodEye = LOD_EYE;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${fadeAt(band.near, band.far)}\nif (${fold}) ${FOLD}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLodFade;')
      .replace('void main() {', `void main() {\n  ${DITHER}\n  if (${keep}) discard;`);
  };
  m.customProgramCacheKey = () => `palimpsest-lod-${level}-${band.near}-${band.far}`;
  return m;
}

/**
 * The shadow-map depth for the far boxes: an instance folds away while the
 * eye is close enough that its near kit casts the shadow instead.
 */
export function lodDepthMaterial(band: { near: number; far: number } = AMBIENT_LOD): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLodEye = LOD_EYE;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${fadeAt(band.near, band.far)}\nif (vLodFade <= 0.0) ${FOLD}`);
  };
  m.customProgramCacheKey = () => `palimpsest-lod-depth-${band.near}-${band.far}`;
  return m;
}
