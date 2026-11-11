import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { passLayers } from './lod.js';

/** AO fades out between these view distances, in metres (lod.ts AO_NEAR leaves out what lies past the end). */
const AO_FADE_START = 350;
export const AO_FADE_END = 1200;

/**
 * Screen-space AO has nothing to say about a building a kilometre away, and
 * at grazing angles on distant ground its depth precision runs out and it
 * draws a dark line along the horizon. Fade it out with distance instead.
 */
function fadeWithDistance(gtao: GTAOPass, camera: THREE.PerspectiveCamera): void {
  const m = gtao.blendMaterial;
  m.uniforms.tDepth = { value: gtao.depthTexture };
  m.uniforms.cameraNear = { value: camera.near };
  m.uniforms.cameraFar = { value: camera.far };
  m.fragmentShader = /* glsl */ `
    #include <packing>
    uniform float intensity;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      float viewZ = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).x, cameraNear, cameraFar);
      float k = intensity * (1.0 - smoothstep(${AO_FADE_START.toFixed(1)}, ${AO_FADE_END.toFixed(1)}, viewZ));
      gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, k), texel.a);
    }`;
  m.needsUpdate = true;
}

/** Bloom catches only what is brighter than this in the linear HDR frame: real emitters, never lit paint. */
export const BLOOM_THRESHOLD = 0.97;
/** The renderer's exposure (scene.ts), which the threshold is measured after. */
export const EXPOSURE = 0.85;

/**
 * The budget for flickering lights (a welder's arc on a job site, Task 26):
 * how many point lights the city keeps (a fixed pool, so a light switching on
 * never recompiles every material in the city), and how bright one may get.
 * The peak is set so the steel a welder works on, two metres from the arc,
 * stays just under the bloom threshold: the arc itself and its sparks bloom,
 * the beams round it are lit by it without glowing. A lit surface's radiance
 * is I / d^2 * albedo / pi, times the exposure; primer steel's albedo is
 * about 0.25 and the brightest metal deck about 0.6.
 */
export const FLICKER = (() => {
  const lights = 2;
  const distance = 26;
  const albedo = 0.6;
  const d = 2;
  const peak = Math.floor((BLOOM_THRESHOLD * Math.PI * d * d) / (albedo * EXPOSURE));
  return { lights, distance, peak, color: 0xc4dcff } as const;
})();

/**
 * The work floodlights on a job site's deck (Task 26): a warm high-pressure
 * sodium white that lights the frame, the crane's mast and the netting round
 * it, and nothing else in the city. Steel three metres from a head stays just
 * under the bloom threshold, so the lenses bloom and the frame they light
 * does not. They switch with the site's stage, never on a timer.
 */
export const FLOOD = (() => {
  const albedo = 0.6;
  const d = 3;
  const peak = Math.floor((BLOOM_THRESHOLD * Math.PI * d * d) / (albedo * EXPOSURE));
  return { peak, distance: 34, color: 0xffb066 } as const;
})();

export interface Post {
  render(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Post chain: scene into a multisampled HDR target, ground-truth ambient
 * occlusion (high quality only), bloom that only catches real emitters
 * (threshold 0.97: at 0.82 saturated paint glowed like neon), then ACES
 * tone mapping and sRGB output.
 */
export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: 'high' | 'medium',
  /** Passes drawn straight after the scene, before AO and bloom (the river's water, which reads the frame and its depth). */
  after: Pass[] = [],
): Post {
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * ratio, size.y * ratio, {
    type: THREE.HalfFloatType,
    // At retina density the pixels themselves antialias; multisampling there costs a quarter of the frame rate.
    samples: quality === 'high' && ratio < 1.5 ? 4 : 0,
  });
  // The frame keeps its depth, for the water's reflections (river.ts); the composer's second buffer gets its own copy.
  target.depthTexture = new THREE.DepthTexture(size.x * ratio, size.y * ratio);
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));
  for (const p of after) composer.addPass(p);

  let gtao: GTAOPass | null = null;
  // The AO draws its normals and depth through its own camera, which follows the view's but sees the AO's
  // layers (lod.ts): the blocks near enough for it to show, never what only the view or the shadow map draws.
  const aoCamera = new THREE.PerspectiveCamera();
  const aoLayers = passLayers().ao;
  if (quality === 'high') {
    gtao = new GTAOPass(scene, aoCamera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    // City scale: a metre and a half of reach finds the contact shadow where walls meet pavement.
    gtao.updateGtaoMaterial({ radius: 1.5, distanceExponent: 2, thickness: 3, scale: 1 });
    fadeWithDistance(gtao, camera);
    composer.addPass(gtao);
  }

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.5, BLOOM_THRESHOLD);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    render() {
      if (gtao) {
        camera.updateMatrixWorld();
        aoCamera.copy(camera, false);
        aoCamera.layers.mask = aoLayers.mask;
      }
      composer.render();
    },
    setSize(width, height) {
      composer.setSize(width, height);
    },
    dispose() {
      for (const p of after) p.dispose();
      gtao?.dispose();
      bloom.dispose();
      composer.dispose();
      target.dispose();
    },
  };
}
