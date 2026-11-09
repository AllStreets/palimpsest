import * as THREE from 'three';

import { texture } from './materials';

/**
 * Facade families. `plain` is the mockup's lattice; the others are real
 * building types with their own window rhythm and surface:
 * - stone: dressed sandstone (scanned), tall punched windows in deep reveals, sills;
 * - brick: red brick (scanned), punched windows with stone sills and lintels;
 * - concrete: ribbed precast panels between continuous ribbon windows;
 * - glass: curtain wall, floor-height panes in metal mullions over spandrel
 *   bands; low roughness, so the panes give back the dusk sky at grazing angles.
 */
export type FacadeFamily = 'plain' | 'stone' | 'brick' | 'concrete' | 'glass';

export interface FacadeOptions {
  /** Fraction of windows lit, 0 to 1 (default 0.42). */
  lit?: number;
  metal?: number;
  rough?: number;
  family?: FacadeFamily;
}

const FAMILY_ID: Record<FacadeFamily, number> = { plain: 0, stone: 1, brick: 2, concrete: 3, glass: 4 };

/** Scanned surfaces, sampled in world space so every wall keeps real scale: texture prefix and metres per tile. */
const SCANS: Partial<Record<FacadeFamily, { prefix: string; tile: number }>> = {
  stone: { prefix: 'sand', tile: 2.6 },
  brick: { prefix: 'brick', tile: 1.5 },
};

/**
 * A facade whose windows are computed from world position in the shader, so
 * every building keeps real window scale at any size (a stretched canvas
 * texture reads as a toy). Floor height and bay width vary per building,
 * seeded from its position; whole floors go dark, the rest light warm or cool
 * with ceiling falloff and blinds. Works on plain and instanced meshes, and
 * respects per-instance colour (as a tint over scanned surfaces). Below
 * 4.6 m the facade becomes lit shopfronts under a fascia; roofs (faces
 * pointing up) are gravel, membrane or tar, chosen per building.
 */
