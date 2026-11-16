/**
 * The street's traffic signals as they stand (Phase 5 Task 4): at every
 * junction with signals (ambient.ts, signals.ts) a pole on each corner of
 * the pavement, just behind the kerb, carrying one three-aspect head that
 * faces the traffic coming up on that side (right-hand traffic: the near
 * kerb's corner to the right of the approach). Each head shows its
 * approach's light as the cycle says, red over amber over green, the dark
 * aspects a smoked glass; the lit one is an emitter just under the bloom
 * threshold, so it reads as a lamp at a distance and does not glow.
 *
 * Drawn in two instanced calls: the poles and housings in a dark painted
 * steel, the lenses in one emissive material whose instance attribute says
 * which aspect is lit. Within SIGNAL_LOD.far of the eye only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { LAYER, setLayers } from './lod.js';
import { signalPhase, type Axis, type SignalJunction, type Signals, type SignalPhase } from './signals.js';

/** The pole's corner: this far off both streets' centre lines (the kerb at 4 m, a little back on the paving). */
export const SIGNAL_CORNER = 4.75;
/** The head's height over the pavement (the middle aspect), and the lens radius. */
const HEAD_Y = 3.05;
const LENS = 0.105;
/** Signals draw within this of the eye (a lit aspect reads well past it, a pole does not). */
export const SIGNAL_LOD = { far: 700 } as const;
/** The lit aspects' radiance: each a little under the bloom threshold after exposure (post.ts BLOOM_THRESHOLD). */
const LIT: Record<'red' | 'amber' | 'green', THREE.Color> = {
  red: new THREE.Color(0.9, 0.06, 0.03),
  amber: new THREE.Color(0.86, 0.38, 0.03),
  green: new THREE.Color(0.08, 0.72, 0.42),
};

/** One head per corner, facing the traffic that comes up on that corner's side. */
interface Head {
  j: SignalJunction;
  axis: Axis;
  x: number;
  z: number;
  /** The way it faces (toward the traffic it is for). */
  yaw: number;
}

/** The four heads of a junction: a corner each, for the approach whose near right-hand corner it is. */
export function headsOf(j: SignalJunction): Head[] {
  const c = SIGNAL_CORNER;
  // Eastbound (+x) traffic keeps right, to +z: its near corner is (-x, +z), and the head faces back along -x. (A turn
  // of yaw about y takes the head's +x face to (cos yaw, -sin yaw).)
  return [
    { j, axis: 'x', x: j.x - c, z: j.z + c, yaw: Math.PI },
    { j, axis: 'x', x: j.x + c, z: j.z - c, yaw: 0 },
    { j, axis: 'z', x: j.x - c, z: j.z - c, yaw: Math.PI / 2 },
    { j, axis: 'z', x: j.x + c, z: j.z + c, yaw: -Math.PI / 2 },
  ];
}

/** Which aspect an approach shows: 0 red, 1 amber, 2 green. */
export function aspectOf(p: SignalPhase, axis: Axis): 0 | 1 | 2 {
  if (p.green !== axis) return 0;
  return p.amber ? 1 : 2;
}

/** The pole, its housing, back plate and the three visors, with the head facing +x (lens side). */
function bodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.055, 0.07, HEAD_Y + 0.55, 10, 1);
  pole.translate(0, (HEAD_Y + 0.55) / 2, 0);
  parts.push(pole);
  const base = new THREE.CylinderGeometry(0.12, 0.14, 0.32, 10, 1);
  base.translate(0, 0.16, 0);
  parts.push(base);
  // The housing on a short bracket off the pole toward the road.
  const bracket = new THREE.BoxGeometry(0.18, 0.06, 0.06);
  bracket.translate(0.1, HEAD_Y + 0.25, 0);
  parts.push(bracket);
  const housing = new THREE.BoxGeometry(0.24, 0.84, 0.3);
  housing.translate(0.24, HEAD_Y, 0);
  parts.push(housing);
  const plate = new THREE.BoxGeometry(0.02, 1.04, 0.5);
  plate.translate(0.11, HEAD_Y, 0);
  parts.push(plate);
  for (const dy of [0.27, 0, -0.27]) {
    // A hood over each lens: a thin shelf proud of the face.
    const hood = new THREE.BoxGeometry(0.16, 0.02, 0.26);
    hood.translate(0.44, HEAD_Y + dy + 0.12, 0);
    parts.push(hood);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  for (const p of parts) p.dispose();
  return g;
}

/** The three lenses on the housing's face, each tagged with its aspect (aSlot: 0 red top, 1 amber, 2 green bottom). */
function lensGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  [0.27, 0, -0.27].forEach((dy, slot) => {
    const c = new THREE.CircleGeometry(LENS, 14);
    c.rotateY(Math.PI / 2);
    c.translate(0.362, HEAD_Y + dy, 0);
    const n = c.attributes.position.count;
    c.setAttribute('aSlot', new THREE.Float32BufferAttribute(new Array(n).fill(slot), 1));
    parts.push(c.toNonIndexed());
    c.dispose();
  });
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

function lensMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.18, metalness: 0 });
  m.name = 'signal-lens';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRed = { value: LIT.red };
    sh.uniforms.uAmber = { value: LIT.amber };
    sh.uniforms.uGreen = { value: LIT.green };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSlot;\nattribute float aLit;\nvarying float vSlot;\nvarying float vLit;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlot = aSlot;\nvLit = aLit;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRed;\nuniform vec3 uAmber;\nuniform vec3 uGreen;\nvarying float vSlot;\nvarying float vLit;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 tint = vSlot < 0.5 ? uRed : vSlot < 1.5 ? uAmber : uGreen;
          bool on = abs(vSlot - vLit) < 0.5;
          // The dark aspects: smoked glass with the colour just showing through, as an unlit lens does at dusk.
          diffuseColor.rgb = tint * 0.05;
          totalEmissiveRadiance += on ? tint : tint * 0.012;
        }`,
      )
      // A lit lens is a small bright source: the haze dims it far less than a painted surface (as vehicles.ts lamps).
      .replace(
        '#include <fog_fragment>',
        `vec3 preFog = gl_FragColor.rgb;
        #include <fog_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, preFog, abs(vSlot - vLit) < 0.5 ? 0.55 : 0.0);`,
      );
  };
  m.customProgramCacheKey = () => 'palimpsest-signal-lens';
  return m;
}

export interface SignalHeads {
  group: THREE.Group;
  /** Lays the heads at the junctions that carry signals now (after the roads were laid again). */
  set(signals: Signals): void;
  /** Shows each head's aspect at the lights' time, and draws those within reach of the eye. */
  update(eye: THREE.Vector3): void;
  /** How many heads stand, and how many draw now (tests and the budget). */
  view(): { heads: number; drawn: number };
  dispose(): void;
}

export function createSignalHeads(): SignalHeads {
  const group = new THREE.Group();
  group.name = 'signals';
  const bodyGeo = bodyGeometry();
  const lensGeo = lensGeometry();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1d1f20, roughness: 0.55, metalness: 0.35 });
  bodyMat.name = 'signal-body';
  const lensMat = lensMaterial();
  let heads: Head[] = [];
  let signals: Signals | null = null;
  let bodies: THREE.InstancedMesh | null = null;
  let lenses: THREE.InstancedMesh | null = null;
  let lit: THREE.InstancedBufferAttribute | null = null;
  /** Which head each drawn instance is, and the heads near the eye at the last lay-out. */
  let slots: number[] = [];
  const at = new THREE.Vector3();
  const lastEye = new THREE.Vector3(Infinity, 0, 0);
  const PHASE: SignalPhase = { green: null, amber: false, left: 0 };
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);

  function build(): void {
    for (const m of [bodies, lenses]) {
      if (!m) continue;
      group.remove(m);
      if (m === lenses) m.geometry.dispose();
      m.dispose();
    }
    const n = Math.max(heads.length, 1);
    bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, n);
    lenses = new THREE.InstancedMesh(lensGeo, lensMat, n);
    lit = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    lit.setUsage(THREE.DynamicDrawUsage);
    lenses.geometry = lensGeo.clone();
    lenses.geometry.setAttribute('aLit', lit);
    for (const m of [bodies, lenses]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      setLayers(m, LAYER.view);
      group.add(m);
    }
    bodies.name = 'signal-poles';
    lenses.name = 'signal-lenses';
    lastEye.set(Infinity, 0, 0);
  }
  build();

  /** Places the heads within reach of the eye into the instances (when the eye has moved far enough to matter). */
  function place(eye: THREE.Vector3): void {
    if (!bodies || !lenses) return;
    slots = [];
    const far2 = SIGNAL_LOD.far * SIGNAL_LOD.far;
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      const dx = h.x - eye.x;
      const dz = h.z - eye.z;
      if (dx * dx + dz * dz > far2) continue;
      const k = slots.length;
      slots.push(i);
      at.set(h.x, 0, h.z);
      M.compose(at, Q.setFromAxisAngle(Y, h.yaw), ONE);
      bodies.setMatrixAt(k, M);
      lenses.setMatrixAt(k, M);
    }
    bodies.count = slots.length;
    lenses.count = slots.length;
    bodies.instanceMatrix.needsUpdate = true;
    lenses.instanceMatrix.needsUpdate = true;
    lastEye.copy(eye);
  }

  return {
    group,
    set(next) {
      const list = next.list();
      signals = next;
      const same = heads.length === list.length * 4 && list.every((j, i) => heads[i * 4].j === j);
      if (same) return;
      heads = list.flatMap(headsOf);
      build();
    },
    update(eye) {
      if (!signals || !bodies || !lenses || !lit) return;
      if (lastEye.distanceToSquared(eye) > 40 * 40) place(eye);
      const t = signals.now();
      const arr = lit.array as Float32Array;
      for (let k = 0; k < slots.length; k++) {
        const h = heads[slots[k]];
        arr[k] = aspectOf(signalPhase(h.j, t, PHASE), h.axis);
      }
      lit.needsUpdate = true;
    },
    view: () => ({ heads: heads.length, drawn: slots.length }),
    dispose() {
      for (const m of [bodies, lenses]) {
        if (!m) continue;
        group.remove(m);
        if (m === lenses) m.geometry.dispose();
        m.dispose();
      }
      bodyGeo.dispose();
      lensGeo.dispose();
      bodyMat.dispose();
      lensMat.dispose();
    },
  };
}
