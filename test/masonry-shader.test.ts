import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { patchMasonryShader } from '../app/src/city/campus/masonry-shader.js';
import { lightsOutLit } from '../app/src/city/lightsout.js';

/** The include markers a MeshStandardMaterial's shaders carry, in their order, which both patches rewrite. */
const fake = (): THREE.WebGLProgramParametersWithUniforms =>
  ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n}',
  }) as unknown as THREE.WebGLProgramParametersWithUniforms;

test("the masonry's bare emitter kind goes out where the power is off, with the lights-out term declared before it", () => {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  m.customProgramCacheKey = () => 'palimpsest-campus-masonry';
  m.onBeforeCompile = (sh) => patchMasonryShader(sh);
  lightsOutLit(m);
  assert.equal(m.userData.lightsOut, true, 'the masonry takes the dust patch, as a school tower in a dark quarter needs');
  const sh = fake();
  m.onBeforeCompile(sh, null as unknown as THREE.WebGLRenderer);
  const f = sh.fragmentShader;
  const use = f.indexOf('vColor.rgb * (1.0 - lightsOut(vOutW))');
  assert.ok(use > 0, 'kind 15 emits its tone scaled by the zone level');
  assert.ok(f.indexOf('float lightsOut(vec3 w)') < use, 'the term is declared before the emitter reads it');
  assert.ok(f.includes('varying vec3 vOutW;') && sh.vertexShader.includes('vOutW ='), 'the world position reaches the fragment');
  assert.ok(f.includes('campusKind() == 15'), 'the kind is still picked by the attribute');
  assert.ok('uOutZone' in sh.uniforms && 'uOutCount' in sh.uniforms, 'the shared zone uniforms are bound');
  assert.ok(m.customProgramCacheKey().endsWith('|out'));
});
