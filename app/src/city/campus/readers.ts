/**
 * The readers in the library's lit bays (Phase 5 Task 10): at each bay two
 * desks set against the glass on the window dais, and at most desks a
 * reader, seated, shoulders, head and arms on the desk, in one of three
 * poses: bent over a book, upright with a chin on one hand, or writing,
 * half turned. One instanced draw for every desk in the room: the three
 * poses ride in one geometry (each vertex names its pose) and an instance
 * folds away the two it does not hold; the desks are shared by all.
 *
 * Seen from the quad they stand behind the glass, which the window shader
 * draws opaque (the room is painted on the pane). So a reader's depth is
 * written as if it stood on a plane a hand in front of the pane (behind the
 * mullions), its own depth kept in order a few centimetres deep: the
 * mullions and the wall cut it as they should and the pane does not hide
 * it; where it lands on the screen is its true place, so it moves with the
 * eye as a figure in the room does. Lit by the desk lamp before it, low and
 * warm, at the bay's own level (life.ts); a dark bay folds its readers
 * away, since no one reads in the dark. The view alone draws them.
 *
 * Fake life stays a failure: the readers stand only in the bays the
 * voyage lights, one per genome racing as the bays are.
 */
import * as THREE from 'three';

/** The desk's top over the terrace, in a bay's frame, and how far behind the wall's face the desk's front edge stands. */
export const READER_DESK = { y: 3.18, front: -0.68, depth: 0.56, width: 1.15 } as const;
/** The desk lamp, in the desk's frame: to one side near the glass edge, a hand over the books. */
const LAMP_AT: P3 = [0.36, 0.34, 0.12];
/**
 * Where the readers' depth is written: this far out of the wall's face (the pane stands at -0.6, the mullions to -0.415).
 * Tuned to the library's wall (LIBRARY.wall 0.55) and gothic.ts dress's pane and mullion depths: if those move, move this.
 */
export const READER_GLASS_Z = -0.5;
/** The share of a reader's true depth behind the glass plane kept in its written depth, so it still occludes itself in order. */
export const READER_DEPTH_KEPT = 0.08;
/** Desks per bay, along the wall from the bay's centre. */
const DESK_U = [-0.95, 0.95];
/** The poses: 0 bent over a book, 1 upright with a chin on a hand, 2 writing, half turned; 3 an empty desk. */
export const READER_POSES = 3;
const EMPTY = 3;

type P3 = [number, number, number];

/** Cloth, skin, hair and paper, in linear light; each reader's coat is a shade of its own (the instance's tone). */
const SKIN = new THREE.Color(0.42, 0.27, 0.19);
const HAIR = new THREE.Color(0.06, 0.045, 0.035);
const PAPER = new THREE.Color(0.8, 0.76, 0.66);
const COAT = new THREE.Color(0.17, 0.155, 0.15);
const WOOD = new THREE.Color(0.16, 0.09, 0.05);
/** The lamp shade's lit glass: the one colour over 0.95 red, which the shader takes for the emitter. */
const LAMP_GLOW = new THREE.Color(1.0, 0.8, 0.5);

/** A piece of a figure: its geometry in the desk's frame, its colour and the pose it belongs to (-1 every pose, the desk). */
function piece(g: THREE.BufferGeometry, colour: THREE.Color, pose: number): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  const count = n.attributes.position.count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colour.toArray(col, i * 3);
  n.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  n.setAttribute('aPose', new THREE.Float32BufferAttribute(new Float32Array(count).fill(pose), 1));
  n.deleteAttribute('uv');
  return n;
}