export function facadeMaterial(base: number, o: FacadeOptions = {}): THREE.MeshStandardMaterial {
  const family = o.family ?? 'plain';
  const scan = SCANS[family];
  const m = new THREE.MeshStandardMaterial({
    color: base,
    metalness: o.metal ?? (family === 'plain' ? 0.55 : 0),
    roughness: o.rough ?? (family === 'plain' ? 0.28 : family === 'glass' ? 0.3 : 0.85),
  });
  if (scan) {
    m.map = texture(`${scan.prefix}_diff.jpg`, true);
    m.normalMap = texture(`${scan.prefix}_nor.jpg`);
    m.roughnessMap = texture(`${scan.prefix}_arm.jpg`);
    m.normalScale.set(0.9, 0.9);
  }
  // Low-e glazing is more reflective than bare glass; the extra env weight stands in for its coating.
  if (family === 'glass') m.envMapIntensity = 3.0;
  const litFrac = o.lit ?? 0.42;
  m.customProgramCacheKey = () => `palimpsest-facade-${family}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = { value: litFrac };
    sh.defines = { ...(sh.defines ?? {}), FAMILY: FAMILY_ID[family], FACADE_TILE: (scan?.tile ?? 1).toFixed(2) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN; varying vec3 vSeed;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 mm = modelMatrix;
        #ifdef USE_INSTANCING
          mm = modelMatrix * instanceMatrix;
        #endif
        vWP = (mm * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(mm) * objectNormal);
        vSeed = mm[3].xyz;
        vec2 wuv = (abs(vWN.x) > 0.5 ? vWP.zy : abs(vWN.z) > 0.5 ? vWP.xy : vWP.xz) / FACADE_TILE;
        #ifdef USE_MAP
          vMapUv = wuv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = wuv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = wuv;
        #endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        const float STREET_TOP = 4.6;
        uniform float uLit; varying vec3 vWP; varying vec3 vWN; varying vec3 vSeed;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float box1(float x, float a, float b, float e) { return smoothstep(a, a + e, x) * smoothstep(b, b - e, x); }`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FACADE_GLSL}`);
  };
  return m;
}

const FACADE_GLSL = /* glsl */ `
  vec3 an = abs(vWN);
  float bs = h21(vSeed.xz * 0.013);
  float bs0 = fract(sin(dot(vSeed.xz, vec2(12.9898, 78.233))) * 43758.5453);
  if (an.y < 0.5) {
    float u = an.x > 0.5 ? vWP.z : vWP.x;
    vec3 tangentView = normalize((viewMatrix * vec4(an.x > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), 0.0)).xyz);
    if (vWP.y < STREET_TOP) {
      // Street level: tall shopfront bays under a fascia, most of them lit.
      float bw = 4.2 + bs0 * 2.4;
      float bx = fract(u / bw);
      float bid = floor(u / bw);
      float glass = box1(bx, 0.05, 0.95, 0.02) * box1(vWP.y, 0.3, 3.75, 0.12);
      glass *= 1.0 - 0.85 * box1(bx, 0.495, 0.505, 0.005);
      float open = step(0.28, h21(vec2(bid, bs * 31.0)));
      vec3 shop = mix(vec3(1.0, 0.7, 0.42), vec3(0.86, 0.9, 1.0), step(0.8, h21(vec2(bid * 1.3, bs))));
      float depth = 0.55 + 0.45 * smoothstep(0.4, 3.6, vWP.y);
      totalEmissiveRadiance += glass * open * shop * depth * (0.45 + 0.6 * h21(vec2(bid, 7.0)));
      float fascia = smoothstep(3.85, 3.95, vWP.y);
      diffuseColor.rgb *= mix(1.0, 0.25, max(glass, fascia * 0.8));
      roughnessFactor = mix(roughnessFactor, 0.12, glass);
    } else {
      float wy = vWP.y - STREET_TOP;
      // Window rhythm per family: floor height, bay width and the window's box within the bay.
      float fh = 3.4 + bs0 * 0.8, cw = 1.7 + bs0 * 1.6;
      float x0 = 0.07, x1 = 0.93, y0 = 0.14, y1 = 0.88;
      #if FAMILY == 1
        fh = 3.9 + bs0 * 0.6; cw = 2.9 + bs0 * 0.9; x0 = 0.3; x1 = 0.7; y0 = 0.2; y1 = 0.82;
      #elif FAMILY == 2
        fh = 3.2 + bs0 * 0.4; cw = 2.4 + bs0 * 0.7; x0 = 0.26; x1 = 0.74; y0 = 0.22; y1 = 0.8;
      #elif FAMILY == 3
        fh = 3.6 + bs0 * 0.5; cw = 1.6; x0 = 0.03; x1 = 0.97; y0 = 0.36; y1 = 0.86;
      #elif FAMILY == 4
        fh = 3.8 + bs0 * 0.4; cw = 1.5; x0 = 0.035; x1 = 0.965; y0 = 0.2; y1 = 0.985;
      #endif
      vec2 cell = fract(vec2(u / cw, wy / fh));
      vec2 id = floor(vec2(u / cw, wy / fh));
      float win = box1(cell.x, x0, x1, 0.015) * box1(cell.y, y0, y1, 0.015);
      #if FAMILY == 0
        win *= 1.0 - 0.8 * box1(cell.x, 0.47, 0.53, 0.02);
      #endif
      float floorOn = step(0.25, h21(vec2(id.y, bs * 91.0)));
      // Occupancy varies by building: some are nearly dark, some nearly full.
      float occupancy = clamp(uLit * (0.3 + 1.4 * h21(vSeed.xz * 0.0071 + 3.1)), 0.0, 0.92);
      float lit = step(1.0 - occupancy, h21(id + bs * 57.0)) * floorOn;
      vec3 warm = vec3(1.0, 0.74, 0.45), cool = vec3(0.78, 0.88, 1.0);
      vec3 c = mix(warm, cool, step(0.7, h21(vec2(bs, id.y))));
      float k = 0.25 + 0.75 * pow(h21(id * 1.7 + bs), 2.0);
      // Inside the room: ceiling light falls off toward the sill; blinds drawn to varied heights, slatted.
      float wy01 = clamp((cell.y - y0) / (y1 - y0), 0.0, 1.0);
      float room = 0.45 + 0.55 * smoothstep(0.1, 0.95, wy01);
      float blindDrop = h21(id * 3.1 + bs) < 0.45 ? h21(id * 5.7) * 0.7 : 0.0;
      float slats = 0.75 + 0.25 * step(0.5, fract(cell.y * fh * 9.0));
      float shade = wy01 > 1.0 - blindDrop ? 0.4 * slats : 1.0;
      float glow = 1.15;
      #if FAMILY == 1 || FAMILY == 2
        // Deep reveals: the head and one jamb of each opening sit in shadow.
        float wx01 = clamp((cell.x - x0) / (x1 - x0), 0.0, 1.0);
        shade *= mix(0.45, 1.0, smoothstep(0.86, 0.72, wy01) * smoothstep(0.0, 0.12, wx01));
        // Stone sill under, lintel over, a little wider than the opening.
        float trim = box1(cell.x, x0 - 0.04, x1 + 0.04, 0.01) * (box1(cell.y, y0 - 0.05, y0, 0.01) + box1(cell.y, y1, y1 + 0.04, 0.01));
        #if FAMILY == 2
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.38, 0.32), trim);
        #else
          diffuseColor.rgb *= 1.0 + trim * 0.25;
        #endif
      #endif
      #if FAMILY == 4
        glow = 0.8;
      #endif
      totalEmissiveRadiance += win * lit * c * k * room * shade * glow;

      #if FAMILY == 3
        // Precast ribs in the spandrels, catching the low sun.
        float spandrel = 1.0 - win;
        float rib = sin(u * 6.2831853 / 0.4) * spandrel;
        normal = normalize(normal + tangentView * rib * 0.14);
        diffuseColor.rgb *= 0.92 + 0.16 * h21(vec2(floor(u / 4.8), id.y));
      #endif
      #if FAMILY == 4
        // Curtain wall: dark glazing, a metal mullion grid, opaque spandrel bands at each floor.
        float mullion = 1.0 - box1(cell.x, x0, x1, 0.004);
        float pane = win * (1.0 - mullion);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.016, 0.02), pane);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.048, 0.045), mullion);
        roughnessFactor = mix(roughnessFactor, 0.035, pane);
        roughnessFactor = mix(roughnessFactor, 0.45, mullion);
        metalnessFactor = mix(metalnessFactor, 0.85, mullion);
      #else
        diffuseColor.rgb *= mix(1.0, 0.2, win);
        // Unlit glass is glossy and gives back the sky.
        roughnessFactor = mix(roughnessFactor, 0.06, win * (1.0 - lit));
        float slab = 1.0 - box1(cell.y, 0.0, 0.1, 0.05) * 0.18;
        diffuseColor.rgb *= slab;
      #endif
    }
  } else if (vWN.y > 0.5) {
    // Roofs: gravel, pale membrane with seams, or tar, chosen per building.
    float kind = h21(vSeed.xz * 0.021 + 7.3);
    float grit = h21(floor(vWP.xz * 1.7));
    vec3 gravel = vec3(0.085, 0.082, 0.077) * (0.8 + 0.4 * grit);
    float seam = 1.0 - 0.25 * box1(fract(vWP.x / 2.0), 0.0, 0.03, 0.01);
    vec3 membrane = vec3(0.16, 0.16, 0.155) * seam * (0.9 + 0.1 * grit);
    vec3 tar = vec3(0.05, 0.048, 0.046) * (0.85 + 0.3 * grit);
    diffuseColor.rgb = kind < 0.5 ? gravel : kind < 0.72 ? membrane : tar;
    roughnessFactor = kind < 0.5 ? 0.95 : kind < 0.72 ? 0.6 : 0.8;
    metalnessFactor = 0.0;
  }`;
