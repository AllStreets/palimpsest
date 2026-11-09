import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** AO fades out between these view distances, in metres. */
const AO_FADE_START = 350;
const AO_FADE_END = 1200;

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
): Post {
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * ratio, size.y * ratio, {
    type: THREE.HalfFloatType,
    // At retina density the pixels themselves antialias; multisampling there costs a quarter of the frame rate.
    samples: quality === 'high' && ratio < 2 ? 4 : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));

  let gtao: GTAOPass | null = null;
  if (quality === 'high') {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    // City scale: a metre and a half of reach finds the contact shadow where walls meet pavement.
    gtao.updateGtaoMaterial({ radius: 1.5, distanceExponent: 2, thickness: 3, scale: 1 });
    fadeWithDistance(gtao, camera);
    composer.addPass(gtao);
  }

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.5, 0.97);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    render: () => composer.render(),
    setSize(width, height) {
      composer.setSize(width, height);
    },
    dispose() {
      gtao?.dispose();
      bloom.dispose();
      composer.dispose();
      target.dispose();
    },
  };
}
