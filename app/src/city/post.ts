import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
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
  m.uniforms.uTan = { value: new THREE.Vector2() };
  m.fragmentShader = /* glsl */ `
    #include <packing>
    uniform float intensity;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec2 uTan;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      float viewZ = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).x, cameraNear, cameraFar);
      // Distance from the eye, not depth: the AO is gone at the same range across the frame, so what lies past
      // that range can leave the AO pass (lod.ts AO_NEAR).
      vec2 ndc = vUv * 2.0 - 1.0;
      float dist = viewZ * length(vec3(1.0, ndc * uTan));
      float k = intensity * (1.0 - smoothstep(${AO_FADE_START.toFixed(1)}, ${AO_FADE_END.toFixed(1)}, dist));
      gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, k), texel.a);
    }`;
  m.needsUpdate = true;
}

/**
 * Past AO_FADE_END the blend above takes none of the AO, yet the AO and its
 * denoise were worked out for every pixel there (the far ground, the water
 * and the city to the horizon), which on high was the frame's margin under
 * 16.7 ms (Task 13). Both passes now leave those pixels as they leave the
 * sky (discarded, the clear's white: no occlusion), from a quarter past the
 * fade's end, so every pixel the blend still takes AO for reads the same
 * neighbours with the same weights (the denoise weighs a neighbour by its
 * depth along the pixel's normal, so one that far behind counts for nothing).
 * The frame is unchanged; only the work behind it goes.
 */
export const AO_SKIP = AO_FADE_END * 1.25;
function skipPastFade(gtao: GTAOPass): void {
  const at = 'vec3 viewPos = getViewPosition(vUv, depth);';
  const skip = `${at}\n      if (length(viewPos) > ${AO_SKIP.toFixed(1)}) { discard; return; }`;
  for (const m of [gtao.gtaoMaterial, gtao.pdMaterial]) {
    if (!m.fragmentShader.includes(at)) throw new Error('GTAOPass: its shaders changed; post.ts skipPastFade needs a new anchor');
    m.fragmentShader = m.fragmentShader.replace(at, skip);
    m.needsUpdate = true;
  }
}

/** Bloom catches only what is brighter than this in the linear HDR frame: real emitters, never lit paint. */
export const BLOOM_THRESHOLD = 0.97;
/** The renderer's exposure (scene.ts), which the threshold is measured after. */
export const EXPOSURE = 0.85;
/**
 * The brightest the sky may be in the HDR frame, the sun's glow included
 * (sky.ts skyCap): under the bloom threshold, so the sky itself never reaches
 * the bloom pass and a low view toward the sun keeps its upper right. The
 * glow still rises toward the sun through a soft knee; only emitters bloom.
 */
export const SUN_BLOOM_MAX = 0.94;

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

/**
 * The ambient traffic's headlamps (Task 32): how many pools of light the
 * streets carry at once, how far from the eye they are laid, and how bright
 * one lays on the road. Pools are additive; four overlapping (a queue at a
 * light, nose to tail) stay under the bloom threshold, so a lit road never
 * glows like an emitter: only the lamps themselves bloom. The colour is a
 * warm LED white, a touch cooler than the sodium street lamps.
 */
export const HEADLAMP = (() => {
  const pools = 160;
  const reach = 240;
  const overlap = 4;
  const peak = Math.floor((BLOOM_THRESHOLD / (EXPOSURE * overlap)) * 1000) / 1000;
  return { pools, reach, peak, colour: [1.0, 0.92, 0.8] as [number, number, number] } as const;
})();

/**
 * The dome's dither (sky.ts), in linear units before tone mapping: a dusk
 * gradient at 8 bits steps into bands without it. The lens's composite lays
 * the same dither again over what it blurs, since a blur averages it away.
 */
export const SKY_DITHER = 0.6 / 255;

// ---------------------------------------------------------------- the lens (Phase 5 Task 11, ruling 16)

/** The close modes the lens focuses in: the ride, following a figure, a tour stop, the inspector's close tower view. */
export type FocusMode = 'ride' | 'follow' | 'tour' | 'inspect';

