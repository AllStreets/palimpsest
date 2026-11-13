/**
 * The campus's one opaque material (site.ts explains the kinds): a
 * MeshStandardMaterial whose fragment picks a scan by `vKind`. The brick
 * scan is its own map; the limestone, ashlar and gravel scans come in as
 * uniforms (gravel is the sand scan at a fine tile); slate is coursed in the
 * shader, turf is mottled and striped, the lamp kind emits its tone, and the
 * dial kind is the exchange's painted clock dial, lit from behind after
 * sunset (the `uDialLit` uniform, which the material's userData exposes to
 * the clock tower). App only: it loads textures.
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
  };
  m.userData.dialLit = u.uDialLit;
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
        uniform sampler2D uDial; uniform float uDialLit;
        int campusKind() { return int(vKind + 0.5); }`,
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
          } else {
            // Turf: a mown lawn, mottled by the sand scan at a coarse tile and a finer one, with the mower's stripes.
            float a = texture2D(uSandMap, vMapUv * 0.13).g;
            float b = texture2D(uSandMap, vMapUv * 0.6).g;
            float f = texture2D(uSandMap, vMapUv * 3.1).g;
            float stripe = 0.95 + 0.05 * step(0.5, fract(vMapUv.x * 2.2));
            s = vec4(vec3((0.62 + 0.5 * a + 0.22 * b + 0.08 * f) * stripe), 1.0);
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
          else r = 0.96;
          roughnessFactor *= r;
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
          else if (ck == 6 || ck == 7 || ck == 8 || ck == 9) { mapN = vec3(0.5, 0.5, 1.0); }
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
        if (campusKind() == 6) totalEmissiveRadiance += vColor.rgb * 3.2;
        // The dials after sunset: opal glass lit from behind, warm, at the exchange's level, under the bloom threshold.
        if (campusKind() == 7) totalEmissiveRadiance += texture2D(uDial, vMapUv).rgb * vec3(1.0, 0.86, 0.62) * (0.62 * uDialLit);`,
      );
  };
  return m;
}
