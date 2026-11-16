/**
 * The far towers' shadows (Task 15). The sun's shadow map covers SHADOW_HALF
 * metres round the view's target, so from the wide home framing the towers
 * past it stood on unshaded ground. Each tower now has a baked contact
 * shadow: a soft dark tongue on the ground from its foot, away from the sun,
 * fading out along its length and across its edges. It shows only where the
 * shadow map does not reach (it fades in across the map's last quarter, in
 * the light's own frame), so it never doubles a real shadow. All of them are
 * one instanced draw in the view alone. The geometry is pure, so it is
 * tested in Node.
 */
import * as THREE from 'three';

import { LAYER, setLayers } from './lod.js';

/** The tongue: its length as a share of the tower's height (capped), its darkest alpha, and where its fade-in runs as shares of the shadow map's half width. */
export const CONTACT = { perHeight: 0.6, maxLength: 220, minLength: 40, strength: 0.42, fadeFrom: 0.75, fadeTo: 1.0, lift: 0.1 } as const;

export interface Foot {
  x: number;
  z: number;
  /** Half the tower's width at its foot, metres. */
  half: number;
  /** The tower's height, metres. */
  height: number;
}

/** The light's frame: the two axes across the sun's view (three's lookAt from the sun toward the target), as shadowColumn uses. */
export function lightAxes(sunDir: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const s = sunDir.clone().normalize();
  const m = new THREE.Matrix4().lookAt(s, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  return { u: new THREE.Vector3().setFromMatrixColumn(m, 0), v: new THREE.Vector3().setFromMatrixColumn(m, 1) };
}

/**
 * How much of a tower's contact shadow shows, 0 to 1: none while its foot
 * stands well inside the shadow map's box (centred on `at`, `half` metres
 * each way in the light's frame), all of it once past the box's edge.
 */
export function contactWeight(foot: { x: number; z: number }, at: { x: number; y: number; z: number }, axes: { u: THREE.Vector3; v: THREE.Vector3 }, half: number): number {
  const c = new THREE.Vector3(foot.x - at.x, -at.y, foot.z - at.z);
  const r = Math.max(Math.abs(c.dot(axes.u)), Math.abs(c.dot(axes.v))) / half;
  const t = Math.min(1, Math.max(0, (r - CONTACT.fadeFrom) / (CONTACT.fadeTo - CONTACT.fadeFrom)));
  return t * t * (3 - 2 * t);
}

/** The tongue's ground quad for a tower: its centre, its heading (radians about y, along the shadow) and its length and width. */
export function contactQuad(f: Foot, sunDir: THREE.Vector3): { x: number; z: number; heading: number; length: number; width: number } {
  const away = new THREE.Vector2(-sunDir.x, -sunDir.z).normalize();
  const length = Math.min(CONTACT.maxLength, Math.max(CONTACT.minLength, f.height * CONTACT.perHeight)) + f.half;
  // It starts half a width behind the foot's centre, so the whole footprint stands in it.
  const mid = length / 2 - f.half;
  return { x: f.x + away.x * mid, z: f.z + away.y * mid, heading: Math.atan2(away.x, away.y), length, width: f.half * 2.2 };
}

const VERTEX = /* glsl */ `
  uniform vec3 uShadowAt;
  uniform vec3 uLightU;
  uniform vec3 uLightV;
  uniform float uHalf;
  varying vec2 vUv;
  varying float vShow;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 foot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 c = foot.xyz - uShadowAt;
    float r = max(abs(dot(c, uLightU)), abs(dot(c, uLightV))) / uHalf;
    vShow = smoothstep(${CONTACT.fadeFrom.toFixed(3)}, ${CONTACT.fadeTo.toFixed(3)}, r);
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    if (vShow <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    #include <fog_vertex>
  }`;

const FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vShow;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    // Along: dark at the foot, gone by the tip. Across: soft at both edges.
    float along = pow(1.0 - vUv.y, 1.6);
    // Narrowing toward the tip, as a shadow's penumbra widens and its core thins with distance from what casts it.
    float across = 1.0 - smoothstep(0.55 - 0.35 * vUv.y, 1.0 - 0.25 * vUv.y, abs(vUv.x * 2.0 - 1.0));
    float a = ${CONTACT.strength.toFixed(3)} * along * across * vShow;
    // The haze over the ground hides a shadow as it hides the ground: the shadow thins by the haze's share.
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = hazeFactor(fogDensity, vFogDepth, hazeLayer(vFogWorld.y));
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      a *= 1.0 - fogFactor;
    #endif
    gl_FragColor = vec4(vec3(0.0), a);
  }`;

export interface ContactShadows {
  object: THREE.InstancedMesh;
  /** The towers standing now. */
  set(feet: Foot[]): void;
  /** The shadow map's centre this frame. */
  follow(at: THREE.Vector3): void;
  dispose(): void;
}

export function createContactShadows(sunDir: THREE.Vector3, half: number, cap = 256): ContactShadows {
  const geo = new THREE.PlaneGeometry(1, 1);
  // Flat on the ground, its v running from the foot (0) to the tip (1) along +z before the heading turns it.
  geo.rotateX(-Math.PI / 2);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) + 0.5, pos.getZ(i) + 0.5);
  const axes = lightAxes(sunDir);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uShadowAt: { value: new THREE.Vector3() }, uLightU: { value: axes.u }, uLightV: { value: axes.v }, uHalf: { value: half } }]),
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = 'contact-shadows';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Over the ground and the plazas, under everything drawn after them.
  mesh.renderOrder = 1;
  setLayers(mesh, LAYER.view);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  return {
    object: mesh,
    set(feet) {
      const n = Math.min(cap, feet.length);
      for (let i = 0; i < n; i++) {
        const t = contactQuad(feet[i], sunDir);
        q.setFromAxisAngle(up, t.heading);
        m.compose(new THREE.Vector3(t.x, CONTACT.lift, t.z), q, new THREE.Vector3(t.width, 1, t.length));
        mesh.setMatrixAt(i, m);
      }
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
    },
    follow(at) {
      (mat.uniforms.uShadowAt.value as THREE.Vector3).copy(at);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