/** A rounded limb from a to b, radius r. */
function limb(a: P3, b: P3, r: number): THREE.BufferGeometry {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = Math.max(0.01, va.distanceTo(vb));
  const g = new THREE.CapsuleGeometry(r, len, 2, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return g.applyQuaternion(q).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

interface Pose {
  /** Forward lean of the trunk toward the desk, radians; and its turn about the vertical. */
  lean: number;
  turn: number;
  /** The head's bow (radians forward) and turn. */
  bow: number;
  look: number;
  /** Elbows and hands, left then right, in the desk's frame (y up from the desk's top, z toward the glass). */
  elbows: [P3, P3];
  hands: [P3, P3];
  /** Paper on the desk: a book open, a sheet. */
  paper: Array<{ at: P3; w: number; d: number; ry: number; rx?: number }>;
}

/**
 * The three poses, in the desk's frame: x along the wall, y up from the
 * desk's top, z toward the glass (the reader sits on the room's side, -z,
 * facing it). The hip stands 0.32 under the desk's top and 0.5 behind its
 * middle; the shoulders 0.58 over the hip along the trunk.
 */
const POSES: Pose[] = [
  // Bent over a book: the trunk well forward, the head bowed, both forearms on the desk round the book.
  { lean: 0.42, turn: 0, bow: 0.5, look: 0, elbows: [[-0.24, 0.05, -0.12], [0.24, 0.05, -0.12]], hands: [[-0.12, 0.04, 0.1], [0.13, 0.04, 0.1]], paper: [{ at: [0, 0.012, 0.08], w: 0.36, d: 0.25, ry: 0 }] },
  // Upright, the left forearm flat on the desk, the right elbow on it and the chin on that hand.
  { lean: 0.12, turn: 0.1, bow: 0.12, look: -0.25, elbows: [[-0.26, 0.05, -0.1], [0.16, 0.05, -0.14]], hands: [[0.0, 0.04, 0.08], [0.05, 0.3, -0.29]], paper: [{ at: [-0.1, 0.012, 0.12], w: 0.3, d: 0.22, ry: 0.25 }] },
  // Writing, half turned: the right forearm across the sheet, the left hand holding it, the head down and to the side.
  { lean: 0.3, turn: -0.28, bow: 0.38, look: 0.22, elbows: [[-0.25, 0.05, -0.08], [0.28, 0.05, -0.18]], hands: [[-0.12, 0.04, 0.16], [0.07, 0.035, 0.1]], paper: [{ at: [0.0, 0.01, 0.12], w: 0.3, d: 0.4, ry: -0.35 }, { at: [-0.32, 0.03, 0.14], w: 0.2, d: 0.28, ry: 0.3 }] },
];

/** One reader in a pose, its pieces stamped with the pose. */
function figure(p: Pose, i: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const hip = new THREE.Vector3(0, -0.32, -0.5);
  const turn = new THREE.Matrix4().makeRotationY(p.turn);
  /** A point up the trunk from the hip, leaning toward the glass by the pose's lean and turned by its turn, x across. */
  const up = (h: number, x = 0): P3 => {
    const v = new THREE.Vector3(x, h * Math.cos(p.lean), h * Math.sin(p.lean)).applyMatrix4(turn).add(hip);
    return [v.x, v.y, v.z];
  };
  // The trunk: a coat's broad back, narrower at the waist, as two rounded masses.
  const waist = up(0.12);
  const chest = up(0.4);
  out.push(piece(limb(waist, up(0.3), 0.15).scale(1, 1, 1), COAT, i));
  const torso = new THREE.CapsuleGeometry(0.155, 0.2, 2, 8).scale(1.32, 1, 0.78).applyMatrix4(new THREE.Matrix4().makeRotationX(p.lean)).applyMatrix4(turn).translate(chest[0], chest[1], chest[2]);
  out.push(piece(torso, COAT, i));
  // The shoulders, across: the line the eye reads first from outside.
  const sl = up(0.55, -0.19);
  const sr = up(0.55, 0.19);
  out.push(piece(limb(sl, sr, 0.075), COAT, i));
  // The neck and the head, bowed and turned on it; the hair over the crown and back.
  const neck = up(0.64);
  out.push(piece(limb(up(0.56), neck, 0.05), SKIN, i));
  const head = new THREE.Vector3(0, 0.12, 0.02).applyAxisAngle(new THREE.Vector3(1, 0, 0), p.bow).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.turn + p.look).add(new THREE.Vector3(...neck));
  const skull = new THREE.SphereGeometry(0.1, 9, 7).scale(0.88, 1.1, 1.0);
  const tilt = new THREE.Matrix4().makeRotationY(p.turn + p.look).multiply(new THREE.Matrix4().makeRotationX(p.bow));
  out.push(piece(skull.clone().applyMatrix4(tilt).translate(head.x, head.y, head.z), SKIN, i));
  const hair = new THREE.SphereGeometry(0.106, 9, 4, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.9, 1.1, 1.02).translate(0, 0.012, -0.012);
  out.push(piece(hair.applyMatrix4(tilt).translate(head.x, head.y, head.z), HAIR, i));
  skull.dispose();
  // The arms: upper arm from the shoulder to the elbow, forearm to the hand, a hand at its end.
  [sl, sr].forEach((s, k) => {
    out.push(piece(limb(s, p.elbows[k], 0.05), COAT, i));
    out.push(piece(limb(p.elbows[k], p.hands[k], 0.043), COAT, i));
    out.push(piece(new THREE.SphereGeometry(0.045, 6, 4).scale(1, 0.7, 1.3).translate(...p.hands[k]), SKIN, i));
  });
  for (const b of p.paper) out.push(piece(new THREE.BoxGeometry(b.w, 0.012, b.d).rotateX(b.rx ?? 0).rotateY(b.ry).translate(...b.at), PAPER, i));
  return out;
}

/** The desk every pose shares: an open table, its top and two trestles, and a short row of books at its glass edge. */
function desk(): THREE.BufferGeometry[] {
  const { width: w, depth: d } = READER_DESK;
  const out = [piece(new THREE.BoxGeometry(w, 0.035, d).translate(0, -0.018, 0), WOOD, -1)];
  for (const s of [-1, 1]) out.push(piece(new THREE.BoxGeometry(0.05, 0.4, d - 0.08).translate((s * (w - 0.12)) / 2, -0.23, 0), WOOD, -1));
  // A few books stood at the glass edge, their spines to the reader, a hand high: low enough to leave the arms in sight.
  [-0.42, -0.36, -0.31, 0.3, 0.35].forEach((x, k) => out.push(piece(new THREE.BoxGeometry(0.045, 0.16 + 0.03 * (k % 3), 0.2).translate(x, 0.085, d / 2 - 0.12), k % 2 ? PAPER.clone().multiplyScalar(0.35) : WOOD.clone().multiplyScalar(1.8), -1)));
  // The desk lamp itself: a dark stem and a small shade whose lit inside shows (its colour flags it as the emitter).
  out.push(piece(new THREE.CylinderGeometry(0.012, 0.03, LAMP_AT[1] + 0.02, 6).translate(LAMP_AT[0] + 0.05, (LAMP_AT[1] - 0.02) / 2, LAMP_AT[2]), HAIR, -1));
  out.push(piece(new THREE.CylinderGeometry(0.05, 0.085, 0.09, 10, 1, true).translate(LAMP_AT[0], LAMP_AT[1] + 0.04, LAMP_AT[2]), LAMP_GLOW, -1));
  return out;
}

/** Every pose and the desk in one geometry: position, normal, colour and the pose each vertex belongs to. */
export function readerGeometry(): THREE.BufferGeometry {
  const parts = [...desk(), ...POSES.flatMap((p, i) => figure(p, i))];
  const names = ['position', 'normal', 'color', 'aPose'] as const;
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = (parts[0].attributes[name] as THREE.BufferAttribute).itemSize;
    const arr = new Float32Array(total * size);
    let at = 0;
    for (const g of parts) {
      arr.set(g.attributes[name].array as Float32Array, at);
      at += g.attributes[name].count * size;
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

/** A small stable hash in [0, 1). */
function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Which pose each desk holds (bay by bay, the two desks in turn): three poses round the room, now and then an empty desk. */
export function readerPoses(bays: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < bays; b++) {
    for (let d = 0; d < DESK_U.length; d++) {
      const i = b * DESK_U.length + d;
      // One desk in five or so stands empty, never both in a bay.
      const empty = d === 1 && hash(i * 3.7) < 0.35;
      out.push(empty ? EMPTY : (b + d * 2 + Math.floor(hash(i) * 2)) % READER_POSES);
    }
  }
  return out;
}

export interface Readers {
  mesh: THREE.InstancedMesh;
  /** The pose each instance holds, in instance order (bay by bay). */
  poses: ReadonlyArray<number>;
  /** Each bay's light, 0 dark to 1 lit (life.ts): a reader shows while its bay is lit, lamplit at its level. */
  set(levels: ReadonlyArray<number>): void;
  dispose(): void;
}

/** The readers' material: a coat's cloth under the desk lamp, the poses folded per instance, the depth written on the glass's plane. */
function readerMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0 });
  m.name = 'campus-readers';
  m.customProgramCacheKey = () => 'campus-readers';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aPose;
        attribute vec3 aReader;
        varying float vLamp;
        varying float vLampFall;
        varying vec3 vLampDir;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          // aReader: x the pose this desk holds, y its bay's light, z its coat's tone.
          vLamp = aReader.y;
          float off = aReader.y < 0.02 || (aPose >= 0.0 && abs(aPose - aReader.x) > 0.5) ? 1.0 : 0.0;
          if (off > 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          mat4 mi = modelMatrix * instanceMatrix;
          // The desk lamp: a point to one side near the glass edge, a hand over the books; its light falls off with the
          // distance, so the face and hands over the desk are lit and the trestles and the coat's back fall dark.
          vec3 toLamp = vec3(${LAMP_AT.map((v) => v.toFixed(2)).join(', ')}) - transformed;
          vLampDir = normalize((viewMatrix * mi * vec4(toLamp, 0.0)).xyz);
          vLampFall = 1.0 / (1.0 + 7.0 * dot(toLamp, toLamp));
          // Depth on the glass's plane: where the ray to this point crosses the plane a hand in front of the pane,
          // plus a sliver of its true depth behind it, so the reader stays in order with itself.
          vec3 wp = (mi * vec4(transformed, 1.0)).xyz;
          vec3 n = normalize(mi[2].xyz);
          vec3 onGlass = (mi * vec4(0.0, 0.0, ${(READER_GLASS_Z - (READER_DESK.front - READER_DESK.depth / 2)).toFixed(3)}, 1.0)).xyz;
          vec3 ray = wp - cameraPosition;
          float den = dot(ray, n);
          float t = abs(den) > 1e-5 ? dot(onGlass - cameraPosition, n) / den : 1.0;
          if (t > 0.0 && t < 1.0 && off < 0.5) {
            vec4 c = projectionMatrix * viewMatrix * vec4(cameraPosition + ray * (t + (1.0 - t) * ${READER_DEPTH_KEPT.toFixed(3)}), 1.0);
            gl_Position.z = c.z / c.w * gl_Position.w;
          }
        }`,
      )
      .replace(
        '#include <color_vertex>',
        // Each reader's coat a shade of its own, from a navy to a brown: the dark cloth only, not the skin, the paper or the desk.
        '#include <color_vertex>\n  if (aPose >= 0.0 && vColor.r < 0.18 && vColor.r > 0.1) vColor.rgb *= mix(vec3(0.75, 0.85, 1.35), vec3(1.45, 1.1, 0.75), aReader.z);',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLamp;\nvarying float vLampFall;\nvarying vec3 vLampDir;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Indoors: the dusk outside barely reaches past the glass; the desk lamp lights what faces it, warm, at the
          // bay's level, and the room's light behind leaves a dim warm rim on the back and shoulders.
          diffuseColor.rgb *= 0.25;
          float face = max(dot(normal, vLampDir), 0.0);
          float rim = pow(1.0 - abs(normal.z), 2.0) * 0.32;
          totalEmissiveRadiance += vColor.rgb * vec3(1.0, 0.72, 0.42) * vLamp * (0.06 + 2.2 * face * vLampFall + rim);
          if (vColor.r > 0.95) totalEmissiveRadiance += vColor.rgb * 1.1 * vLamp;
        }`,
      );
  };
  return m;
}

/** The readers at every bay's desks, in the Kit's frame (the frames as makeLibrary answers them). */
export function makeReaders(bayFrames: ReadonlyArray<THREE.Matrix4>): Readers {
  const geo = readerGeometry();
  const poses = readerPoses(bayFrames.length);
  const count = poses.length;
  const material = readerMaterial();
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.name = 'campus:readers';
  mesh.castShadow = mesh.receiveShadow = false;
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const deskZ = READER_DESK.front - READER_DESK.depth / 2;
  bayFrames.forEach((F, b) => {
    DESK_U.forEach((u, d) => {
      const i = b * DESK_U.length + d;
      mesh.setMatrixAt(i, F.clone().multiply(new THREE.Matrix4().makeTranslation(u, READER_DESK.y, deskZ)));
      attr.setXYZ(i, poses[i], 0, hash(i * 9.1));
    });
  });
  geo.setAttribute('aReader', attr);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return {
    mesh,
    poses,
    set(levels) {
      for (let i = 0; i < count; i++) attr.setY(i, Math.max(0, Math.min(1, levels[Math.floor(i / DESK_U.length)] ?? 0)));
      attr.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
