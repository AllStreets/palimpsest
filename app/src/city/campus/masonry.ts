/**
 * The campus's one opaque material (site.ts explains the kinds): a
 * MeshStandardMaterial whose fragment picks a scan by `vKind`. The brick
 * scan is its own map; the limestone, ashlar and gravel scans come in as
 * uniforms (gravel is the sand scan at a fine tile); slate is coursed in the
 * shader, turf is mottled and striped, the lamp kind emits its tone, and the
 * dial kind is the exchange's painted clock dial, lit from behind after
 * sunset (the `uDialLit` uniform, which the material's userData exposes to
 * the clock tower). The observatory's kinds (Task 36): copper whose patina
 * is painted here from its own UVs (metres across and along the dome, so
 * the standing seams and the streaks keep their size), a smooth paint, a
 * brass lit by `uPlateLit` while the master is trusted, and the warm lining
 * inside the dome lit by `uSlitLit` while the shutters are open. The line
 * kind (Task 38) is a bare emitter for the school towers' lit lines and
 * lamps, which draw in this masonry too. App only: it loads textures.
 */
import * as THREE from 'three';

import { clockDial } from '../exchange.js';
import { texture } from '../materials.js';

export function masonryMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: texture('brick_diff.jpg', true),
    normalMap: texture('brick_nor.jpg'),
    roughnessMap: texture('brick_arm.jpg'),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.6,
  });
  const u = {
    uSandMap: { value: texture('sand_diff.jpg', true) },
    uSandNor: { value: texture('sand_nor.jpg') },
    uSandArm: { value: texture('sand_arm.jpg') },
    uAshMap: { value: texture('ashlar_diff.jpg', true) },
    uAshNor: { value: texture('ashlar_nor.jpg') },
    uAshArm: { value: texture('ashlar_arm.jpg') },
    uDial: { value: clockDial() ?? texture('sand_diff.jpg', true) },
    uDialLit: { value: 0 },
    uSlitLit: { value: 0 },
    uPlateLit: { value: 0 },
  };
  m.userData.dialLit = u.uDialLit;
  m.userData.slitLit = u.uSlitLit;
  m.userData.plateLit = u.uPlateLit;
  m.customProgramCacheKey = () => 'palimpsest-campus-masonry';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aKind; varying float vKind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKind = aKind;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vKind;
        uniform sampler2D uSandMap; uniform sampler2D uSandNor; uniform sampler2D uSandArm;
        uniform sampler2D uAshMap; uniform sampler2D uAshNor; uniform sampler2D uAshArm;
        uniform sampler2D uDial; uniform float uDialLit; uniform float uSlitLit; uniform float uPlateLit;
        int campusKind() { return int(vKind + 0.5); }
        // Copper gone green: how bare the metal is at this point (0 crusted verdigris, 1 brown copper showing),
        // from long streaks down the dome where the rain runs and the standing seams every 1.25 m across, which
        // shed water and keep their metal; the UVs are metres across (x) and along (y).
        float copperBare(vec2 uv) {
          float panel = fract(uv.x / 1.25);
          float seam = 1.0 - smoothstep(0.0, 0.09, min(panel, 1.0 - panel));
          float streak = texture2D(uSandMap, vec2(uv.x * 0.31, uv.y * 0.035)).g;
          float fine = texture2D(uSandMap, uv * 0.55).g;
          return smoothstep(0.46, 0.84, streak * 0.6 + fine * 0.4 + 0.35 * seam);
        }
        vec3 copperColour(vec2 uv, float bare) {
          float panel = fract(uv.x / 1.25);
          float ridge = smoothstep(0.0, 0.02, min(panel, 1.0 - panel));
          float fine = texture2D(uSandMap, uv * 0.55).g;
          float mottle = texture2D(uSandMap, uv * 0.07).g;
          float run = texture2D(uSandMap, vec2(uv.x * 0.9, uv.y * 0.06)).g;
          // Each sheet of copper weathered its own way: a tone per panel, and a drift down each panel's length.
          float sheet = fract(sin(floor(uv.x / 1.25) * 12.9898 + floor(uv.y / 2.4) * 78.233) * 43758.5453);
          // Verdigris from a pale chalky green to a deep blue-green, the darker where the rain runs, brown where bare.
          vec3 verdigris = mix(vec3(0.09, 0.25, 0.21), vec3(0.3, 0.52, 0.42), 0.3 * fine + 0.5 * mottle + 0.2 * sheet) * (0.72 + 0.46 * run) * (0.9 + 0.2 * sheet);
          vec3 metal = mix(vec3(0.2, 0.09, 0.05), vec3(0.34, 0.17, 0.09), fine);
          return mix(verdigris, metal, bare) * (0.68 + 0.32 * ridge);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          int ck = campusKind();
          vec4 s;
          if (ck == 0) s = texture2D(map, vMapUv);
          else if (ck == 1) s = texture2D(uSandMap, vMapUv);
          else if (ck == 3) {
            // Ashlar: the scan, cooled toward limestone, and its repeat broken block by block: each course (0.6 m, four
            // a tile) and each block in it (a hash of the course and the block's place, offset every other course) a
            // shade lighter or darker, a slow drift tile to tile, and a hair's shadow under each course's bed joint.
            vec3 a = texture2D(uAshMap, vMapUv).rgb;
            float lum = dot(a, vec3(0.3, 0.59, 0.11));
            a = mix(a, vec3(lum), 0.55) * vec3(0.98, 1.0, 1.03);
            float course = floor(vMapUv.y * 4.0);
            float blk = floor(vMapUv.x * 3.0 + 0.5 * mod(course, 2.0));
            float hb = fract(sin(course * 12.9898 + blk * 78.233) * 43758.5453);
            float hc = fract(sin(course * 39.425) * 24631.3);
            float ht = fract(sin(floor(vMapUv.x) * 21.17 + floor(vMapUv.y) * 51.9) * 9173.7);
            float tone = 0.9 + 0.14 * hb + 0.08 * (hc - 0.5) + 0.06 * (ht - 0.5);
            float bed = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.035, fract(vMapUv.y * 4.0)));
            s = vec4(a * tone * bed, 1.0);
          }
          else if (ck == 5) {
            // Gravel: the sand scan is a mid-grey meant to be tinted pale; lifted, it reads as crushed limestone.
            vec3 gr = texture2D(uSandMap, vMapUv).rgb;
            s = vec4(min(vec3(1.0), gr * 1.75 + 0.08), 1.0);
          }
          else if (ck == 2) {
            // Slate: courses of slates half a metre deep and a third wide, each course offset by half a slate, their
            // edges a shade darker, and the brick scan's shading as the stone's own variation.
            float c = texture2D(map, vMapUv).g;
            float course = floor(vMapUv.y * 4.0);
            float sx = fract(vMapUv.x * 6.0 + 0.5 * mod(course, 2.0));
            float sy = fract(vMapUv.y * 4.0);
            float edge = smoothstep(0.0, 0.1, sy) * smoothstep(0.0, 0.07, sx) * (1.0 - 0.5 * smoothstep(0.9, 1.0, sy));
            float tone = 0.9 + 0.2 * fract(sin(course * 12.9898 + floor(vMapUv.x * 6.0 + 0.5 * mod(course, 2.0)) * 78.233) * 43758.5453);
            s = vec4(vec3((0.82 + 0.3 * c) * (0.7 + 0.3 * edge) * tone), 1.0);
          } else if (ck == 6) {
            s = vec4(1.0);
          } else if (ck == 7) {
            // A clock dial: the painted face (cream, a chapter ring, roman numerals), the piece's own UVs.
            s = texture2D(uDial, vMapUv);
          } else if (ck == 8) {
            // Louvres: horizontal slats of weathered timber, 18 cm to the course (the UVs are metres), each dark in
            // its shadow with a lit edge along its lower lip, the sand scan stretched along the grain.
            float slat = fract(vMapUv.y / 0.18);
            float lip = smoothstep(0.8, 0.9, slat) * (1.0 - smoothstep(0.95, 1.0, slat));
            float grain = texture2D(uSandMap, vMapUv * vec2(0.5, 4.0)).g;
            s = vec4(vec3((0.5 + 0.5 * grain) * (0.22 + 0.7 * lip)), 1.0);
          } else if (ck == 9) {
            s = vec4(1.0);
          } else if (ck == 10) {
            // Yew: the tone is the vertex colour's, a fine dark-light break from the sand scan, no lawn mottle.
            float f = texture2D(uSandMap, vMapUv * 2.3).g;
            s = vec4(vec3(0.38 + 0.32 * f), 1.0);
          } else if (ck == 11) {
            s = vec4(copperColour(vMapUv, copperBare(vMapUv)), 1.0);
          } else if (ck == 12 || ck == 13) {
            s = vec4(1.0);
          } else if (ck == 14) {
            // The lining's paint is near black (the sun through the slit adds nothing): its tone is its lamplight.
            s = vec4(0.06);
          } else if (ck == 15) {
            // A bare emitter (a school tower's lit lines and lamps): black paint, its tone is its light.
            s = vec4(0.0, 0.0, 0.0, 1.0);
          } else {
            // Turf: a mown lawn, mottled by the sand scan at a coarse tile and a finer one, with the mower's stripes.
            float a = texture2D(uSandMap, vMapUv * 0.13).g;
            float b = texture2D(uSandMap, vMapUv * 0.6).g;
            float f = texture2D(uSandMap, vMapUv * 3.1).g;
            float stripe = 0.91 + 0.09 * step(0.5, fract(vMapUv.x * 2.2));
            s = vec4(vec3((0.56 + 0.5 * a + 0.32 * b + 0.1 * f) * stripe), 1.0);
          }
          diffuseColor *= s;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        {
          int ck = campusKind();
          float r = 1.0;
          if (ck == 0) r = texture2D(roughnessMap, vRoughnessMapUv).g;
          else if (ck == 1) r = texture2D(uSandArm, vRoughnessMapUv).g;
          else if (ck == 3) r = texture2D(uAshArm, vRoughnessMapUv).g;
          else if (ck == 5) r = 0.9 + 0.1 * texture2D(uSandArm, vRoughnessMapUv).g;
          else if (ck == 2) r = 0.52 + 0.22 * texture2D(roughnessMap, vRoughnessMapUv).g;
          else if (ck == 6) r = 0.5;
          else if (ck == 7) r = 0.42;
          else if (ck == 8) r = 0.88;
          else if (ck == 9) r = 0.34;
          else if (ck == 10) r = 0.95;
          else if (ck == 11) r = mix(0.68, 0.38, copperBare(vRoughnessMapUv));
          else if (ck == 12) r = 0.36;
          else if (ck == 13) r = 0.28;
          else if (ck == 14) r = 0.9;
          else if (ck == 15) r = 0.6;
          else r = 0.96;
          roughnessFactor *= r;
        }`,
      )
      // The copper and the brass are metals where the metal shows: the crust of verdigris is not.
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = metalness;
        {
          int ck = campusKind();
          if (ck == 11) metalnessFactor = mix(0.08, 0.7, copperBare(vRoughnessMapUv));
          else if (ck == 13) metalnessFactor = 0.75;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
        {
          int ck = campusKind();
          vec3 mapN;
          float k = 1.0;
          if (ck == 0) mapN = texture2D(normalMap, vNormalMapUv).xyz;
          else if (ck == 1) { mapN = texture2D(uSandNor, vNormalMapUv).xyz; k = 0.8; }
          else if (ck == 3) { mapN = texture2D(uAshNor, vNormalMapUv).xyz; k = 1.1; }
          else if (ck == 5) { mapN = texture2D(uSandNor, vNormalMapUv).xyz; k = 0.25; }
          else if (ck == 2) { mapN = texture2D(normalMap, vNormalMapUv).xyz; k = 0.35; }
          else if (ck == 6 || ck == 7 || ck == 8 || ck == 9 || ck == 12 || ck == 13 || ck == 14 || ck == 15) { mapN = vec3(0.5, 0.5, 1.0); }
          else if (ck == 11) { mapN = texture2D(uSandNor, vNormalMapUv * 0.55).xyz; k = 0.22; }
          else { mapN = texture2D(uSandNor, vNormalMapUv * 2.9).xyz; k = 0.3; }
          mapN = mapN * 2.0 - 1.0;
          mapN.xy *= normalScale * k;
          normal = normalize( tbn * mapN );
        }
        #endif`,
      )
      // The lamp heads emit their own tone: warm, at a level the street lamps' lenses share, so bloom catches them at dusk.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // A lamp head is a globe in a square lantern, not a hot square: the light pools round the centre of each face
        // (the head keeps the box's own 0..1 UVs) and falls off softly toward the frame, which stays a warm rim.
        if (campusKind() == 6) {
          float r = length(vMapUv - 0.5) * 2.0;
          float globe = 1.0 - smoothstep(0.38, 1.0, r);
          totalEmissiveRadiance += vColor.rgb * (0.45 + 2.9 * globe * globe);
        }
        // The dials after sunset: opal glass lit from behind, warm, at the exchange's level, under the bloom threshold.
        if (campusKind() == 7) totalEmissiveRadiance += texture2D(uDial, vMapUv).rgb * vec3(1.0, 0.86, 0.62) * (0.62 * uDialLit);
        // The observatory: the lamplit lining inside the dome while the slit is open, and the brass plate by the door
        // (with its lantern's lens) while the master is trusted, both real emitters under the bloom threshold.
        if (campusKind() == 14) {
          // Lamplit from below: brightest toward the dome's foot, falling off toward the apex; the lining's UVs are
          // metres round the dome and down from its apex. Its own paint is near black, so the sun through the slit
          // adds nothing: what shows is the lamplight.
          float down = clamp(vMapUv.y / 12.0, 0.0, 1.0);
          float cloth = 0.9 + 0.2 * texture2D(uSandMap, vMapUv * 0.2).g;
          // The tone is the lamplight in linear light (an amber that encodes to a deep orange, not peach); the ribs
          // carry a fraction of it and read dark against the lining.
          totalEmissiveRadiance += vColor.rgb * (0.15 + 0.85 * down * down) * cloth * uSlitLit;
        }
        if (campusKind() == 13) totalEmissiveRadiance += vColor.rgb * (0.9 * uPlateLit);
        // A school tower's lit lines and lamps: the tone is the tower's own emitter colour at its own level.
        if (campusKind() == 15) totalEmissiveRadiance += vColor.rgb;`,
      );
  };
  return m;
}