/**
 * The lens's depth of field. Off past `reach` metres from the subject; on
 * and off over `ease` seconds. The background's blur (the circle of
 * confusion at infinity, as a share of the frame's height) is `blur` up to
 * `close` metres and falls as (close / d)^`falloff` beyond, as a lens of
 * fixed glass stopped down with the focus distance would, then closes to
 * nothing from `fade` to `reach`, so the lens never pops off. The near
 * field may blur `nearCap` times the background's (so the gather's reach,
 * and its cost, is the background's circle); no circle passes
 * `maxRadius` half-resolution pixels. The autofocus settles over `settle`
 * seconds when the subject's depth changes under it.
 */
export const DOF = { reach: 160, ease: 0.6, close: 12, blur: 0.0065, falloff: 0.5, fade: 110, nearCap: 1, maxRadius: 14, settle: 0.12 } as const;

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** The background's blur radius (the circle of confusion at infinity) with the focus at `distance` metres, as a share of the frame's height. */
export function cocInfinity(distance: number): number {
  if (!(distance > 0) || distance >= DOF.reach) return 0;
  const stop = Math.pow(Math.min(1, DOF.close / distance), DOF.falloff);
  return DOF.blur * stop * (1 - smooth01((distance - DOF.fade) / (DOF.reach - DOF.fade)));
}

/** Which close mode the camera is in: a scripted path's own (the ride, the tour) over following a figure over the inspector; none from home or the overview. */
export function focusModeFor(o: { script: 'ride' | 'tour' | null; following: boolean; inspecting: boolean }): FocusMode | null {
  return o.script ?? (o.following ? 'follow' : o.inspecting ? 'inspect' : null);
}

export interface LensState {
  mode: FocusMode | null;
  /** Whether the lens draws this frame (any blur at all). */
  on: boolean;
  /** How far on, 0 to 1, eased. */
  amount: number;
  /** The subject's distance the focus holds, in metres. */
  distance: number;
  /** The background's blur now, as a share of the frame's height (cocInfinity times the amount). */
  blur: number;
}

/**
 * The lens's state from frame to frame: on in a close mode on high within
 * DOF.reach of the subject, eased on and off over DOF.ease seconds, the
 * focus held on the last subject while it eases off. Never on at medium.
 */
export function createLens(quality: 'high' | 'medium'): { set(o: { mode: FocusMode | null; distance: number }): void; step(dt: number): LensState; state(): LensState } {
  let mode: FocusMode | null = null;
  let subject = 0;
  let held = 0;
  let t = 0;
  const state = (): LensState => {
    const amount = smooth01(t);
    return { mode, on: amount > 0, amount, distance: held, blur: cocInfinity(held) * amount };
  };
  return {
    set(o) {
      mode = o.mode;
      subject = o.distance;
    },
    step(dt) {
      const want = quality === 'high' && mode !== null && cocInfinity(subject) > 0;
      if (want) held = subject;
      t = Math.min(1, Math.max(0, t + ((want ? 1 : -1) * Math.max(0, dt)) / DOF.ease));
      return state();
    },
    state,
  };
}

