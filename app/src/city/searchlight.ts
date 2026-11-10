/**
 * The inspection guild's searchlights as light on the city (Task 27): one
 * set of uniforms every lit material shares, so a beam sweeping a tower's top
 * floor streaks the tower's own face, the ambient blocks it passes and the
 * construction's steel alike. The field (construction.ts) writes the lamps
 * here each frame in world space; with no inspection running the count is 0
 * and the loop ends at once. Switching lamps on or off changes uniforms only:
 * no material recompiles for an event.
 *
 * The term: a spot with a soft edge, inverse square from each lamp, held
 * level inside its near distance (searchRadiance in construction.ts), and
 * nothing a few metres past where the beam meets the floor (the floor stands
 * in its way). A warm white mixed far toward white, so it lifts a surface
 * without repainting it.
 */
import * as THREE from 'three';

import { EXPOSURE } from './post.js';

/** Lamps the city can light with at once (two per job site). */
export const MAX_SEARCH = 16;

/**
 * A searchlight's light: a 2 kW xenon lamp of the kind used for night
 * inspection, inverse square, held level inside 90 m. At that distance pale
 * steel of albedo 0.35 comes to 0.8 after exposure, under the bloom
 * threshold. Each lamp is sized to its throw (searchThrow in construction.ts).
 */
export const SEARCH = (() => {
  const near = 90;
  const albedo = 0.35;
  const peak = Math.round((0.8 * Math.PI * near * near) / (albedo * EXPOSURE));
  return { peak, near, color: new THREE.Color(1, 0.97, 0.92) } as const;
})();

/**
 * The most irradiance a searchlight gives a surface of albedo 1, in the
 * units of the term (uSearchColor carries the peak); the shader divides it
 * by the surface's own albedo, so any surface under the beam comes to at
 * most 0.85 after exposure, under the bloom threshold.
 */
export const SEARCH_CAP = (0.85 * Math.PI) / (EXPOSURE * SEARCH.peak);

/** The shared uniforms: each lamp's lens and aim in world space, its cone (cos outer, cos inner, throw gain, beam length). */
export const SEARCH_UNIFORMS = {
  uSearchPosW: { value: Array.from({ length: MAX_SEARCH }, () => new THREE.Vector3()) },
  uSearchDirW: { value: Array.from({ length: MAX_SEARCH }, () => new THREE.Vector3(0, 1, 0)) },
  uSearchCone: { value: Array.from({ length: MAX_SEARCH }, () => new THREE.Vector4(1, 1, 1, 0)) },
  uSearchCount: { value: 0 },
  uSearchColor: { value: SEARCH.color.clone().multiplyScalar(SEARCH.peak) },
};

export const SEARCH_PARS = /* glsl */ `
  uniform vec3 uSearchPosW[${MAX_SEARCH}];
  uniform vec3 uSearchDirW[${MAX_SEARCH}];
  uniform vec4 uSearchCone[${MAX_SEARCH}];
  uniform int uSearchCount;
  uniform vec3 uSearchColor;
`;

/** Added after the material's own lights: needs geometryPosition and geometryNormal (view space) and material.diffuseColor. */
export const SEARCH_LIGHT = /* glsl */ `
  for (int i = 0; i < ${MAX_SEARCH}; i++) {
    if (i >= uSearchCount) break;
    vec3 sPos = (viewMatrix * vec4(uSearchPosW[i], 1.0)).xyz;
    vec3 sDir = normalize((viewMatrix * vec4(uSearchDirW[i], 0.0)).xyz);
    vec3 sL = sPos - geometryPosition;
    float sD = length(sL);
    sL /= max(sD, 1e-3);
    float sAlong = dot(-sL, sDir);
    // The face the beam meets takes its light: nothing a few metres past the beam's end is lit.
    float sSpot = smoothstep(uSearchCone[i].x, uSearchCone[i].y, sAlong) * (1.0 - smoothstep(0.5, 3.0, sAlong * sD - uSearchCone[i].w));
    if (sSpot <= 0.0) continue;
    float sNl = max(dot(geometryNormal, sL), 0.0);
    float sNear = max(sD, ${SEARCH.near.toFixed(1)});
    // Irradiance held under the level at which this surface would reach the bloom threshold: the beam lifts a
    // surface in proportion to its own colour (its hue kept) and never burns it out, dark or pale.
    float sAlb = max(dot(material.diffuseColor, vec3(0.2126, 0.7152, 0.0722)), 0.04);
    float sE = min(uSearchCone[i].z * sSpot * sNl / (sNear * sNear), ${SEARCH_CAP.toExponential(4)} / sAlb);
    reflectedLight.directDiffuse += uSearchColor * sE * BRDF_Lambert(material.diffuseColor);
    #ifdef SEARCH_GLINT
      // Glass: the beam's glint, a broad sheen lobe of weathered, dusty glazing (a beam from the plaza below rakes the face, so the half vector to an eye out over the city sits well off the normal) (13% of the beam's irradiance about the
      // half vector to the eye), held under 0.5 so it reads as a bright moving glint on the face and never burns out.
      float sH = max(dot(geometryNormal, normalize(sL + geometryViewDir)), 0.0);
      float sG = min(uSearchCone[i].z * sSpot / (sNear * sNear) * pow(sH, 4.0) * ${(SEARCH.peak * 0.13).toFixed(1)}, 0.5);
      reflectedLight.directSpecular += normalize(uSearchColor) * 1.7 * sG;
    #endif
  }
`;

/** Adds the searchlight term to a compiled shader, if it is a lit one. */
export function injectSearch(shader: THREE.WebGLProgramParametersWithUniforms, glint = false): void {
  if (!shader.fragmentShader.includes('#include <lights_fragment_end>')) return;
  Object.assign(shader.uniforms, SEARCH_UNIFORMS);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${glint ? '#define SEARCH_GLINT\n' : ''}${SEARCH_PARS}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${SEARCH_LIGHT}`);
}

/** Glossy, non-metal surfaces (glazing and curtain wall) show the beam's glint as well as its light. */
const glossy = (m: THREE.MeshStandardMaterial): boolean => m.roughness < 0.25 && m.metalness < 0.5;

/**
 * Lets a lit material take the searchlights: its own shader patch runs
 * first, then the term is added; its program key gains a suffix so it never
 * shares a program with its unpatched self. Done once per material.
 */
export function searchLit(m: THREE.Material): void {
  if (m.userData.searchLit || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  const own = m.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey ? null : m.customProgramCacheKey.bind(m);
  const ownKey = own ? own() : m.onBeforeCompile.toString();
  const glint = glossy(m as THREE.MeshStandardMaterial);
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    injectSearch(shader, glint);
  };
  // A suffixed key, so the patched program is never one compiled before the patch (the tower glass is found by the
  // prefix of its key: batch.ts, the scene's window rows).
  m.customProgramCacheKey = () => `${own ? own() : ownKey}|search${glint ? '-glint' : ''}`;
  m.userData.searchLit = true;
  m.needsUpdate = true;
}

/** Every lit material under a root takes the searchlights (towers, quarters, the ambient blocks). */
export function searchLitTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) searchLit(m);
  });
}
