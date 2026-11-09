import * as THREE from 'three';

import { BLOCK, LAMP_EDGE, LAMP_OFFSETS, PITCH, PLAZA_LAMP_RING, PLAZA_LAMPS, PLAZA_RADIUS, type Plaza } from './grid';
import { materials, texture, worldBox } from './materials';

/** Most plazas the ground shader tracks at once (the civic plaza plus districts). */
export const MAX_PLAZAS = 64;
const GROUND_SIZE = 16000;
/** Metres per paving texture tile. */
const PAVE_TILE = 4;
/** Lamp heads reach this far over the road from the pole. */
const LAMP_REACH = 1.3;

export interface Ground {
  mesh: THREE.Mesh;
  setPlazas(plazas: Plaza[]): void;
  dispose(): void;
}

/**
 * The ground: precast stone paving everywhere, asphalt lanes with worn
 * centre dashes down every street, open paved plazas where districts and the
 * civic plaza sit, and the light pools of the sodium lamps (the lamps in
 * grid.ts sit on the same lattice the shader computes, so every pool has its
 * lamp). Pools are albedo-weighted irradiance, not paint, so asphalt takes
 * less light than stone.
 */
export function createGround(): Ground {
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1);
  // UVs from position, centred on zero, so precision is best where the city is.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / PAVE_TILE, pos.getY(i) / PAVE_TILE);

  const arm = texture('pave_arm.jpg');
  const mat = new THREE.MeshStandardMaterial({
    map: texture('pave_diff.jpg', true),
    normalMap: texture('pave_nor.jpg'),
    aoMap: arm,
    roughnessMap: arm,
    color: 0xc4bdb5,
    roughness: 0.6,
    metalness: 0,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });

  const uniforms = {
    uPlazas: { value: Array.from({ length: MAX_PLAZAS }, () => new THREE.Vector2(1e6, 1e6)) },
    uPlazaCount: { value: 1 },
  };

  mat.customProgramCacheKey = () => 'palimpsest-ground';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const lampOffsets = LAMP_OFFSETS.map((o) => o.toFixed(1)).join(', ');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGP;
        uniform vec2 uPlazas[${MAX_PLAZAS}];
        uniform int uPlazaCount;
        const float PITCH = ${PITCH.toFixed(1)};
        const float HALF_BLOCK = ${(BLOCK / 2).toFixed(1)};
        const float LAMP_AT = ${(LAMP_EDGE + LAMP_REACH).toFixed(2)};
        const float PLAZA_R = ${PLAZA_RADIUS.toFixed(1)};
        const float RING_R = ${PLAZA_LAMP_RING.toFixed(1)};
        const float RING_N = ${PLAZA_LAMPS.toFixed(1)};
        const float OFFS[4] = float[4](${lampOffsets});
        float gHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        // Distance to the nearest plaza centre, and that centre.
        float nearestPlaza(vec2 p, out vec2 c) {
          float best = 1e9; c = vec2(1e6);
          for (int i = 0; i < ${MAX_PLAZAS}; i++) {
            if (i >= uPlazaCount) break;
            float d = distance(p, uPlazas[i]);
            if (d < best) { best = d; c = uPlazas[i]; }
          }
          return best;
        }
        float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
        float pool(vec2 d) { return exp(-dot(d, d) / 38.0) + 0.18 * exp(-dot(d, d) / 260.0); }
        bool inPlaza(vec2 p) {
          for (int i = 0; i < ${MAX_PLAZAS}; i++) {
            if (i >= uPlazaCount) break;
            if (distance(p, uPlazas[i]) < PLAZA_R) return true;
          }
          return false;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        vec2 gp = vGP.xz;
        vec2 cellId = floor((gp + PITCH * 0.5) / PITCH);
        vec2 lc = gp - cellId * PITCH;                 // position within this block's cell, block centred
        vec2 plazaC;
        float plazaD = nearestPlaza(gp, plazaC);
        float plaza = 1.0 - smoothstep(PLAZA_R - 2.0, PLAZA_R, plazaD);
        float edge = max(abs(lc.x), abs(lc.y));
        float road = smoothstep(HALF_BLOCK + 3.9, HALF_BLOCK + 4.1, edge) * (1.0 - plaza);
        float kerb = smoothstep(HALF_BLOCK + 3.6, HALF_BLOCK + 3.75, edge) * (1.0 - smoothstep(HALF_BLOCK + 3.85, HALF_BLOCK + 4.0, edge)) * (1.0 - plaza);
        // Asphalt: dark, faintly blue, worn smoother where tyres run, with fine grain.
        float grain = gHash(floor(gp * 9.0)) * 0.12 + gHash(floor(gp * 1.3)) * 0.08;
        vec3 asphalt = vec3(0.028, 0.029, 0.032) * (0.9 + grain);
        // Centre dashes on streets that are not intersections.
        bool alongZ = abs(lc.x) > HALF_BLOCK + 4.0 && abs(lc.y) <= HALF_BLOCK;
        bool alongX = abs(lc.y) > HALF_BLOCK + 4.0 && abs(lc.x) <= HALF_BLOCK;
        float centre = alongZ ? abs(abs(lc.x) - PITCH * 0.5) : alongX ? abs(abs(lc.y) - PITCH * 0.5) : 99.0;
        float run = alongZ ? lc.y : lc.x;
        float dash = (1.0 - smoothstep(0.07, 0.1, centre)) * step(0.5, fract(run / 6.0)) * (0.55 + 0.45 * gHash(floor(gp * 3.0)));
        asphalt = mix(asphalt, vec3(0.3, 0.27, 0.2), dash * 0.8);
        // Weathering: broad stains and lighter worn patches so the paving never reads as one repeated tile.
        float stain = gNoise(gp * 0.045) * 0.6 + gNoise(gp * 0.21) * 0.4;
        diffuseColor.rgb *= 0.72 + 0.5 * stain;
        diffuseColor.rgb = mix(diffuseColor.rgb, asphalt, road);
        diffuseColor.rgb *= 1.0 - kerb * 0.35;
        // Plaza ring: a band of lighter dressed stone at the plaza's edge.
        float ring = smoothstep(PLAZA_R - 4.0, PLAZA_R - 3.6, plazaD) * (1.0 - smoothstep(PLAZA_R - 1.2, PLAZA_R - 0.8, plazaD));
        diffuseColor.rgb *= 1.0 + ring * 0.18;
        roughnessFactor = mix(roughnessFactor, 0.74 + grain, road);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float light = 0.0;
          bool nearP = plazaD < PLAZA_R + 24.0;
          for (int k = 0; k < 4; k++) {
            float o = OFFS[k];
            vec2 lamps[4] = vec2[4](vec2(o, LAMP_AT), vec2(LAMP_AT, o), vec2(o, LAMP_AT - PITCH), vec2(LAMP_AT - PITCH, o));
            for (int q = 0; q < 4; q++) {
              vec2 lp = lamps[q];
              if (nearP) {
                vec2 pole = cellId * PITCH + lp - (q % 2 == 0 ? vec2(0.0, ${LAMP_REACH.toFixed(2)}) : vec2(${LAMP_REACH.toFixed(2)}, 0.0));
                if (inPlaza(pole)) continue;
              }
              light += pool(lc - lp);
            }
          }
          // Lanterns around the nearest plaza.
          if (plazaD < RING_R + 14.0) {
            vec2 d = gp - plazaC;
            float step_ = 6.28318530718 / RING_N;
            float a = floor(atan(d.y, d.x) / step_ + 0.5) * step_;
            vec2 lp = vec2(cos(a), sin(a)) * RING_R;
            light += 0.8 * pool(d - lp);
          }
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.56, 0.22) * light * 2.6;
        }`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'ground';

  return {
    mesh,
    setPlazas(plazas) {
      const all = [{ x: 0, z: 0 }, ...plazas].slice(0, MAX_PLAZAS);
      all.forEach((p, i) => uniforms.uPlazas.value[i].set(p.x, p.z));
      uniforms.uPlazaCount.value = all.length;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * A plain dressed-stone plinth reserving a district's place: three steps, a
 * rusticated base and a cornice. Towers stand on this footprint from Task 8.
 */
export function makePlinth(): THREE.Group {
  const M = materials();
  const g = new THREE.Group();
  const FOOT = 34;
  for (let s = 0; s < 3; s++) {
    const step = worldBox(FOOT + 8 - s * 2, 0.45, FOOT + 8 - s * 2, M.sand, 2.5);
    step.position.y = 0.225 + s * 0.45;
    g.add(step);
  }
  const base = worldBox(FOOT, 2.6, FOOT, M.sand, 2.2);
  base.position.y = 1.35 + 1.3;
  g.add(base);
  const cornice = worldBox(FOOT + 1.4, 0.7, FOOT + 1.4, M.sand, 2.2);
  cornice.position.y = 1.35 + 2.6 + 0.35;
  g.add(cornice);
  return g;
}
