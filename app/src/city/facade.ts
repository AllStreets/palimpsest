import * as THREE from 'three';

export interface FacadeOptions {
  /** Fraction of windows lit, 0 to 1 (default 0.42). */
  lit?: number;
  metal?: number;
  rough?: number;
}

/**
 * A facade whose windows are computed from world position in the shader, so
 * every building keeps real window scale at any size (a stretched canvas
 * texture reads as a toy). Floor height and bay width vary per building,
 * seeded from its position; whole floors go dark, the rest light warm or cool
 * with blinds and ceiling falloff. Works on plain and instanced meshes, and
 * respects per-instance colour. Below 4.6 m the facade becomes lit
 * shopfronts under a fascia; roofs (faces pointing up) are tar and gravel.
 */
export function facadeMaterial(base: number, o: FacadeOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: base, metalness: o.metal ?? 0.55, roughness: o.rough ?? 0.28 });
  const litFrac = o.lit ?? 0.42;
  m.customProgramCacheKey = () => 'palimpsest-facade';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = { value: litFrac };
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
        vSeed = mm[3].xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        const float STREET_TOP = 4.6;
        uniform float uLit; varying vec3 vWP; varying vec3 vWN; varying vec3 vSeed;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 an = abs(vWN);
        float bs = h21(vSeed.xz*0.013);
        if (an.y < 0.5) {
          float u = an.x > 0.5 ? vWP.z : vWP.x;
          float bs0 = fract(sin(dot(vSeed.xz, vec2(12.9898, 78.233))) * 43758.5453);
          if (vWP.y < STREET_TOP) {
            // Street level: tall shopfront bays under a dark fascia, most of them lit.
            float bw = 4.2 + bs0*2.4;
            float bx = fract(u / bw);
            float bid = floor(u / bw);
            float glass = smoothstep(0.05,0.07,bx)*smoothstep(0.95,0.93,bx)*smoothstep(0.3,0.42,vWP.y)*smoothstep(3.75,3.6,vWP.y);
            glass *= 1.0 - 0.85*smoothstep(0.495,0.5,bx)*smoothstep(0.505,0.5,bx);
            float open = step(0.28, h21(vec2(bid, bs*31.0)));
            vec3 shop = mix(vec3(1.0, 0.7, 0.42), vec3(0.86, 0.9, 1.0), step(0.8, h21(vec2(bid*1.3, bs))));
            float depth = 0.55 + 0.45*smoothstep(0.4, 3.6, vWP.y);
            totalEmissiveRadiance += glass * open * shop * depth * (0.45 + 0.6*h21(vec2(bid, 7.0)));
            float fascia = smoothstep(3.85, 3.95, vWP.y);
            diffuseColor.rgb *= mix(1.0, 0.25, max(glass, fascia * 0.8));
          } else {
            float fh = 3.4 + bs0*0.8, cw = 1.7 + bs0*1.6;
            float wy = vWP.y - STREET_TOP;
            vec2 cell = fract(vec2(u / cw, wy / fh));
            vec2 id = floor(vec2(u / cw, wy / fh));
            float win = smoothstep(0.06,0.09,cell.x)*smoothstep(0.94,0.91,cell.x)*smoothstep(0.12,0.16,cell.y)*smoothstep(0.9,0.86,cell.y);
            win *= 1.0 - 0.8*smoothstep(0.47,0.49,cell.x)*smoothstep(0.53,0.51,cell.x);
            float floorOn = step(0.25, h21(vec2(id.y, bs*91.0)));
            // Occupancy varies by building: some are nearly dark, some nearly full.
            float occupancy = clamp(uLit * (0.3 + 1.4 * h21(vSeed.xz * 0.0071 + 3.1)), 0.0, 0.92);
            float lit = step(1.0 - occupancy, h21(id + bs*57.0)) * floorOn;
            vec3 warm = vec3(1.0, 0.74, 0.45), cool = vec3(0.78, 0.88, 1.0);
            vec3 c = mix(warm, cool, step(0.7, h21(vec2(bs, id.y))));
            float k = 0.25 + 0.75*pow(h21(id*1.7 + bs), 2.0);
            // Inside the room: the ceiling light falls off toward the sill, and
            // each window has its blind drawn to its own height, slatted.
            float wy01 = clamp((cell.y - 0.16) / 0.7, 0.0, 1.0);
            float room = 0.45 + 0.55 * smoothstep(0.1, 0.95, wy01);
            float blindDrop = h21(id * 3.1 + bs) < 0.45 ? h21(id * 5.7) * 0.7 : 0.0;
            float slats = 0.75 + 0.25 * step(0.5, fract(cell.y * fh * 9.0));
            float shade = wy01 > 1.0 - blindDrop ? 0.4 * slats : 1.0;
            totalEmissiveRadiance += win * lit * c * k * room * shade * 1.15;
            diffuseColor.rgb *= mix(1.0, 0.45, win);
            // Unlit glass is glossy and gives back the sky; the slab edge between floors reads as a faint band.
            roughnessFactor = mix(roughnessFactor, 0.06, win * (1.0 - lit));
            float slab = 1.0 - smoothstep(0.0, 0.05, cell.y) * smoothstep(0.1, 0.05, cell.y) * 0.18;
            diffuseColor.rgb *= slab;
          }
        } else if (vWN.y > 0.5) {
          // Roofs: tar and gravel, not facade paint.
          float grit = h21(floor(vWP.xz * 1.7));
          diffuseColor.rgb = vec3(0.085, 0.082, 0.078) * (0.8 + 0.4 * grit) * (0.85 + 0.3 * bs);
          roughnessFactor = 0.95;
          metalnessFactor = 0.0;
        }`,
      );
  };
  return m;
}