const LENS_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** The view depth (metres along the axis) from the frame's depth; the sky stands at a million. */
const VIEW_DEPTH = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  float viewDepth(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return d >= 0.999999 ? 1e6 : -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
  }`;

/** A thin lens's signed circle of confusion, in half-resolution pixels: negative nearer than the focus, positive beyond, uInf at infinity. */
const COC = /* glsl */ `
  uniform float uInf;
  uniform float uNearMax;
  uniform float uFarMax;
  float cocAt(float z, float zf) {
    return clamp(uInf * (1.0 - zf / z), -uNearMax, uFarMax);
  }`;

/**
 * The autofocus, one pixel: the nearest surface within the subject's depth
 * window over a 5 by 5 cluster round where the subject stands on screen
 * (so the focus lands on the tower's face, not its axis, and on the figure,
 * not the street behind it), eased from the last frame's.
 */
export const LENS_FOCUS_GLSL = /* glsl */ `
  ${VIEW_DEPTH}
  uniform sampler2D tPrev;
  uniform vec2 uAt;
  uniform vec2 uSpread;
  uniform float uGuess;
  uniform float uKeep;
  varying vec2 vUv;
  void main() {
    float best = 1e6;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        float z = viewDepth(clamp(uAt + vec2(float(i), float(j)) * uSpread, vec2(0.001), vec2(0.999)));
        if (z > uGuess * 0.5 && z < uGuess * 1.15) best = min(best, z);
      }
    }
    float measured = best < 1e5 ? best : uGuess;
    float prev = texture2D(tPrev, vec2(0.5)).r;
    gl_FragColor = vec4(mix(prev, measured, uKeep), 0.0, 0.0, 1.0);
  }`;

/**
 * Half resolution: each texel takes the nearest of its four pixels' surfaces
 * and averages only the pixels on it, so a texel on a tower's edge is the
 * tower's and never a mix of tower and sky (the mix is what haloes); the
 * alpha holds that surface's circle of confusion.
 */
export const LENS_DOWN_GLSL = /* glsl */ `
  ${VIEW_DEPTH}
  ${COC}
  uniform sampler2D tColor;
  uniform sampler2D tFocus;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float zf = texture2D(tFocus, vec2(0.5)).r;
    vec2 a = vUv + vec2(-0.5, -0.5) * uTexel;
    vec2 b = vUv + vec2(0.5, -0.5) * uTexel;
    vec2 c = vUv + vec2(-0.5, 0.5) * uTexel;
    vec2 e = vUv + vec2(0.5, 0.5) * uTexel;
    vec4 z = vec4(viewDepth(a), viewDepth(b), viewDepth(c), viewDepth(e));
    float near = min(min(z.x, z.y), min(z.z, z.w));
    vec4 w = step(z, vec4(near * 1.04 + 0.05));
    vec3 col = texture2D(tColor, a).rgb * w.x + texture2D(tColor, b).rgb * w.y + texture2D(tColor, c).rgb * w.z + texture2D(tColor, e).rgb * w.w;
    gl_FragColor = vec4(col / max(dot(w, vec4(1.0)), 1.0), cocAt(near, zf));
  }`;

/**
 * The bokeh, at half resolution: a scatter-as-gather over a golden-angle
 * spiral (Gustafsson), each sample counted only where its own circle covers
 * the centre, and a sample behind the centre never spreading wider than
 * twice the centre's own circle. So a sharp tower's edge keeps out the sky's
 * blur and the sky's blur takes nothing of the tower: no halo either way;
 * a lit window out of focus spreads to a disc its own size.
 */
export const LENS_GATHER_GLSL = /* glsl */ `
  uniform sampler2D tHalf;
  uniform vec2 uHalfTexel;
  uniform float uRadius;
  varying vec2 vUv;
  const float RING = 0.6;
  // The golden angle's turn, applied to a unit vector sample by sample.
  const mat2 TURN = mat2(-0.73736887, 0.67549029, -0.67549029, -0.73736887);
  void main() {
    vec4 c0 = texture2D(tHalf, vUv);
    float cc = c0.a;
    float cs = abs(cc);
    vec3 acc = c0.rgb;
    float tot = 1.0;
    float r = RING;
    vec2 dir = vec2(1.0, 0.0);
    for (int i = 0; i < 400; i++) {
      if (r > uRadius) break;
      vec4 s = texture2D(tHalf, vUv + dir * uHalfTexel * r);
      float ss = abs(s.a);
      if (s.a > cc) ss = min(ss, cs * 2.0);
      float m = smoothstep(r - 0.5, r + 0.5, ss);
      acc += mix(acc / tot, s.rgb, m);
      tot += 1.0;
      r += RING / r;
      dir = TURN * dir;
    }
    gl_FragColor = vec4(acc / tot, cc);
  }`;

/**
 * The fill, at half resolution: a tent over the bokeh's eight neighbours
 * that lie on the same surface (their circles close to the centre's), where
 * the circle is wider than a texel. The spiral strikes a lit window a few
 * times, not everywhere over its disc; the tent fills the disc in, so a lamp
 * out of focus reads as a soft disc and not a speckle of dots.
 */
export const LENS_FILL_GLSL = /* glsl */ `
  uniform sampler2D tBokeh;
  uniform vec2 uHalfTexel;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tBokeh, vUv);
    float cs = abs(c.a);
    if (cs < 1.0) {
      gl_FragColor = c;
      return;
    }
    vec3 acc = c.rgb * 4.0;
    float tot = 4.0;
    float reach = max(1.0, cs * 0.5);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        if (i == 0 && j == 0) continue;
        vec4 s = texture2D(tBokeh, vUv + vec2(float(i), float(j)) * uHalfTexel);
        float wt = (i == 0 || j == 0 ? 2.0 : 1.0) * step(abs(s.a - c.a), reach);
        acc += s.rgb * wt;
        tot += wt;
      }
    }
    gl_FragColor = vec4(acc / tot, c.a);
  }`;

/**
 * Full resolution: each pixel's own circle decides how much of the bokeh
 * it takes, read from the four nearest half-resolution texels weighted by
 * how near their circles are to its own (a joint bilateral upsample), so a
 * sky pixel beside a sharp tower takes only the sky's blur. What it blurs
 * takes the sky's dither again (SKY_DITHER): the blur averaged the dome's
 * own away, and the dusk gradient would band at 8 bits without it.
 */
export const LENS_COMPOSITE_GLSL = /* glsl */ `
  ${VIEW_DEPTH}
  ${COC}
  uniform sampler2D tDiffuse;
  uniform sampler2D tFocus;
  uniform sampler2D tBlur;
  uniform vec2 uHalfSize;
  varying vec2 vUv;
  float lensDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    vec4 sharp = texture2D(tDiffuse, vUv);
    float zf = texture2D(tFocus, vec2(0.5)).r;
    float c = cocAt(viewDepth(vUv), zf);
    float k = smoothstep(0.3, 1.0, abs(c));
    if (k <= 0.0) {
      gl_FragColor = sharp;
      return;
    }
    vec2 hp = vUv * uHalfSize - 0.5;
    vec2 f = fract(hp);
    vec2 o = 1.0 / uHalfSize;
    vec2 base = (floor(hp) + 0.5) * o;
    vec4 s00 = texture2D(tBlur, base);
    vec4 s10 = texture2D(tBlur, base + vec2(o.x, 0.0));
    vec4 s01 = texture2D(tBlur, base + vec2(0.0, o.y));
    vec4 s11 = texture2D(tBlur, base + o);
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) + 1e-3;
    w /= vec4(0.1) + abs(vec4(s00.a, s10.a, s01.a, s11.a) - c);
    vec3 blur = (s00.rgb * w.x + s10.rgb * w.y + s01.rgb * w.z + s11.rgb * w.w) / dot(w, vec4(1.0));
    vec3 col = mix(sharp.rgb, blur, k) + (lensDither(gl_FragCoord.xy) - 0.5) * ${SKY_DITHER.toFixed(6)} * k;
    gl_FragColor = vec4(col, sharp.a);
  }`;

/** Every shader of the lens, for the checks on their names. */
export const LENS_GLSL = [LENS_FOCUS_GLSL, LENS_DOWN_GLSL, LENS_GATHER_GLSL, LENS_FILL_GLSL, LENS_COMPOSITE_GLSL];

/** Notes the scene's depth where the scene pass drew it (the composer's buffers swap from frame to frame). */
class DepthTap extends Pass {
  depth: THREE.DepthTexture | null = null;
  constructor() {
    super();
    this.needsSwap = false;
  }
  render(_r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.depth = readBuffer.depthTexture;
  }
}

function lensMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: LENS_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

/**
 * The lens's pass: the autofocus, the half-resolution surfaces, the bokeh,
 * its fill and the composite. It draws only while the lens is on (the composer skips
 * a disabled pass), so from home it costs nothing.
 */
class LensPass extends Pass {
  // The surfaces are read filtered by the gather (a nearest read steps the bokeh into a mosaic of half-resolution
  // blocks); the composite reads the bokeh texel by texel and weighs its four itself.
  private half = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  private bokeh = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private focus = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
  private ping = 0;
  private quads: FullScreenQuad[];
  private mFocus: THREE.ShaderMaterial;
  private mDown: THREE.ShaderMaterial;
  private mGather: THREE.ShaderMaterial;
  private mFill: THREE.ShaderMaterial;
  private mComposite: THREE.ShaderMaterial;
  /** Snap the autofocus to what it measures (the lens has just come on), else ease by this share. */
  keep = 1;
  /** The background's blur as a share of the frame's height, the subject's axial depth and where it stands on screen (uv). */
  blur = 0;
  guess = 1;
  at = new THREE.Vector2(0.5, 0.5);
  constructor(private tap: DepthTap, private camera: THREE.PerspectiveCamera) {
    super();
    this.needsSwap = true;
    const depthU = (): Record<string, THREE.IUniform> => ({ tDepth: { value: null }, cameraNear: { value: 0.5 }, cameraFar: { value: 20000 } });
    const cocU = (): Record<string, THREE.IUniform> => ({ uInf: { value: 0 }, uNearMax: { value: 0 }, uFarMax: { value: 0 } });
    this.mFocus = lensMaterial(LENS_FOCUS_GLSL, { ...depthU(), tPrev: { value: null }, uAt: { value: new THREE.Vector2() }, uSpread: { value: new THREE.Vector2() }, uGuess: { value: 1 }, uKeep: { value: 1 } });
    this.mDown = lensMaterial(LENS_DOWN_GLSL, { ...depthU(), ...cocU(), tColor: { value: null }, tFocus: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mGather = lensMaterial(LENS_GATHER_GLSL, { tHalf: { value: null }, uHalfTexel: { value: new THREE.Vector2() }, uRadius: { value: 0 } });
    this.mFill = lensMaterial(LENS_FILL_GLSL, { tBokeh: { value: null }, uHalfTexel: { value: new THREE.Vector2() } });
    this.mComposite = lensMaterial(LENS_COMPOSITE_GLSL, { ...depthU(), ...cocU(), tDiffuse: { value: null }, tFocus: { value: null }, tBlur: { value: null }, uHalfSize: { value: new THREE.Vector2() } });
    this.quads = [this.mFocus, this.mDown, this.mGather, this.mFill, this.mComposite].map((m) => new FullScreenQuad(m));
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const depth = this.tap.depth ?? readBuffer.depthTexture;
    const w = readBuffer.width;
    const h = readBuffer.height;
    const hw = Math.max(1, Math.ceil(w / 2));
    const hh = Math.max(1, Math.ceil(h / 2));
    if (this.half.width !== hw || this.half.height !== hh) {
      this.half.setSize(hw, hh);
      this.bokeh.setSize(hw, hh);
    }
    const inf = this.blur * hh;
    const nearMax = Math.min(inf * DOF.nearCap, DOF.maxRadius);
    const farMax = Math.min(inf, DOF.maxRadius);
    for (const m of [this.mFocus, this.mDown, this.mComposite]) {
      m.uniforms.tDepth.value = depth;
      m.uniforms.cameraNear.value = this.camera.near;
      m.uniforms.cameraFar.value = this.camera.far;
    }
    for (const m of [this.mDown, this.mComposite]) {
      m.uniforms.uInf.value = inf;
      m.uniforms.uNearMax.value = nearMax;
      m.uniforms.uFarMax.value = farMax;
    }
    // The autofocus: one pixel, read back by the passes after it (never by the CPU).
    const prev = this.focus[this.ping];
    const next = this.focus[1 - this.ping];
    this.ping = 1 - this.ping;
    const uf = this.mFocus.uniforms;
    uf.tPrev.value = prev.texture;
    (uf.uAt.value as THREE.Vector2).copy(this.at);
    (uf.uSpread.value as THREE.Vector2).set(8 / w, 8 / h);
    uf.uGuess.value = this.guess;
    uf.uKeep.value = this.keep;
    renderer.setRenderTarget(next);
    this.quads[0].render(renderer);
    // Half resolution, then the bokeh.
    const ud = this.mDown.uniforms;
    ud.tColor.value = readBuffer.texture;
    ud.tFocus.value = next.texture;
    (ud.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    renderer.setRenderTarget(this.half);
    this.quads[1].render(renderer);
    const ug = this.mGather.uniforms;
    ug.tHalf.value = this.half.texture;
    (ug.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    ug.uRadius.value = Math.max(nearMax, farMax) + 0.5;
    renderer.setRenderTarget(this.bokeh);
    this.quads[2].render(renderer);
    // The fill, back into the surfaces' target (the gather is done with it).
    const ui = this.mFill.uniforms;
    ui.tBokeh.value = this.bokeh.texture;
    (ui.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    renderer.setRenderTarget(this.half);
    this.quads[3].render(renderer);
    // The composite into the frame (it reads the filled bokeh at texel centres, so the target's filter changes nothing).
    const uc = this.mComposite.uniforms;
    uc.tDiffuse.value = readBuffer.texture;
    uc.tFocus.value = next.texture;
    uc.tBlur.value = this.half.texture;
    (uc.uHalfSize.value as THREE.Vector2).set(hw, hh);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quads[4].render(renderer);
  }
  dispose(): void {
    this.half.dispose();
    this.bokeh.dispose();
    for (const f of this.focus) f.dispose();
    for (const q of this.quads) {
      q.material.dispose();
      q.dispose();
    }
  }
}

export interface Post {
  /** Draws the frame; `dt` (seconds) eases the lens. */
  render(dt?: number): void;
  /**
   * The lens's subject this frame (ruling 16): the close mode the camera is
   * in, or null, and how far the subject stands; `at`, where it stands, lets
   * the autofocus find its surface.
   */
  setFocus(o: { mode: FocusMode | null; distance: number; at?: THREE.Vector3 }): void;
  /** The lens as it stands: its state and the axial depth the focus was last aimed at. */
  lens(): LensState & { focus: number };
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Post chain: scene into a multisampled HDR target, ground-truth ambient
 * occlusion (high quality only), bloom that only catches real emitters
 * (threshold 0.97: at 0.82 saturated paint glowed like neon), then ACES
 * tone mapping and sRGB output. On high, in the four close modes, the lens's
 * depth of field sits between the AO and the bloom (setFocus).
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
  // The depth as the scene drew it, for the lens alone: on medium there is no lens, so nothing taps it.
  const tap = quality === 'high' ? new DepthTap() : null;
  if (tap) composer.addPass(tap);
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
    skipPastFade(gtao);
    composer.addPass(gtao);
  }

  // The lens (high only) after the AO and before the bloom, as glass sits before the sensor: an emitter out of focus
  // spreads to its disc first and blooms as the disc.
  const lens = createLens(quality);
  const lensPass = tap ? new LensPass(tap, camera) : null;
  if (lensPass) {
    lensPass.enabled = false;
    composer.addPass(lensPass);
  }
  let subjectAt: THREE.Vector3 | null = null;
  let aimed = 0;
  const lensWas = { on: false };
  const projected = new THREE.Vector3();

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.5, BLOOM_THRESHOLD);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // The lens's shaders compile now, with the city, and not on the first close-up (a compile there costs frames).
  if (lensPass) {
    lensPass.render(renderer, composer.renderTarget2, composer.renderTarget1);
    renderer.setRenderTarget(null);
  }

  return {
    setFocus(o) {
      lens.set(o);
      subjectAt = o.at ?? null;
    },
    lens: () => ({ ...lens.state(), focus: aimed }),
    render(dt = 0) {
      const st = lens.step(dt);
      if (lensPass) {
        lensPass.enabled = st.on;
        if (st.on) {
          camera.updateMatrixWorld();
          // The subject's axial depth and its place on screen (the inspector's offset view included).
          if (subjectAt) {
            projected.copy(subjectAt).applyMatrix4(camera.matrixWorldInverse);
            aimed = Math.max(camera.near, -projected.z);
            projected.copy(subjectAt).project(camera);
            lensPass.at.set(THREE.MathUtils.clamp(projected.x * 0.5 + 0.5, 0, 1), THREE.MathUtils.clamp(projected.y * 0.5 + 0.5, 0, 1));
          } else {
            aimed = st.distance;
            lensPass.at.set(0.5, 0.5);
          }
          lensPass.guess = aimed;
          lensPass.blur = st.blur;
          lensPass.keep = lensWas.on ? 1 - Math.exp(-Math.max(dt, 1 / 240) / DOF.settle) : 1;
        }
        lensWas.on = st.on;
      }
      if (gtao) {
        camera.updateMatrixWorld();
        aoCamera.copy(camera, false);
        aoCamera.layers.mask = aoLayers.mask;
        const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        (gtao.blendMaterial.uniforms.uTan.value as THREE.Vector2).set(t * camera.aspect, t);
        gtao.blendMaterial.uniforms.cameraFar.value = camera.far;
      }
      composer.render();
    },
    setSize(width, height) {
      composer.setSize(width, height);
    },
    dispose() {
      for (const p of after) p.dispose();
      gtao?.dispose();
      lensPass?.dispose();
      bloom.dispose();
      composer.dispose();
      target.dispose();
    },
  };
}
