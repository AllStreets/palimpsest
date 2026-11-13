/**
 * The campus's one opaque material (site.ts explains the kinds): a
 * MeshStandardMaterial whose fragment picks a scan by `vKind`. The brick
 * scan is its own map; the limestone, ashlar and gravel scans come in as
 * uniforms (gravel is the sand scan at a fine tile); slate and turf are flat tones with a little relief borrowed from
 * the brick and sand normals. App only: it loads textures.
 */
import * as THREE from 'three';

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
    uPaveMap: { value: texture('pave_diff.jpg', true) },
    uPaveNor: { value: texture('pave_nor.jpg') },
    uPaveArm: { value: texture('pave_arm.jpg') },
  };
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
        uniform sampler2D uPaveMap; uniform sampler2D uPaveNor; uniform sampler2D uPaveArm;
        int campusKind() { return int(vKind + 0.5); }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          int ck = campusKind();
          vec4 s;
          if (ck == 0) s = texture2D(map, vMapUv);
          else if (ck == 1) s = texture2D(uSandMap, vMapUv);
          else if (ck == 3) s = texture2D(uAshMap, vMapUv);
          else if (ck == 5) s = texture2D(uSandMap, vMapUv);
          else if (ck == 2) {
            // Slate: courses from the brick scan's shading, a worn sheen on the ridge of each slate.
            float c = texture2D(map, vMapUv).g;
            s = vec4(vec3(0.8 + 0.4 * c), 1.0);
          } else {
            // Turf: a mown lawn, mottled by the sand scan at a coarse tile, never flat.
            float a = texture2D(uSandMap, vMapUv * 0.37).g;
            float b = texture2D(uSandMap, vMapUv * 2.9).g;
            s = vec4(vec3(0.78 + 0.3 * a + 0.1 * b), 1.0);
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
          else if (ck == 2) r = 0.72 + 0.2 * texture2D(roughnessMap, vRoughnessMapUv).g;
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
          else if (ck == 5) { mapN = texture2D(uSandNor, vNormalMapUv).xyz; k = 0.9; }
          else if (ck == 2) { mapN = texture2D(normalMap, vNormalMapUv).xyz; k = 0.35; }
          else { mapN = texture2D(uSandNor, vNormalMapUv * 2.9).xyz; k = 0.3; }
          mapN = mapN * 2.0 - 1.0;
          mapN.xy *= normalScale * k;
          normal = normalize( tbn * mapN );
        }
        #endif`,
      );
  };
  return m;
}
