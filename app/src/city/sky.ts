import * as THREE from 'three';

/** Where the sun sits, just under the horizon: the glow band and the key light both follow it. */
export const SUN_DIRECTION = new THREE.Vector3(-260, 40, 120).normalize();

/** A representative haze colour for the scene's fog object; the fog shader itself takes its colour from the sky per direction. */
export const HORIZON_FOG = new THREE.Color(0x58434c);

const VERTEX_DOME = /* glsl */ `
  varying vec3 vD;
  void main() {
    vD = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

const VERTEX_ENV = /* glsl */ `
  varying vec3 vD;
  void main() {
    vD = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * Haze brightness relative to the sky right at the horizon. At 1.0 fully
 * fogged ground meets the sky with no seam, as real inscattering does.
 */
const HAZE = 1.0;

/**
 * The sky as a function of direction, shared by the dome, the environment
 * map and the fog, so all three agree. `skyHaze` is the colour of the air at
 * the horizon in a given direction: warm toward the afterglow, violet away from it.
 */
const SKY_GLSL = /* glsl */ `
  const vec3 SKY_SUN = vec3(${SUN_DIRECTION.x.toFixed(5)}, ${SUN_DIRECTION.y.toFixed(5)}, ${SUN_DIRECTION.z.toFixed(5)});
  float skyHash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
  float skyNoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z); }
  float skySunFacing(vec3 d) {
    return max(dot(normalize(vec3(d.x, 0., d.z) + 1e-6), normalize(vec3(SKY_SUN.x, 0., SKY_SUN.z))), 0.);
  }
  vec3 skyClear(vec3 d) {
    float h = max(d.y, 0.0);
    float sd = skySunFacing(d);
    vec3 zen = vec3(0.035, 0.05, 0.11), mid = vec3(0.095, 0.105, 0.215), hor = vec3(0.95, 0.45, 0.22);
    vec3 c = mix(mid, zen, smoothstep(0.08, 0.55, h));
    float band = exp(-h*9.0) * (0.35 + 0.65*pow(sd, 3.0));
    c = mix(c, hor, clamp(band, 0., 1.));
    c += vec3(1.0, 0.55, 0.25) * pow(sd, 24.0) * exp(-h*14.0) * 1.4;
    return c;
  }
  vec3 skyHaze(vec3 d) {
    vec3 c = skyClear(vec3(d.x, 0.0, d.z)) * ${HAZE.toFixed(3)};
    return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.22);
  }
  vec3 skyColor(vec3 d) {
    vec3 c = skyClear(d);
    float h = max(d.y, 0.0);
    float sd = skySunFacing(d);
    float n = skyNoise(d*vec3(3.0, 14.0, 3.0)*2.0) * 0.6 + skyNoise(d*vec3(7.0, 30.0, 7.0)) * 0.4;
    float cl = smoothstep(0.55, 0.85, n) * smoothstep(0.03, 0.12, h) * smoothstep(0.5, 0.15, h);
    c = mix(c, mix(vec3(0.22,0.18,0.24), vec3(0.95,0.55,0.38), pow(sd, 2.0)*exp(-h*4.0)), cl*0.55);
    return mix(skyHaze(d), c, smoothstep(-0.005, 0.07, d.y));
  }`;

const FRAGMENT = /* glsl */ `
  varying vec3 vD;
  ${SKY_GLSL}
  void main(){ gl_FragColor = vec4(skyColor(normalize(vD)), 1.); }`;

/**
 * Replaces three's fog with fog whose colour is the sky's haze in the
 * direction of each fragment, so distant ground and buildings dissolve into
 * exactly the sky behind them at every bearing (one flat fog colour leaves a
 * seam wherever the sky is brighter). Density stays exponential squared.
 * Call before any material compiles.
 */
export function installSkyFog(): void {
  THREE.ShaderChunk.fog_pars_vertex = `
  #ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorld;
  #endif`;
  THREE.ShaderChunk.fog_vertex = `
  #ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
  #endif`;
  THREE.ShaderChunk.fog_pars_fragment = `
  #ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
    ${SKY_GLSL}
  #endif`;
  THREE.ShaderChunk.fog_fragment = `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, skyHaze(normalize(vFogWorld - cameraPosition)), fogFactor );
  #endif`;
}

function skyMaterial(vertexShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader,
    fragmentShader: FRAGMENT,
  });
}

export interface Sky {
  dome: THREE.Mesh;
  environment: THREE.Texture;
  dispose(): void;
}

/**
 * The dusk sky dome, plus an environment map rendered from the same sky (and
 * a warm ring for the lit city below) so every reflection agrees with what
 * the viewer sees. A bright daytime HDRI made titanium read as white plastic.
 */
export function createSky(renderer: THREE.WebGLRenderer): Sky {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(15000, 64, 32), skyMaterial(VERTEX_DOME));
  dome.renderOrder = -1;
  dome.frustumCulled = false;

  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), skyMaterial(VERTEX_ENV));
  envScene.add(envSky);
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(49, 49, 6, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x5a3a28, side: THREE.BackSide }),
  );
  glow.position.y = -3;
  envScene.add(glow);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  pmrem.dispose();
  for (const m of [envSky, glow]) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }

  return {
    dome,
    environment: target.texture,
    dispose() {
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      target.dispose();
    },
  };
}
