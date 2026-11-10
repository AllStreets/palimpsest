/**
 * Lights out (Task 28): where a bankrupt firm's power is off, as one set of
 * uniforms every emitter and every window in the city shares. A zone is a
 * square on the ground (its centre, its half side) and how far its lights
 * are out (0 on, 1 out). Zones are read in order and a later zone overrides
 * an earlier one where they overlap, so a dark court can hold one lit tower
 * (the one a buyer re-clad) and a lit quarter one tower going dark.
 *
 * Going dark, relighting and the re-clad's windows change uniforms only: no
 * material recompiles and no quarter rebuilds for an event.
 */
import * as THREE from 'three';

import { QUARTER_COURT, QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import type { QuarterShow } from './quarters.js';

/** Zones the city can hold at once: a court and its four towers, for four quarters at a time. */
export const MAX_OUT = 20;

/** Half the side of the square a tower's lights fill: its root's foot (13 m at the agent scale) and the cantilevers past it. */
export const TOWER_OUT_HALF = 15;
/** Half the side of a court's: the court itself, its lanterns and its walks. */
export const COURT_OUT_HALF = QUARTER_COURT + 1;

/** A zone: [x, z, half side, level], level 0 lit to 1 out. */
export type OutZone = [number, number, number, number];

/** The zones of one quarter as it shows: its court (when its lamps are not all on), then each of its towers over it. */
export function quarterZones(origin: { x: number; z: number }, show: QuarterShow): OutZone[] {
  const out: OutZone[] = [];
  const court = 1 - show.court;
  if (court > 0) out.push([origin.x, origin.z, COURT_OUT_HALF, court]);
  show.towers.forEach((t, i) => {
    const level = 1 - t.lit;
    // Only where it differs from what is round it: a lit tower in a lit court needs no zone.
    if (level === court && court === 0) return;
    const at = QUARTER_OFFSETS[t.spec.towerIndex ?? i];
    if (at) out.push([origin.x + at.x, origin.z + at.z, TOWER_OUT_HALF, level]);
  });
  return out;
}

/** How far the lights are out at (x, z): the shader's term in JS. */
export function lightsOutAt(zones: ReadonlyArray<OutZone>, x: number, z: number): number {
  let d = 0;
  for (const [cx, cz, half, level] of zones) if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) < half) d = level;
  return d;
}

/** The shared uniforms: each zone's centre, half side and level, and how many are set. */
export const OUT_UNIFORMS = {
  uOutZone: { value: Array.from({ length: MAX_OUT }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) },
  uOutCount: { value: 0 },
};

/** Writes the zones into the uniforms (the first MAX_OUT). */
export function setZones(zones: ReadonlyArray<OutZone>): void {
  const n = Math.min(zones.length, MAX_OUT);
  for (let i = 0; i < n; i++) OUT_UNIFORMS.uOutZone.value[i].set(...zones[i]);
  OUT_UNIFORMS.uOutCount.value = n;
}

/**
 * The GLSL: `lightsOutZone(world)` returns the zone a world point stands in
 * (its centre in xy, its half side in z, its level in w), or a zero zone.
 */
export const OUT_PARS = /* glsl */ `
  uniform vec4 uOutZone[${MAX_OUT}];
  uniform int uOutCount;
  vec4 lightsOutZone(vec3 w) {
    vec4 hit = vec4(0.0);
    for (int i = 0; i < ${MAX_OUT}; i++) {
      if (i >= uOutCount) break;
      vec4 z = uOutZone[i];
      vec2 q = abs(w.xz - z.xy);
      if (max(q.x, q.y) < z.z) hit = z;
    }
    return hit;
  }
  float lightsOut(vec3 w) { return lightsOutZone(w).w; }
`;

/** The world position of a vertex, instanced or not, for the fragment's lightsOut (after project_vertex). */
const WORLD_VERTEX = /* glsl */ `
  {
    vec4 ow = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      ow = instanceMatrix * ow;
    #endif
    vOutW = (modelMatrix * ow).xyz;
  }
`;

/** What an emitter shows with its power off: a dead lamp's dull glass, not black. */
const DEAD = '0.014, 0.014, 0.015';

/**
 * An emitter (a light line, a vent, a lantern's glass, a beacon) goes out
 * where the power is off. For unlit (basic) materials: their colour is
 * their light. Done once per material; its program key says so.
 */
export function lightsOutEmitter<T extends THREE.Material>(m: T): T {
  if (m.userData.lightsOut) return m;
  const prev = m.onBeforeCompile.bind(m);
  const own = m.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey ? null : m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, renderer) => {
    prev(sh, renderer);
    Object.assign(sh.uniforms, OUT_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOutW;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VERTEX}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vOutW;\n${OUT_PARS}`)
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, vec3(${DEAD}), lightsOut(vOutW));\n#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `${own ? own() : ''}|lights-out`;
  m.userData.lightsOut = true;
  m.needsUpdate = true;
  return m;
}

/** For a lit shader that adds its own world position: the vertex and fragment declarations. */
export const OUT_VARYING = 'varying vec3 vOutW;';
export { WORLD_VERTEX as OUT_WORLD_VERTEX };

/**
 * Dust where the power is off: a lit material (stone, brick, metal, the
 * walks) takes on a dead building's grime, darker and greyer, in streaks
 * run down by the rain. Done once per material, its own patch first; the
 * tower glass has its own dead term (look.ts) and is left alone.
 */
export function lightsOutLit(m: THREE.Material): void {
  if (m.userData.lightsOut || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  const own = m.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey ? null : m.customProgramCacheKey.bind(m);
  if (own && own().startsWith('palimpsest-tower-window')) return;
  const ownKey = own ? null : m.onBeforeCompile.toString();
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, renderer) => {
    prev(sh, renderer);
    if (!sh.fragmentShader.includes('#include <color_fragment>')) return;
    Object.assign(sh.uniforms, OUT_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOutW;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VERTEX}`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vOutW;\n${OUT_PARS}
        float oHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float oNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(oHash(i), oHash(i + vec2(1, 0)), f.x), mix(oHash(i + vec2(0, 1)), oHash(i + vec2(1, 1)), f.x), f.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float dO = lightsOut(vOutW);
          if (dO > 0.0) {
            // Streaks: noise stretched down the wall, so the grime runs from every sill and cornice.
            float along = vOutW.x * 1.3 + vOutW.z * 1.3;
            float st = oNoise(vec2(along, vOutW.y * 0.06)) * 0.6 + oNoise(vec2(along * 3.1, vOutW.y * 0.2)) * 0.4;
            vec3 g = diffuseColor.rgb * vec3(0.6, 0.58, 0.55) * (0.72 + 0.4 * st);
            float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(lum), g, 0.62), dO);
          }
        }`,
      );
  };
  m.customProgramCacheKey = () => `${own ? own() : ownKey}|out`;
  m.userData.lightsOut = true;
  m.needsUpdate = true;
}

/** Every lit material under a root takes the dust where the power is off. */
export function lightsOutTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const mm of Array.isArray(mat) ? mat : [mat]) lightsOutLit(mm);
  });
}
